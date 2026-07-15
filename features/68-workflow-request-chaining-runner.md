# Feature 68 — Workflow: request chaining & collection runner

## Context
Rest Hippo has the building blocks for multi-step workflows but no way to orchestrate them:
- **Captures** (`src/web/scripts/components/editors/captures-editor.js`) already extract values from a
  response into variables, so data *can* flow from one request to the next.
- **Scripting** (Feature 25 — `src/app/scripting/sandbox.js` + `sandbox-worker.js`) runs pre-request /
  after-response scripts in a sandboxed worker.
- **Assertions** (Feature 29 — the response viewer's Tests tab) validate a single response.
- **Folder run** (`src/web/scripts/event-bus/run-folder-handlers.js`, `hippo:run-folder`) fires every
  request in a folder — but it's fire-all, with no defined order, no data-passing contract, no stop-on-fail,
  and no consolidated report.

What's missing is a **runner**: an ordered sequence of requests executed as a unit, with captured values
flowing downstream, per-step assertions gating the run, optional data-driven iteration, and a persisted
run report. This is Postman's "Collection Runner" / Newman — the feature that turns an API client into a
smoke/regression tool.

## Goal
Add a Workflow Runner that executes an ordered set of requests (a folder, or an ad-hoc sequence),
threads captured variables between steps, evaluates each step's assertions, supports stop-on-failure and
data-driven iteration, and produces a persisted, exportable run report.

## Implementation steps
1. **Run model (main-process orchestration).** Build on the existing send path + sandbox: run steps
   sequentially, resolving `{{var}}` against a **run-scoped variable scope** that captures (Feature 25/
   captures) write into and later steps read from. Per step, run pre-request script → send → after-response
   script → assertions (Feature 29), collecting `{step, name, status, timeMs, assertions[], captured{}}`.
   Support **stop-on-first-failure** vs **continue**. Add IPC `flow:run`, `flow:cancel`, and a
   `flow:progress` push channel; register in `main.js`, expose in `preload.js`.
2. **Ordering & selection.** Let a run target (a) a folder (reuse the folder's child order) or (b) an
   ad-hoc ordered list the user assembles. Persist a named "flow" (ordered request-id list + options) as an
   additive, schema-versioned document alongside collections; add a migration.
3. **Data-driven iteration.** Accept a data file (CSV or JSON array); run the whole sequence once per row,
   exposing the row's fields as run-scoped variables (`{{data.col}}`). Bound the iteration count and surface
   progress; never load an unbounded file into memory unguarded.
4. **Runner UI.** A run panel (modal or dedicated view) showing the ordered steps, a data-file picker, run/
   cancel controls, live per-step progress, and a results summary (passed/failed/skipped counts, total
   time). Each step expands to its assertion results and captured values. Use `theme.css` status tokens.
5. **Report persistence & export.** Persist each run into history/timeline so a past run is replayable and
   its pass/fail is visible on the Timeline (extend Feature 45). Export the report as **JSON** and **JUnit
   XML** so it can be consumed by CI.
6. **Surfacing & errors.** Reflect overall pass/fail prominently; route runner/engine errors through the
   notification system (Feature 26) — never fail silently.
7. **User guide.** Add a "Running workflows" page covering chaining via captures, ordering, data-driven
   runs, and CI export.

## Acceptance criteria
- A user can run an ordered sequence where step 2 consumes a value captured from step 1's response.
- Each step shows its assertion pass/fail; the run summary shows passed/failed/skipped + total time.
- Stop-on-failure halts the run at the first failing step; "continue" runs all and reports every failure.
- A data-driven run executes the sequence once per CSV/JSON row with row fields available as variables.
- The run report persists (visible/replayable from the Timeline) and exports to JSON and JUnit XML.
- Cancelling a run stops cleanly with no dangling requests or listeners.

## Constraints
- Reuse the Feature 25 sandbox, Feature 29 assertions, and the captures→variable path — do **not** add a
  second scripting or assertion engine.
- Orchestration and file reads live in the **main process**; renderer talks only over `window.hippo.*` IPC.
  Keep `main.js`/`preload.js` in sync.
- Flow documents + persisted reports are additive and schema-versioned (coordinate with `migrations.js`);
  keep history shape backward-compatible.
- Plain DOM + class-based ES modules; status colors from `theme.css`; every user string via `t()` and
  translated into all seven catalogs.

## Verify
`make fmt && make lint && make test`, then `make debug`: build a 2-step flow (capture → reuse), run it,
confirm the report + Timeline entry, then run it data-driven over a small CSV and export JUnit.
