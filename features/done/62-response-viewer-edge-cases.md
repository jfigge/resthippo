# Feature 62 — Response viewer: cross-request bleed & stream/fold edge cases

> Source: full code review 2026-07-10 (response viewer grade A−). No XSS/ReDoS found; these are correctness edges.

## Context
`response-viewer.js` routes almost every lifecycle handler by `requestId` (`isSelected(rid)`), but one handler
can't, and a couple of streaming/fold edges remain.

## Findings to fix
- **[Medium] `captures-applied` badge bleeds across requests.** `response-viewer.js` ≈505-507 handles
  `hippo:captures-applied` and calls `#showCapturedBadge(count)` with **no `isSelected(rid)` guard** — and the
  event (dispatched at `app.js` ≈3007-3011) carries only `{ count }`, no `requestId` to filter on. If request
  A is shown while background request B finishes, A's status bar gets B's "⤓ N captured" badge. Add
  `requestId` to the event payload and guard the handler like every other lifecycle path. (Count-only, so no
  value leak — but a visible wrong-request marker.)
- **[Low] Early terminal stream frame dropped.** `stream-view.js` ≈254-262 gates `onStreamEnd`/`onStreamError`
  on `d.streamId !== this.#streamId`, but a terminal frame arriving while the stream is only *armed*
  (`#streamId` still `null`, id held in `#armedStreamId`) is dropped — leaving the log stuck in "streaming…".
  The arm/buffer machinery exists for early *data* frames but not early *terminal* frames; extend it to
  terminal frames. (Low likelihood — the marker is dispatched at headers-received, before data/end.)
- **[Low] Large styled body highlights synchronously with no cap.** `body-render.js` `renderFoldableCode`
  (≈162-167) falls back for bodies over `MAX_FOLD_LINES` (5000) to `appendCodeBlock` → `Prism.highlight()`
  over the **entire text** on the main thread, bounded only by the spill threshold. A large-but-under-spill
  JSON/XML/HTML body can jank the renderer. Add a size cap on that path (plain text or chunked highlight).
- **[Low] Verify intent: viewing another request aborts an in-flight stream.** Selecting a different request
  reaches `#showLoading`/`#showResponse` → `teardownStream({ abort: true })` (≈2066-2070, 2204;
  `stream-view.js` ≈364-367), which aborts the underlying **network** request in main, not just the view.
  Likely intended (single stream pane) but confirm the abort-vs-hide distinction is wanted.
- **[Low] Two near-duplicate body-render paths.** `#renderFilteredText` (≈1387-1410) duplicates the foldable
  branch of `#renderBodyPane` (build `pre.res-body-pre`, pick `prismLang`, `setFoldReveal(null)`,
  `renderFoldableCode`, `reapplyActiveSearch`). Extract a shared helper so the two can't drift.

## Goal
Response-pane markers and stream state always reflect the *selected* request; large bodies don't hang the
renderer; the two body-render paths share one helper.

## Implementation steps
1. Add `requestId` to the `hippo:captures-applied` payload (`app.js` ≈3007) and guard the handler with
   `isSelected(rid)` (`response-viewer.js` ≈505).
2. Extend `stream-view.js` arm/buffer handling to hold an early terminal frame until the marker is processed.
3. Cap synchronous highlight in `renderFoldableCode`'s fallback (size threshold → plain / chunked).
4. Confirm and document the stream abort-on-select behavior (or switch to hide-without-abort if undesired).
5. Extract the shared foldable body-render helper used by `#renderBodyPane` and `#renderFilteredText`.

## Acceptance criteria
- A background request completing its captures never paints its badge over a different selected request.
- A stream whose end/error races ahead of the marker still reaches a terminal state (no stuck "streaming…").
- A large styled body renders without a long main-thread stall.
- `make test-components` / response tests green.

## Constraints
- Keep the existing frame cap (`STREAM_MAX_FRAMES`) and pending cap (`STREAM_PENDING_CAP`).
- Preserve `textContent`/DOMPurify/Prism routing — no server text into `innerHTML`.

## Verify
`make test`; then `make debug`: fire two requests where the background one has capture rules and confirm no
badge bleed; drive an SSE stream and select away mid-stream.
