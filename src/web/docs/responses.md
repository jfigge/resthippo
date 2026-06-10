# Reading Responses

[← Back to contents](README.md)

When a request returns, the right panel fills in. The **status bar** at the top
shows the status code and text, the elapsed time, and the response size — plus a
**captured** badge if any [captures](variables-and-environments.md#captures) ran.

![A JSON response](images/overview.png)

Below the status bar, a row of tabs organizes the response: **Body**,
**Preview**, **Headers**, **Cookies**, **Console**, and **Timeline**.

## Body

The **Body** tab renders the response according to its content type. By default
it's **Styled** — pretty-printed and syntax-highlighted:

- **JSON / YAML / XML / HTML** — indented and colorized
- **Markdown** — rendered
- **JavaScript / CSS** — colorized
- **Images** — shown inline:

  ![An inline image response](images/response-image.png)

- **Binary** — shown as a hex dump

**Secondary-click (right-click) the `Body` tab** for options: switch the render
mode between **Styled**, **Raw** (plain monospace), and **Hex**; **Copy** the
body; **Download** it (wurl picks an extension from the content type); or **Copy
as cURL** to reproduce the whole request on the command line.

### Preview

For HTML and Markdown responses, the **Preview** tab renders the content live in
a sandboxed view, so you can see the page as a browser would. Any `console.log`
output the page produces is captured on the **Console** tab.

> PDF responses open in wurl's built-in PDF viewer with zoom and page
> navigation.

## Headers

The **Headers** tab lists every response header as a name/value table:

![The response Headers tab](images/response-headers.png)

## Cookies

The **Cookies** tab parses the response's `Set-Cookie` headers into a table —
name, value, domain, path, and the `Secure` / `HttpOnly` / `SameSite` / `Expires`
attributes. If the collection has [cookie sending](collections.md#cookies)
enabled, these cookies are stored and reused on later requests.

## Timeline

The **Timeline** tab keeps a short history of the request's recent runs. Each
entry records the status, timing, and a snapshot of what was sent — method, URL,
parameters, headers, and auth — so you can compare runs and reopen an earlier
response:

![The response timeline](images/response-timeline.png)

How many runs are kept is configurable in
[Settings → History](settings-and-themes.md#history).

## Searching the body

Press <kbd>⌘/Ctrl</kbd>+<kbd>F</kbd> with the response focused to open the
**Find** bar:

![Searching within a response](images/response-search.png)

- Type to highlight matches; the counter shows the active match and the total.
- <kbd>Enter</kbd> / <kbd>Shift</kbd>+<kbd>Enter</kbd> jump to the next/previous
  match.
- Toggle **case-sensitive** and **regex** matching.
- <kbd>Esc</kbd> closes the bar.

<kbd>⌘/Ctrl</kbd>+<kbd>A</kbd> selects the whole body text (when the find box
isn't focused).

---

Next: [Import, Export & Backup →](import-export-and-backup.md)
