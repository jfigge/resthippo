# Rest Hippo — Design-Consistency Prompts

Each file here is a **self-contained prompt** for one design-consistency fix found
during a codebase review. Like the feature prompts in the parent folder, open one,
hand it to Claude (or work it yourself), and it carries the context needed to land
the change without re-reviewing the whole app.

These are **refactors and consistency fixes**, not new features. Unless a prompt
says otherwise it must be **behavior-preserving** and leave the test suite green.
Work them roughly in number order — the lower numbers are functional fixes with
user-visible impact; the higher numbers are stylistic/maintainability cleanups.

## Every prompt assumes these project rules (from `CLAUDE.md`)

- Source lives in `src/app/` (main process) and `src/web/` (renderer). Do **not**
  modify `build/`, `src/node_modules/`, or `src/web/scripts/vendor/` (except the
  hand-authored `*-entry.js` esbuild inputs, regenerated via `make vendor-*`).
- No frameworks — plain DOM APIs and class-based ES modules. Match existing files.
- Use CSS custom properties from `src/web/styles/theme.css`; never hardcode
  colors/sizes. Component styles go in `src/web/styles/components.css`.
- IPC channels are registered in `src/app/main.js` and exposed via
  `src/app/preload.js` — keep the two in sync.
- Native dialogs, filesystem I/O, and HTTP/socket execution stay in the **main
  process**; the renderer talks to it exclusively over `window.hippo.*` IPC.
- Verify every change with: `make fmt && make lint && make test`.

## Prompts

### Tier 1 — functional (user-visible behavior, do first)

| # | Fix | Area |
|---|-----|------|
| 01 | Route authoritative writes through `safeCallWrite` | IPC / reliability |
| 02 | Make WebSocket-console text scale with the font-size setting | CSS |
| 03 | Give `window-state.json` the atomic-write guarantee | Storage / reliability |

### Tier 2 — cross-cutting architecture

| # | Fix | Area |
|---|-----|------|
| 04 | Unify the `variables` shape across import/export | Import/export |
| 05 | Standardize main-process error conventions | Main process |
| 06 | Add `io.js` fs helpers; delete the dead async write path | Storage |
| 07 | De-duplicate OAuth validation & param assembly | Auth |
| 08 | Share import auth/body helpers (mirror `export/redact.js`) | Import |
| 09 | Standardize component-to-app communication | Components |
| 10 | Standardize popup lifecycle (open/close/destroy) | Components |

### Tier 3 — stylistic / maintainability

| # | Fix | Area |
|---|-----|------|
| 11 | One state-class convention; reconcile BEM vs flat names | CSS |
| 12 | Shared base button + variant classes | CSS |
| 13 | Token cleanup (spacing, method colors, focus ring, weights) | CSS |
| 14 | One private-field convention (`#private`) | Components |
| 15 | Standardize DOM creation & HTML escaping | Components |
| 16 | One component error-surfacing convention | Components |
| 17 | Align store-module conventions | Storage |
| 18 | One IPC channel-naming convention | IPC |
