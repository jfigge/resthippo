# Feature 58 — File body: broken upload (Electron 42) + import/export round-trip loss

> Source: full code review 2026-07-10 (request editor grade B, import/export grade B+). **High: file uploads silently send an empty body.**

## Context
File bodies are broken in three places, all traceable to stale assumptions about where the filesystem path
lives.

## Findings to fix
- **[High] File-body upload sends an empty body on Electron 42.** `request-payload.js:475` derives the path
  from `spec.bodyFile.path`, and the comment there still says "Electron exposes the real filesystem path via
  `File.path`." That property was **removed in Electron 32** (this repo is Electron 42) — `preload.js` ≈166
  documents the removal and exposes `webUtils.getPathForFile` as the replacement. The send path
  (`request-editor.js:2924`) passes the raw `File` object as `bodyFile`, whose `.path` is now `undefined`, so
  `bodyFilePath` becomes `""` → `hippo:send-request` carries an empty path → main reads no file → empty
  upload. The correctly-resolved path already exists as `getValue().bodyFilePath` (computed via
  `getPathForFile`) but is never passed. After a reload it's worse: `setValue()` nulls `#bodyFileObject`, so
  the file body vanishes entirely.
- **[Medium] Postman file body lost on round-trip.** `import/postman.js:213` reads `body.src`, but
  `export/postman.js:174` writes the v2.1-correct `{ mode:"file", file:{ src } }` (and real Postman uses
  `body.file.src`). Result: `fileBody(undefined)` → `bodyFilePath:""` → path silently dropped.
- **[Low] Insomnia file body → no-body on round-trip.** `import/insomnia.js` `parseBody` (≈127-166) has no
  branch for a file / `application/octet-stream` body, though `export/insomnia.js` (≈107-112) writes
  `mimeType:"application/octet-stream", fileName`. Re-import falls through to `noBody()`.
- **[Low] WS handshake ignores path params.** `request-editor.js` (≈1299-1317) resolves the WS URL with
  `encodeBaseUrl(await rv(rawUrl))` but omits `applyPathParams`/`resolvePathParamValues` (unlike the HTTP
  send at ≈2903-2908), so a WS URL with `:id`/`{id}` tokens is sent literally.

## Goal
Make a picked file actually upload, and make file bodies survive export→import for Rest Hippo's own formats.

## Implementation steps
1. **Send path.** Pass the resolved path, not the `File`: at `request-editor.js:2924` send
   `bodyFile: { path: bodyVals.bodyFilePath, type: bodyVals.bodyFile?.type }` (the `{ path, type }` shape the
   JSDoc at `request-payload.js` ≈211 already documents). In `request-payload.js:472-479`, read
   `spec.bodyFile.path` from that shape and delete the stale `File.path` comment. Confirm
   `body-editor.js` `getValue()` computes `bodyFilePath` via `window.hippo.getPathForFile` (≈117-125) and that
   it survives `setValue()`/reload (persist the path string, not the `File`).
2. **Postman.** In `import/postman.js`, read `body.file?.src ?? body.src` so both our export shape and real
   Postman files work.
3. **Insomnia.** In `import/insomnia.js` `parseBody`, add a file branch for `application/octet-stream` +
   `fileName` → a file body.
4. **WS path params.** Apply the same `applyPathParams`/`resolvePathParamValues` step used by the HTTP send
   before opening the socket.

## Acceptance criteria
- Picking a file in Body → File and sending uploads the file's real bytes (verify against the mock server or
  an echo endpoint); the body survives a reload of the request.
- A request with a file body exported to Postman v2.1 and re-imported keeps its file path; same for Insomnia.
- A WebSocket URL containing `:id` connects to the substituted path.
- `make test-import && make test-export` green.

## Constraints
- Native file reads stay in main; the renderer only ever passes a path string over `window.hippo.*`.
- Don't reintroduce any dependence on `File.path`.

## Verify
`make test-import && make test-export && make test`. Then `make debug`: send a real file upload and confirm
bytes arrive; export a file-body request to Postman/Insomnia and re-import.
