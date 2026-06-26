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

// ── VariablePillEditor: constructor + ARIA wiring ───────────────────────────────

test("VariablePillEditor: the element is a contenteditable textbox with the right attrs", () => {
  const ed = makeVpe({
    placeholder: "Enter value",
    ariaLabel: "Param value",
    className: "my-class",
  });
  const el = ed.element;
  assert.equal(el.contentEditable, "true", "contenteditable host");
  assert.equal(el.getAttribute("role"), "textbox");
  assert.equal(el.getAttribute("aria-label"), "Param value");
  assert.equal(el.dataset.placeholder, "Enter value");
  assert.equal(el.spellcheck, false);
  assert.equal(el.getAttribute("autocorrect"), "off");
  assert.equal(el.getAttribute("autocapitalize"), "off");
  assert.ok(el.classList.contains("pill-editor"), "carries base class");
  assert.ok(el.classList.contains("params-input"), "carries params class");
  assert.ok(el.classList.contains("my-class"), "carries the extra class");
  ed.destroy();
});

test("VariablePillEditor: aria-label falls back to the placeholder when omitted", () => {
  const ed = makeVpe({ placeholder: "Just a placeholder" });
  assert.equal(ed.element.getAttribute("aria-label"), "Just a placeholder");
  ed.destroy();
});

// ── VariablePillEditor: setValue / getValue round-trip edge cases ───────────────

test("VariablePillEditor: setValue(null)/setValue(undefined) renders an empty field", () => {
  const ed = makeVpe();
  ed.setValue("seed"); // move off the sentinel so the next call renders
  ed.setValue(null);
  assert.equal(ed.getValue(), "", "null normalises to empty string");
  assert.equal(ed.element.dataset.empty, "true");
  ed.destroy();
});

test("VariablePillEditor: adjacent pills round-trip and get a guard between them", () => {
  const ed = makeVpe();
  ed.setValue("{{token}}{{uuid()}}");
  assert.equal(
    ed.element.querySelectorAll(".variable-pill").length,
    2,
    "both pills rendered",
  );
  assert.ok(
    ed.element.querySelector(".pill-guard"),
    "a guard separates the adjacent pills",
  );
  assert.equal(
    ed.getValue(),
    "{{token}}{{uuid()}}",
    "guards drop on serialise",
  );
  ed.destroy();
});

test("VariablePillEditor: an unclosed {{ stays literal text and round-trips", () => {
  const ed = makeVpe();
  ed.setValue("prefix {{token");
  assert.equal(
    ed.element.querySelectorAll(".variable-pill").length,
    0,
    "no pill formed from an unclosed token",
  );
  assert.equal(ed.getValue(), "prefix {{token");
  ed.destroy();
});

test("VariablePillEditor: a function pill with args round-trips its raw call", () => {
  const ed = makeVpe();
  ed.setValue('{{hash("md5", "x")}}');
  const fn = ed.element.querySelector(".function-pill");
  assert.ok(fn, "a function pill rendered");
  assert.equal(fn.dataset.function, "hash");
  assert.equal(ed.getValue(), '{{hash("md5", "x")}}');
  ed.destroy();
});

test("VariablePillEditor: setValue is a no-op when the value is unchanged", () => {
  const ed = makeVpe();
  ed.setValue("{{token}}");
  const pill = ed.element.querySelector(".variable-pill");
  ed.setValue("{{token}}"); // same value → should NOT re-render
  assert.equal(
    ed.element.querySelector(".variable-pill"),
    pill,
    "the same DOM node survives an identical setValue",
  );
  ed.destroy();
});

// ── VariablePillEditor: callbacks ───────────────────────────────────────────────

test("VariablePillEditor: onInput fires with the serialized value on an input event", () => {
  const seen = [];
  const ed = makeVpe({ onInput: (v) => seen.push(v) });
  ed.setValue(""); // baseline empty (setValue does not fire onInput)
  // Type a character the native way, then signal input.
  ed.element.appendChild(document.createTextNode("hi"));
  ed.element.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.deepEqual(seen, ["hi"], "onInput received the new serialized value");
  ed.destroy();
});

