# Feature 55 — Mock server (collection-backed)

## Context
resthippo has no way to *serve* an API — only to call one. Postman and Insomnia both let you stand up a
mock server so a frontend or test suite can run before the real backend exists. resthippo is well placed
to do this: the main process already owns native HTTP (`src/app/net/http-engine.js`), imports `net`, and
has `findFreePort()`/`isPortFree()` helpers, and **real responses are already persisted** at
`collections/<collId>/responses/<reqId>/<histId>.json`. What's missing is (a) a saved-response concept on
the request, (b) a local HTTP server, and (c) main-process templating (the pill resolver is renderer-only).

The chosen model mirrors Postman: **bind a mock server to an existing collection** rather than introduce a
separate mock object type. Each request gains a set of saved responses; launching the server turns the
collection into a runnable default test API on `localhost`.

## Goal
From a collection, define one or more saved responses per request and **launch a local HTTP mock server**
that answers incoming requests by matching method + path against the collection and returning the selected
response — with variable/Faker templating, request echo, and a small stateful store for POST→GET round-trips.

## Design decisions (settled — do not relitigate)
- **Reference an existing collection** (Postman model); no separate mock entity. Responses live *with* the
  request (an overlay), so the mock stays in sync with the collection as it's edited.
- **Routes are derived from requests, not equated with them.** Route on the URL **path only** — strip the
  host / `{{baseUrl}}` prefix (parse the resolved URL, keep `pathname`) — and turn concrete paths into
  patterns using the request's existing `pathParams` (`/users/123` → `/users/:id`).
- **One request → many responses + a selection rule.** Ship simple first: a per-request **active** response
  plus an `x-mock-response-name` header override (select by name). **Defer** Postman-style fuzzy path
  scoring and request-body/header matching to a later pass.
- **Templating runs in the main process** (the server must answer autonomously). Extract the renderer pill
  resolver into a shared core both sides can call.
- **Differentiator: a stateful store.** An in-memory KV table in main lets a POST persist a value and a
  later GET read it back — something Postman only offers in local mode and Insomnia not at all.
- **Security:** bind to `127.0.0.1` only by default; never `0.0.0.0` without an explicit opt-in.

## Implementation steps
1. **Saved-response data model.** Add a `mockResponses: []` array to the request record
   (`src/app/store/request-store.js` shape). Each entry: `{ id, name, status, statusText, headers, body,
   contentType, active }`. It rides inside the request file, so it inherits encrypt-at-rest automatically
   (`CollectionRepository`). Store per-collection mock config (chosen/last port, base path, bind host) in the
   collection's `metadata.json`.
2. **Promote-from-history action.** Add "Save as mock response" in the response viewer / history, reading the
   already-persisted `responses/<reqId>/<histId>.json` and appending a `mockResponses[]` entry (maps status,
   headers, body). This is the highest-value, lowest-cost entry point — wire it early.
3. **Route table derivation.** Build `{ method, pathPattern, requestId, responses }[]` from the collection:
   parse each request URL, drop scheme+host, keep `pathname`, and substitute `pathParams` segments with
   `:name` matchers. Preserve `tree.json` order for first-match tie-breaking.
4. **Mock server (main).** New `src/app/mock/mock-server.js` using `http.createServer()`; bind via
   `findFreePort()` (or the configured port) to `127.0.0.1`. Per request: match method + path → select a
   response → template → send (status/headers/body). Lifecycle: start/stop; stop on app quit; one server at a
   time (the active collection).
5. **Selection / matching.** Choose the request's `active` response; honor `x-mock-response-name` to pick by
   name; first-match (declaration order) when multiple requests map to the same method+pattern. No scoring yet.
6. **Main-process templating.** Extract the pure logic of `variable-resolver.js` into a shared module (e.g.
   `src/app/mock/template.js` or a `src/shared/` core imported by both renderer and main). Resolve `{{var}}`
   against collection/environment/global variables (read from the stores in main), add Faker-style functions
   (`{{$randomFullName}}`, `{{$uuid}}`, …), and request echo (`{{req.body.*}}`, `{{req.query.*}}`,
   `{{req.params.*}}`).
7. **Stateful store.** An in-memory `Map` in main with `get/set/delete/clear`, exposed to templates so a POST
   route can persist and a GET route read back. Provide a `mock:state:clear` IPC. (Can land as a second pass
   after 1–6 prove out.)
8. **UI.** (a) A collection-level "Start/Stop mock server" control (menu or toolbar) showing running state,
   port, and a copyable base URL; broadcast `hippo:mock-started` / `hippo:mock-stopped`. (b) A "Responses"
   section in the request editor to add/edit/select saved responses (name, status, headers, body, active
   toggle), reusing `PillCodeEditor` for the body. (c) The promote action from step 2.
9. **IPC.** Add `mock:start` (collectionId, opts) → `{ port, baseUrl }`, `mock:stop`, `mock:status`,
   `mock:state:clear`. Register in `src/app/main.js` (or an `src/app/ipc/*.js` module) and expose via
   `src/app/preload.js` as `window.hippo.mock.*` — keep the two in sync.
10. **i18n + user guide + headers.** Route every new string through `t()` and translate into all 7 catalogs
    in the same change. Add a `mocking.md` user-guide page and register it in the `PAGES` arrays of both
    `scripts/build-docs.mjs` and `src/web/scripts/components/docs-viewer.js`. Stamp the Apache header on every
    new `src/app/` / `src/web/scripts/` file (`make license-headers`).

## Acceptance criteria
- A collection can be launched as a mock server on `127.0.0.1:<port>`; the base URL is shown and copyable.
- `curl`-ing a path defined by a request returns that request's active saved response (status/headers/body),
  including parameterized paths via `:param` matchers.
- `x-mock-response-name` selects an alternate saved response by name.
- Response bodies template `{{var}}`, Faker functions, and request echo at request time.
- A POST can store a value the server returns on a later GET (stateful store), cleared via the app.
- Unmatched routes return a clear 404; the server binds to localhost only by default.
- All new UI strings are localized into all 7 locales; the user guide has a mocking page; new files carry the
  license header; `make test` is green.

## Constraints
- No framework; plain DOM + class-based ES modules. Reuse `PopupManager`, `PillCodeEditor`, the shared
  variable resolver, and `findFreePort()` — don't reimplement.
- Native HTTP/socket lifecycle stays in the **main** process; renderer talks only over `window.hippo.*`.
- CSS via `theme.css` tokens; component styles in `components.css`; class naming per CLAUDE.md
  (`prefix-name` elements, `block--modifier` state).
- Bind to `127.0.0.1` by default; treat exposing on `0.0.0.0` as an explicit, warned opt-in.
- Defer fuzzy path scoring and body/header matching — ship active-response + name-override first.

## Verify
`make fmt && make lint && make test`, then in `make debug`: create a collection with a couple of requests,
add/promote saved responses, start the mock server, and `curl` the base URL to confirm path matching,
`:param` routes, `x-mock-response-name` selection, templating/Faker/echo, a POST→GET state round-trip, and a
404 for an unknown path. Stop the server and confirm the port is released.
