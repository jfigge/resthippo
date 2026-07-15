# Feature 31 — Code signing & notarization (macOS + Windows)

## Context
Builds are **unsigned and un-notarized**. The `electron-builder` config in `src/package.json` (`build`
block) has no `mac.notarize`, `afterSign`, `hardenedRuntime`, `entitlements`, or Windows
`sign`/`certificate`; there is no `.entitlements` file. As a result an unsigned macOS `.dmg` is
Gatekeeper-quarantined ("damaged / unidentified developer") and an unsigned Windows installer trips
SmartScreen — ordinary users are blocked at first launch. `make dist*` is the only path that produces
installers, and it currently emits unsigned artifacts.

## Goal
Sign and notarize distributable builds: hardened-runtime + Developer-ID signing + notarization on macOS,
and Authenticode signing on Windows, driven by credentials supplied via environment/CI secrets.

## Implementation steps
1. **macOS**: add `hardenedRuntime: true`, a minimal `entitlements`/`entitlementsInherit` plist (allow
   JIT/network-client as needed for Electron), and `mac.notarize` (or an `afterSign` notarize hook).
   Read the Developer-ID identity and Apple ID / API-key from env vars — never commit credentials.
2. **Windows**: configure `win` Authenticode signing (certificate file/store or a signing service). Keep
   the NSIS + portable targets.
3. **Makefile/CI**: thread signing on through `dist-mac`/`dist-win`; in CI (Feature 28) run signing only
   on tag/release with secrets, and keep PR builds unsigned `--dir`. Document required secrets.
4. **Verify the artifacts**: `codesign --verify --deep` + `spctl -a` on macOS; `signtool verify` on
   Windows.

## Acceptance criteria
- A release `.dmg` is signed with a Developer-ID identity and passes `spctl -a` / Gatekeeper after
  notarization staple.
- The Windows installer is Authenticode-signed and launches without a SmartScreen block on a clean VM.
- No credentials are committed; signing reads from env/CI secrets and is skipped gracefully when absent.

## Constraints
- Keep unsigned `--dir` builds working for local dev and CI PR jobs (don't force-require certs there).
- This is the prerequisite for Feature 36 (auto-update) — updates must be signed.
- Do not modify anything under `build/`; configuration lives in `src/package.json` + new config/scripts.

## Verify
`make fmt && make lint && make test`, then `make dist-mac` / `make dist-win` with credentials and verify
the signatures as above.
