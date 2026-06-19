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
 * pill-editors.test.js — characterization tests for the two pill editors.
 *
 * VariablePillEditor (a contenteditable single field) and PillCodeEditor (a
 * multi-line code editor) were copied from a common ancestor and then drifted;
 * neither had any direct coverage, yet both carry the same `{{ }}` variable /
 * function pill machinery that the PillEditorCore unification is about to share.
 *
 * These tests pin the OBSERVABLE pill behaviour both editors must keep: how
 * `setValue` text becomes pill DOM (variable vs function, known vs unknown), how
 * `getValue` serialises it back, and the editor-specific surface (PCE multi-line
 * + readonly, VPE empty flag). They are written against the CURRENT code so the
 * refactor can be verified — change the internals, re-run, expect green.
 *
 * Run with:   node --test src/web/scripts/tests/pill-editors.test.js
 */
"use strict";

// MUST precede the component imports (they touch document / Prism on load).
import { resetDom } from "./jsdom-setup.js";

import { test } from "node:test";
import assert from "node:assert/strict";

import { VariablePillEditor } from "../components/variable-pill-editor.js";
import { PillCodeEditor } from "../components/pill-code-editor.js";
import {
  pickerScopes,
  pickerFunctions,
} from "../components/pill-picker-data.js";

// A context in which {{token}} resolves (collection scope) — drives the
// known/unknown pill class and the picker's variable list.
const KNOWN_CTX = { collectionVariables: { token: "x" }, folderChain: [] };

/** Build one editor of each kind with a fresh DOM and a shared context. */
function makeVpe(opts = {}) {
  resetDom();
  const ed = new VariablePillEditor({ getContext: () => KNOWN_CTX, ...opts });
  document.body.appendChild(ed.element);
  return ed;
}
function makePce(opts = {}) {
  resetDom();
  const ed = new PillCodeEditor({ getContext: () => KNOWN_CTX, ...opts });
  document.body.appendChild(ed.element);
  return ed;
}

// ── Shared pill behaviour (run against both editors) ────────────────────────────
// Each entry is [name, factory]; the factory returns a fresh mounted editor.
const EDITORS = [
  ["VariablePillEditor", makeVpe],
  ["PillCodeEditor", makePce],
];

for (const [name, make] of EDITORS) {
  test(`${name}: plain text round-trips through setValue/getValue`, () => {
    const ed = make();
    ed.setValue("hello world");
    assert.equal(ed.getValue(), "hello world");
    ed.destroy();
  });

  test(`${name}: a {{var}} becomes a variable pill and round-trips`, () => {
    const ed = make();
    ed.setValue("a {{token}} b");
    const pills = ed.element.querySelectorAll(
      ".variable-pill:not(.function-pill)",
    );
    assert.equal(pills.length, 1, "one variable pill rendered");
    assert.equal(pills[0].dataset.variable, "token");
    assert.equal(
      ed.getValue(),
      "a {{token}} b",
      "serialises back to the token",
    );
    ed.destroy();
  });

  test(`${name}: a known variable gets --known, an unknown gets --unknown`, () => {
    const known = make();
    known.setValue("{{token}}");
    const kp = known.element.querySelector(".variable-pill");
    assert.ok(kp.classList.contains("variable-pill--known"), "known class");
    assert.ok(!kp.classList.contains("variable-pill--unknown"));
    known.destroy();

    resetDom();
    const unknown = new (
      name === "VariablePillEditor" ? VariablePillEditor : PillCodeEditor
    )({ getContext: () => ({ collectionVariables: {} }) });
    document.body.appendChild(unknown.element);
    unknown.setValue("{{nope}}");
    const up = unknown.element.querySelector(".variable-pill");
    assert.ok(up.classList.contains("variable-pill--unknown"), "unknown class");
    assert.ok(!up.classList.contains("variable-pill--known"));
    unknown.destroy();
  });

  test(`${name}: a function token becomes a function pill and round-trips`, () => {
    const ed = make();
    ed.setValue("{{uuid()}}");
    const fn = ed.element.querySelector(".function-pill");
    assert.ok(fn, "a function pill rendered");
    assert.equal(fn.dataset.function, "uuid");
    assert.equal(ed.getValue(), "{{uuid()}}", "serialises back to the call");
    ed.destroy();
  });

  test(`${name}: multiple pills mixed with text round-trip in order`, () => {
    const ed = make();
    ed.setValue("x {{token}} y {{uuid()}} z");
    assert.equal(
      ed.element.querySelectorAll(".variable-pill").length,
      2,
      "both pills rendered (function pill also carries .variable-pill)",
    );
    assert.equal(ed.getValue(), "x {{token}} y {{uuid()}} z");
    ed.destroy();
  });
}

