# wurl User Guide

**wurl** is a fast, cross-platform desktop REST API client — like Postman or
Insomnia — for building, sending, and inspecting HTTP, GraphQL, and WebSocket
requests. It runs natively (no browser CORS limits), stores everything in local
files, and ships with a built-in theme editor and a bundled UI font.

![The wurl interface](images/overview.png)

This guide walks through everything wurl can do, from sending your first request
to OAuth 2.0, environments, GraphQL schema introspection, and encrypted backups.

## Contents

| Page                                                      | What's inside                                                                  |
| --------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [Getting Started](getting-started.md)                     | Install, the three-panel layout, and sending your first request                |
| [Collections & the Tree](collections.md)                  | Organizing requests into collections and folders; Favorites and Recents        |
| [Building Requests](requests.md)                          | Methods, the URL bar, query params, headers, and body editors                  |
| [Authentication](authentication.md)                       | API Key, Basic, Bearer, Digest, NTLM, AWS SigV4, and OAuth 2.0                 |
| [Variables & Environments](variables-and-environments.md) | `{{variables}}`, environments, collection/folder scopes, and response captures |
| [GraphQL](graphql.md)                                     | The query/variables editor, schema introspection, and validation               |
| [WebSockets](websocket.md)                                | Connecting, sending frames, and reading the frame log                          |
| [Reading Responses](responses.md)                         | Body rendering, previews, headers, cookies, timeline, and search               |
| [Import, Export & Backup](import-export-and-backup.md)    | Postman/Insomnia/OpenAPI/HAR and whole-workspace backups                       |
| [Settings & Themes](settings-and-themes.md)               | Appearance, layouts, proxy, retries, and the theme editor                      |
| [Keyboard Shortcuts](keyboard-shortcuts.md)               | Every shortcut in one place                                                    |

## A quick tour

wurl's window has three panels:

- **Collections** (left) — your saved requests, organized into collections and
  folders, plus the **Favorites** and **Recents** tabs. Its toolbar holds the
  **collection** and **environment** selectors.
- **Request** (center) — where you set the method, URL, query parameters,
  headers, body, authentication, and post-response captures.
- **Response** (right) — the status, timing, body (syntax-highlighted), headers,
  cookies, console output, and a request timeline.

At the top right are the **layout picker** and **settings**. You can rearrange
the three panels into four different
[layouts](settings-and-themes.md#layouts) and restyle everything with
[themes](settings-and-themes.md#themes).

> The screenshots in this guide use a demo collection called **Demo API** and a
> **Local** environment pointing at a test server. Yours will show your own
> collections.

Ready? Start with **[Getting Started](getting-started.md)**.
