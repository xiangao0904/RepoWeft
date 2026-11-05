//! OpenSSH transport: connection reuse, password authentication and host key trust.
//!
//! Every SSH call reuses one multiplexed connection per host. The first call makes a
//! master connection, later calls ride on it, so a password is only ever asked once
//! per host and window instead of once per Git command.

use keyring::Entry;
use serde::Deserialize;
use std::{
    collections::{HashMap, hash_map::DefaultHasher},
    fs,
    hash::{Hash, Hasher},
    io::Write,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

/// Returned to the UI when the host accepts neither keys nor a stored password.
pub const AUTH_REQUIRED: &str = "REPOWEFT_AUTH_REQUIRED";
/// This host key is not in known_hosts yet. The fingerprint is read separately.
pub const HOST_KEY_UNKNOWN: &str = "REPOWEFT_HOST_KEY_UNKNOWN";
/// A known host presented a different key. Never offer to trust this automatically.
pub const HOST_KEY_CHANGED: &str = "REPOWEFT_HOST_KEY_CHANGED";

const SERVICE: &str = "repoweft.ssh";
/// Set to `0` or `1` to override the platform default for connection reuse.
const MULTIPLEX_ENV: &str = "REPOWEFT_SSH_MULTIPLEX";
/// Cleared for the rest of the process once a control socket misbehaves, so a
/// platform that cannot multiplex degrades to one connection per command.
static MULTIPLEX: AtomicBool = AtomicBool::new(true);
const CONTROL_PERSIST: &str = "300";
/// Environment marker set only on the process OpenSSH spawns for a password.
const ASKPASS_MARKER: &str = "REPOWEFT_ASKPASS";
const ASKPASS_FILE: &str = "REPOWEFT_ASKPASS_FILE";

/// The Win32 OpenSSH build cannot multiplex: asking for a master connection fails
/// inside the socket layer (`getsockname failed: Not a socket`) and every command
/// dies before the remote side ever runs. Reuse is therefore opt-in there.
fn multiplex_supported() -> bool {
    match std::env::var(MULTIPLEX_ENV).ok().as_deref() {
        Some("1") => true,
        Some("0") => false,
        _ => !cfg!(windows),
    }
}

fn multiplexing() -> bool {
    MULTIPLEX.load(Ordering::Relaxed) && multiplex_supported()
}

/// Whether commands currently share one connection. The terminal only pre-authenticates
/// when it can ride that connection; otherwise the PTY asks for itself.
pub fn reuse_enabled() -> bool {
    multiplexing()
}

/// Stop reusing connections for the rest of the process and drop the socket that
/// the failed attempt left behind, so the direct retry cannot hit it again.
fn drop_reuse(host: &Host) {
    MULTIPLEX.store(false, Ordering::Relaxed);
    let _ = fs::remove_file(control_path(host));
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    pub hostname: String,
    pub username: String,
    pub port: u16,
    pub identity_file: String,
}

/// How a connection should authenticate and whether it may touch known_hosts.
#[derive(Clone, Copy, PartialEq)]
pub enum Mode {
    /// Ride the multiplexed connection. Never prompts, so a cold password-only host fails.
    Session,
    /// Like `Session`, but answers a password prompt from the credential store.
    StoredSecret,
    /// Establish the multiplexed connection, asking an askpass helper for the password.
    Password,
    /// Accept an unknown host key. The authentication result is irrelevant here.
    Trust,
    /// Read the fingerprint of an unknown host key without trusting it.
    Inspect,
}

impl Host {
    /// Stable identity for connection reuse and credential storage.
    pub fn key(&self) -> String {
        format!(
            "{}@{}:{}",
            match self.username.is_empty() {
                true => "-",
                false => self.username.as_str(),
            },
            self.hostname,
            self.port
        )
    }
    fn destination(&self) -> String {
        if self.username.is_empty() {
            self.hostname.clone()
        } else {
            format!("{}@{}", self.username, self.hostname)
        }
    }
}

fn validate(host: &Host) -> Result<(), String> {
    if host.hostname.is_empty()
        || host.hostname.starts_with('-')
        || host
            .hostname
            .chars()
            .any(|c| !(c.is_ascii_alphanumeric() || ".-_:%[]()".contains(c)))
    {
        return Err("Invalid SSH hostname or config alias".into());
    }
    if host.username.starts_with('-')
        || host
            .username
            .chars()
            .any(|c| !(c.is_ascii_alphanumeric() || "-_.".contains(c)))
    {
        return Err("Invalid SSH username".into());
    }
    if host.identity_file.contains('\0') {
        return Err("NUL bytes are not allowed".into());
    }
    Ok(())
}

/// Socket shared by every command for this host. Kept short because AF_UNIX paths
/// on Windows are limited to 108 characters.
pub fn control_path(host: &Host) -> PathBuf {
    let mut hasher = DefaultHasher::new();
    host.key().hash(&mut hasher);
    std::env::temp_dir().join(format!("repoweft-{:016x}.sock", hasher.finish()))
}

/// Build an `ssh` process without a remote command; callers append their own.
pub fn command(host: &Host, mode: Mode) -> Result<Command, String> {
    validate(host)?;
    let mut cmd = Command::new("ssh");
    let multiplexed =
        multiplexing() && matches!(mode, Mode::Session | Mode::StoredSecret | Mode::Password);
    if multiplexed {
        let control = control_path(host);
        cmd.args(["-o", "ControlMaster=auto"]);
        cmd.arg("-o")
            .arg(format!("ControlPath={}", control.display()));
        cmd.args(["-o", &format!("ControlPersist={CONTROL_PERSIST}")]);
    }
    match mode {
        Mode::Session => cmd.args(["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes"]),
        Mode::StoredSecret => cmd.args([
            "-o",
            "BatchMode=no",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            "NumberOfPasswordPrompts=1",
            // Keys still come first; the saved password is only a fallback.
            "-o",
            "PreferredAuthentications=publickey,keyboard-interactive,password",
        ]),
        Mode::Password => cmd.args([
            "-o",
            "BatchMode=no",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            "NumberOfPasswordPrompts=1",
            // Key authentication already failed before this mode is used, and
            // skipping it avoids burning the server's authentication budget on
            // every key in the agent.
            "-o",
            "PreferredAuthentications=keyboard-interactive,password",
        ]),
        Mode::Trust => cmd.args([
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=accept-new",
        ]),
        Mode::Inspect => cmd.args(["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=ask"]),
    };
    cmd.args([
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=2",
    ]);
    // Port 0 lets OpenSSH honor the port in ~/.ssh/config.
    if host.port != 0 {
        cmd.args(["-p", &host.port.to_string()]);
    }
    if !host.identity_file.is_empty() {
        cmd.arg("-i").arg(&host.identity_file);
    }
    if !host.username.is_empty() {
        cmd.arg("-l").arg(&host.username);
    }
    cmd.arg(host.destination());
    Ok(cmd)
}

/// Run an SSH command, translating the failures the UI can act on.
pub fn run(command: Command, timeout: u64) -> Result<String, String> {
    match crate::git::output(command, timeout) {
        Ok(output) => Ok(output),
        Err(error) => Err(explain(error)),
    }
}

/// Run one remote command, recovering from a control socket that cannot be used.
///
/// A multiplexed client that cannot reach its master fails before the remote
/// command starts, so retrying over a direct connection is both safe and the only
/// way forward: after that, reuse stays off for the rest of the process.
pub fn exec(host: &Host, mode: Mode, remote: &str, timeout: u64) -> Result<String, String> {
    run_remote(host, mode, remote, None, timeout)
}

fn run_remote(
    host: &Host,
    mode: Mode,
    remote: &str,
    secret: Option<&str>,
    timeout: u64,
) -> Result<String, String> {
    match attempt(host, mode, remote, secret, timeout) {
        Err(error) if multiplexing() && multiplex_error(&error) => {
            drop_reuse(host);
            attempt(host, mode, remote, secret, timeout)
        }
        result => result,
    }
}

fn attempt(
    host: &Host,
    mode: Mode,
    remote: &str,
    secret: Option<&str>,
    timeout: u64,
) -> Result<String, String> {
    // Without a shared connection every command authenticates on its own, so a host
    // that only accepts a password would otherwise prompt on every Git call.
    let saved = match (secret, mode, multiplexing()) {
        (Some(value), _, _) => Some(value.to_owned()),
        (None, Mode::Session, false) => available_password(host),
        _ => None,
    };
    let mode = match (&saved, mode) {
        (Some(_), Mode::Session) => Mode::StoredSecret,
        _ => mode,
    };
    let mut cmd = command(host, mode)?;
    cmd.arg(remote);
    // The file must outlive the process, so it is bound to this scope.
    let _secret = match &saved {
        Some(value) => Some(attach_askpass(&mut cmd, value)?),
        None => None,
    };
    run(cmd, timeout)
}

fn explain(error: String) -> String {
    if error.contains("REMOTE HOST IDENTIFICATION HAS CHANGED")
        || (error.contains("Host key for") && error.contains("has changed"))
    {
        return HOST_KEY_CHANGED.into();
    }
    if error.contains("Host key verification failed") {
        return HOST_KEY_UNKNOWN.into();
    }
    // Session commands authenticate on their own, so a rejected credential has to
    // reach the UI in a form it can turn into a prompt.
    if denied(&error) {
        return AUTH_REQUIRED.into();
    }
    error
}

/// Read the host key offered by the server without trusting it, so the UI can show
/// a fingerprint before the user decides.
pub fn host_key(host: &Host) -> Result<String, String> {
    let mut cmd = command(host, Mode::Inspect)?;
    cmd.arg("true");
    // A rejected probe carries the fingerprint on stderr; a trusted host answers
    // the probe instead and has nothing to show.
    let text = crate::git::output(cmd, 20).unwrap_or_else(|error| error);
    text.split_whitespace()
        .find(|word| word.starts_with("SHA256:"))
        .map(|word| {
            word.trim_matches(|c: char| {
                !c.is_ascii_alphanumeric() && c != ':' && c != '+' && c != '/'
            })
            .to_string()
        })
        .ok_or_else(|| "Unable to read the host key fingerprint".into())
}

/// Signals that the shared control socket, not the server, is the problem.
fn multiplex_error(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    error.contains("multiplex")
        || error.contains("control socket")
        || error.contains("controlpath")
        // The Win32 OpenSSH socket layer failing on a multiplexed client.
        || error.contains("getsockname")
        || error.contains("not a socket")
}

/// True when SSH itself rejected the credentials, as opposed to a remote command
/// reporting a file permission problem.
fn denied(error: &str) -> bool {
    error.contains("Permission denied (")
        || error.contains("Permission denied, please try again")
        || error.contains("Too many authentication failures")
}

/// Either the transport rejected the credentials or it needs some to proceed.
fn needs_credentials(error: &str) -> bool {
    error == AUTH_REQUIRED || denied(error)
}

/// Authenticate a host: keys and agent first, then a supplied or remembered password.
pub fn connect(host: &Host, password: Option<&str>, remember: bool) -> Result<(), String> {
    match exec(host, Mode::Session, "true", 25) {
        Ok(_) => return Ok(()),
        Err(error) if error.starts_with(HOST_KEY_UNKNOWN) || error == HOST_KEY_CHANGED => {
            return Err(error);
        }
        // Anything else needs no credentials and is a real failure.
        Err(error) if !needs_credentials(&error) => return Err(error),
        Err(_) => {}
    }
    let supplied = password.map(str::to_owned);
    let remembered = match &supplied {
        Some(_) => None,
        None => available_password(host),
    };
    let secret = match (&supplied, &remembered) {
        (Some(value), _) => value.clone(),
        (None, Some(value)) => value.clone(),
        (None, None) => return Err(AUTH_REQUIRED.into()),
    };
    match run_remote(host, Mode::Password, "true", Some(&secret), 30) {
        Ok(_) => {
            match (&supplied, remember) {
                // Losing the credential is worth a warning, not a failed connection;
                // the server page shows whether a password is actually stored.
                (Some(_), true) => {
                    let _ = save_password(host, &secret);
                }
                // "Do not save" means do not persist: the password still has to live
                // for this run, because every command authenticates on its own.
                (Some(_), false) => {
                    forget_password(host);
                    keep_in_session(host, &secret);
                }
                // A remembered password that worked stays remembered.
                (None, _) => {}
            }
            Ok(())
        }
        Err(error) if needs_credentials(&error) => {
            // Drop a password the server no longer accepts so the next attempt asks
            // the user instead of silently retrying it forever.
            if supplied.is_none() {
                forget_password(host);
            }
            Err(AUTH_REQUIRED.into())
        }
        Err(error) => Err(error),
    }
}

/// Add an unknown host key to known_hosts. Authentication may still fail afterwards;
/// only the host key outcome matters here.
pub fn trust(host: &Host) -> Result<(), String> {
    let mut cmd = command(host, Mode::Trust)?;
    cmd.arg("true");
    match run(cmd, 20) {
        Ok(_) => Ok(()),
        Err(error) if error == HOST_KEY_CHANGED => Err(error),
        Err(error) if error.starts_with(HOST_KEY_UNKNOWN) => Err(format!(
            "Unable to add the host key of {} to known_hosts",
            host.hostname
        )),
        Err(_) => Ok(()),
    }
}

fn entry(host: &Host) -> Result<Entry, String> {
    Entry::new(SERVICE, &host.key()).map_err(|e| e.to_string())
}

/// Saved passwords, cached because every remote command asks for one and the system
/// keychain is not free. Invalidated whenever the credential changes.
fn cached() -> &'static Mutex<HashMap<String, Option<String>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Passwords typed in this run but not saved. Deliberately kept out of the keychain:
/// without connection reuse every command authenticates on its own, so retyping per
/// command would be unusable, while a restart must still forget them.
fn session_store() -> &'static Mutex<HashMap<String, String>> {
    static STORE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn invalidate(host: &Host) {
    if let Ok(mut cache) = cached().lock() {
        cache.remove(&host.key());
    }
    if let Ok(mut store) = session_store().lock() {
        store.remove(&host.key());
    }
}

fn session_password(host: &Host) -> Option<String> {
    session_store().lock().ok()?.get(&host.key()).cloned()
}

fn keep_in_session(host: &Host, password: &str) {
    if let Ok(mut store) = session_store().lock() {
        store.insert(host.key(), password.to_owned());
    }
}

pub fn stored_password(host: &Host) -> Option<String> {
    if let Ok(mut cache) = cached().lock() {
        if let Some(hit) = cache.get(&host.key()) {
            return hit.clone();
        }
        // Read while holding the lock: parallel Git calls must not race the keychain.
        let value = entry(host).ok().and_then(|entry| entry.get_password().ok());
        cache.insert(host.key(), value.clone());
        value
    } else {
        entry(host).ok().and_then(|entry| entry.get_password().ok())
    }
}

/// What a command may authenticate with: this session's typing, then the keychain.
fn available_password(host: &Host) -> Option<String> {
    session_password(host).or_else(|| stored_password(host))
}

pub fn save_password(host: &Host, password: &str) -> Result<(), String> {
    entry(host)?
        .set_password(password)
        .map_err(|e| format!("Unable to save the password in the system keychain: {e}"))?;
    invalidate(host);
    keep_in_session(host, password);
    Ok(())
}

pub fn forget_password(host: &Host) {
    if let Ok(entry) = entry(host) {
        let _ = entry.delete_credential();
    }
    invalidate(host);
}

/// Hands the password to OpenSSH through an askpass helper that reads a short lived
/// file, so the secret never reaches the process list or an inherited environment.
struct SecretFile {
    path: PathBuf,
}

impl Drop for SecretFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn attach_askpass(cmd: &mut Command, password: &str) -> Result<SecretFile, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!(
        "repoweft-askpass-{}-{stamp}.txt",
        std::process::id()
    ));
    write_private(&path, password)?;
    cmd.env("SSH_ASKPASS", exe);
    cmd.env("SSH_ASKPASS_REQUIRE", "force");
    cmd.env(ASKPASS_MARKER, "1");
    cmd.env(ASKPASS_FILE, &path);
    Ok(SecretFile { path })
}

