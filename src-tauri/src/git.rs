use crate::ssh::{self, Host};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::Read,
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

#[derive(Clone, Deserialize)]
pub struct Location {
    pub kind: String,
    pub path: String,
    pub host: Option<Host>,
}
#[derive(Serialize)]
pub struct Commit {
    hash: String,
    parents: Vec<String>,
    author: String,
    email: String,
    timestamp: i64,
    message: String,
    refs: Vec<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    path: String,
    index: String,
    worktree: String,
    original_path: Option<String>,
}
#[derive(Serialize)]
pub struct Branch {
    name: String,
    current: bool,
    remote: bool,
    upstream: String,
    hash: String,
}
#[derive(Serialize)]
pub struct Remote {
    name: String,
    url: String,
}
#[derive(Serialize)]
pub struct Snapshot {
    branch: String,
    commits: Vec<Commit>,
    files: Vec<FileChange>,
    branches: Vec<Branch>,
    remotes: Vec<Remote>,
}
#[derive(Deserialize)]
pub struct Action {
    kind: String,
    paths: Option<Vec<String>>,
    value: Option<String>,
    extra: Option<String>,
}
#[derive(Serialize)]
pub struct CommitFile {
    path: String,
    added: String,
    deleted: String,
}
#[derive(Serialize)]
pub struct CommitDetail {
    message: String,
    files: Vec<CommitFile>,
}

type RepoLocks = HashMap<String, Arc<Mutex<()>>>;
#[derive(Default)]
pub struct GitState {
    locks: Mutex<RepoLocks>,
}

