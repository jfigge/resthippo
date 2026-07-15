# Feature 50 — Internationalization (i18n) scaffolding

## Context
Every UI string is **hardcoded English**. There is no localization layer anywhere in `src/web/scripts` (no
`i18n`/`locale`/`intl`/message catalog), `<html lang="en">` is fixed in `index.html`, and labels/
placeholders/titles/aria-labels/dialog copy are inline literals. The only locale-aware behavior is
incidental (`Date.toLocaleString()` for cookie expiry, number/byte formatting). Adding localization later
will require touching dozens of component files unless a seam is introduced now.

## Goal
Introduce a lightweight i18n layer — a string catalog + a `t()` lookup — and migrate user-facing strings to
it, with at least the structure to add locales (English shipped; a second locale optional as proof).

## Implementation steps
1. **i18n module**: add a small `i18n` utility exposing `t(key, params?)` with interpolation and a fallback
   to the key/English. Load the active locale's catalog (JSON) at startup; default to system locale →
   English. No heavy dependency — a focused implementation is fine.
2. **Catalog**: create `en` message files (grouped by area). Establish a key convention
   (`area.component.label`).
3. **Migration**: replace inline literals in the highest-traffic components first (settings, popups,
   tree/context actions, request/response tabs, notifications) with `t(...)`. Localize `aria-label`s and
   `title`s too. Set `<html lang>` from the active locale.
4. **Plurals/format**: provide a simple plural/format helper (or wrap `Intl`) for counts and dates so those
   aren't hardcoded.

## Acceptance criteria
- A central `t()` + JSON catalog exists; the app renders entirely through it for migrated areas.
- Switching the active locale (even to a small sample catalog) changes the migrated strings, falling back
  to English for missing keys.
- `aria-label`/`title` strings and the document `lang` are localized.
- No user-facing regression in the default English experience.

## Constraints
- No framework, no heavy i18n dependency unless justified; keep catalogs as bundled JSON (no CDN).
- Plain DOM + class-based ES modules; don't change component structure beyond string extraction.
- Migration can be incremental — but the seam (module + catalog + convention) must be complete.

## Verify
`make fmt && make lint && make test`
