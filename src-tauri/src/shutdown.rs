//! Route console interrupts through Tauri instead of the CRT signal handlers
//! that input methods and other injected modules may replace.
pub fn install(app: &tauri::AppHandle) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        let mut process = 0;
        // GUI builds normally have no console and need no console handler.
        if unsafe { windows::GetConsoleProcessList(&mut process, 1) } != 0 {
            let app = app.clone();
            windows::register(move || app.exit(0))?;
        }
    }
    #[cfg(not(windows))]
    let _ = app;
    Ok(())
}

#[cfg(windows)]
mod windows {
    use std::sync::OnceLock;

    static EXIT: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn SetConsoleCtrlHandler(handler: Option<extern "system" fn(u32) -> i32>, add: i32) -> i32;
        pub(super) fn GetConsoleProcessList(processes: *mut u32, count: u32) -> u32;
    }

    extern "system" fn interrupt(event: u32) -> i32 {
        if matches!(event, 0 | 1) {
            if let Some(exit) = EXIT.get() {
                // Request exit on Tauri's event loop. No UI teardown runs here.
                exit();
                return 1;
            }
        }
        0
    }

    pub(super) fn register(exit: impl Fn() + Send + Sync + 'static) -> std::io::Result<()> {
        if EXIT.set(Box::new(exit)).is_err() {
            return Ok(());
        }
        // A custom handler does not make child Git/SSH processes ignore Ctrl+C.
        if unsafe { SetConsoleCtrlHandler(Some(interrupt), 1) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::time::{Duration, Instant};

        static RECEIVED: AtomicUsize = AtomicUsize::new(0);
        static LEGACY: AtomicUsize = AtomicUsize::new(0);

        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetCurrentProcessId() -> u32;
            fn GenerateConsoleCtrlEvent(event: u32, group: u32) -> i32;
        }
        extern "system" fn legacy_handler(_: u32) -> i32 {
            LEGACY.fetch_add(1, Ordering::SeqCst);
            1
        }

        #[test]
        #[ignore = "Run in a dedicated hidden console; never broadcast interrupts to a shared terminal"]
        fn interrupts_bypass_legacy_handlers_in_isolated_console() {
            assert_eq!(
                std::env::var("REPOWEFT_ISOLATED_CONSOLE_TEST").as_deref(),
                Ok("1")
            );
            let mut processes = [0u32; 16];
            let count =
                unsafe { GetConsoleProcessList(processes.as_mut_ptr(), processes.len() as u32) };
            assert_eq!(
                count, 1,
                "The test requires a console containing only this process"
            );
            assert_eq!(processes[0], unsafe { GetCurrentProcessId() });
            assert_ne!(unsafe { SetConsoleCtrlHandler(Some(legacy_handler), 1) }, 0);
            register(|| {
                RECEIVED.fetch_add(1, Ordering::SeqCst);
            })
            .unwrap();
            for event in [0, 1] {
                let previous = RECEIVED.load(Ordering::SeqCst);
                assert_ne!(unsafe { GenerateConsoleCtrlEvent(event, 0) }, 0);
                let start = Instant::now();
                while RECEIVED.load(Ordering::SeqCst) == previous
                    && start.elapsed() < Duration::from_secs(3)
                {
                    std::thread::sleep(Duration::from_millis(10));
                }
                assert_eq!(RECEIVED.load(Ordering::SeqCst), previous + 1);
                assert_eq!(LEGACY.load(Ordering::SeqCst), 0);
            }
            assert_eq!(
                interrupt(2),
                0,
                "Unrelated console events retain normal handling"
            );
        }
    }
}
