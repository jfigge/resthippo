# Settings & Themes

[← Back to contents](README.md)

Open **Settings** from the ⚙ button in the header. Settings are grouped into
panels down the left side and **save as you change them** — there's no separate
save step.

## Appearance

![Settings — Appearance](images/settings-appearance.png)

| Setting              | What it does                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| **Theme**            | The color theme (see [Themes](#themes)).                                                               |
| **Editor font size** | Size of text in the code editors (11–18 px).                                                           |
| **UI font**          | The interface typeface — **Inter** (bundled) or a system font.                                         |
| **Remove headers**   | Hides the top header bar and moves its controls into the collections panel, for a more compact window. |
| **Method icons**     | Show HTTP method badges as compact icons instead of text.                                              |
| **Show recents**     | Show or hide the [Recent](collections.md#favorites-and-recent) tab.                                    |

There's also a **code folding** toggle for the editors, and you can change the
font size anywhere with <kbd>⌘/Ctrl</kbd>+<kbd>+</kbd> /
<kbd>-</kbd> / <kbd>0</kbd>.

## Request

![Settings — Request](images/settings-request.png)

| Setting                              | What it does                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------ |
| **Timeout (ms)**                     | How long to wait before giving up on a request.                                |
| **Picker debounce (ms)**             | Delay before the `{{` typeahead appears.                                       |
| **Follow redirects**                 | Automatically follow 3xx redirects.                                            |
| **Double-click requests to execute** | Double-clicking a request in the tree loads _and_ sends it.                    |
| **Verify SSL certificates**          | Reject invalid/self-signed certificates. Turn off to test against dev servers. |

## Proxy

Route requests through an HTTP/HTTPS or SOCKS proxy. Enter a **Proxy URL** (the
scheme — `http://`, `socks5://`, … — selects the proxy type), optionally enable
**proxy authentication** with a username and password, and list hosts to
**bypass** (a `NO_PROXY`-style list supporting suffixes and `*` globs).

## Certificates

Configure mutual TLS (mTLS) and custom trust for hosts that need more than the
system certificate store.

- **Client certificates** — present a certificate to hosts that require mutual
  TLS. Each entry has a **Host** pattern (exact, suffix, or `*` glob, with an
  optional `:port`, matched like the proxy bypass list) and a **Format**: choose
  **PEM** to point at a certificate file plus an optional private-key file, or
  **PFX / P12** for a single bundle. A **passphrase** can be supplied for an
  encrypted key or PFX. The first entry whose host matches a request wins, so
  list a specific host above a broader wildcard. The certificate is also
  presented automatically on redirects to a matching host and on OAuth token
  requests to one.

- **Certificate authorities** — add CA files to trust **in addition to** the
  system roots. This lets a privately-signed host validate with verification
  still on, instead of turning verification off globally.

- **Skip verification for hosts** — a `NO_PROXY`-style list of hosts whose TLS
  certificate is not checked. Use this only for trusted self-signed hosts when a
  custom CA isn't practical; it overrides the global **Verify SSL** toggle for
  those hosts only.

Only file **paths** are stored — Rest Hippo reads the certificate bytes in the
background process when a request is sent. Passphrases are encrypted at rest with
the OS keystore (like other secrets) and are removed from secret-free exports.

## Retries

Automatically retry failed requests with backoff. Configure the **max
attempts**, the **backoff base**, **multiplier**, and **max delay**, and choose
what to retry on — **connection errors**, **timeouts**, and/or a list of
**status codes** (e.g. `429, 503, 504`). Retries are off by default.

## History

Set how many runs each request keeps in its
[**Timeline**](responses.md#timeline) (1–10).

## Layouts

The **layout picker** in **Appearance → Layout** rearranges the three panels
into four configurations — click a layout icon to switch:

![The layout picker](images/layout-picker.png)

| Layout                | Arrangement                                                  |
| --------------------- | ------------------------------------------------------------ |
| **Side by side**      | Collections │ Request │ Response, in three columns           |
| **Left + stacked**    | Collections on the left; Request above Response on the right |
| **Top + full bottom** | Collections and Request on top; Response full-width below    |
| **All stacked**       | The three panels stacked top to bottom                       |

Rest Hippo also adapts automatically to narrow windows, and remembers where you drag
the panel dividers.

## Themes

Rest Hippo ships with four built-in themes — **Mocha** (the default dark theme),
**Grey dark**, **Latte** (light), and **Grey light** — selectable from
**Appearance → Theme**.

For full control, choose **Theme Editor…** from the theme dropdown to open the
editor in its own window. There you can tune every design token — backgrounds,
text, accent and semantic colors — with a live preview, and save your creation
as a custom theme that appears in the theme list. Custom themes can be exported
and imported to share.

> The interface font for **context menus** always uses your OS's native
> typeface (San Francisco, Segoe UI, …); the **UI font** setting controls
> everything else.

---

Next: [Keyboard Shortcuts →](keyboard-shortcuts.md)
