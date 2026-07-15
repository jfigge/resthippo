# Feature 47 — Keyboard-shortcut coverage & cheat-sheet

## Context
App-specific shortcuts are sparse and undiscoverable. The only ones are **Cmd/Ctrl+Enter** (send,
`src/web/scripts/app.js` ~1886-1895), font zoom (`+`/`-`/`0`), and, inside the response viewer,
**Cmd/Ctrl+A** (select body) and **Cmd/Ctrl+F** (find). The application menu defines only one custom
accelerator (Import, `Cmd/Ctrl+Shift+I`); the View menu's font items even omit their accelerators
(`src/app/main.js` ~2309-2329), and there is **no New Request / Save / Find / Settings** menu entry and
**no shortcuts reference UI** anywhere. The Send button shows no hint that `Cmd/Ctrl+Enter` exists.

## Goal
Provide a coherent, discoverable set of keyboard shortcuts for the core actions, plus an in-app cheat-sheet.

## Implementation steps
1. **Define a keymap**: a single source of truth mapping actions → bindings (send, save, new request, new
   folder, focus URL, focus sidebar filter, open command palette [Feature 30], switch tabs [Feature 27],
   next/prev request, toggle panes, open settings). Implement handlers via the existing capture-phase
   global key handling in `app.js`; keep platform-correct Cmd vs Ctrl.
2. **Menu accelerators**: add the missing application-menu items (New Request, Save, Find, Settings) with
   accelerators, and add accelerators to the font-size items so the menu advertises them
   (`main.js` menu).
3. **Discoverability**: add a "Keyboard Shortcuts" cheat-sheet dialog (e.g. `?` / `Cmd/Ctrl+/`) listing the
   keymap grouped by area; reuse `PopupManager`. Add tooltips/`title` hints to key controls (e.g. Send).
4. **No conflicts**: ensure shortcuts don't fire while typing in editors except where intended (Send).
5. Update the user guide

## Acceptance criteria
- Core actions (send/save/new/find/focus-url/command-palette/switch-tab) have working, platform-correct
  shortcuts.
- A cheat-sheet dialog lists all shortcuts and is itself openable by keyboard.
- The application menu advertises accelerators for its items (including font size).
- Shortcuts don't interfere with normal text entry.

## Constraints
- Plain DOM + class-based ES module; keep the keymap centralized, not scattered.
- Menu changes in `main.js`; keep `main.js`/`preload.js` in sync if a channel is added.
- CSS tokens from `theme.css`; styles in `components.css`.

## Verify
`make fmt && make lint && make test`, then verify each shortcut and the cheat-sheet in `make debug`.
