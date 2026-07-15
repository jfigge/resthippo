# Feature 59 — HTTP engine: credential safety on redirect + robustness + URL redaction

> Source: full code review 2026-07-10 (networking grade B+). **High: signed-auth identity material leaked to a redirect's host.**

## Context
`src/app/net/http-engine.js` has strong hygiene (header validation, credential-header redaction in the
verbose log, cross-origin header/body stripping, bounded buffers), but the cross-origin protection stops at
literal headers and doesn't cover the signing descriptors, and a few nested-leg / logging edges remain.

## Findings to fix
- **[High] Cross-origin redirect re-signs for the new host.** The redirect recursion spreads `...desc`
  (including `awsIam`, `oauth1`, `authDigest`) and the SigV4 (≈656-676) / OAuth1 (≈685-710) / Digest (401 at
  ≈990) blocks re-run unconditionally on the new leg. The `crossOrigin` guard (≈944) strips only the literal
  `Authorization`/`Cookie`/`Proxy-Authorization` headers (`CREDENTIAL_HEADERS`), so a request that
  302/307-redirects to `evil.com` **re-signs for `evil.com`**, exposing the AWS `AccessKeyId`,
  `oauth_consumer_key`+`oauth_token`, or Digest `username=`. Fix: when `crossOrigin`, also clear/suppress
  `awsIam` / `oauth1` / `authDigest` (don't just drop headers) before the recursive `doRequest`.
- **[Medium] Nested request legs can hang the whole request.** Every nested `doRequest(...).then(resolve)`
  (NTLM negotiate, redirect, digest retry, NTLM challenge — ≈563-566, 979, 1037, 1100) omits `.catch`.
  `executeWithRetries`' try/catch only guards the *first* leg, so a synchronous throw in a later leg (e.g.
  `aws4.sign()` on a redirected URL it can't sign) leaves the outer promise unsettled → the `http:execute`
  IPC never resolves → the renderer spinner never clears. The NTLM branch additionally leaks its keep-alive
  `_ntlmAgent` (its `destroy()` lives only in the un-caught `.then`). Add `.catch(reject)` (and agent
  teardown) to each nested leg; the safety net at ≈1698-1722 should also settle these.
- **[Low] Digest `qop=auth-int` hashes an empty entity for non-AWS multipart.** `bodyBuffer` is only
  populated for the AWS-SigV4 multipart combo (≈632), so a plain multipart send passes `entityBody: null` and
  `digest.js` `buildAuthorization` (≈169-177) hashes `Buffer.alloc(0)` → auth fails against a server enforcing
  `auth-int`. Buffer the entity when `authDigest` + multipart + `auth-int`.
- **[Low] Full request URLs printed to stdout / persisted logs.** `http-engine.js` ≈1839/1877/1885
  `console.log("[http:execute] →", method, url)` emits the URL verbatim (unlike the redacted verbose log), so
  API keys / userinfo / query-string secrets reach stdout. Separately, `ipc/websocket.js:52`
  `console.log("[ws:open] →", opts.url)` is teed into the **rotating log that Export Diagnostics bundles**, so
  a `wss://user:pass@host` or `?access_token=…` URL lands on disk and in shared bug reports. Redact to
  origin/host (or gate behind a debug flag) in both places.

## Goal
No signed-auth credential material is ever sent to a host the user didn't target; a failed leg surfaces an
error instead of hanging; secret-bearing URLs never reach stdout or the diagnostics log.

## Implementation steps
1. In the cross-origin branch (≈944), null out `awsIam`, `oauth1`, `authDigest` on the descriptor passed to
   the redirect recursion (and keep the existing `CREDENTIAL_HEADERS` strip). Add a test to
   `net/tests/http-engine.test.js` asserting no `Authorization`/signature on a cross-origin redirect leg.
2. Add `.catch(reject)` to every nested `doRequest(...).then(resolve)`; destroy `_ntlmAgent` on the error
   path. Add a test that a synchronous throw in a non-first leg rejects (doesn't hang).
3. Populate `bodyBuffer` for multipart when Digest `auth-int` is in play; test the computed response matches.
4. Redact URLs in the `http:execute` console lines and `ipc/websocket.js:52` (log `new URL(url).host`), or
   remove them; keep the existing credential-header redaction in the verbose log.

## Acceptance criteria
- A cross-origin redirect carries no `Authorization`/signature and no AWS/OAuth1/Digest identity material.
- A throw in any request leg rejects the `http:execute` promise (renderer shows an error, never a stuck
  spinner); no `_ntlmAgent` leak.
- Digest `auth-int` multipart authenticates.
- No full request/WS URL appears in stdout or the rotating diagnostics log.
- `make test-net` green (with the new redirect + hang tests).

## Constraints
- Preserve existing correct behavior: proxy-agent TLS handling, NTLM-bypasses-proxy, MAS mTLS-disabled — all
  documented design choices, do not change.
- Keep credential-header redaction in the verbose log as-is.

## Verify
`make test-net && make test`. Manually: point a request with AWS SigV4 auth at an endpoint that redirects
cross-origin and confirm (via the mock server logs) the second host receives no signature.
