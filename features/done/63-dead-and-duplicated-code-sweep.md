# Feature 63 — Dead & duplicated code sweep

> Source: full code review 2026-07-10 (cross-cutting; the "redundant code" concern). Low risk, high tidiness — each item is independently verifiable as unused/duplicated.

## Context
Several files, exports, shortcuts, and code blocks are dead or copy-pasted, mostly residue from earlier
refactors (collection-variables removal, pill-builder unification, HeadersEditor extraction). Removing them
cuts maintenance surface and drift risk.

## Findings to fix
- **[Medium] `components/variables-popup.js` — entire 343-line file is dead.** Never imported or `new`-ed
  anywhere (`grep -rn "VariablesPopup\|variables-popup" src/web` returns only stale doc comments). Its role is
  covered by `CollectionsPopup`'s Environments tab and `vars-editor.js`. Delete the file and its test, and
  **correct `CLAUDE.md`**, which still lists `VariablesPopup` as a live app-created editor popup (in the
  Component↔App Communication and Popups sections).
- **[Medium] `request-editor.js` `#buildHeaderRow` (~150 lines, ≈1990-2155) duplicates
  `HeadersEditor.#buildRow` (`headers-editor.js` ≈347-492).** Near-verbatim (name combo, value pill,
  multi-value comma suggestions, capture-phase keydown nav, blur `scheduleHide`); only field names differ.
  `HeadersEditor` exists to be the shared Headers surface (`collections-popup.js` uses it) but the request
  editor never adopts it. Adopt `HeadersEditor` (or extract the row builder both call), so a suggestion-logic
  fix reaches both.
- **[Low] One-line pass-through wrappers to `kv-editor-shared`.** `request-editor.js` `#buildKvRow`,
  `#wireDeleteAllConfirm`, `#kvRowsToText`, `#headerRowsToText`, `#textToKvRows`, `#textToHeaderRows`,
  `#buildToolbarToggle`, `#disposePillEditors` (≈2580-2609, 1693, 1960-1962) and `body-editor.js` (≈220-243)
  just call the already-imported shared functions. Call the imports directly. Also `HeadersEditor.#applyBulkMode`
  (≈279-291) re-hand-rolls the shared `applyBulkMode` (keep only the local spacer/label-hide bit).
- **[Low] Dead exports from the collection-variables refactor.** `data-store.js` `setActiveVariables` (≈625)
  and `saveCollectionVariables` (≈736) have no non-test renderer callers (the latter survives only in a
  comment at `app.js` ≈3217). Remove.
- **[Low] Dead / duplicated keyboard shortcuts.** `keymap.js` advertises `import` (⇧⌘I) with no handler
  anywhere (≈265-268); `app.js` (≈3952-3953) maps both `editEnvironment` (⌘E) and `collectionVariables`
  (⇧⌘E) to the identical `openCollectionsEditor("env")` (and the adjacent comment wrongly says "⌥/Alt");
  `userGuide` (⌘/) is marked display-only but is a real menu accelerator in `main.js` (≈2364) — mark it
  `menuOwned: true`. Reconcile the cheat sheet with reality.
- **[Low] OAuth dead surface.** `oauth-executor.js` `injectBearerToken()` (≈206) has no callers (the send
  path builds the header inline at `request-editor.js` ≈2987); `token-store.js` diagnostics `isValid`/`keys`/
  `TokenEntry.isExpired`/`toDisplayInfo`/`clearAll` are unused in product code; auth-code grant reads
  `config.prompt`/`loginHint`/`acrValues`/`responseMode`/`nonce` (`authorization-code.js` ≈91-99) that have no
  UI field/bulk key/default → permanently `undefined`. Remove the dead branches or note them as reserved.
  (Note: `config.state` is treated in Feature 64, not here.)
- **[Low] Import helper duplication.** `import/curl.js` (≈179-188) and `import/har.js` (≈53-62)
  `requestName(method, url)` are byte-identical; the mime→`bodyType` sniff is re-implemented in
  `curl.bodyFromData`, `har.bodyFromPostData`, and `insomnia.parseBody`. Hoist a `requestName` +
  `rawBodyFromMime` into `import/shape.js` (which already owns the builders).
