# Feature 43 — Persistent logging, diagnostics & crash safety

## Context
All diagnostics are ephemeral `console.*` to stdout/stderr. There is **no log file, no `electron-log`, no
`crashReporter`, and no user-facing "open/export logs"** path — a packaged-app user who hits a decrypt
failure, a failed backup-restore, or a write error has nothing to attach to a bug report. The main process
also has **no `process.on('uncaughtException'|'unhandledRejection')`** handler, so an unexpected throw
outside a `safeCall` wrapper crashes silently. And there is **no `app.requestSingleInstanceLock()`** — the
storage layer's safety model is explicitly "single-process, single-writer," yet a second instance can open
the same `userData` dir and defeat the in-process write serialization.

## Goal
Add a persistent rotating log, a user-accessible diagnostics export, global crash handlers, and a
single-instance lock.

## Implementation steps
1. **Logging**: add a rotating log file under `userData` (e.g. `electron-log` or a small custom logger).
   Route main-process `console.*` and key lifecycle/error events through it (never log secret values —
   keep the existing secret-free error shape from `crypto.js`). Mirror critical renderer errors to main
   over IPC.
2. **Crash safety**: install `process.on('uncaughtException')` and `process.on('unhandledRejection')` in
   `main.js` to log + show a dialog before exit; optionally enable Electron `crashReporter` writing
   locally (no remote upload without consent).
3. **Diagnostics export**: add a menu item "Reveal logs" / "Export diagnostics…" that opens the log
   directory or bundles logs + app/version/build info into a zip via a native save dialog.
4. **Single-instance lock**: call `app.requestSingleInstanceLock()` at startup; on a second launch, focus
   the existing window and quit the duplicate (wire `second-instance`).
5. Update the user guide

## Acceptance criteria
- Errors and key events are written to a rotating log file under `userData`; secrets never appear in it.
- An uncaught exception/rejection is logged and reported instead of vanishing.
- A user can reveal or export logs from the menu.
- Launching a second copy focuses the existing window instead of opening a duplicate.

## Constraints
- Logging/crash handling/lock live in the **main process**; keep `main.js`/`preload.js` in sync.
- No telemetry or remote log upload without explicit user consent.
- Reuse the existing secret-free error formatting; don't regress the anti-clobber secret paths.

## Verify
`make fmt && make lint && make test`
