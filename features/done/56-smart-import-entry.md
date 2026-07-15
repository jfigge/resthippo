# Feature 56 — Smart import entry (Collections dialog: URL, file, or Browse)

## Context
The Collections dialog has an **Export** icon button in its sidebar toolbar
(`src/web/scripts/components/collections-popup.js`, `.coll-sidebar-toolbar` in
`#build()`, ~line 381) but **no matching Import affordance** — importing is only
reachable from three separate File-menu items ("Import Collection…", "Import from
cURL…", "Import from URL…"). Users expect an Import button next to Export.

The existing **Import from URL** modal (`components/url-import-modal.js`, opened
via `menu-handlers.js` → `UrlImportModal.open(ctx.handleUrlImport)`) already
fetches any supported interchange doc through the main-process request engine (no
CORS) and runs it through the shared inspect → parse → apply tail
(`_importInspectedContent` in `app.js`). File import
(`handleImport` in `app.js`) uses the native OS picker
(`import:file:open` IPC → `{ filename, content }`) and the same tail. Every parser
lives under `src/web/scripts/import/` (Postman / Insomnia v3–v5 / OpenAPI 3 /
Swagger 2 / HAR / native Rest Hippo archive; cURL is paste-only). Format
auto-detection is `detectFormat`/`inspectImport` in `import/index.js`.

**Hard constraint:** the renderer is sandboxed and **cannot read a file path
typed into a text box** — file bytes only reach it via the native picker. So a
"type a URL *or* a file path" field needs a new main-process IPC to read a typed
path, plus a Browse fallback (the only route that works in the Mac App Store
sandbox, mirroring how `import:files:check` returns `[]` under `isMas()`).

## Goal
Add an **Import** icon button next to Export in the Collections dialog. Clicking
it opens the (generalized) Import modal whose **single field routes on input**:
a URL runs the existing URL-fetch import; a local file path runs the existing
file import. The modal **title updates live** — "Import from URL" ⇄ "Import from
file" — and a **Browse…** button opens the native picker as a fallback.

## Design decisions (settled — do not relitigate)
- **File branch = typed path + Browse** (user choice). A new
  `import:file:read(path)` IPC reads a typed absolute path; a **Browse…** button
  opens the existing native picker. The typed-path read degrades to `null` under
  MAS and for any unreadable path, so Browse is always the safe fallback.
- **Generalize the existing `UrlImportModal` in place** (keep the class/filename;
  a rename to `ImportModal` is optional polish, not required). The Collections
  button and the File ▸ "Import from URL" menu item **share one handler** by
  dispatching the existing `hippo:import-url-requested` event — mirroring how the
  popup's Export button reuses `hippo:export-all-requested`.
- **Reuse every existing importer and the shared tail** (`inspectImport`,
  `parseImport`, `_importInspectedContent`, `applyImportedCollection`). This
  feature adds an entry point + a URL/path detection layer only — no new parser.
- **No extra sources folded in now.** The smart field is the natural home for
  more, but they are explicitly **deferred** (see Constraints): raw JSON/YAML
  paste, cURL-command paste (consolidating the separate cURL modal), and a
  GraphQL-introspection → collection importer (larger; introspection code exists
  in `components/graphql-body-editor.js` but is not wired to import).

## Implementation steps
1. **Icon.** Add an `upload` glyph (tray + up arrow) to `src/web/scripts/icons.js`
   next to the existing `download` icon.
2. **Collections button.** In `collections-popup.js`: add
   `const ICON_IMPORT = icon("upload", { size: 15 });`; insert an Import button
   `class="icon-btn coll-import-btn"` immediately after the export-all button in
   `.coll-sidebar-toolbar`; add an `#onImport` constructor callback (mirroring
   `#onExportAll`) and wire its click. In `app.js` (next to the `onExportAll`
   wiring), set `onImport: () => window.dispatchEvent(new
   CustomEvent("hippo:import-url-requested"))`.
3. **CSS.** Add `.coll-import-btn` to the toolbar pointer-cursor selector list in
   `src/web/styles/components.css` (alongside `.coll-new-btn`,
   `.coll-export-all-btn`).
4. **Generalize the modal** (`url-import-modal.js`):
   - `open({ onImport, onImportFile, onBrowse })` (was a single positional arg).
   - `#detectMode(value)` → `'url' | 'file'`: `^https?://` → url; path-shaped
     (absolute `^/`, home `~/`, relative `./`/`../`, Windows drive `C:\`, UNC
     `\\`, **or** ends `.json`/`.yaml`/`.yml`/`.har`) → file; empty/ambiguous →
     url (keeps current title).
   - On `input`, recompute mode and update **both** `.popup-title` textContent and
     the dialog `aria-label` (`urlImport.title` vs new `urlImport.titleFile`); hide
     the auth-header field in file mode (native `hidden` attribute — no bare state
     class).
   - `#submit()` routes: file → skip the http-scheme check, call
     `onImportFile(path)`; url → unchanged (`onImport(url, header)`).
   - Add a **Browse…** button → `onBrowse()`; close on a `true` return.
   - Soften the intro/label copy to say "a URL or a local file path".
5. **Renderer handlers** (`app.js`): extract the archive-detect + inspect tail of
   `handleImport` into `_importFromContent(content)`. Add
   `handleFilePathImport(path)` (desktop-guard → `window.hippo.import.file.read` →
   error `urlImport.errPath` on `null` → `_importFromContent`) and
   `handleImportBrowse()` (the native-picker body of `handleImport`, returning
   `true` on success). Pass all three handlers into the `menu-handlers.js` ctx.
6. **Modal wiring** (`event-bus/menu-handlers.js`): `hippo:import-url-requested`
   → `UrlImportModal.open({ onImport: ctx.handleUrlImport, onImportFile:
   ctx.handleFilePathImport, onBrowse: ctx.handleImportBrowse })`.
7. **New IPC** — keep `main.js`/`preload.js` in sync:
   `ipcMain.handle("import:file:read", (…, filePath) => …)` in `src/app/main.js`
   after `import:file:open` — return `null` under `isMas()`, for a non-string/empty
   path, or a path that isn't a readable file; else `{ filename, content }`. Expose
   `read: (filePath) => ipcRenderer.invoke("import:file:read", filePath)` under
   `import.file` in `src/app/preload.js`.
8. **i18n** — add and translate into all 7 catalogs (`en` + de/es/fr/it/ja/zh):
   `collections.import` ("Import collection"), `urlImport.titleFile` ("Import from
   file"), `urlImport.browse` ("Browse…"), `urlImport.errPath` ("Couldn't read
   that file — check the path."), and the reworded `urlImport.intro`. All strings
   via `t()`; keep the no-hardcoded-strings baseline empty.
9. **User guide** — update `src/web/docs/import-export-and-backup.md` to document
   the Collections-dialog Import button, the URL-or-path field, and Browse.
10. **Headers** — the Apache-2.0 header is already present on every touched
    first-party file; keep it (`make license-headers` if any new file is added).

## Acceptance criteria
- An **Import** icon button appears next to Export in the Collections sidebar
  toolbar; clicking it opens the import modal titled "Import from URL".
- Typing a URL keeps the "Import from URL" title and imports via the existing
  fetch path (Postman/Insomnia/OpenAPI/Swagger/HAR).
- Typing a file path flips the title to "Import from file", hides the auth-header
  field, and imports the file via the new `import:file:read` IPC.
- **Browse…** opens the native picker and imports the chosen file; an unreadable
  typed path shows an inline error and keeps the modal open.
- File ▸ "Import from URL" opens the same generalized modal.
- All new strings localized into all 7 locales; the user guide covers the new
  button; `make test` is green (i18n completeness, no-hardcoded-strings, license
  headers, unit tests).

## Constraints
- No framework; plain DOM + class-based ES modules. Reuse `PopupManager`, the
  existing importers, `inspectImport`/`parseImport`/`_importInspectedContent`,
  and the native picker — don't reimplement.
- Native filesystem/HTTP stays in **main**; renderer talks only via
  `window.hippo.*`. Keep `main.js`/`preload.js` in lockstep for the new IPC.
- CSS via `theme.css` tokens; class naming per CLAUDE.md (`prefix-name` elements,
  `block--modifier` state — no bare state classes).
- **Deferred (out of scope):** raw JSON/YAML paste, cURL-command paste
  (consolidating the separate cURL modal), and GraphQL-introspection → collection
  import. Each is a small follow-on decision; ship URL + file + Browse first.

## Verify
`make fmt && make lint && make test`, then in `make debug`: open the Collections
dialog and confirm the Import button sits next to Export; open it and check the
title flips between "Import from URL" (type a spec URL, e.g. the mock server at
`http://localhost:8888/…`) and "Import from file" (type an absolute
`.json`/`.yaml`/`.har` path); confirm a typed path imports, Browse… imports via
the native picker, a bad path shows the inline error, and File ▸ "Import from URL"
still opens the same modal.