- **[Low] Main-process catalog-resolution duplication.** `main.js` `initEditContextMenuIPC` (≈406-413)
  re-implements the exact `loadCatalog({...})` + `i18nLabel` resolution that the `activeLabels()` helper
  (≈265) already encapsulates and every other dialog/menu uses; the same manifest-theme + scheme-guard block
  recurs in `showThemeEditor` / `showDocsWindow`. Call `activeLabels()` / a shared helper instead.
- **[Low] Pill caret/insertion logic duplicated between the two editors.** `pill-code-editor.js`
  `#convertAtCaret` (≈1078) / `#insertToken` (≈1199) and `variable-pill-editor.js` `#tryConvertAtCaret`
  (≈465) / `insertToken` (≈236) are near-identical `{{…}}`-before-caret detection + token insertion; and
  `variable-pill-editor.js` `#rawTextFromFragment` (≈707) reimplements `serializeEditor`
  (`variable-resolver.js` ≈273) used everywhere else. Pill *construction* was unified into `pill-builders.js`;
  unify the caret/insertion + serialization the same way so the copies can't drift.
- **[Low] Tree insertion boilerplate repeats 5×.** `tree-view.js` `#addCollection`/`#addFolderTo`/
  `#addFolderAfter`/`#addRequestTo`/`#addRequestAfter` (≈1215-1376) repeat build-node → `collapsedIds.delete`
  + `saveCollapsedState` → `insertChild`/`insertNodeAfter` → `#rerender` → `#emitChange` → select boilerplate,
  and the `{ type:"collection", name:"New Folder", children:[] }` literal appears 3× (see also Feature 65 for
  the i18n leak). Extract a `#insertAndReveal(node, mode)` helper. Also `updateNode`'s `silent=false` branch
  (≈2687) is effectively dead — every caller passes `{ silent:true }` — so its full-tree re-persist default is
  a latent footgun; document or drop it.
- **[Low] Stale doc/comment fixes.** `app.js` ≈2668 comment says `_queueSaveCollections`; the real function
  is `_queueSaveTree` (≈2623). `variable-resolver.js` JSDoc (≈219, 385) and `secret-storage.js` (≈210-218
  orphaned JSDoc over `_warnedUnavailable`) reference a `collection` scope / duplicate a doc block that no
  longer match the code. `ipc/store.js` (≈143-149) comment says `store:requests:update` is unused, but it *is*
  (`data-store.js` ≈591); only `store:requests:create` is genuinely dead (drop the handler + its preload
  method).

## Goal
Delete provably-dead code and collapse the duplications so each behavior has a single home; fix the docs that
describe removed things (including CLAUDE.md).

## Implementation steps
1. Delete `variables-popup.js` + its test; update CLAUDE.md's editor-popup and Popups sections.
2. Adopt `HeadersEditor` in the request editor (or extract a shared row builder); delete `#buildHeaderRow`.
3. Inline the pass-through wrappers; drop the redundant `#applyBulkMode` hand-roll.
4. Remove the dead `data-store.js` exports and the dead `store:requests:create` handler + preload method.
5. Reconcile `keymap.js` / `app.js` shortcuts (remove dead `import`, de-dup ⌘E/⇧⌘E or give them distinct
   actions, mark `userGuide` `menuOwned`).
6. Trim the OAuth dead surface (or annotate as reserved).
7. Hoist `requestName` + `rawBodyFromMime` into `import/shape.js`.
8. Fix the stale comments/JSDoc listed above.

## Acceptance criteria
- No remaining reference to `VariablesPopup`/`variables-popup` outside history; CLAUDE.md no longer lists it.
- Headers behave identically in the request editor and Collections popup, from one code path.
- `make lint` (unused-var/import rules) and `make test` green; the `no-hardcoded-strings` and i18n baselines
  unchanged; CI's license-header/i18n gates pass.

## Constraints
- Removing a file drops its license-header/i18n obligations — fine, but confirm the guard `ROOTS`/baselines
  don't reference it.
- Don't remove anything still consumed by the `tests/` suites (verify each "unused" export against tests
  first — e.g. several `net/` exports are used only by sibling tests and are **not** dead).

## Verify
`make lint && make test`. Grep to confirm each deleted symbol has zero remaining references.
