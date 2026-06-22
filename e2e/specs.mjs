// specs.mjs — The Rest Hippo UI end-to-end specs.
//
// Each spec receives the helper surface `h` (see harness.mjs) and drives the
// live renderer the way a user would: clicking tree rows, switching tabs, typing
// into fields, firing requests against the mock API on :8888 and asserting on
// what the real components render back. A spec fails by throwing (assert).
//
// The dataset is the deterministic demo workspace from .docs-build/seed.mjs:
//   • "Demo API" collection: Users / GraphQL / Authentication / Content types /
//     WebSocket folders; "Petstore" collection.
//   • Local environment active → {{baseUrl}} = http://localhost:8888 (the mock).
import assert from "node:assert/strict";

export const specs = [];
const spec = (name, fn) => specs.push({ name, fn });

// ── App shell ──────────────────────────────────────────────────────────────────
spec("app-loads", async (h) => {
  // Seeded collections render as a non-empty tree…
  assert.ok((await h.count(".tree-node-row")) > 0, "tree has request rows");
  // …the active environment is the seeded "Local"…
  await h.waitForSel(".env-picker-trigger");
  const env = await h.text(".env-picker-trigger");
  assert.match(env, /Local/, `env picker shows Local (got: ${env})`);
  // …and the request/response panels are mounted.
  assert.ok(await h.exists("#panel-request"), "request panel present");
  assert.ok(await h.exists("#panel-response"), "response panel present");
});

spec("select-request", async (h) => {
  assert.ok(await h.selectReq("GET", "List users"), "List users row clicked");
  await h.waitForText(".req-url-input", "/echo");
  // {{baseUrl}} renders as a pill, so its braces are absent from textContent —
  // we assert on the literal URL tail that survives.
  const url = await h.value(".req-url-input");
  assert.match(url, /\/echo\?role=/, `URL bar shows seeded URL (got: ${url})`);
  const method = await h.text(".req-method-select");
  assert.match(method, /GET/, `method select shows GET (got: ${method})`);
});

// ── Request → response cycle ────────────────────────────────────────────────────
spec("send-and-response", async (h) => {
  await h.selectReq("GET", "List users");
  await h.waitForText(".req-url-input", "/echo");
  const r = await h.send();
  assert.equal(
    r.type,
    "hippo:response-received",
    "got a response, not an error",
  );
  assert.equal(r.status, 200, "mock /echo returns 200");
  await h.waitForSel(".res-status-badge");
  const badge = await h.text(".res-status-badge");
  assert.match(badge, /200/, `status badge shows 200 (got: ${badge})`);
  // The mock /echo reflects the request; the body should mention the method.
  await h.waitForText("#res-tab-body", "GET");
});

spec("create-user-roundtrip", async (h) => {
  await h.selectReq("POST", "Create user");
  await h.waitForText(".req-url-input", "/echo/users");
  const r = await h.send();
  assert.equal(r.status, 200, "POST create-user returns 200");
  // The JSON body we send is echoed back into the response body.
  await h.waitForText("#res-tab-body", "Ada Lovelace");
});

// ── Request tabs ─────────────────────────────────────────────────────────────────
spec("request-tabs-switch", async (h) => {
  await h.selectReq("GET", "List users");
  for (const id of ["params", "headers", "body", "auth", "captures"]) {
    assert.ok(await h.reqTab(id), `clicked ${id} tab`);
    await h.waitFor(
      `document.querySelector('.req-tab-btn[data-tab="${id}"]').classList.contains('req-tab-btn--active')`,
      { label: `${id} tab active` },
    );
  }
});

spec("params-tab", async (h) => {
  await h.selectReq("GET", "List users");
  await h.reqTab("params");
  await h.waitForSel(".params-row");
  // The seeded request carries a `role` query param.
  const names = await h.cdp.eval(
    `[...document.querySelectorAll('.params-name input, .params-name')].map(e=>e.value||e.textContent).join(',')`,
  );
  assert.match(names, /role/, `params include "role" (got: ${names})`);
});

spec("headers-tab", async (h) => {
  await h.selectReq("POST", "Create user");
  await h.reqTab("headers");
  // Header name/value live in <input>s (all panes are mounted; the seeded
  // Content-Type header is unique to this request's headers pane).
  await h.waitFor(
    `[...document.querySelectorAll('.req-tab-pane input')].some(i=>i.value==='Content-Type')`,
    { label: "Content-Type header input present" },
  );
});

spec("body-json", async (h) => {
  await h.selectReq("POST", "Create user");
  await h.reqTab("body");
  // The JSON body renders inside the code editor's contenteditable surface.
  await h.waitFor(
    `[...document.querySelectorAll('.req-tab-pane [contenteditable]')].map(e=>e.innerText).join(' ').includes('Ada Lovelace')`,
    { label: "JSON body editor shows seeded payload" },
  );
});

