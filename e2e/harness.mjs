// harness.mjs — UI-driving helpers for the Rest Hippo end-to-end tests.
//
// These tests drive the *real* Electron renderer over the Chrome DevTools
// Protocol — the same transport the docs-screenshot pipeline uses — so they
// exercise the production components, the preload IPC bridge, and the Node main
// process exactly as a user would. We reuse the minimal CDP client from
// .docs-build/cdp.mjs (no Playwright/Puppeteer dependency — the project
// deliberately ships none) and layer trusted-input + DOM-query helpers on top.
//
// Helpers come in three flavours:
//   • queries   — exists / count / text / attr / value (read the live DOM)
//   • actions   — clickSel / selectReq / reqTab / send / type / mouseSel …
//   • waits     — waitFor / waitForGone / waitResponse (deterministic polling,
//                 never fixed sleeps for correctness — sleeps are jitter-only)
//
// Selectors mirror the renderer's stable hooks: tree rows (.tree-node-row /
// .tree-node-method), request/response tab strips (.req-tab-btn /
// .res-tab-btn keyed by data-tab), the send button (.req-send-btn), the status
// badge (.res-status-badge) and PopupManager's overlay (.popup-overlay--visible).
import { CDP } from "../.docs-build/cdp.mjs";

const J = JSON.stringify;

/** Connect to the already-running app's page target (see run.mjs for launch). */
export async function connect() {
  return CDP.connect();
}

/**
 * Build the helper surface bound to a connected CDP session. Every action
 * returns a Promise; queries resolve to JSON values evaluated in the page.
 */
