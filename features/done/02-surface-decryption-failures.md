# Feature 02 — Surface decryption failures

## Context
Secrets are encrypted at rest with Electron `safeStorage` (OS keystore). The
decrypt path in `src/app/store/crypto.js` (around line 75) currently swallows
failures and passes through, so a keystore/profile mismatch or corrupted blob
yields a silently blank secret with no signal to the user or logs. This makes
"my token vanished" bugs undiagnosable.

## Goal
Make decryption failures observable and recoverable instead of silent.

## Implementation steps
1. In `crypto.js`, when `safeStorage.decryptString` throws or `isEncryptionAvailable()`
   is false for data that is marked encrypted, stop returning a blank/plaintext
   pass-through. Instead return a typed result (e.g. `{ ok:false, reason }`) or
   throw a tagged error the caller can distinguish.
2. Log a structured warning in the main process (one line, no secret material).
3. Propagate a non-fatal signal to the renderer via an existing IPC result shape
   so the relevant field can show an inline "couldn't decrypt — re-enter" state
   rather than appearing empty-and-fine.
4. Ensure a failed decrypt never overwrites the stored ciphertext on the next
   save (don't let a blank value clobber a recoverable secret).

## Acceptance criteria
- Simulated decrypt failure produces a log line and a distinguishable return
  value, not a silent empty string.
- The stored ciphertext is preserved after a failed decrypt + subsequent save.
- A unit test forces the failure branch (mock `safeStorage`) and asserts the
  non-silent behavior.

## Constraints
- Never log decrypted secret contents.
- Keep the happy path API unchanged for callers that already succeed.

## Verify
`make fmt && make lint && make test`
