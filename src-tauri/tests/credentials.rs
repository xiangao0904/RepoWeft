//! Exercise the shipped executable through Git's real credential protocol, without network or keychain access.
use std::{
    io::Write,
    process::{Command, Stdio},
};

fn helper() -> String {
    let executable = env!("CARGO_BIN_EXE_repoweft")
        .replace('\\', "/")
        .replace('\'', "'\\''");
    format!("!'{}' --repoweft-credential", executable)
}
fn fill(host: &str, protocol: &str, login: &str, token: &str) -> std::process::Output {
    let mut command = Command::new("git");
    command
        .args([
            "-c",
            "credential.helper=",
            "-c",
            &format!("credential.helper={}", helper()),
            "credential",
            "fill",
        ])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "")
        .env("REPOWEFT_GIT_LOGIN", login)
        .env("REPOWEFT_GIT_TOKEN", token)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().unwrap();
    write!(
        child.stdin.take().unwrap(),
        "protocol={protocol}\nhost={host}\n\n"
    )
    .unwrap();
    child.wait_with_output().unwrap()
}
#[test]
fn git_receives_only_the_commands_selected_account() {
    for (login, token) in [
        ("first-user", "fake-first-token"),
        ("second-user", "fake-second-token"),
    ] {
        let result = fill("github.com", "https", login, token);
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let output = String::from_utf8(result.stdout).unwrap();
        assert!(output.contains(&format!("username={login}\n")));
        assert!(output.contains(&format!("password={token}\n")));
        assert!(result.stderr.is_empty());
    }
}
#[test]
fn git_cannot_receive_the_token_for_other_origins() {
    for (host, protocol) in [
        ("gitlab.com", "https"),
        ("github.com.evil.test", "https"),
        ("github.com", "http"),
    ] {
        let result = fill(host, protocol, "test-user", "fake-secret");
        assert!(!result.status.success());
        assert!(!String::from_utf8_lossy(&result.stdout).contains("fake-secret"));
        assert!(!String::from_utf8_lossy(&result.stderr).contains("fake-secret"));
    }
}
#[test]
fn github_ssh_urls_rewrite_without_touching_other_hosts() {
    for (url, expected) in [
        (
            "git@github.com:owner/repo.git",
            "https://github.com/owner/repo.git",
        ),
        (
            "ssh://git@github.com/owner/repo.git",
            "https://github.com/owner/repo.git",
        ),
        (
            "git@gitlab.com:owner/repo.git",
            "git@gitlab.com:owner/repo.git",
        ),
    ] {
        let result = Command::new("git")
            .args([
                "-c",
                "url.https://github.com/.insteadOf=git@github.com:",
                "-c",
                "url.https://github.com/.insteadOf=ssh://git@github.com/",
                "ls-remote",
                "--get-url",
                url,
            ])
            .output()
            .unwrap();
        assert!(result.status.success());
        assert_eq!(String::from_utf8(result.stdout).unwrap().trim(), expected);
    }
}
