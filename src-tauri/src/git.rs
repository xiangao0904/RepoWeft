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
#[derive(Serialize, Default)]
pub struct Snapshot {
    tracking: Option<Tracking>,
    branch: String,
    commits: Vec<Commit>,
    files: Vec<FileChange>,
    branches: Vec<Branch>,
    remotes: Vec<Remote>,
    tags: Vec<String>,
    stashes: Vec<String>,
    operation: Option<String>,
}
#[derive(Serialize)]
pub struct Tracking {
    ahead: usize,
    behind: usize,
}
#[derive(Deserialize)]
pub struct Action {
    kind: String,
    paths: Option<Vec<String>>,
    value: Option<String>,
    extra: Option<String>,
    #[serde(default, rename = "allowEmpty")]
    allow_empty: bool,
    lease: Option<PushLease>,
    #[serde(rename = "expectedHead")]
    expected_head: Option<String>,
    #[serde(rename = "expectedBranch")]
    expected_branch: Option<String>,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct PushLease {
    remote: String,
    target: String,
    expected: String,
}
#[derive(Serialize)]
struct RewordResult {
    head: String,
    branch: String,
    targets: Vec<PushLease>,
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
pub(crate) fn output(command: Command, timeout: u64) -> Result<String, String> {
    output_with_input(command, timeout, None)
}
fn output_with_input(
    mut command: Command,
    timeout: u64,
    input: Option<Vec<u8>>,
) -> Result<String, String> {
    command
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    if crate::tasks::cancelled() {
        return Err("READ_CANCELLED".into());
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("Unable to start Git/OpenSSH: {e}"))?;
    let stdout = child.stdout.take().ok_or("Missing stdout")?;
    let stderr = child.stderr.take().ok_or("Missing stderr")?;
    let writer = input.map(|input| {
        let mut stdin = child.stdin.take().expect("Piped stdin");
        std::thread::spawn(move || {
            use std::io::Write;
            stdin.write_all(&input)
        })
    });
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
        if crate::tasks::cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            return Err("READ_CANCELLED".into());
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < Duration::from_secs(timeout) => std::thread::sleep(
                Duration::from_millis(if started.elapsed() < Duration::from_millis(50) {
                    3
                } else {
                    15
                }),
            ),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Operation timed out. Refresh the repository to check its state before retrying.".into());
            }
        }
    };
    let (stdout, overflow) = out.join().map_err(|_| "Output reader failed")?;
    let (stderr, _) = err.join().map_err(|_| "Error reader failed")?;
    if let Some(writer) = writer {
        writer
            .join()
            .map_err(|_| "Input writer failed")?
            .map_err(|e| e.to_string())?;
    }
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
            if args.contains(&"--")
                && matches!(
                    args.first(),
                    Some(
                        &"add"
                            | &"rm"
                            | &"checkout"
                            | &"checkout-index"
                            | &"ls-files"
                            | &"reset"
                            | &"clean"
                            | &"restore"
                    )
                )
            {
                cmd.arg("--literal-pathspecs");
            }
            cmd.args(["--no-pager", "-C", &location.path]).args(args);
            crate::accounts::network_output(cmd, 180, account_id.as_deref())
        }
        "ssh" => {
            if !location.path.starts_with('/') {
                return Err("Remote path must be absolute".into());
            }
            let host = location.host.as_ref().ok_or("SSH host is missing")?;
            let literal = if args.contains(&"--")
                && matches!(
                    args.first(),
                    Some(
                        &"add"
                            | &"rm"
                            | &"checkout"
                            | &"checkout-index"
                            | &"ls-files"
                            | &"reset"
                            | &"clean"
                            | &"restore"
                    )
                ) {
                "--literal-pathspecs"
            } else {
                ""
            };
            let encoded = args.iter().map(|a| quote(a)).collect::<Vec<_>>().join(" ");
            ssh::exec(
                host,
                ssh::Mode::Session,
                &format!(
                    "GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 git --no-pager {} -C {} {}",
                    literal,
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
        "--decorate=full",
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
fn commit_count(location: &Location, current_only: bool) -> Result<usize, String> {
    let scope = if current_only {
        "--first-parent"
    } else {
        "--all"
    };
    let raw = match git(location, &["rev-list", "--count", scope, "HEAD", "--"]) {
        Ok(raw) => raw,
        Err(error) => {
            if git(location, &["rev-parse", "--verify", "HEAD"]).is_ok() {
                return Err(error);
            }
            git(location, &["rev-parse", "--git-dir"])?;
            if current_only {
                return Ok(0);
            }
            git(location, &["rev-list", "--count", "--all", "--"])?
        }
    };
    raw.trim()
        .parse::<usize>()
        .map_err(|_| "Invalid commit count returned by Git".into())
}
#[tauri::command]
pub async fn repository_commit_count(
    location: Location,
    current_only: bool,
    request_id: Option<String>,
) -> Result<usize, String> {
    crate::tasks::read(request_id, move || commit_count(&location, current_only)).await
}
fn file_status(location: &Location, expand_untracked: bool) -> Result<Vec<FileChange>, String> {
    let raw = git(
        location,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            if expand_untracked {
                "--untracked-files=all"
            } else {
                "--untracked-files=normal"
            },
        ],
    )?;
    Ok(parse_status(&raw))
}
#[cfg(test)]
fn snapshot(location: &Location) -> Result<Snapshot, String> {
    snapshot_sections(location, None, true)
}
fn snapshot_sections(
    location: &Location,
    sections: Option<&[String]>,
    expand_untracked: bool,
) -> Result<Snapshot, String> {
    if sections.is_some_and(|items| items.len() == 1 && items[0] == "files") {
        return Ok(Snapshot {
            files: file_status(location, expand_untracked)?,
            ..Snapshot::default()
        });
    }
    let wants =
        |section: &str| sections.is_none_or(|items| items.iter().any(|item| item == section));
    if sections.is_none() {
        let inside = git(location, &["rev-parse", "--is-inside-work-tree"])?;
        if inside.trim() != "true" {
            return Err(
                "Choose a Git working directory. Bare repositories are not supported yet.".into(),
            );
        }
    }
    let (branch, files, commits, raw_branches, raw_remotes) = std::thread::scope(|scope| {
        let status = scope.spawn(crate::tasks::inherit(|| {
            if wants("files") {
                file_status(location, expand_untracked)
            } else {
                Ok(Vec::new())
            }
        }));
        let history = scope.spawn(crate::tasks::inherit(|| {
            if wants("commits") {
                log(location, 0, false)
            } else {
                Ok(Vec::new())
            }
        }));
        let refs = scope.spawn(crate::tasks::inherit(|| {
            if !wants("branches") {
                return Ok(String::new());
            }
            git(
                location,
                &[
                    "for-each-ref",
                    "--format=%(refname)%00%(HEAD)%00%(upstream:short)%00%(objectname)",
                    "refs/heads",
                    "refs/remotes",
                ],
            )
        }));
        let remotes = scope.spawn(crate::tasks::inherit(|| {
            if wants("remotes") {
                git(location, &["remote", "-v"])
            } else {
                Ok(String::new())
            }
        }));
        let branch = if wants("branch") {
            git(location, &["symbolic-ref", "--short", "-q", "HEAD"])
                .unwrap_or_else(|_| "HEAD (detached)".into())
                .trim()
                .to_string()
        } else {
            String::new()
        };
        Ok::<_, String>((
            branch,
            status.join().map_err(|_| "Status reader failed")??,
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
        tracking: if wants("branches") {
            git(
                location,
                &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
            )
            .ok()
            .and_then(|s| {
                let mut counts = s.split_whitespace();
                Some(Tracking {
                    ahead: counts.next()?.parse().ok()?,
                    behind: counts.next()?.parse().ok()?,
                })
            })
        } else {
            None
        },
        branch,
        commits,
        files,
        branches,
        remotes,
        tags: if wants("tags") {
            git(location, &["tag", "--list"])?
                .lines()
                .map(str::to_owned)
                .collect()
        } else {
            Vec::new()
        },
        stashes: if wants("stashes") {
            git(location, &["stash", "list", "--format=%gd: %s"])?
                .lines()
                .map(str::to_owned)
                .collect()
        } else {
            Vec::new()
        },
        operation: operation_state(location)?,
    })
}
fn operation_state(location: &Location) -> Result<Option<String>, String> {
    for (file, operation) in [
        ("rebase-merge", "rebase"),
        ("rebase-apply", "rebase"),
        ("MERGE_HEAD", "merge"),
        ("CHERRY_PICK_HEAD", "cherry-pick"),
        ("REVERT_HEAD", "revert"),
    ] {
        let path = git(
            location,
            &["rev-parse", "--path-format=absolute", "--git-path", file],
        )?;
        let exists = if location.kind == "local" {
            std::path::Path::new(path.trim()).exists()
        } else {
            ssh::exec(
                location.host.as_ref().ok_or("SSH host is missing")?,
                ssh::Mode::Session,
                &format!("test -e {}", quote(path.trim())),
                15,
            )
            .is_ok()
        };
        if exists {
            return Ok(Some(operation.into()));
        }
    }
    Ok(None)
}
#[derive(Serialize)]
pub struct ConflictVersions {
    base: Option<String>,
    ours: Option<String>,
    theirs: Option<String>,
}
#[tauri::command]
pub async fn repository_conflict(
    location: Location,
    path: String,
    request_id: Option<String>,
) -> Result<ConflictVersions, String> {
    crate::tasks::read(request_id, move || {
        valid_text(&path)?;
        let entries = git(&location, &["ls-files", "--unmerged", "--", &path])?;
        if entries.is_empty() {
            return Err("This file no longer has conflicts. Refresh the repository.".into());
        }
        let read = |stage: &str| -> Result<Option<String>, String> {
            let blob = entries.lines().find_map(|line| {
                let fields: Vec<_> = line.split_whitespace().collect();
                if fields.get(2) == Some(&stage) {
                    fields.get(1).copied()
                } else {
                    None
                }
            });
            let Some(blob) = blob else {
                return Ok(None);
            };
            let size = git(&location, &["cat-file", "-s", blob])?
                .trim()
                .parse::<usize>()
                .map_err(|e| e.to_string())?;
            if size > 1024 * 1024 {
                return Err("Conflict preview supports files up to 1 MiB".into());
            }
            let content = git(&location, &["cat-file", "blob", blob])?;
            if content.contains('\0') || content.contains('\u{fffd}') {
                return Err("Binary conflicts must be resolved by choosing a side".into());
            }
            Ok(Some(content))
        };
        Ok(ConflictVersions {
            base: read("1")?,
            ours: read("2")?,
            theirs: read("3")?,
        })
    })
    .await
}
fn validate_hash(hash: &str) -> Result<(), String> {
    if !(4..=64).contains(&hash.len()) || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
        Err("Invalid commit hash".into())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub async fn repository_snapshot(
    location: Location,
    request_id: Option<String>,
    sections: Option<Vec<String>>,
    expand_untracked: Option<bool>,
) -> Result<Snapshot, String> {
    crate::tasks::read(request_id, move || {
        snapshot_sections(
            &location,
            sections.as_deref(),
            expand_untracked.unwrap_or(false),
        )
    })
    .await
}
#[tauri::command]
pub async fn repository_log(
    location: Location,
    skip: usize,
    current_only: bool,
    request_id: Option<String>,
) -> Result<Vec<Commit>, String> {
    crate::tasks::read(request_id, move || log(&location, skip, current_only)).await
}
#[tauri::command]
pub async fn repository_detail(
    location: Location,
    hash: String,
    request_id: Option<String>,
) -> Result<CommitDetail, String> {
    crate::tasks::read(request_id, move || {
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
pub(crate) fn diff_text(
    location: &Location,
    path: &str,
    staged: bool,
    hash: Option<&str>,
    untracked: bool,
) -> Result<String, String> {
    if let Some(hash) = hash {
        validate_hash(hash)?;
        return git(
            location,
            &[
                "show",
                "--format=",
                "--no-ext-diff",
                "--no-textconv",
                hash,
                "--",
                path,
            ],
        );
    }
    if untracked {
        // Git's no-index mode exits 1 when it finds differences.
        if location.kind == "ssh" {
            return Err("Stage the untracked file to view its diff on the remote host.".into());
        }
        let root = std::fs::canonicalize(&location.path).map_err(|e| e.to_string())?;
        let file = std::fs::canonicalize(root.join(path)).map_err(|e| e.to_string())?;
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
    args.extend(["--", path]);
    git(location, &args)
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
    if value.starts_with('-')
        && !matches!(action.kind.as_str(), "commit" | "reword" | "resolveEdited")
    {
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
            let mut args = vec!["commit", "-m", &value];
            if action.allow_empty {
                args.push("--allow-empty");
            }
            git(location, &args)
        }
        "fetch" => git(location, &["fetch", "--all", "--prune", "--tags"]),
        "pull" => git(location, &["pull", "--ff-only"]),
        "push" => git(location, &["push"]),
        "publishBranch" => {
            let branch = git(location, &["symbolic-ref", "--short", "HEAD"])?;
            git(
                location,
                &[
                    "push",
                    "--set-upstream",
                    "--",
                    &value,
                    &format!("HEAD:refs/heads/{}", branch.trim()),
                ],
            )
        }
        "amend" => {
            if value.trim().is_empty() {
                return Err("Commit message is required".into());
            }
            git(
                location,
                &["commit", "--amend", "--allow-empty", "-m", &value],
            )
        }
        "discard" => {
            if paths.is_empty() {
                return Err("Choose files to discard".into());
            }
            let mut args = if extra == "untracked" {
                vec!["clean", "-f", "-d", "--"]
            } else {
                vec!["restore", "--worktree", "--"]
            };
            args.extend(paths.iter().map(String::as_str));
            git(location, &args)
        }
        "forcePush" => {
            if let Some(lease) = action.lease {
                let head = action.expected_head.ok_or("REWRITE_STATE_CHANGED")?;
                let branch = action.expected_branch.ok_or("REWRITE_STATE_CHANGED")?;
                validate_hash(&head)?;
                validate_hash(&lease.expected)?;
                if lease.remote.is_empty()
                    || lease.remote.starts_with('-')
                    || !lease.target.starts_with("refs/heads/")
                {
                    return Err("Invalid push target".into());
                }
                git(location, &["check-ref-format", &lease.target])?;
                if commit_target(location, "HEAD")? != head
                    || git(location, &["symbolic-ref", "--short", "HEAD"])?.trim() != branch
                {
                    return Err("REWRITE_STATE_CHANGED".into());
                }
                return git(
                    location,
                    &[
                        "push",
                        &format!("--force-with-lease={}:{}", lease.target, lease.expected),
                        "--",
                        &lease.remote,
                        &format!("{head}:{}", lease.target),
                    ],
                );
            }
            // An explicit expected object protects against background fetches updating the lease.
            let upstream = git(
                location,
                &["rev-parse", "--symbolic-full-name", "@{upstream}"],
            )?;
            let expected = git(location, &["rev-parse", "@{upstream}"])?;
            let branch = git(location, &["symbolic-ref", "--short", "HEAD"])?;
            let remote = git(
                location,
                &[
                    "config",
                    "--get",
                    &format!("branch.{}.remote", branch.trim()),
                ],
            )?;
            let target = git(
                location,
                &[
                    "config",
                    "--get",
                    &format!("branch.{}.merge", branch.trim()),
                ],
            )?;
            if !upstream.trim().starts_with("refs/remotes/")
                || !target.trim().starts_with("refs/heads/")
            {
                return Err("A remote tracking branch is required".into());
            }
            git(
                location,
                &[
                    "push",
                    &format!("--force-with-lease={}:{}", target.trim(), expected.trim()),
                    "--",
                    remote.trim(),
                    &format!("HEAD:{}", target.trim()),
                ],
            )
        }
        "checkoutCommit" => {
            let hash = commit_target(location, &value)?;
            git(location, &["switch", "--detach", &hash])
        }
        "reset" => {
            if !matches!(extra.as_str(), "soft" | "mixed" | "hard") {
                return Err("Choose a reset mode".into());
            }
            let hash = commit_target(location, &value)?;
            git(location, &["reset", &format!("--{extra}"), &hash])
        }
        "revert" | "cherryPick" => {
            let hash = commit_target(location, &value)?;
            git(
                location,
                &[
                    if action.kind == "revert" {
                        "revert"
                    } else {
                        "cherry-pick"
                    },
                    "--no-edit",
                    &hash,
                ],
            )
        }
        "createTag" => {
            git(
                location,
                &["check-ref-format", &format!("refs/tags/{value}")],
            )?;
            let hash = commit_target(location, if extra.is_empty() { "HEAD" } else { &extra })?;
            git(location, &["tag", &value, &hash])
        }
        "deleteTag" => git(location, &["tag", "-d", "--", &value]),
        "pushTag" => {
            if extra.is_empty() || extra.starts_with('-') {
                return Err("Choose a remote".into());
            }
            git(
                location,
                &[
                    "push",
                    "--",
                    &extra,
                    &format!("refs/tags/{value}:refs/tags/{value}"),
                ],
            )
        }
        "reword" => {
            let previous = commit_target(location, "HEAD")?;
            let branch = git(location, &["symbolic-ref", "--short", "HEAD"])?
                .trim()
                .to_owned();
            let mut targets = published_targets(location, &extra)?;
            reword(location, &extra, &value)?;
            let head = commit_target(location, "HEAD")?;
            if previous == head {
                targets.clear();
            }
            serde_json::to_string(&RewordResult {
                head,
                branch,
                targets,
            })
            .map_err(|e| e.to_string())
        }
        "rebase" => {
            let hash = commit_target(location, &value)?;
            git(location, &["rebase", &hash])
        }
        "continueOperation" | "abortOperation" | "skipOperation" => {
            if !matches!(
                value.as_str(),
                "merge" | "rebase" | "cherry-pick" | "revert"
            ) || (action.kind == "skipOperation" && value == "merge")
            {
                return Err("Invalid operation".into());
            }
            let flag = match action.kind.as_str() {
                "continueOperation" => "--continue",
                "abortOperation" => "--abort",
                _ => "--skip",
            };
            git(location, &["-c", "core.editor=true", value.as_str(), flag])
        }
        "resolveOurs" | "resolveTheirs" => {
            if paths.is_empty() {
                return Err("Select a conflicted file".into());
            }
            let mut args = vec![
                "checkout",
                if action.kind == "resolveOurs" {
                    "--ours"
                } else {
                    "--theirs"
                },
                "--",
            ];
            args.extend(paths.iter().map(String::as_str));
            git(location, &args)?;
            let mut args = vec!["add", "--"];
            args.extend(paths.iter().map(String::as_str));
            git(location, &args)
        }
        "resolveDelete" => {
            if paths.is_empty() {
                return Err("Select a conflicted file".into());
            }
            let mut args = vec!["rm", "--"];
            args.extend(paths.iter().map(String::as_str));
            git(location, &args)
        }
        "resolveEdited" => {
            if paths.len() != 1 || value.len() > 1024 * 1024 || value.contains('\0') {
                return Err("Choose one text conflict smaller than 1 MiB".into());
            }
            let entries = git(location, &["ls-files", "--unmerged", "--", &paths[0]])?;
            let modes: Vec<_> = entries
                .lines()
                .filter_map(|line| line.split_whitespace().next())
                .collect();
            if modes.is_empty()
                || modes
                    .iter()
                    .any(|mode| !matches!(*mode, "100644" | "100755"))
            {
                return Err("Only regular text file conflicts can be edited here".into());
            }
            let mode = modes[0];
            let mut cmd = if location.kind == "local" {
                let mut cmd = Command::new("git");
                cmd.args(["-C", &location.path, "hash-object", "-w", "--stdin"]);
                cmd
            } else {
                let mut cmd = ssh::command(
                    location.host.as_ref().ok_or("SSH host is missing")?,
                    ssh::Mode::Session,
                )?;
                cmd.arg(format!(
                    "git -C {} hash-object -w --stdin",
                    quote(&location.path)
                ));
                cmd
            };
            cmd.env("GIT_TERMINAL_PROMPT", "0");
            let blob = output_with_input(cmd, 180, Some(value.into_bytes()))?;
            git(
                location,
                &[
                    "update-index",
                    "--add",
                    "--cacheinfo",
                    mode,
                    blob.trim(),
                    &paths[0],
                ],
            )?;
            git(location, &["checkout-index", "--force", "--", &paths[0]])
        }
        "stash" => git(
            location,
            &["stash", "push", "--include-untracked", "-m", &value],
        ),
        "stashApply" | "stashPop" | "stashDrop" => {
            if !value.starts_with("stash@{")
                || !value.ends_with('}')
                || value[7..value.len() - 1].parse::<u32>().is_err()
            {
                return Err("Choose a stash entry".into());
            }
            git(
                location,
                &[
                    "stash",
                    match action.kind.as_str() {
                        "stashApply" => "apply",
                        "stashPop" => "pop",
                        _ => "drop",
                    },
                    &value,
                ],
            )
        }
        "createBranch" => {
            git(location, &["check-ref-format", "--branch", &value])?;
            if extra.is_empty() {
                git(location, &["switch", "-c", &value])
            } else {
                let hash = commit_target(location, &extra)?;
                git(location, &["branch", &value, &hash])
            }
        }
        "switchBranch" => git(location, &["switch", "--", &value]),
        "trackBranch" => git(location, &["switch", "--track", "--", &value]),
        "renameBranch" => {
            if extra.is_empty() || extra.starts_with('-') {
                return Err("Choose a branch name".into());
            }
            git(location, &["check-ref-format", "--branch", &extra])?;
            git(location, &["branch", "-m", "--", &value, &extra])
        }
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

fn commit_target(location: &Location, value: &str) -> Result<String, String> {
    if value.is_empty() || value.starts_with('-') {
        return Err("Choose a commit".into());
    }
    git(
        location,
        &["rev-parse", "--verify", &format!("{value}^{{commit}}")],
    )
    .map(|s| s.trim().to_owned())
}
fn published_targets(location: &Location, target: &str) -> Result<Vec<PushLease>, String> {
    let hash = commit_target(location, target)?;
    let upstream = git(
        location,
        &["rev-parse", "--symbolic-full-name", "@{upstream}"],
    )
    .unwrap_or_default();
    let remotes = git(location, &["remote"])?;
    let refs = git(
        location,
        &[
            "for-each-ref",
            &format!("--contains={hash}"),
            "--format=%(refname)%00%(objectname)%00%(symref)",
            "refs/remotes/",
        ],
    )?;
    let mut targets = Vec::new();
    for line in refs.lines() {
        let fields: Vec<_> = line.split('\0').collect();
        if fields.len() != 3 || !fields[2].is_empty() {
            continue;
        }
        let Some(short) = fields[0].strip_prefix("refs/remotes/") else {
            continue;
        };
        let Some(remote) = remotes
            .lines()
            .filter(|r| short.starts_with(&format!("{r}/")))
            .max_by_key(|r| r.len())
        else {
            continue;
        };
        let branch = &short[remote.len() + 1..];
        let lease = PushLease {
            remote: remote.into(),
            target: format!("refs/heads/{branch}"),
            expected: fields[1].into(),
        };
        if fields[0] == upstream.trim() {
            targets.insert(0, lease);
        } else {
            targets.push(lease);
        }
    }
    Ok(targets)
}

fn reword(location: &Location, target: &str, message: &str) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("Commit message is required".into());
    }
    let hash = commit_target(location, target)?;
    let head = commit_target(location, "HEAD")?;
    let branch = git(location, &["symbolic-ref", "--quiet", "HEAD"])?;
    git(location, &["merge-base", "--is-ancestor", &hash, &head])?;
    if operation_state(location)?.is_some() {
        return Err("REWORD_OPERATION_ACTIVE".into());
    }
    // --only changes the message without including the real index or working files.
    if hash == head {
        return git(
            location,
            &[
                "commit",
                "--amend",
                "--only",
                "--allow-empty",
                "-m",
                message,
            ],
        );
    }
    let parents = git(location, &["rev-list", "--parents", "-n", "1", &hash])?;
    let base = parents.split_whitespace().nth(1);
    let range = base.map(|b| format!("{b}..{head}"));
    if !git(
        location,
        &["rev-list", "--merges", range.as_deref().unwrap_or(&head)],
    )?
    .trim()
    .is_empty()
    {
        return Err("Reword currently requires a linear history without merge commits".into());
    }
    // Replaying in a disposable worktree leaves the user's staged, unstaged and
    // untracked changes untouched. The branch is updated only after cleanup.
    let local_directory = if location.kind == "local" {
        Some(
            tempfile::Builder::new()
                .prefix("repoweft-reword-")
                .tempdir()
                .map_err(|e| e.to_string())?,
        )
    } else {
        None
    };
    let path = if let Some(dir) = &local_directory {
        dir.path().to_string_lossy().into_owned()
    } else {
        let path = ssh::exec(
            location.host.as_ref().ok_or("SSH host is missing")?,
            ssh::Mode::Session,
            "mktemp -d /tmp/repoweft-reword.XXXXXXXX",
            15,
        )?
        .trim()
        .to_owned();
        if !path.starts_with("/tmp/repoweft-reword.") || path.contains(['\n', '\r']) {
            return Err("REWORD_TEMP_WORKTREE".into());
        }
        path
    };
    if let Err(error) = git(location, &["worktree", "add", "--detach", &path, &head]) {
        if location.kind == "ssh" {
            let _ = ssh::exec(
                location.host.as_ref().ok_or("SSH host is missing")?,
                ssh::Mode::Session,
                &format!("rmdir -- {}", quote(&path)),
                15,
            );
        }
        return Err(error);
    }
    let workspace = Location {
        path: path.clone(),
        ..location.clone()
    };
    let replay = (|| {
        let mut args = vec![
            "-c",
            "sequence.editor=sed -i '1s/^pick /edit /'",
            "-c",
            "rebase.updateRefs=false",
            "-c",
            "rebase.autoSquash=false",
            "rebase",
            "--interactive",
            "--keep-empty",
            "--reapply-cherry-picks",
            "--empty=keep",
        ];
        args.push(base.unwrap_or("--root"));
        git(&workspace, &args)?;
        git(
            &workspace,
            &[
                "commit",
                "--amend",
                "--only",
                "--allow-empty",
                "-m",
                message,
            ],
        )?;
        git(
            &workspace,
            &["-c", "core.editor=true", "rebase", "--continue"],
        )?;
        let rewritten = commit_target(&workspace, "HEAD")?;
        if git(&workspace, &["rev-parse", "HEAD^{tree}"])?
            != git(location, &["rev-parse", &format!("{head}^{{tree}}")])?
        {
            return Err("REWORD_TREE_CHANGED".into());
        }
        Ok::<String, String>(rewritten)
    })();
    let cleanup = git(location, &["worktree", "remove", "--force", &path]);
    let rewritten = replay?;
    cleanup?;
    if git(location, &["symbolic-ref", "--quiet", "HEAD"])? != branch {
        return Err("REWRITE_STATE_CHANGED".into());
    }
    git(
        location,
        &[
            "update-ref",
            "-m",
            "RepoWeft: edit commit message",
            branch.trim(),
            &rewritten,
            &head,
        ],
    )
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
    fn partial_status_collapses_untracked_directories_until_expanded() {
        let dir = std::env::temp_dir().join(format!("repoweft-status-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("untracked")).unwrap();
        let location = Location {
            kind: "local".into(),
            path: dir.to_string_lossy().into_owned(),
            host: None,
        };
        git(&location, &["init", "-q"]).unwrap();
        std::fs::write(dir.join("untracked/a.txt"), "a").unwrap();
        std::fs::write(dir.join("untracked/b.txt"), "b").unwrap();
        let sections = vec!["files".to_string()];
        let summary = snapshot_sections(&location, Some(&sections), false).unwrap();
        assert_eq!(summary.files.len(), 1);
        assert_eq!(summary.files[0].path, "untracked/");
        assert!(
            summary.commits.is_empty() && summary.branches.is_empty() && summary.remotes.is_empty()
        );
        let expanded = snapshot_sections(&location, Some(&sections), true).unwrap();
        assert_eq!(expanded.files.len(), 2);
        std::fs::remove_dir_all(dir).unwrap();
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

    fn workflow_repo() -> (tempfile::TempDir, Location) {
        let dir = tempfile::tempdir().unwrap();
        let loc = Location {
            kind: "local".into(),
            path: dir.path().to_string_lossy().into(),
            host: None,
        };
        git(&loc, &["init", "-b", "main"]).unwrap();
        git(&loc, &["config", "user.name", "Workflow Test"]).unwrap();
        git(&loc, &["config", "user.email", "test@example.test"]).unwrap();
        git(&loc, &["config", "commit.gpgsign", "false"]).unwrap();
        git(&loc, &["config", "core.autocrlf", "false"]).unwrap();
        git(&loc, &["config", "core.hooksPath", ".git/no-hooks"]).unwrap();
        (dir, loc)
    }
    fn run_action(
        loc: &Location,
        kind: &str,
        value: &str,
        extra: &str,
        paths: &[&str],
        allow_empty: bool,
    ) -> Result<String, String> {
        execute_action(
            loc,
            Action {
                kind: kind.into(),
                value: Some(value.into()),
                extra: Some(extra.into()),
                paths: Some(paths.iter().map(|s| s.to_string()).collect()),
                allow_empty,
                lease: None,
                expected_head: None,
                expected_branch: None,
            },
        )
    }
    #[test]
    fn message_edits_preserve_dirty_index_worktree_and_untracked_files() {
        let (dir, loc) = workflow_repo();
        std::fs::write(dir.path().join("file.txt"), "base\n").unwrap();
        run_action(&loc, "stage", "", "", &["file.txt"], false).unwrap();
        run_action(&loc, "commit", "original root", "", &[], false).unwrap();
        let root = commit_target(&loc, "HEAD").unwrap();
        run_action(&loc, "commit", "second", "", &[], true).unwrap();
        run_action(&loc, "commit", "third", "", &[], true).unwrap();
        let untouched = commit_target(&loc, "HEAD").unwrap();
        git(&loc, &["branch", "untouched", &untouched]).unwrap();
        git(&loc, &["config", "rebase.updateRefs", "true"]).unwrap();
        git(&loc, &["config", "rebase.autoSquash", "true"]).unwrap();
        std::fs::write(dir.path().join("file.txt"), "staged\n").unwrap();
        run_action(&loc, "stage", "", "", &["file.txt"], false).unwrap();
        std::fs::write(dir.path().join("file.txt"), "unstaged\n").unwrap();
        std::fs::write(dir.path().join("untracked.bin"), [0, 1, 2, 255]).unwrap();
        let index = git(&loc, &["ls-files", "--stage", "-z"]).unwrap();
        let staged = git(&loc, &["diff", "--cached", "--binary"]).unwrap();
        let unstaged = git(&loc, &["diff", "--binary"]).unwrap();
        let status = git(&loc, &["status", "--porcelain", "-z"]).unwrap();
        for target in [&root, "HEAD"] {
            run_action(&loc, "reword", "updated message", target, &[], false).unwrap();
            assert_eq!(commit_target(&loc, "untouched").unwrap(), untouched);
            assert_eq!(git(&loc, &["ls-files", "--stage", "-z"]).unwrap(), index);
            assert_eq!(
                git(&loc, &["diff", "--cached", "--binary"]).unwrap(),
                staged
            );
            assert_eq!(git(&loc, &["diff", "--binary"]).unwrap(), unstaged);
            assert_eq!(git(&loc, &["status", "--porcelain", "-z"]).unwrap(), status);
            assert_eq!(git(&loc, &["show", "HEAD:file.txt"]).unwrap(), "base\n");
            assert_eq!(
                std::fs::read_to_string(dir.path().join("file.txt")).unwrap(),
                "unstaged\n"
            );
            assert_eq!(
                std::fs::read(dir.path().join("untracked.bin")).unwrap(),
                [0, 1, 2, 255]
            );
            assert_eq!(
                git(&loc, &["worktree", "list", "--porcelain"])
                    .unwrap()
                    .lines()
                    .filter(|line| line.starts_with("worktree "))
                    .count(),
                1
            );
            assert!(git(&loc, &["stash", "list"]).unwrap().is_empty());
        }
        let head = commit_target(&loc, "HEAD").unwrap();
        let root = commit_target(&loc, "HEAD~2").unwrap();
        let hooks = dir.path().join("test-hooks");
        std::fs::create_dir(&hooks).unwrap();
        let hook = hooks.join("pre-commit");
        std::fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        git(&loc, &["config", "core.hooksPath", hooks.to_str().unwrap()]).unwrap();
        assert!(run_action(&loc, "reword", "hook must reject", &root, &[], false).is_err());
        assert_eq!(commit_target(&loc, "HEAD").unwrap(), head);
        assert_eq!(git(&loc, &["ls-files", "--stage", "-z"]).unwrap(), index);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("file.txt")).unwrap(),
            "unstaged\n"
        );
        assert_eq!(
            git(&loc, &["worktree", "list", "--porcelain"])
                .unwrap()
                .lines()
                .filter(|line| line.starts_with("worktree "))
                .count(),
            1
        );
    }
    #[test]
    fn history_counts_cover_unloaded_commits_and_match_branch_scope() {
        let (_dir, loc) = workflow_repo();
        assert_eq!(commit_count(&loc, false).unwrap(), 0);
        assert_eq!(commit_count(&loc, true).unwrap(), 0);
        let mut stream = String::new();
        for index in 0..1505 {
            let message = format!("Commit {index}");
            stream.push_str(&format!("commit refs/heads/main\ncommitter Count Test <count@example.test> 1700000000 +0000\ndata {}\n{message}\n\n", message.len()));
        }
        let mut command = Command::new("git");
        command.args(["-C", &loc.path, "fast-import", "--quiet"]);
        output_with_input(command, 30, Some(stream.into_bytes())).unwrap();
        git(&loc, &["reset", "--hard", "HEAD"]).unwrap();
        git(&loc, &["branch", "same-tip", "HEAD"]).unwrap();
        assert_eq!(log(&loc, 0, false).unwrap().len(), 100);
        assert_eq!(log(&loc, 1400, false).unwrap().len(), 100);
        assert_eq!(commit_count(&loc, false).unwrap(), 1505);
        assert_eq!(commit_count(&loc, true).unwrap(), 1505);
        git(&loc, &["switch", "-c", "side", "HEAD~1"]).unwrap();
        run_action(&loc, "commit", "Side commit", "", &[], true).unwrap();
        git(&loc, &["switch", "main"]).unwrap();
        git(&loc, &["merge", "--no-ff", "--no-edit", "side"]).unwrap();
        assert_eq!(commit_count(&loc, false).unwrap(), 1507);
        assert_eq!(commit_count(&loc, true).unwrap(), 1506);
        git(&loc, &["switch", "--detach", "HEAD~1"]).unwrap();
        run_action(&loc, "commit", "Detached commit", "", &[], true).unwrap();
        assert_eq!(commit_count(&loc, false).unwrap(), 1508);
        assert_eq!(commit_count(&loc, true).unwrap(), 1506);
    }
    #[test]
    fn history_actions_preserve_trees_and_rewrite_root_and_descendants() {
        let (dir, loc) = workflow_repo();
        assert!(run_action(&loc, "commit", "empty rejected", "", &[], false).is_err());
        run_action(&loc, "commit", "root\n\nbody", "", &[], true).unwrap();
        let root = commit_target(&loc, "HEAD").unwrap();
        std::fs::write(dir.path().join("file.txt"), "one\n").unwrap();
        run_action(&loc, "stage", "", "", &["file.txt"], false).unwrap();
        run_action(&loc, "commit", "second", "", &[], false).unwrap();
        run_action(&loc, "commit", "empty descendant", "", &[], true).unwrap();
        let tree = git(&loc, &["rev-parse", "HEAD^{tree}"]).unwrap();
        run_action(&loc, "createBranch", "from-root", &root, &[], false).unwrap();
        assert_eq!(commit_target(&loc, "from-root").unwrap(), root);
        assert_eq!(
            git(&loc, &["branch", "--show-current"]).unwrap().trim(),
            "main"
        );
        run_action(&loc, "createTag", "v1", &root, &[], false).unwrap();
        assert_eq!(commit_target(&loc, "v1").unwrap(), root);
        run_action(&loc, "reword", "new root\n\nnew body", &root, &[], false).unwrap();
        assert_eq!(
            git(&loc, &["rev-list", "--count", "HEAD"]).unwrap().trim(),
            "3"
        );
        assert_eq!(git(&loc, &["rev-parse", "HEAD^{tree}"]).unwrap(), tree);
        assert_eq!(
            git(&loc, &["show", "-s", "--format=%B", "HEAD~2"])
                .unwrap()
                .trim(),
            "new root\n\nnew body"
        );
        let second = commit_target(&loc, "HEAD~1").unwrap();
        run_action(&loc, "reword", "new second", &second, &[], false).unwrap();
        assert_eq!(
            git(&loc, &["log", "-1", "--format=%s", "HEAD~1"])
                .unwrap()
                .trim(),
            "new second"
        );
        std::fs::write(dir.path().join("file.txt"), "dirty\n").unwrap();
        run_action(&loc, "stage", "", "", &["file.txt"], false).unwrap();
        run_action(&loc, "reword", "message only", "HEAD", &[], false).unwrap();
        assert_eq!(git(&loc, &["show", "HEAD:file.txt"]).unwrap(), "one\n");
        assert!(!git(&loc, &["diff", "--cached"]).unwrap().is_empty());
        run_action(&loc, "reset", "HEAD~1", "soft", &[], false).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("file.txt")).unwrap(),
            "dirty\n"
        );
        run_action(&loc, "reset", "HEAD", "mixed", &[], false).unwrap();
        assert!(git(&loc, &["diff", "--cached"]).unwrap().is_empty());
        run_action(&loc, "reset", "HEAD", "hard", &[], false).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("file.txt")).unwrap(),
            "one\n"
        );
        assert!(snapshot(&loc).unwrap().tags.contains(&"v1".to_owned()));
        run_action(&loc, "deleteTag", "v1", "", &[], false).unwrap();
        run_action(
            &loc,
            "renameBranch",
            "from-root",
            "renamed-root",
            &[],
            false,
        )
        .unwrap();
        assert_eq!(commit_target(&loc, "renamed-root").unwrap(), root);
        std::fs::write(dir.path().join("file.txt"), "amended contents\n").unwrap();
        run_action(&loc, "stage", "", "", &["file.txt"], false).unwrap();
        let count = git(&loc, &["rev-list", "--count", "HEAD"]).unwrap();
        run_action(&loc, "amend", "amended", "", &[], false).unwrap();
        assert_eq!(git(&loc, &["rev-list", "--count", "HEAD"]).unwrap(), count);
        assert_eq!(
            git(&loc, &["show", "HEAD:file.txt"]).unwrap(),
            "amended contents\n"
        );
        std::fs::write(dir.path().join("file.txt"), "discard me\n").unwrap();
        run_action(&loc, "discard", "", "", &["file.txt"], false).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("file.txt")).unwrap(),
            "amended contents\n"
        );
        for name in ["[draft].txt", "d.txt"] {
            std::fs::write(dir.path().join(name), "untracked\n").unwrap();
        }
        run_action(&loc, "discard", "", "untracked", &["[draft].txt"], false).unwrap();
        assert!(!dir.path().join("[draft].txt").exists());
        assert!(dir.path().join("d.txt").exists());
    }
    #[test]
    fn conflicts_can_choose_a_side_continue_or_abort() {
        let (dir, loc) = workflow_repo();
        std::fs::write(dir.path().join("f.txt"), "base\n").unwrap();
        run_action(&loc, "stage", "", "", &["f.txt"], false).unwrap();
        run_action(&loc, "commit", "base", "", &[], false).unwrap();
        run_action(&loc, "createBranch", "side", "", &[], false).unwrap();
        std::fs::write(dir.path().join("f.txt"), "side\n").unwrap();
        run_action(&loc, "stage", "", "", &["f.txt"], false).unwrap();
        run_action(&loc, "commit", "side", "", &[], false).unwrap();
        run_action(&loc, "switchBranch", "main", "", &[], false).unwrap();
        std::fs::write(dir.path().join("f.txt"), "main\n").unwrap();
        run_action(&loc, "stage", "", "", &["f.txt"], false).unwrap();
        run_action(&loc, "commit", "main", "", &[], false).unwrap();
        assert!(run_action(&loc, "merge", "side", "", &[], false).is_err());
        assert_eq!(operation_state(&loc).unwrap().as_deref(), Some("merge"));
        let versions =
            tauri::async_runtime::block_on(repository_conflict(loc.clone(), "f.txt".into(), None))
                .unwrap();
        assert_eq!(versions.base.as_deref(), Some("base\n"));
        assert_eq!(versions.ours.as_deref(), Some("main\n"));
        assert_eq!(versions.theirs.as_deref(), Some("side\n"));
        run_action(&loc, "resolveTheirs", "", "", &["f.txt"], false).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("f.txt")).unwrap(),
            "side\n"
        );
        run_action(&loc, "continueOperation", "merge", "", &[], false).unwrap();
        assert_eq!(operation_state(&loc).unwrap(), None);
        run_action(&loc, "reset", "HEAD~1", "hard", &[], false).unwrap();
        assert!(run_action(&loc, "merge", "side", "", &[], false).is_err());
        run_action(
            &loc,
            "resolveEdited",
            "combined\nUnicode: 你好\n'quoted' $literal\n",
            "",
            &["f.txt"],
            false,
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("f.txt")).unwrap(),
            "combined\nUnicode: 你好\n'quoted' $literal\n"
        );
        assert!(git(&loc, &["ls-files", "--unmerged"]).unwrap().is_empty());
        run_action(&loc, "continueOperation", "merge", "", &[], false).unwrap();
        run_action(&loc, "reset", "HEAD~1", "hard", &[], false).unwrap();
        assert!(run_action(&loc, "cherryPick", "side", "", &[], false).is_err());
        assert_eq!(
            operation_state(&loc).unwrap().as_deref(),
            Some("cherry-pick")
        );
        run_action(&loc, "abortOperation", "cherry-pick", "", &[], false).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("f.txt")).unwrap(),
            "main\n"
        );
        std::fs::write(dir.path().join("untracked.txt"), "saved\n").unwrap();
        run_action(&loc, "stash", "save all", "", &[], false).unwrap();
        assert!(!dir.path().join("untracked.txt").exists());
        assert_eq!(snapshot(&loc).unwrap().stashes.len(), 1);
        run_action(&loc, "stashPop", "stash@{0}", "", &[], false).unwrap();
        assert!(dir.path().join("untracked.txt").exists());
    }
    #[test]
    fn force_push_rejects_unseen_remote_updates() {
        let (_dir, loc) = workflow_repo();
        let remote = tempfile::tempdir().unwrap();
        let mut init = Command::new("git");
        init.args(["init", "--bare", remote.path().to_str().unwrap()]);
        output(init, 10).unwrap();
        git(
            &loc,
            &["remote", "add", "origin", remote.path().to_str().unwrap()],
        )
        .unwrap();
        run_action(&loc, "commit", "root", "", &[], true).unwrap();
        assert!(published_targets(&loc, "HEAD").unwrap().is_empty());
        run_action(&loc, "publishBranch", "origin", "", &[], false).unwrap();
        assert_eq!(snapshot(&loc).unwrap().tracking.unwrap().ahead, 0);
        let published = commit_target(&loc, "HEAD").unwrap();
        run_action(&loc, "commit", "local only", "", &[], true).unwrap();
        assert!(published_targets(&loc, "HEAD").unwrap().is_empty());
        assert_eq!(
            published_targets(&loc, "HEAD~1").unwrap()[0].expected,
            published
        );
        run_action(&loc, "reset", "HEAD~1", "hard", &[], false).unwrap();
        let result: serde_json::Value = serde_json::from_str(
            &run_action(&loc, "reword", "rewritten", "HEAD", &[], false).unwrap(),
        )
        .unwrap();
        assert_eq!(result["targets"][0]["expected"], published);
        let push = |receipt: &serde_json::Value| -> Action {
            serde_json::from_value(serde_json::json!({"kind":"forcePush", "lease":receipt["targets"][0], "expectedHead":receipt["head"], "expectedBranch":receipt["branch"]})).unwrap()
        };
        execute_action(&loc, push(&result)).unwrap();
        let mut wrong_branch = push(&result);
        wrong_branch.expected_branch = Some("another-branch".into());
        assert_eq!(
            execute_action(&loc, wrong_branch).unwrap_err(),
            "REWRITE_STATE_CHANGED"
        );
        let mut wrong_head = push(&result);
        wrong_head.expected_head = Some(published);
        assert_eq!(
            execute_action(&loc, wrong_head).unwrap_err(),
            "REWRITE_STATE_CHANGED"
        );
        run_action(&loc, "forcePush", "", "", &[], false).unwrap();
        let (_other_dir, other) = workflow_repo();
        git(
            &other,
            &["remote", "add", "origin", remote.path().to_str().unwrap()],
        )
        .unwrap();
        git(&other, &["fetch", "origin"]).unwrap();
        git(&other, &["branch", "-m", "unused"]).unwrap();
        run_action(&other, "trackBranch", "origin/main", "", &[], false).unwrap();
        run_action(&other, "commit", "remote advanced", "", &[], true).unwrap();
        git(&other, &["push", "origin", "main"]).unwrap();
        let second: serde_json::Value = serde_json::from_str(
            &run_action(&loc, "reword", "second rewrite", "HEAD", &[], false).unwrap(),
        )
        .unwrap();
        assert!(run_action(&loc, "forcePush", "", "", &[], false).is_err());
        git(&loc, &["fetch", "origin"]).unwrap();
        assert!(execute_action(&loc, push(&second)).is_err());
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
            allow_empty: false,
            lease: None,
            expected_head: None,
            expected_branch: None,
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
            None,
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
        let diff = diff_text(&loc, "你好.txt", false, None, false).unwrap();
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
