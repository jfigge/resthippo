# Feature 34 — GraphQL body mode

## Context
There is no GraphQL support. Body modes (`src/web/scripts/components/request-editor.js`, serialized in
`request-payload.js`) are Form Data / Form URL-Encoded / JSON / YAML / XML / Text / File / No Body — no
GraphQL option, query editor, or variables pane. GraphQL users must hand-author a raw JSON body with a
manually-escaped `query` string and a `variables` object, which is error-prone.

## Goal
Add a first-class GraphQL body mode with separate **Query** and **Variables** editors that serialize to the
standard `{ query, variables, operationName }` JSON POST, plus optional schema introspection for
autocomplete.

## Implementation steps
1. **Body mode**: add `GraphQL` to the body-type selector. Render two editors — a GraphQL query editor and
   a JSON variables editor — reusing the existing Prism-highlighted editor pattern. On send, serialize to
   `{ query, variables, operationName }` and set `Content-Type: application/json` (respecting a
   user-supplied Content-Type, per existing `request-payload.js` behavior).
2. **Variable interpolation**: support `{{var}}` resolution inside both query and variables before
   serialization.
3. **Introspection (optional but valued)**: a "Fetch schema" action that runs the standard introspection
   query against the URL and caches the schema per request/collection to drive field/argument autocomplete
   in the query editor. Network I/O goes through the existing main-process execution path.
4. **Persistence**: store query + variables on the request; ensure import/export (Postman/Insomnia
   `graphql` body type) round-trips — coordinate with Features 39–41.
5. Add a new set of APIs to mock to support testing all combinations of graphQL  

## Acceptance criteria
- Selecting GraphQL shows Query + Variables editors and POSTs a correct `{query, variables}` JSON body.
- `{{var}}` interpolation works in both panes; Content-Type is set unless the user overrides it.
- Introspection (if implemented) populates autocomplete for the connected schema; failure is surfaced, not
  silent.
- GraphQL bodies persist and survive save/load (and round-trip through import/export where supported).

## Constraints
- Plain DOM + class-based ES modules; reuse the existing body-editor and pill/variable machinery.
- CSS tokens from `theme.css`; styles in `components.css`.
- Keep the persisted request model additive/back-compatible (coordinate with schema versioning).

## Verify
`make fmt && make lint && make test`
