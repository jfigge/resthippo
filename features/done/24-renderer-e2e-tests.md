# Feature 24 — Renderer integration / E2E tests (IPC bridge + request→response cycle)

## Context
Feature 20 added pure-logic tests (variable resolution, import/export, HTTP
execution) and **explicitly deferred full DOM/E2E coverage**. The renderer tier
remains untested: ~17k lines across `src/web/scripts/` — including the IPC bridge
`data-store.js`, `app.js` orchestration, and the editor/viewer/tree components —
have no tests. The two highest-value gaps are:
- **`src/web/scripts/data-store.js`** — every persistence call from the renderer
  routes through this bridge to `window.hippo.*` (exposed by `preload.js`). An
  untested bridge means IPC desync and silent save failures are invisible.
- **The request→response cycle** — selecting/editing a request, executing it, and
  rendering the response is the core loop and has no end-to-end assertion.

## Goal
Add integration tests for the renderer's IPC bridge and an end-to-end test of the
request→response cycle, runnable headlessly under `make test`.

## Implementation steps
1. **`data-store.js` integration tests** (start here, cheapest): drive the bridge
   against a mock `window.hippo` (mirror the `window.hippo` mock pattern already used
   in `src/web/scripts/auth/tests/oauth.test.js`). Assert that each method maps to
   the correct IPC channel with the right arguments, surfaces returned data, and
   propagates/handles errors rather than swallowing them. Cover create/read/update/
   delete for collections, requests, environments, and history.
2. **request→response cycle E2E**: with the renderer components instantiated in a
   DOM (use a lightweight DOM such as the one Node provides, or a minimal stub if
   jsdom is out of scope — keep it dependency-light and justify any new dep),
   simulate: select a request → edit method/URL/headers/body → trigger execute →
   assert the built payload sent over the (mocked) IPC matches, then feed a mock
   response back and assert `ResponseViewer` renders status/headers/body.
3. **Wire-up**: add a `test-renderer-e2e` target to the `Makefile` and include it
   in the aggregate `test` target, matching the existing per-area target pattern.
4. Keep fixtures small and deterministic; reuse the mock server only if a real HTTP
   round-trip adds value over the IPC mock.

## Acceptance criteria
- `data-store.js` has tests asserting correct IPC channel + argument mapping and
  error propagation for the main CRUD paths.
- One end-to-end test exercises edit → execute → render without a real network or
  a running Electron main process.
- New tests run under `make test` and pass headlessly (no display required).

## Constraints
- Use the existing `node --test` runner; avoid a heavy framework (no Jest). If a
  DOM is required, prefer the lightest option and justify the dependency.
- Mock `window.hippo` / IPC — do not spawn a real Electron process.
- Keep tests deterministic (no real network).
- Coordinates with Feature 20 (do not duplicate its pure-logic coverage).

## Verify
`make fmt && make lint && make test`
