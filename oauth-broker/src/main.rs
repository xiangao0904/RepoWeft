//! Deploy behind HTTPS. Only this service receives the GitHub App client secret.
//! No body/header logging, token persistence, CORS, arbitrary upstreams or redirects.
use axum::{
    Json, Router,
    extract::{ConnectInfo, DefaultBodyLimit, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const CALLBACK: &str = "http://127.0.0.1:49173/oauth/github/callback";
#[derive(Clone)]
struct App {
    client: reqwest::Client,
    client_id: Arc<String>,
    secret: Arc<String>,
    limits: Arc<Mutex<HashMap<IpAddr, (Instant, u32)>>>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Exchange {
    code: String,
    code_verifier: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Refresh {
    refresh_token: String,
}
#[derive(Deserialize, Serialize)]
struct TokenPair {
    access_token: String,
    refresh_token: String,
    expires_in: u64,
    refresh_token_expires_in: u64,
}

#[derive(Debug)]
struct Failure(StatusCode, &'static str);
impl IntoResponse for Failure {
    fn into_response(self) -> Response {
        response(self.0, Json(serde_json::json!({"error": self.1}))).into_response()
    }
}
fn response(status: StatusCode, body: impl IntoResponse) -> Response {
    let mut result = (status, body).into_response();
    result
        .headers_mut()
        .insert("cache-control", HeaderValue::from_static("no-store"));
    result
        .headers_mut()
        .insert("pragma", HeaderValue::from_static("no-cache"));
    result.headers_mut().insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    result
}
fn valid_code(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
fn valid_verifier(value: &str) -> bool {
    (43..=128).contains(&value.len())
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-._~".contains(&c))
}
fn admit(app: &App, ip: IpAddr, headers: &HeaderMap) -> Result<(), Failure> {
    // Native requests have no Origin. A browser must not use this service as its token endpoint.
    if headers.contains_key("origin") {
        return Err(Failure(StatusCode::FORBIDDEN, "browser_request_rejected"));
    }
    let mut limits = app
        .limits
        .lock()
        .map_err(|_| Failure(StatusCode::SERVICE_UNAVAILABLE, "unavailable"))?;
    limits.retain(|_, (since, _)| since.elapsed() < Duration::from_secs(60));
    if limits.len() >= 4096 && !limits.contains_key(&ip) {
        return Err(Failure(StatusCode::TOO_MANY_REQUESTS, "rate_limited"));
    }
    let counter = limits.entry(ip).or_insert((Instant::now(), 0));
    if counter.1 >= 60 {
        return Err(Failure(StatusCode::TOO_MANY_REQUESTS, "rate_limited"));
    }
    counter.1 += 1;
    Ok(())
}
async fn exchange(
    State(app): State<App>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<Exchange>,
) -> Result<Response, Failure> {
    admit(&app, peer.ip(), &headers)?;
    if !valid_code(&body.code) || !valid_verifier(&body.code_verifier) {
        return Err(Failure(StatusCode::BAD_REQUEST, "invalid_request"));
    }
    token(
        &app,
        &[
            ("client_id", &app.client_id),
            ("client_secret", &app.secret),
            ("code", &body.code),
            ("code_verifier", &body.code_verifier),
            ("redirect_uri", CALLBACK),
        ],
    )
    .await
}
async fn refresh(
    State(app): State<App>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<Refresh>,
) -> Result<Response, Failure> {
    admit(&app, peer.ip(), &headers)?;
    if !body.refresh_token.starts_with("ghr_") || !valid_code(&body.refresh_token) {
        return Err(Failure(StatusCode::BAD_REQUEST, "invalid_request"));
    }
    token(
        &app,
        &[
            ("client_id", &app.client_id),
            ("client_secret", &app.secret),
            ("grant_type", "refresh_token"),
            ("refresh_token", &body.refresh_token),
        ],
    )
    .await
}
async fn token(app: &App, form: &[(&str, &str)]) -> Result<Response, Failure> {
    let result = app
        .client
        .post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .form(form)
        .send()
        .await
        .map_err(|_| Failure(StatusCode::BAD_GATEWAY, "upstream_unavailable"))?;
    if result.status() == reqwest::StatusCode::TOO_MANY_REQUESTS
        || result.status().is_server_error()
    {
        return Err(Failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "upstream_unavailable",
        ));
    }
    let value: serde_json::Value = result
        .json()
        .await
        .map_err(|_| Failure(StatusCode::BAD_GATEWAY, "invalid_upstream_response"))?;
    if value.get("error").is_some() {
        return Err(match value["error"].as_str().unwrap_or_default() {
            "incorrect_client_credentials" | "redirect_uri_mismatch" => {
                Failure(StatusCode::SERVICE_UNAVAILABLE, "configuration_error")
            }
            _ => Failure(StatusCode::UNAUTHORIZED, "reauthorization_required"),
        });
    }
    let pair: TokenPair = serde_json::from_value(value)
        .map_err(|_| Failure(StatusCode::BAD_GATEWAY, "invalid_upstream_response"))?;
    if !pair.access_token.starts_with("ghu_")
        || !pair.refresh_token.starts_with("ghr_")
        || pair.expires_in == 0
        || pair.refresh_token_expires_in == 0
    {
        return Err(Failure(
            StatusCode::BAD_GATEWAY,
            "invalid_upstream_response",
        ));
    }
    Ok(response(StatusCode::OK, Json(pair)))
}
#[tokio::main]
async fn main() {
    let client_id = std::env::var("GITHUB_CLIENT_ID").expect("Set GITHUB_CLIENT_ID");
    let secret =
        std::env::var("GITHUB_CLIENT_SECRET").expect("Set GITHUB_CLIENT_SECRET on the server only");
    assert!(
        !client_id.is_empty() && !secret.is_empty(),
        "GitHub App configuration is required"
    );
    let app = App {
        client: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(25))
            .user_agent("RepoWeft-OAuth")
            .build()
            .expect("HTTP client"),
        client_id: Arc::new(client_id),
        secret: Arc::new(secret),
        limits: Arc::new(Mutex::new(HashMap::new())),
    };
    let routes = Router::new()
        .route("/exchange", post(exchange))
        .route("/refresh", post(refresh))
        .layer(DefaultBodyLimit::max(4096))
        .with_state(app);
    // A TLS ingress/proxy exposes this listener; do not expose cleartext outside the host.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:8787")
        .await
        .expect("Bind OAuth broker");
    axum::serve(
        listener,
        routes.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    .expect("Serve OAuth broker");
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn input_validation_rejects_injection_and_requires_pkce() {
        assert!(valid_verifier(&"a".repeat(43)));
        for verifier in [
            "short".into(),
            "a".repeat(129),
            format!("{}\n", "a".repeat(43)),
        ] {
            assert!(!valid_verifier(&verifier));
        }
        assert!(valid_code("abc_123-DEF"));
        for code in ["", "code&client_secret=evil", "a\r\nb"] {
            assert!(!valid_code(code));
        }
        assert!(
            serde_json::from_str::<Exchange>(
                r#"{"code":"abc","code_verifier":"test","client_secret":"evil"}"#
            )
            .is_err()
        );
    }
}
