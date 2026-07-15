# Design 02 — Make WebSocket-console text scale with the font-size setting

## Context
The whole app sizes text from the design tokens `--font-size-*` (defined in
`src/web/styles/theme.css`), and `--font-size-base: 13px` is applied to `body`. No
`font-size` is set on `:root`/`html`.

`src/web/styles/ws-console.css` is the lone outlier: it sizes text in **`rem`**
(`ws-console.css:68,73,82,101,225,238,272`, values like `0.85rem`/`0.8rem`/`0.78rem`).
Because `rem` resolves against the browser default (16px), not `--font-size-base`, the
WebSocket-console text is a **fixed size** and does not respond to the user's font-size
setting the way every other panel does.

Secondary nits in the same file: `font-family: var(--font-mono), monospace`
(`ws-console.css:74,100,244`) repeats a `, monospace` fallback that `--font-mono` already
includes (`theme.css:55`); and a few raw `padding: 2px var(--space-2)` literals
(`ws-console.css:83,118,228,239`).

## Goal
The WebSocket console honors the app font-size setting and the design-token scale, like
every other panel.

## Implementation steps
1. Replace every `rem` font-size in `ws-console.css` with the nearest `--font-size-*`
   token (`--font-size-xs`/`-sm`/`-md`/etc.). Map each rem value to the token whose pixel
   value matches the current intent against the `13px` base; if no token matches exactly,
   pick the closest and note it, or propose a new token rather than keeping a raw unit.
2. Drop the redundant `, monospace` after `var(--font-mono)`.
3. Replace the raw `2px` paddings with `--space-1` (2px) so spacing tracks the scale.
4. Sanity-check the console visually against the rest of the app at the default font size
   and at one larger setting.

## Acceptance criteria
- No `rem` units remain in `ws-console.css`.
- Changing the app font-size setting visibly rescales WebSocket-console text.
- No visual regression in the frame log at the default size.

## Constraints
- CSS tokens only; no hardcoded sizes.
- Scope is `ws-console.css`; do not touch unrelated CSS.

## Verify
`make fmt && make lint && make test`
