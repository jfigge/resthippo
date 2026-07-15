# Design 11 — One state-class convention; reconcile BEM vs flat names

## Context
CSS state classes are spelled three ways for the same concept:
- BEM modifier `--state` (dominant, 30+ uses) — `.tree-tab--active` (`components.css:144`),
  `.req-tab-btn--active` (`components.css:840`), `.coll-list-item--active`
  (`components.css:4025`); also `--selected`, `--collapsed`, `--disabled`, `--danger`.
- Standalone `.is-*` (~9 uses) — `.params-secure-btn.is-active` (`components.css:1855`),
  `.settings-nav-item.is-active` (`components.css:3682`), `.coll-tab.is-active`
  (`components.css:3919`), plus `.is-hidden`/`.is-masked`/`.is-confirming-delete`.
- Bare `.selected` — `.theme-item.selected` (`theme-editor.css:117`).

So `--active`, `.is-active`, and `.selected` all express "active/selected" in the same
codebase. Separately, BEM `prefix__element` (79 classes) is mixed with flat
`prefix-name` (332 classes) within the same components — `.tree-node` (flat) coexists with
`.tree-node__row`/`.tree-node__method` (BEM); `.auth-field` (flat) with `.auth-field__*`
(BEM) — with no rule for when `__` is used vs. a hyphen.

## Goal
A single, documented state-class convention and a clear rule for BEM `__element` vs. flat
hyphenated names, applied consistently.

## Implementation steps
1. Pick the state convention. Recommended: BEM modifier `--state` (already dominant). Pick
   the element convention too (recommended: keep flat `prefix-name` for elements and reserve
   `--modifier` for state; or commit fully to BEM `__element`). Write the rule into
   `CLAUDE.md`.
2. Convert the `.is-*` outliers and the bare `.theme-item.selected` to the chosen modifier
   form. This requires renaming both the CSS selectors **and** the JS that toggles them —
   grep each class name across `src/web/scripts/` and update toggles together.
3. Reconcile the mixed `__element`/flat names per component to the chosen rule, or
   explicitly document any component that stays mixed for a reason.
4. Do this incrementally per component family to keep diffs reviewable; the state-class
   unification (`.is-*` → `--active`) is the highest-value first step.

## Acceptance criteria
- One spelling for "active/selected" across all CSS and JS toggles.
- A documented BEM-vs-flat rule; components conform or are documented exceptions.
- No dangling selectors (every renamed class updated in JS too).
- App renders identically (no visual or interaction regressions).

## Constraints
- Pure rename refactor; no visual change.
- Update JS class toggles in lockstep with CSS renames — verify with a grep of each class.

## Verify
`make fmt && make lint && make test`
