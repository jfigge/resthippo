# Design 10 — Standardize popup lifecycle (open/close/destroy)

## Context
Popups/modals use three competing lifecycle models:
- **Long-lived singleton with instance `open(data)`** — `new`-ed once at startup
  (`app.js:734-737`) and reused: `CollectionsPopup` (`collections-popup.js:145`),
  `EnvironmentsPopup` (`environments-popup.js:116`), `VariablesPopup`
  (`variables-popup.js:82`), `SettingsPopup` (`settings-popup.js:616`).
- **Static factory creating a fresh instance per open** — `BackupModal.openExport`
  (`backup-modal.js:42`), `ExportModal.openCollection` (`export-modal.js:62`),
  `GraphQLSchemaViewer.open` (`graphql-schema-viewer.js:37`), `PillEditorPopup.open`
  (`pill-editor-popup.js:112`).
- **Roll-your-own, no `PopupManager`** — `PillPicker` (`pill-picker.js:73`) and
  `LayoutPicker` (`layout-picker.js:170-174`) manage their own mount/outside-click/teardown,
  even though `PopupManager.openMenu()` exists for exactly this (`popup-manager.js:567`);
  meanwhile `RequestEditor`'s method menu *does* use `PopupManager` (`request-editor.js:742`).

Closing is also split: private `#doClose()` wrappers (`collections-popup.js:1229`,
`environments-popup.js:992`, `variables-popup.js:477`) vs. direct `PopupManager.close()`
(`settings-popup.js:604`, `backup-modal.js:72`, `export-modal.js:75`,
`pill-editor-popup.js:130`). And `destroy()` exists on only some components
(`pill-picker.js:73`, `variable-pill-editor.js:163`, `request-auth-editor.js:2057`).

## Goal
One documented popup/menu lifecycle convention: how a popup is instantiated, opened,
closed, and torn down — applied across all popups and dropdown menus.

## Implementation steps
1. Decide the conventions (recommended):
   - **Instantiation:** singleton + instance `open(data)` for the heavyweight panels;
     static factory per-open for lightweight one-shot modals. Document which category a new
     popup belongs to.
   - **Menus/dropdowns:** always go through `PopupManager.openMenu()` — no roll-your-own
     mount/outside-click.
   - **Close:** one convention (e.g. always `PopupManager.close()`; keep `#doClose()` only
     when it adds real cleanup, and have it call the manager).
2. Migrate `PillPicker` and `LayoutPicker` onto `PopupManager.openMenu()` (or document why
   they can't), removing their bespoke outside-click/teardown.
3. Make the close path uniform: collapse the `#doClose()` trio to the chosen convention.
4. Ensure every component that registers `document`/`window` listeners on open removes them
   on close/destroy. The app-lifetime singletons (request-editor, response-viewer) may keep
   permanent listeners, but document that they are intentionally never destroyed.
5. Record the convention in `CLAUDE.md` (a short "Popups & menus" note).

## Acceptance criteria
- Menus go through `PopupManager`; no component reimplements outside-click/mount.
- One close convention across popups.
- No leaked `document`/`window` listeners from popups that open and close repeatedly.
- All popup-related e2e tests pass.

## Constraints
- Behavior-preserving (same open/close UX, keyboard ESC handling, overlay behavior).
- Plain DOM + class-based ES modules.

## Verify
`make fmt && make lint && make test`
