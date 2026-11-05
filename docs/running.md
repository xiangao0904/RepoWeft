# Running RepoWeft

## Standalone desktop app

Use a standalone build for normal Git operations, especially when RepoWeft manages its own source repository:

```powershell
pnpm desktop:build
.\src-tauri\target\release\repoweft.exe
```

This builds and embeds the frontend assets. The app does not depend on a Vite server and does not watch source files. The build skips installers; it does not launch the app automatically.

Stop an existing `pnpm tauri dev` session with Ctrl+C before opening the standalone app. RepoWeft allows one instance, so launching another executable while the development app is running will focus the existing development window.

On macOS or Linux, run the matching executable/app bundle reported by Tauri after the build. `CARGO_TARGET_DIR` and cross-compilation settings can change the output location.

If the release compiler runs out of memory, the same standalone app can be built with lower optimization for RepoWeft itself while retaining cached release dependencies:

```powershell
$env:CARGO_BUILD_JOBS = '1'
node node_modules/@tauri-apps/cli/tauri.js build --no-bundle -- --config profile.release.package.repoweft.opt-level=1 --config profile.release.package.repoweft.codegen-units=16
```

This override applies only to that build; it does not modify the release settings in Cargo.toml. The output uses embedded assets and has no source watcher.

## Development

```powershell
pnpm tauri dev
```

Tauri watches the native source and restarts the desktop process when it changes. The console reports `File ... changed. Rebuilding application...`, followed by another `Running ... repoweft` line. During this restart, the old window closes while compilation runs.

Switching branches in RepoWeft's own source checkout can change those watched files. Editing the application source from an editor or coding agent also triggers restarts. A push to another repository does not itself modify RepoWeft's source; a restart alongside a push needs to be correlated with the watched-file message rather than attributed to the push alone.

Vite updates React components separately. Shared non-component functions belong in `src/lib` so they do not invalidate React Fast Refresh boundaries.

If a standalone app exits, record the time and any console or Windows application-error event. Native panic messages, process exit codes, or WebView errors help distinguish an actual runtime failure from development restarts.

## Windows console interrupts

RepoWeft routes Ctrl+C and Ctrl+Break through Tauri's normal exit request and closes terminal sessions on exit. The handler is registered only when the desktop process is attached to a console. Git credential-helper and SSH askpass child invocations return before this handler is installed; child Git/SSH processes retain their normal console behavior.

Some input methods load CrashRpt into host processes. CrashRpt supports SIGINT handling, which can turn Ctrl+C into a crash-reporting path. If its CrashSender executable is missing, an error reporter can remain open after the interrupt. The application console handler consumes the interrupt before the CRT signal path and requests an orderly shutdown instead of disabling input methods or suppressing real exceptions.

The Windows regression test `shutdown::windows::tests::interrupts_bypass_legacy_handlers_in_isolated_console` is ignored by the regular suite. It must run in a separate hidden console with `REPOWEFT_ISOLATED_CONSOLE_TEST=1`. Before generating Ctrl+C/Ctrl+Break, it verifies that its console contains only its own process, then checks that a previously registered handler was bypassed. Never generate console control events in a shared development terminal.

References: [Windows console handlers](https://learn.microsoft.com/windows/console/setconsolectrlhandler), [CrashRpt signal handling](https://crashrpt.sourceforge.net/docs/html/_crash_rpt_8h.html).