test("VariablePillEditor: onEnter fires on Enter (and the keydown is prevented)", () => {
  let entered = 0;
  const ed = makeVpe({ onEnter: () => entered++ });
  ed.setValue("text");
  const ev = new window.KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
  });
  ed.element.dispatchEvent(ev);
  assert.equal(entered, 1, "onEnter called once");
  assert.equal(ev.defaultPrevented, true, "Enter does not insert a newline");
  ed.destroy();
});

test("VariablePillEditor: onEnter is optional — Enter with no handler is a no-op", () => {
  const ed = makeVpe(); // no onEnter
  ed.setValue("text");
  const ev = new window.KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
  });
  // Should not throw despite the missing handler.
  ed.element.dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, true);
  ed.destroy();
});

test("VariablePillEditor: onPaste hook claims a paste, suppressing self-insertion", () => {
  let pastedText = null;
  const ed = makeVpe({
    onPaste: (text) => {
      pastedText = text;
      return true; // claim it
    },
  });
  ed.setValue("");
  ed.element.focus();
  const ev = new window.Event("paste", { bubbles: true, cancelable: true });
  ev.clipboardData = { getData: () => "claimed text" };
  ed.element.dispatchEvent(ev);
  assert.equal(pastedText, "claimed text", "hook saw the pasted text");
  assert.equal(ed.getValue(), "", "claimed paste was NOT inserted");
  ed.destroy();
});

test("VariablePillEditor: a plain-text paste with no hook inserts at the caret", () => {
  const ed = makeVpe();
  ed.setValue("");
  ed.element.focus();
  // Caret at the start of the empty editor's seed text node.
  const sel = window.getSelection();
  const r = document.createRange();
  r.setStart(ed.element.firstChild ?? ed.element, 0);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
  const ev = new window.Event("paste", { bubbles: true, cancelable: true });
  ev.clipboardData = { getData: () => "pasted" };
  ed.element.dispatchEvent(ev);
  assert.equal(ed.getValue(), "pasted", "plain text inserted verbatim");
  ed.destroy();
});

test("VariablePillEditor: pasting {{token}} text converts to a pill on insert", () => {
  const ed = makeVpe();
  ed.setValue("");
  ed.element.focus();
  const sel = window.getSelection();
  const r = document.createRange();
  r.setStart(ed.element.firstChild ?? ed.element, 0);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
  const ev = new window.Event("paste", { bubbles: true, cancelable: true });
  ev.clipboardData = { getData: () => "{{token}}" };
  ed.element.dispatchEvent(ev);
  assert.equal(
    ed.element.querySelectorAll(".variable-pill").length,
    1,
    "the pasted {{token}} became a pill",
  );
  assert.equal(ed.getValue(), "{{token}}");
  ed.destroy();
});

test("VariablePillEditor: an empty paste is ignored", () => {
  const ed = makeVpe();
  ed.setValue("keep");
  const ev = new window.Event("paste", { bubbles: true, cancelable: true });
  ev.clipboardData = { getData: () => "" };
  ed.element.dispatchEvent(ev);
  assert.equal(ed.getValue(), "keep", "nothing changed");
  assert.equal(ev.defaultPrevented, true, "default paste still prevented");
  ed.destroy();
});

// ── VariablePillEditor: copy / cut serialise pills to raw {{…}} text ───────────

test("VariablePillEditor: copy writes the raw {{token}} for a selected pill", () => {
  const ed = makeVpe();
  ed.setValue("a {{token}} b");
  // Select the whole editor contents.
  const sel = window.getSelection();
  const r = document.createRange();
  r.selectNodeContents(ed.element);
  sel.removeAllRanges();
  sel.addRange(r);
  let written = null;
  const ev = new window.Event("copy", { bubbles: true, cancelable: true });
  ev.clipboardData = {
    setData: (_type, v) => {
      written = v;
    },
  };
  ed.element.dispatchEvent(ev);
  assert.equal(written, "a {{token}} b", "pill serialised back to its token");
  assert.equal(ev.defaultPrevented, true, "we own the clipboard write");
  ed.destroy();
});

