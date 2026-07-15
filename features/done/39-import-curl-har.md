# Feature 39 — Import from cURL paste & HAR

## Context
Import only accepts JSON/YAML files for three formats. `parseImport()`
(`src/web/scripts/import/index.js`, `detectFormat` ~13-32) handles Postman, Insomnia, and OpenAPI, and the
native dialog filters to `json`/`yaml`/`yml` (`src/app/main.js` ~1890-1899). Two of the most common import
paths are missing:
- **cURL paste** — moving a request from docs/terminal/DevTools "Copy as cURL" into the client. Rest Hippo can
  *emit* cURL but cannot *ingest* it.
- **HAR** — the universal browser/proxy capture format ("Save all as HAR") for bulk-importing real traffic.

## Goal
Let users (a) paste a raw `curl …` command and get a ready-to-send request, and (b) import a `.har` file as
a collection of requests.

## Implementation steps
1. **cURL parser**: add a tokenizer for `curl` commands handling `-X/--request`, `-H/--header`,
   `-d/--data*`, `--data-binary`, `-F/--form`, `-u/--user`, `--url`, bare URL, and line continuations.
   Map to the request model (method/url/params/headers/body/basic-auth). Add an "Import from cURL" entry
   (paste box) in the import UI — no file needed.
2. **HAR importer**: add a `har` branch to `detectFormat`/`parseImport` that reads `log.entries[]` into
   requests (method/url/headers/query/postData), optionally grouping by host/path into folders. Extend the
   open dialog filter to include `.har`.
3. **Fidelity**: preserve headers/query/body faithfully; skip response payloads (or import as examples if
   Feature 40's example handling lands). Resolve obvious secrets to variables where reasonable.
4. Update the user guide

## Acceptance criteria
- Pasting a representative `curl` command (headers + JSON `-d` + method) produces a correct request.
- Importing a `.har` file creates requests matching its entries (method/url/headers/body).
- Malformed input is reported via a notification (Feature 26), not silently dropped.
- Imported items append as a new collection consistent with existing import behavior.

## Constraints
- Parsing stays in the renderer importer modules (`src/web/scripts/import/`), matching the existing
  Postman/Insomnia/OpenAPI structure.
- Extend the main-process file dialog filter; keep `main.js`/`preload.js` in sync if a channel changes.
- No heavy shell-parsing dependency — a focused tokenizer is fine.

## Verify
`make fmt && make lint && make test` (add importer unit tests mirroring `import/tests/import.test.js`).