// ── Response tabs ────────────────────────────────────────────────────────────────
spec("response-tabs", async (h) => {
  await h.selectReq("GET", "List users");
  await h.send();
  await h.resTab("headers");
  await h.waitForText("#res-tab-headers", "content-type");
  await h.resTab("timeline");
  await h.waitFor(
    `document.querySelector('.res-tab-btn[data-tab="timeline"]').classList.contains('res-tab-btn--active')`,
    { label: "timeline tab active" },
  );
  await h.resTab("console");
  await h.waitFor(
    `document.querySelector('.res-tab-btn[data-tab="console"]').classList.contains('res-tab-btn--active')`,
    { label: "console tab active" },
  );
});

// ── Method picker (DOM dropdown via PopupManager.openMenu) ───────────────────────
spec("method-menu", async (h) => {
  await h.selectReq("GET", "List users");
  await h.sleep(120);
  await h.mouseSel(".req-method-select"); // opens on mousedown
  await h.waitForSel(".req-method-menu");
  const items = await h.cdp.eval(
    `[...document.querySelectorAll('.req-method-menu-item')].map(e=>e.textContent.trim()).join(',')`,
  );
  assert.match(items, /POST/, `method menu lists POST (got: ${items})`);
  assert.match(items, /DELETE/, "method menu lists DELETE");
  await h.escape();
});

// ── Environments ─────────────────────────────────────────────────────────────────
// NOTE: the env quick-switch and the tree row context menu are *native* OS menus
// (window.hippo.ui.contextMenu.show), which CDP cannot drive or inspect. We
// instead validate the environment end-to-end the way it actually matters: that
// the active "Local" environment's variables resolve into a fired request. The
// seeded Local env sets userId=42, so {{baseUrl}}/echo/users/{{userId}} must hit
// /echo/users/42 — which the mock reflects back in its response body.
spec("environments-resolve", async (h) => {
  // Active env is shown on the picker trigger.
  assert.match(
    await h.text(".env-picker-trigger"),
    /Local/,
    "active env is Local",
  );
  await h.selectReqByName("Get user by ID");
  await h.waitForText(".req-url-input", "/echo/users");
  const r = await h.send();
  assert.equal(r.status, 200, "request resolved and returned 200");
  await h.waitForText("#res-tab-body", "/echo/users/42");
});

// ── Collection variables popup ───────────────────────────────────────────────────
spec("collection-variables-popup", async (h) => {
  await h.clickSel("#btn-collection");
  await h.waitForSel(".popup--visible"); // the popup content (sibling of the mask)
  // The Demo API collection seeds a `defaultRole` collection variable, shown in
  // an editable <input> in the popup's variables grid.
  await h.waitFor(
    `[...document.querySelectorAll('.popup--visible input')].some(i=>i.value.includes('defaultRole'))`,
    { label: "collection var defaultRole shown" },
  );
  await h.closePopups();
  await h.waitForGone(".popup-overlay--visible");
});

// ── Settings popup ───────────────────────────────────────────────────────────────
spec("settings-popup", async (h) => {
  await h.clickSel("#btn-settings");
  await h.waitForSel(".popup-overlay--visible");
  assert.ok(
    await h.exists('[data-panel="appearance"]'),
    "appearance panel present",
  );
  // Navigate to the Request panel.
  await h.clickSel('[data-panel="request"]');
  await h.sleep(150);
  await h.closePopups();
  await h.waitForGone(".popup-overlay--visible");
});

// ── GraphQL ──────────────────────────────────────────────────────────────────────
spec("graphql-roundtrip", async (h) => {
  await h.selectReq("POST", "List users"); // the GraphQL "List users"
  await h.reqTab("body");
  // The GraphQL query renders in the code editor's contenteditable surface.
  await h.waitFor(
    `[...document.querySelectorAll('.req-tab-pane [contenteditable]')].map(e=>e.innerText).join(' ').includes('ListUsers')`,
    { label: "GraphQL query editor shows the seeded query" },
  );
  const r = await h.send();
  assert.equal(r.status, 200, "GraphQL query returns 200");
  await h.waitForText("#res-tab-body", "users");
});

// ── No-code captures & assertions ───────────────────────────────────────────────
spec("captures-tab", async (h) => {
  await h.selectReq("GET", "List users");
  await h.reqTab("captures");
  // The seeded capture extracts `.method` from the body into an env var; the
  // path renders in an editable <input>.
  await h.waitFor(
    `[...document.querySelectorAll('.req-tab-pane input')].some(i=>i.value.includes('.method'))`,
    { label: "seeded capture (.method) shown" },
  );
});

