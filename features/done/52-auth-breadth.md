# Feature 52 — Auth breadth (device_code, token-exchange, OAuth 1.0a)

## Context
The implemented OAuth grants, Digest, NTLM, and AWS SigV4 are production-grade, but breadth gaps remain.
The OAuth grant dropdown is hard-coded to four values (`src/web/scripts/components/request-auth-editor.js`
~890-895) and `GrantType` (`src/web/scripts/auth/types/oauth-types.js`) defines no others, so:
- **Device Authorization (`device_code`)** — the standard flow for CLI/TV/headless auth — is **absent**
  (Insomnia offers it).
- **RFC 8693 Token Exchange** is **absent**. (Confusingly, `auth/flows/token-exchange.js` is **not** the
  token-exchange grant — it's a shared helper module of token-POST utilities; the name is misleading.)
- **OAuth 1.0a**, **Hawk**, and **Akamai EdgeGrid** are absent (Postman ships all three); OAuth 1.0a still
  appears on legacy enterprise APIs.

## Goal
Add the Device Authorization grant and RFC 8693 Token Exchange to OAuth2, add OAuth 1.0a as a top-level auth
type, and remove the naming confusion around the token-exchange helper.

## Implementation steps
1. **device_code**: add the grant to `GrantType` and the dropdown; implement the flow in `auth/flows/`
   (request device/user codes, show the user-code + verification-URL prompt, poll the token endpoint with
   the correct interval/backoff and `slow_down`/`authorization_pending` handling). Reuse the existing
   token-store caching/refresh.
2. **token_exchange (RFC 8693)**: add the grant + a real `token-exchange` flow (subject_token/-type,
   actor_token, requested scopes/audience/resource). **Rename the existing misnamed helper** (e.g.
   `auth/flows/token-request.js`) and update imports so the filename matches its role.
3. **OAuth 1.0a**: add a top-level auth type (consumer key/secret, token/secret, signature method
   HMAC-SHA1/256 + PLAINTEXT, nonce/timestamp). Sign in the main process where the request executes (like
   AWS SigV4), following the existing auth-type plug-in pattern.
4. **Optional**: scope Hawk/EdgeGrid as follow-ups if time allows; at minimum leave clean extension points.
5. Update the user guide

## Acceptance criteria
- `device_code` completes against a test IdP with a visible user-code prompt and correct polling; or is
  cleanly scoped/tested with a mock.
- `token_exchange` performs an RFC 8693 exchange and caches the result; the misnamed helper is renamed with
  no behavioral change to the four existing grants.
- OAuth 1.0a produces a correct `Authorization: OAuth …` signature for a known test vector.
- New auth types persist, encrypt secrets, and redact on export like existing ones.

## Constraints
- Stateful/ signing auth executes in the **main process**; follow the existing auth plug-in pattern.
- Reuse `crypto.js` secret encryption + redaction and the OAuth token-store; keep `main.js`/`preload.js`
  in sync.
- Don't regress the four existing OAuth grants when renaming the helper (covered by `auth/tests/oauth.test.js`).

## Verify
`make fmt && make lint && make test`
