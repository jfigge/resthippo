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
 * tests/pill-editor-popup.test.js
 *
 * Pins the dismissal contract of the Variable / Function pill editor dialog:
 * Escape cancels from ANY focus position inside it (the suggestions listbox, the
 * footer buttons, a parameterless function editor whose only focusable control is
 * the header ✕), commits nothing, and leaves no document listener behind.
 *
 * Escape used to be wired per-field — on the variable listbox and on each
 * function param input — so it silently did nothing once focus moved elsewhere,
 * and never worked at all for a function with no parameters.
 */

"use strict";

// MUST come first — installs the jsdom globals the popup needs.
import { resetDom } from "../../tests/jsdom-setup.js";

import { test } from "node:test";
import assert from "node:assert/strict";

import { PillEditorPopup } from "../pill-editor-popup.js";

const CTX = { environmentVariables: { token: "x" }, folderChain: [] };

/** Let PopupManager's rAF mount/focus work and its close animation finish. */
const settle = () => new Promise((r) => setTimeout(r, 450));

const popupEl = () => document.querySelector(".pill-editor-popup");

function pressEscape(target) {
  target.dispatchEvent(
    new window.KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }),
  );
}

/** Open a variable editor over a fresh DOM; returns the commit spy. */
async function openVariable() {
  resetDom();
  const commits = [];
  PillEditorPopup.open({
    type: "variable",
    rawValue: "{{token}}",
    getContext: () => CTX,
    onCommit: (raw) => commits.push(raw),
  });
  await settle();
  return commits;
}

/** Open a function editor with no parameters (e.g. {{uuid()}}). */
async function openParamlessFunction() {
  resetDom();
  const commits = [];
  PillEditorPopup.open({
    type: "function",
    funcName: "uuid",
    funcDef: { labelKey: "func.uuid.label", params: [] },
    rawArgs: [],
    getContext: () => CTX,
    getItems: () => [],
    getPreview: async () => "abc",
    onCommit: (raw) => commits.push(raw),
  });
  await settle();
  return commits;
}

test("variable editor: Escape closes from the focused suggestions listbox", async () => {
  const commits = await openVariable();
  assert.ok(popupEl(), "popup mounted");

  pressEscape(document.querySelector(".pill-editor-var-suggestions"));
  await settle();

  assert.equal(popupEl(), null, "Escape closed the dialog");
  assert.deepEqual(commits, [], "Escape cancels — nothing committed");
});

test("variable editor: Escape closes with focus outside the listbox (footer button)", async () => {
  const commits = await openVariable();
  const done = popupEl().querySelector(".js-done");
  done.focus();

  pressEscape(done);
  await settle();

  assert.equal(popupEl(), null, "Escape closed the dialog");
  assert.deepEqual(commits, [], "Escape cancels — nothing committed");
});

test("variable editor: Escape closes when focus has left the dialog entirely", async () => {
  await openVariable();

  pressEscape(document.body);
  await settle();

  assert.equal(popupEl(), null, "Escape closed the dialog");
});

test("function editor with no params: Escape closes it", async () => {
  const commits = await openParamlessFunction();
  assert.ok(popupEl(), "popup mounted");

  pressEscape(document.activeElement ?? document.body);
  await settle();

  assert.equal(popupEl(), null, "Escape closed the dialog");
  assert.deepEqual(commits, [], "Escape cancels — nothing committed");
});

test("function editor: Escape closes from a param input", async () => {
  resetDom();
  const commits = [];
  PillEditorPopup.open({
    type: "function",
    funcName: "now",
    funcDef: {
      labelKey: "func.now.label",
      params: [{ labelKey: "func.now.label" }],
    },
    rawArgs: ["iso"],
    getContext: () => CTX,
    getItems: () => [],
    getPreview: async () => "2026-01-01",
    onCommit: (raw) => commits.push(raw),
  });
  await settle();

  const input = popupEl().querySelector(".pill-editor-param-input");
  input.focus();
  pressEscape(input);
  await settle();

  assert.equal(popupEl(), null, "Escape closed the dialog");
  assert.deepEqual(commits, [], "Escape cancels — nothing committed");
});

test("the Escape listener is removed on close (a later Escape is inert)", async () => {
  await openVariable();

  pressEscape(document.body);
  await settle();
  assert.equal(popupEl(), null, "closed");

  // A stray Escape after close must not be consumed by a leaked listener.
  const stray = new window.KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
  document.body.dispatchEvent(stray);
  assert.equal(
    stray.defaultPrevented,
    false,
    "no popup listener left to swallow Escape",
  );
});
