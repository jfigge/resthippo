# Getting Started

[← Back to contents](README.md)

## Installing

Rest Hippo ships as a native desktop app for **macOS**, **Windows**, and **Linux**.
Download the installer for your platform, run it, and launch Rest Hippo — there's
nothing else to set up. Your data lives in a local folder under your user
profile, so requests, environments, and settings persist between sessions.

> Building from source? See the project [README](../README.md) — `make install`
> then `make debug` runs Rest Hippo with hot-reload.

## The interface

Rest Hippo is organized into three panels:

![The three-panel interface](images/overview.png)

1. **Collections** (left) — the tree of saved requests. Switch between the
   **Requests**, **Favorites**, and **Recents** tabs at the top, and press
   <kbd>Cmd</kbd>+<kbd>F</kbd> (<kbd>Ctrl</kbd>+<kbd>F</kbd>) while the tree is
   focused to filter it.
2. **Request** (center) — the method selector, URL bar, and the tabs where you
   define query parameters, headers, the body, authentication, and captures.
3. **Response** (right) — the response status and timing, plus tabs for the
   body, headers, cookies, console, and timeline.

The header holds three controls, from left to right:

| Control            | What it does                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| 🌐 **Environment** | Shows the active environment (e.g. `LOCAL`) and opens the [environments editor](variables-and-environments.md#environments). |
| ▦ **Layout**       | Switches between the four [panel layouts](settings-and-themes.md#layouts).                                                   |
| ⚙ **Settings**     | Opens [Settings](settings-and-themes.md) — theme, fonts, timeouts, proxy, and more.                                          |

You can resize the panels by dragging the dividers between them, and Rest Hippo
remembers the positions.

## Sending your first request

1. **Pick (or create) a request.** Click a request in the tree to load it. To
   make a new one, click the **+** (New Request) button above the tree, or
   right-click a folder and choose **Add Request**.
2. **Choose a method.** Click the method button on the left of the URL bar
   (`GET`, `POST`, …) and pick from the menu.

   ![Choosing an HTTP method](images/method-menu.png)

3. **Enter the URL.** Type into the URL bar. You can use
   [`{{variables}}`](variables-and-environments.md) anywhere — Rest Hippo shows the
   resolved URL beneath the bar when **Show URL preview** is on (Settings →
   Appearance).
4. **Add query params, headers, or a body** in the tabs below (all optional).
   See [Building Requests](requests.md).
5. **Click `Send`** (or press <kbd>Enter</kbd> while the URL bar is focused).

The response appears on the right: the status code and text, the elapsed time,
the response size, and the body — pretty-printed and syntax-highlighted by
default.

![A JSON response](images/overview.png)

> Rest Hippo runs requests **natively**, not through a browser, so you're never
> blocked by CORS. Requests can reach `localhost`, private networks, and any
> scheme the OS allows.

## Diagnostics & logs

Rest Hippo keeps a rotating log of its own activity and errors in a `logs` folder
inside your data directory. It records lifecycle and error events — never your
secret values — and is your starting point if something goes wrong.

From the **Help** menu:

| Item                         | What it does                                                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Reveal Logs**              | Opens the log folder in your file manager.                                                                              |
| **Export Diagnostics…**      | Saves a single `.txt` file containing Rest Hippo's version and build info plus the recent logs — ideal to attach to a bug report. |

If Rest Hippo ever hits an unexpected error it can't recover from, it writes the
details to the log and shows a dialog before closing, so the failure is never
silent.

> **One window at a time.** Rest Hippo runs as a single instance to protect your data.
> Launching a second copy simply brings the existing window to the front instead
> of opening a duplicate.

## Where to go next

- Organize your work into [collections and folders](collections.md).
- Reuse values with [variables and environments](variables-and-environments.md).
- Secure your requests with [authentication](authentication.md).
- Dig into the [response viewer](responses.md).
