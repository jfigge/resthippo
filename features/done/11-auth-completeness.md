# Feature 11 — Auth completeness (API-key, Digest/NTLM, device_code)

## Context
Auth types today: None / Basic / Bearer / OAuth2 / AWS SigV4
(`src/web/scripts/components/request-editor.js` Auth tab; OAuth in
`src/web/scripts/auth/`). Gaps:
- **API-key** auth is hand-rolled by users (manual header/query) — should be
  first-class.
- **Digest** and **NTLM** are unsupported.
- The OAuth **`device_code`** flow is *defined but unimplemented* in
  `src/web/scripts/auth/flows/`.

## Goal
Add first-class API-key auth, Digest and NTLM auth, and finish (or remove) the
device_code flow.

## Implementation steps
1. **API-key**: add an `API Key` auth type with fields for key name, value, and
   add-to (header or query param). Apply during request resolution.
2. **Digest**: implement RFC-2617/7616 challenge-response. This needs a two-step
   exchange (401 with `WWW-Authenticate` → re-send with `Authorization: Digest`),
   handled in the main process where the request executes (`main.js`).
3. **NTLM**: implement the multi-leg NTLM handshake in the main process (also a
   stateful exchange). Evaluate a vetted dependency vs. vendored implementation;
   avoid heavy/unmaintained deps.
4. **device_code**: either finish the flow in `auth/flows/` (poll the token
   endpoint with the device/user codes and show the user-code prompt) or remove
   the dead flow definition and references.

## Acceptance criteria
- API-key auth adds the key to the chosen location and persists.
- A Digest-protected endpoint authenticates via the challenge round-trip.
- NTLM completes its handshake against a test server (or is clearly scoped/tested
  with a mock).
- device_code is either fully working (with user-code UI) or removed — no dead
  half-flow left behind.

## Constraints
- Stateful auth round-trips (Digest/NTLM) execute in the main process.
- Follow the existing auth-type plug-in pattern in the request editor.

## Verify
`make fmt && make lint && make test`