// ── PillCodeEditor-specific ─────────────────────────────────────────────────────

test("PillCodeEditor: multi-line content round-trips, one .pce-line per line", () => {
  const ed = makePce();
  ed.setValue("line one\nline two\nline three");
  assert.equal(ed.element.querySelectorAll(".pce-line").length, 3);
  assert.equal(ed.getValue(), "line one\nline two\nline three");
  ed.destroy();
});

test("PillCodeEditor: a pill survives on a line among plain lines", () => {
  const ed = makePce();
  ed.setValue("before\n{{token}}\nafter");
  assert.equal(ed.element.querySelectorAll(".variable-pill").length, 1);
  assert.equal(ed.getValue(), "before\n{{token}}\nafter");
  ed.destroy();
});

test("PillCodeEditor: readonly reports its value but marks the doc non-editable", () => {
  const ed = makePce({ readonly: true });
  ed.setValue("{{token}} read me");
  const doc = ed.element.querySelector(".pce-doc");
  assert.equal(doc.contentEditable, "false");
  assert.equal(doc.getAttribute("aria-readonly"), "true");
  assert.ok(ed.element.classList.contains("pce--readonly"));
  assert.equal(ed.getValue(), "{{token}} read me");
  ed.destroy();
});

// ── Picker lifecycle (typeahead open → filter → select → close) ────────────────
// Drives the real `{{` flow: set text, drop a collapsed caret after the trigger,
// dispatch the editor's input event, then wait out the open debounce. The picker
// (PillPicker) mounts to document.body as `.pill-picker`.

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Place a collapsed caret just after `needle` in the editor's flattened text.
 * Walks all text nodes (the multi-line editor splits `{{tok` across nodes) and
 * maps the global end-of-needle offset back to the right (node, offset).
 */
function caretAfter(root, needle) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let concat = "";
  let n;
  while ((n = walker.nextNode())) {
    nodes.push([n, concat.length]);
    concat += n.textContent;
  }
  const at = concat.indexOf(needle);
  if (at === -1) throw new Error(`caret needle not found: ${needle}`);
  const target = at + needle.length;
  let node = nodes[nodes.length - 1][0];
  let offset = node.textContent.length;
  for (const [nd, start] of nodes) {
    if (target <= start + nd.textContent.length) {
      node = nd;
      offset = target - start;
      break;
    }
  }
  const sel = window.getSelection();
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
  return node;
}

// Each editor: factory + which root holds the caret + receives the input event.
// PillCodeEditor is built with highlight OFF: live typing keeps `{{tok` in one
// text node at schedule-time (the Prism repaint that would split it runs later,
// async), and the picker filter reads only the caret's node — so highlight-off
// reproduces the real schedule-time DOM rather than setValue's post-paint split.
const PICKER_EDITORS = [
  ["VariablePillEditor", (o) => makeVpe(o), (ed) => ed.element],
  [
    "PillCodeEditor",
    (o) => makePce({ highlight: false, ...o }),
    (ed) => ed.element.querySelector(".pce-doc"),
  ],
];

/** Open the picker by typing `text` and caret-anchoring after `needle`. */
async function openPicker(ed, inputRoot, text, needle) {
  ed.setValue(text);
  caretAfter(inputRoot, needle);
  inputRoot.dispatchEvent(new window.Event("input", { bubbles: true }));
  await delay(260); // covers both editors' open debounce (200 / 150 ms)
  return document.body.querySelector(".pill-picker");
}

