# Feature 44 — Proxy completeness (SOCKS, auth, bypass) & request retries

## Context
Proxy support is minimal and there are no retries. The only agent is `HttpsProxyAgent` from a single global
`proxyUrl` (`src/app/main.js` ~529) — HTTP/HTTPS CONNECT only, no SOCKS, proxy auth only via URL userinfo
(`http://user:pass@host`), and no bypass/no-proxy list. Corporate SOCKS5 proxies and "bypass proxy for
these hosts" are standard in Postman/Insomnia. Separately, there are **no retries** anywhere (the only
"retry" is the Digest/NTLM one-shot auth re-send), so flaky endpoints and smoke/load testing aren't served.

## Goal
Extend proxy support to SOCKS plus separate proxy credentials and a bypass list, and add a configurable
request retry policy.

## Implementation steps
1. **Proxy types**: support HTTP/HTTPS and SOCKS proxies — select the appropriate agent
   (`https-proxy-agent` vs a `socks-proxy-agent`) by scheme. Add separate username/password fields
   (encrypted via `crypto.js`, like the existing `proxyUrl`) instead of requiring inline userinfo.
2. **Bypass list**: add a no-proxy host/glob list; skip the proxy for matching hosts (honor a common
   `NO_PROXY`-style syntax). Keep the NTLM-handshake proxy bypass already in `main.js`.
3. **Retries**: add a retry policy (max attempts, backoff, and which conditions — connection errors,
   timeouts, optionally specific 5xx). Apply in the main-process execution path; surface attempt counts in
   the response Console. Make it overridable per request via Feature 42.
4. **Settings UI**: extend the Proxy section (`settings-popup.js`) for type/credentials/bypass and add a
   retry section.

## Acceptance criteria
- A SOCKS5 proxy works; HTTP/HTTPS proxies still work, now with separate (encrypted) credentials.
- Hosts in the bypass list connect directly, ignoring the proxy.
- A flaky endpoint succeeds within the configured retries with backoff; retries are visible in the Console.
- Proxy credentials are encrypted at rest and redacted on export.

## Constraints
- Proxy/agent selection and retry logic live in the **main process**.
- Reuse `crypto.js` secret encryption + redaction; keep `main.js`/`preload.js` in sync.
- Evaluate vetted, maintained proxy-agent deps; avoid heavy/unmaintained packages.

## Verify
`make fmt && make lint && make test`