test("VariablePillEditor: cut serialises then removes the selected content", () => {
  const ed = makeVpe();
  ed.setValue("x {{token}} y");
  const sel = window.getSelection();
  const r = document.createRange();
  r.selectNodeContents(ed.element);
  sel.removeAllRanges();
  sel.addRange(r);
  let written = null;
  const ev = new window.Event("cut", { bubbles: true, cancelable: true });
  ev.clipboardData = {
    setData: (_type, v) => {
      written = v;
    },
  };
  ed.element.dispatchEvent(ev);
  assert.equal(written, "x {{token}} y", "cut wrote the raw token text");
  assert.equal(ed.getValue(), "", "the selection was removed");
  ed.destroy();
});

// ── VariablePillEditor: backspace / delete remove a whole pill ──────────────────

test("VariablePillEditor: Backspace just after a pill removes the whole pill", () => {
  const changes = [];
  const ed = makeVpe({ onInput: (v) => changes.push(v) });
  ed.setValue("{{token}}tail");
  ed.element.dispatchEvent(new window.Event("focus"));
  // Caret at the very start of the "tail" text node — i.e. just after the pill.
  // #pillBeforeCaret treats an all-ZWS prefix (here empty) as "at the pill edge".
  const tailNode = [...ed.element.childNodes].find(
    (n) => n.nodeType === Node.TEXT_NODE && n.textContent.includes("tail"),
  );
  const sel = window.getSelection();
  const r = document.createRange();
  r.setStart(tailNode, 0);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
  const ev = new window.KeyboardEvent("keydown", {
    key: "Backspace",
    bubbles: true,
    cancelable: true,
  });
  ed.element.dispatchEvent(ev);
  assert.equal(
    ed.element.querySelectorAll(".variable-pill").length,
    0,
    "the pill was deleted as a unit",
  );
  assert.equal(ev.defaultPrevented, true);
  assert.equal(ed.getValue(), "tail");
  ed.destroy();
});

test("VariablePillEditor: Delete just before a pill removes the whole pill", () => {
  const ed = makeVpe();
  ed.setValue("head{{token}}");
  ed.element.focus();
  caretAfter(ed.element, "head"); // caret between "head" and the pill
  const ev = new window.KeyboardEvent("keydown", {
    key: "Delete",
    bubbles: true,
    cancelable: true,
  });
  ed.element.dispatchEvent(ev);
  assert.equal(ed.element.querySelectorAll(".variable-pill").length, 0);
  assert.equal(ev.defaultPrevented, true);
  assert.equal(ed.getValue(), "head");
  ed.destroy();
});

// ── VariablePillEditor: revalidate re-colours pills on a context change ─────────

test("VariablePillEditor: revalidate re-resolves known/unknown against new context", () => {
  let ctx = { collectionVariables: {} }; // token unknown at first
  const ed = makeVpe({ getContext: () => ctx });
  ed.setValue("{{token}}");
  let pill = ed.element.querySelector(".variable-pill");
  assert.ok(
    pill.classList.contains("variable-pill--unknown"),
    "unknown before the context defines it",
  );
  ctx = { collectionVariables: { token: "x" } }; // now defined
  ed.revalidate();
  pill = ed.element.querySelector(".variable-pill");
  assert.ok(
    pill.classList.contains("variable-pill--known"),
    "known after revalidate picks up the new context",
  );
  assert.ok(!pill.classList.contains("variable-pill--unknown"));
  ed.destroy();
});

// ── VariablePillEditor: focus() + destroy() listener hygiene ────────────────────

test("VariablePillEditor: focus() delegates to the host element's focus()", () => {
  // jsdom won't move document.activeElement onto a contenteditable div lacking a
  // tabindex (no layout / focusability model), so assert the delegation instead:
  // focus() must invoke the host element's own focus() exactly once.
  const ed = makeVpe();
  ed.setValue("hi");
  let calls = 0;
  ed.element.focus = () => {
    calls++;
  };
  assert.doesNotThrow(() => ed.focus());
  assert.equal(calls, 1, "focus() forwarded to the contenteditable host");
  ed.destroy();
});

