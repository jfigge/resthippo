# Feature 40 — Export parity (Insomnia v4 / OpenAPI 3 / HAR) & workspace export

## Context
Export is **Postman v2.1, single-collection only**. The lone exporter is `exportToPostman()`
(`src/web/scripts/export/postman.js`), invoked from the tree's "Export Collection…". Imports cover three
formats but exports cover one, so a Rest Hippo user can hand a collection only to Postman users. The
whole-workspace **Backup** (`src/app/store/backup.js`) is Rest Hippo's own encrypted `resthippo-backup` envelope — a
backup/restore mechanism, not a portable interchange format other tools can read.

## Goal
Add interchange exporters for Insomnia v4, OpenAPI 3, and HAR, plus a "export all collections" option, with
the same secret-redaction guarantees the Postman exporter already provides.

## Implementation steps
1. **Exporter modules**: add `export/insomnia.js`, `export/openapi.js`, `export/har.js` alongside
   `export/postman.js`, each consuming the same request/collection model. Reuse the redaction helpers
   (`crypto.js` `redact*`) so secrets are blanked-but-field-preserved exactly as Postman export does.
2. **Mapping**: Insomnia v4 (resources graph with workspace/folders/requests/environments); OpenAPI 3
   (paths/operations from requests, components for shared auth/params — best-effort, document lossy areas);
   HAR (`log.entries` from the most recent run/history where available).
3. **UI**: turn "Export Collection…" into "Export…" with a format picker; add "Export all collections…"
   for a workspace-level export to the chosen interchange format (distinct from the encrypted Backup).
4. **Round-trip**: where Rest Hippo also imports the format (Postman/Insomnia/OpenAPI — Features 39/41), add a
   round-trip test asserting structural stability.

## Acceptance criteria
- A collection can be exported to Insomnia v4, OpenAPI 3, and HAR, each consumable by the respective tool/
  validator.
- "Export all collections" produces a single portable interchange file (not the encrypted backup envelope).
- Secrets are redacted in every exporter (covered by tests, like `export/tests/postman.test.js`).
- Postman↔Rest Hippo and Insomnia↔Rest Hippo round-trips preserve structure.

## Constraints
- Exporters live in `src/web/scripts/export/`, mirroring the existing module/test layout.
- Reuse existing redaction; never emit plaintext secrets.
- Native save dialog + FS stay in the main process; keep `main.js`/`preload.js` in sync.

## Verify
`make fmt && make lint && make test`
