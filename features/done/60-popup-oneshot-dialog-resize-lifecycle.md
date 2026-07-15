# Feature 60 — Popup: one-shot dialog resize lifecycle (listener leak + awaiting-caller hang)

> Source: full code review 2026-07-10 (renderer app core grade B+). **Medium: window resize can hang an awaiting caller forever.**

## Context
`PopupManager`'s one-shot dialogs (`confirm`/`notify`/`warn` via `_showOneShotDialog`, ≈251-265) attach a
`document` `keydown` handler (`onKey`) and resolve their promise only through the dialog's own `dismiss()`.
But the window `resize` handler (≈111-114) dismisses whatever is open by calling `PopupManager.close()`
(≈312), which **does not** call `dismiss()`.

## Findings to fix
- **[Medium] Leak + hang.** On a resize while a `confirm`/`notify`/`warn` dialog is open:
  1. the `keydown` (`onKey`) listener added at ≈265 is never removed (it's removed only inside `dismiss()`),
     so it **leaks**, and a later Escape/Enter fires a stale `onDismiss` and reassigns `_activePopup` to a
     stale `prevActivePopup`;
  2. because `onConfirm`/`onCancel` run only through `dismiss()`, an awaiting caller — e.g.
     `_askKeepWsAlive` (`app.js` ≈832, awaited inside the `hippo:request-selected` handler) — **never
     settles**, so that selection's pane/timeline updates never run.
  `confirmClose` is unaffected (resize calls `_closeConfirmIfOpen`, which cleans up); only the
  `_showOneShotDialog` family is exposed.

## Goal
Resizing the window while a one-shot dialog is open resolves it cleanly (as a cancel/dismiss), removes its
listeners, and never strands an `await`.

## Implementation steps
1. Make the `resize` path route one-shot dialogs through their `dismiss()` (cancel semantics) instead of the
   bare `PopupManager.close()` — e.g. track the active one-shot's `dismiss` and invoke it, mirroring how
   `_closeConfirmIfOpen` already handles `confirmClose`.
2. Guarantee the `onKey` `keydown` listener is removed on *every* teardown path (resize, mask click, Escape,
   programmatic close) — pair add/remove or register a `once` `hippo:popup-closed` cleanup.
3. Ensure the dialog promise always settles exactly once (cancel) when torn down by resize.

## Acceptance criteria
- Open a `confirm`/`notify`/`warn`, resize the window: the dialog closes, its promise resolves (cancel), and
  no orphan `document` `keydown` listener remains (verify no stale `onDismiss` fires on a later Escape).
- The WS "keep alive?" prompt (`_askKeepWsAlive`) resolves on resize so the subsequent request selection
  completes.
- `make test-components` green (add a regression test for resize-dismisses-and-resolves).

## Constraints
- Keep the balanced popup-mask depth counting and the `hippo:popup-opened`/`-closed` pairing intact.
- Don't change the app-lifetime singletons' permanent listeners.

## Verify
`make test-components && make test`; then `make debug`: trigger a confirm dialog, resize, and confirm the app
stays responsive and the promise resolved.
