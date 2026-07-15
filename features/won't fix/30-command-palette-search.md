# Feature 30 — Command palette & global search

## Context
There is no command palette, quick-open, or fuzzy finder anywhere. The only search is the sidebar filter
(`src/web/scripts/components/tree-view.js` `#applyFilter` ~1310-1374), which does a substring match on
request name/url **within the active collection only** — it cannot reach other collections. In a workspace
with many collections, there is no way to jump to an arbitrary request or invoke an action by keyboard.

## Goal
Add a `Cmd/Ctrl+K` command palette that fuzzy-searches **all** requests/folders/collections across every
collection and also exposes app commands (new request, send, open settings, switch environment, import/
export, theme editor, etc.).

## Implementation steps
1. **Overlay**: build a palette modal (reuse `PopupManager` focus-trap/escape conventions) bound to
   `Cmd/Ctrl+K`, with an input + ranked results list, full keyboard navigation (↑/↓/Enter/Esc), and
   `role="combobox"`/`listbox` semantics.
2. **Index**: build a flat searchable index across all collections (requests, folders, collections) plus a
   static command registry. Add lightweight fuzzy ranking (subsequence + recency boost); no heavy dep —
   a small matcher is fine.
3. **Actions**: selecting a request opens/focuses it (works with Feature 27 tabs); selecting a command
   runs it. Show the matched path (collection › folder › request) and `<mark>` the matched characters.
4. **Cross-collection search**: this is the global counterpart to the active-collection sidebar filter —
   keep the sidebar filter as-is for in-tree narrowing.
5. Update user guide
6. Provide a global setting to disable command-palette-search   

## Acceptance criteria
- `Cmd/Ctrl+K` opens the palette from anywhere; Esc closes it and restores focus.
- Typing fuzzy-matches requests across **all** collections and ranks sensibly; Enter opens the selection.
- App commands are invocable from the palette by name.
- Fully keyboard-operable and screen-reader labeled (coordinate with Feature 48).

## Constraints
- No framework, no heavy fuzzy-search dependency — implement a small matcher or justify a tiny vetted one.
- Plain DOM + class-based ES module; CSS tokens from `theme.css`, styles in `components.css`.
- Reuse existing navigation events (`hippo:request-selected`) rather than duplicating selection logic.

## Verify
`make fmt && make lint && make test`, then exercise palette open/search/select and command invocation in
`make debug`.
