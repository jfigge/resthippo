# Design 14 — One private-field convention (`#private`)

## Context
18 component files use `#private` fields exclusively. The two largest files mix `#private`
with `this._underscore`:
- `request-editor.js` uses `#el`, `#method`, … but `this._sendBtn`, `this._methodSel`,
  `this._tabStrip`, `this._urlInput` (`request-editor.js:574,800-805`).
- `response-viewer.js` does the same — `this._statusBar`, `this._tabStrip`,
  `this._tabContent` (`response-viewer.js:543,663,701`).

These two files are the only ones using underscore fields at all, so the convention is
"`#private` everywhere except the two biggest components."

## Goal
A single private-field convention (`#private`) across all components.

## Implementation steps
1. In `request-editor.js` and `response-viewer.js`, convert every `this._foo` field to a
   `#foo` private field: declare it in the class body and replace all reads/writes.
2. Watch for name collisions (e.g. a `#tabStrip` private vs an existing one) and for any
   place that relies on the field being enumerable/externally reachable — `#private` is not
   accessible outside the class, so confirm nothing (including tests) reads `instance._foo`.
3. If a test reaches into `_underscore` internals, update it to test behavior instead, or
   expose a minimal accessor.

## Acceptance criteria
- No `this._` instance fields remain in `request-editor.js` or `response-viewer.js`.
- All component fields use `#private`.
- request-editor and response-viewer tests pass unchanged in behavior.

## Constraints
- Pure rename refactor; no behavior change.
- Do not widen visibility (don't convert privates to public to satisfy a test — fix the
  test).

## Verify
`make fmt && make lint && make test`
