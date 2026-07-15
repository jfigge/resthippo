# Feature 25 — Pre-request & after-response scripting (sandboxed JS)

## Context
Rest Hippo has no real scripting. The "function" system (`src/web/scripts/components/function-logic-map.js`,
`function-registry.js`, `function-backend.js`) only resolves a fixed set of value tokens
(`{{uuid}}`, `{{now}}`, `{{hmac(...)}}`, `{{response("Req", ".path")}}` …); the privileged half is a
hard-coded 4-case `switch` in `src/app/main.js` (~1477-1537). There is **no JS runtime** — no `vm`,
`eval`, or `new Function` anywhere. Request chaining is pull-based and cannot write a value back into a
variable for later steps.

The persistence layer already whitelists `preRequestScript` and `afterResponseScript` in
`src/app/store/request-store.js` (`PATCHABLE_FIELDS`), but these fields are **dead scaffolding** — never
read, written, surfaced, imported, or exported. They are the natural anchor for this feature.

## Goal
Add a **pre-request script** (runs before send) and an **after-response script** (runs after receive),
each executed in a sandboxed JS runtime with a small, documented `hippo.*` API for reading/mutating the
request, reading the response, and getting/setting variables across scopes.

## Implementation steps
1. **UI**: add a `Scripts` tab to the request editor (alongside Params/Headers/Body/Auth/Notes —
   `src/web/scripts/components/request-editor.js` `TABS`), with two code areas (pre / post). Reuse the
   existing Prism-highlighted text-editor pattern from the body editor. Persist into the already-present
   `preRequestScript` / `afterResponseScript` fields (no schema change needed).
2. **Runtime (main process only)**: execute scripts in a locked-down `vm` context (or a worker) — never
   `eval`/`new Function` in the sandboxed renderer. Register the channel(s) in `main.js` and expose via
   `preload.js`. Deny `require`, `process`, fs, and network from the script context.
3. **API surface** (`hippo.*`): `variables.get/set(scope, name, value)` (scopes per
   `variable-resolver.js`), `request` (method/url/headers/body — mutable in pre), `response`
   (status/headers/body — read in post), `environment`, and `console.log/info/warn/error` routed to the
   response **Console** pane.
4. **Execution order**: resolve variables → pre-request script (may mutate request + set vars) → send →
   after-response script (may read response + set vars). Variable writes flow back through the store.
   Script errors must surface through Feature 26 (not be swallowed). This is the runtime that Feature 29
   (test assertions) builds on.

## Authoring experience (how users learn, write, validate & test scripts)

These steps make the feature usable, not just runnable. They are part of this feature, not optional polish.

5. **Editor — reuse `PillCodeEditor` in a JavaScript mode.** Mount the pre/post code areas with
   `PillCodeEditor` (`src/web/scripts/components/pill-code-editor.js`), the same component the Body and
   GraphQL editors use, configured `{ language: "javascript", multiline: true, lineNumbers: true,
   externalErrors: true }`. Two one-line wiring changes are needed: add `javascript: "javascript"` to the
   `PRISM_LANG` map and include `"javascript"` in the validated-language handling. **No `make vendor-prism`
   rebuild** — the `prism-javascript` grammar is already in the bundle (`prism-entry.js`). `{{variable}}`
   pills and the `{{` typeahead come for free from `PillCodeEditor`, so scripts can interpolate variables
   the same way as the rest of the app.

6. **`hippo.*` API reference in the User Guide (required).** Add a new page
   `src/web/docs/scripting.md` and register it in the `PAGES` array in
   `src/web/scripts/components/docs-viewer.js` (`{ slug: "scripting", title: "Scripts" }`), with a
   `Next:` link added to the preceding page and from this page onward — matching the tone/structure of the
   existing pages (e.g. `requests.md`). It must contain:
   - What pre-request vs after-response scripts are, and the execution-order diagram from step 4.
   - A **complete `hippo.*` API reference table** — one row per member, columns: **signature**,
     **parameters** (name · type · required), **returns** (type), **available in** (pre / post / both),
     and a one-line description. The surface (keep this the single source of truth shared with the
     autocomplete dictionary in step 7 and the API impl in step 3):

     | Member | Params | Returns | Avail | Notes |
     | --- | --- | --- | --- | --- |
     | `hippo.variables.get(scope, name)` | `scope`: `"global"\|"environment"\|"collection"\|"folder"` · `name`: string | `string \| undefined` | both | Reads a resolved variable. `"folder"` = nearest enclosing folder. |
     | `hippo.variables.set(scope, name, value)` | `scope` (as above) · `name`: string · `value`: string | `void` | both | Write flows back through the store for later steps. |
     | `hippo.request.method` / `.url` / `.headers` / `.body` | — | string / string / object / string | both | **Mutable in pre** (changes the outgoing request); read-only snapshot in post. |
     | `hippo.response.status` / `.headers` / `.body` | — | number / object / string | **post only** | Throws/undefined if read in a pre-request script. |
     | `hippo.response.json()` | — | parsed value | post only | Convenience parse of a JSON body; throws on non-JSON. |
     | `hippo.environment` | — | `{ name, variables }` | both | Active environment (read). |
     | `hippo.console.log/info/warn/error(...args)` | `...args`: any | `void` | both | Routed to the response **Console** pane. |

   - Two **worked examples**: (a) a pre-request script that sets an auth token variable the request then
     uses; (b) an after-response script that reads `hippo.response.json()` and captures a value into a
     variable consumed by a later request.
   - A **sandbox limits** note (no `require` / `process` / fs / network) and how script errors appear.
   - Screenshots via the `.docs-build` CDP pipeline. The guide stays **English-by-design** (per the docs
     convention) — translate the in-app UI strings, not the Markdown pages.

