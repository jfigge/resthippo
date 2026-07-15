# Feature 41 — OpenAPI import fidelity ($ref resolution & example bodies)

## Context
The OpenAPI importer (`src/web/scripts/import/openapi.js`) never dereferences `$ref` — the string `$ref`
appears nowhere in the file. Consequences:
- **Local `$ref`** into `components/{schemas,parameters,requestBodies,responses}` is silently dropped:
  `$ref`'d parameters are skipped (they have no `.in`) and `$ref`'d request bodies aren't resolved
  (`buildBody` only inspects `requestBody.content`). Real specs (Stripe, GitHub, …) lean heavily on shared
  `components`, so many requests import with **missing params/headers/bodies**.
- **Request bodies import empty** (`bodyText: ""`, ~135-137) — `example`/`examples`/schema are ignored, so
  there's no sample body. Postman/Insomnia synthesize a sample from the schema.

## Goal
Resolve local `$ref`s during OpenAPI import and generate example request bodies from schema/`example`, so
imported requests arrive complete and runnable.

## Implementation steps
1. **`$ref` resolution**: before mapping, walk the document and resolve all **local** (`#/...`) `$ref`s for
   parameters, request bodies, headers, and schemas (handle nested refs; guard against cycles). Remote/URL
   `$ref`s require network I/O the renderer can't do directly — either resolve them via the main-process
   execution path or clearly skip-and-report them (Feature 26), not silently.
2. **Example bodies**: when a request body has `example`/`examples`, use it; otherwise synthesize a minimal
   JSON example from the schema (types, required fields, enums) and set the matching `Content-Type`.
3. **Params/headers from components**: ensure `$ref`'d `parameters` (path/query/header) are merged the same
   as inline ones; carry `required`/`enum` hints where the model supports them.
4. **Tests**: extend `import/tests/import.test.js` with a spec that exercises `components` `$ref`s and
   example generation.

## Acceptance criteria
- A spec using `components` `$ref`s for parameters and request bodies imports with those params/bodies
  present (not dropped).
- Operations with a request body import a non-empty, schema-consistent example body with the right
  Content-Type.
- Remote `$ref`s are either resolved or explicitly reported — never silently lost.
- New importer tests cover `$ref` resolution and example synthesis.

## Constraints
- Keep importer logic in `src/web/scripts/import/`; match the existing module/test structure.
- Any network fetch for remote refs goes through the main process; keep `main.js`/`preload.js` in sync.
- No heavy OpenAPI dependency unless justified; a focused local-`$ref` resolver is preferred.

## Verify
`make fmt && make lint && make test`
