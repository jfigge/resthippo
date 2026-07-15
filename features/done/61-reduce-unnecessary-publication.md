# Feature 61 — Reduce unnecessary publication (debounce/guard broadcasts, writes & re-renders)

> Source: full code review 2026-07-10 (cross-cutting; app core / settings / response / pill / storage). The "unnecessary publication" concern, consolidated. Mostly Medium/Low; individually cheap.

## Context
Several paths fire full persistence writes, `hippo:*` broadcasts, or full re-renders far more often than the
underlying state actually changes. None are correctness bugs, but together they cause per-keystroke disk I/O,
redundant whole-app re-applies, and avoidable reflow.

## Findings to fix
- **[Medium] Settings persist on every keystroke.** `settings-popup.js` ≈720-726 wires text/number/textarea
  controls on `"input"`; each keystroke dispatches a full `hippo:settings-changed` with the whole
  `#readValues()` object → `settings-handlers.js` ≈43 → `updateSettings` → `saveSettings` →
  `_persistManifest` (a full, **undebounced** manifest disk write) **and** `applySettings(getSettings())`
  (re-applies theme — tears down/rebuilds the `#resthippo-custom-theme` `<style>` — font vars, layout,
  re-broadcast to every panel). Typing a 30-char proxy URL = 30 full writes + 30 whole-app re-applies. Debounce
  the emit (the repo's unused `utils/debounce.js`) and/or dedup against the last-saved values.
- **[Low] Closing Settings unchanged still saves + sweeps history.** `settings-popup.js` ≈769-779 emits
  `hippo:settings-changed` (full save) **and** `hippo:history-trim` (sweeps on-disk history for every request)
  even when nothing was edited. Guard on a real diff / dirty flag.
- **[Medium] `hippo:layout-changed` broadcast on every font-zoom step.** `app.js` `applyLayout` (≈927-940)
  dispatches unconditionally, and `applySettings` (≈4095) calls `applyLayout(settings.layout)` on *every*
  invocation — including every zoom step (zoom-handlers → `applySettings`) and every theme preview — needlessly
  re-running `RequestEditor.#graphql.onLayoutChanged()`. Guard the dispatch (or the call) on `_currentLayout`
  actually changing.
- **[Low] URL preview resolves even when hidden.** `request-editor.js` `#updateUrlPreview` (≈2439-2449)
  awaits `#buildPreviewUrl()` whenever `#urlPreviewInputEl` exists, regardless of `#urlPreviewEnabled` — so
  every URL/param keystroke runs a full async resolution (variable resolver / response caches) into a
  CSS-hidden input. Early-return when `!#urlPreviewEnabled` (after toggling the hidden class).
- **[Low] `PillCodeEditor` re-scans all pills on every global `selectionchange`.** `pill-code-editor.js`
  `#onSelectionChange` (≈276-282) calls `#syncPillSelection` (≈1238 — `querySelectorAll(".variable-pill")` +
  `comparePoint` over every pill) unconditionally, even for a collapsed caret outside this editor. With
  several editors mounted, moving the caret anywhere iterates all their pills. Add the `if (this.#isFocused)`
  guard `VariablePillEditor` already uses (≈113-118). Also `#syncGutter` (≈1381-1417) reads layout per line on
  every keystroke (forces reflow) while highlight/validation are debounced — debounce the gutter measure too.
- **[Low] Wrap toggle re-renders the whole response body.** `response-viewer.js` `applySettings` wrap branch
  (≈678-687) runs a full `#renderBodyPane` (re-parse/-stringify/-highlight every line) for what is a single
  CSS class flip (`res-body-pre--no-wrap`). Line-number/fold toggles genuinely change DOM; wrap does not —
  flip the class without re-render.
- **[Low] `updater-progress` dispatched with no consumer.** `preload.js:122` dispatches
  `hippo:updater-progress` per download tick, but nothing in the renderer listens (`updater-handlers.js` shows
  no live percentage) and the `app.js` registry (≈1507) documents an event no one reacts to. Drop the
  per-chunk dispatch (and registry entry) or wire a consumer.
- **[Low] `reencryptAll` pass 2 rewrites the entire workspace.** `secret-storage.js` ≈473-481 rewrites every
  `_secretFiles()` entry unconditionally on a mode switch, even files with no secrets / idempotent no-ops
  (and re-reads them after pass 1 already did). Skip files whose re-encrypt produced identical bytes.

## Goal
Each persistence write / `hippo:*` broadcast / expensive re-render fires only when its underlying state
actually changed; per-keystroke work is debounced or guarded.

## Implementation steps
1. Debounce + diff the settings emit (`settings-popup.js`); gate the Close-time save/`history-trim` on a
   dirty flag.
2. Guard `applyLayout`'s dispatch on a real `_currentLayout` change.
3. Early-return `#updateUrlPreview` when the preview is disabled.
4. Add the focus guard to `PillCodeEditor.#onSelectionChange`; debounce `#syncGutter`.
5. Make the wrap toggle a pure class flip.
6. Remove (or wire) the `hippo:updater-progress` per-chunk dispatch and its registry entry.
7. Skip no-op rewrites in `reencryptAll` pass 2.

## Acceptance criteria
- Typing in a Settings field produces at most one debounced save + apply after input settles (verify via a
  write counter / log); opening and closing Settings unchanged writes nothing and doesn't sweep history.
- Font-zoom steps don't emit `hippo:layout-changed`.
- With the URL preview off, editing the URL does no async resolution.
- Moving the caret in the URL bar over a large pill-filled body doesn't iterate other editors' pills.
- Toggling wrap doesn't re-highlight the body.
- `make test` green (update any tests asserting the old emit cadence; the `hippo:*` registry comment stays
  accurate).

## Constraints
- Keep `hippo:settings-changed` as a genuine multi-listener event (several panels consume it) — only reduce
  its *frequency*, don't remove it.
- Don't break the documented `hippo:*` registry in `app.js` — update it in lockstep.

## Verify
`make test`; then `make debug` with a write/emit counter: exercise each path and confirm the reduced cadence.
