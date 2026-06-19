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
| `hippo.response.status` · `.headers` · `.body` | — | number · object · string | **after-response only** | Reading these in a pre-request script throws — the response doesn't exist yet. |
| `hippo.response.json()` | — | parsed value | after-response only | Parses the response body as JSON; throws if the body isn't valid JSON. |
| `hippo.environment` | — | `{ name, variables }` | both | The active environment (read-only). |
| `hippo.console.log` / `.info` / `.warn` / `.error` | `...args`: any | `void` | both | Logs to the response **Console** tab (see [Console output](#console-output)). |

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
something.

---

Next: [Import, Export & Backup →](import-export-and-backup.md)
