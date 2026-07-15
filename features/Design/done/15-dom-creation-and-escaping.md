# Design 15 — Standardize DOM creation & HTML escaping

## Context
Components build DOM two ways — `document.createElement` + `textContent` vs. `innerHTML`
template strings — sometimes **within the same class**:
- `CollectionsPopup` builds sidebar rows with createElement (`collections-popup.js:386-405`)
  but cookie rows with `innerHTML` (`collections-popup.js:1010-1025`).
- Counts: `request-editor.js` ~111 createElement / 28 innerHTML; `response-viewer.js`
  63 / 23; `collections-popup.js` 21 / 15.

Escaping is also inconsistent. There is a shared `escapeHtml` in `utils/html.js`, imported
by 8 files, but:
- `response-viewer.js:196-198` defines local `escAttr`/`escText` inside `prettyHtml()`
  despite already importing `escapeHtml`.
- Several `innerHTML` users don't import `escapeHtml` at all
  (`variables-popup.js`, `environments-popup.js`, `settings-popup.js`) — currently safe only
  because they confine `innerHTML` to static markup and route user data through
  `textContent`, but the reader can't rely on one rule.

## Goal
A documented rule for DOM construction and a single escaping helper, so user-supplied data
is escaped the same way everywhere.

## Implementation steps
1. Define the rule (recommended): use `createElement` + `textContent` for any element that
   carries user/response data; reserve `innerHTML` for static, developer-authored markup
   (e.g. inline SVG icons). When `innerHTML` must include dynamic data, it goes through the
   shared `escapeHtml` from `utils/html.js`. Add the rule to `CLAUDE.md`.
2. Remove the local `escAttr`/`escText` in `response-viewer.js:196-198`; use the shared
   `escapeHtml` (extend `utils/html.js` if an attribute-escaping variant is genuinely
   needed, so there is still one home).
3. Audit `innerHTML` sites that interpolate dynamic data and route them through the shared
   helper or convert them to `createElement`/`textContent`. The `collections-popup` cookie
   rows (`:1010-1025`) are the clearest candidate to convert for intra-file consistency.
4. Prioritize the highest-risk files (anything rendering response bodies, headers, cookie
   values, or imported names).

## Acceptance criteria
- One escaping helper (`utils/html.js`); no per-file re-implementations.
- A documented createElement-vs-innerHTML rule; dynamic-data `innerHTML` sites either use
  `escapeHtml` or are converted.
- No XSS regression — user/response data is escaped on every render path (spot-check with a
  value containing `<script>`/`"`/`&`).

## Constraints
- Behavior-preserving rendering.
- Plain DOM only; do not introduce a templating library.

## Verify
`make fmt && make lint && make test`
