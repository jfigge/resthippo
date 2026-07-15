# Feature 09 — Cookie jar persistence

## Context
Cookies are displayed per-response (response viewer has a cookies tab) but are
**not persisted** and **not sent** on subsequent requests — there is no jar.
Real session flows (login → authenticated calls) need automatic cookie handling.
HTTP execution happens in the main process (`src/app/main.js`).

## Goal
Persist `Set-Cookie` responses into a per-collection (or per-environment) cookie
jar and automatically attach matching cookies to outgoing requests, with a UI to
view/edit/clear them.

## Implementation steps
1. **Jar model**: store cookies keyed by domain/path with attributes (expiry,
   secure, httpOnly, sameSite). Add a `cookie-store.js` under `src/app/store/`
   with the standard atomic-write pattern. Honor schema versioning (Feature 01).
2. **Capture**: in the main-process response handling, parse `Set-Cookie`
   headers and upsert into the jar (respecting domain/path/expiry).
3. **Attach**: before sending, compute the matching `Cookie` header for the
   target URL from the jar and merge with any user-set cookie header.
4. **UI**: a cookie manager (modal or panel) to list, edit, delete, and clear
   cookies. Add a per-request toggle to bypass the jar if needed.
5. Consider an existing RFC-6265 parser in `src/package.json` deps vs. a small
   vendored implementation; do not add heavy deps casually.

## Acceptance criteria
- A request that receives `Set-Cookie` causes the next matching request to send
  the cookie automatically.
- Domain/path scoping and expiry are respected; expired cookies are not sent.
- The cookie manager can view and clear the jar; clearing takes effect immediately.

## Constraints
- All cookie storage/attachment logic lives in the main process.
- Don't send cookies across non-matching domains.

## Verify
`make fmt && make lint && make test`
