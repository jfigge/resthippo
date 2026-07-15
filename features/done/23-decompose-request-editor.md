# Feature 23 — Decompose `request-editor.js` into sub-components

## Context
`src/web/scripts/components/request-editor.js` is ~5,200 lines — by far the largest
file in the codebase and a god-object. A single `RequestEditor` class owns the HTTP
method/URL input, the headers and query-param grids, the request body/payload tabs,
**and** all seven auth schemes (Basic, Bearer, API-key, Digest, NTLM, OAuth2 with
OIDC discovery, AWS IAM). It is well-encapsulated (private `#` fields, a reusable
`AutocompleteDropdown`) but its breadth makes it hard to navigate, test, and change
safely. The component communicates outward via `CustomEvent` on `window`.

## Goal
- Split `RequestEditor` into focused sub-components without changing behavior, so each
  concern can be read, tested, and modified independently.
- Due to the large size of ths file, focus only on distinct sections that easily be
  isolated and abstracted.  Do not attempt to separate combined logic

## Acceptance criteria
- `request-editor.js` is materially smaller; auth, headers/params, and body live in
  their own component files following the existing class-based pattern.
- No behavioral change: all existing flows (every auth scheme, header/param edit,
  body modes, OIDC discovery) work exactly as before.
- The emitted/consumed `CustomEvent` contract and persisted model are unchanged.
- `make fmt && make lint && make test` pass.

## Constraints
- Plain DOM + class-based ES modules — no framework, match existing component style.
- Use CSS tokens from `theme.css`; keep styles in `components.css`. Do not rename
  existing CSS classes (no styling regressions).
- Pure refactor — defer new features (e.g. tabs from Feature 14) to their own work.
- Where practical, give each new component a `destroy()`/teardown method
  (coordinate with Feature 23).

## Verify
`make fmt && make lint && make test`, then exercise each auth scheme, header/param
editing, and every body mode in `make debug` to confirm parity.
