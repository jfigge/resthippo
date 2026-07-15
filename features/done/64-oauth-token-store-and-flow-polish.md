# Feature 64 — OAuth: token-store cache key, dead `state` field, refresh semantics

> Source: full code review 2026-07-10 (renderer auth grade A−). No live vulnerabilities — the security-critical machinery (PKCE S256, state/nonce fail-closed, `alg:none` rejection, tokens stripped from events) is sound. These are correctness/UX polish.

## Context
The from-scratch OAuth layer is solid; a few flow inputs are wired to nothing, and the token cache key /
force-refresh have small correctness gaps.

## Findings to fix
- **[Low] Token cache key ignores the password (and other identity inputs).** `tokens/token-store.js`
  `keyFor` (≈147) omits `password` (also `clientType`, `credentials`, `redirectUri`,
  `deviceAuthorizationUrl`). After changing only the password on a Resource-Owner-Password config,
  `acquireToken()` returns the **stale** token minted from the old password until it expires (auto-send is
  affected; the manual "Get Token" button uses `forceRefresh` and works around it). Include password (and the
  other identity-affecting fields) in the cache key.
- **[Medium] Advanced "state" field does nothing.** `components/auth/oauth2-fields.js` (≈251) writes
  `config.state`, which is persisted, template-resolved, and included in `gatherTemplates()`, but no flow
  reads it — `authorizationCodeFlow` and `implicitFlow` unconditionally call `generateState()`. Either **wire
  it** (validate it's high-entropy, then use it as the CSRF state) or **remove the field** so a security-minded
  user isn't misled into thinking a pinned state is in effect.
- **[Low] Custom implicit nonce is broken (latent).** `flows/implicit.js` (≈89) does
  `nonce = config.nonce?.trim() || generateNonce()` but a custom nonce is **never registered** in the TTL
  registry (`utils/nonce.js` ≈53), so `!validateNonce(payload.nonce)` (≈177) always fails. Currently
  unreachable (no nonce UI field), but it will break the moment a nonce override is added — register a
  user-supplied nonce when used (or drop the branch).
- **[Low] `forceRefresh` discards the refresh token.** `oauth-executor.js` `forceRefresh` (≈156) clears the
  store **before** `#refreshOrGrant`, throwing away the cached refresh token, so the manual "Refresh Token"
  button always re-runs the full grant (reopening the browser popup for auth-code) instead of a silent
  `refresh_token` exchange. Feed the component's `#authOAuth2.refreshToken` into the executor and prefer a
  silent refresh. (Auto-send already refreshes correctly via `acquireToken → #refreshOrGrant`.) Confirm the
  intended "force" semantics before changing.
- **[Low] Device-code pending status is a no-op.** `flows/device-code.js` (≈183)
  `handle.update?.({ status: undefined })` on `authorization_pending` does nothing (the prompt ignores an
  undefined `status`, ≈129), so the polling line never refreshes. Pass a real "waiting" status.

## Goal
Auth inputs the UI exposes actually take effect (or are removed), the token cache never returns a token minted
from stale credentials, and "Refresh Token" does a silent refresh when it can.

## Implementation steps
1. Add `password` (+ the other identity-affecting fields) to `token-store.js` `keyFor`.
2. Decide on `config.state`: wire with entropy validation, or remove the field + its bulk key + persistence.
3. Register a user-supplied implicit nonce (or remove the branch until a nonce field exists).
4. Make `forceRefresh` attempt a `refresh_token` exchange before falling back to a full grant.
5. Give device-code `authorization_pending` a real status message.

## Acceptance criteria
- Changing only the password on a password-grant config causes the next auto-send to fetch a fresh token.
- The "state" field either verifiably controls the CSRF state or is gone from the UI.
- "Refresh Token" performs a silent refresh (no browser popup) when a valid refresh token exists.
- `make test-auth` / `make test-oauth` green.

## Constraints
- Do **not** regress the sound parts: PKCE S256, state/nonce fail-closed matching + single-use TTL,
  `alg:none` rejection, implicit nonce check, tokens memory-only and stripped from `hippo:request-updated`.
- Tokens must never be logged or dispatched in events.

## Verify
`make test-auth && make test-oauth && make test`; then `make debug` against Keycloak (`make kc`): change a
password and confirm a new token; exercise silent refresh.
