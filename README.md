# wurl — Web URL REST API Client

A lightweight, cross-platform desktop REST API client — like Insomnia — built with **Electron** and a **Go** development server.

## Overview

wurl runs in two modes:

| Mode | Description |
|------|-------------|
| **IDE / Dev** | Go static file server serves the web UI at `http://localhost:8080` |
| **Desktop** | Electron wraps the web UI as a native desktop application |

## Prerequisites

- [Go](https://go.dev/) 1.26+
- [Node.js](https://nodejs.org/) (includes `npm`)
- `goimports` — `go install golang.org/x/tools/cmd/goimports@latest`
- `golangci-lint` — managed via `tools/golangci-lint/go.mod`

## Project Structure

```
wurl/
├── Makefile
└── src/
    ├── go.mod          # Go module
    ├── package.json    # Node / Electron dependencies
    ├── app/
    │   ├── main.js     # Electron main process
    │   └── preload.js  # Electron preload script
    ├── cmd/
    │   └── main.go     # Go dev server entry point
    └── web/
        ├── index.html
        ├── scripts/    # Frontend JavaScript
        └── styles/     # CSS
```

## Getting Started

### Install dependencies

```bash
make install
```

### Run in development mode (IDE)

Start the Go dev server:

```bash
make dev
```

The UI is served at `http://localhost:8080`. To override the port:

```bash
SERVER_PORT=9090 make dev
```

### Run in development mode (Electron)

With the dev server already running, open a second terminal:

```bash
make dev-electron
```

Electron will load the UI from the Go dev server and open DevTools automatically.

## Building

### Build everything (server + all Electron targets)

```bash
make build
```

### Build individual targets

```bash
make build-server   # Go server binary only
make build-mac      # Electron app for macOS
make build-linux    # Electron app for Linux
make build-win      # Electron app for Windows
```

> **Note:** Cross-compiling for Linux requires additional setup on non-Linux hosts. Windows cross-compilation requires Wine.

### Create distribution packages (installers)

```bash
make dist           # All platforms
make dist-mac       # macOS (.dmg, .zip)
make dist-linux     # Linux (.AppImage, .deb)
make dist-win       # Windows (.exe NSIS installer, portable)
```

Packages are written to `dist/`.

## Code Quality

```bash
make fmt      # Format Go (gofmt, goimports) and JS/CSS/HTML (prettier)
make lint     # Lint Go (golangci-lint) and JS (eslint)
```

Run everything at once:

```bash
make          # install → fmt → lint → build
```

## Build Information

```bash
make version  # Print current version string
make info     # Print full build info (app, version, branch, commit, build time)
```

## Clean

```bash
make clean    # Remove build/ and dist/ directories
```

## License

Copyright © 2026

