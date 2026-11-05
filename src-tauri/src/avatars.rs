use serde::Deserialize;
use serde_json::Value;
use std::sync::OnceLock;

fn commit_author(html: &str) -> Option<String> {
    let start = html.find("\"authors\":[")? + "\"authors\":".len();
    let mut decoder = serde_json::Deserializer::from_str(&html[start..]);
    let authors = Vec::<Value>::deserialize(&mut decoder).ok()?;
    let raw = authors.first()?.get("avatarUrl")?.as_str()?;
    let url = reqwest::Url::parse(raw).ok()?;
    if url.scheme() != "https" || url.host_str() != Some("avatars.githubusercontent.com") {
        return None;
    }
    Some(raw.to_string())
}

#[tauri::command]
pub async fn github_commit_avatar(
    repository: String,
    hash: String,
) -> Result<Option<String>, String> {
    if repository.split('/').count() != 2
        || repository.split('/').any(|part| {
            part.is_empty()
                || part == "."
                || part == ".."
                || !part
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
        })
        || hash.len() != 40
        || !hash.chars().all(|c| c.is_ascii_hexdigit())
    {
        return Err("Invalid GitHub commit".into());
    }
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    let client = CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("RepoWeft/0.1.0")
            .timeout(std::time::Duration::from_secs(8))
            .build()
            .expect("HTTP client")
    });
    let mut response = client
        .get(format!("https://github.com/{repository}/commit/{hash}"))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    if response.content_length().unwrap_or(0) > 4 * 1024 * 1024 {
        return Ok(None);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > 4 * 1024 * 1024 {
            return Ok(None);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(commit_author(&String::from_utf8_lossy(&bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "Set REPOWEFT_GITHUB_REPOSITORY and REPOWEFT_GITHUB_HASH for a live check"]
    fn live_github_avatar() {
        let repo = std::env::var("REPOWEFT_GITHUB_REPOSITORY").unwrap();
        let hash = std::env::var("REPOWEFT_GITHUB_HASH").unwrap();
        let avatar = tauri::async_runtime::block_on(github_commit_avatar(repo, hash)).unwrap();
        assert!(
            avatar
                .unwrap()
                .starts_with("https://avatars.githubusercontent.com/")
        );
    }
    #[test]
    fn resolves_verified_author_without_rest_api_and_rejects_other_hosts() {
        let html = r#"<script>{"authors":[{"login":"alice","avatarUrl":"https://avatars.githubusercontent.com/u/1?v=4"}],"other":1}</script>"#;
        assert_eq!(
            commit_author(html).as_deref(),
            Some("https://avatars.githubusercontent.com/u/1?v=4")
        );
        assert!(
            commit_author(&html.replace("avatars.githubusercontent.com", "evil.test")).is_none()
        );
        assert!(commit_author("no metadata").is_none());
    }
}
