# Feature 46 — Per-request history diffing

## Context
History already persists **full response payloads per execution** (headers, cookies, body, console) split
across `history/<reqId>/<histId>.json` and `responses/<reqId>/<histId>.json`
(`src/app/store/history-store.js`). But the Timeline only ever **restores a single entry**
(`hippo:timeline-select`, `src/web/scripts/app.js` ~1076-1105) — there is no compare/diff. The data needed
to diff two runs is already on disk; this is a high-value, low-cost addition. (Separately, the large-body
`bodyRef` is session-scoped and reaped on restart — `app.js` ~800-807 — so a big historical body becomes a
256 KB preview after relaunch.)

## Goal
Let users select two history entries for a request and see a diff of status, headers, and body, to spot
regressions and changes over time.

## Implementation steps
1. **Selection**: in the Timeline, allow picking two entries (e.g. "compare with…"). Load both response
   payloads via the existing lazy `getHistoryResponse`.
2. **Diff view**: render side-by-side or inline diffs of status/headers/body. Pretty-print and align JSON
   before diffing (reuse the viewer's existing pretty-printers) so structural changes read cleanly. Use a
   small diff routine or a vetted lightweight diff lib (justify any dep).
3. **Body availability**: diff the persisted body; where only a truncated preview survives (large bodies
   post-restart), clearly label "diff of preview only." Consider persisting larger bodies (or making
   retention configurable) so more history is diffable across restarts.
4. **Affordances**: highlight added/removed/changed lines with `theme.css` status tokens; allow copying the
   diff.

## Acceptance criteria
- A user can pick two runs of a request and see status/header/body differences highlighted.
- JSON bodies are normalized before diffing so key-order noise doesn't dominate.
- Truncated-body cases are labeled, not silently misleading.
- Diffing never mutates the stored history entries.

## Constraints
- Reuse existing history load paths and viewer pretty-printers; don't duplicate rendering logic.
- Plain DOM + class-based ES module; CSS tokens from `theme.css`, styles in `components.css`.
- Any change to persisted body retention must stay back-compatible (coordinate with schema versioning).

## Verify
`make fmt && make lint && make test`