pub(crate) fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
fn valid_text(value: &str) -> Result<(), String> {
    if value.contains('\0') {
        Err("NUL bytes are not allowed".into())
    } else {
        Ok(())
    }
}
pub(crate) fn output(mut command: Command, timeout: u64) -> Result<String, String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("Unable to start Git/OpenSSH: {e}"))?;
    let stdout = child.stdout.take().ok_or("Missing stdout")?;
    let stderr = child.stderr.take().ok_or("Missing stderr")?;
    // Drain both pipes concurrently. Keep bounded output while continuing to drain.
    fn drain(mut pipe: impl Read) -> (Vec<u8>, bool) {
        let mut result = Vec::new();
        let mut buffer = [0; 8192];
        let mut overflow = false;
        loop {
            match pipe.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if result.len() + n <= 16 * 1024 * 1024 {
                        result.extend_from_slice(&buffer[..n]);
                    } else {
                        overflow = true;
                    }
                }
            }
        }
        (result, overflow)
    }
    let out = std::thread::spawn(move || drain(stdout));
    let err = std::thread::spawn(move || drain(stderr));
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < Duration::from_secs(timeout) => {
                std::thread::sleep(Duration::from_millis(3))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Operation timed out. Refresh the repository to check its state before retrying.".into());
            }
        }
    };
    let (stdout, overflow) = out.join().map_err(|_| "Output reader failed")?;
    let (stderr, _) = err.join().map_err(|_| "Error reader failed")?;
    if !status.success() {
        return Err(String::from_utf8_lossy(&stderr).trim().to_string());
    }
    if overflow {
        return Err("Output exceeds 16 MiB. Select a smaller diff or history page.".into());
    }
    Ok(String::from_utf8_lossy(&stdout).into_owned())
}
fn git(location: &Location, args: &[&str]) -> Result<String, String> {
    valid_text(&location.path)?;
    for arg in args {
        valid_text(arg)?;
    }
    if location.path.is_empty() {
        return Err("Repository path is required".into());
    }
    match location.kind.as_str() {
        "local" => {
            let mut cmd = Command::new("git");
            cmd.env("GIT_TERMINAL_PROMPT", "0")
                .env("GIT_OPTIONAL_LOCKS", "0");
            let account_id = if matches!(args.first(), Some(&"fetch" | &"pull" | &"push"))
                && crate::accounts::has_github_remote(&location.path)?
            {
                crate::accounts::configure(&mut cmd, Some(&location.path))?
            } else {
                None
            };
            cmd.args(["--no-pager", "-C", &location.path]).args(args);
            crate::accounts::network_output(cmd, 180, account_id.as_deref())
        }
        "ssh" => {
            if !location.path.starts_with('/') {
                return Err("Remote path must be absolute".into());
            }
            let host = location.host.as_ref().ok_or("SSH host is missing")?;
            let encoded = args.iter().map(|a| quote(a)).collect::<Vec<_>>().join(" ");
            ssh::exec(
                host,
                ssh::Mode::Session,
                &format!(
                    "GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 git --no-pager -C {} {}",
                    quote(&location.path),
                    encoded
                ),
                180,
            )
        }
        _ => Err("Unknown repository backend".into()),
    }
}
fn parse_log(raw: &str) -> Vec<Commit> {
    raw.split('\x1e')
        .filter_map(|record| {
            let fields: Vec<_> = record
                .trim_start_matches(['\n', '\r'])
                .splitn(7, '\0')
                .collect();
            if fields.len() != 7 {
                return None;
            }
            Some(Commit {
                hash: fields[0].into(),
                parents: fields[1].split_whitespace().map(str::to_string).collect(),
                author: fields[2].into(),
                email: fields[3].into(),
                timestamp: fields[4].parse::<i64>().unwrap_or(0) * 1000,
                message: fields[5].into(),
                refs: fields[6]
                    .trim()
                    .split(", ")
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .collect(),
            })
        })
        .collect()
}
fn parse_status(raw: &str) -> Vec<FileChange> {
    let mut entries = raw.split('\0');
    let mut files = Vec::new();
    while let Some(entry) = entries.next() {
        if entry.len() < 4 {
            continue;
        }
        let index = &entry[..1];
        let worktree = &entry[1..2];
        let original_path = if index == "R" || index == "C" || worktree == "R" || worktree == "C" {
            entries.next().map(str::to_string)
        } else {
            None
        };
        files.push(FileChange {
            path: entry[3..].into(),
            index: index.into(),
            worktree: worktree.into(),
            original_path,
        });
    }
    files
}
fn log(location: &Location, skip: usize, current_only: bool) -> Result<Vec<Commit>, String> {
    let limit = "100";
    let skip = skip.to_string();
    let mut args = vec![
        "log",
        "--date-order",
        "--max-count",
        limit,
        "--skip",
        &skip,
        "--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x00%D%x1e",
    ];
    if current_only {
        // Follow the branch mainline; retain merges without expanding their side histories.
        args.push("--first-parent");
    } else {
        args.push("--all");
    }
    args.push("HEAD");
    args.push("--");
    match git(location, &args) {
        Ok(raw) => Ok(parse_log(&raw)),
        Err(error) => {
            // Validate only on failure so the common case needs one process.
            if git(location, &["rev-parse", "--verify", "HEAD"]).is_err() {
                git(location, &["rev-parse", "--git-dir"])?;
                Ok(Vec::new())
            } else {
                Err(error)
            }
        }
    }
}
fn snapshot(location: &Location) -> Result<Snapshot, String> {
    let inside = git(location, &["rev-parse", "--is-inside-work-tree"])?;
    if inside.trim() != "true" {
        return Err(
            "Choose a Git working directory. Bare repositories are not supported yet.".into(),
        );
    }
    let (branch, files, commits, raw_branches, raw_remotes) = std::thread::scope(|scope| {
        let status = scope.spawn(|| {
            git(
                location,
                &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
            )
        });
        let history = scope.spawn(|| log(location, 0, false));
        let refs = scope.spawn(|| {
            git(
                location,
                &[
                    "for-each-ref",
                    "--format=%(refname)%00%(HEAD)%00%(upstream:short)%00%(objectname)",
                    "refs/heads",
                    "refs/remotes",
                ],
            )
        });
        let remotes = scope.spawn(|| git(location, &["remote", "-v"]));
        let branch = git(location, &["symbolic-ref", "--short", "-q", "HEAD"])
            .unwrap_or_else(|_| "HEAD (detached)".into())
            .trim()
            .to_string();
        Ok::<_, String>((
            branch,
            parse_status(&status.join().map_err(|_| "Status reader failed")??),
            history.join().map_err(|_| "History reader failed")??,
            refs.join().map_err(|_| "Reference reader failed")??,
            remotes.join().map_err(|_| "Remote reader failed")??,
        ))
    })?;
    let branches = raw_branches
        .lines()
        .filter_map(|line| {
            let f: Vec<_> = line.split('\0').collect();
            if f.len() != 4 || f[0].ends_with("/HEAD") {
                return None;
            }
            let remote = f[0].starts_with("refs/remotes/");
            Some(Branch {
                name: f[0]
                    .trim_start_matches(if remote {
                        "refs/remotes/"
                    } else {
                        "refs/heads/"
                    })
                    .into(),
                current: f[1] == "*",
                remote,
                upstream: f[2].into(),
                hash: f[3].into(),
            })
        })
        .collect();
    let remotes = raw_remotes
        .lines()
        .filter_map(|line| {
            let (name, rest) = line.split_once('\t')?;
            let url = rest.strip_suffix(" (fetch)")?;
            Some(Remote {
                name: name.into(),
                url: url.into(),
            })
        })
        .collect();
    Ok(Snapshot {
        branch,
        commits,
        files,
        branches,
        remotes,
    })
}
fn validate_hash(hash: &str) -> Result<(), String> {
    if !(4..=64).contains(&hash.len()) || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
        Err("Invalid commit hash".into())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub async fn repository_snapshot(location: Location) -> Result<Snapshot, String> {
    blocking(move || snapshot(&location)).await
}
#[tauri::command]
pub async fn repository_log(
    location: Location,
    skip: usize,
    current_only: bool,
) -> Result<Vec<Commit>, String> {
    blocking(move || log(&location, skip, current_only)).await
}
#[tauri::command]
pub async fn repository_detail(location: Location, hash: String) -> Result<CommitDetail, String> {
    blocking(move || {
        validate_hash(&hash)?;
        let message = git(&location, &["show", "-s", "--format=%B", &hash, "--"])?;
        let raw = git(
            &location,
            &[
                "diff-tree",
                "--root",
                "--no-commit-id",
                "-r",
                "--numstat",
                "-z",
                "--no-renames",
                &hash,
                "--",
            ],
        )?;
        let files = raw
            .split('\0')
            .filter_map(|line| {
                let f: Vec<_> = line.splitn(3, '\t').collect();
                if f.len() != 3 {
                    return None;
                }
                Some(CommitFile {
                    path: f[2].into(),
                    added: f[0].into(),
                    deleted: f[1].into(),
                })
            })
            .collect();
        Ok(CommitDetail {
            message: message.trim().into(),
            files,
        })
    })
    .await
}
#[tauri::command]
pub async fn repository_diff(
    location: Location,
    path: String,
    staged: bool,
    hash: Option<String>,
    untracked: bool,
) -> Result<String, String> {
    blocking(move || {
        if let Some(hash) = hash {
            validate_hash(&hash)?;
            return git(
                &location,
                &[
                    "show",
                    "--format=",
                    "--no-ext-diff",
                    "--no-textconv",
                    &hash,
                    "--",
                    &path,
                ],
            );
        }
        if untracked {
            // Git's no-index mode exits 1 when it finds differences.
            if location.kind == "ssh" {
                return Err("Stage the untracked file to view its diff on the remote host.".into());
            }
            let root = std::fs::canonicalize(&location.path).map_err(|e| e.to_string())?;
            let file = std::fs::canonicalize(root.join(&path)).map_err(|e| e.to_string())?;
            if !file.starts_with(&root) || !file.is_file() {
                return Err("File is outside the repository".into());
            }
            if std::fs::metadata(&file).map_err(|e| e.to_string())?.len() > 1024 * 1024 {
                return Err("File preview is limited to 1 MiB".into());
            }
            let bytes = std::fs::read(file).map_err(|e| e.to_string())?;
            if bytes.contains(&0) {
                return Ok("Binary file".into());
            }
            return Ok(String::from_utf8_lossy(&bytes)
                .lines()
                .map(|s| format!("+{s}\n"))
                .collect());
        }
        let mut args = vec!["diff", "--no-ext-diff", "--no-textconv"];
        if staged {
            args.push("--cached");
        }
        args.extend(["--", &path]);
        git(&location, &args)
    })
    .await
}
#[tauri::command]
pub async fn repository_action(
    state: tauri::State<'_, GitState>,
    location: Location,
    action: Action,
) -> Result<String, String> {
    let key = format!(
        "{}:{}:{}",
        location.kind,
        location
            .host
            .as_ref()
            .map(|h| h.hostname.as_str())
            .unwrap_or(""),
        location.path
    );
    let lock = state
        .locks
        .lock()
        .map_err(|e| e.to_string())?
        .entry(key)
        .or_default()
        .clone();
    blocking(move || {
        let _guard = lock.lock().map_err(|e| e.to_string())?;
        execute_action(&location, action)
    })
    .await
}
fn execute_action(location: &Location, action: Action) -> Result<String, String> {
    let value = action.value.unwrap_or_default();
    let extra = action.extra.unwrap_or_default();
    if value.starts_with('-') && action.kind != "commit" {
        return Err("Values cannot start with '-'".into());
    }
    let paths = action.paths.unwrap_or_default();
    match action.kind.as_str() {
        "stage" => {
            if paths.is_empty() {
                return Err("Select files to stage".into());
            }
            let mut args = vec!["add", "--"];
            args.extend(paths.iter().map(String::as_str));
            git(location, &args)
        }
        "unstage" => {
            if paths.is_empty() {
                return Err("Select files to unstage".into());
            }
            let head = git(location, &["rev-parse", "--verify", "HEAD"]).is_ok();
            let mut args = if head {
                vec!["reset", "-q", "HEAD", "--"]
            } else {
                vec!["rm", "--cached", "-r", "--force", "--"]
            };
            args.extend(paths.iter().map(String::as_str));
            git(location, &args)
        }
        "commit" => {
            if value.trim().is_empty() {
                return Err("Commit message is required".into());
            }
            git(location, &["commit", "-m", &value])
        }
        "fetch" => git(location, &["fetch", "--all"]),
        "pull" => git(location, &["pull", "--ff-only"]),
        "push" => git(location, &["push"]),
        "createBranch" => {
            git(location, &["check-ref-format", "--branch", &value])?;
            git(location, &["switch", "-c", &value])
        }
        "switchBranch" => git(location, &["switch", "--", &value]),
        "deleteBranch" => git(location, &["branch", "-d", "--", &value]),
        "merge" => git(location, &["merge", "--no-edit", "--", &value]),
        "addRemote" => {
            if value.is_empty() || extra.is_empty() || extra.starts_with('-') {
                return Err("Remote name and URL are required".into());
            }
            git(location, &["remote", "add", &value, &extra])
        }
        "removeRemote" => git(location, &["remote", "remove", &value]),
        _ => Err("Unsupported Git operation".into()),
    }
}
#[tauri::command]
pub async fn repository_create(path: String, url: Option<String>) -> Result<(), String> {
    blocking(move || {
        valid_text(&path)?;
        if !std::path::Path::new(&path).is_absolute() {
            return Err("Choose an absolute destination path".into());
        }
        if let Some(url) = url {
            valid_text(&url)?;
            if url.is_empty() || url.starts_with('-') {
                return Err("Invalid repository URL".into());
            }
            let mut cmd = Command::new("git");
            let account_id = if crate::accounts::github_url(&url) {
                crate::accounts::configure(&mut cmd, None)?
            } else {
                None
            };
            cmd.env("GIT_TERMINAL_PROMPT", "0")
                .args(["clone", "--", &url, &path]);
            crate::accounts::network_output(cmd, 600, account_id.as_deref())?;
            if let Some(id) = account_id {
                crate::accounts::write_binding(&path, Some(&id))?;
            }
        } else {
            std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
            let mut cmd = Command::new("git");
            cmd.args(["init", "--", &path]);
            output(cmd, 30)?;
        }
        Ok(())
    })
    .await
}
/// Initialize or clone a repository on a remote host without leaving the app.
#[tauri::command]
pub async fn repository_create_remote(
    host: Host,
    path: String,
    url: Option<String>,
) -> Result<String, String> {
    blocking(move || {
        valid_text(&path)?;
        if !path.starts_with('/') {
            return Err("Remote path must be absolute".into());
        }
        let remote = match url {
            Some(url) => {
                valid_text(&url)?;
                if url.is_empty() || url.starts_with('-') {
                    return Err("Invalid repository URL".into());
                }
                format!(
                    "GIT_TERMINAL_PROMPT=0 git clone -- {} {}",
                    quote(&url),
                    quote(&path)
                )
            }
            None => format!("GIT_TERMINAL_PROMPT=0 git init -- {}", quote(&path)),
        };
        ssh::exec(&host, ssh::Mode::Session, &remote, 600)?;
        Ok(path.trim_end_matches('/').to_string())
    })
    .await
}
#[tauri::command]
pub async fn ssh_test(host: Host) -> Result<String, String> {
    blocking(move || ssh::exec(&host, ssh::Mode::Session, "git --version", 20)).await
}
/// Authenticate a host, reusing a multiplexed connection and, when the user asked
/// for it, the password kept in the system keychain.
#[tauri::command]
pub async fn ssh_connect(
    host: Host,
    password: Option<String>,
    remember: bool,
) -> Result<(), String> {
    blocking(move || ssh::connect(&host, password.as_deref(), remember)).await
}
#[tauri::command]
pub async fn ssh_trust(host: Host) -> Result<(), String> {
    blocking(move || ssh::trust(&host)).await
}
#[tauri::command]
pub async fn ssh_host_key(host: Host) -> Result<String, String> {
    blocking(move || ssh::host_key(&host)).await
}
#[tauri::command]
pub async fn ssh_password_saved(host: Host) -> bool {
    ssh::stored_password(&host).is_some()
}
#[tauri::command]
pub async fn ssh_reuse_enabled() -> bool {
    ssh::reuse_enabled()
}
#[tauri::command]
pub async fn ssh_forget_password(host: Host) {
    ssh::forget_password(&host);
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryListing {
    path: String,
    directories: Vec<DirectoryEntry>,
}
#[derive(Serialize)]
pub struct DirectoryEntry {
    path: String,
    accessible: bool,
}

fn directory_command(path: &str) -> Result<String, String> {
    valid_text(path)?;
    if !path.is_empty() && !path.starts_with('/') {
        return Err("Remote path must be absolute".into());
    }
    let destination = if path.is_empty() {
        "\"$HOME\"".into()
    } else {
        quote(path)
    };
    // Enumerate entries without descending into other users' directories. Permission
    // checks use the SSH user's effective access, including ACLs and directory search.
    // NUL delimiters preserve spaces and newlines in names.
    Ok(format!(
        "cd {destination} || exit; if [ ! -r . ] || [ ! -x . ]; then printf '%s\\n' 'Permission denied: cannot list this directory' >&2; exit 1; fi; printf '%s\\0' \"$PWD\"; for entry in ./* ./.[!.]* ./..?*; do [ -d \"$entry\" ] || continue; if [ -r \"$entry\" ] && [ -x \"$entry\" ]; then printf '1\\0%s\\0' \"$entry\"; else printf '0\\0%s\\0' \"$entry\"; fi; done; true"
    ))
}
fn parse_directory_listing(raw: &str) -> Result<DirectoryListing, String> {
    let mut parts = raw.split('\0');
    let path = parts
        .next()
        .filter(|s| s.starts_with('/'))
        .ok_or("Invalid remote directory response")?
        .to_string();
    let mut directories = Vec::new();
    while let Some(access) = parts.next().filter(|s| !s.is_empty()) {
        let name = parts
            .next()
            .filter(|s| s.starts_with("./"))
            .ok_or("Invalid remote directory entry")?;
        if access != "0" && access != "1" {
            return Err("Invalid remote directory permissions".into());
        }
        directories.push(DirectoryEntry {
            path: format!(
                "{}/{}",
                path.trim_end_matches('/'),
                name.trim_start_matches("./")
            ),
            accessible: access == "1",
        });
    }
    directories.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(DirectoryListing { path, directories })
}
#[tauri::command]
pub async fn ssh_directories(host: Host, path: String) -> Result<DirectoryListing, String> {
    blocking(move || {
        let remote = directory_command(&path)?;
        let raw = ssh::exec(&host, ssh::Mode::Session, &remote, 20)?;
        parse_directory_listing(&raw)
    })
    .await
}
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shell_arguments_are_single_tokens() {
        assert_eq!(quote("/a b/it's;$(touch x)"), "'/a b/it'\\''s;$(touch x)'");
    }
    #[test]
    fn remote_browser_starts_at_home_and_preserves_directory_names() {
        assert!(directory_command("").unwrap().contains("cd \"$HOME\""));
        assert!(directory_command("relative").is_err());
        let listing = parse_directory_listing(
            "/home/user\x001\0./repo one\x001\0./line\nbreak\x000\0./.hidden\0",
        )
        .unwrap();
        assert_eq!(listing.path, "/home/user");
        assert!(
            listing
                .directories
                .iter()
                .any(|entry| entry.path == "/home/user/repo one" && entry.accessible)
        );
        assert!(
            listing
                .directories
                .iter()
                .any(|entry| entry.path == "/home/user/line\nbreak" && entry.accessible)
        );
        assert!(
            listing
                .directories
                .iter()
                .any(|entry| entry.path == "/home/user/.hidden" && !entry.accessible)
        );
        let root = parse_directory_listing("/\x001\0./projects\0").unwrap();
        assert_eq!(root.directories[0].path, "/projects");
        assert!(root.directories[0].accessible);
    }
    #[test]
    fn remote_browser_keeps_owned_directories_when_neighbours_are_inaccessible() {
        let result =
            parse_directory_listing("/data\x000\0./daixiangting\x001\0./my-repo\0").unwrap();
        assert_eq!(result.directories.len(), 2);
        assert!(!result.directories[0].accessible);
        assert_eq!(result.directories[1].path, "/data/my-repo");
        assert!(result.directories[1].accessible);
        let command = directory_command("/data").unwrap();
        assert!(!command.contains("find "));
        assert!(parse_directory_listing("/data\x001\0").is_err());
    }
    #[test]
    fn status_handles_renames_and_unicode() {
        let files = parse_status("R  新 名.txt\0old.txt\0 M src/main.rs\0?? new.txt\0");
        assert_eq!(files.len(), 3);
        assert_eq!(files[0].path, "新 名.txt");
        assert_eq!(files[0].original_path.as_deref(), Some("old.txt"));
        assert_eq!(files[1].worktree, "M");
    }
    #[test]
    fn parses_merge_parents() {
        let commits = parse_log(
            "abc123\0def456 789abc\0Alice\0a@b.com\01700000000\0Merge feature\0HEAD -> main, origin/main\x1e\n",
        );
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].parents.len(), 2);
        assert_eq!(commits[0].refs.len(), 2);
    }
    #[test]
    fn reads_ssh_aliases_and_includes_without_duplicates_or_cycles() {
        let dir = std::env::temp_dir().join(format!("repoweft-ssh-test-{}", std::process::id()));
        std::fs::create_dir_all(dir.join(".ssh/hosts")).unwrap();
        std::fs::write(dir.join(".ssh/config"), "Host alpha beta\n HostName example.com\nHost * !excluded *.internal\nInclude hosts/*.conf\n").unwrap();
        std::fs::write(
            dir.join(".ssh/hosts/team.conf"),
            "Host=gamma alpha\nInclude config\nHost lab(FJW) # comment\n",
        )
        .unwrap();
        let mut aliases = Vec::new();
        config_aliases(
            &dir.join(".ssh/config"),
            &dir,
            &mut std::collections::HashSet::new(),
            &mut aliases,
        )
        .unwrap();
        assert_eq!(aliases, ["alpha", "beta", "gamma", "lab(FJW)"]);
        let host = Host {
            hostname: aliases[3].clone(),
            username: String::new(),
            port: 0,
            identity_file: String::new(),
        };
        let command = ssh::command(&host, ssh::Mode::Session).unwrap();
        let args: Vec<_> = command
            .get_args()
            .map(|s| s.to_string_lossy().into_owned())
            .collect();
        assert!(!args.contains(&"-p".to_string()));
        assert!(!args.contains(&"-i".to_string()));
        assert_eq!(args.last().unwrap(), "lab(FJW)");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    #[ignore = "Set REPOWEFT_BENCH_PATH to benchmark a real repository read-only"]
    fn benchmark_snapshot() {
        let path = std::env::var("REPOWEFT_BENCH_PATH").expect("Set REPOWEFT_BENCH_PATH");
        let location = Location {
            kind: "local".into(),
            path,
            host: None,
        };
        for _ in 0..3 {
            let start = Instant::now();
            let data = snapshot(&location).unwrap();
            println!(
                "snapshot: {:?}, {} commits, {} files",
                start.elapsed(),
                data.commits.len(),
                data.files.len()
            );
        }
    }

    #[test]
    fn local_workflow() {
        let dir = std::env::temp_dir().join(format!("repoweft-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let loc = Location {
            kind: "local".into(),
            path: dir.to_string_lossy().into(),
            host: None,
        };
        git(&loc, &["init"]).unwrap();
        git(&loc, &["config", "user.name", "RepoWeft Test"]).unwrap();
        git(&loc, &["config", "user.email", "test@repoweft.local"]).unwrap();
        git(&loc, &["config", "commit.gpgsign", "false"]).unwrap();
        git(&loc, &["config", "core.hooksPath", ".git/empty-hooks"]).unwrap();
        let action = |kind: &str, paths: Vec<&str>, value: &str| Action {
            kind: kind.into(),
            paths: Some(paths.into_iter().map(str::to_string).collect()),
            value: Some(value.into()),
            extra: None,
        };
        git(
            &loc,
            &[
                "remote",
                "add",
                "origin",
                "https://github.com/example/repo.git",
            ],
        )
        .unwrap();
        git(
            &loc,
            &[
                "remote",
                "set-url",
                "--push",
                "origin",
                "git@github.com:example/repo.git",
            ],
        )
        .unwrap();
        let empty = snapshot(&loc).unwrap();
        assert!(empty.commits.is_empty());
        assert_eq!(empty.remotes.len(), 1);
        assert_eq!(empty.remotes[0].name, "origin");
        assert_eq!(empty.remotes[0].url, "https://github.com/example/repo.git");
        std::fs::write(dir.join("你好.txt"), "hello\n").unwrap();
        assert_eq!(snapshot(&loc).unwrap().files.len(), 1);
        execute_action(&loc, action("stage", vec!["你好.txt"], "")).unwrap();
        // Unstage before the first commit, preserving modifications made after staging.
        std::fs::write(dir.join("你好.txt"), "hello\nworld\n").unwrap();
        execute_action(&loc, action("unstage", vec!["你好.txt"], "")).unwrap();
        assert_eq!(snapshot(&loc).unwrap().files[0].index, "?");
        assert!(
            std::fs::read_to_string(dir.join("你好.txt"))
                .unwrap()
                .contains("world")
        );
        execute_action(&loc, action("stage", vec!["你好.txt"], "")).unwrap();
        execute_action(&loc, action("commit", vec![], "Initial commit")).unwrap();
        let data = snapshot(&loc).unwrap();
        assert_eq!(data.commits.len(), 1);
        assert!(data.files.is_empty());
        let detail = tauri::async_runtime::block_on(repository_detail(
            loc.clone(),
            data.commits[0].hash.clone(),
        ))
        .unwrap();
        assert_eq!(detail.files[0].path, "你好.txt");
        execute_action(&loc, action("createBranch", vec![], "feature/test")).unwrap();
        assert_eq!(snapshot(&loc).unwrap().branch, "feature/test");
        git(
            &loc,
            &["commit", "--allow-empty", "-m", "Feature-only commit"],
        )
        .unwrap();
        assert_eq!(log(&loc, 0, true).unwrap().len(), 2);
        execute_action(&loc, action("switchBranch", vec![], &data.branch)).unwrap();
        assert_eq!(snapshot(&loc).unwrap().branch, data.branch);
        assert_eq!(log(&loc, 0, true).unwrap().len(), 1);
        assert_eq!(log(&loc, 0, false).unwrap().len(), 2);
        std::fs::write(dir.join("你好.txt"), "hello\nworld\nnew line\n").unwrap();
        let diff = tauri::async_runtime::block_on(repository_diff(
            loc.clone(),
            "你好.txt".into(),
            false,
            None,
            false,
        ))
        .unwrap();
        assert!(diff.contains("+new line"));
        execute_action(&loc, action("stage", vec!["你好.txt"], "")).unwrap();
        execute_action(&loc, action("unstage", vec!["你好.txt"], "")).unwrap();
        assert_eq!(snapshot(&loc).unwrap().files[0].index, " ");
        git(&loc, &["restore", "--", "你好.txt"]).unwrap();
        git(
            &loc,
            &["merge", "--no-ff", "feature/test", "-m", "Merge feature"],
        )
        .unwrap();
        let mainline = log(&loc, 0, true).unwrap();
        assert_eq!(mainline.len(), 2);
        assert_eq!(mainline[0].message, "Merge feature");
        assert_eq!(mainline[0].parents.len(), 2);
        assert!(mainline.iter().all(|c| c.message != "Feature-only commit"));
        let all = log(&loc, 0, false).unwrap();
        assert_eq!(all.len(), 3);
        assert!(all.iter().any(|c| c.message == "Feature-only commit"));
        let next_page = log(&loc, 1, true).unwrap();
        assert_eq!(next_page.len(), 1);
        assert_eq!(next_page[0].hash, data.commits[0].hash);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigHost {
    id: String,
    name: String,
    hostname: String,
    username: String,
    port: u16,
    identity_file: String,
}

fn config_aliases(
    path: &std::path::Path,
    home: &std::path::Path,
    seen: &mut std::collections::HashSet<std::path::PathBuf>,
    aliases: &mut Vec<String>,
) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let canonical = path.canonicalize().map_err(|e| e.to_string())?;
    if !seen.insert(canonical) {
        return Ok(());
    }
    let text =
        std::fs::read_to_string(path).map_err(|e| format!("Unable to read SSH config: {e}"))?;
    for line in text.lines() {
        let line = line.split('#').next().unwrap_or("").trim();
        let mut fields = line.splitn(2, |c: char| c.is_whitespace() || c == '=');
        let key = fields.next().unwrap_or("");
        let value = fields
            .next()
            .unwrap_or("")
            .trim()
            .trim_start_matches('=')
            .trim();
        if key.eq_ignore_ascii_case("host") {
            for alias in value.split_whitespace() {
                if !alias.contains(['*', '?', '!']) && !aliases.iter().any(|a| a == alias) {
                    aliases.push(alias.to_owned());
                }
            }
        } else if key.eq_ignore_ascii_case("include") {
            for pattern in value.split_whitespace() {
                let pattern = pattern.trim_matches('"');
                let expanded = if let Some(rest) = pattern.strip_prefix("~/") {
                    home.join(rest)
                } else {
                    let candidate = std::path::PathBuf::from(pattern);
                    if candidate.is_absolute() {
                        candidate
                    } else {
                        home.join(".ssh").join(candidate)
                    }
                };
                for entry in glob::glob(&expanded.to_string_lossy()).map_err(|e| e.to_string())? {
                    config_aliases(&entry.map_err(|e| e.to_string())?, home, seen, aliases)?;
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_config_hosts() -> Result<Vec<ConfigHost>, String> {
    blocking(move || {
        let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
            .ok_or("Home directory unavailable")?;
        let home = std::path::PathBuf::from(home);
        let mut aliases = Vec::new();
        let mut seen = std::collections::HashSet::new();
        config_aliases(&home.join(".ssh/config"), &home, &mut seen, &mut aliases)?;
        Ok(aliases
            .into_iter()
            .map(|name| ConfigHost {
                id: format!("ssh-config:{name}"),
                hostname: name.clone(),
                name,
                username: String::new(),
                port: 0,
                identity_file: String::new(),
            })
            .collect())
    })
    .await
}
