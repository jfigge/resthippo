/*
 * Copyright 2026 Jason Figge
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * response-overlay.test.js — overlay / popup lifecycle of ResponseViewer.
 *
 * The viewer coordinates a native HTML-preview WebContentsView with web-content
 * popups: any popup must hide the overlay (it renders above all web content),
 * snapshotting it first so the area doesn't blank, and re-show it once the LAST
 * popup closes. That orchestration is driven by a private popup-depth counter +
 * the hippo:popup-opened/-closed events, and by #switchTab's tab state machine —
 * all DOM/state logic with no geometry, so it's testable under jsdom with a
 * recording stub for window.hippo.preview. (The bounds math #computeBounds feeds
 * those calls is geometry the jsdom harness zeroes — the e2e geometry harness
 * covers that half.)
 *
 * Run with:   node --test src/web/scripts/tests/response-overlay.test.js
 */
"use strict";

// MUST precede the component import (the Prism bundle reads `Element` on load).
import { resetDom } from "./jsdom-setup.js";

import { test } from "node:test";
import assert from "node:assert/strict";

import { ResponseViewer } from "../components/response-viewer.js";

/** A window.hippo.preview that records every call by name. */
function recordingHippo() {
  const calls = [];
  const rec =
    (name, ret) =>
    (...args) => {
      calls.push({ name, args });
      return Promise.resolve(ret);
    };
  const html = {
    loadUrl: rec("html.loadUrl"),
    capture: rec("html.capture", "data:image/png;base64,AAAA"),
    hide: rec("html.hide"),
    show: rec("html.show"),
    resize: rec("html.resize"),
    destroy: rec("html.destroy"),
  };
  const pdf = {
    show: rec("pdf.show"),
    hide: rec("pdf.hide"),
    destroy: rec("pdf.destroy"),
  };
  return { hippo: { isElectron: true, preview: { html, pdf } }, calls };
}

function mountViewer({ electron = false } = {}) {
  const window = resetDom();
  const rec = electron ? recordingHippo() : { hippo: { isElectron: false } };
  window.hippo = rec.hippo;
  const viewer = new ResponseViewer();
  document.body.appendChild(viewer.element);
  return { window, viewer, calls: rec.calls ?? [] };
}

/** Let any deferred rAF / awaited-microtask work settle. */
const flush = () => new Promise((r) => setTimeout(r, 15));

const htmlResponse = () => ({
  request: { method: "GET", url: "http://x" },
  requestUrl: "http://x",
  status: 200,
  statusText: "OK",
  headers: { "content-type": "text/html" },
  cookies: [],
  body: "<html><body>hi</body></html>",
  elapsed: 5,
  size: 0,
  consoleLog: [],
});

const jsonResponse = () => ({
  request: { method: "GET", url: "http://x" },
  requestUrl: "http://x",
  status: 200,
  statusText: "OK",
  headers: { "content-type": "application/json" },
  cookies: [],
  body: '{"a":1}',
  elapsed: 5,
  size: 0,
  consoleLog: [],
});

async function show(window, detail) {
  window.dispatchEvent(
    new window.CustomEvent("hippo:response-received", { detail }),
  );
  await flush();
}

const openPopup = (window) =>
  window.dispatchEvent(new window.CustomEvent("hippo:popup-opened"));
const closePopup = (window) =>
  window.dispatchEvent(new window.CustomEvent("hippo:popup-closed"));

// ── #switchTab DOM state machine (no geometry) ──────────────────────────────

test("#switchTab toggles the active tab button and the visible pane", async () => {
  const { window, viewer } = mountViewer();
  await show(window, jsonResponse());

  const btn = (tab) => viewer.element.querySelector(`[data-tab="${tab}"]`);
  const pane = (tab) => viewer.element.querySelector(`#res-tab-${tab}`);

  // Body is the default active tab.
  assert.ok(btn("body").classList.contains("res-tab-btn--active"));
  assert.equal(pane("body").hidden, false);

  btn("headers").click();
  assert.ok(btn("headers").classList.contains("res-tab-btn--active"));
  assert.equal(btn("headers").getAttribute("aria-selected"), "true");
  assert.ok(!btn("body").classList.contains("res-tab-btn--active"));
  assert.equal(pane("headers").hidden, false, "headers pane shown");
  assert.equal(pane("body").hidden, true, "body pane hidden");
});

// ── HTML-preview overlay lifecycle (Electron) ───────────────────────────────

/** Bring the viewer into the html-preview-active state and clear setup calls. */
async function activatePreview(window, viewer, calls) {
  await show(window, htmlResponse());
  const previewBtn = viewer.element.querySelector('[data-tab="preview"]');
  assert.ok(previewBtn && !previewBtn.hidden, "Preview tab visible for HTML");
  previewBtn.click(); // → #switchTab("preview") → activates the overlay
  await flush();
  calls.length = 0; // drop the activation's loadUrl etc.
}

test("a popup hides the live HTML preview after snapshotting it", async () => {
  const { window, viewer, calls } = mountViewer({ electron: true });
  await activatePreview(window, viewer, calls);

  openPopup(window);
  await flush();

  const names = calls.map((c) => c.name);
  assert.ok(names.includes("html.capture"), "snapshot captured first");
  assert.ok(names.includes("html.hide"), "live overlay hidden under the popup");
});

test("closing the last popup re-shows the HTML preview", async () => {
  const { window, viewer, calls } = mountViewer({ electron: true });
  await activatePreview(window, viewer, calls);

  openPopup(window);
  await flush();
  calls.length = 0;

  closePopup(window);
  await flush();
  assert.ok(
    calls.some((c) => c.name === "html.show"),
    "overlay re-shown once the popup is gone",
  );
});

test("nested popups: the overlay re-shows only after the LAST popup closes", async () => {
  const { window, viewer, calls } = mountViewer({ electron: true });
  await activatePreview(window, viewer, calls);

  openPopup(window); // depth 1
  await flush();
  openPopup(window); // depth 2
  await flush();
  calls.length = 0;

  closePopup(window); // depth 1 — still a popup open
  await flush();
  assert.ok(
    !calls.some((c) => c.name === "html.show"),
    "not re-shown while a popup remains open",
  );

  closePopup(window); // depth 0 — all popups gone
  await flush();
  assert.ok(
    calls.some((c) => c.name === "html.show"),
    "re-shown after the final popup closes",
  );
});
