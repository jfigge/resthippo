# Feature 29 — Test assertions & results panel

## Context
Rest Hippo can send requests and render responses but cannot **validate** them. The response viewer
(`src/web/scripts/components/response-viewer.js` `TABS`) has Body/Preview/Headers/Cookies/Console/Timeline
— but no test-results surface. There is no pass/fail concept, so Rest Hippo can't be used for API smoke tests or
regression checks. Request-body syntax validation exists for the *editor* only (`#validate`), nothing
checks *responses*.

## Goal
Let users attach assertions to a request and see per-request pass/fail results after each send, building on
the scripting runtime from Feature 25.

## Implementation steps
1. **Authoring**: in the after-response context (Feature 25), expose a tiny test API —
   `hippo.test(name, fn)` plus an `expect`-style helper (status, header, json-path value, response time,
   body contains). Persist alongside `afterResponseScript`. Optionally add a no-code "quick assertions"
   grid (field → matcher → expected) that compiles down to the same checks for non-scripters.
2. **Execution**: run assertions in the main-process sandbox right after the response is received; collect
   `{name, passed, message}[]`. Never throw out to the user silently — surface engine errors via
   Feature 26.
3. **Results UI**: add a **Tests** tab to the response viewer showing each assertion's pass/fail with a
   summary count and color from `theme.css` status tokens. Persist results into the history entry so the
   Timeline shows whether a past run passed.
4. **Status surfacing**: reflect overall pass/fail in the response status bar (e.g. a small badge next to
   status/time/size).
5. Update user guide

## Acceptance criteria
- A request with assertions shows per-assertion pass/fail after sending, with a summary count.
- Assertions can check status, a header, a JSON-path value, response time, and body content.
- Results persist in history and are visible when replaying a Timeline entry.
- A failing assertion is unmistakable (badge + Tests tab), and assertion-engine errors are surfaced.

## Constraints
- Reuse the Feature 25 sandbox/runtime; do not add a second scripting path.
- Plain DOM + class-based ES modules; status colors from `theme.css`.
- Keep the persisted history shape backward-compatible (additive fields; coordinate with schema
  versioning).

## Verify
`make fmt && make lint && make test`
