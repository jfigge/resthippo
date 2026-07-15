# Feature 27 — Multi-request tabs

## Context
Only **one request** can be open at a time. The layout has a single mount point
`#request-editor-root` (`src/web/index.html`), and selecting a tree node fires `hippo:request-selected`,
which calls `requestEditor.load(node)` on the one shared `RequestEditor`
(`src/web/scripts/app.js` ~716-760), discarding whatever was open. The only "tabs" today are the sub-tabs
*inside* one request editor (Params/Headers/Body/Auth/Notes). Compare/iterate workflows (auth request →
data request) are slow and force a round-trip through the tree.

## Goal
Add a tabbed workspace so multiple requests can be open simultaneously, each retaining its own editor
state, with quick switching and clear dirty/unsaved indicators.

## Implementation steps
1. **Tab strip**: add an open-requests tab bar above `#request-editor-root` (distinct from the in-editor
   `.req-tab-strip`). Each tab = `{requestId, title, dirty}`. Support reorder (drag), middle-click close,
   close-others, and an overflow affordance.
2. **Editor lifecycle**: keep one `RequestEditor` per open tab (or a pooled instance that snapshots/
   restores per-tab state). Decouple `hippo:request-selected` so selecting a tree node opens-or-focuses a
   tab instead of replacing the single editor. Preserve unsaved edits when switching tabs.
3. **Persistence**: remember open tabs + active tab across restarts (reuse the settings/manifest store and
   the existing per-collection "selected request id" plumbing in `app.js`).
4. **Dirty state**: show an unsaved marker per tab; prompt before closing a dirty tab (reuse
   `PopupManager` confirm). Coordinate teardown with each component's `destroy()` to avoid leaked
   listeners.
5. Update user guide
6. Provide a global setting to disable multi-request tabs

## Acceptance criteria
- Multiple requests stay open at once; switching tabs preserves per-tab edits, scroll, and active sub-tab.
- Opening a request already open focuses its existing tab rather than duplicating it.
- Open tabs and the active tab survive an app restart.
- Closing a tab with unsaved changes warns first; closing leaks no listeners.
- A setting should allow tabs to be hidden

## Constraints
- No framework — plain DOM + class-based ES modules; match existing component style.
- CSS tokens from `theme.css`; styles in `components.css`; don't rename existing classes.
- Keep the emitted/consumed `CustomEvent` contract stable for components that don't care about tabs.

## Verify
`make fmt && make lint && make test`, then exercise open/close/reorder/switch and restart in `make debug`.
