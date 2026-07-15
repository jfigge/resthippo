# Design 09 — Standardize component-to-app communication

## Context
Renderer components talk to the rest of the app two ways, with no principled boundary:
- **Global custom events** — `window.dispatchEvent(new CustomEvent("hippo:…"))`. Used by the
  big panels: `tree-view.js` (15+ events: `hippo:request-open`, `hippo:collections-changed`,
  …), `request-editor.js`, `response-viewer.js`, and `variables-popup.js`
  (`hippo:vars-save`).
- **Constructor callbacks** — `onSelect`/`onChange`/`onChoose`: `pill-picker.js:38`,
  `layout-picker.js:83`, `env-picker.js:31`, `export-modal.js:49`,
  `graphql-schema-viewer.js:25`.

The split isn't principled: `LayoutPicker` uses a callback while the structurally similar
`VariablesPopup` ("edit, then notify the app") uses a `hippo:vars-save` event.

## Goal
A documented rule for when a component uses a constructor callback vs. a global `hippo:*`
event, applied consistently, so the same kind of interaction uses the same mechanism.

## Implementation steps
1. Define the rule (recommended): **constructor callbacks** for ephemeral, locally-owned
   child widgets whose parent created them (pickers, modals returning a value); **global
   `hippo:*` events** for app-wide state changes that arbitrary panels may react to
   (collections changed, request opened). Write it into `CLAUDE.md` or a short comment in
   `app.js`.
2. Inventory every `dispatchEvent(new CustomEvent("hippo:…"))` and every constructor
   callback against the rule. Produce the list of mismatches first.
3. Migrate the mismatches. The clearest is `VariablesPopup`'s `hippo:vars-save` — it is a
   parent-owned popup returning a value, so it should use a callback like the other
   popups, unless multiple unrelated listeners genuinely depend on the event (verify by
   grepping for `hippo:vars-save` listeners first).
4. Keep a single registry/comment listing the `hippo:*` event names and their payloads so
   the global channel stays discoverable.

## Acceptance criteria
- A written rule exists and every component follows it.
- No callback-vs-event mismatch remains for the same interaction kind.
- All renderer e2e tests pass; event-driven flows behave identically.

## Constraints
- Behavior-preserving; this is a wiring refactor.
- Plain DOM `CustomEvent`/callbacks only — no event-bus library.

## Verify
`make fmt && make lint && make test`
