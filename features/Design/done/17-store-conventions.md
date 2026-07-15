# Design 17 — Align store-module conventions

## Context
The `*-store.js` modules under `src/app/store/` diverge on several conventions:
- **Version field, three ways** — `version` (`collection-store.js:15`,
  `environment-store.js:18`, `collections-store.js:55`), `schemaVersion`
  (`cookie-store.js:24`), or none (`tree-store.js:48`). These hand-written fields are
  vestigial: `migrations.js` already stamps `schemaVersion` on every persisted doc.
- **Directory creation** — eager in the constructor (`collection-store.js:32`,
  `environment-store.js:31`) vs. lazy per-write (the other six stores — the dominant
  pattern).
- **CRUD method naming** — `get*`/`save*` (collection, collections, tree, environment) vs.
  full CRUD verbs (`request-store.js`: create/update/delete) vs. `list*`/`add*`
  (`history-store.js`) vs. `upsert*` and private `_read`/`_write` (`cookie-store.js`, the
  only store with private `_read`/`_write`).
- **Resolver injection** — nullable with guards in `collection-store.js:29-31,82` vs.
  assumed-present elsewhere (`collections-store.js:36`, `tree-store.js:34`, …).

## Goal
The store modules follow one structural template: same versioning approach, same
dir-creation timing, consistent method naming, consistent dependency injection.

## Implementation steps
1. **Versioning:** remove the hand-written `version`/`schemaVersion` defaults from store
   payloads and rely solely on the `migrations.js` envelope, OR keep one field name
   consistently if it serves a purpose — but not three conventions. Confirm migrations still
   round-trip via the existing migration tests.
2. **Dir creation:** standardize on lazy `ensureDir` per-write (the dominant pattern);
   remove the eager constructor `ensureDir` from `collection-store`/`environment-store`.
3. **Method naming:** adopt a consistent verb set. Recommended: `get*`/`save*` for
   whole-blob stores; full CRUD verbs only where the store is genuinely granular
   (requests/history). Make `cookie-store`'s persistence helpers match the others rather
   than being the lone private `_read`/`_write`.
4. **Resolver injection:** make it consistent — either always required (drop the null
   guards in `collection-store`) or always optional with guards. Pick one based on whether
   any store is ever constructed without a resolver (check `stores.js`).
5. Update `store/tests/*` for any renamed methods or changed defaults.

## Acceptance criteria
- One versioning approach across stores; migration tests pass.
- All stores create directories the same way (lazy).
- Consistent CRUD method naming; no lone `_read`/`_write` outlier.
- Resolver injection is uniform.

## Constraints
- Behavior-preserving for persisted data; changes to stored fields go through the
  schema-version envelope (Feature 01) so existing installs migrate cleanly.
- All filesystem I/O stays in the main process via `io.js`.

## Verify
`make fmt && make lint && make test`
