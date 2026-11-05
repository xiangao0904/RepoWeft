use serde::{Deserialize, Serialize};
use std::{
    io::{self, BufRead},
    process::Command,
    sync::Mutex,
    time::Duration,
};

pub(crate) static STORE_LOCK: Mutex<()> = Mutex::new(());
pub(crate) const SERVICE: &str = "repoweft.github";

#[derive(Clone, Serialize, Deserialize)]
pub struct Account {
    pub id: String,
    pub login: String,
    #[serde(default = "pat_method")]
    pub method: String,
    #[serde(default)]
    pub reauthorize: bool,
}
fn pat_method() -> String {
    "pat".into()
}
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Accounts {
    pub accounts: Vec<Account>,
    pub active_id: Option<String>,
}

fn registry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, "accounts").map_err(|_| "ACCOUNT_STORAGE_FAILED".into())
}
pub(crate) fn read() -> Result<Accounts, String> {
    match registry()?.get_password() {
        Ok(raw) => serde_json::from_str(&raw).map_err(|_| "ACCOUNT_STORAGE_FAILED".into()),
        Err(keyring::Error::NoEntry) => Ok(Accounts::default()),
        Err(_) => Err("ACCOUNT_STORAGE_FAILED".into()),
    }
}
pub(crate) fn save(accounts: &Accounts) -> Result<(), String> {
    registry()?
        .set_password(&serde_json::to_string(accounts).map_err(|_| "ACCOUNT_STORAGE_FAILED")?)
        .map_err(|_| "ACCOUNT_STORAGE_FAILED".into())
}
pub(crate) fn token_entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, &format!("token:{id}"))
        .map_err(|_| "ACCOUNT_STORAGE_FAILED".into())
}
pub(crate) async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|_| "ACCOUNT_STORAGE_FAILED".to_string())?
}
#[tauri::command]
pub async fn accounts_list() -> Result<Accounts, String> {
    blocking(|| {
        let _guard = STORE_LOCK.lock().map_err(|_| "ACCOUNT_STORAGE_FAILED")?;
        let mut state = read()?;
        for account in &mut state.accounts {
            if account.method == "oauth" {
                account.reauthorize |= crate::oauth::needs_reauthorization(&account.id);
            }
        }
        Ok(state)
    })
    .await
}
#[tauri::command]
pub async fn account_connect(token: String) -> Result<Accounts, String> {
    let token = token.trim().to_owned();
    if token.is_empty() || token.chars().any(char::is_whitespace) {
        return Err("ACCOUNT_INVALID_TOKEN".into());
    }
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(25))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "ACCOUNT_NETWORK_FAILED")?
        .get("https://api.github.com/user")
        .header("User-Agent", "RepoWeft")
        .header("Accept", "application/vnd.github+json")
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|_| "ACCOUNT_NETWORK_FAILED")?;
    if response.status() == 401 || response.status() == 403 {
        return Err("ACCOUNT_INVALID_TOKEN".into());
    }
    if !response.status().is_success() {
        return Err("ACCOUNT_NETWORK_FAILED".into());
    }
    #[derive(Deserialize)]
    struct User {
        id: u64,
        login: String,
    }
    let user: User = serde_json::from_str(
        &response
            .text()
            .await
            .map_err(|_| "ACCOUNT_NETWORK_FAILED")?,
    )
    .map_err(|_| "ACCOUNT_NETWORK_FAILED")?;
    blocking(move || {
        let _guard = STORE_LOCK.lock().map_err(|_| "ACCOUNT_STORAGE_FAILED")?;
        let mut state = read()?;
        let id = user.id.to_string();
        // Bound the registry to stay inside Windows Credential Manager's entry limit.
        if state.accounts.len() >= 8 && !state.accounts.iter().any(|a| a.id == id) {
            return Err("ACCOUNT_LIMIT".into());
        }
        token_entry(&id)?
            .set_password(&token)
            .map_err(|_| "ACCOUNT_STORAGE_FAILED")?;
        state.accounts.retain(|a| a.id != id);
        state.accounts.push(Account {
            id: id.clone(),
            login: user.login,
            method: "pat".into(),
            reauthorize: false,
        });
        state.active_id = Some(id);
        save(&state)?;
        Ok(state)
    })
    .await
}
#[tauri::command]
pub async fn account_select(id: String) -> Result<Accounts, String> {
    blocking(move || {
        let _guard = STORE_LOCK.lock().map_err(|_| "ACCOUNT_STORAGE_FAILED")?;
        let mut state = read()?;
        if !state.accounts.iter().any(|a| a.id == id) {
            return Err("ACCOUNT_NOT_FOUND".into());
        }

        state.active_id = Some(id);
        save(&state)?;
        Ok(state)
    })
    .await
}
#[tauri::command]
pub async fn account_remove(id: String) -> Result<Accounts, String> {
    blocking(move || {
        let _guard = STORE_LOCK.lock().map_err(|_| "ACCOUNT_STORAGE_FAILED")?;
        let mut state = read()?;
        if !state.accounts.iter().any(|a| a.id == id) {
            return Err("ACCOUNT_NOT_FOUND".into());
        }
        match token_entry(&id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => (),
            Err(_) => return Err("ACCOUNT_STORAGE_FAILED".into()),
        }
        crate::oauth::delete_tokens(&id)?;
        state.accounts.retain(|a| a.id != id);
        if state.active_id.as_deref() == Some(&id) {
            state.active_id = state.accounts.first().map(|a| a.id.clone());
        }
        save(&state)?;
        Ok(state)
    })
    .await
}

