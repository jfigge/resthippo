# Feature 20 — Test coverage (renderer, HTTP, vars, import/export)

## Context
Existing tests (~2,900 lines) cover storage and OAuth well, but the following are
**untested**: renderer components, HTTP execution (`main.js`), variable resolution
(`variable-resolver.js` + `function-registry.js` / dynamic functions), and
import/export. The variable resolver and import/export are pure logic and the
cheapest, highest-value places to start. Tests run via Node's built-in runner
(`node --test`, `make test`).

## Goal
Add focused tests for the highest-value untested areas, starting with pure-logic
modules.

## Implementation steps
1. **Variable resolution** (start here): test scope precedence
   (folder → collection → environment → global) and dynamic functions
   (`{{$uuid}}`, timestamps/`now()`, base64/url encode-decode, `randomInt`,
   `hmac`/`hash`, `response()/responseHeader()/responseStatus()`,
   `environmentVariable`, name helpers). Cover unknown-variable and nested cases.
2. **Import/export**: fixture-driven tests — import a known Postman/Insomnia/
   OpenAPI sample and assert the resulting model; export and assert key fields
   round-trip. (Coordinates with Feature 13.)
3. **HTTP execution**: test the request-building/auth-application logic in
   `main.js` against a local mock server (the repo already has a mock server —
   see recent commits); assert method/headers/body/auth signing.
4. **Renderer components**: add at least smoke tests for pure helpers in the
   components (e.g. cURL builder, body serialization). Full DOM/e2e can come later
   (note if Spectron/Playwright-electron is in scope — keep optional).

## Acceptance criteria
- New tests run under `make test` and pass headlessly.
- Variable resolution and import/export each have meaningful coverage with
  fixtures.
- At least one HTTP-execution test exercises auth application against the mock
  server.

## Constraints
- Use the existing `node --test` runner; no new test framework unless justified.
- Keep tests deterministic (no real network; use the mock server / fixtures).

## Verify
`make fmt && make lint && make test`
