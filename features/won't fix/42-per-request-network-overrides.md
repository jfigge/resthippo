# Feature 42 — Per-request / per-collection network overrides

## Context
Networking config is **global-only, with no per-request override**. Timeout, follow-redirects (boolean),
SSL-verify, and proxy all come solely from `currentSettings` (`src/web/scripts/components/settings-popup.js`
→ applied in `src/web/scripts/app.js` ~1597-1611). Real workflows need, e.g., SSL-verify off for one
internal host while staying on elsewhere, or a longer timeout for one slow endpoint — impossible today
without flipping a global toggle each time. Also, the redirect cap is hardcoded `maxRedirects = 10`
(`src/app/main.js` ~343) and never exposed, even though it's already plumbed as a descriptor field.

## Goal
Allow timeout, redirect behavior (follow + max count), SSL-verify, and proxy selection to be overridden per
request (and/or per collection), inheriting from global settings by default.

## Implementation steps
1. **Model**: add an optional `networkOverrides` block to the request (and collection) model — each field
   `inherit | <value>`. Default everything to inherit so existing requests are unchanged.
2. **UI**: add a small "Settings/Options" affordance in the request editor (e.g. a gear or a section in an
   Options tab) exposing timeout, follow-redirects + max redirects, verify-SSL, and proxy on/off/which.
   Show the effective (inherited) value when not overridden.
3. **Resolution & apply**: merge collection → request over global settings when building the execute
   descriptor in `app.js`, and pass the resolved values to `main.js`. Expose the already-plumbed
   `maxRedirects` so the redirect cap is configurable; coordinate per-request SSL-verify with Feature 37's
   trust config.
4. **Persistence**: store overrides; ensure they survive import/export where the target format supports it.
5. Update the user guide

## Acceptance criteria
- A single request can use a different timeout / redirect policy / SSL-verify / proxy than the global
  default, while other requests keep inheriting.
- The redirect max count is user-configurable (not hardcoded to 10).
- The editor shows whether a value is inherited or overridden.
- Requests with no overrides behave exactly as before.

## Constraints
- Resolution happens in the renderer; the main process keeps receiving a fully-resolved descriptor.
- Plain DOM + class-based ES modules; CSS tokens from `theme.css`.
- Additive, back-compatible request model (coordinate with schema versioning).

## Verify
`make fmt && make lint && make test`
