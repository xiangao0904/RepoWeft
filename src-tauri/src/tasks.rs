//! Cancellation is restricted to read operations; writes always run to completion.
use std::{
    cell::RefCell,
    collections::HashMap,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
};
type Token = Arc<AtomicBool>;
fn registry() -> &'static Mutex<HashMap<String, Token>> {
    static TASKS: OnceLock<Mutex<HashMap<String, Token>>> = OnceLock::new();
    TASKS.get_or_init(|| Mutex::new(HashMap::new()))
}
thread_local! { static CURRENT: RefCell<Option<Token>> = const { RefCell::new(None) }; }
pub fn cancelled() -> bool {
    CURRENT.with(|slot| {
        slot.borrow()
            .as_ref()
            .is_some_and(|token| token.load(Ordering::Relaxed))
    })
}
fn context<T>(token: Option<Token>, work: impl FnOnce() -> T) -> T {
    struct Reset(Option<Token>);
    impl Drop for Reset {
        fn drop(&mut self) {
            CURRENT.with(|slot| *slot.borrow_mut() = self.0.take());
        }
    }
    let _reset = Reset(CURRENT.with(|slot| slot.replace(token)));
    work()
}
pub fn inherit<T: Send>(work: impl FnOnce() -> T + Send) -> impl FnOnce() -> T + Send {
    let token = CURRENT.with(|slot| slot.borrow().clone());
    move || context(token, work)
}
pub async fn read<T: Send + 'static>(
    id: Option<String>,
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let token = id.as_ref().map(|id| {
        registry()
            .lock()
            .unwrap()
            .entry(id.clone())
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .clone()
    });
    let result = tauri::async_runtime::spawn_blocking(move || {
        context(token, || {
            if cancelled() {
                return Err("READ_CANCELLED".into());
            }
            let result = work();
            if cancelled() {
                Err("READ_CANCELLED".into())
            } else {
                result
            }
        })
    })
    .await
    .map_err(|error| error.to_string());
    if let Some(id) = id {
        registry().lock().unwrap().remove(&id);
    }
    result?
}
#[tauri::command]
pub fn repository_cancel(request_id: String) {
    let mut tasks = registry().lock().unwrap();
    // A cancel may arrive just before registration. Bound these short-lived tombstones.
    if tasks.len() > 512 {
        tasks.retain(|_, token| !token.load(Ordering::Relaxed));
    }
    tasks
        .entry(request_id)
        .or_insert_with(|| Arc::new(AtomicBool::new(false)))
        .store(true, Ordering::Relaxed);
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_crosses_workers_and_restores_context() {
        let token = Arc::new(AtomicBool::new(true));
        context(Some(token), || {
            assert!(cancelled());
            std::thread::scope(|scope| assert!(scope.spawn(inherit(cancelled)).join().unwrap()));
        });
        assert!(!cancelled());
    }
    #[test]
    fn cancelling_a_read_stops_its_process_promptly() {
        let token = Arc::new(AtomicBool::new(false));
        let worker_token = token.clone();
        let start = std::time::Instant::now();
        let worker = std::thread::spawn(move || {
            context(Some(worker_token), || {
                #[cfg(windows)]
                let mut command = std::process::Command::new("powershell.exe");
                #[cfg(windows)]
                command.args(["-NoProfile", "-Command", "Start-Sleep -Seconds 30"]);
                #[cfg(not(windows))]
                let mut command = std::process::Command::new("sleep");
                #[cfg(not(windows))]
                command.arg("30");
                crate::git::output(command, 40)
            })
        });
        std::thread::sleep(std::time::Duration::from_millis(100));
        token.store(true, Ordering::Relaxed);
        assert_eq!(worker.join().unwrap().unwrap_err(), "READ_CANCELLED");
        assert!(start.elapsed() < std::time::Duration::from_secs(5));
    }
}