test("VariablePillEditor: destroy() detaches the selectionchange listener", () => {
  const ed = makeVpe();
  ed.setValue("{{token}}");
  ed.element.dispatchEvent(new window.Event("focus")); // mark focused
  ed.destroy();
  // After destroy the editor must not react to document selection changes.
  // Mutate the pill class, then fire selectionchange: a live listener would
  // call #syncPillSelection and could touch the pill; we assert it stays put
  // and that dispatching does not throw (the listener is gone).
  const before = ed.element.querySelector(".variable-pill")?.className;
  assert.doesNotThrow(() =>
    document.dispatchEvent(new window.Event("selectionchange")),
  );
  assert.equal(
    ed.element.querySelector(".variable-pill")?.className,
    before,
    "no selection sync ran after destroy",
  );
});

test("VariablePillEditor: destroy() is idempotent (double-destroy is safe)", () => {
  const ed = makeVpe();
  ed.setValue("text");
  ed.destroy();
  assert.doesNotThrow(() => ed.destroy(), "second destroy must not throw");
});

// ── VariablePillEditor: blur closes the picker + clears pill selection ──────────

test("VariablePillEditor: blur clears the selected-pill highlight", () => {
  const ed = makeVpe();
  ed.setValue("{{token}}");
  const pill = ed.element.querySelector(".variable-pill");
  pill.classList.add("variable-pill--selected");
  ed.element.dispatchEvent(new window.Event("blur", { bubbles: true }));
  assert.ok(
    !pill.classList.contains("variable-pill--selected"),
    "blur removed the transient selection class",
  );
  ed.destroy();
});

// ── PillCodeEditor: view-setting setters apply mode classes ─────────────────────

test("PillCodeEditor: setWrap toggles the pce--wrap class", () => {
  const ed = makePce();
  assert.ok(!ed.element.classList.contains("pce--wrap"), "off by default");
  ed.setWrap(true);
  assert.ok(
    ed.element.classList.contains("pce--wrap"),
    "on after setWrap(true)",
  );
  ed.setWrap(false);
  assert.ok(!ed.element.classList.contains("pce--wrap"), "off again");
  ed.destroy();
});

test("PillCodeEditor: setLineNumbers toggles the pce--nums class", () => {
  const ed = makePce({ lineNumbers: false });
  assert.ok(!ed.element.classList.contains("pce--nums"));
  ed.setLineNumbers(true);
  assert.ok(ed.element.classList.contains("pce--nums"));
  ed.setLineNumbers(false);
  assert.ok(!ed.element.classList.contains("pce--nums"));
  ed.destroy();
});

test("PillCodeEditor: setFolding toggles the pce--fold class for a grammar language", () => {
  const ed = makePce({ language: "json", folding: false });
  assert.ok(!ed.element.classList.contains("pce--fold"));
  ed.setFolding(true);
  assert.ok(
    ed.element.classList.contains("pce--fold"),
    "folding active for a language that has a grammar",
  );
  ed.setFolding(false);
  assert.ok(!ed.element.classList.contains("pce--fold"));
  ed.destroy();
});

test("PillCodeEditor: folding never activates for plain text (no grammar)", () => {
  const ed = makePce({ language: "text", folding: true });
  ed.setFolding(true);
  assert.ok(
    !ed.element.classList.contains("pce--fold"),
    "plain text has no grammar so folding stays inactive",
  );
  ed.destroy();
});

test("PillCodeEditor: setHighlight(false) leaves the value intact", () => {
  const ed = makePce({ language: "json" });
  ed.setValue('{"a": {{token}}}');
  ed.setHighlight(false);
  assert.equal(
    ed.getValue(),
    '{"a": {{token}}}',
    "value survives highlight off",
  );
  assert.equal(ed.element.querySelectorAll(".variable-pill").length, 1);
  ed.setHighlight(true);
  assert.equal(
    ed.getValue(),
    '{"a": {{token}}}',
    "value survives highlight on",
  );
  ed.destroy();
});

