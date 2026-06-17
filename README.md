# Rest Hippo — Web URL REST API Client

[![CI](https://github.com/jfigge/resthippo/actions/workflows/ci.yml/badge.svg)](https://github.com/jfigge/resthippo/actions/workflows/ci.yml)

A lightweight, cross-platform desktop REST API client — like Postman or Insomnia —
built with **Electron** and **Vanilla JavaScript**, backed by a file-based
**Node.js storage layer**. No framework, no CDN dependencies.

## Features

- **Full request/response workflow** — all HTTP methods, headers, query params,
  body editors, and a response viewer with syntax highlighting (Prism.js) and
  binary-response rendering.
- **Authentication** — a custom OAuth 2.0 implementation with PKCE, plus Digest,
  NTLM, and AWS SigV4 signing.
- **Cookie jar** — persistent, per-domain cookie storage.
- **Import / export** — Postman collection import and redaction-aware export.
- **Environments & variables** — variable resolution across requests.
- **Themes & typography** — a theme editor and a user-selectable UI font
  (Inter bundled as a variable font; no CDN fonts).

## Architecture

```
Electron main process (src/app/main.js)        ← owns all filesystem I/O + native HTTP
  └── IPC bridge (src/app/preload.js)  →  window.hippo.*
        └── Renderer / UI (src/web/scripts/app.js)   ← sandboxed; talks to main via IPC only
              ├── TreeView
              ├── RequestEditor
              └── ResponseViewer
```

The main process performs all HTTP execution natively, so requests are **not**
subject to browser CORS constraints. The renderer is sandboxed and communicates
with the main process exclusively through the `window.hippo.*` bridge. Storage is
file-based under Electron's `userData` path (see `src/app/store/`).

## Prerequisites

- [Node.js](https://nodejs.org/) (includes `npm`) — Electron 42 bundles Node 22;
  matching that locally keeps CI parity.
- *(optional)* [Go](https://go.dev/) — only needed to run the mock test server.
- *(optional)* [Docker](https://www.docker.com/) — only needed for the bundled
  Keycloak OAuth test environment.

## Project Structure

```
Rest Hippo/
├── Makefile               # Build orchestration (authoritative command list)
├── mock/                  # Optional Go mock API for MIME / status / auth testing
└── src/
    ├── package.json       # Node / Electron dependencies + electron-builder config
    ├── app/               # Electron main process (Node.js)
    │   ├── main.js        #   window lifecycle + IPC registration
    │   ├── preload.js     #   IPC bridge exposed as window.hippo
    │   ├── store/         #   file-based storage layer (+ tests)
    │   └── auth/          #   Digest / NTLM signing (+ tests)
    └── web/               # Renderer (Vanilla JS + CSS)
        ├── index.html
        ├── scripts/       #   UI components, OAuth, import/export, vendored libs
        ├── styles/        #   CSS + design tokens (theme.css)
        └── fonts/         #   Bundled Inter variable font
```

## Getting Started

### Install dependencies

```bash
make install        # npm ci in src/
```

### Run in development

```bash
make debug          # Electron with DevTools + hot-reload (primary dev workflow)
```

This launches the Electron app directly with a local `--user-data-dir` so
development data stays out of your real profile.

## Building

`build-*` targets produce an **unpackaged** app directory (fast, for smoke
tests). `dist-*` targets produce **installers**. Output lands in
`build/src/dist/`.

```bash
make build          # Build the app directory for macOS (dir only)
make build-mac      # macOS app directory
make build-linux    # Linux app directory
make build-win      # Windows app directory

make dist           # Installers for all platforms (host can only build its own)
make dist-mac       # macOS (.dmg, .zip)
make dist-linux     # Linux (.AppImage, .deb)
make dist-win       # Windows (NSIS .exe, portable)

make launch         # Build and open the macOS app
```

> A given host can only build its own platform's installer (a macOS `.dmg`
> needs macOS, etc.). CI runs `dist-mac` / `dist-linux` / `dist-win` on native
> runners.

### Code signing & notarization

`dist-mac` / `dist-win` sign their installers when signing credentials are
present and produce **unsigned** artifacts (no failure) when they are absent —
so unsigned `--dir` dev builds and credential-less CI keep working unchanged.

- **macOS** builds run under the hardened runtime with the entitlements in
  `src/packaging/entitlements.mac.plist`, are signed with a **Developer ID
  Application** identity, and are **notarized + stapled** via Apple's
  `notarytool`. A signed, notarized `.dmg` passes Gatekeeper (`spctl -a`).
- **Windows** installers are **Authenticode**-signed (SHA-256, RFC-3161
  timestamped), which clears SmartScreen on a clean machine.

For a signed build **locally**, copy `release.env.example` → `release.env`
(git-ignored) and fill in the credentials; `make dist-*` reads them
automatically. In **CI** the same values come from repository secrets — the
[Release workflow](.github/workflows/release.yml) lists the exact secret names
and signs only on tag/release builds (PR builds stay unsigned `--dir`).

Verify the artifacts:

```bash
codesign --verify --deep --strict --verbose=2 <Rest Hippo.app>   # macOS
spctl -a -vvv -t install <Rest Hippo.app>                         # macOS Gatekeeper
signtool verify /pa /v <resthippo-setup.exe>                     # Windows
```

## Code Quality & Tests

```bash
make fmt            # Format JS/CSS/HTML (Prettier)
make fmt-check      # Verify formatting without writing
make lint           # Lint JS (ESLint)
make test           # Run the full test suite (node --test)
```

The default target runs the whole pipeline:

```bash
make                # clean → fmt → lint → test → build
```

## Releasing

Run from `main` with a clean, up-to-date working tree:

```bash
make release VERSION=1.2.3
```

It validates the version, confirms you're on `main` and in sync with origin,
then gates on the full test suite. On approval it bumps `src/package.json`,
fast-forwards the long-lived `release` branch to `main`, tags `v1.2.3`, and
pushes `main` + `release` + the tag atomically. The tag push triggers the
**Release** workflow to build and publish installers for all platforms.

`release` stays a strict fast-forward of `main`, so it always points at exactly
what was last shipped — a clean base for a hotfix if one is ever needed. Bump
`src/package.json` is handled for you, so the tag and the installer version
always match.

## Vendored Libraries

Third-party browser libraries are bundled into `src/web/scripts/vendor/` via
esbuild rather than loaded from a CDN:

```bash
make vendor-yaml        # yaml
make vendor-prism       # Prism.js (syntax highlighting)
make vendor-markdown    # marked + DOMPurify
```

## Test Helpers

### Mock API server (Go)

A small Go server exposing endpoints for MIME-type, status-code, and auth
testing on `http://localhost:8888`:

```bash
make mock-up        # build + start
make mock-down      # stop
```

The mock server also exposes an `/echo` endpoint for any HTTP method (including
custom verbs): `http://localhost:8888/echo` reflects the request back — method,
URL, query params, headers, cookies and body. The response is JSON by default,
or XML/YAML/HTML when the `Accept` header asks for one of those
(`application/xml`, `application/yaml`, `text/html`).

For testing loading states, the timing waterfall and timeout/cancel handling it
exposes `GET /delay?seconds=<n>`, which sleeps for `n` seconds (clamped to
`1`–`30`) before returning JSON. A missing or non-integer `seconds` returns
`400`.

For the WebSocket client it exposes `ws://localhost:8888/ws` (and `/ws/echo`),
which echoes every frame back; `/ws/time`, which pushes a timestamped JSON frame
once per second (to test received-without-send traffic); and `/ws/reject`, which
refuses the upgrade with `401` so handshake-failure handling can be exercised.

It also runs a forward proxy on `http://localhost:9999` for exercising Rest Hippo's
proxy settings and request-retry policy. Point a request's proxy at it and send
the `X-PROXY-ERROR` header to make the proxy fail a fixed number of times before
the request succeeds — `X-PROXY-ERROR: 3` returns `503` for the first two
attempts of a given URL, then forwards the third upstream. The countdown is
cached per URL for 5 minutes and resets once the request finally succeeds, so a
retry policy can be observed driving the request to completion.

### Keycloak OAuth environment (Docker)

Spins up a Keycloak instance pre-configured with realms, users, and clients for
each OAuth grant type (Authorization Code, PKCE, Client Credentials, Implicit,
Password):

```bash
make kc             # start + bootstrap + print credentials
make creds          # print endpoints, clients, and sample curl requests
make stop           # stop and remove the container
make reset          # stop and delete data volumes
```

## Build Information

```bash
make version        # Print the current version string
make info           # Print full build info (version, branch, commit, build time)
make help           # List all available targets
```

## Clean

```bash
make clean          # Remove build/ and dist/ directories
```

## License

Copyright © 2026
