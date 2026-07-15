# Feature 65 — Small correctness fixes (i18n leak, edge-case guards, grammar gap)

> Source: full code review 2026-07-10 (assorted subsystems). A grab-bag of independent, low-risk bugs. Each can land alone.

## Findings to fix
- **[Medium] "New Folder" isn't localized.** `tree-view.js` names new folders with the literal
  `name: "New Folder"` in all three creation paths — `#addCollection`, `#addFolderTo`, `#addFolderAfter`
  (≈1224, 1332, 1365) — bypassing `t()`. The correct key already exists (`tree.newCollection`) and is used for
  the top-level-collection branch (≈1240) and the button title. In de/es/fr/it/ja/zh a created folder shows
  "New Folder" in English. The `no-hardcoded-strings` guard misses it (it scans `label|text|title|…`, not
  `name:`). Route all three through `t("tree.newCollection")`.
- **[Low] `pickerDebounceMs` can't be set to 0.** `settings-popup.js` (≈1243-1247)
  `parseInt(...) || 200` coerces a legitimate `0` (the input has `min="0"`) back to the default, so the picker
  debounce can never be disabled. Use `Number.isFinite(parsed) ? parsed : 200` (the sibling `|| 0` fields are
  fine).
- **[Low] Theme import crashes on `{ "vars": null }`.** `theme-editor.js` `importTheme` (≈749-759) guards
  `typeof data.vars !== "object"`, which passes for `null` (`typeof null === "object"`), then `data.vars[key]`
  throws inside an un-caught async click handler → unhandled rejection. Add a truthy/`!== null` check.
- **[Low] Code-gen throws on a null header/param name.** `code-gen/request-model.js` (≈118-125) calls
  `h.name.trim()` / `p.name.trim()` unguarded in the enabled filters, while the disabled filter one line above
  correctly uses `(h.name ?? "").trim()`. A row with a null name throws during code generation. Make the guard
  consistent.
- **[Low] `{`/`}` in a variable value breaks the pill grammar.** `variable-resolver.js` `tokenize`
  (≈242, `/\{\{([^{}]+)\}\}/g`) and `pill-builders.js` `TOKEN_RE` (≈189) have no escape for braces inside
  content/args, so a value like `a}b` in a function-pill arg is silently dropped on commit and re-emitted as
  literal text on reload. Define an escape (or reject/round-trip braces) and document the grammar. (The
  resolver header already notes nested `{{…}}` in args is unsupported — same class of gap.)
- **[Low] Unhandled `unhandledRejection` dialogs stack unbounded.** `main.js` (≈147-155, 2123-2143) fires a
  fresh non-modal `showRejectionDialog` per rejection with no coalescing; a rejection thrown in a loop stacks
  dialogs. Debounce / suppress repeats.
- **[Low] `i18n` `t` shadowed in the request editor.** `request-editor.js` shadows the module `t` with a
  `const t = [...]` (≈3116) and arrow params `(t) => …` (≈2238, 2241, 3348). Harmless today (no `t("…")` in
  those scopes) but a footgun in a `t()`-heavy file — rename the locals to `tpls`/`tok`.
- **[Low] `activeCollectionId` not cleared when an *ancestor* is deleted.** `tree-view.js` `#deleteNode`
  (≈1479) clears `#activeCollectionId` only when it exactly equals the deleted `nodeId`, not when the deleted
  node is its ancestor. Repro: select nested folder B (sets `activeCollectionId=B`), delete B's parent A —
  `activeCollectionId` still points at the now-removed B; a subsequent New Request/Collection then calls
  `insertChild(items, B, …)`, finds no parent, returns the tree unchanged (node silently dropped, no
  feedback), yet `#emitChange` still fires a full re-persist. Validate `#activeCollectionId` against the live
  tree before use.
- **[Low] New request mis-parented when a root request is selected.** `tree-view.js` `#addRequest`
  (≈1260-1265): `findParentId` returns `null` for a root node, and `?? this.#activeCollectionId` coalesces
  that `null` away, so a request created while a root-level request is selected lands inside a folder instead
  of as a root sibling. Distinguish "no parent found" (`undefined`) from "parent is root" (`null`).
- **[Low] PDF-preview singleton state asymmetry (main).** `main.js` window `closed` handler (≈1183-1187)
  resets the HTML-preview singletons but leaves `_pdfPreviewView`/`_pdfPreviewAdded`/`_pdfPreviewPath`
  dangling; if the main window is recreated while another window keeps the app alive,
  `initPdfPreviewIPC._ensureView()` (≈708) reuses a `WebContentsView` bound to the destroyed window (and the
  temp `.pdf` leaks). Reset the PDF state alongside the HTML state. Separately, the PDF view (≈711-722) renders
  an untrusted body in the **default session**, unlike the HTML preview which isolates it via
  `partition:"preview-html"` (≈490-494) — give the PDF view its own partition for consistency.

## Goal
Close each of these independent edge-case bugs; keep every user-facing string localized.

## Implementation steps
Fix each finding in its file per the notes above. For the "New Folder" fix, verify the rendered name is
localized in a non-English locale. For the pill grammar, add a round-trip test (value with `}` survives
edit → save → reload). Rename the shadowed `t` locals.

## Acceptance criteria
- A folder created in a non-English locale gets the localized default name.
- `pickerDebounceMs` accepts and persists `0`.
- Importing `{ "vars": null }` is a clean no-op (no unhandled rejection).
- Code generation with a null-named header/param doesn't throw.
- A variable value containing `}` round-trips through the pill editor.
- `make test-i18n && make test` green; the i18n and `no-hardcoded-strings` baselines stay clean.

## Constraints
- Every new/changed user-facing string goes through `t()` and is translated into all 7 catalogs in the same
  change (CLAUDE.md i18n rule).
- No new dependencies; plain DOM.

## Verify
`make test-i18n && make test`; then `make debug`: create a folder in `de`/`ja` and confirm the localized name;
import a malformed theme; generate code for a request with an empty header row.
