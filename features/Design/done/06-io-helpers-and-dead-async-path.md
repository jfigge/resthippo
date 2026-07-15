# Design 06 — Add `io.js` fs helpers; delete the dead async write path

## Context
`src/app/store/io.js` centralizes atomic writes and JSON read/write, but it offers no
`remove` / `listDir` / `exists` helpers, so stores reach around it and reimplement the same
best-effort `try { fs.xxxSync } catch {}` pattern:
- `fs.rmSync` — `collection-store.js:78`, `history-store.js:220,225`, `backup.js:339`.
- `fs.unlinkSync` — `request-store.js:117,196`, `history-store.js:192,197,269,274`,
  `main.js:362,1059,1108,1956`.
- `fs.readdirSync` / `fs.existsSync` / `fs.statSync` — `history-store.js` (many),
  `resolver.js:81-98`, `tree-store.js:81`, `backup.js:257,275`.

Separately, `io.js` ships a **dead** async write path — `atomicWriteAsync` /
`writeJSONAsync` plus the `serialize`/`writeChains` machinery (`io.js:106-165,173`). No
store calls it; every store uses the sync `writeJSON`. So there are two parallel write
implementations and only one is exercised.

## Goal
A single I/O surface: stores delete/scan/check through `io.js` helpers, and `io.js` has no
unused parallel write implementation.

## Implementation steps
1. Add small helpers to `io.js`: `remove(path)` (file or dir, recursive+force,
   best-effort), `listDir(path)` (returns `[]` if missing), and `exists(path)`. Match the
   existing best-effort/error semantics in the call sites they replace.
2. Migrate the direct `fs.rmSync` / `fs.unlinkSync` / `fs.readdirSync` / `fs.existsSync`
   call sites listed above to the new helpers. Leave genuinely special cases (e.g. a
   `statSync` that needs `mtime`) as-is but note why.
3. Delete the dead async write path (`atomicWriteAsync`, `writeJSONAsync`, and the
   `serialize`/`writeChains` machinery) **unless** a caller exists — grep first to confirm
   nothing references them, including tests. If a test references them, decide whether the
   async path should become the standard before deleting.
4. Update `io.js` tests to cover the new helpers.

## Acceptance criteria
- `io.js` exposes `remove` / `listDir` / `exists`, covered by tests.
- The enumerated direct-`fs` call sites in stores now go through `io.js`.
- No dead async write code remains in `io.js` (verified by a grep showing zero callers
  before removal).
- All existing store/integration tests pass.

## Constraints
- Preserve the current best-effort semantics (deletes that currently swallow errors must
  keep doing so).
- All filesystem I/O stays in the main process and flows through `io.js`.

## Verify
`make fmt && make lint && make test`
