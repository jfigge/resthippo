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
 * pill-caret.test.js — caret-offset math for PillCodeEditor.
 *
 * getCaretOffset()/replaceRange() map between a DOM (node, offset) and a global
 * character offset within getValue(). That mapping is pure DOM-walk + string
 * length arithmetic (no layout), so it IS testable under jsdom — unlike the
 * pixel geometry (caretCoords / scrollIntoView) the jsdom harness stubs to zero,
 * which the e2e geometry harness covers instead.
 *
 * The load-bearing subtlety these pin: a {{token}} pill is an atomic element
 * whose visible text ("token", plus zero-width-space guards) is SHORTER than the
 * 9-character `{{token}}` it serialises to — so the offset must count the raw
 * serialized length, not the rendered characters. The newline between lines
 * counts as one character too.
 *
 * Run with:   node --test src/web/scripts/tests/pill-caret.test.js
 */
"use strict";

// MUST precede the component import (it touches document / Prism on load).
import { resetDom } from "./jsdom-setup.js";

import { test } from "node:test";
import assert from "node:assert/strict";

import { PillCodeEditor } from "../components/pill-code-editor.js";

const KNOWN_CTX = { environmentVariables: { token: "x" }, folderChain: [] };

function makePce(opts = {}) {
  resetDom();
  const ed = new PillCodeEditor({ getContext: () => KNOWN_CTX, ...opts });
  document.body.appendChild(ed.element);
  return ed;
}

/**
 * Place a collapsed caret just after `needle` in the editor's flattened text,
 * mapping the global end-of-needle position back to the (node, offset) it lands
 * in. (Pills split text across nodes; zero-width-space guards live in their own
 * nodes — both are handled by walking every text node.)
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
}

// ── getCaretOffset ──────────────────────────────────────────────────────────

test("getCaretOffset on plain text equals the character count before the caret", () => {
  const ed = makePce();
  ed.setValue("hello world");
  caretAfter(ed.element, "hello");
  assert.equal(ed.getCaretOffset(), 5);
  caretAfter(ed.element, "hello world");
  assert.equal(ed.getCaretOffset(), 11, "caret at end → full length");
  ed.destroy();
});

test("getCaretOffset counts the newline between lines", () => {
  const ed = makePce();
  ed.setValue("ab\ncd");
  caretAfter(ed.element, "ab"); // end of line 1, before the newline
  assert.equal(ed.getCaretOffset(), 2);
  caretAfter(ed.element, "abc"); // one char into line 2 → 2 + newline + 1
  assert.equal(ed.getCaretOffset(), 4);
  ed.destroy();
});

test("getCaretOffset counts a pill's full raw {{token}} length, not its rendered text", () => {
  const ed = makePce();
  ed.setValue("AB{{token}}CD"); // raw length 13; rendered text is far shorter
  caretAfter(ed.element, "AB"); // immediately before the pill
  assert.equal(ed.getCaretOffset(), 2, "leading text counted literally");
  caretAfter(ed.element, "CD"); // after the pill + trailing text
  assert.equal(
    ed.getCaretOffset(),
    ed.getValue().length,
    "end offset equals the raw serialized length (pill = 9, not 'token')",
  );
  assert.equal(ed.getValue().length, 13);
  ed.destroy();
});

test("getCaretOffset returns -1 with no caret or a caret outside the document", () => {
  const ed = makePce();
  ed.setValue("hi");
  window.getSelection().removeAllRanges();
  assert.equal(ed.getCaretOffset(), -1, "no selection");

  const outside = document.createElement("div");
  outside.textContent = "elsewhere";
  document.body.appendChild(outside);
  const r = document.createRange();
  r.setStart(outside.firstChild, 1);
  r.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  assert.equal(ed.getCaretOffset(), -1, "caret outside the editor doc");
  ed.destroy();
});

// ── replaceRange ────────────────────────────────────────────────────────────

test("replaceRange replaces [start, end) against getValue()", () => {
  const ed = makePce();
  ed.setValue("hello world");
  ed.replaceRange(5, 11, "!"); // replace " world"
  assert.equal(ed.getValue(), "hello!");
  ed.destroy();
});

test("replaceRange with start === end inserts without deleting", () => {
  const ed = makePce();
  ed.setValue("ab");
  ed.replaceRange(1, 1, "X");
  assert.equal(ed.getValue(), "aXb");
  ed.destroy();
});

test("replaceRange inserting {{token}} renders a variable pill", () => {
  const ed = makePce();
  ed.setValue("a b");
  ed.replaceRange(2, 3, "{{token}}"); // replace "b"
  assert.equal(ed.getValue(), "a {{token}}");
  assert.equal(ed.element.querySelectorAll(".variable-pill").length, 1);
  ed.destroy();
});

// ── undo / redo (a replaceRange edit is one history step) ───────────────────

test("undo restores the pre-edit value and redo re-applies it", () => {
  // Construct with the initial value so it's the undo baseline — a later
  // setValue() is a programmatic (re)load and deliberately doesn't checkpoint.
  const ed = makePce({ value: "hello" });
  ed.replaceRange(5, 5, " world");
  assert.equal(ed.getValue(), "hello world");
  assert.equal(ed.canUndo, true);

  ed.undo();
  assert.equal(ed.getValue(), "hello", "undo reverts the insertion");

  ed.redo();
  assert.equal(ed.getValue(), "hello world", "redo re-applies it");
  ed.destroy();
});
