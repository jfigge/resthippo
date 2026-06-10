# Import, Export & Backup

[← Back to contents](README.md)

wurl can exchange collections with other tools and back up your entire
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
| **Postman v2.1** | Postman collection. Re-imports into Postman and back into wurl. |
| **Insomnia v4**  | Insomnia export. Re-imports into Insomnia and back into wurl.   |
| **OpenAPI 3**    | A best-effort, lossy OpenAPI 3.0 description of the requests.   |
| **HAR 1.2**      | Recorded request/response exchanges from recent runs.           |

Secrets — passwords, tokens, and keys — are **redacted** in every export format,
so exports are safe to share. wurl then opens a native save dialog.

## Importing

To import, open the import dialog and pick a file. wurl recognizes:

- **Postman** collections
- **Insomnia** exports
- **OpenAPI 3** specifications
- **cURL** commands
- **HAR 1.2** files

It reconstructs the folder structure, requests, headers, auth, and variables,
and adds them to your workspace.

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