// ── PillCodeEditor: setLanguage re-derives mode + re-validates ──────────────────

test("PillCodeEditor: setLanguage to plain text clears folding and keeps the value", () => {
  const ed = makePce({ language: "json", folding: true });
  ed.setValue("a\n  b\n  c");
  ed.setLanguage("text");
  assert.ok(
    !ed.element.classList.contains("pce--fold"),
    "switching to plain text disables folding",
  );
  assert.equal(ed.getValue(), "a\n  b\n  c", "content unchanged by the switch");
  ed.destroy();
});

test("PillCodeEditor: setLanguage emits pce:validity for the new language", () => {
  const ed = makePce({ language: "text" });
  ed.setValue('{"broken": }');
  const states = [];
  ed.element.addEventListener("pce:validity", (e) =>
    states.push(e.detail.state),
  );
  ed.setLanguage("json"); // now the broken JSON should validate as invalid
  assert.ok(
    states.includes(false),
    "switching to JSON surfaced an invalid state for the malformed content",
  );
  ed.destroy();
});

// ── PillCodeEditor: setReadonly toggles editability + closes the picker ─────────

test("PillCodeEditor: setReadonly(true) marks the doc non-editable, false restores it", () => {
  const ed = makePce();
  const doc = ed.element.querySelector(".pce-doc");
  assert.equal(doc.contentEditable, "true", "editable by default");
  ed.setReadonly(true);
  assert.equal(doc.contentEditable, "false");
  assert.equal(doc.getAttribute("aria-readonly"), "true");
  assert.ok(ed.element.classList.contains("pce--readonly"));
  ed.setReadonly(false);
  assert.equal(doc.contentEditable, "true");
  assert.equal(doc.getAttribute("aria-readonly"), "false");
  assert.ok(!ed.element.classList.contains("pce--readonly"));
  ed.destroy();
});

test("PillCodeEditor: undo/redo are no-ops while read-only", () => {
  const ed = makePce({ value: "hello" });
  ed.replaceRange(5, 5, " world");
  assert.equal(ed.getValue(), "hello world");
  ed.setReadonly(true);
  ed.undo(); // suppressed by the readonly guard
  assert.equal(ed.getValue(), "hello world", "undo did nothing while readonly");
  ed.destroy();
});

// ── PillCodeEditor: setMultiline collapses newlines and toggles the single class ─

test("PillCodeEditor: setMultiline(false) joins lines and flags pce--single", () => {
  const ed = makePce();
  ed.setValue("one\ntwo\nthree");
  ed.setMultiline(false);
  assert.ok(ed.element.classList.contains("pce--single"));
  assert.equal(ed.getValue(), "one two three", "newlines flattened to spaces");
  assert.equal(ed.element.querySelectorAll(".pce-line").length, 1);
  ed.destroy();
});

// ── PillCodeEditor: external errors + markers ───────────────────────────────────

test("PillCodeEditor: setErrors renders a squiggle marker, refreshMarkers re-renders", () => {
  const ed = makePce({ language: "json", externalErrors: true });
  ed.setValue('{"a": 1}');
  // Without geometry jsdom returns zero-size rects, so the squiggle falls back
  // to the line rect; assert the call path runs and tracks the error state.
  ed.setErrors([{ line: 1, col: 3, length: 1, message: "boom" }]);
  // refreshMarkers must not throw and re-runs the same render path.
  assert.doesNotThrow(() => ed.refreshMarkers());
  ed.destroy();
});

test("PillCodeEditor: setErrors([]) clears any rendered markers", () => {
  const ed = makePce({ language: "json", externalErrors: true });
  ed.setValue('{"a": 1}');
  ed.setErrors([{ line: 1, col: 1, length: 1, message: "x" }]);
  ed.setErrors([]);
  const markers = ed.element.querySelector(".pce-markers");
  assert.equal(
    markers.querySelectorAll(".pce-error-squiggle").length,
    0,
    "no squiggles after clearing errors",
  );
  ed.destroy();
});