for (const [name, make, inputRootOf] of PICKER_EDITORS) {
  test(`${name}: typing {{ opens the picker with variables and functions`, async () => {
    const ed = make();
    const picker = await openPicker(ed, inputRootOf(ed), "{{", "{{");
    assert.ok(picker, "the picker mounted");
    const labels = [...picker.querySelectorAll(".pill-picker-item-name")].map(
      (n) => n.textContent,
    );
    assert.ok(labels.includes("token"), "the known variable is offered");
    assert.ok(
      labels.some((l) => l.startsWith("uuid")),
      "functions are offered too",
    );
    ed.destroy();
    document.body.querySelector(".pill-picker")?.remove();
  });

  test(`${name}: the picker filters variables by the typed prefix`, async () => {
    const ed = make({
      getContext: () => ({ collectionVariables: { token: 1, other: 1 } }),
    });
    const picker = await openPicker(ed, inputRootOf(ed), "{{tok", "{{tok");
    assert.ok(picker, "the picker mounted");
    const names = [...picker.querySelectorAll(".pill-picker-item-name")].map(
      (n) => n.textContent,
    );
    assert.ok(names.includes("token"), "matching variable shown");
    assert.ok(!names.includes("other"), "non-matching variable hidden");
    ed.destroy();
    document.body.querySelector(".pill-picker")?.remove();
  });

  test(`${name}: selecting a picker item inserts the variable pill`, async () => {
    const ed = make();
    const picker = await openPicker(ed, inputRootOf(ed), "{{tok", "{{tok");
    assert.ok(picker, "the picker mounted");
    const item = [...picker.querySelectorAll(".pill-picker-item")].find(
      (el) =>
        el.querySelector(".pill-picker-item-name")?.textContent === "token",
    );
    assert.ok(item, "found the token item");
    item.dispatchEvent(new window.Event("mousedown", { bubbles: true }));
    assert.equal(
      ed.getValue(),
      "{{token}}",
      "the pill replaced the {{tok typing",
    );
    assert.equal(ed.element.querySelectorAll(".variable-pill").length, 1);
    ed.destroy();
    document.body.querySelector(".pill-picker")?.remove();
  });

  test(`${name}: clearing the trigger closes the picker`, async () => {
    const ed = make();
    await openPicker(ed, inputRootOf(ed), "{{", "{{");
    assert.ok(document.body.querySelector(".pill-picker"), "open first");
    ed.setValue("plain text"); // no {{ → schedule should close on next input
    inputRootOf(ed).dispatchEvent(new window.Event("input", { bubbles: true }));
    await delay(20);
    assert.equal(
      document.body.querySelector(".pill-picker"),
      null,
      "picker dismissed once the trigger is gone",
    );
    ed.destroy();
  });
}

// ── Shared picker data (pill-picker-data.js) ────────────────────────────────────

test("pickerScopes: groups scopes lowest-priority-first with picker labels", () => {
  const scopes = pickerScopes({
    globalVariables: { g: 1 },
    environmentVariables: { e: 1 },
    collectionVariables: { c2: 1, c1: 1 },
    activeEnvironmentName: "Staging",
    collectionName: "My API",
    folderChain: [
      { variables: { f: 1 } },
      { variables: { f: 2, child: 3 } }, // inner f shadows outer; deduped to one
    ],
  });
  assert.deepEqual(
    scopes.map((s) => s.label),
    ["Global", "Staging", "My API", "Folders"],
    "order + labels (env/collection names override defaults)",
  );
  assert.deepEqual(scopes[2].variables, ["c1", "c2"], "names sorted");
  assert.deepEqual(scopes[3].variables, ["child", "f"], "folder names deduped");
});

test("pickerScopes: empty/absent context yields no groups", () => {
  assert.deepEqual(pickerScopes(null), []);
  assert.deepEqual(pickerScopes({ collectionVariables: {} }), []);
});

test("pickerFunctions: lists every registered function with its definition", () => {
  const fns = pickerFunctions();
  assert.ok(fns.length > 0);
  assert.ok(
    fns.every((f) => typeof f.name === "string" && f.funcDef),
    "each entry has a name + funcDef",
  );
  assert.ok(fns.some((f) => f.name === "uuid"));
});

// ── VariablePillEditor-specific ─────────────────────────────────────────────────

test("VariablePillEditor: the empty flag tracks whether there is content", () => {
  const ed = makeVpe();
  ed.setValue("");
  assert.equal(ed.element.dataset.empty, "true", "empty when blank");
  ed.setValue("something");
  assert.notEqual(ed.element.dataset.empty, "true", "not empty with content");
  ed.destroy();
});

test("VariablePillEditor: getValue serialises a lone pill with no surrounding text", () => {
  const ed = makeVpe();
  ed.setValue("{{token}}");
  assert.equal(ed.element.querySelectorAll(".variable-pill").length, 1);
  assert.equal(ed.getValue(), "{{token}}");
  ed.destroy();
});
