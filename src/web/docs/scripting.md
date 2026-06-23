# Scripts

[← Back to contents](README.md)

The **Scripts** tab on a request lets you run a little JavaScript **before** the
request is sent and **after** the response comes back. Use it to prepare the
outgoing request (set a header, rewrite the URL), to pull a value out of the
response and stash it in a [variable](variables-and-environments.md) for a later
request, or just to log something while you debug.

There are two panes:

- **Pre-request** — runs just before the request is sent. It can change the
  outgoing request and set variables.
- **After-response** — runs as soon as the response arrives. It can read the
  response and set variables.

Both panes are full code editors with JavaScript highlighting; syntax errors are
underlined as you type.

Each pane header has an **Enabled** toggle — a script runs only when its pane is
enabled, so you can keep a script on a request but switch it off without deleting
it. Drag the divider between the two panes to resize them; the split is saved
with the request.

## When scripts run

```
Pre-request script  →  {{variables}} substituted  →  request sent
                                                         ↓
                          variables / UI updated  ←  After-response script
```

Because the pre-request script runs **before** variable substitution, a variable
you set with `hippo.variables.set(...)` is available to the very request you are
sending — `{{thatVariable}}` resolves with the new value. Variables set in either
pane are also saved, so a **later** request can use them too.

## The `hippo` API

