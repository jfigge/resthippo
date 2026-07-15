# Design 01 — Route authoritative writes through `safeCallWrite`

## Context
`src/app/main.js` defines two IPC wrappers (`main.js:106-134`):
- `safeCall` — on failure returns a look-alike fallback value the renderer **cannot
  distinguish from success**.
- `safeCallWrite` — on failure returns a `{ __hippoError: true, ... }` envelope so the
  renderer can surface a save-failure (toast/modal).

Only two write handlers use `safeCallWrite`:
- `store:manifest:save` (`main.js:151`)
- `store:env:save` (`main.js:178`)

Every other **authoritative** mutating handler still uses the silent `safeCall`, so a
failed write is reported to the UI as success:
- `store:tree:save` (`main.js:194`)
- `store:environments:save` (`main.js:287`)
- `store:cookies:upsert` / `store:cookies:delete` / `store:cookies:clear` (`main.js:305,311,317`)

(Genuinely best-effort handlers such as `store:requests:delete` and the `store:history:*`
handlers are intentionally silent — see their inline comments — and should stay on `safeCall`.)

## Goal
Every authoritative persistence write reports failure to the renderer through the same
`safeCallWrite` envelope, and the renderer surfaces those failures consistently.

## Implementation steps
1. Switch `store:tree:save`, `store:environments:save`, and the three `store:cookies:*`
   mutating handlers to `safeCallWrite` in `main.js`. Leave deliberately best-effort
   handlers on `safeCall` and add a one-line comment on each explaining why it stays.
2. Audit the remaining `safeCall` write handlers and classify each as authoritative
   (→ `safeCallWrite`) or best-effort (stays, with a comment). Document the rule near the
   wrapper definitions (`main.js:106-134`) so future handlers pick the right one.
3. In the renderer, ensure the call sites for these writes already detect `__hippoError`
   and surface it via the standard notification path (Feature 26 / `Notifications` /
   `PopupManager.notify`). Mirror how the manifest/env save callers handle it today; add
   handling where missing.
4. Keep `preload.js` exposure unchanged (the envelope passes through transparently).

## Acceptance criteria
- A simulated write failure on tree, environments, or cookies returns a `__hippoError`
  envelope and produces a visible save-failure notification in the renderer.
- Best-effort handlers remain silent by design and each carries a justifying comment.
- A short test (or extension of an existing store/IPC test) covers the new envelope path
  for at least one converted handler.

## Constraints
- Behavior change is intentional and limited to error reporting; the success path is
  unchanged.
- Keep `main.js`/`preload.js` in sync.

## Verify
`make fmt && make lint && make test`
