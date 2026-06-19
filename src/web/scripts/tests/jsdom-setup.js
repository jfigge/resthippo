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
 * tests/jsdom-setup.js
 *
 * Side-effect module that installs a headless jsdom DOM onto the Node globals so
 * the renderer's DOM components (RequestEditor, ResponseViewer, the Prism vendor
 * bundle, …) can be instantiated under `node --test` with no display.
 *
 * Why jsdom (the one new test dependency): the renderer tier is ~2.5k-line pure
 * DOM classes that call document.createElement, classList, getSelection,
 * createRange, requestAnimationFrame, and import the Prism bundle (which touches
 * `Element` at module-load). There is no dependency-light stub that reproduces
 * that surface faithfully, and the alternative — booting the whole Electron app —
 * is what the acceptance criteria explicitly forbid. jsdom is the standard
 * headless DOM, is a devDependency only, and is never bundled into the shipped
 * app.
 *
 * IMPORTANT: this module must be imported BEFORE any component module, because
 * the Prism vendor bundle dereferences `Element` at evaluation time. ESM
 * evaluates a side-effect import listed first ahead of later imports, so placing
 * `import "./jsdom-setup.js";` at the top of a test file is sufficient.
 */

"use strict";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { applyCatalog } from "../i18n.js";

const GLOBAL_KEYS = [
  "CustomEvent",
  "Event",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "DocumentFragment",
  "Range",
  "NodeFilter",
  "DOMParser",
  "getComputedStyle",
  "CSS",
  "MutationObserver",
  "KeyboardEvent",
  "MouseEvent",
  "InputEvent",
];

/**
 * Build a fresh jsdom window and rebind it onto the Node globals the renderer
 * components read at construction time (`window`, `document`, and the DOM
 * constructor classes + the Prism bundle reference). Returns the new window.
 *
 * Because the components register their event listeners on the global `window`
 * in their constructors, every call to `resetDom()` yields a clean window with
 * no listeners from a prior test — the unit of isolation between cases that each
 * instantiate their own RequestEditor/ResponseViewer.
 *
 * @returns {Window} the freshly-installed jsdom window
 */
let _activeDom = null;

export function resetDom() {
  // Tear down the previous instance so jsdom windows (and their timers/listeners)
  // do not accumulate across tests in the shared process.
  if (_activeDom) _activeDom.window.close();

  const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  _activeDom = dom;
  const { window } = dom;

  // `navigator` is a read-only getter on Node's globalThis, so it is left as
  // Node provides it; everything else the components touch is rebound here.
  globalThis.window = window;
  globalThis.self = window;
  globalThis.document = window.document;
  for (const key of GLOBAL_KEYS) {
    if (window[key] !== undefined) globalThis[key] = window[key];
  }

  // jsdom does not drive an animation frame loop; a microtask-ish shim is enough
  // for the components, which only use rAF to defer non-critical work.
  const raf = (cb) => setTimeout(() => cb(Date.now()), 0);
  globalThis.requestAnimationFrame = raf;
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  window.requestAnimationFrame = raf;
  window.cancelAnimationFrame = globalThis.cancelAnimationFrame;

  // jsdom implements Blob but not object URLs — the binary (image) view needs
  // URL.createObjectURL. Stub it on the global URL the component references.
  if (globalThis.URL && !globalThis.URL.createObjectURL) {
    globalThis.URL.createObjectURL = () => "blob:stub";
    globalThis.URL.revokeObjectURL = () => {};
  }

  // jsdom doesn't implement CSS.escape — renderer code (e.g. TreeView) uses the
  // bare global to escape ids in attribute selectors. A spec-adequate shim
  // (backslash-escape anything outside [A-Za-z0-9_-]) covers the id/uuid cases.
  if (typeof globalThis.CSS?.escape !== "function") {
    const escape = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c);
    globalThis.CSS = Object.assign(globalThis.CSS ?? {}, { escape });
    window.CSS = globalThis.CSS;
  }

  // jsdom exposes localStorage on window only; renderer code reads the bare
  // global (e.g. TreeView's collapsed-state persistence).
  globalThis.localStorage = window.localStorage;

  // jsdom has no layout engine, so scrollIntoView is missing — the find-in-
  // response navigator calls it on each match. A no-op keeps search tests quiet.
  if (window.Element && !window.Element.prototype.scrollIntoView) {
    window.Element.prototype.scrollIntoView = () => {};
  }

  // Likewise, Range geometry is absent — the `{{` pill picker anchors at the
  // caret via Range.getClientRects()/getBoundingClientRect(). Empty/zeroed stubs
  // let the editors fall back to the element rect (the no-layout behaviour).
  if (window.Range && !window.Range.prototype.getClientRects) {
    window.Range.prototype.getClientRects = () => [];
    window.Range.prototype.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
    });
  }

  return window;
}

// Install one DOM at module-load so the Prism vendor bundle — which dereferences
// `Element` while evaluating — has its globals in place before any component
// module is imported.
export const window = resetDom();

// Load the English catalog so components resolve real display text through t()
// under test, mirroring what i18n.init() does at app startup. Without this t()
// returns bare keys, and text-based selectors (e.g. [aria-label="Send request"])
// would never match. Persisted in the i18n module singleton, so it survives the
// per-test resetDom() above; renderer i18n.test.js overrides it per case via its
// own applyCatalog() fixtures.
const EN_CATALOG = JSON.parse(
  fs.readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "locales",
      "en.json",
    ),
    "utf8",
  ),
);
applyCatalog({
  active: "en",
  lang: "en",
  messages: EN_CATALOG,
  fallback: EN_CATALOG,
});