// Git launches this binary as a credential helper. Never start Tauri in that child.
pub fn credential_entry() -> Option<i32> {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some("--repoweft-credential") {
        return None;
    }
    if args.next().as_deref() != Some("get") {
        return Some(0);
    }
    let fields: Vec<String> = io::stdin()
        .lock()
        .lines()
        .take_while(|line| line.as_ref().is_ok_and(|s| !s.is_empty()))
        .filter_map(Result::ok)
        .collect();
    if credential_matches(&fields) {
        if let (Ok(login), Ok(token)) = (
            std::env::var("REPOWEFT_GIT_LOGIN"),
            std::env::var("REPOWEFT_GIT_TOKEN"),
        ) {
            println!("username={login}\npassword={token}\n");
        }
    }
    Some(0)
}
fn credential_matches(fields: &[String]) -> bool {
    fields.iter().filter(|s| s.starts_with("protocol=")).count() == 1
        && fields.iter().filter(|s| s.starts_with("host=")).count() == 1
        && fields.iter().any(|s| s == "protocol=https")
        && fields.iter().any(|s| s == "host=github.com")
}

// Each command captures its selected account. No global Git config or remote URL is changed.
pub fn configure(command: &mut Command, path: Option<&str>) -> Result<Option<String>, String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "ACCOUNT_STORAGE_FAILED")?;
    let binding = path.map(repository_binding).transpose()?.flatten();
    if binding.as_deref() == Some("system") {
        return Ok(None);
    }
    let state = read()?;
    let Some(account) = selected_account(&state, binding.as_deref())? else {
        return Ok(None);
    };
    if account.reauthorize {
        return Err("ACCOUNT_REAUTHORIZE".into());
    }
    let token = if account.method == "oauth" {
        crate::oauth::usable_token(&account.id)?
    } else {
        token_entry(&account.id)?
            .get_password()
            .map_err(|_| "ACCOUNT_REAUTHORIZE")?
    };
    let executable = std::env::current_exe()
        .map_err(|_| "ACCOUNT_STORAGE_FAILED")?
        .to_string_lossy()
        .replace('\\', "/");
    let helper = format!("!{} --repoweft-credential", crate::git::quote(&executable));
    command
        .env(
            "REPOWEFT_GIT_LOGIN",
            if account.method == "oauth" {
                "x-access-token"
            } else {
                &account.login
            },
        )
        .env("REPOWEFT_GIT_TOKEN", token)
        .args([
            "-c",
            "credential.https://github.com.helper=",
            "-c",
            &format!("credential.https://github.com.helper={helper}"),
            "-c",
            "credential.https://github.com.username=",
            "-c",
            "http.https://github.com.extraHeader=",
            "-c",
            "url.https://github.com/.insteadOf=git@github.com:",
            "-c",
            "url.https://github.com/.insteadOf=ssh://git@github.com/",
        ]);
    Ok(Some(account.id.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn helper_only_serves_exact_github_https_origin() {
        for (protocol, host, expected) in [
            ("https", "github.com", true),
            ("http", "github.com", false),
            ("https", "github.com.evil.test", false),
            ("https", "gitlab.com", false),
            ("https", "github.com:443", false),
        ] {
            assert_eq!(
                credential_matches(&[format!("protocol={protocol}"), format!("host={host}")]),
                expected
            );
        }
        assert!(!credential_matches(&[]));
    }
}

// Non-secret repository preference lives in .git/config, independently of user.* and core.sshCommand.
const BINDING_KEY: &str = "repoweft.githubAccount";
pub(crate) fn repository_binding(path: &str) -> Result<Option<String>, String> {
    let mut command = Command::new("git");
    command.args(["-C", path, "config", "--local", "--get", BINDING_KEY]);
    // Missing keys exit 1; distinguish them from an invalid repository first.
    let mut verify = Command::new("git");
    verify.args(["-C", path, "rev-parse", "--git-dir"]);
    crate::git::output(verify, 10)?;
    match crate::git::output(command, 10) {
        Ok(value) if !value.trim().is_empty() => Ok(Some(value.trim().into())),
        Ok(_) => Ok(None),
        Err(error) if error.is_empty() => Ok(None),
        Err(error) => Err(error),
    }
}
pub(crate) fn write_binding(path: &str, id: Option<&str>) -> Result<(), String> {
    if id.is_none() && repository_binding(path)?.is_none() {
        return Ok(());
    }
    let mut command = Command::new("git");
    command.args(["-C", path, "config", "--local"]);
    if let Some(id) = id {
        command.args(["--replace-all", BINDING_KEY, id]);
    } else {
        command.args(["--unset-all", BINDING_KEY]);
    }
    crate::git::output(command, 10).map(|_| ())
}
#[tauri::command]
pub async fn account_repository_get(path: String) -> Result<Option<String>, String> {
    blocking(move || repository_binding(&path)).await
}
#[tauri::command]
pub async fn account_repository_set(path: String, id: Option<String>) -> Result<(), String> {
    blocking(move || {
        let _guard = STORE_LOCK.lock().map_err(|_| "ACCOUNT_STORAGE_FAILED")?;
        if let Some(id) = id.as_deref() {
            if id != "system" && !read()?.accounts.iter().any(|a| a.id == id) {
                return Err("ACCOUNT_NOT_FOUND".into());
            }
        }
        write_binding(&path, id.as_deref())
    })
    .await
}
#[tauri::command]
pub async fn account_use_pat(id: String) -> Result<Accounts, String> {
    blocking(move || {
        let _guard = STORE_LOCK.lock().map_err(|_| "ACCOUNT_STORAGE_FAILED")?;
        token_entry(&id)?
            .get_password()
            .map_err(|_| "ACCOUNT_PAT_MISSING")?;
        let mut state = read()?;
        let account = state
            .accounts
            .iter_mut()
            .find(|a| a.id == id)
            .ok_or("ACCOUNT_NOT_FOUND")?;
        account.method = "pat".into();
        account.reauthorize = false;
        save(&state)?;
        Ok(state)
    })
    .await
}

// Do not retry a write operation after an authentication failure; its result may be ambiguous.
pub(crate) fn network_output(
    command: Command,
    timeout: u64,
    id: Option<&str>,
) -> Result<String, String> {
    let supplied = command
        .get_envs()
        .find(|(key, _)| *key == "REPOWEFT_GIT_TOKEN")
        .and_then(|(_, value)| value)
        .map(|v| v.to_string_lossy().into_owned());
    match crate::git::output(command, timeout) {
        Err(error) if id.is_some() && authentication_rejected(&error) => {
            let _guard = STORE_LOCK.lock().map_err(|_| "ACCOUNT_STORAGE_FAILED")?;
            let id = id.unwrap();
            let mut state = read()?;
            if let Some(account) = state.accounts.iter_mut().find(|a| a.id == id) {
                let same_token = supplied.as_deref().is_some_and(|supplied| {
                    if account.method == "oauth" {
                        crate::oauth::access_token_matches(id, supplied).unwrap_or(false)
                    } else {
                        token_entry(id)
                            .and_then(|entry| {
                                entry
                                    .get_password()
                                    .map_err(|_| "ACCOUNT_STORAGE_FAILED".into())
                            })
                            .is_ok_and(|current| current == supplied)
                    }
                });
                if !same_token {
                    return Err("ACCOUNT_CREDENTIAL_CHANGED".into());
                }
                account.reauthorize = true;
                save(&state)?;
            }
            Err("ACCOUNT_REAUTHORIZE".into())
        }
        result => result,
    }
}
fn authentication_rejected(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    error.contains("authentication failed")
        || error.contains("invalid username or token")
        || error.contains("requested url returned error: 401")
        || error.contains("could not read username")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryAccess {
    repository: String,
    login: String,
    method: String,
    status: u16,
    user_can_push: Option<bool>,
    contents_permission: Option<String>,
    installation_found: Option<bool>,
}
fn github_repository(raw: &str) -> Option<String> {
    let normalized = raw
        .strip_prefix("git@github.com:")
        .map(|s| format!("https://github.com/{s}"))
        .unwrap_or_else(|| raw.to_owned());
    let url = reqwest::Url::parse(&normalized).ok()?;
    if url.host_str() != Some("github.com") || !matches!(url.scheme(), "https" | "ssh") {
        return None;
    }
    let path = url.path().trim_matches('/').trim_end_matches(".git");
    let parts: Vec<_> = path.split('/').collect();
    if parts.len() != 2
        || parts.iter().any(|part| {
            part.is_empty()
                || !part
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
        })
    {
        return None;
    }
    Some(path.into())
}
#[tauri::command]
pub async fn account_repository_access(
    path: String,
    remote: String,
) -> Result<RepositoryAccess, String> {
    blocking(move || {
        if remote.is_empty() || remote.starts_with('-') {
            return Err("ACCOUNT_REMOTE_REQUIRED".into());
        }
        let mut url_command = Command::new("git");
        url_command.args(["-C", &path, "remote", "get-url", "--push", &remote]);
        let url = crate::git::output(url_command, 10)?;
        let repository = github_repository(url.trim()).ok_or("ACCOUNT_GITHUB_ONLY")?;
        let mut credentials = Command::new("git");
        let id = configure(&mut credentials, Some(&path))?.ok_or("ACCOUNT_SYSTEM_CHECK")?;
        let token = credentials
            .get_envs()
            .find(|(key, _)| *key == "REPOWEFT_GIT_TOKEN")
            .and_then(|(_, value)| value)
            .ok_or("ACCOUNT_REAUTHORIZE")?
            .to_string_lossy()
            .into_owned();
        let account = read()?
            .accounts
            .into_iter()
            .find(|a| a.id == id)
            .ok_or("ACCOUNT_NOT_FOUND")?;
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "ACCOUNT_NETWORK_FAILED")?;
        let get = |url: &str| {
            client
                .get(url)
                .header("User-Agent", "RepoWeft")
                .header("Accept", "application/vnd.github+json")
                .bearer_auth(&token)
                .send()
                .map_err(|_| "ACCOUNT_NETWORK_FAILED".to_string())
        };
        let response = get(&format!("https://api.github.com/repos/{repository}"))?;
        let status = response.status().as_u16();
        let data: serde_json::Value = response.json().map_err(|_| "ACCOUNT_NETWORK_FAILED")?;
        let mut result = RepositoryAccess {
            repository: repository.clone(),
            login: account.login,
            method: account.method.clone(),
            status,
            user_can_push: data.pointer("/permissions/push").and_then(|v| v.as_bool()),
            contents_permission: None,
            installation_found: None,
        };
        if account.method == "oauth" {
            let slug = crate::oauth::app_slug()?;
            let owner = repository.split('/').next().unwrap_or("");
            for page in 1..=10 {
                let response = get(&format!(
                    "https://api.github.com/user/installations?per_page=100&page={page}"
                ))?;
                if !response.status().is_success() {
                    break;
                }
                let data: serde_json::Value =
                    response.json().map_err(|_| "ACCOUNT_NETWORK_FAILED")?;
                let installations = data["installations"]
                    .as_array()
                    .ok_or("ACCOUNT_NETWORK_FAILED")?;
                let installation = installations.iter().find(|v| {
                    v["app_slug"].as_str() == Some(slug.as_str())
                        && v.pointer("/account/login")
                            .and_then(|v| v.as_str())
                            .is_some_and(|login| login.eq_ignore_ascii_case(owner))
                });
                if let Some(installation) = installation {
                    result.installation_found = Some(true);
                    result.contents_permission = installation
                        .pointer("/permissions/contents")
                        .and_then(|v| v.as_str())
                        .map(str::to_owned);
                    break;
                }
                if installations.len() < 100 {
                    result.installation_found = Some(false);
                    break;
                }
            }
        }
        Ok(result)
    })
    .await
}

pub(crate) fn github_url(raw: &str) -> bool {
    if raw.starts_with("git@github.com:") {
        return true;
    }
    reqwest::Url::parse(raw).is_ok_and(|url| {
        url.host_str() == Some("github.com") && matches!(url.scheme(), "https" | "ssh")
    })
}
pub(crate) fn has_github_remote(path: &str) -> Result<bool, String> {
    let mut command = Command::new("git");
    command.args([
        "-C",
        path,
        "config",
        "--get-regexp",
        r"^remote\..*\.(url|pushurl)$",
    ]);
    match crate::git::output(command, 10) {
        Ok(value) => Ok(value
            .lines()
            .any(|line| line.split_once(' ').is_some_and(|(_, url)| github_url(url)))),
        Err(error) if error.is_empty() => Ok(false),
        Err(error) => Err(error),
    }
}

fn selected_account<'a>(
    state: &'a Accounts,
    binding: Option<&str>,
) -> Result<Option<&'a Account>, String> {
    let id = match binding {
        Some("system") => return Ok(None),
        Some(id) => Some(id),
        None => state.active_id.as_deref(),
    };
    id.map(|id| {
        state
            .accounts
            .iter()
            .find(|a| a.id == id)
            .ok_or("ACCOUNT_REAUTHORIZE".into())
    })
    .transpose()
}
#[cfg(test)]
mod account_tests {
    use super::*;
    #[test]
    fn access_checks_only_build_api_paths_for_github_repositories() {
        for url in [
            "git@github.com:owner/repo.git",
            "https://github.com/owner/repo.git",
            "ssh://git@github.com/owner/repo.git",
        ] {
            assert_eq!(github_repository(url).as_deref(), Some("owner/repo"));
        }
        for url in [
            "https://github.com.attacker.test/owner/repo",
            "https://attacker.test/owner/repo",
            "https://github.com/owner/repo/extra",
            "https://github.com/owner/%2Frepo",
            "file:///owner/repo",
        ] {
            assert!(github_repository(url).is_none());
        }
        assert!(!authentication_rejected(
            "Permission to owner/repo denied. The requested URL returned error: 403"
        ));
    }
    #[test]
    fn legacy_pat_registry_migrates_without_changing_account_ids() {
        let state: Accounts =
            serde_json::from_str(r#"{"accounts":[{"id":"123","login":"alice"}],"activeId":"123"}"#)
                .unwrap();
        assert_eq!(state.accounts[0].method, "pat");
        assert!(!state.accounts[0].reauthorize);
        assert_eq!(selected_account(&state, None).unwrap().unwrap().id, "123");
    }
    #[test]
    fn repository_binding_overrides_default_and_never_falls_back_if_missing() {
        let state = Accounts {
            accounts: vec![
                Account {
                    id: "one".into(),
                    login: "one".into(),
                    method: "oauth".into(),
                    reauthorize: false,
                },
                Account {
                    id: "two".into(),
                    login: "two".into(),
                    method: "pat".into(),
                    reauthorize: false,
                },
            ],
            active_id: Some("one".into()),
        };
        assert_eq!(selected_account(&state, None).unwrap().unwrap().id, "one");
        assert_eq!(
            selected_account(&state, Some("two")).unwrap().unwrap().id,
            "two"
        );
        assert!(selected_account(&state, Some("system")).unwrap().is_none());
        assert!(selected_account(&state, Some("removed")).is_err());
    }
    #[test]
    fn binding_preserves_commit_and_ssh_identity() {
        let path = std::env::temp_dir().join(format!(
            "repoweft-binding-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&path).unwrap();
        let path_str = path.to_str().unwrap();
        let run = |args: &[&str]| {
            let mut command = Command::new("git");
            command.args(["-C", path_str]).args(args);
            crate::git::output(command, 10).unwrap()
        };
        run(&["init"]);
        run(&["config", "--local", "user.name", "Independent Author"]);
        run(&["config", "--local", "user.email", "author@example.test"]);
        run(&[
            "config",
            "--local",
            "core.sshCommand",
            "ssh -i independent-key",
        ]);
        assert_eq!(repository_binding(path_str).unwrap(), None);
        write_binding(path_str, Some("123")).unwrap();
        assert_eq!(
            repository_binding(path_str).unwrap().as_deref(),
            Some("123")
        );
        write_binding(path_str, Some("system")).unwrap();
        assert_eq!(
            repository_binding(path_str).unwrap().as_deref(),
            Some("system")
        );
        let mut command = Command::new("git");
        assert_eq!(configure(&mut command, Some(path_str)).unwrap(), None);
        assert!(
            !command
                .get_envs()
                .any(|(key, _)| key == "REPOWEFT_GIT_TOKEN")
        );
        write_binding(path_str, None).unwrap();
        assert_eq!(repository_binding(path_str).unwrap(), None);
        assert_eq!(
            run(&["config", "--local", "user.name"]).trim(),
            "Independent Author"
        );
        assert_eq!(
            run(&["config", "--local", "user.email"]).trim(),
            "author@example.test"
        );
        assert_eq!(
            run(&["config", "--local", "core.sshCommand"]).trim(),
            "ssh -i independent-key"
        );
        run(&["remote", "add", "origin", "git@gitlab.com:team/project.git"]);
        assert!(!has_github_remote(path_str).unwrap());
        run(&[
            "remote",
            "set-url",
            "--push",
            "origin",
            "https://github.com/team/project.git",
        ]);
        assert!(has_github_remote(path_str).unwrap());
        std::fs::remove_dir_all(path).unwrap();
    }
}