Everything a script can do lives under the global `hippo` object. The surface is
small and deliberately sandboxed (see [Sandbox & limits](#sandbox--limits)).

| Member | Parameters | Returns | Available in | Notes |
| --- | --- | --- | --- | --- |
| `hippo.variables.get(scope, name)` | `scope`: `"global"` \| `"environment"` \| `"collection"` \| `"folder"` · `name`: string | `string \| undefined` | both | Reads a variable from a specific scope. |
| `hippo.variables.set(scope, name, value)` | `scope`: `"global"` \| `"environment"` \| `"collection"` · `name`: string · `value`: string | `void` | both | Writes a variable; the value is saved for later requests. `"folder"` is **read-only** — `set` throws. |
| `hippo.request.method` · `.url` · `.headers` · `.body` | — | string · string · object · string | both | **Mutable in the pre-request script** (changes the outgoing request); a read-only snapshot in the after-response script. In the pre-request pane these still contain `{{templates}}` — they are substituted after your script runs. |
| `hippo.response.status` · `.time` · `.headers` · `.body` | — | number · number (ms) · object · string | **after-response only** | Reading these in a pre-request script throws — the response doesn't exist yet. `.time` is the elapsed response time in milliseconds. |
| `hippo.response.json()` | — | parsed value | after-response only | Parses the response body as JSON; throws if the body isn't valid JSON. |
| `hippo.environment` | — | `{ name, variables }` | both | The active environment (read-only). |
| `hippo.run(requestName)` | `requestName`: string **literal** | `{ status, time, headers, body, json() }` | both | Runs another saved request **by name** and returns its response (same shape as `hippo.response`). The name must be a string literal — see [Run another request](#example-run-another-request-first-pre-request). |
| `hippo.console.log` / `.info` / `.warn` / `.error` | `...args`: any | `void` | both | Logs to the response **Console** tab (see [Console output](#console-output)). |
| `hippo.test(name, fn)` | `name`: string · `fn`: function | `void` | after-response | Runs `fn` as a named test; if it throws, the test fails (see [Test assertions](#test-assertions)). |
| `hippo.expect(value)` | `value`: any | matcher | after-response | Returns a matcher with `.toBe` / `.toEqual` / `.toContain` / `.toBeLessThan` / `.toBeGreaterThan` / `.toMatch` / `.toBeTruthy` / `.toBeFalsy` (and `.not`), each throwing on mismatch. |

> **Scopes** follow the same precedence as everywhere else in Rest Hippo:
> folder → collection → environment → global. `get` can read any of the four;
> `set` writes to global, environment, or collection (folder variables are
> read-only from a script).

## Example: prepare the request (pre-request)

```js
// Build an Authorization header from an environment variable.
const key = hippo.variables.get("environment", "apiKey");
hippo.request.headers["Authorization"] = "Bearer " + key;

// Or set a variable and reference it as {{token}} in the URL / headers — it is
// substituted into THIS request because the script runs before substitution.
hippo.variables.set("environment", "token", "abc123");
```

## Example: run another request first (pre-request)

`hippo.run("Name")` runs another saved request and hands you back its response,
so a script can chain a dependency — log in, grab a token, and use it on the
request you are about to send:

```js
// Log in first, then carry the token on this request.
const res = hippo.run("Login");
if (res.status === 200) {
  hippo.request.headers["Authorization"] = "Bearer " + res.json().token;
}
```

The returned response has the same shape as
[`hippo.response`](#the-hippo-api): `status`, `time` (ms), `headers`, `body`,
and `json()`.

> The request name must be a **string literal** — Rest Hippo finds and runs it
> _before_ your script does, so a computed name like `hippo.run(someVariable)`
> can't work and throws. The named request runs with its own saved settings but
> does **not** run its own pre- or after-response scripts, so two requests can't
> recursively trigger each other. `hippo.run` works the same way in an
> after-response script.

> **Duplicate names.** `hippo.run("Name")` matches **by name**, so if two saved
> requests share that name it runs the first one and shows a warning — give them
> distinct names to be sure. The cross-request **function pills** you insert into
> a field (`run`, `response`, `responseHeader`, `responseStatus`) don't have this
> problem: the picker stores the request's **stable id**, so they keep pointing at
> the same request even if you rename it, and the picker shows each request's
> folder path when a name is duplicated so you can tell them apart.

## Example: capture from the response (after-response)

```js
// On success, pull an id out of the JSON body and save it for a later request.
if (hippo.response.status === 200) {
  const body = hippo.response.json();
  hippo.variables.set("collection", "userId", body.id);
  hippo.console.log("captured userId", body.id);
}
```

A following request can now use `{{userId}}` in its URL, headers, or body. (For
simple field extraction without writing code, see also
[Captures](variables-and-environments.md#captures).)

## Test assertions

An after-response script can also **validate** the response, turning a request
into an API check. Use `hippo.test(name, fn)` to declare a named test and
`hippo.expect(value)` for the comparison — if the matcher (or anything inside the
test) throws, the test is marked failed; otherwise it passes. Results appear on
the response **[Tests](responses.md#tests)** tab with a pass/fail badge in the
status bar.

```js
hippo.test("status is 200", () => {
  hippo.expect(hippo.response.status).toBe(200);
});

hippo.test("responds quickly", () => {
  hippo.expect(hippo.response.time).toBeLessThan(500);
});

hippo.test("returns the right user", () => {
  const body = hippo.response.json();
  hippo.expect(body.id).toBe(42);
  hippo.expect(body.roles).toContain("admin");
});
```

Matchers: `toBe` (strict equality), `toEqual` (deep equality), `toContain`
(substring / array member), `toBeLessThan` / `toBeGreaterThan`, `toMatch` (regex),
`toBeTruthy` / `toBeFalsy`. Prefix any with `.not` to invert it, e.g.
`hippo.expect(hippo.response.status).not.toBe(500)`.

> Prefer not to write code? The no-code **[Tests](requests.md#tests)** tab lets
> you build the same checks from a grid of source → matcher → expected rows. Grid
> assertions and scripted `hippo.test()` calls run together and share the one
> Tests tab.

## Console output

`hippo.console.log/info/warn/error(...)` writes lines to the response
**[Console](responses.md)** tab, tagged so you can tell them apart from the HTTP
verbose log. This is the easiest way to see what a script is doing — log a value,
send the request, and read it back on the Console tab.

## Errors

If a script throws, Rest Hippo surfaces it — it is never swallowed:

- An error toast shows the message and the line number.
- The offending line is marked with a red squiggle in the editor.
- A **pre-request** error **cancels the send** — a half-prepared request is never
  sent. Any variable writes from that run are discarded.

## Sandbox & limits

Scripts run in a locked-down sandbox in Rest Hippo's main process. They **cannot**
reach the filesystem, the network, `process`, or `require`, and `eval` / the
`Function` constructor are disabled. A script that loops forever is stopped by a
one-second timeout.

Scripts are **synchronous** — there is no `await` (there's nothing to wait for
inside the sandbox). Keep them small: read a value, set a variable, log
something. Even `hippo.run("…")` is synchronous: Rest Hippo runs the named
request _outside_ the sandbox before your script starts, then hands the response
in — which is why the request name has to be a literal it can spot ahead of time.

---

Next: [Import, Export & Backup →](import-export-and-backup.md)
