use crate::accounts::{self, Account, Accounts};
use serde::{Deserialize, Serialize};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, ipc::Channel};
use tauri_plugin_opener::OpenerExt;

static LOGIN: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);
const REFRESH_MARGIN: u64 = 120;
const TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const DEVICE_URL: &str = "https://github.com/login/device/code";
const VERIFICATION_URL: &str = "https://github.com/login/device";
const DEFAULT_CLIENT_ID: &str = "Iv23li8CYshl2Yf2vXzf";
const DEFAULT_APP_SLUG: &str = "repoweftgit";
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Configuration {
    configured: bool,
    installation_url: Option<String>,
}
#[derive(Clone)]
struct Config {
    client_id: String,
    slug: String,
}
fn setting(name: &str, compiled: Option<&str>) -> String {
    if cfg!(debug_assertions) {
        std::env::var(name)
            .ok()
            .or_else(|| compiled.map(str::to_owned))
            .unwrap_or_default()
    } else {
        compiled.unwrap_or_default().into()
    }
}
fn config() -> Result<Config, String> {
    let client_id = setting(
        "REPOWEFT_GITHUB_CLIENT_ID",
        option_env!("REPOWEFT_GITHUB_CLIENT_ID").or(Some(DEFAULT_CLIENT_ID)),
    );
    let slug = setting(
        "REPOWEFT_GITHUB_APP_SLUG",
        option_env!("REPOWEFT_GITHUB_APP_SLUG").or(Some(DEFAULT_APP_SLUG)),
    );
    if client_id.is_empty()
        || !client_id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'.')
        || slug.is_empty()
        || !slug.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
    {
        return Err("OAUTH_NOT_CONFIGURED".into());
    }
    Ok(Config { client_id, slug })
}
pub(crate) fn app_slug() -> Result<String, String> {
    config().map(|c| c.slug)
}
#[tauri::command]
pub fn github_oauth_configuration() -> Configuration {
    match config() {
        Ok(c) => Configuration {
            configured: true,
            installation_url: Some(format!(
                "https://github.com/apps/{}/installations/new",
                c.slug
            )),
        },
        Err(_) => Configuration {
            configured: false,
            installation_url: None,
        },
    }
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn refresh_needed(expires_at: u64, current_time: u64) -> bool {
    expires_at <= current_time.saturating_add(REFRESH_MARGIN)
}
fn oauth_error(value: &serde_json::Value) -> Option<&'static str> {
    value
        .get("error")
        .map(|error| match error.as_str().unwrap_or_default() {
            "device_flow_disabled" => "OAUTH_DEVICE_DISABLED",
            "access_denied" => "OAUTH_DENIED",
            "expired_token" | "token_expired" => "OAUTH_TIMEOUT",
            "bad_refresh_token" | "invalid_grant" => "ACCOUNT_REAUTHORIZE",
            "incorrect_client_credentials" => "OAUTH_NOT_CONFIGURED",
            _ => "OAUTH_EXCHANGE_FAILED",
        })
}
#[derive(Serialize, Deserialize)]
struct Tokens {
    access_token: String,
    refresh_token: String,
    expires_at: u64,
    refresh_expires_at: u64,
    client_id: String,
    #[serde(default)]
    flow: String,
}
#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
    expires_in: u64,
    refresh_token_expires_in: u64,
}
impl TokenResponse {
    fn into_tokens(self, c: &Config) -> Result<Tokens, String> {
        if !self.access_token.starts_with("ghu_")
            || !self.refresh_token.starts_with("ghr_")
            || self.expires_in == 0
            || self.refresh_token_expires_in == 0
        {
            return Err("OAUTH_INVALID_RESPONSE".into());
        }
        Ok(Tokens {
            access_token: self.access_token,
            refresh_token: self.refresh_token,
            expires_at: now().saturating_add(self.expires_in),
            refresh_expires_at: now().saturating_add(self.refresh_token_expires_in),
            client_id: c.client_id.clone(),
            flow: "device".into(),
        })
    }
}
fn entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(accounts::SERVICE, &format!("oauth:{id}"))
        .map_err(|_| "ACCOUNT_STORAGE_FAILED".into())
}
fn read_tokens(id: &str) -> Result<Tokens, String> {
    let raw = match entry(id)?.get_password() {
        Ok(raw) => raw,
        Err(keyring::Error::NoEntry) => return Err("ACCOUNT_REAUTHORIZE".into()),
        Err(_) => return Err("ACCOUNT_STORAGE_FAILED".into()),
    };
    serde_json::from_str(&raw).map_err(|_| "ACCOUNT_REAUTHORIZE".into())
}
fn save_tokens(id: &str, tokens: &Tokens) -> Result<(), String> {
    entry(id)?
        .set_password(&serde_json::to_string(tokens).map_err(|_| "ACCOUNT_STORAGE_FAILED")?)
        .map_err(|_| "ACCOUNT_STORAGE_FAILED".into())
}
pub(crate) fn delete_tokens(id: &str) -> Result<(), String> {
    match entry(id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("ACCOUNT_STORAGE_FAILED".into()),
    }
}
pub(crate) fn reauthorize(id: &str) -> String {
    if let Ok(mut state) = accounts::read() {
        if let Some(a) = state.accounts.iter_mut().find(|a| a.id == id) {
            a.reauthorize = true;
            let _ = accounts::save(&state);
        }
    }
    "ACCOUNT_REAUTHORIZE".into()
}
pub(crate) fn needs_reauthorization(id: &str) -> bool {
    read_tokens(id)
        .map(|t| t.refresh_expires_at <= now())
        .unwrap_or(true)
}
// The caller holds STORE_LOCK, serializing refresh-token rotation with login and removal.
pub(crate) fn usable_token(id: &str) -> Result<String, String> {
    let mut tokens = read_tokens(id)?;
    let c = config()?;
    // Legacy browser-flow tokens require a one-time device authorization. Never send them to a broker.
    if tokens.flow != "device" || tokens.client_id != c.client_id {
        return Err(reauthorize(id));
    }
    if !refresh_needed(tokens.expires_at, now()) {
        return Ok(tokens.access_token);
    }
    if tokens.refresh_expires_at <= now() {
        return Err(reauthorize(id));
    }
    let client = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|_| "OAUTH_NETWORK_FAILED")?;
    let response = client
        .post(TOKEN_URL)
        .header("Accept", "application/json")
        .header("User-Agent", "RepoWeft")
        .form(&refresh_form(&c.client_id, &tokens.refresh_token))
        .send()
        .map_err(|_| "OAUTH_NETWORK_FAILED")?;
    let status = response.status();
    if status.is_server_error() || status == 429 {
        return Err("OAUTH_NETWORK_FAILED".into());
    }
    let value: serde_json::Value = response.json().map_err(|_| "OAUTH_INVALID_RESPONSE")?;
    if let Some(error) = oauth_error(&value) {
        if error == "ACCOUNT_REAUTHORIZE" {
            return Err(reauthorize(id));
        }
        return Err(error.into());
    }
    if status == 401 {
        return Err(reauthorize(id));
    }
    if !status.is_success() {
        return Err("OAUTH_NETWORK_FAILED".into());
    }
    tokens = serde_json::from_value::<TokenResponse>(value)
        .map_err(|_| "OAUTH_INVALID_RESPONSE")?
        .into_tokens(&c)?;
    save_tokens(id, &tokens)?;
    Ok(tokens.access_token)
}
fn refresh_form<'a>(client_id: &'a str, refresh_token: &'a str) -> [(&'static str, &'a str); 3] {
    [
        ("client_id", client_id),
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
    ]
}
#[tauri::command]
pub fn github_oauth_cancel() {
    if let Ok(login) = LOGIN.lock() {
        if let Some(cancel) = login.as_ref() {
            cancel.store(true, Ordering::Release);
        }
    }
}
struct LoginGuard;
impl Drop for LoginGuard {
    fn drop(&mut self) {
        if let Ok(mut login) = LOGIN.lock() {
            *login = None;
        }
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicePrompt {
    user_code: String,
    verification_uri: String,
    expires_at: u64,
    account_login: Option<String>,
    phase: &'static str,
}
#[derive(Deserialize)]
struct DeviceResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    #[serde(default = "default_interval")]
    interval: u64,
}
fn default_interval() -> u64 {
    5
}
impl DeviceResponse {
    fn validate(&self) -> Result<(), String> {
        if self.verification_uri != VERIFICATION_URL
            || self.device_code.is_empty()
            || self.device_code.len() > 256
            || !(1..=1800).contains(&self.expires_in)
            || self.interval == 0
            || self.interval > 300
            || !(4..=32).contains(&self.user_code.len())
            || !self
                .user_code
                .bytes()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'-')
        {
            return Err("OAUTH_INVALID_RESPONSE".into());
        }
        Ok(())
    }
}
fn polling_delay(value: &serde_json::Value, interval: u64) -> Result<Option<u64>, String> {
    match value.get("error").and_then(|e| e.as_str()) {
        Some("authorization_pending") => Ok(Some(interval)),
        Some("slow_down") => {
            Ok(Some(interval.saturating_add(5).max(
                value.get("interval").and_then(|v| v.as_u64()).unwrap_or(0),
            )))
        }
        Some(_) => Err(oauth_error(value).unwrap_or("OAUTH_EXCHANGE_FAILED").into()),
        None => Ok(None),
    }
}
async fn cancelled(cancel: &AtomicBool) {
    while !cancel.load(Ordering::Acquire) {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
#[tauri::command]
pub async fn github_oauth_login(
    app: tauri::AppHandle,
    account_id: Option<String>,
    on_device: Channel<DevicePrompt>,
) -> Result<Accounts, String> {
    let c = config()?;
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut login = LOGIN.lock().map_err(|_| "OAUTH_BUSY")?;
        if login.is_some() {
            return Err("OAUTH_BUSY".into());
        }
        *login = Some(cancel.clone());
    }
    let _guard = LoginGuard;
    tokio::select! {
        result = device_login(&app, c, account_id, on_device, cancel.clone()) => result,
        _ = cancelled(&cancel) => Err("OAUTH_CANCELLED".into()),
    }
}
async fn device_login(
    app: &tauri::AppHandle,
    c: Config,
    expected_id: Option<String>,
    on_device: Channel<DevicePrompt>,
    cancel: Arc<AtomicBool>,
) -> Result<Accounts, String> {
    let expected = expected_id.clone();
    let account_login = accounts::blocking(move || {
        let _guard = accounts::STORE_LOCK
            .lock()
            .map_err(|_| "ACCOUNT_STORAGE_FAILED")?;
        expected
            .map(|id| {
                accounts::read()?
                    .accounts
                    .into_iter()
                    .find(|a| a.id == id)
                    .map(|a| a.login)
                    .ok_or("ACCOUNT_NOT_FOUND".into())
            })
            .transpose()
    })
    .await?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(25))
        .user_agent("RepoWeft")
        .build()
        .map_err(|_| "OAUTH_NETWORK_FAILED")?;
    let response = client
        .post(DEVICE_URL)
        .header("Accept", "application/json")
        .form(&[
            ("client_id", c.client_id.as_str()),
            ("scope", "offline_access"),
        ])
        .send()
        .await
        .map_err(|error| transport_error("device", &error))?;
    let status = response.status();
    let value: serde_json::Value = response
        .json()
        .await
        .map_err(|_| "OAUTH_INVALID_RESPONSE")?;
    if let Some(error) = oauth_error(&value) {
        return Err(error.into());
    }
    if !status.is_success() {
        return Err("OAUTH_NETWORK_FAILED".into());
    }
    let device: DeviceResponse =
        serde_json::from_value(value).map_err(|_| "OAUTH_INVALID_RESPONSE")?;
    device.validate()?;
    let deadline = Instant::now() + Duration::from_secs(device.expires_in);
    let mut prompt = DevicePrompt {
        user_code: device.user_code,
        verification_uri: VERIFICATION_URL.into(),
        expires_at: now().saturating_add(device.expires_in),
        account_login,
        phase: "waiting",
    };
    on_device
        .send(prompt.clone())
        .map_err(|_| "OAUTH_CANCELLED")?;
    // The code is visible before the browser opens. If opening fails, the fixed URL can be opened manually.
    let _ = app.opener().open_url(VERIFICATION_URL, None::<&str>);
    let tokens = tokio::time::timeout(Duration::from_secs(device.expires_in), async {
        let mut interval = device.interval.max(5);
        let mut failures = 0;
        loop {
            tokio::time::sleep(Duration::from_secs(interval)).await;
            if Instant::now() >= deadline {
                return Err("OAUTH_TIMEOUT".into());
            }
            let response = client
                .post(TOKEN_URL)
                .header("Accept", "application/json")
                .form(&[
                    ("client_id", c.client_id.as_str()),
                    ("device_code", device.device_code.as_str()),
                    ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ])
                .send()
                .await;
            let response = match response {
                Ok(response) => response,
                Err(error) => {
                    failures += 1;
                    if failures >= 3 {
                        return Err(transport_error("poll", &error).into());
                    }
                    interval = interval.saturating_mul(2).min(60).max(interval);
                    prompt.phase = "retrying";
                    let _ = on_device.send(prompt.clone());
                    continue;
                }
            };
            let status = response.status();
            if status.is_server_error() || status == 429 {
                failures += 1;
                if failures >= 3 {
                    return Err("OAUTH_POLL_UNAVAILABLE".into());
                }
                interval = interval.saturating_mul(2).min(60).max(interval).max(
                    response
                        .headers()
                        .get("retry-after")
                        .and_then(|v| v.to_str().ok())
                        .and_then(|v| v.parse().ok())
                        .unwrap_or(0),
                );
                prompt.phase = "retrying";
                let _ = on_device.send(prompt.clone());
                continue;
            }
            failures = 0;
            prompt.phase = "waiting";
            let _ = on_device.send(prompt.clone());
            let value: serde_json::Value = response
                .json()
                .await
                .map_err(|_| "OAUTH_INVALID_RESPONSE")?;
            if let Some(delay) = polling_delay(&value, interval)? {
                interval = delay;
                continue;
            }
            if !status.is_success() {
                return Err("OAUTH_EXCHANGE_FAILED".into());
            }
            return serde_json::from_value::<TokenResponse>(value)
                .map_err(|_| "OAUTH_INVALID_RESPONSE")?
                .into_tokens(&c);
        }
    })
    .await
    .map_err(|_| "OAUTH_TIMEOUT")??;
    prompt.phase = "profile";
    let _ = on_device.send(prompt);
    #[derive(Deserialize)]
    struct User {
        id: u64,
        login: String,
    }
    let mut attempt = 0;
    let user = loop {
        attempt += 1;
        let response = client
            .get("https://api.github.com/user")
            .header("User-Agent", "RepoWeft")
            .header("X-GitHub-Api-Version", "2026-03-10")
            .bearer_auth(&tokens.access_token)
            .send()
            .await;
        let response = match response {
            Ok(response) => response,
            Err(error) if attempt >= 3 => return Err(transport_error("profile", &error).into()),
            Err(_) => {
                tokio::time::sleep(Duration::from_secs(2 * attempt)).await;
                continue;
            }
        };
        if (response.status().is_server_error() || response.status() == 429) && attempt < 3 {
            tokio::time::sleep(Duration::from_secs(2 * attempt)).await;
            continue;
        }
        if response.status() == 403 || response.status() == 429 {
            return Err("OAUTH_PROFILE_RESTRICTED".into());
        }
        if !response.status().is_success() {
            return Err("OAUTH_EXCHANGE_FAILED".into());
        }
        break response
            .json::<User>()
            .await
            .map_err(|_| "OAUTH_INVALID_RESPONSE")?;
    };
    if expected_id.is_some_and(|id| id != user.id.to_string()) {
        return Err("OAUTH_ACCOUNT_MISMATCH".into());
    }
    if cancel.load(Ordering::Acquire) {
        return Err("OAUTH_CANCELLED".into());
    }
    let result = accounts::blocking(move || {
        let _guard = accounts::STORE_LOCK
            .lock()
            .map_err(|_| "ACCOUNT_STORAGE_FAILED")?;
        let mut state = accounts::read()?;
        if cancel.load(Ordering::Acquire) {
            return Err("OAUTH_CANCELLED".into());
        }
        let id = user.id.to_string();
        if state.accounts.len() >= 8 && !state.accounts.iter().any(|a| a.id == id) {
            return Err("ACCOUNT_LIMIT".into());
        }
        save_tokens(&id, &tokens)?;
        state.accounts.retain(|a| a.id != id);
        state.accounts.push(Account {
            id: id.clone(),
            login: user.login,
            method: "oauth".into(),
            reauthorize: false,
        });
        state.active_id = Some(id);
        accounts::save(&state)?;
        Ok(state)
    })
    .await?;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    Ok(result)
}

