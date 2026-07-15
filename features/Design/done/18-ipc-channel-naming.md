# Design 18 — One IPC channel-naming convention

## Context
IPC channels (`src/app/main.js` ↔ `src/app/preload.js`) mostly follow `area:noun:verb`
with colon separators (all 24 `store:*` channels, e.g. `store:requests:create`,
`store:history:response:get`), but several families invent their own shape:
- **camelCase segments** — `htmlPreview:loadUrl`, `htmlPreview:capture`,
  `pdfPreview:loadFile` (`main.js:1767,1817,1968`).
- **dash + verb-first, no third segment** — `export:save-file`, `import:open-file`,
  `backup:prepare-import` (`main.js:2371,2392,2486`).
- **inconsistent `ui:` family** — `ui:context-menu:show` (`main.js:1638`) vs.
  `ui:edit-context-menu` (`main.js:1676`) — two shapes for the same menu concern.

The preload surface also sometimes renames the verb (`http:body:get` → `http.getBody`,
`oauth:open-popup` → `oauth.openPopup`) while the whole `store` namespace mirrors the final
channel segment verbatim.

## Goal
One documented channel-naming convention applied to all channels, with the preload API
surface mirroring it predictably.

## Implementation steps
1. Adopt the dominant `area:noun:verb` colon convention with lowercase, hyphenated
   multi-word segments (e.g. `preview:html:load-url`, `preview:pdf:load-file`,
   `export:file:save`, `import:file:open`, `ui:context-menu:show`,
   `ui:context-menu:edit`). Document it in `CLAUDE.md`.
2. Rename the off-convention channels in `main.js` and update the matching `preload.js`
   exposures **in the same commit** — every channel must have exactly one handler and one
   preload entry. Grep both files to confirm no orphans on either side.
3. Decide the preload method-name rule: mirror the final channel verb (as `store.*` does)
   rather than ad-hoc renames, OR document the camelCase mapping as intentional and apply it
   uniformly. Pick one.
4. Update every renderer call site that uses a renamed `window.hippo.*` method.
5. Add/adjust a test (or a simple assertion) that every registered handler has a matching
   preload exposure and vice versa, to prevent future drift.

## Acceptance criteria
- All channels follow the documented `area:noun:verb` convention.
- `main.js` and `preload.js` are in sync — no orphan handler or orphan exposure.
- Renderer call sites updated; the app functions identically.
- A check exists guarding handler/preload parity.

## Constraints
- Behavior-preserving; channel renames are internal.
- Keep `main.js`/`preload.js` in lockstep — this is the project's cardinal IPC rule.

## Verify
`make fmt && make lint && make test`
