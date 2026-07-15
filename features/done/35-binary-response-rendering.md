# Feature 35 — Binary response rendering (images, PDF, hex)

## Context
Binary responses are mangled. The main process converts the response body with `rawBody.toString("utf8")`
before it crosses IPC (`src/app/main.js` ~826), and the viewer's `classifyContentType`
(`src/web/scripts/components/response-viewer.js` ~58-75) has no branch for `image/*`, `application/pdf`,
or other binary types — they fall into the `"other"` bucket and render as garbled text. Hitting an
endpoint that returns a PNG, PDF, or protobuf shows noise. Postman previews images and offers a hex view.

## Goal
Detect binary content types and render them appropriately — inline image preview, PDF preview, and a hex
viewer for arbitrary binary — without corrupting the bytes in transit.

## Implementation steps
1. **Preserve bytes**: stop forcing `toString("utf8")` for binary responses. Detect binary by
   `Content-Type` (and/or a sniff) and carry the body as a Buffer/base64/`bodyRef` so the renderer
   receives the real bytes. Reuse the existing spill-to-disk/`bodyRef` mechanism for large binaries.
2. **Renderers**: add viewer branches — `image/*` → `<img>` from a `blob:`/data URL (CSP already allows
   `img-src data: blob:`); `application/pdf` → a PDF preview (an Electron `<webview>`/`WebContentsView`
   or a bundled viewer — no CDN); everything else binary → a hex+ASCII dump with offsets (virtualized/
   capped for large bodies).
3. **Controls**: keep "Save to file" working for binary (it already exists), and offer a "view as text/
   hex" override for ambiguous types.
4. **Guardrails**: cap inline preview sizes (reuse the inline-limit philosophy) and fall back to save-to-
   file beyond the cap.

## Acceptance criteria
- An `image/png` response shows the actual image; a `application/pdf` response shows a readable preview.
- An arbitrary binary response shows a correct hex/ASCII dump (bytes intact, not utf8-mangled).
- Text responses are unchanged; large binaries don't blow up memory (spill/cap respected).
- Save-to-file still produces a byte-accurate file.

## Constraints
- Byte-preserving changes to the execution path live in the **main process**; keep `main.js`/`preload.js`
  in sync for any new channel.
- No CDN-loaded viewers; bundle anything needed (per the fonts/vendor rule).
- Plain DOM + class-based ES modules; CSS tokens from `theme.css`.

## Verify
`make fmt && make lint && make test`