7. **In-editor autocomplete for `hippo.*` (SHOULD — keep minimal; defer if it balloons).** Offer
   completion of the documented API members while typing in the Scripts editors, rendered through the
   existing `PillPicker` dropdown widget (`pill-picker.js`). Scope it deliberately small: a **static
   completion dictionary** generated from the same surface table as step 6 (members of `hippo`,
   `hippo.variables`, `hippo.request`, `hippo.response`, `hippo.console`, plus the four scope-name string
   literals), each entry showing its signature + one-line hint. Trigger on `.` after a known receiver and
   on identifier prefixes. **No full JS semantic analysis.** This needs a new member-access trigger in
   `PillPickerController` (the current trigger is `{{`-only), so timebox it: if it exceeds ~a day, ship
   the feature without autocomplete and file a follow-up. Autocomplete is **not** an acceptance gate.

8. **Auto-validation with inline error squiggles (live + post-run).** The Scripts editors run
   `externalErrors: true`; the host pushes errors via `editor.setErrors([{ line, col, length, message }])`
   — reusing the squiggle + hover-tooltip overlay `PillCodeEditor` already renders (the same path
   `graphql-body-editor.js` uses).
   - **Syntax (live, debounced as the user types):** send the script text to the main process and compile
     it with `new vm.Script(src)` **compile-only, never executed**; map the thrown `SyntaxError`'s
     location to one squiggle. Cheap — it reuses the sandbox runtime already built in step 2.
   - **Runtime (after execution):** when a script throws at send time, map the error's line back through
     the same `setErrors()` path (alongside the Feature 26 surfacing), so the failing line is marked in
     the editor, not just reported in a toast/console.

9. **Empty-state starter snippets.** When a Scripts pane is empty, show a commented example (ghost
   placeholder text or an "Insert example" affordance) — a pre-request snippet that sets a variable and a
   post snippet that captures a response value — so users have a runnable starting point without leaving
   the editor. Route all snippet/placeholder text through `t()`.

10. **i18n (required, same change).** Every new user-facing string — the `Scripts` tab label
    (`request.tab.scripts`), the Pre-request / After-response pane labels, placeholder/empty-state text,
    autocomplete hints, and validation/error messages — goes through `t()` and is translated into all
    seven catalogs (`en, de, es, fr, it, ja, zh`). Add the `Scripts` tab to `TABS` (and `WS_TABS` if
    WebSocket requests should support scripts) in `request-editor.js`.

11. **Feature Test Suite (required, same change).** Add a `folder("NN", "Request scripting", [ … ])`
    entry to the `FEATURES` array in `test-collection/build-test-collection.cjs` exercising: a
    pre-request script that mutates the request + sets a variable (→ `/echo`), an after-response script
    that captures a response value for a later request (→ `/echo`), and a sandbox-denial check. Rebuild
    with `node test-collection/build-test-collection.cjs --system-backup` (app closed).

## Acceptance criteria
- Pre/post scripts persist on the request and round-trip through save/load.
- A pre-request script can mutate the outgoing request and set a variable that the request then uses.
- An after-response script can read the response and set a variable consumed by a later request.
- The sandbox cannot reach fs, network, `process`, or `require`.
- Script errors are surfaced to the user, never silently dropped.
- The Scripts editor highlights JavaScript and shows **syntax errors as inline squiggles as the user
  types** (before any send), each with a hover message; a runtime error marks the offending line too.
- The User Guide has a `scripting` page reachable via **Help → User Guide** that documents **every**
  `hippo.*` member with its parameters, return type, and pre/post availability, plus two worked examples.
- All new user-facing strings are present in all seven locale catalogs (no English fallback).
- A `test-collection` folder exercises pre/post scripting and a sandbox-denial check.
- _(If shipped)_ typing `hippo.` in a Scripts pane offers completion of the documented API members. This
  one is best-effort, not a gate (step 7).

## Constraints
- Sandbox runs in the **main process**; no arbitrary code execution in the renderer.
- Keep the `hippo.*` API small and documented; reuse the four variable scopes from `variable-resolver.js`
  (`folder`, `collection`, `environment`, `global`). The reference table in step 6 is the canonical surface
  — the docs page, the autocomplete dictionary (step 7), and the runtime impl (step 3) must not drift apart.
- Reuse `PillCodeEditor` for the editor and its `externalErrors`/`setErrors()` overlay for squiggles — do
  not hand-roll a code editor or a second error-marker system. The JS Prism grammar is already bundled.
- Autocomplete (step 7) is a timeboxed SHOULD, not a MUST. Validation squiggles (step 8) and the User
  Guide page (step 6) are MUSTs.
- Plain DOM + class-based ES modules; CSS tokens from `theme.css`. Keep `main.js`/`preload.js` in sync.

## Verify
`make fmt && make lint && make test`
