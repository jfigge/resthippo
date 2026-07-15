# Feature 48 — Accessibility baseline

## Context
Accessibility is partial. There's reasonable ARIA (dialogs use `role="dialog"`/`aria-modal`, the tree uses
`role="tree"`/`treeitem` with `aria-expanded`, tablists set `aria-selected`), modal focus is managed by
`PopupManager`, and there's a global `:focus-visible` ring (`src/web/styles/theme.css` ~234-237). But there
are concrete gaps:
- **Zero** `prefers-reduced-motion`, `prefers-contrast`, or `forced-colors` handling anywhere in
  `src/web/styles` — despite many transitions/animations.
- **No `sr-only`/visually-hidden** utility class at all.
- The tree is **not a roving-tabindex composite**: every row is `tabindex="0"`, with no Arrow/Home/End/
  typeahead navigation (`tree-view.js`); in-app listbox pickers (layout, env list) also lack arrow-key nav.

## Goal
Bring the UI to a solid accessibility baseline: respect OS motion/contrast preferences, add a
visually-hidden utility, and make the tree and custom pickers proper keyboard-navigable widgets.

## Implementation steps
1. **Media queries**: add `@media (prefers-reduced-motion: reduce)` to neutralize non-essential
   transitions/animations, and `@media (prefers-contrast: more)` / `(forced-colors: active)` adjustments so
   Windows High Contrast and increased-contrast users get adequate contrast. Use `theme.css` tokens.
2. **Roving tabindex**: convert the tree to a single-tab-stop composite with Arrow up/down to move between
   visible rows, Left/Right to collapse/expand, Home/End, and type-ahead; manage `tabindex`/
   `aria-activedescendant`. Apply the same to the in-app listbox pickers.
3. **Screen-reader text**: add a `.sr-only`/visually-hidden utility and use it for icon-only controls and
   status announcements; ensure error/status updates use `aria-live` (coordinate with Feature 26
   notifications).
4. **Audit pass**: verify labels/roles on key controls (Send, tabs, tree, pickers) and that focus is never
   trapped or lost.
5. Update the user guide

## Acceptance criteria
- With "reduce motion" set, popups/transitions don't animate distractingly.
- High-contrast / forced-colors mode renders the UI with adequate contrast (no invisible controls).
- The tree is fully operable with Arrow/Home/End/type-ahead from a single tab stop.
- Icon-only controls expose accessible names; status changes are announced.

## Constraints
- Plain CSS with `theme.css` tokens — no hardcoded colors; no framework.
- Don't regress existing ARIA or `PopupManager` focus management.
- Keep the keyboard model consistent with Feature 47.

## Verify
`make fmt && make lint && make test`, then keyboard-and-reduced-motion test in `make debug`.
