# Design 04 — Unify the `variables` shape across import/export

## Context
The two halves of the import/export subsystem use **inverse representations** of the same
concept:
- **Importers return `variables` as an object map** `{ name: value }`:
  `import/postman.js:221-224,236`, `import/insomnia.js:132-143`, `import/openapi.js:552`.
- **Exporters consume a canonical array** `[{ name, value, secure }]`:
  `export/postman.js:184`, `export/insomnia.js:143`, `export/redact.js:31`.

The app layer papers over the mismatch at every call site with `normalizeVariables` /
`varsArrayToMap` (`app.js:2944,2956`). The `secure` flag exists only on the export side;
importers have no notion of it. A reader moving between `import/*` and `export/*` has to
mentally flip the shape.

## Goal
One canonical in-memory variables shape across import, export, and the app layer, with
conversion to/from foreign formats confined to the format adapters.

## Implementation steps
1. Pick the canonical shape — the export-side array `[{ name, value, secure }]` is already
   the documented "canonical" form and carries `secure`; adopt it everywhere in-app.
2. Update the three importers to **return the canonical array** directly (set `secure`
   where the source format expresses it; default `false` otherwise), instead of an object
   map.
3. Collapse `normalizeVariables` / `varsArrayToMap` (`app.js:2944,2956`): keep a single
   helper only where a foreign format genuinely needs the map shape, and call it inside
   that adapter — not at every app-level boundary.
4. Update JSDoc on each importer/exporter entry function to state the canonical shape, and
   update any tests asserting the old object-map return.

## Acceptance criteria
- All importers and exporters agree on `[{ name, value, secure }]` as the boundary shape.
- `secure` round-trips where the source/target format supports it.
- No app-level shape-flipping remains except inside a format adapter that requires it.
- Import/export tests pass with assertions updated to the canonical shape.

## Constraints
- Behavior-preserving for end users (same files import/export equivalently).
- Keep changes additive to persisted models; run new persisted fields through the
  schema-version envelope (Feature 01) if any are added.

## Verify
`make fmt && make lint && make test`