fn write_private(path: &Path, password: &str) -> Result<(), String> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|e| e.to_string())?;
    file.write_all(password.as_bytes())
        .map_err(|e| e.to_string())
}

/// When the app binary is launched as OpenSSH's askpass helper, answer and exit
/// instead of starting the user interface.
///
/// OpenSSH invokes `ssh_askpass <prompt>` with a server-specific prompt, so the
/// flag cannot come from argv. The marker variable below is only ever set on that
/// helper process.
pub fn askpass_entry() -> Option<i32> {
    if std::env::var(ASKPASS_MARKER).as_deref() != Ok("1") {
        return None;
    }
    let answer = std::env::var_os(ASKPASS_FILE)
        .and_then(|path| fs::read_to_string(path).ok())
        .unwrap_or_default();
    let mut stdout = std::io::stdout();
    let _ = writeln!(stdout, "{}", answer.trim_end_matches(['\r', '\n']));
    let _ = stdout.flush();
    Some(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host() -> Host {
        Host {
            hostname: "example.com".into(),
            username: "deploy".into(),
            port: 0,
            identity_file: String::new(),
        }
    }

    fn args(command: &Command) -> Vec<String> {
        command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn rejects_options_as_hosts_and_usernames() {
        let mut evil = host();
        evil.hostname = "-oProxyCommand=evil".into();
        assert!(command(&evil, Mode::Session).is_err());
        let mut user = host();
        user.username = "-oProxyCommand=evil".into();
        assert!(command(&user, Mode::Session).is_err());
        assert!(command(&host(), Mode::Session).is_ok());
    }

    #[test]
    fn sessions_reuse_one_control_socket_per_host() {
        let session = args(&command(&host(), Mode::Session).unwrap());
        assert!(session.iter().any(|arg| arg == "BatchMode=yes"));
        assert!(session.iter().any(|arg| arg == "StrictHostKeyChecking=yes"));
        // Reuse is a platform capability, so the options must follow the same switch.
        assert_eq!(
            session
                .iter()
                .any(|arg| arg.starts_with("ControlPath=") && arg.ends_with(".sock")),
            multiplexing()
        );
        assert_eq!(session.last().unwrap(), "deploy@example.com");
        // The socket path must stay inside the AF_UNIX limit on Windows.
        assert!(control_path(&host()).to_string_lossy().len() < 100);
        let other = Host {
            port: 2222,
            ..host()
        };
        assert_ne!(control_path(&host()), control_path(&other));
    }

    #[test]
    fn windows_keeps_reuse_off() {
        // Win32 OpenSSH fails inside its socket layer when multiplexing; only an
        // explicit override may turn it back on there.
        if cfg!(windows) && std::env::var(MULTIPLEX_ENV).is_err() {
            assert!(!multiplex_supported());
            assert!(!multiplexing());
        }
    }

    #[test]
    fn saved_password_mode_keeps_keys_first_and_allows_a_single_prompt() {
        let stored = args(&command(&host(), Mode::StoredSecret).unwrap());
        assert!(stored.iter().any(|arg| arg == "BatchMode=no"));
        assert!(
            stored.iter().any(
                |arg| arg == "PreferredAuthentications=publickey,keyboard-interactive,password"
            )
        );
        assert!(stored.iter().any(|arg| arg == "NumberOfPasswordPrompts=1"));
    }

    #[test]
    fn password_mode_allows_prompts_without_touching_known_hosts() {
        let password = args(&command(&host(), Mode::Password).unwrap());
        assert!(password.iter().any(|arg| arg == "BatchMode=no"));
        assert!(
            password
                .iter()
                .any(|arg| arg == "NumberOfPasswordPrompts=1")
        );
        assert!(
            password
                .iter()
                .any(|arg| arg == "StrictHostKeyChecking=yes")
        );
        assert!(
            password
                .iter()
                .any(|arg| arg == "PreferredAuthentications=keyboard-interactive,password")
        );
    }

    #[test]
    fn trust_mode_accepts_new_keys_but_never_reuses_a_connection() {
        let trust = args(&command(&host(), Mode::Trust).unwrap());
        assert!(
            trust
                .iter()
                .any(|arg| arg == "StrictHostKeyChecking=accept-new")
        );
        assert!(!trust.iter().any(|arg| arg.starts_with("ControlPath=")));
    }

    #[test]
    fn recognizes_missing_multiplexing_support() {
        assert!(multiplex_error("Multiplexing is not supported"));
        assert!(multiplex_error("Control socket connect(/tmp/x): failed"));
        // The Win32 socket layer failure that broke every command on Windows.
        assert!(multiplex_error("getsockname failed: Not a socket"));
        assert!(!multiplex_error("Permission denied (publickey)"));
    }

    #[test]
    fn distinguishes_ssh_rejections_from_remote_file_permissions() {
        assert!(denied(
            "deploy@host: Permission denied (publickey,password)."
        ));
        assert!(denied("Permission denied, please try again."));
        assert!(!denied("error: open('.git/index'): Permission denied"));
    }

    #[test]
    fn rejected_credentials_reach_the_ui_as_a_prompt() {
        assert_eq!(
            explain("Permission denied (publickey).".into()),
            AUTH_REQUIRED
        );
        assert!(needs_credentials(AUTH_REQUIRED));
        assert!(needs_credentials("Permission denied (publickey,password)."));
        // A remote file permission problem is not an authentication prompt.
        assert!(!needs_credentials(
            "error: open('.git/index'): Permission denied"
        ));
        assert_eq!(
            explain("error: open('.git/index'): Permission denied".into()),
            "error: open('.git/index'): Permission denied"
        );
    }

    #[test]
    fn known_hosts_failures_become_ui_signals() {
        assert_eq!(
            explain("Host key verification failed.".into()),
            HOST_KEY_UNKNOWN
        );
        assert_eq!(
            explain("@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@".into()),
            HOST_KEY_CHANGED
        );
        assert_eq!(
            explain("fatal: not a git repository".into()),
            "fatal: not a git repository"
        );
    }

    #[test]
    fn askpass_reads_the_secret_file_and_trims_the_newline() {
        let path = std::env::temp_dir().join(format!(
            "repoweft-askpass-test-{}-{}",
            std::process::id(),
            "secret"
        ));
        write_private(&path, "p@ss word\n").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "p@ss word\n");
        fs::remove_file(&path).unwrap();
        // A second writer must not silently reuse the same file.
        write_private(&path, "first").unwrap();
        assert!(write_private(&path, "second").is_err());
        fs::remove_file(&path).unwrap();
    }
}