pub(crate) fn access_token_matches(id: &str, value: &str) -> Result<bool, String> {
    Ok(read_tokens(id)?.access_token == value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn polling_respects_pending_slow_down_and_terminal_errors() {
        assert_eq!(
            polling_delay(&json!({"error":"authorization_pending"}), 5).unwrap(),
            Some(5)
        );
        assert_eq!(
            polling_delay(&json!({"error":"slow_down"}), 5).unwrap(),
            Some(10)
        );
        assert_eq!(
            polling_delay(&json!({"error":"slow_down", "interval":20}), 10).unwrap(),
            Some(20)
        );
        assert_eq!(
            polling_delay(&json!({"error":"access_denied"}), 5).unwrap_err(),
            "OAUTH_DENIED"
        );
        assert_eq!(
            polling_delay(&json!({"error":"expired_token"}), 5).unwrap_err(),
            "OAUTH_TIMEOUT"
        );
        assert_eq!(
            polling_delay(&json!({"error":"device_flow_disabled"}), 5).unwrap_err(),
            "OAUTH_DEVICE_DISABLED"
        );
        assert_eq!(
            polling_delay(&json!({"access_token":"ghu_test"}), 5).unwrap(),
            None
        );
    }
    #[test]
    fn only_opens_githubs_device_page_and_validates_codes_and_lifetimes() {
        let mut response = DeviceResponse {
            device_code: "private-device-code".into(),
            user_code: "ABCD-EFGH".into(),
            verification_uri: VERIFICATION_URL.into(),
            expires_in: 900,
            interval: 5,
        };
        assert!(response.validate().is_ok());
        response.verification_uri = "https://github.com.evil.test/login/device".into();
        assert!(response.validate().is_err());
        response.verification_uri = VERIFICATION_URL.into();
        response.user_code = "<script>".into();
        assert!(response.validate().is_err());
        response.user_code = "ABCD-EFGH".into();
        response.expires_in = u64::MAX;
        assert!(response.validate().is_err());
    }
    #[test]
    fn refresh_uses_no_secret_and_legacy_tokens_require_reauthorization() {
        let form = refresh_form("client", "ghr_test");
        assert_eq!(
            form,
            [
                ("client_id", "client"),
                ("grant_type", "refresh_token"),
                ("refresh_token", "ghr_test")
            ]
        );
        let legacy: Tokens = serde_json::from_value(json!({"access_token":"ghu_old","refresh_token":"ghr_old","expires_at":100,"refresh_expires_at":200,"client_id":"client","broker":"https://old.example.test"})).unwrap();
        assert_ne!(legacy.flow, "device");
        assert_eq!(
            oauth_error(&json!({"error":"bad_refresh_token"})),
            Some("ACCOUNT_REAUTHORIZE")
        );
    }
    #[test]
    fn expiry_and_atomic_token_pair_use_device_origin() {
        assert!(!refresh_needed(1121, 1000));
        assert!(refresh_needed(1120, 1000));
        let c = Config {
            client_id: "client".into(),
            slug: "repoweftgit".into(),
        };
        let pair = TokenResponse {
            access_token: "ghu_test".into(),
            refresh_token: "ghr_test".into(),
            expires_in: 28800,
            refresh_token_expires_in: 15897600,
        };
        let tokens = pair.into_tokens(&c).unwrap();
        assert_eq!(tokens.flow, "device");
        assert!(tokens.expires_at > now());
        let public = serde_json::to_string(&DevicePrompt {
            user_code: "ABCD-EFGH".into(),
            verification_uri: VERIFICATION_URL.into(),
            expires_at: 100,
            account_login: None,
            phase: "waiting",
        })
        .unwrap();
        assert!(!public.contains("device_code"));
        assert!(!public.contains("access_token"));
    }
    #[tokio::test]
    async fn cancellation_interrupts_a_pending_wait() {
        let cancel = Arc::new(AtomicBool::new(false));
        let worker = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            worker.store(true, Ordering::Release);
        });
        tokio::time::timeout(Duration::from_secs(1), cancelled(&cancel))
            .await
            .unwrap();
    }
}

