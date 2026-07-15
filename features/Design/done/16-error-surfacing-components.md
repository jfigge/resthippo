# Design 16 — One component error-surfacing convention

## Context
Components surface errors three different ways with no rule for which to use:
- **Inline `#errorEl` + `#showError`/`#clearError`** — `backup-modal.js:314-319`,
  `export-modal.js:46`, `pill-editor-popup.js:484`.
- **Modal `PopupManager.notify`** — `request-editor.js:2747,2814,2890`,
  `tree-view.js:1090-1097`.
- **Toast `Notifications.*`** — used in exactly one component,
  `request-auth-editor.js:1232` (`Notifications.warning`), even though Feature 26
  introduced `Notifications` as the app-wide way to report that something happened.

So the toast system that was meant to be the standard is barely used, while modal `notify`
and inline errors dominate.

## Goal
A documented rule for when to use inline field-level errors vs. a transient toast vs. a
blocking modal, applied consistently across components.

## Implementation steps
1. Define the rule (recommended):
   - **Inline `#errorEl`** for validation tied to a specific field/form (stays visible
     while the user fixes input).
   - **Toast (`Notifications.*`)** for transient, non-blocking outcomes ("Saved",
     "Export failed", a recoverable warning) — the default for "something happened."
   - **Modal (`PopupManager.notify`)** only for errors that must block and be acknowledged.
   Document it in `CLAUDE.md` (alongside the Feature 26 notification notes).
2. Inventory current error-surfacing call sites against the rule and list the mismatches.
3. Migrate the mismatches — most likely converting some `PopupManager.notify` toasts-in-
   disguise to `Notifications.*`, and keeping genuine blocking errors as modals. Keep
   inline field errors where they belong.
4. Ensure save-failure surfacing from Design 01 (`__hippoError`) uses this same convention.

## Acceptance criteria
- A documented rule exists; each error path uses the matching mechanism.
- The toast system is used for transient outcomes rather than being effectively unused.
- No error path is silently dropped.

## Constraints
- Behavior-preserving in intent (the user still learns of every error).
- Reuse the existing `Notifications` and `PopupManager` APIs; do not add a new one.

## Verify
`make fmt && make lint && make test`
