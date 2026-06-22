# e2e — UI end-to-end suite

Drives the **real** Rest Hippo app — a live Electron renderer + the Node main
process + the preload IPC bridge — the way a user would: clicking tree rows,
switching tabs, typing into fields, firing requests at the mock API and
asserting on what the production components render back.

It reuses the Chrome DevTools Protocol client from `.docs-build/cdp.mjs` (the
same transport the docs-screenshot pipeline uses), so there is **no Playwright /
Puppeteer dependency** — the project deliberately ships none.

## Running

```bash
make test-e2e                      # whole suite
make test-e2e NAMES="send graphql" # only specs whose name matches a term
# or directly:
node e2e/run.mjs
node e2e/run.mjs websocket response
KEEP_OPEN=1 node e2e/run.mjs app-loads   # leave the app running to poke at it
```

`run.mjs` is self-contained — it:

1. seeds an isolated, secret-free data dir at `e2e/.data/` (reuses
   `.docs-build/seed.mjs`; gitignored, clobbered each run);
2. ensures the Go mock API is up on `:8888` — reuses a running one (e.g. from
   `make mock-up`) or launches `mock/mock-server` and tears it back down;
3. launches Electron with `--remote-debugging-port=9222` pointed at the seeded
   data dir;
4. connects over CDP and runs every spec in `specs.mjs`;
5. tears down everything it started and exits non-zero if any spec failed.

It is **deliberately not part of `make test`** — it needs a display server, a
real Electron process and the mock API, none of which belong in the hermetic
unit-test gate (that gate's jsdom-level cousin is
`src/web/scripts/tests/renderer-e2e.test.js`). Run it on demand / before a
release.

## Files

- `harness.mjs` — CDP-bound UI-driving helpers: queries (`exists`/`text`/
  `value`/`count`), actions (`selectReq`/`reqTab`/`send`/`mouseSel`/`typeInto`),
  and deterministic waits (`waitFor`/`waitForText`/`waitForGone`). `send()`
  resolves on the app's own `hippo:response-received` / `hippo:request-error`
  window event, so it is correct across back-to-back requests.
- `specs.mjs` — the specs themselves: `export const specs = [{ name, fn(h) }]`.
  Add a spec with `spec("my-name", async (h) => { … })`.
- `run.mjs` — the orchestrator described above.

## Adding a spec

```js
spec("my-feature", async (h) => {
  await h.selectReq("GET", "List users");
  const r = await h.send();
  assert.equal(r.status, 200);
  await h.waitForText("#res-tab-body", "expected");
});
```

Tips drawn from the existing specs:

- **All request tab panes are mounted at once** (`.req-tab-pane` ×8, shown/hidden
  via CSS), so `querySelector('.req-tab-pane')` is always the *params* pane.
  Assert on content-specific hooks instead — header/capture values live in
  `<input>`s; body/GraphQL text lives in a `[contenteditable]`.
- **`{{variables}}` render as pills**, so their braces are absent from
  `textContent` — match the literal tail (`/echo?role=`), not the `{{…}}`.
- **Popups**: the visible content is `.popup--visible` (a sibling of the
  `.popup-overlay--visible` click-catching mask) — read content from the former,
  close by clicking the latter (`h.closePopups()`).
- Menus that open on `mousedown` (the HTTP-method picker) need a **trusted**
  mouse event — use `h.mouseSel(sel)`, not `h.clickSel(sel)`.

## Limitations

- **Native OS menus are not covered.** The environment quick-switch and the tree
  row right-click context menu render through `window.hippo.ui.contextMenu.show`
  (a real Electron menu), which CDP cannot drive or inspect — the same limitation
  the docs pipeline notes. Environment behaviour is instead validated through
  variable *resolution* (`environments-resolve`).
- **WebContentsView overlays** (HTML Preview, PDF viewer) live outside the main
  web contents and aren't asserted here.
- The run opens a real app window; CDP input is delivered to the renderer
  regardless of OS focus, but don't fight it for the keyboard while it runs.