// Return only fixed error codes: reqwest errors may contain URLs, so never forward raw errors.
fn transport_error(stage: &str, error: &reqwest::Error) -> &'static str {
    match (stage, error.is_timeout()) {
        ("poll", true) => "OAUTH_POLL_TIMEOUT",
        ("poll", false) => "OAUTH_POLL_CONNECTION",
        ("profile", _) => "OAUTH_PROFILE_CONNECTION",
        _ => "OAUTH_NETWORK_FAILED",
    }
}
#[cfg(test)]
mod connectivity_tests {
    use super::*;
    #[test]
    #[ignore = "Read-only connectivity check against fixed GitHub endpoints; no real credentials"]
    fn live_github_device_transport() {
        let client = reqwest::blocking::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(25))
            .user_agent("RepoWeft")
            .build()
            .unwrap();
        let start = Instant::now();
        let response = client
            .post(TOKEN_URL)
            .header("Accept", "application/json")
            .form(&[
                ("client_id", DEFAULT_CLIENT_ID),
                ("device_code", "repoweft-connectivity-test"),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ])
            .send()
            .expect("Token endpoint transport failed");
        assert!(response.status().is_success());
        let value: serde_json::Value = response.json().unwrap();
        assert_eq!(value["error"], "incorrect_device_code");
        println!(
            "GitHub token endpoint connected in {:?}; invalid test code correctly rejected",
            start.elapsed()
        );
    }
}
