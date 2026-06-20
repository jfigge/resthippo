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
 * tests/zoom-handlers.test.js
 *
 * Unit tests for the UI font-size ("zoom") event-bus handlers extracted from
 * app.js. A fresh jsdom window is installed per test and a mock bus context
 * captures the settings the handlers write, so wheel/keyboard/menu inputs can be
 * exercised without the app bootstrap.
 *
 * Run with:   node --test event-bus/tests/zoom-handlers.test.js
 */

"use strict";

// MUST come first — installs the jsdom globals the handlers attach to.
import { resetDom } from "../../tests/jsdom-setup.js";

import { test } from "node:test";
import assert from "node:assert/strict";

import { installZoomHandlers } from "../zoom-handlers.js";

// FONT_SIZES = [9, 11, 12, 13, 14, 16, 18, 20]; DEFAULT_FONT = 13.

function setup({ fontSize = 13 } = {}) {
  resetDom();
  const settings = { fontSize };
  let applied = 0;
  const sendBtn = document.createElement("button");
  sendBtn.className = "req-send-btn";
  let sendClicks = 0;
  sendBtn.addEventListener("click", () => sendClicks++);
  const editorEl = document.createElement("div");
  editorEl.appendChild(sendBtn);

  const ctx = {
    getSettings: () => settings,
    updateSettings: (patch) => Object.assign(settings, patch),
    applySettings: () => applied++,
    getRequestEditor: () => ({ element: editorEl }),
  };
  installZoomHandlers(ctx);
  return {
    settings,
    appliedCount: () => applied,
    sendClicks: () => sendClicks,
  };
}

function wheel({ ctrlKey = false, deltaY = 0 } = {}) {
  const ev = new window.Event("wheel", { cancelable: true });
  Object.defineProperty(ev, "ctrlKey", { value: ctrlKey });
  Object.defineProperty(ev, "deltaY", { value: deltaY });
  window.dispatchEvent(ev);
}

function keydown(key, mods = {}) {
  window.dispatchEvent(
    new window.KeyboardEvent("keydown", {
      key,
      cancelable: true,
      ...mods,
    }),
  );
}

test("Ctrl+wheel up steps the font size to the next larger entry", () => {
  const h = setup({ fontSize: 13 });
  wheel({ ctrlKey: true, deltaY: -1 });
  assert.equal(h.settings.fontSize, 14);
  assert.equal(h.appliedCount(), 1);
});

test("Ctrl+wheel down steps the font size to the next smaller entry", () => {
  const h = setup({ fontSize: 13 });
  wheel({ ctrlKey: true, deltaY: 1 });
  assert.equal(h.settings.fontSize, 12);
});

test("a plain wheel (no modifier) is ignored", () => {
  const h = setup({ fontSize: 13 });
  wheel({ ctrlKey: false, deltaY: -1 });
  assert.equal(h.settings.fontSize, 13);
  assert.equal(h.appliedCount(), 0);
});

test("Ctrl+'+' zooms in and Ctrl+'-' zooms out", () => {
  const h = setup({ fontSize: 13 });
  keydown("+", { ctrlKey: true });
  assert.equal(h.settings.fontSize, 14);
  keydown("-", { ctrlKey: true });
  assert.equal(h.settings.fontSize, 13);
});

test("Ctrl+'0' resets to the default font size", () => {
  const h = setup({ fontSize: 20 });
  keydown("0", { ctrlKey: true });
  assert.equal(h.settings.fontSize, 13);
});

test("stepping past the max boundary is a no-op (no apply)", () => {
  const h = setup({ fontSize: 20 }); // already the largest
  wheel({ ctrlKey: true, deltaY: -1 });
  assert.equal(h.settings.fontSize, 20);
  assert.equal(h.appliedCount(), 0);
});

test("hippo:ui-font-change menu events step / reset the font", () => {
  const h = setup({ fontSize: 13 });
  window.dispatchEvent(
    new window.CustomEvent("hippo:ui-font-change", { detail: "in" }),
  );
  assert.equal(h.settings.fontSize, 14);
  window.dispatchEvent(
    new window.CustomEvent("hippo:ui-font-change", { detail: "reset" }),
  );
  assert.equal(h.settings.fontSize, 13);
});

test("Cmd/Ctrl+Enter clicks the request editor's send button", () => {
  const h = setup();
  keydown("Enter", { metaKey: true });
  assert.equal(h.sendClicks(), 1);
});
