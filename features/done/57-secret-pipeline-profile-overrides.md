# Feature 57 — Secret pipeline: profile-override (`profileValues`) coverage

> Source: full code review 2026-07-10 (storage subsystem, grade B−). **Highest-priority item: one Critical (permanent secret loss) + one High (plaintext leak).**

## Context
The latest commit `cd51844` ("Implemented presence-based profile overrides") gave folder nodes a
`profileValues` map — `{ [profileId]: { [name]: value } }` — and encrypts the secret ones at rest via
`encryptProfileValues` / `decryptProfileValues` (`src/app/store/crypto.js` ≈714-760), wired into read/write
in `src/app/store/collections-store.js` (decrypt ≈185, encrypt ≈247). **The encryption was added but the
rest of the secret *pipeline* was not**, so every code path that walks the tree for secrets skips
`profileValues` (it walks only `node.variables`). `grep -n profileValues src/app/store/{secret-storage,collection-archive,backup}.js` returns nothing today — that gap is the bug.

## Findings to fix
- **[Critical] Mode switch destroys override secrets.** `secret-storage.js` `collectTree`/`mapTree`
  (≈655-676) walk only `node.variables`; `reencryptAll` (≈452) therefore never re-encrypts
  `profileValues`. On a backend switch (`main.js` ≈1688 deletes the old app key, or master-password switch
  drops the KDF/verifier/masterKey), the old `enck:`/`encm:` `profileValues` ciphertext becomes permanently
  undecryptable. A user with one secret profile override who switches app-key → OS-keychain loses it forever.
- **[High] Password-protected collection archives leak override secrets in plaintext.**
  `collection-archive.js` `mapNodeSecrets`/`encryptArchiveSecrets` (≈106-123) seal `n.variables` but not
  `n.profileValues`; the renderer hands them over already-decrypted (`export/resthippo.js:77` assumes they
  "need no handling"). Worse, `archiveHasSecrets` (≈53-74) can't even detect a profile-only secret, so the
  password prompt never fires. `decryptArchiveSecrets` ignores them on import too.
- **[Medium] Whole-workspace backups mishandle them.** `backup.js` `_exportTreeNodes` (≈692-705) exports
  machine-bound ciphertext un-redacted in `none` mode (defeats "safe to share"); in `password` mode it is
  neither converted to portable `encp:` on export nor localized on import (`_localizeTreeNodes` ≈787-800),
  so a cross-machine restore leaves undecryptable ciphertext → override secrets lost. (`machine` mode
  happens to work by carrying ciphertext verbatim.)
- **[Medium] Lost-config recovery can boot the wrong mode.** `_inferMode` / `collectTree` (≈392, 566-568)
  can't see `profileValues` secrets, so an install whose *only* secret is a master-password (`encm:`) profile
  override isn't detected and falls through to the app-key default — orphaning those `encm:` secrets.

## Goal
Treat a folder's `profileValues` secret entries as first-class secrets everywhere `node.variables` secrets are
handled: mode-switch re-encryption, archive sealing + detection, backup redaction/portability/localization,
and lost-config mode inference.

## Implementation steps
1. **Re-encryption walk.** In `secret-storage.js`, extend `collectTree` (collect override ciphertext for the
   probe) and `mapTree`/`reencryptAll` to transform `node.profileValues` alongside `node.variables`. Mirror
   how `collections-store.js` derives `secureNames` for `encrypt/decryptProfileValues` so only secret entries
   are touched. Add a `reencryptProfileValues(map, from, to, secureNames)` helper analogous to the variables path.
2. **Archives.** In `collection-archive.js`, seal/unseal `n.profileValues` in `mapNodeSecrets` /
   `decryptArchiveSecrets`, and make `archiveHasSecrets` return true when a profile override is a secret.
3. **Backups.** In `backup.js`, handle `profileValues` in `_exportTreeNodes` (redact in `none`, convert to
   portable `encp:` in `password`) and `_localizeTreeNodes` (localize `encp:` → machine backend on import).
4. **Mode inference.** Include `profileValues` ciphertext in `_anyCiphertext` / `_inferMode` so an
   override-only master-password install boots locked in the right mode.
5. **Regression tests (required).** Add a "profile-override secret is the *only* secret" case to
   `store/tests/{secret-storage,collection-archive,backup,integration}.test.js`: it must survive an
   app-key↔keychain↔master-password switch, seal into a password archive (and trigger the prompt),
   round-trip through a password backup across machines, and be detected by `_inferMode`.

## Acceptance criteria
- A workspace whose only secret is a folder profile override survives every secret-backend mode switch and
  still decrypts afterward (no data loss).
- A password-protected collection export stores that override as ciphertext and the password prompt fires;
  import decrypts it.
- A `password`-mode backup restored on a second machine decrypts the override; a `none`-mode backup does not
  contain its plaintext/ciphertext.
- `_inferMode` boots the correct locked mode for an override-only master-password install.
- New regression tests cover all four paths; `make test` (esp. `make test-data-store`) is green.

## Constraints
- Do not change the on-disk `profileValues` shape or the `enc{,k,m,p}:` prefix scheme; extend the walks only.
- All store I/O stays synchronous in the main process; preserve atomic write + quarantine semantics.
- No new plaintext-at-rest for secret overrides in any mode.

## Verify
`make test-data-store && make test`. Then in `make debug`: set a secret profile override on a folder, switch
the secret backend in Settings and confirm the override still resolves; export the collection with a password
and re-import; run a password backup/restore.
