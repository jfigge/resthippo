# Feature 26 — User-facing notifications & standardized error surfacing

## Context
Errors currently reach the user as **silence**. In the renderer, `storeCall()`
(`src/web/scripts/data-store.js` ~112-118) wraps every persistence call in `try/catch`, logs
`console.warn`, and resolves to a fallback. In the main process, `safeCall()` (`src/app/main.js` ~95-102)
catches store-handler throws, logs `console.error`, and returns a typed fallback. So a persistent **write**
failure (disk full, permission denied, keystore unavailable) is logged to a console the user can't see
while the UI proceeds as if the save succeeded — silent data loss.

Critically, **there is no toast/notification component anywhere in the renderer** (verified: none exists).
Even where a failure is detected, there is no standard way to tell the user.

## Goal
Add a single renderer-wide notification surface (toast/inline-banner) and route detected failures through
it, so that **write failures and other actionable errors are always visible** — while read failures may
still degrade quietly.

## Implementation steps
1. **Notification component**: build a small `Notifications`/toast module (follow the class-based pattern
   and `PopupManager` conventions in `src/web/scripts/popup-manager.js`) with levels (error/warn/info/
   success), auto-dismiss for non-errors, manual dismiss + optional action button for errors. Use an
   `aria-live="assertive"` region for errors and `polite` for info (coordinate with Feature 48).
2. **Classify store calls**: in `data-store.js`, separate **writes** (create/update/delete/save) from
   **reads**. On a write failure, reject or return a typed error and raise an error toast; reads may keep
   the silent-fallback behavior but should still log.
3. **Propagate from main**: have `safeCall()` return a discriminable error envelope (not a look-alike
   fallback) for write handlers so the renderer can tell success from failure. Keep HTTP execution's
   structured `{status:0, error}` result as-is (that path is already surfaced in the response viewer).
4. **Adopt across components**: replace ad-hoc `console.*`-only error handling on user-initiated actions
   (send, save, import/export, backup/restore, OAuth, theme import) with notifications.

## Acceptance criteria
- A simulated save failure produces a visible, dismissible error notification (not a silent success).
- Reads that fall back still work without nagging the user, but the failure is logged.
- One reusable notification API is used app-wide; no new bespoke error banners.
- Notifications are accessible (announced to screen readers; keyboard-dismissible).

## Constraints
- Plain DOM + class-based ES module; styles in `components.css` using `theme.css` tokens.
- Don't change the read-path degradation contract that existing tests rely on without updating them.
- Keep `main.js`/`preload.js` in sync if any new channel is introduced.

## Verify
`make fmt && make lint && make test`
