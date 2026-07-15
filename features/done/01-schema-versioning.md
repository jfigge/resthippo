# Feature 01 — Schema versioning & migration

## Context
Stored JSON under Electron's `userData` path has no version field and no
migration path. Any future change to the on-disk shape risks silently corrupting
or misreading existing user data. The store layer lives in `src/app/store/`
(`stores.js` factory, `io.js` atomic read/write, plus the per-entity
`*-store.js` modules).

## Goal
Introduce an explicit schema version on persisted records/collections and a
migration step that runs on read, upgrading old data to the current shape before
the renderer ever sees it.

## Implementation steps
1. Decide the unit of versioning — pick the smallest practical: a top-level
   `schemaVersion` integer on each stored document (collection/request/settings),
   defaulting to `1` for any record that lacks one.
2. Add a `migrations/` module under `src/app/store/` exporting an ordered list of
   pure migration functions `(doc) => doc`, each bumping the version by one.
3. In the read path (`io.js` or each `*-store.js` load), after parsing JSON, run
   the doc through all migrations whose version is newer than the doc's, then
   stamp the current version. Write-back the upgraded form on next save (do not
   eagerly rewrite every file on load).
4. Define `CURRENT_SCHEMA_VERSION` in one place and assert in a test that it
   equals the highest migration index.

## Acceptance criteria
- A record written by the old code (no `schemaVersion`) loads cleanly and is
  treated as version 1.
- Adding a no-op migration and bumping the version does not break existing data.
- Unit tests cover: missing version → 1, forward migration chain runs in order,
  already-current docs are untouched.

## Constraints
- Migrations must be pure and synchronous; no I/O inside them.
- Keep atomic-write semantics in `io.js` intact.

## Verify
`make fmt && make lint && make test`
