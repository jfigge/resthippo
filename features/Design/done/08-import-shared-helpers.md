# Design 08 — Share import auth/body helpers (mirror `export/redact.js`)

## Context
The export side has a single source of truth, `export/redact.js`, consumed by all four
exporters (`export/openapi.js:3`, `har.js:3`, `postman.js:3`, `insomnia.js:3`). The import
side follows the opposite philosophy: there is **no shared import helper module**, and the
same concerns are reimplemented per format with the same names but different mappings:
- `parseAuth(auth)` — defined independently in `import/postman.js:42` and
  `import/insomnia.js:3`.
- `parseBody(...)` — defined independently in `import/postman.js:89` and
  `import/insomnia.js:46`.

Two functions with identical names but different field maps is a maintenance trap — a
reader may assume they are shared.

Related asymmetry (worth fixing in the same pass): only `parseOpenApi` returns a
`warnings` channel (`import/openapi.js:441,553`); `parsePostman`/`parseInsomnia` return
`{ collection, variables }` with no `warnings` key (`import/postman.js:214`,
`import/insomnia.js:115`), even though the consumer reads `parsed.warnings`
(`app.js:2968`). The sub-parsers also never throw — malformed-but-JSON input silently
yields a partial/empty collection.

## Goal
Importers share common auth/body helpers (where the canonical Rest Hippo shape is the same), and
all importers return a uniform shape including `warnings`.

## Implementation steps
1. Identify the parts of `parseAuth`/`parseBody` that produce the **canonical Rest Hippo request
   shape** (the same across formats) vs. the parts that are genuinely format-specific. Put
   the canonical builders in a shared module (e.g. `import/shape.js` or extend an existing
   shared util), and have each importer map its format into that builder.
2. Where two formats truly differ, keep small format-specific adapters but route them
   through the shared canonical builder so the output shape can't drift.
3. Give `parsePostman` and `parseInsomnia` a `warnings: []` return field (populated where
   they currently drop data silently), making the three importers' return shape uniform.
4. Decide and document the importer error contract: either sub-parsers surface
   non-fatal issues via `warnings` and only `parseImport` throws on unparseable input
   (current behavior, made explicit), and add at least one warning for a known lossy case.
5. Update `import/tests/import.test.js` for the shared helpers and the uniform return shape.

## Acceptance criteria
- `parseAuth`/`parseBody` canonical logic exists once, not once per format.
- All three importers return `{ collection, variables, warnings }`.
- Tests cover the shared helpers and the warnings field.

## Constraints
- Behavior-preserving for valid inputs (same collections imported).
- Coordinate the canonical variables shape with Design 04 if both are in flight.

## Verify
`make fmt && make lint && make test`
