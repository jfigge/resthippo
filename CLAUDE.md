# Rest Hippo — Project Guide for Claude

## What This Is

**Rest Hippo** is a cross-platform REST API client desktop application (like Postman/Insomnia) built with Electron, Vanilla JavaScript, and a Node.js storage layer.

**Naming (the project was renamed from "wurl" — don't reintroduce that token):**

- **Display name** → `Rest Hippo` (UI, docs, window titles).
- **Identifier / slug** → `resthippo` (repo `jfigge/resthippo`, folder, appId `com.resthippo.app`, package name, backup filenames).
- **IPC bridge + event namespace** → `hippo`. The renderer↔main bridge is exposed as **`window.hippo`** (not `window.wurl`), and all cross-cutting renderer events are **`hippo:*`** (not `wurl:*`). This is deliberate — the namespace is `hippo`, not `resthippo`.

## Source Directories

All changeable source code lives in:

- `src/app/` — Electron main process (Node.js): window management, IPC handlers, storage layer
- `src/web/` — Frontend renderer (Vanilla JS + CSS): UI components, OAuth, layout
- `src/web/fonts/` — Bundled typefaces (Inter variable font); do **not** load fonts from a CDN
- `Makefile` — Build orchestration (authoritative list of dev/build/test commands)
- `src/package.json` — Node.js dependencies and electron-builder config

Do **not** modify anything under `build/`, `src/node_modules/`, or `src/web/scripts/vendor/` — these hold generated bundles and third-party code. **Exception:** the hand-authored esbuild entry files (`src/web/scripts/vendor/*-entry.js`, e.g. `graphql-entry.js`, `prism-entry.js`, `markdown-entry.js`) _are_ editable source; change them and regenerate the bundle via the matching `make vendor-*` target — never hand-edit the generated `*.js` output.

## Architecture

```
Electron main process (src/app/main.js)
  └── IPC bridge (src/app/preload.js)  →  window.hippo.*
        └── Renderer / UI (src/web/scripts/app.js)
              ├── TreeView
              ├── RequestEditor
              └── ResponseViewer
```

- The main process owns all filesystem I/O and native HTTP execution (no CORS constraints).
- The renderer is sandboxed — it communicates with main exclusively via `window.hippo.*` IPC.
- Storage is file-based under Electron's `userData` path; see `src/app/store/` for layout.

## Key Entry Points

| File                      | Role                                                 |
| ------------------------- | ---------------------------------------------------- |
| `src/app/main.js`         | Electron entry — window lifecycle, IPC registration  |
| `src/app/preload.js`      | IPC bridge exposed to renderer as `window.hippo`     |
| `src/web/scripts/app.js`  | Frontend bootstrap — mounts components, wires events |
| `src/app/store/stores.js` | Storage factory coordinating all store modules       |

## Common Commands

```bash
make install      # Install npm dependencies
make debug        # Run Electron with DevTools + hot-reload (primary dev workflow)
make fmt          # Format JS/CSS/HTML via Prettier
make lint         # Lint JS via ESLint
make test         # Run all tests
make build        # Build Electron app (macOS)
make dist         # Build installers for all platforms
make clean        # Remove build artifacts
```

## Git Workflow

- **Never create a branch unless explicitly told to.** This is a solo project —
  commit directly on the current branch (normally `main`). Do **not** auto-branch
  before committing, even when the change is large.
- Commit and push only when the user asks.

## Tech Stack

- **Frontend**: Vanilla JS (ES2022), plain CSS with custom design tokens
- **Main process**: Node.js, Electron 42
- **Build**: Makefile + npm + electron-builder
- **Linting/Formatting**: ESLint 9 (flat config), Prettier
- **Testing**: Node.js built-in test runner (`node --test`)
- **OAuth**: Custom full OAuth 2.0 implementation with PKCE (`src/web/scripts/auth/`)
- **Syntax highlighting**: Prism.js (bundled via esbuild into `src/web/scripts/vendor/`)

## Coding Conventions

- No framework — plain DOM APIs and CSS. Do not introduce React, Vue, or similar.
- Components are class-based ES modules; follow the pattern in existing files.
- CSS uses custom properties defined in `src/web/styles/theme.css` — use them, don't hardcode colors or sizes.
- **CSS class naming**: one convention, applied to both the CSS selector and the JS that toggles it (keep them in lockstep — a renamed class is a two-file edit):
  - **Elements** → flat, hyphen-delimited `prefix-name` (e.g. `tree-node-row`, `auth-field-label`, `secret-field-input`). **No BEM `__element`** (`__` double-underscore) — do not introduce `block__element`.
  - **State / variant** → BEM modifier `block--modifier` (e.g. `tree-tab--active`, `theme-item--selected`, `settings-row--disabled`, `params-toolbar-toggle-label--hidden`, `secret-field--masked`). **Never** `.is-*` standalone state classes, and **never** a bare state class (`.selected`). The `--` double-hyphen is reserved exclusively for modifiers.
  - **Word usage** stays consistent: `--active` for the current tab / nav-item / toggle button; `--selected` for the chosen item in a list. (CSS custom properties — `--color-*`, `--space-*` — also use `--`; that's a variable namespace, unrelated to class modifiers.)
  - **One sanctioned exception**: `delete-confirm--armed`, the single cross-cutting state utility. `wireDeleteConfirm()` (`delete-confirm.js`) applies it to arbitrary delete controls app-wide, so it has no owning block — the module name acts as the pseudo-block.
- IPC channels are registered in `main.js` and exposed through `preload.js`; keep those two files in sync when adding new IPC calls.
- **Typography**: two font-family variables serve distinct roles:
  - `--font-sans` — the user-selectable UI font (default: Inter, bundled). Changed by the font picker via `applySettings()` in `app.js`, which maps the `fontFamily` setting key to a full CSS stack via `FONT_STACKS`.
  - `--font-ui` — the OS-native typeface for context menus (San Francisco / Segoe UI / system-ui). Set once at startup in `DOMContentLoaded` from `window.hippo.platform`; never driven by user settings. Themes may override it via CSS.
  - Inter is bundled as a variable font (`src/web/fonts/Inter-VariableFont_opsz,wght.ttf`); do not add `@font-face` CDN imports or additional font files without bundling them here.

## No god files (size & single responsibility)

A handful of oversized **"god files"** exist — `app.js` (~5.6k lines),
`components/request-editor.js`, `components/tree-view.js`,
`components/response-viewer.js`, `components/request-auth-editor.js`,
`components/settings-popup.js`, `main.js`, `net/http-engine.js`. They are
**legacy debt, not a pattern to imitate** — their size is exactly what made them
the hardest to test and review (a module-level state singleton reachable only by
reimplementing its bootstrap; a 501-line `#build()`; IPC handler bodies with no
executable coverage). **Do not create new god files, and do not grow the existing
ones.**

Rules for new and changed code:

- **~800 lines for a file, ~80 for a function/method, is a smell** — not a hard
  limit, but a prompt to ask "does this have ONE responsibility?" If a file is
  acquiring a second or third concern, split it before adding the next.
- **Extract a cohesive, importable, tested module instead of appending to a large
  file.** A unit that owns one concern — a state container, an async primitive, a
  builder, a parser — belongs in its own file with a **sibling test**. Follow the
  shape of `utils/coalesce.js`, `components/response-cache.js`, `utils/theme-css.js`,
  `store/io.js`.
- **When you touch a god file, leave it no bigger.** Adding a feature to `app.js`
  or a component? Lift the new logic (and, opportunistically, an adjacent cluster)
  into a module the file imports — don't append another module-level `let` +
  inline function. Every extraction that removes state/logic from a god file is a
  strict improvement.
- **Module-level mutable state is the specific anti-pattern.** State scattered as
  top-level `let` bindings makes a module un-importable and un-testable (why
  `app.js` orchestration still has no direct test). Keep state in a class /
  controller object that a test can construct.
- **A new module must be reachable by a test** — importable under `node --test`
  (pure logic) or jsdom (DOM components), shipping with a sibling test wired into
  the relevant `make test-*` target.
- **Never rewrite an existing god file wholesale in one change.** Dissolve it
  incrementally, extract one cluster at a time, verify each step against the live
  app, and keep `make test` green.

## Component ↔ App Communication

Renderer components talk to the rest of the app two ways. Pick by **who needs to
hear the message**, and apply it consistently — the same kind of interaction must
use the same mechanism:

- **Constructor callbacks** (`new Foo({ onSave, onChange, … })`) — for a
  **parent-owned widget reporting back to the one parent that created it**. The
  widget computes/edits something and hands the result to its creator; no other
  part of the app cares. This covers pickers and modals returning a value
  (`LayoutPicker`, `EnvPicker`, `PillPicker`, `PillEditorPopup`, `ExportModal`,
  `BackupModal`, `wireDeleteConfirm`) **and** the app-created editor surfaces
  (`CollectionsPopup` and the inline `VarsEditor`), whose changes are
  persisted by their creator (`app.js`). Invoke as `this.#onSave?.(payload)` so an
  unwired callback is a harmless no-op.

- **Global `hippo:*` events** (`window.dispatchEvent(new CustomEvent("hippo:…"))`)
  — for **app-wide state changes or notifications that any number of unrelated
  parts may react to**, and for main→renderer broadcasts. Used by the top-level
  panels (`TreeView`, `RequestEditor`, `ResponseViewer`) and for cross-cutting
  coordination: the request lifecycle (`hippo:request-selected/-loading/-error`,
  `hippo:response-received`), UI coordination (`hippo:popup-opened/-closed`), and
  settings/theme/timeline changes. A good test: **more than one independent
  listener, or the listener set is open-ended.** `SettingsPopup` intentionally
  stays on events (`hippo:settings-changed` is consumed by several panels).

Rule of thumb: if the only listener is the component's own creator, use a
callback; if arbitrary panels may listen, use an event. Plain DOM
`CustomEvent`/callbacks only — do not add an event-bus library. The live registry
of `hippo:*` events (names + payloads) lives in a comment block at the top of
`initEventBus()` in `app.js`; keep it current when adding or removing events.

## License headers

The project is licensed under **Apache-2.0** (`LICENSE` + `NOTICE` at the repo
root; `"license": "Apache-2.0"` in `src/package.json`). Every **first-party
source file must begin with the standard Apache 2.0 header comment**, and this is
a **hard requirement enforced by a guard** — treat it like the i18n and
User-Guide rules, applied by hand as you write each file.

- **Scope — what must carry the header**: first-party `*.js` under `src/app/` and
  `src/web/scripts/`, `*.css` under `src/web/styles/`, and the build scripts
  under `scripts/` (`*.mjs`/`*.cjs`/`*.js`). When you add a new file in that
  scope, prepend the header **in the same change**. A file is not "done" until it
  carries the header.
- **Exempt — never stamped**: generated bundles (`src/web/scripts/vendor/`),
  dependencies (`node_modules/`), and non-comment file types (`*.json`, `*.md`,
  `*.html`). The guard already skips these; don't add headers to them.
- **The header** (a block comment, valid in both JS and CSS) — keep the
  `Licensed under the Apache License, Version 2.0` marker line verbatim, since
  the guard detects presence by that substring:
  ```js
  /*
   * Copyright 2026 Jason Figge
   *
   * Licensed under the Apache License, Version 2.0 (the "License");
   * you may not use this file except in compliance with the License.
   * You may obtain a copy of the License at
   *
   *     http://www.apache.org/licenses/LICENSE-2.0
   *
   * Unless required by applicable law or agreed to in writing, software
   * distributed under the License is distributed on an "AS IS" BASIS,
   * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   * See the License for the specific language governing permissions and
   * limitations under the License.
   */
  ```
  It goes at the very top, **after a shebang line** if the file has one.
- **Enforcement (commit requirement)** — the guard
  (`scripts/license-header.mjs --check`) runs as `make test-license-headers`,
  which is part of `make test` (so **CI** fails on a missing header) **and** the
  local **pre-commit** hook (`make fmt lint test-i18n test-license-headers`), so a
  leak fails before the commit/push, not only in CI. (The pre-commit hook lives
  in `.git/hooks/pre-commit`, which is not version-controlled — CI is the shared
  gate; a fresh clone re-adds the hook check by hand.)
- **Auto-fix** — never hand-add headers one by one across many files. Run
  `make license-headers` (alias for `node scripts/license-header.mjs`) to stamp
  every in-scope file missing the header; it preserves shebangs and is
  idempotent. Keep the script's `ROOTS`/`EXCLUDE_DIRS` in lockstep with the scope
  above when directories move.

## Internationalization (i18n)

Every user-facing string goes through the `t()` seam — never hardcode display
text, `placeholder`, `title`, or `aria-label` literals in new code. Treat this as
a **convention you apply by hand**, not a job delegated to the guard test: route
_every_ user string through `t()` as you write it, and translate it into all seven
catalogs in the same change. The `no-hardcoded-strings` guard (below) is a
pattern-matching backstop with known blind spots, so "the test passed" is **not**
proof a surface is localized. Manually self-check the spots the guard cannot see:

- text passed to `PopupManager.confirm`/`confirmClose`/`warnVariables`/`notify`
  dialogs (only `Notifications.*` toast text is scanned);
- a label handed by **position** to a _newly added_ builder helper (the guard
  only knows the helpers in its curated list — keep it current, see below);
- display text on a config property the guard doesn't watch (it watches
  `label`/`text`/`title`/`hint`/`placeholder`/`ariaLabel`/`desc`/`description`/
  `message`/`tooltip` — a `heading:`/`caption:`/`prompt:`/`emptyText:` slips by);
- lowercase-first strings on the helper/config/text-node rules (those require a
  capital first letter for precision);
- **main-process** strings under `src/app/` (native menus, dialogs) — the
  scanner only walks `src/web/scripts`, so these are entirely unguarded;
- a `t("…")` whose key you forgot to add to `en.json` — neither test flags a key
  missing from the reference catalog itself; it silently renders the raw
  key/English at runtime.

- **Renderer module** — `src/web/scripts/i18n.js` exposes `t(key, params)`,
  `formatNumber`, `formatDate`, `getLocale`/`getLang`, and `init()`. `app.js`
  `await i18n.init()` runs first in `DOMContentLoaded`, **before** any component
  renders, so `t()` is a synchronous lookup everywhere after.
- **Catalogs** — bundled JSON under `src/web/locales/<lang>.json`, grouped by
  area. Keys are dotted paths (`area.component.label`) resolved against the
  nested object. English (`en.json`) is the reference + fallback. Interpolation
  is `{name}`; a leaf may be an object of CLDR plural categories selected by a
  numeric `count` param.
- **Supported languages — always translate** — the app ships catalogs for
  **English (`en`), German (`de`), Spanish (`es`), French (`fr`), Italian
  (`it`), Japanese (`ja`), and Chinese – Simplified (`zh`)** — the set offered
  by the Appearance → Language picker (`LOCALE_OPTIONS` in `i18n.js`, plus a
  `system` option that follows the OS locale). `en.json` is the source-of-truth
  superset; **every other locale must stay complete** (cover every `en.json`
  key). **Any new user-facing string must be added to `en.json` _and_ translated
  into all of `de`, `es`, `fr`, `it`, `ja`, `zh` within the same change; never
  leave a locale to fall back to English.** Preserve `{name}`/`{count}`
  placeholders and inline `<code>…</code>` markup verbatim in each translation;
  technical example values (proxy/bypass/status-code placeholders) stay literal.
  The completeness test (`COMPLETE_LOCALES` in `src/app/tests/i18n.test.js`)
  fails when any shipped locale is missing an `en.json` key, so `make test-i18n`
  is the gate — it runs both in CI (via `make test`) **and** in the local
  `pre-commit` hook (`make fmt lint test-i18n`), so a leak fails before the push,
  not only after.
- **No-hardcoded-strings guard** — `make test-i18n` also runs
  `src/web/scripts/tests/no-hardcoded-strings.test.js`, which scans renderer
  source for display literals that bypass `t()`. It catches not just the direct
  forms (`textContent`/`title`/`placeholder`/`aria-label` assignments and
  HTML-template attributes) but also the **helper-built** ones that hide behind a
  variable: UI-bearing object properties (`label:`/`text:`/`hint:`/`desc:`/
  `message:` …, the way a field-builder receives display text), `Notifications.*`
  toast text, and static `<option>`/text nodes in templates (`>Cancel</…`). Data
  properties (`value:`/`key:`/`className:`) and non-UI modules (`export/`,
  `import/`, `i18n.js`, `icons.js`) are excluded to keep matches real. It ratchets
  against `no-hardcoded-strings.baseline.json` (the enumerated pre-existing debt,
  keyed `relPath::literal`): a **new** literal not in the baseline fails CI, and a
  baseline entry that disappears (was localized) also fails so the baseline can
  only shrink. After an intentional change, regenerate it with
  `UPDATE_HARDCODED_BASELINE=1 node --test
src/web/scripts/tests/no-hardcoded-strings.test.js`. The baseline is **now empty
  (`[]`)** — keep it empty: localize a newly flagged string rather than baselining
  it, and never let it grow back. (A handful of proper nouns — interchange-format
  names like `Postman v2.1`, font and theme names — are kept verbatim in the
  `INTENTIONAL` set, not the baseline.)
- **Keep the guard current** — the scanner is a _curated_ pattern-matcher, so
  introducing UI in a shape it doesn't yet recognize means extending the guard in
  the **same change**, or it silently stops covering that surface:
  - add a **new positional-label builder helper** to the `RULES` allowlist (the
    `mkTab|buildToolbarToggle|#buildAuthFieldSelect|…` alternation in
    `no-hardcoded-strings.test.js`) so its label argument is scanned;
  - add a **new display-bearing config key** to the UI-bearing property-name list
    (`label|text|title|hint|placeholder|ariaLabel|desc|description|message|tooltip`)
    when a helper starts receiving display text under a key not already there;
  - extend `INTENTIONAL` (never the baseline) for a genuinely non-translatable
    proper noun, and `SKIP_FILES`/`SKIP_DIRS` only for non-product code. After
    touching any of these allowlists, re-run `make test-i18n` to confirm the guard
    still passes.
- **Loading** — the sandboxed renderer can't read files, so the **main process**
  (`src/app/i18n.js`) resolves the active locale (persisted `settings.locale` →
  OS `app.getLocale()` → English) and returns the catalog over the `i18n:load`
  IPC channel. Keep `main.js`/`preload.js` in sync for that channel like any
  other.
- **Never call `t()` at module top-level** — the catalog isn't loaded until
  `init()`. Module-level tables (e.g. tab specs) store a `labelKey` and resolve
  via `t(spec.labelKey)` at render time.
- **Switching locales** — the Appearance settings Language picker writes
  `settings.locale` and `app.js` reloads the window (imperatively-built DOM can't
  re-localize in place); the new catalog is applied at the next startup. `<html
lang>` is set from the active locale in `applyCatalog()`.

## User Guide

The shipped, in-app user guide lives in `src/web/docs/` (Markdown pages —
`getting-started.md`, `requests.md`, `responses.md`, `collections.md`,
`authentication.md`, `graphql.md`, `import-export-and-backup.md`,
`keyboard-shortcuts.md`). It is served via **Help → User Guide** through
`DocsViewer` (`docs-viewer.js` / `docs-window.js`).

- **Keep it in step with features** — when you add or change a user-facing
  feature (a new panel, command, setting, auth type, import/export format,
  keyboard shortcut, etc.), **update the relevant guide page in the same change**
  if a user would reasonably look it up there. Purely internal refactors with no
  visible behavior change need no doc edit — use judgement ("if necessary").
- **Screenshots** are regenerated through the `.docs-build` CDP pipeline
  (source images in the gitignored `docs-originals/`); match the tone and
  structure of the existing pages.
- **The website guide auto-syncs — no manual copy.** `src/web/docs/*.md` is the
  single source of truth for **both** the in-app guide (`DocsViewer`) **and** the
  hosted guide at `resthippo.com/docs`. `scripts/build-docs.mjs` renders that same
  Markdown into `website/docs/*.html`, and the **Deploy Website** workflow
  (`.github/workflows/deploy-site.yml`) runs it on every push to `main` (plus on
  release / manual dispatch). So a doc edit, once committed and pushed to `main`,
  republishes to the site automatically — there is nothing to hand-sync, and the
  two can never drift. **Never hand-edit `website/docs/`** — it is generated
  output (gitignored intent; CI overwrites it). The **only** manual touchpoint is
  **adding/removing/renaming a page**: keep the `PAGES` array in `build-docs.mjs`
  in lockstep with the one in `docs-viewer.js` (both list slug + title, in order)
  — editing the body of an existing page needs no code change.

## Test collection (Feature Test Suite)

> **Status (2026-06-19): the generator is not in the repo.** There used to be a
> self-test Rest Hippo collection — one folder per implemented feature —
> generated by `test-collection/build-test-collection.cjs` (the source of truth)
> and built into the dev data store so it showed up in the running app. That
> generator and the `test-collection/` directory are **no longer present** in
> version control (no `.cjs` files, no `FEATURES` array, no git history); only
> the **generated archives** remain tracked — `backup/test-suite.json` and
> `data/archives/test-suite-*.json`.
>
> Because the generator is gone, **the old "every new feature must add a
> `folder(...)` to `FEATURES` and rebuild with `--system-backup`" rule is
> suspended** — there is nothing to edit or rebuild. Do **not** hand-edit the
> stored archives to fake a folder. If you want the suite back, restore or
> recreate the generator first (the archives above show the expected output
> shape: `kind/schemaVersion/manifest/environments/collections`, requests
> routed to the mock server `{{mockUrl}}`=http://localhost:8888 or Keycloak
> `{{keycloakUrl}}`=http://localhost:8090, catch-all `/echo` for everything that
> just needs to fire). Until then, new features are "done" without a suite
> folder — the i18n and User-Guide rules still fully apply.

## Popups & menus

All popup/menu lifecycle goes through the `PopupManager` singleton
(`src/web/scripts/popup-manager.js`). Pick the right category:

- **Modal popups** — mount/dismiss via `PopupManager.open(instance)` /
  `PopupManager.close()`. Heavyweight panels are **singletons** `new`-ed once at
  startup and reused via an instance `open(data)` method (`CollectionsPopup`,
  `SettingsPopup`); lightweight one-shot
  modals use a **static factory per open** (`BackupModal`, `ExportModal`,
  `GraphQLSchemaViewer`, `PillEditorPopup`). One-shot dialogs (confirm / notify /
  warn) use the `PopupManager.confirm/confirmDelete/confirmClose/warnVariables/notify`
  helpers — never hand-roll a dialog.
- **Dropdown / context menus** — always `PopupManager.openMenu(element, x, y)`.
  It provides the transparent click-capturing mask, viewport clamping, and fires
  `hippo:popup-opened/-closed`; do **not** reimplement outside-click/mount in the
  component (`LayoutPicker` and `RequestEditor`'s method menu both use it).
  Invariant: only open a menu when no other popup is active (the
  `hippo:popup-opened/-closed` pair is coalesced to mask visibility; opening a
  menu over a live popup would unbalance depth-counting listeners such as
  `ResponseViewer`'s native preview overlays). Keep a reference to the menu and
  drop it on a `once` `hippo:popup-closed` listener, since a mask click or resize
  closes the menu without calling back into the component.
- **Exception:** `PillPicker` (the inline `{{` typeahead) does **not** use
    `openMenu` — the full-page mask (`pointer-events: auto`) would block the
    still-focused editor it coexists with, so `VariablePillEditor` owns its
    mount/outside-click/teardown. This is the only sanctioned opt-out.
- **Closing** — call `PopupManager.close()` directly. Wrap it in a private
  `#doClose()` **only** when there is real pre-close cleanup to run first (e.g.
  flushing an editor save before close) — `CollectionsPopup` does exactly this;
  a popup with no cleanup just calls `PopupManager.close()`.
- **Listeners** — anything that adds a `document`/`window` listener on open must
  remove it on close: pair add/remove, or register a `once`
  `hippo:popup-closed` cleanup (as `SettingsPopup` does for its Escape handler).
  The app-lifetime singletons (`RequestEditor`, `ResponseViewer`) keep permanent
  `hippo:*`/`resize` listeners and are intentionally never destroyed.