export function makeHelpers(cdp) {
  // ── raw eval wrappers ───────────────────────────────────────────────────────
  // Guarded eval: a selector miss returns a sentinel instead of throwing, so
  // callers branch on the value rather than on exceptions.
  const evalSafe = (expr) =>
    cdp.eval(
      `(()=>{try{return (${expr})}catch(e){return ["__e2e_err__",String(e)]}})()`,
    );

  // ── queries ─────────────────────────────────────────────────────────────────
  const exists = (sel) => cdp.eval(`!!document.querySelector(${J(sel)})`);
  const count = (sel) =>
    cdp.eval(`document.querySelectorAll(${J(sel)}).length`);
  const text = (sel) =>
    cdp.eval(
      `(()=>{const e=document.querySelector(${J(sel)});return e?e.textContent.trim():null})()`,
    );
  const attr = (sel, name) =>
    cdp.eval(
      `(()=>{const e=document.querySelector(${J(sel)});return e?e.getAttribute(${J(name)}):null})()`,
    );
  // Form value OR contenteditable text (the URL bar is a contenteditable div).
  const value = (sel) =>
    cdp.eval(
      `(()=>{const e=document.querySelector(${J(sel)});if(!e)return null;return ("value" in e && e.value!=="")?e.value:e.textContent})()`,
    );
  // Whole-document text — handy for "did this message render anywhere" checks.
  const bodyText = () => cdp.eval(`document.body.innerText`);

  // ── waits ───────────────────────────────────────────────────────────────────
  // Poll a boolean page expression until truthy or timeout. Deterministic: we
  // advance the instant the condition holds, not after a worst-case sleep.
  async function waitFor(expr, { timeout = 8000, interval = 120, label } = {}) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
      last = await cdp.eval(
        `(()=>{try{return !!(${expr})}catch(e){return false}})()`,
      );
      if (last) return true;
      await cdp.sleep(interval);
    }
    throw new Error(`waitFor timed out (${timeout}ms): ${label || expr}`);
  }
  const waitForSel = (sel, opts) =>
    waitFor(`document.querySelector(${J(sel)})`, { label: sel, ...opts });
  const waitForGone = (sel, opts) =>
    waitFor(`!document.querySelector(${J(sel)})`, {
      label: `gone:${sel}`,
      ...opts,
    });
  const waitForText = (sel, needle, opts) =>
    waitFor(
      `(()=>{const e=document.querySelector(${J(sel)});return e&&e.textContent.includes(${J(needle)})})()`,
      { label: `${sel} ⊇ "${needle}"`, ...opts },
    );

  // ── trusted input (CDP) ─────────────────────────────────────────────────────
  // Synthetic .click() can't open menus that bind on mousedown, so for those we
  // use real Input.dispatchMouseEvent at an element's centre.
  async function mouseAt(x, y, button = "left") {
    const buttons = button === "right" ? 2 : 1;
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button,
      clickCount: 1,
      buttons,
    });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button,
      clickCount: 1,
      buttons: 0,
    });
  }
  async function mouseSel(sel, button = "left") {
    const r = await cdp.rect(sel);
    if (!r) return false;
    await mouseAt(r.x + r.width / 2, r.y + r.height / 2, button);
    return true;
  }
  async function dispatchKey(key, code, vk, modifiers = 0) {
    for (const type of ["keyDown", "keyUp"]) {
      await cdp.send("Input.dispatchKeyEvent", {
        type,
        key,
        code,
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
        modifiers,
      });
    }
  }
  const escape = () => dispatchKey("Escape", "Escape", 27);
  const insertText = (text) => cdp.send("Input.insertText", { text });

  async function focusSel(sel) {
    return cdp.eval(
      `(()=>{const e=document.querySelector(${J(sel)});if(!e)return false;e.focus();return document.activeElement===e})()`,
    );
  }
  // Replace a (contenteditable or input) field's content with `txt`, via real
  // keyboard input so the app's input listeners fire as they would for a user.
  async function typeInto(sel, txt) {
    const ok = await focusSel(sel);
    if (!ok) return false;
    // Select-all then overwrite. Cmd+A (mac) selects, insertText replaces.
    await dispatchKey("a", "KeyA", 65, 4 /* Meta */);
    await insertText(txt);
    return true;
  }

  // ── clicks ──────────────────────────────────────────────────────────────────
  const clickSel = (sel) =>
    cdp.eval(
      `(()=>{const e=document.querySelector(${J(sel)});if(e){e.click();return true}return false})()`,
    );
  const clickByText = (sel, label) =>
    cdp.eval(`(()=>{
      const els=[...document.querySelectorAll(${J(sel)})];
      const e=els.find(x=>x.textContent.trim()===${J(label)})||els.find(x=>x.textContent.trim().startsWith(${J(label)}));
      if(e){e.click();return true}return false})()`);

  // ── tree / tabs ─────────────────────────────────────────────────────────────
  // Select a request row by HTTP method + visible name (disambiguates the two
  // "List users" rows — one GET, one GraphQL POST).
  const selectReq = (method, name) =>
    cdp.eval(`(()=>{
      const rows=[...document.querySelectorAll('.tree-node-row')];
      const row=rows.find(r=>{const m=r.querySelector('.tree-node-method');return m&&m.textContent.trim()===${J(method)}&&r.innerText.includes(${J(name)});});
      if(row){row.click();return true}return false})()`);
  const selectReqByName = (name) =>
    cdp.eval(`(()=>{
      const rows=[...document.querySelectorAll('.tree-node-row')];
      const row=rows.find(r=>r.innerText.includes(${J(name)}));
      if(row){row.click();return true}return false})()`);
  // Request / response tabs are keyed by a stable data-tab id (i18n-proof).
  const reqTab = (id) => clickSel(`.req-tab-btn[data-tab="${id}"]`);
  const resTab = (id) => clickSel(`.res-tab-btn[data-tab="${id}"]`);
  const treeTab = (label) => clickByText(".tree-tab", label);

  // ── request lifecycle ───────────────────────────────────────────────────────
  // Fire the request and resolve when the app dispatches the matching window
  // event (response-received | request-error) — deterministic, and works across
  // back-to-back sends (a stale .res-status-badge would not).
  async function send({ timeout = 15000 } = {}) {
    await cdp.eval(`(()=>{
      window.__e2eResp=null;
      const h=(e)=>{window.__e2eResp={type:e.type,status:e.detail?.status??null,error:e.detail?.message??null};
        window.removeEventListener('hippo:response-received',h);
        window.removeEventListener('hippo:request-error',h);};
      window.addEventListener('hippo:response-received',h);
      window.addEventListener('hippo:request-error',h);
      return true;})()`);
    const clicked = await clickSel(".req-send-btn");
    if (!clicked) throw new Error("send: no .req-send-btn to click");
    await waitFor(`window.__e2eResp`, {
      timeout,
      label: "response/error event",
    });
    return cdp.eval(`window.__e2eResp`);
  }

  // ── popups / toasts ─────────────────────────────────────────────────────────
  const popupVisible = () => exists(".popup-overlay--visible");
  async function closePopups() {
    await cdp.eval(
      `document.querySelector('.popup-overlay--visible')?.click()`,
    );
    await escape();
    await cdp.sleep(150);
  }
  const clearToasts = () =>
    cdp.eval(
      `document.querySelectorAll('[class*="notification"],[class*="toast"]').forEach(e=>e.remove())`,
    );

  const sleep = (ms) => cdp.sleep(ms);

  return {
    cdp,
    evalSafe,
    exists,
    count,
    text,
    attr,
    value,
    bodyText,
    waitFor,
    waitForSel,
    waitForGone,
    waitForText,
    mouseAt,
    mouseSel,
    dispatchKey,
    escape,
    insertText,
    focusSel,
    typeInto,
    clickSel,
    clickByText,
    selectReq,
    selectReqByName,
    reqTab,
    resTab,
    treeTab,
    send,
    popupVisible,
    closePopups,
    clearToasts,
    sleep,
  };
}
