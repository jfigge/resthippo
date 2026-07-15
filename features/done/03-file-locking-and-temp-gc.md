# Feature 03 — File locking & orphaned `.tmp` GC

## Context
Writes in `src/app/store/io.js` are atomic via temp-file + rename, but there is
**no locking** between concurrent writers and **no cleanup** of stale `.tmp`
files left behind by a crash mid-write. Over time the data dir can accumulate
orphan temp files, and concurrent saves can race.

## Goal
Prevent write races and clean up orphaned temp files on startup.

## Implementation steps
1. **Startup GC**: when the store initializes (`stores.js`), scan the data dir
   for the temp-file pattern used by `io.js` and delete any that are older than a
   small threshold (e.g. a few seconds) and have no matching in-flight write.
2. **Serialize writes per path**: add a lightweight in-process write queue/mutex
   in `io.js` keyed by target path so two saves to the same file can't interleave
   their temp→rename steps. A simple promise-chain map keyed by absolute path is
   sufficient (single process, single writer model).
3. Make the temp filename pattern explicit and unique (e.g. include a counter)
   so the GC scan can reliably identify orphans and never match real data files.

## Acceptance criteria
- Two rapid sequential/overlapping writes to the same key both land, last-write-wins,
  with no corrupted/partial file.
- A planted orphan `.tmp` file is removed on next startup; a real data file with a
  similar name is never removed.
- Unit tests cover the per-path serialization and the orphan-scan matcher.

## Constraints
- Single-process model — do not add a cross-process lockfile dependency.
- Keep the existing atomic temp→rename guarantee.

## Verify
`make fmt && make lint && make test`
