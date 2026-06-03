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

import { JSDOM } from "jsdom";

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

  return window;
}

// Install one DOM at module-load so the Prism vendor bundle — which dereferences
// `Element` while evaluating — has its globals in place before any component
// module is imported.
export const window = resetDom();
