# Design 07 — De-duplicate OAuth validation & param assembly

## Context
The OAuth subsystem (`src/web/scripts/auth/`) duplicates the same logic across flows:
- **Required-field validation runs twice.** Each popup flow validates its own fields *and*
  `validateOAuthConfig` (`oauth-types.js:101`) validates again — the executor calls it
  before dispatch (`oauth-executor.js:54`). The same string "Client ID is required."
  appears in both `authorization-code.js:48` and `oauth-types.js:116`. Field-check **order**
  even differs (`password.js:24` vs `oauth-types.js:120-123`), so the first-error message
  can disagree.
- **The `new URL(authUrl)` validity check is copy-pasted** verbatim in
  `authorization-code.js:56-62` and `implicit.js:54-60`.
- **The extra-params merge loop is copy-pasted 5×:** `authorization-code.js:108-112` and
  `:181-185`, `client-credentials.js:43-47`, `implicit.js:102-106`, `password.js:49-53`.
- **Client-auth has three call shapes:** shared `applyClientAuth`
  (`client-credentials.js:51`, `password.js:57`), conditional with a flag
  (`authorization-code.js:191-195`), and hand-rolled (`refresh-token.js:46-56`).

## Goal
Each piece of OAuth logic lives in exactly one place; flows differ only where the grant
genuinely differs, and validation is not run twice.

## Implementation steps
1. **Single validation path.** Make `validateOAuthConfig` (`oauth-types.js`) the one
   source of required-field validation for every grant, including the `new URL(authUrl)`
   validity check for popup grants. Remove the per-flow duplicate field checks; flows
   assume config is already validated by the executor (`oauth-executor.js:54`). Reconcile
   field-check order so the first-error message is deterministic.
2. **Shared param merge.** Extract a `mergeExtraParams(target, src)` helper (e.g. in
   `auth/utils/`) and replace all five copies.
3. **Client-auth.** Make `applyClientAuth` cover the three current cases via options
   (e.g. `{ sendEmptySecret, skipForPkce }`) so `authorization-code` and `refresh-token`
   use it too, instead of conditional/hand-rolled blocks — unless a documented protocol
   reason requires divergence, in which case leave a comment.
4. Confirm scope/`audience`/`resource` handling is intentional per grant
   (`client-credentials.js:38` adds both; `password.js:45` adds audience only;
   `refresh-token` neither) — align the incidental omissions or document them.
5. Update `auth/tests/oauth.test.js` to cover the consolidated validation and helpers.

## Acceptance criteria
- Required-field validation exists in one place; flows do not re-validate.
- One `mergeExtraParams` helper, zero copies.
- One `applyClientAuth` path covering all grants (or documented exceptions).
- OAuth tests pass; error messages for missing fields are unchanged in wording.

## Constraints
- Plain class-based ES modules; keep the renderer-side OAuth/PKCE behavior identical.
- Never log or emit plaintext secrets.

## Verify
`make fmt && make lint && make test`
