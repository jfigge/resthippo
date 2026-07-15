# Feature 37 — mTLS / client certificates & custom CA

## Context
There is no mutual-TLS or custom-trust support. The Node request options in `src/app/main.js` (~518-531)
set only `rejectUnauthorized` and an optional proxy agent — no `cert`, `key`, `pfx`, `passphrase`, or `ca`,
and no `createSecureContext`. The only TLS knob is the global all-or-nothing `verifySsl` setting. So any
API requiring a client certificate (banking, government, internal corp services) can't be called, and for a
privately-signed dev API the only recourse is disabling verification entirely instead of trusting a
specific CA.

## Goal
Support per-host client certificates (PEM and PFX/P12) and a custom CA bundle, configured in settings and
applied automatically by host during request execution.

## Implementation steps
1. **Config UI**: add a "Certificates" section to settings — a list of client-cert entries
   `{host, certPath|pfxPath, keyPath, passphrase}` and a custom CA file list. Store cert **paths**
   (read by main at send time); encrypt any passphrase via the existing `safeStorage` path in
   `crypto.js` (extend the secret-field list).
2. **Apply by host (main)**: in the execution path, match the request host against configured client certs
   and set `cert`/`key`/`pfx`/`passphrase` on the TLS options; load and set `ca` from the custom CA list.
   Read files in the main process only.
3. **Per-request TLS verify**: allow a per-request/collection override of `verifySsl` (coordinate with
   Feature 42) so one self-signed host can be trusted without disabling verification globally.
4. **Token endpoints**: thread the same TLS context into OAuth token requests where applicable so token
   fetches can reach hosts behind a private CA.

## Acceptance criteria
- A request to an mTLS-protected host presents the configured client cert and succeeds; other hosts are
  unaffected.
- A custom CA file lets a privately-signed host validate **with** verification still on.
- Cert passphrases are encrypted at rest and redacted on export.
- Per-request SSL-verify override works without flipping the global setting.

## Constraints
- All file I/O and TLS context creation happen in the **main process**.
- Reuse `crypto.js` secret encryption + export redaction; keep `main.js`/`preload.js` in sync.
- Plain DOM + class-based ES module for the settings UI; CSS tokens from `theme.css`.

## Verify
`make fmt && make lint && make test`
