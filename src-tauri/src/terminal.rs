use crate::git::{Location, quote};
use crate::ssh::{self, Mode};
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tauri::{AppHandle, Manager, State, ipc::Channel};

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TerminalEvent {
    Data { bytes: Vec<u8> },
    Exit,
}
struct Flow {
    pending: Mutex<usize>,
    ready: Condvar,
    closed: AtomicBool,
}
struct Session {
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    flow: Flow,
}
impl Session {
    fn stop(&self) {
        if self.flow.closed.swap(true, Ordering::Relaxed) {
            return;
        }
        self.flow.ready.notify_all();
        if let Ok(mut killer) = self.killer.lock() {
            let _ = killer.kill();
        }
        if let Ok(mut writer) = self.writer.lock() {
            writer.take();
        }
        if let Ok(mut master) = self.master.lock() {
            master.take();
        }
    }
}
#[derive(Default)]
pub struct TerminalState {
    sessions: Mutex<HashMap<u64, Arc<Session>>>,
    next: AtomicU64,
    opening: Mutex<()>,
}
impl TerminalState {
    pub fn close_all(&self) {
        let sessions: Vec<_> = self
            .sessions
            .lock()
            .map(|mut sessions| sessions.drain().map(|(_, session)| session).collect())
            .unwrap_or_default();
        for session in sessions {
            session.stop();
        }
    }
}
impl Drop for TerminalState {
    fn drop(&mut self) {
        self.close_all();
    }
}
fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        cols: cols.clamp(2, 500),
        rows: rows.clamp(1, 200),
        pixel_width: 0,
        pixel_height: 0,
    }
}
fn command(location: &Location) -> Result<CommandBuilder, String> {
    if location.path.is_empty() || location.path.contains('\0') {
        return Err("Repository path is required".into());
    }
    let mut cmd;
    match location.kind.as_str() {
        "local" => {
            if !std::path::Path::new(&location.path).is_dir() {
                return Err("Repository directory does not exist".into());
            }
            #[cfg(windows)]
            {
                cmd = CommandBuilder::new("powershell.exe");
                cmd.args(["-NoLogo", "-NoProfile"]);
            }
            #[cfg(not(windows))]
            {
                cmd = CommandBuilder::new(
                    std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()),
                );
                cmd.arg("-l");
            }
            cmd.cwd(&location.path);
        }
        "ssh" => {
            if !location.path.starts_with('/') {
                return Err("Remote path must be absolute".into());
            }
            let host = location.host.as_ref().ok_or("SSH host is missing")?;
            let source = ssh::command(host, Mode::Session)?;
            let mut args: Vec<_> = source
                .get_args()
                .map(|a| a.to_string_lossy().into_owned())
                .collect();
            let destination = args.pop().ok_or("SSH host is missing")?;
            for arg in &mut args {
                if arg == "BatchMode=yes" {
                    *arg = "BatchMode=no".into();
                }
            }
            cmd = CommandBuilder::new("ssh");
            cmd.args(args);
            cmd.arg("-tt");
            cmd.arg(destination);
            cmd.arg(format!(
                "cd {} && exec \"${{SHELL:-/bin/sh}}\" -l",
                quote(&location.path)
            ));
        }
        _ => return Err("Unknown repository backend".into()),
    }
    cmd.env("TERM", "xterm-256color");
    Ok(cmd)
}
#[tauri::command]
pub async fn terminal_open(
    app: AppHandle,
    location: Location,
    cols: u16,
    rows: u16,
    output: Channel<TerminalEvent>,
) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<TerminalState>();
        // Serialize creation without blocking acknowledgements or session removal.
        let _opening = state.opening.lock().map_err(|e| e.to_string())?;
        if state.sessions.lock().map_err(|e| e.to_string())?.len() >= 8 {
            return Err("Too many terminal sessions".into());
        }
        let pair = native_pty_system()
            .openpty(size(cols, rows))
            .map_err(|e| e.to_string())?;
        let mut child = pair
            .slave
            .spawn_command(command(&location)?)
            .map_err(|e| e.to_string())?;
        drop(pair.slave);
        let mut reader = match pair.master.try_clone_reader() {
            Ok(reader) => reader,
            Err(error) => {
                let _ = child.kill();
                return Err(error.to_string());
            }
        };
        let writer = match pair.master.take_writer() {
            Ok(writer) => writer,
            Err(error) => {
                let _ = child.kill();
                return Err(error.to_string());
            }
        };
        let session = Arc::new(Session {
            master: Mutex::new(Some(pair.master)),
            writer: Mutex::new(Some(writer)),
            killer: Mutex::new(child.clone_killer()),
            flow: Flow {
                pending: Mutex::new(0),
                ready: Condvar::new(),
                closed: AtomicBool::new(false),
            },
        });
        let id = state.next.fetch_add(1, Ordering::Relaxed) + 1;
        state
            .sessions
            .lock()
            .map_err(|e| e.to_string())?
            .insert(id, session.clone());
        let app = app.clone();
        std::thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            while !session.flow.closed.load(Ordering::Relaxed) {
                let count = match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => count,
                };
                let mut pending = match session.flow.pending.lock() {
                    Ok(value) => value,
                    Err(_) => break,
                };
                while *pending >= 128 * 1024 && !session.flow.closed.load(Ordering::Relaxed) {
                    pending = session
                        .flow
                        .ready
                        .wait_timeout(pending, Duration::from_secs(1))
                        .unwrap()
                        .0;
                }
                if session.flow.closed.load(Ordering::Relaxed) {
                    break;
                }
                *pending += count;
                drop(pending);
                if output
                    .send(TerminalEvent::Data {
                        bytes: buffer[..count].to_vec(),
                    })
                    .is_err()
                {
                    break;
                }
            }
            drop(reader);
            session.stop();
            let _ = child.wait();
            if let Ok(mut sessions) = app.state::<TerminalState>().sessions.lock() {
                sessions.remove(&id);
            }
            let _ = output.send(TerminalEvent::Exit);
        });
        Ok(id)
    })
    .await
    .map_err(|e| e.to_string())?
}
fn session(state: &TerminalState, id: u64) -> Result<Arc<Session>, String> {
    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .get(&id)
        .cloned()
        .ok_or("Terminal session has ended".into())
}
#[tauri::command]
pub async fn terminal_write(
    state: State<'_, TerminalState>,
    id: u64,
    data: String,
) -> Result<(), String> {
    if data.len() > 64 * 1024 {
        return Err("Terminal input is too large".into());
    }
    let session = session(&state, id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut slot = session.writer.lock().map_err(|e| e.to_string())?;
        let writer = slot.as_mut().ok_or("Terminal session has ended")?;
        writer
            .write_all(data.as_bytes())
            .and_then(|_| writer.flush())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn terminal_resize(
    state: State<'_, TerminalState>,
    id: u64,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    session(&state, id)?
        .master
        .lock()
        .map_err(|e| e.to_string())?
        .as_ref()
        .ok_or("Terminal session has ended")?
        .resize(size(cols, rows))
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn terminal_ack(state: State<'_, TerminalState>, id: u64, bytes: usize) -> Result<(), String> {
    let session = session(&state, id)?;
    let mut pending = session.flow.pending.lock().map_err(|e| e.to_string())?;
    *pending = pending.saturating_sub(bytes);
    session.flow.ready.notify_one();
    Ok(())
}
#[tauri::command]
pub async fn terminal_close(state: State<'_, TerminalState>, id: u64) -> Result<(), String> {
    let session = state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&id);
    if let Some(session) = session {
        tauri::async_runtime::spawn_blocking(move || session.stop())
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn terminal_rejects_invalid_locations_and_clamps_size() {
        assert!(
            command(&Location {
                kind: "local".into(),
                path: "".into(),
                host: None
            })
            .is_err()
        );
        assert!(
            command(&Location {
                kind: "ssh".into(),
                path: "relative".into(),
                host: None
            })
            .is_err()
        );
        assert_eq!(size(0, 0).cols, 2);
        assert_eq!(size(u16::MAX, u16::MAX).rows, 200);
    }
    #[test]
    fn remote_terminal_preserves_ssh_config_and_quotes_the_directory() {
        let location = Location {
            kind: "ssh".into(),
            path: "/work/it's a repo".into(),
            host: Some(crate::ssh::Host {
                hostname: "my-server".into(),
                username: String::new(),
                port: 0,
                identity_file: String::new(),
            }),
        };
        let cmd = command(&location).unwrap();
        let args: Vec<_> = cmd
            .get_argv()
            .iter()
            .map(|s| s.to_string_lossy().into_owned())
            .collect();
        assert!(args.iter().any(|s| s == "-tt"));
        assert!(args.iter().any(|s| s == "BatchMode=no"));
        assert!(!args.iter().any(|s| s == "-p" || s == "-i"));
        assert_eq!(
            args.last().unwrap(),
            "cd '/work/it'\\''s a repo' && exec \"${SHELL:-/bin/sh}\" -l"
        );
    }
    #[test]
    fn closing_sessions_releases_the_process_and_pty_handles() {
        let location = Location {
            kind: "local".into(),
            path: std::env::temp_dir().to_string_lossy().into_owned(),
            host: None,
        };
        let pair = native_pty_system().openpty(size(80, 24)).unwrap();
        let mut cmd = command(&location).unwrap();
        #[cfg(windows)]
        cmd.args(["-Command", "Start-Sleep -Seconds 60"]);
        #[cfg(not(windows))]
        cmd.args(["-c", "sleep 60"]);
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let writer = pair.master.take_writer().unwrap();
        let session = Arc::new(Session {
            master: Mutex::new(Some(pair.master)),
            writer: Mutex::new(Some(writer)),
            killer: Mutex::new(child.clone_killer()),
            flow: Flow {
                pending: Mutex::new(0),
                ready: Condvar::new(),
                closed: AtomicBool::new(false),
            },
        });
        let state = TerminalState::default();
        state.sessions.lock().unwrap().insert(1, session.clone());
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut bytes = [0; 4096];
            while let Ok(count) = reader.read(&mut bytes) {
                if count == 0 {
                    break;
                }
            }
            let _ = sender.send(());
        });
        state.close_all();
        state.close_all();
        assert!(state.sessions.lock().unwrap().is_empty());
        assert!(session.master.lock().unwrap().is_none());
        assert!(session.writer.lock().unwrap().is_none());
        receiver.recv_timeout(Duration::from_secs(10)).unwrap();
        assert!(child.wait().is_ok());
    }
    #[test]
    fn local_pty_streams_output_from_repository_directory() {
        let dir = std::env::temp_dir();
        let location = Location {
            kind: "local".into(),
            path: dir.to_string_lossy().into_owned(),
            host: None,
        };
        let pair = native_pty_system().openpty(size(80, 24)).unwrap();
        let mut cmd = command(&location).unwrap();
        #[cfg(windows)]
        cmd.args([
            "-Command",
            "[Console]::WriteLine('REPOWEFT_PTY_OK'); [Console]::WriteLine((Get-Location).Path)",
        ]);
        #[cfg(not(windows))]
        cmd.args(["-c", "printf 'REPOWEFT_PTY_OK\\n'; pwd"]);
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        pair.master.resize(size(100, 30)).unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut output = Vec::new();
            let mut buffer = [0u8; 4096];
            loop {
                let count = match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => count,
                };
                output.extend_from_slice(&buffer[..count]);
                // ConPTY asks the terminal emulator for its initial cursor position.
                if output.windows(4).any(|sequence| sequence == b"\x1b[6n") {
                    let _ = writer.write_all(b"\x1b[1;1R");
                    let _ = writer.flush();
                }
            }
            let _ = sender.send(String::from_utf8_lossy(&output).into_owned());
        });
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        loop {
            if child.try_wait().unwrap().is_some() {
                break;
            }
            if std::time::Instant::now() > deadline {
                let _ = child.kill();
                panic!("PTY child timed out");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        drop(pair.master);
        let result = receiver.recv_timeout(Duration::from_secs(10)).unwrap();
        assert!(result.contains("REPOWEFT_PTY_OK"));
        assert!(
            result.to_lowercase().contains(
                &dir.to_string_lossy()
                    .trim_end_matches(['\\', '/'])
                    .to_lowercase()
            )
        );
    }
}
