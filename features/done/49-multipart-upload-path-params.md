# Feature 49 — Multipart file upload & path parameters

## Context
Two request-composition gaps:
- **Multipart can't upload files.** The `form-data` serializer in
  `src/web/scripts/components/request-payload.js` (~198-217) emits only **text** parts —
  `Content-Disposition: form-data; name="…"` with no `filename` and no file content. The separate `file`
  body type uploads exactly one binary as the *whole* body (~219-227), so you can't mix a file field with
  other form fields, and can't upload multiple files.
- **No path-parameter UX.** The "Params" tab is **query parameters only** (each enabled row → `?k=v`,
  `request-editor.js` ~1545). There's no `:id`/`{id}` detection, no path-params table, and no segment
  substitution — path values can only be injected by typing `{{var}}` directly into the URL.

## Goal
Support file fields within multipart `form-data` (mixed with text fields, multiple files), and add a
first-class path-parameters table derived from the URL.

## Implementation steps
1. **Multipart files**: let a `form-data` row be a **file** field (type toggle per row) holding a file
   path. In the main process, stream the file's bytes into the multipart body with a proper `filename` and
   detected `Content-Type`; keep text fields working in the same body. Support multiple file rows. (File
   bytes must be read in main — only the path crosses IPC, as the current single-file path does.)
2. **Path params**: detect `:name`/`{name}` tokens in the URL and surface a **Path Params** table that maps
   each token to a value (with `{{var}}` support). Substitute tokens at send time; keep the query-param tab
   for `?k=v`. Auto-add/remove rows as the URL changes.
3. **Persistence & interop**: persist file-field metadata and path-param values; ensure cURL/code-gen
   (Feature 38) and import/export reflect multipart files and path params.

## Acceptance criteria
- A multipart request can send a file field **and** text fields together, plus multiple files, with correct
  `filename`/boundary/Content-Type.
- Editing a URL with `:id`/`{id}` reveals a Path Params table; filling it substitutes into the sent URL.
- File bytes are read in the main process (only paths cross IPC); large files don't buffer wastefully.
- Generated cURL and exports represent multipart files and path params correctly.

## Constraints
- File reading/streaming happens in the **main process**; keep `main.js`/`preload.js` in sync.
- Reuse the existing KV-grid and pill/variable machinery; don't fork it.
- Additive, back-compatible request model (coordinate with schema versioning).

## Verify
`make fmt && make lint && make test`
