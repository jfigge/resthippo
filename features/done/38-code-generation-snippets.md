# Feature 38 — Multi-language code-generation snippets

## Context
Code generation is **cURL-only**. The single generator is `#buildCurl` in
`src/web/scripts/components/tree-view.js` (~914-1086), invoked via the request context menu's
"Generate cURL". There are no other targets (no JS fetch/axios, Python requests, Go, etc.). Postman and
Insomnia generate snippets for ~20 language/library targets — a common way to move a request into code.

Note: the collection-level branch of `#buildCurl` is currently **unreachable dead code** (no menu item
invokes it); fold its intent into the new generator design or remove it.

## Goal
Add a "Generate code" action offering multiple language/library targets (at minimum: cURL, JavaScript
`fetch`, Python `requests`, and a couple more), with a copy-to-clipboard preview dialog.

## Implementation steps
1. **Generator module**: factor request→code generation into a dedicated module with a small per-target
   interface, reusing the variable-resolution and request-shape logic already in `#buildCurl` (method/url/
   headers/params/body incl. multipart + file, plus basic/bearer auth headers; AWS-SigV4 can't be static —
   keep the existing bail-out).
2. **Targets**: implement cURL, JS `fetch`, Python `requests` first; structure so adding Go/HTTPie/etc. is
   trivial. Honor enabled/disabled rows and resolved variables; warn on unresolved variables as the cURL
   path already does.
3. **UI**: replace the single "Generate cURL" menu item with a "Generate code…" dialog — target dropdown +
   highlighted preview + Copy. Keep a direct "Copy as cURL" for speed.
4. **Cleanup**: remove or wire up the unreachable collection-level cURL branch so there's no dead code.
5. Update the user guide

## Acceptance criteria
- A request can be exported to cURL, JS `fetch`, and Python `requests`, each runnable/valid for a simple
  GET and a JSON POST.
- Generated snippets respect headers/params/body/auth and resolved variables; unresolved variables warn.
- The new target interface makes adding a language a small, localized change.
- No unreachable generation code remains.

## Constraints
- Plain DOM + class-based ES modules; reuse existing resolution/shape logic — don't duplicate it.
- CSS tokens from `theme.css`; styles in `components.css`.
- Clipboard via the existing mechanism; no new heavy dependency for templating.

## Verify
`make fmt && make lint && make test`
