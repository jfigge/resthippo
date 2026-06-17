# Import, Export & Backup

[← Back to contents](README.md)

Rest Hippo can exchange collections with other tools and back up your entire
workspace. There are two separate features:

- **Import / Export** moves _collections_ in and out using standard interchange
  formats. Secrets are **redacted**.
- **Backup / Restore** snapshots your _whole workspace_ — collections,
  environments, and settings — with a choice of how to handle secrets.

## Exporting

Export a single collection from its right-click menu (**Export…**), or export
everything at once:

![The export dialog](images/export-modal.png)

Choose a format:

| Format           | Notes                                                           |
| ---------------- | --------------------------------------------------------------- |
| **Postman v2.1** | Postman collection. Re-imports into Postman and back into Rest Hippo. |
| **Insomnia v4**  | Insomnia export. Re-imports into Insomnia and back into Rest Hippo.   |
| **OpenAPI 3**    | A best-effort, lossy OpenAPI 3.0 description of the requests.   |
| **HAR 1.2**      | Recorded request/response exchanges from recent runs.           |

Secrets — passwords, tokens, and keys — are **redacted** in every export format,
so exports are safe to share. Rest Hippo then opens a native save dialog.

## Importing

Open **File → Import Collection…** and pick a file. Rest Hippo recognizes the format
automatically:

- **Postman** collections (`.json`)
- **Insomnia** exports (`.json` / `.yaml`)
- **OpenAPI 3** / Swagger 2.0 specifications (`.json` / `.yaml`)
- **HAR 1.2** captures (`.har`)

The file picker filters to these formats — `.json`, `.yaml` / `.yml`, and
`.har`. On macOS, hovering the **Import Collection…** menu item also shows this
list as a tooltip (native menu tooltips are a macOS-only feature, so on Windows
and Linux this page is the reference).

It reconstructs the folder structure, requests, headers, query, auth, and
variables, and adds them to your workspace as a new collection. A **HAR**
capture (a browser's "Save all as HAR", or a proxy export) is imported request
by request — grouped into a folder per host — so you can replay real traffic;
only the requests are imported, not the recorded responses.

### Import from cURL

To pull in a single request from a terminal, API docs, or a browser's **Copy as
cURL**, choose **File → Import from cURL…** and paste the command:

```
curl https://api.example.com/users \
  -H 'Authorization: Bearer ...' \
  -d '{"name":"Ada"}'
```

Rest Hippo parses the method, URL and query, headers, body (`-d` / `--data*`,
`--data-urlencode`, and `-F` form fields), and authentication — a `-u user:pass`
or an `Authorization: Bearer`/`Basic` header is lifted into the request's **Auth**
tab rather than left as a raw header. The result is added as a new collection,
ready to send.

> **Tip — paste a cURL straight onto a request.** You can also paste a `curl …`
> command directly into a request's **URL bar**. Rest Hippo recognizes it and rewrites
> that request to match the command (method, URL, params, headers, body, auth),
> instead of dropping the raw text into the field. A brand-new, empty request is
> updated in place; if the request already has content, Rest Hippo asks you to confirm
> before overwriting it.

## Backup & restore

A **backup** captures your complete workspace in one file. Open it from the
app's File menu (**Back up…** / **Restore…**).

![The backup dialog](images/backup-modal.png)

When creating a backup, choose how secrets are handled:

| Mode                   | Secrets                                                                         | Restores on…                                      |
| ---------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------- |
| **Redacted**           | Removed entirely                                                                | Anywhere — safe to share or move between machines |
| **This machine only**  | Encrypted with the OS keystore (Keychain / Credential Manager / Secret Service) | Only this machine                                 |
| **Password-protected** | Encrypted with a password you choose                                            | Anywhere, with the password                       |

**Restoring** reads a backup file (prompting for the password if it's
password-protected) and lets you **Merge** it alongside your current collections
or **Replace** everything with the backup's contents.

> Use **This machine only** for routine local backups (no password to remember),
> and **Password-protected** when you need to move a full workspace — secrets and
> all — to another machine.

---

Next: [Settings & Themes →](settings-and-themes.md)
