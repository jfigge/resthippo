# Feature 66 — Request headers inherit the collection default (presence-based, like profiles)

> Source: feature request 2026-07-10. Fixes the Swagger-import regression where blank imported headers clear collection defaults.

## Context
Collections define **default headers** merged into every request. Today the request↔default merge lives in
`request-payload.js` §2 (≈237-271):
1. enabled, non-blank collection defaults seed the header set (255-259);
2. a **disabled** request row suppresses a same-named default (261-265);
3. an **enabled** request row overrides the default — `setHeaderCI(name, await rv(h.value))` at 267-271 — and
   **it sets the value even when blank**, so a blank enabled request row overrides the default to empty
   ("clears" it).

That last rule breaks OpenAPI/Swagger import: `import/openapi.js` deliberately adds enabled header rows with
`value:""` to show the user which headers are available (header params via `paramToRow`/`prefillValue` when
there's no example — ≈229, 512; apiKey-as-header at 347-348; cookie at 355-357). Every such blank row now
**clobbers** the matching collection default (or sends a stray empty header).

We already solved this exact shape for **profile variable overrides**: a value *inherits* the Default unless
it's an *explicit override*, tracked by presence of a `row.overridden` flag, with an "inherits default"
placeholder, a `--inherited` row state, and a **reset-to-inherit** control. See
`components/variable-editor-shared.js` (≈127-134, 186-217), the reset-to-inherit icon (`icons.js:107`), the
`profiles.inheritsDefault` catalog key, and `onResetInherit`. **Request headers should work the same way.**

## Goal
A request header with **no value inherits the collection default** by default (never clears it). The user can
*explicitly* make it blank (an override that sends/clears to empty), can **reset** an explicit-blank back to
inheriting, and sees a **hint** showing which state each header is in.

## Design decisions (settled — mirror profiles)
- **Presence flag on the row.** Extend the request header row `{ enabled, name, value }` with
  `overridden?: boolean` (persisted in the request file's `headers[]`). Semantics mirror `buildVariableRow`:
  a row is *inheriting* when `!overridden`; the **first value edit sets `overridden = true`** (and it stays an
  override even if later cleared to empty — reset is the way back).
- **Send-time behavior** (rewrite the enabled-rows loop at `request-payload.js` 267-271; base the
  override decision on the row's raw `overridden` flag + raw blank-ness, **not** the resolved value).
  **SETTLED 2026-07-10: explicit blank = *suppress* the default (send nothing); no migration of existing
  rows (absent `overridden` ⇒ inherit).**

  | Row | value | `overridden` | matching default? | Result |
  |---|---|---|---|---|
  | enabled | blank | false | yes | **inherit** the default value |
  | enabled | blank | false | no | send nothing (available-header placeholder) |
  | enabled | blank | true | any | **suppress** the default (send nothing — like disabling) |
  | enabled | non-blank | any | any | send the value (concrete override) |
  | disabled | any | any | yes | suppress the default (unchanged) |

- **"Inheriting" only applies to a blank row.** A non-blank value is always a concrete override.
- **Reuse the profile UI pattern**, don't invent a new one: an inherit hint + a reset-to-inherit control
  (icons.js:107) enabled only while `overridden`. **The control is shown ONLY on rows whose name matches a
  collection default, and renders inline inside the value cell** (`.params-value-cell`, flex) rather than as a
  dedicated grid column — so rows with no default keep the plain header layout and every row's delete button
  stays aligned. The **inherit hint** ("Inherit default value") renders as the value editor's standard greyed
  italic placeholder ghost (it's a hint, not a real value); an explicit-blank / **suppressed** row shows no
  hint text at all — the enabled reset control is its only cue.

## Implementation steps
1. **Data model.** Add `overridden?: boolean` to the request header row (request-store shape / request file).
   Import defaults it to absent (= inherit). Round-trip it through `export/`/`import/resthippo.js` (other
   formats have no concept of it — acceptable loss).
2. **Merge.** In `request-payload.js` 267-271, only `setHeaderCI` when `h.overridden === true` **or** the raw
   `h.value` is non-blank; otherwise leave the collection default in place (inherit) / send nothing. Keep the
   disabled-suppress and case-insensitive rules as-is. Add unit tests to `request-payload`/payload tests for
   every row in the table above.
3. **Header editor UI.** The row builder needs (a) the collection default headers and (b) inherit/reset/hint.
   The request editor already has them at `this.#variableContext.collectionHeaders` (used at
   request-editor.js 1305/1621/2911) — pass them into the row builder and look up the case-insensitive match
   per row. For an inheriting blank row whose name matches a default, show a hint with the inherited value
   (e.g. `t("headers.inheritsDefault", { value })`) and the `--inherited` state; enable the reset control only
   when `overridden`; reset sets `overridden = false` and re-renders. Refresh when the active collection or
   its defaults change (`app.js` `_activeCollHeaders()` / the collection-headers save path ≈2693-2705).
   **Prefer to do this once:** adopt `HeadersEditor` in the request editor first (see Feature 63 — the request
   editor's inline `#buildHeaderRow` ≈1990-2155 duplicates `HeadersEditor.#buildRow`), then add inherit
   support in the single shared builder rather than twice.
4. **Import.** Confirm `openapi.js` blank header rows are created **without** `overridden` (inherit). No other
   import change needed — the merge/UI change is what fixes Swagger.
5. **i18n + docs + headers.** Add the new keys (`headers.inheritsDefault`, `headers.resetToDefault`, …) to
   `en.json` and translate into de/es/fr/it/ja/zh in the same change (or reuse `profiles.inheritsDefault`
   where wording fits). Update the Headers section of `src/web/docs/requests.md` (and `collections.md` default
   headers) to describe inherit / explicit-blank / reset. Apache header n/a (no new source files expected; add
   it if you create one).

## Decisions (settled 2026-07-10)
- **Explicit blank = suppress the default** (send nothing at all — same net effect as disabling the row, but
  reached by clearing an inline value). It does *not* send an empty-valued header.
- **No migration.** Existing blank enabled rows (no `overridden`) simply start inheriting; there is no
  one-time stamping pass. Accept the behavior change for the rare case of a blank-to-clear header.
- **Scope: request-editor header rows only.** `HeadersEditor` (used by the Collections popup) edits the
  collection *defaults* themselves, which inherit from nothing — leave it unchanged. Do **not** bundle the
  Feature 63 HeadersEditor-adoption refactor into this change.

## Acceptance criteria
- Importing a Swagger/OpenAPI doc into a collection with default headers: available/blank imported headers
  **inherit** the matching collection defaults, none clear a default, and blank headers with no default send
  nothing.
- A blank, inheriting request header shows an "inherits default (`<value>`)" hint and is not sent as empty.
- Typing then clearing a header keeps it an **explicit empty override** (still clears the default) with the
  reset control enabled; **reset** returns it to inheriting (hint reappears, default used again).
- Non-blank request headers still override; disabling a row still suppresses the default.
- `overridden` persists across reload and round-trips through the Rest Hippo export/import format.
- `make test` green (new merge + UI tests); new strings localized in all 7 locales; docs updated.

## Constraints
- Mirror the profile presence-model — reuse `buildVariableRow`'s inherit/reset/hint approach, the
  reset-to-inherit icon, and an `--inherited` state class; don't invent a parallel mechanism.
- Class naming per CLAUDE.md (`prefix-name` elements, `block--modifier` state).
- Keep header case-insensitivity and the disabled-suppress semantics unchanged.
- No framework; the merge stays pure and testable in `request-payload.js`.

## Verify
`make test` (esp. payload + import). Then `make debug`: on a collection with a default `Accept` header,
import a Swagger doc and confirm imported blank headers inherit (not clear) the default; set an explicit blank
and confirm it clears; reset it and confirm the default returns; check the hint text in a non-English locale.
