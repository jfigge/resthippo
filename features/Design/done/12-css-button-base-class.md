# Design 12 — Shared base button + variant classes

## Context
There are ~30 feature-prefixed button classes that each re-declare the same
padding/border/`--radius-sm`/background/hover block: `.popup-btn`, `.editor-btn`,
`.sidebar-btn`, `.coll-action-btn`, `.cookies-clear-btn`, `.params-toolbar-btn`,
`.auth-discover-btn`, `.body-prettify-btn`, `.req-tab-btn`, `.res-tab-btn`, and more. Only
`.icon-btn` (`components.css:152`) is reused as a base (`.header-icon-btn` extends it in
`layout.css`).

The accent/danger variants are reimplemented per family — `.popup-btn--primary` /
`--danger` (`components.css:3440,3459`) vs. `.editor-btn.btn-primary` / `.btn-danger`
(`theme-editor.css:225,236`) vs. `.sidebar-btn--primary` (`theme-editor.css:78`) are three
separate definitions of the same accent/error button.

## Goal
A single shared base button class plus a small set of variant classes
(primary/danger/secondary/warning), with feature-specific button classes adding only their
genuinely unique rules.

## Implementation steps
1. Define a base `.btn` (or extend the existing `.icon-btn` philosophy) in `components.css`
   capturing the shared padding/border/radius/background/hover/disabled rules, using
   tokens.
2. Define one set of variant classes (`.btn--primary`, `.btn--danger`, `.btn--secondary`,
   `.btn--warning`) referencing `--color-accent`/`--color-error`/etc.
3. Migrate the ~30 feature button classes to compose `.btn` + variant, keeping only the
   per-feature deltas (size, icon spacing, layout). Update the HTML/JS that emits these
   buttons to add the base class.
4. Collapse the three primary/danger definitions into the single variant set; remove the
   `theme-editor.css` `.btn-primary`/`.btn-danger` duplicates in favor of the shared
   variants (theme-editor loads the same `theme.css`/`components.css`).
5. Migrate one button family end-to-end first to validate the approach before doing the
   rest.

## Acceptance criteria
- One base `.btn` and one variant set; no per-family re-declaration of the shared block.
- Primary/danger styling defined once, not three times.
- All buttons render and behave identically (hover, disabled, focus).

## Constraints
- Pure styling refactor; no visual change.
- Tokens only; update JS/HTML class lists in lockstep with CSS.

## Verify
`make fmt && make lint && make test`