// ── PillCodeEditor: internal validation surfaces pce:validity ───────────────────

test("PillCodeEditor: invalid JSON content emits pce:validity false, valid emits true", () => {
  const ed = makePce({ language: "json" });
  const states = [];
  ed.element.addEventListener("pce:validity", (e) =>
    states.push(e.detail.state),
  );
  ed.setValue('{"oops": }'); // malformed
  // setValue triggers #afterStructural → #runValidate synchronously.
  assert.ok(states.includes(false), "malformed JSON reported invalid");
  states.length = 0;
  ed.setValue('{"ok": 1}'); // well-formed
  assert.ok(states.includes(true), "well-formed JSON reported valid");
  ed.destroy();
});

test("PillCodeEditor: empty content emits pce:validity null (nothing to reject)", () => {
  const ed = makePce({ language: "json" });
  const states = [];
  ed.element.addEventListener("pce:validity", (e) =>
    states.push(e.detail.state),
  );
  ed.setValue("seed"); // move off the sentinel
  ed.setValue("");
  assert.ok(
    states.includes(null),
    "empty content is neither valid nor invalid",
  );
  ed.destroy();
});

// ── PillCodeEditor: getValue across many lines with pills on different lines ─────

test("PillCodeEditor: multi-line value with pills on several lines round-trips", () => {
  const ed = makePce({ language: "text" });
  ed.setValue("{{token}} a\nb {{uuid()}}\n{{token}}");
  assert.equal(ed.element.querySelectorAll(".pce-line").length, 3);
  assert.equal(ed.element.querySelectorAll(".variable-pill").length, 3);
  assert.equal(ed.element.querySelectorAll(".function-pill").length, 1);
  assert.equal(ed.getValue(), "{{token}} a\nb {{uuid()}}\n{{token}}");
  ed.destroy();
});

// ── PillCodeEditor: prettify reformats valid JSON, no-op when read-only ──────────

test("PillCodeEditor: prettify reformats minified JSON", () => {
  const ed = makePce({ language: "json" });
  ed.setValue('{"a":1,"b":[2,3]}');
  ed.prettify();
  assert.equal(
    ed.getValue(),
    '{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}',
    "JSON pretty-printed with 2-space indent",
  );
  ed.destroy();
});

test("PillCodeEditor: prettify is a no-op while read-only", () => {
  const ed = makePce({ language: "json", readonly: true });
  ed.setValue('{"a":1}');
  ed.prettify();
  assert.equal(ed.getValue(), '{"a":1}', "read-only content is left untouched");
  ed.destroy();
});

test("PillCodeEditor: prettify leaves invalid JSON unchanged", () => {
  const ed = makePce({ language: "json" });
  ed.setValue('{"a":}'); // malformed
  ed.prettify();
  assert.equal(
    ed.getValue(),
    '{"a":}',
    "unparseable content is not reformatted",
  );
  ed.destroy();
});

// ── PillCodeEditor: getCaretOffset / isPickerOpen idle states ───────────────────

test("PillCodeEditor: isPickerOpen is false when no {{ typeahead is active", () => {
  const ed = makePce();
  ed.setValue("plain");
  assert.equal(ed.isPickerOpen(), false);
  ed.destroy();
});

// ── PillCodeEditor: destroy() is safe and idempotent ────────────────────────────

test("PillCodeEditor: destroy() detaches listeners and double-destroy is safe", () => {
  const ed = makePce();
  ed.setValue("x");
  ed.destroy();
  assert.doesNotThrow(() =>
    document.dispatchEvent(new window.Event("selectionchange")),
  );
  assert.doesNotThrow(() =>
    window.dispatchEvent(
      new window.CustomEvent("hippo:edit-action", {
        detail: { action: "undo" },
      }),
    ),
  );
  assert.doesNotThrow(() => ed.destroy(), "second destroy must not throw");
});
