# Functions

[← Back to contents](README.md)

Functions are dynamic `{{ }}` tokens that compute a value **at send time** instead
of looking one up from a [variable](variables-and-environments.md). Use them to
stamp a request with a fresh UUID, the current timestamp, a Base64-encoded
credential, an HMAC signature, or a value pulled from another request's response.

Where a `{{variable}}` resolves to a stored value, a function like `{{uuid()}}`
**runs** every time the request is sent — so each send gets a new result.

## Inserting a function

Type `{{` in any field to open the **typeahead**. Below your variables it lists
the available functions, grouped into sections:

![The {{ typeahead, listing variables and functions](images/variable-typeahead.png)

Pick a function and Rest Hippo inserts it as a highlighted **pill**. If the
function takes arguments, the **pill editor** opens so you can fill them in; click
an existing function pill any time to edit its arguments again.

Under the hood a function pill is just text in the form
`{{name("arg1", "arg2")}}` — arguments are positional and double-quoted — so you
can also type one by hand. `{{uuid()}}` takes no arguments; `{{now("Unix")}}`
takes one.

## Built-in functions

General-purpose helpers that resolve instantly, with no network or context needed.

| Function                       | Result                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| `uuid()`                       | A random **UUID v4**, e.g. `9f1c…-…`. A fresh one on every send.                         |
| `now("ISO")`                   | The **current timestamp**. Format: `ISO` (default), `Unix` (seconds), `UnixMs` (milliseconds), or `RFC2822`. |
| `base64encode("value")`        | **Base64-encode** the value (UTF-8 safe).                                                |
| `base64decode("value")`        | **Base64-decode** the value.                                                             |
| `urlEncode("value")`           | **Percent-encode** the value for use in a URL.                                           |
| `urlDecode("value")`           | **Percent-decode** the value.                                                            |
| `randomInt("0", "100")`        | A **random integer** between min and max, inclusive (defaults `0`–`100`).                |

Arguments can themselves contain variables — e.g. `{{base64encode("{{user}}:{{pass}}")}}`
builds a Basic-auth credential from two variables.

## Context functions

These read from **where the request lives** and the active environment. They take
no network round-trip.

| Function               | Result                                                                       |
| ---------------------- | ---------------------------------------------------------------------------- |
| `collectionName()`     | The name of the active **collection**.                                       |
| `requestName()`        | The name of the **current request**.                                        |
| `environmentName()`    | The name of the active **environment**.                                     |
| `folderName("0")`      | An **ancestor folder's** name. `0` is the immediate parent, `1` its parent, and so on. |

## Request Outputs

Chain requests together: pull a value **out of another request's response** and
feed it into this one. Reference the source request by name.

| Function                                   | Result                                                                 |
| ------------------------------------------ | --------------------------------------------------------------------- |
| `response("Login", ".data.token")`         | A value from the named request's **response body**. The second argument is a dot-path (`.data.token`, `.items.[0].id`); `.` returns the whole body. |
| `responseHeader("Login", "Location")`      | A single **response header** from the named request.                  |
| `responseStatus("Login")`                  | The **HTTP status code** of the named request's last response.        |
| `run("Seed data")`                         | **Runs** the named request before this one. It produces no text of its own (it resolves to an empty string) — use it purely to trigger a prerequisite. |

The dot-path is the same syntax as [response captures](variables-and-environments.md#captures)
and works over JSON, YAML, or XML bodies.

### Refresh mode

`response`, `responseHeader`, and `responseStatus` each have a **Refresh mode**:

- **Use last result** (default) — read the value from the source request's most
  recent response, without re-sending it. Fast, but the source must have been run
  at least once.
- **Run immediately before** — send the source request first, every time, then
  read from its fresh response. Use this when the value is short-lived (e.g. a
  one-time token) and must be current on every send.

## Backend functions

These run in Rest Hippo's main process (where the crypto and OS APIs live) and
resolve asynchronously.

| Function                                       | Result                                                                  |
| ---------------------------------------------- | ----------------------------------------------------------------------- |
| `hmac("SHA256", "key", "message")`             | An **HMAC** signature. Algorithm: `SHA256` (default) or `SHA512`.       |
| `hash("SHA256", "value")`                      | A **hash** of the value. Algorithm: `SHA256` (default) or `SHA512`.     |
| `environmentVariable("RESTHIPPO_API_KEY")`     | An **OS environment variable**. For safety, only names beginning with `RESTHIPPO_` are readable — any other name returns empty, and the prefix is *not* stripped. |

`environmentVariable` lets you keep a secret out of your stored collection
entirely: export `RESTHIPPO_API_KEY=…` in your shell before launching Rest Hippo,
then reference it with `{{environmentVariable("RESTHIPPO_API_KEY")}}`.

---

Next: [GraphQL →](graphql.md)
