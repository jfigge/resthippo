# Design 13 — Token cleanup (spacing, method colors, focus ring, weights)

## Context
A cluster of smaller token/design-system inconsistencies in `src/web/styles/`:
- **`theme-editor.css` uses zero `--space-*` tokens** despite ~16 hardcoded px values that
  match tokens exactly: `:44` `padding: 10px 12px`, `:59` `gap: 4px` (→`--space-2`), `:157`,
  `:257` `padding: 16px` (→`--space-5`), `:260,267` `gap: 8px` (→`--space-3`). It loads the
  same `theme.css`, so the tokens are available.
- **Method-color tokens duplicate semantic tokens across all 4 themes** — e.g.
  `--color-method-get` == `--color-success` (`theme.css:32,38`), `--color-method-delete` ==
  `--color-error`, `--color-method-put` == `--color-accent`, `--color-method-head` ==
  `--color-warning`. Only post/patch are genuinely distinct. This is a 4× sync burden.
- **Focus ring re-declared with a conflicting offset** — global `theme.css:235`
  (`outline-offset: 2px`) vs. `theme-editor.css:176,312` (`outline-offset: -1px`) on inputs.
- **Unused token** `--splitter-hit: 12px` (`theme.css:106`) — never referenced.
- **Literal values where a token exists** — `border-radius: 8px` where `--radius-lg` == 8px
  (`components.css:4540`); `transition: transform 0.1s ease` (`components.css:1018,2760`)
  matches neither `--transition-fast` (120ms) nor `--transition-normal` (200ms).
- **No font-weight token despite a clear scale** — `600` (39×), `700` (16×), `500` (5×),
  with `500` vs `600` used for "emphasis" interchangeably.

## Goal
The token system is the single source of truth: secondary files use the spacing scale,
duplicate/unused tokens are removed or derived, and stray literals reference tokens.

## Implementation steps
1. **theme-editor.css spacing:** replace the px literals that match a token with the
   `--space-*` token; for off-scale values (3px/5px/6px/7px/9px/10px) pick the nearest scale
   step or justify the one-off inline.
2. **Method colors:** derive the duplicated method tokens from their semantic equivalents
   (e.g. `--color-method-get: var(--color-success)`) so each theme defines them once; keep
   post/patch as distinct literals. Verify all four themes still render the method badges
   correctly.
3. **Focus ring:** remove the `theme-editor.css` focus re-declarations and rely on the
   global `:focus-visible` rule, or, if the inset ring is intentional for inputs,
   standardize that as a documented input-focus token used app-wide.
4. **Dead/literal cleanup:** remove `--splitter-hit`; change `border-radius: 8px` →
   `var(--radius-lg)`; change the `0.1s ease` transitions to a transition token (add a
   `--transition-snappy` token if 100ms is genuinely wanted).
5. **Font-weight tokens:** add `--font-weight-medium/-semibold/-bold` and apply them;
   decide the rule for 500 vs 600 emphasis and apply consistently.

## Acceptance criteria
- No exact-match px literals remain in `theme-editor.css` where a `--space-*` token exists.
- Method-color tokens are derived (post/patch excepted); all four themes render correctly.
- `--splitter-hit` removed; `border-radius`/transition literals reference tokens.
- Font-weight tokens exist and are used; no visual regression.

## Constraints
- Pure token refactor; verify each of the four themes (mocha/latte/grey variants) visually.
- Tokens only; no hardcoded colors/sizes left behind by the cleanup.

## Verify
`make fmt && make lint && make test`
