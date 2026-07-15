# Design 05 — Standardize main-process error conventions

## Context
The main process discriminates errors three different ways:
- `.code` — `io.js` `validateID` (`io.js:275,279`), `notFoundError` (`io.js:300`),
  `resolver.js:34`, `backup.js:354` (`INVALID_BACKUP`).
- `.reason` — `crypto.js` `DecryptError` (`crypto.js:49`) and `PasswordError`
  (`crypto.js:435`).
- `.name` — HTTP result errors in `main.js` (`main.js:503,782,1122`) and `retry.js:78`.

The `backup:import` handler has to check **both** conventions in one catch block:
`err.reason === "bad-password"` and `err.code === "INVALID_BACKUP"` (`main.js:2556,2562`).

Failures are also **returned** three ways:
- throw — every `*-store.js` method (`request-store.js:85`, `tree-store.js:82`, …).
- `{ error: {...} }` — `http:execute` / `http:body:get` (`main.js:494-504,1372-1388`);
  `functions:invoke` even returns a bare **string** error (`main.js:1876,1903,1906`).
- `{ ok: false, reason }` — WebSocket hub (`websocket.js:236,272,288`) and
  `http:body:save` (`main.js:1396,1407`).

## Goal
One documented convention for how main-process errors advertise their kind, and a small
fixed set of failure-return shapes with a clear rule for which to use.

## Implementation steps
1. **Error tagging:** standardize on a single discriminator field (`.code` is already the
   most widespread). Give `DecryptError`/`PasswordError` a `.code` (keep `.reason` as an
   alias only if needed for back-compat), and ensure HTTP/`retry` error classification can
   key off `.code` too. Update the `backup:import` catch to check one field.
2. **Return shapes:** document the rule — storage/throwing operations stay throw-based and
   are wrapped by `safeCall`/`safeCallWrite`; streaming/long-running operations
   (ws, body save) use `{ ok, reason }`. Pick one and apply it; do not leave three.
3. Fix the `functions:invoke` outlier to return the same structured `{ name, message }`
   error object the rest of the HTTP path uses, not a bare string.
4. Add or extend a small unit test asserting the chosen error shape for one example of
   each category (crypto decrypt failure, not-found, ws send failure).

## Acceptance criteria
- A single discriminator field identifies error kind across io/crypto/backup/http/retry.
- The `backup:import` catch checks one field, not two.
- `functions:invoke` returns the structured error shape, not a string.
- The convention is documented (a comment near the wrappers in `main.js`, or a short note
  in `io.js`).

## Constraints
- Behavior-preserving for the renderer's user-facing messages.
- Keep `main.js`/`preload.js` in sync if any error envelope crossing IPC changes shape.

## Verify
`make fmt && make lint && make test`
