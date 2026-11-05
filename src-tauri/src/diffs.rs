//! Diff text stays in an anonymous temporary file. Only requested pages cross IPC.
use crate::git::{self, Location};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::State;

const PAGE_LINES: usize = 128;
const MAX_DOCUMENTS: usize = 4;
const MAX_BYTES: usize = 16 * 1024 * 1024;
const CLOSED_TTL: Duration = Duration::from_secs(600);

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum LineKind {
    Context,
    Add,
    Remove,
    Hunk,
}
#[derive(Serialize, Debug)]
pub struct DiffLine {
    text: String,
    kind: LineKind,
}
#[derive(Serialize, Debug)]
pub struct DiffPage {
    start: usize,
    lines: Vec<DiffLine>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenDiff {
    id: String,
    total_lines: usize,
    page_size: usize,
}

struct Document {
    file: Mutex<File>,
    offsets: Vec<u64>,
    total_lines: usize,
    bytes: u64,
}
impl Document {
    fn new(text: String) -> Result<Self, String> {
        if text.len() > MAX_BYTES {
            return Err("DIFF_TOO_LARGE".into());
        }
        let mut file = tempfile::tempfile().map_err(|error| error.to_string())?;
        file.write_all(text.as_bytes())
            .map_err(|error| error.to_string())?;
        let mut offsets = vec![0];
        let mut line = 0;
        for (index, byte) in text.bytes().enumerate() {
            if index & 8191 == 0 && crate::tasks::cancelled() {
                return Err("READ_CANCELLED".into());
            }
            if byte == b'\n' {
                line += 1;
                if line % PAGE_LINES == 0 {
                    offsets.push((index + 1) as u64);
                }
            }
        }
        Ok(Self {
            file: Mutex::new(file),
            offsets,
            total_lines: if text.is_empty() { 0 } else { line + 1 },
            bytes: text.len() as u64,
        })
    }
    fn page(&self, page: usize) -> Result<DiffPage, String> {
        let start = page.checked_mul(PAGE_LINES).ok_or("DIFF_INVALID_PAGE")?;
        if start >= self.total_lines {
            if page == 0 && self.total_lines == 0 {
                return Ok(DiffPage {
                    start: 0,
                    lines: Vec::new(),
                });
            }
            return Err("DIFF_INVALID_PAGE".into());
        }
        let offset = self.offsets[page];
        let end = self.offsets.get(page + 1).copied().unwrap_or(self.bytes);
        let mut bytes = vec![0; (end - offset) as usize];
        {
            let mut file = self.file.lock().map_err(|error| error.to_string())?;
            file.seek(SeekFrom::Start(offset))
                .map_err(|error| error.to_string())?;
            file.read_exact(&mut bytes)
                .map_err(|error| error.to_string())?;
        }
        let text = std::str::from_utf8(&bytes).map_err(|error| error.to_string())?;
        let lines = text
            .split('\n')
            .take(PAGE_LINES.min(self.total_lines - start))
            .map(|text| {
                let kind = match text.as_bytes().first() {
                    Some(b'+') => LineKind::Add,
                    Some(b'-') => LineKind::Remove,
                    _ if text.starts_with("@@") => LineKind::Hunk,
                    _ => LineKind::Context,
                };
                DiffLine {
                    text: text.to_string(),
                    kind,
                }
            })
            .collect();
        Ok(DiffPage { start, lines })
    }
}
#[derive(Default)]
struct Store {
    documents: HashMap<String, Arc<Document>>,
    closed: HashMap<String, Instant>,
}
#[derive(Clone, Default)]
pub struct DiffState(Arc<Mutex<Store>>);
impl DiffState {
    fn insert(&self, id: &str, document: Document) -> Result<OpenDiff, String> {
        let total_lines = document.total_lines;
        let mut store = self.0.lock().map_err(|error| error.to_string())?;
        store.closed.retain(|_, time| time.elapsed() < CLOSED_TTL);
        if store.closed.contains_key(id) || crate::tasks::cancelled() {
            return Err("READ_CANCELLED".into());
        }
        if store.documents.len() >= MAX_DOCUMENTS {
            return Err("DIFF_LIMIT".into());
        }
        if store.documents.contains_key(id) {
            return Err("DIFF_SESSION_EXISTS".into());
        }
        store.documents.insert(id.to_string(), Arc::new(document));
        Ok(OpenDiff {
            id: id.to_string(),
            total_lines,
            page_size: PAGE_LINES,
        })
    }
    fn page(&self, id: &str, page: usize) -> Result<DiffPage, String> {
        let document = self
            .0
            .lock()
            .map_err(|error| error.to_string())?
            .documents
            .get(id)
            .cloned()
            .ok_or("DIFF_CLOSED")?;
        document.page(page)
    }
    fn close(&self, id: &str) -> Result<(), String> {
        if id.is_empty() || id.len() > 128 {
            return Err("DIFF_INVALID_SESSION".into());
        }
        let document = {
            let mut store = self.0.lock().map_err(|error| error.to_string())?;
            store.closed.retain(|_, time| time.elapsed() < CLOSED_TTL);
            let document = store.documents.remove(id);
            if document.is_none() {
                // A close can arrive before its opening command is registered.
                if store.closed.len() >= 1024 {
                    if let Some(oldest) = store
                        .closed
                        .iter()
                        .min_by_key(|(_, time)| **time)
                        .map(|(key, _)| key.clone())
                    {
                        store.closed.remove(&oldest);
                    }
                }
                store.closed.insert(id.to_string(), Instant::now());
            }
            document
        };
        drop(document);
        Ok(())
    }
}

#[derive(Deserialize)]
pub struct DiffRequest {
    location: Location,
    path: String,
    staged: bool,
    hash: Option<String>,
    untracked: bool,
}
#[tauri::command]
pub async fn repository_diff_open(
    state: State<'_, DiffState>,
    diff: DiffRequest,
    session_id: String,
    request_id: Option<String>,
) -> Result<OpenDiff, String> {
    if session_id.is_empty() || session_id.len() > 128 {
        return Err("DIFF_INVALID_SESSION".into());
    }
    let state = state.inner().clone();
    crate::tasks::read(request_id, move || {
        let text = git::diff_text(
            &diff.location,
            &diff.path,
            diff.staged,
            diff.hash.as_deref(),
            diff.untracked,
        )?;
        state.insert(&session_id, Document::new(text)?)
    })
    .await
}
#[tauri::command]
pub async fn repository_diff_page(
    state: State<'_, DiffState>,
    session_id: String,
    page: usize,
    request_id: Option<String>,
) -> Result<DiffPage, String> {
    let state = state.inner().clone();
    crate::tasks::read(request_id, move || state.page(&session_id, page)).await
}
#[tauri::command]
pub async fn repository_diff_close(
    state: State<'_, DiffState>,
    session_id: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.close(&session_id))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pages_preserve_unicode_kinds_crlf_and_trailing_empty_lines() {
        let mut lines: Vec<_> = (0..300).map(|i| format!("+第{i}行")).collect();
        lines[0] = "@@ -1 +1 @@".into();
        lines[1] = "-old\r".into();
        lines[2] = " context".into();
        let text = lines.join("\n") + "\n";
        let document = Document::new(text.clone()).unwrap();
        assert_eq!(document.total_lines, 301);
        let pages: Vec<_> = (0..3).map(|page| document.page(page).unwrap()).collect();
        assert_eq!(pages[1].start, 128);
        assert_eq!(pages[0].lines[0].kind, LineKind::Hunk);
        assert_eq!(pages[0].lines[1].kind, LineKind::Remove);
        assert_eq!(pages[0].lines[2].kind, LineKind::Context);
        assert_eq!(pages[1].lines[0].kind, LineKind::Add);
        assert_eq!(
            pages
                .into_iter()
                .flat_map(|page| page.lines.into_iter().map(|line| line.text))
                .collect::<Vec<_>>()
                .join("\n"),
            text
        );
        assert!(document.page(3).is_err());
    }
    #[test]
    fn empty_and_exact_page_boundaries_are_preserved() {
        for count in [0, 1, 127, 128, 129, 256] {
            let text = (0..count)
                .map(|i| i.to_string())
                .collect::<Vec<_>>()
                .join("\n");
            let document = Document::new(text).unwrap();
            assert_eq!(document.total_lines, count);
            let actual: usize = (0..count.div_ceil(PAGE_LINES).max(1))
                .map(|page| document.page(page).unwrap().lines.len())
                .sum();
            assert_eq!(actual, count);
        }
    }
    #[test]
    fn early_close_and_capacity_bounds_cannot_leak_documents() {
        let state = DiffState::default();
        state.close("early").unwrap();
        assert!(
            state
                .insert("early", Document::new("late".into()).unwrap())
                .is_err()
        );
        for i in 0..MAX_DOCUMENTS {
            state
                .insert(&i.to_string(), Document::new("text".into()).unwrap())
                .unwrap();
        }
        assert!(
            state
                .insert("overflow", Document::new("text".into()).unwrap())
                .is_err()
        );
        state.close("0").unwrap();
        assert!(state.page("0", 0).is_err());
        state
            .insert("replacement", Document::new("text".into()).unwrap())
            .unwrap();
        assert_eq!(state.0.lock().unwrap().documents.len(), MAX_DOCUMENTS);
    }
    #[test]
    fn repeated_previews_release_documents_without_accumulating_tombstones() {
        let state = DiffState::default();
        for i in 0..1100 {
            let id = i.to_string();
            state
                .insert(&id, Document::new("+line".into()).unwrap())
                .unwrap();
            state.close(&id).unwrap();
        }
        let store = state.0.lock().unwrap();
        assert!(store.documents.is_empty());
        assert!(store.closed.is_empty());
    }
    #[test]
    fn large_diff_keeps_only_a_sparse_index_in_memory() {
        let document = Document::new("+line\n".repeat(100_000)).unwrap();
        assert_eq!(document.total_lines, 100_001);
        assert_eq!(document.offsets.len(), 782);
        assert_eq!(document.page(781).unwrap().lines.len(), 33);
        assert!(document.page(usize::MAX).is_err());
    }
    #[test]
    fn long_lines_remain_complete_and_oversized_previews_are_rejected() {
        let text = "+".to_string() + &"界".repeat(350_000);
        let document = Document::new(text.clone()).unwrap();
        assert_eq!(document.total_lines, 1);
        assert_eq!(document.page(0).unwrap().lines[0].text, text);
        assert!(Document::new("x".repeat(MAX_BYTES + 1)).is_err());
    }
    #[test]
    fn real_git_diffs_round_trip_through_paged_storage() {
        let dir = tempfile::tempdir().unwrap();
        let location = Location {
            kind: "local".into(),
            path: dir.path().to_string_lossy().into_owned(),
            host: None,
        };
        let run = |args: &[&str]| {
            let mut command = std::process::Command::new("git");
            command.arg("-C").arg(dir.path()).args(args);
            git::output(command, 30).unwrap()
        };
        run(&["init", "-q"]);
        std::fs::write(dir.path().join("中文.txt"), "old\n").unwrap();
        run(&["add", "."]);
        run(&[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "-qm",
            "Initial",
        ]);
        std::fs::write(dir.path().join("中文.txt"), "+new内容\n".repeat(600)).unwrap();
        let round_trip = |text: String| {
            let document = Document::new(text.clone()).unwrap();
            let rebuilt = (0..document.total_lines.div_ceil(PAGE_LINES).max(1))
                .flat_map(|page| {
                    document
                        .page(page)
                        .unwrap()
                        .lines
                        .into_iter()
                        .map(|line| line.text)
                })
                .collect::<Vec<_>>()
                .join("\n");
            assert_eq!(rebuilt, text);
        };
        round_trip(git::diff_text(&location, "中文.txt", false, None, false).unwrap());
        assert!(
            git::diff_text(&location, "中文.txt", true, None, false)
                .unwrap()
                .is_empty()
        );
        run(&["add", "."]);
        round_trip(git::diff_text(&location, "中文.txt", true, None, false).unwrap());
        let hash = run(&["rev-parse", "HEAD"]);
        round_trip(git::diff_text(&location, "中文.txt", false, Some(hash.trim()), false).unwrap());
        std::fs::write(dir.path().join("untracked.txt"), "新行\n".repeat(500)).unwrap();
        round_trip(git::diff_text(&location, "untracked.txt", false, None, true).unwrap());
        std::fs::write(dir.path().join("binary.bin"), [0, 1, 2]).unwrap();
        assert_eq!(
            git::diff_text(&location, "binary.bin", false, None, true).unwrap(),
            "Binary file"
        );
    }
}
