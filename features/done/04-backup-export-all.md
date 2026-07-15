# Feature 04 — Backup / export-all

## Context
There is no way to back up or migrate the whole workspace. Export today is
Postman v2.1, single-collection only (`src/web/scripts/.../export/postman.js`).
Users can't snapshot everything or recover after a machine move.

## Goal
Add a one-click "Export everything" that produces a single portable archive of
all collections, environments, and settings, plus a matching "Import backup"
that restores it.

## Implementation steps
1. **Main process**: add an IPC handler that reads every store entity from the
   `userData` path and bundles them into one JSON document (a `resthippo-backup`
   envelope with `schemaVersion` — see Feature 01). Register the channel in
   `main.js` and expose it in `preload.js`.
2. Decide on secret handling: by default **exclude** decrypted secrets from the
   backup (export ciphertext or placeholders); optionally offer an explicit
   "include secrets (this machine only)" path since `safeStorage` ciphertext is
   keystore-bound and won't decrypt elsewhere. Document the choice in the UI.
3. **Restore**: an import handler that validates the envelope, runs it through
   schema migrations, and writes entities back (with a merge-vs-replace choice).
4. **UI**: add Export/Import-backup actions a top-level menu. Use a native 
   save/open dialog from the main process.

## Acceptance criteria
- Export produces a single file containing all collections, environments, and
  settings; re-importing it on a clean profile reproduces the workspace.
- Secrets are not silently leaked in plaintext.
- Round-trip test: export → wipe → import → entities match.

## Constraints
- Reuse the schema-version envelope from Feature 01.
- Native dialogs and all FS I/O stay in the main process.

## Verify
`make fmt && make lint && make test`