spec("response-tests", async (h) => {
  await h.selectReq("GET", "List users"); // seeds 4 assertions
  await h.send();
  await h.resTab("tests");
  await h.waitForSel("#res-tab-tests");
  // The assertions should resolve and report passes (status==200, etc.).
  const txt = await h.text("#res-tab-tests");
  assert.ok(txt && txt.length > 0, "tests pane rendered");
  await h.waitFor(
    `/pass/i.test(document.querySelector('#res-tab-tests').innerText)`,
    {
      label: "at least one passing assertion",
      timeout: 6000,
    },
  );
});

// ── Quick-access tabs (favorites / recents) ─────────────────────────────────────
spec("tree-tabs", async (h) => {
  await h.treeTab("Favorites");
  await h.waitFor(`document.querySelectorAll('.tree-node-row').length >= 0`);
  await h.sleep(150);
  const favs = await h.count(".tree-node-row");
  assert.ok(favs >= 1, `favorites populated (rows: ${favs})`);
  await h.treeTab("Recents");
  await h.sleep(150);
  assert.ok((await h.count(".tree-node-row")) >= 1, "recents populated");
  await h.treeTab("Requests"); // restore default tab for later specs
});

// ── Export / Backup modals (opened via app events) ──────────────────────────────
spec("export-modal", async (h) => {
  await h.cdp.eval(
    `window.dispatchEvent(new CustomEvent('hippo:export-all-requested'))`,
  );
  await h.waitForSel(".popup-overlay--visible");
  await h.closePopups();
  await h.waitForGone(".popup-overlay--visible");
});

spec("backup-modal", async (h) => {
  await h.cdp.eval(
    `window.dispatchEvent(new CustomEvent('hippo:backup-export-requested'))`,
  );
  await h.waitForSel(".popup-overlay--visible");
  await h.closePopups();
  await h.waitForGone(".popup-overlay--visible");
});

// ── Variable typeahead ({{ pill picker) ─────────────────────────────────────────
spec("variable-typeahead", async (h) => {
  await h.selectReq("GET", "Bearer token");
  await h.waitForSel(".req-url-input");
  // Put the caret at the end of the URL and type the pill trigger.
  await h.cdp.eval(`(()=>{
    const el=document.querySelector('.req-url-input'); el.focus();
    const r=document.createRange(); r.selectNodeContents(el); r.collapse(false);
    const s=getSelection(); s.removeAllRanges(); s.addRange(r); return true;})()`);
  await h.insertText("/{{");
  await h.waitFor(
    `!!document.querySelector('[class*="pill-picker"],[class*="typeahead"],[class*="autocomplete"]')`,
    { label: "variable typeahead visible", timeout: 4000 },
  );
  await h.escape();
});

// ── Response body search (Cmd+F) ────────────────────────────────────────────────
spec("response-search", async (h) => {
  await h.selectReq("GET", "List users");
  await h.send();
  await h.resTab("body");
  await h.waitForSel("#res-tab-body");
  // The find shortcut listens on #panel-response; focus must be inside it.
  await h.cdp.eval(
    `(()=>{const p=document.querySelector('.res-body-pre, #res-tab-body');if(p){p.tabIndex=0;p.focus();return true}return false})()`,
  );
  await h.sleep(120);
  await h.dispatchKey("f", "KeyF", 70, 4); // Cmd+F
  await h.waitFor(
    `!!document.querySelector('[class*="filter"],[class*="search"],[class*="find"]')`,
    { label: "response find/search bar visible", timeout: 4000 },
  );
  await h.escape();
});

// ── WebSocket connect → echo → disconnect ───────────────────────────────────────
spec("websocket-echo", async (h) => {
  await h.selectReqByName("Echo socket");
  await h.waitForText(".req-url-input", "ws://");
  // Connect (the send button doubles as Connect for the WS protocol).
  await h.clickSel(".req-send-btn");
  // Connected once the disconnect affordance appears.
  await h.waitFor(
    `(()=>{const t=document.querySelector('#panel-request')?.innerText||'';return /disconnect/i.test(t)})()`,
    { label: "websocket connected", timeout: 8000 },
  );
  // Send the seeded message and expect the echo frame to appear.
  await h.clickByText(".ws-composer-send, .ws-send, button", "Send");
  await h.waitFor(
    `(()=>{const t=document.querySelector('#panel-response')?.innerText||'';return t.includes('Hello, Rest Hippo!')})()`,
    { label: "echoed frame received", timeout: 8000 },
  );
  // Disconnect to leave the socket clean for later specs.
  await h.clickByText(".req-send-btn, button", "Disconnect").catch(() => {});
  await h.sleep(200);
});
