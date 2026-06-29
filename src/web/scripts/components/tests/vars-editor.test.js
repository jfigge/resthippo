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
 * tests/vars-editor.test.js
 *
 * Unit tests for VarsEditor — the in-panel variable editor shown when a
 * container (collection / folder) is selected in the tree. Pins its observable
 * behaviour: which { scopeId, variables } payload reaches onSave from each mode,
 * the immediate-vs-debounced save timing, the flush-on-scope-switch, and the
 * bulk-editor toggle callback.
 *
 * Run with:   node --test components/tests/vars-editor.test.js
 */

"use strict";

// MUST come first — installs the jsdom globals the editor needs.
import { resetDom } from "../../tests/jsdom-setup.js";

import { test } from "node:test";
import assert from "node:assert/strict";

import { VarsEditor } from "../vars-editor.js";

function makeEditor() {
  const window = resetDom();
  const saves = [];
  const bulkChanges = [];
  const ed = new VarsEditor({
    onSave: (p) => saves.push(p),
    onBulkEditorChange: (p) => bulkChanges.push(p),
  });
  document.body.appendChild(ed.element);
  const fire = (el, type) =>
    el.dispatchEvent(new window.Event(type, { bubbles: true }));
  return { ed, saves, bulkChanges, fire };
}

test("bulk-mode edit + flush dispatches the parsed variables for the scope", () => {
  const { ed, saves, fire } = makeEditor();
  ed.load({
    scopeId: "f1",
    scopeName: "Auth",
    variables: [],
    bulkEditor: true,
  });

  const ta = ed.element.querySelector(".vars-textarea");
  ta.value = "base=https://x\n$ key=s3cr3t";
  fire(ta, "input"); // schedules a debounced save
  ed.flush(); // force it now

  assert.equal(saves.at(-1).scopeId, "f1");
  assert.deepEqual(saves.at(-1).variables, [
    { name: "base", value: "https://x", secure: false },
    { name: "key", value: "s3cr3t", secure: true },
  ]);
});

test("KV-mode row edit saves immediately (no debounce) for the scope", () => {
  const { ed, saves, fire } = makeEditor();
  ed.load({
    scopeId: "c1",
    scopeName: "API",
    variables: [{ name: "a", value: "1", secure: false }],
    bulkEditor: false,
  });

  const valIn = ed.element.querySelector(".vars-kv-row .params-value");
  valIn.value = "2";
  fire(valIn, "input");

  assert.equal(saves.at(-1).scopeId, "c1");
  assert.deepEqual(saves.at(-1).variables, [
    { name: "a", value: "2", secure: false },
  ]);
});

test("loading a new scope flushes a pending save for the previous scope", () => {
  const { ed, saves, fire } = makeEditor();
  ed.load({
    scopeId: "f1",
    scopeName: "Auth",
    variables: [],
    bulkEditor: true,
  });

  const ta = ed.element.querySelector(".vars-textarea");
  ta.value = "x=1";
  fire(ta, "input"); // pending (debounced) save for f1

  ed.load({
    scopeId: "f2",
    scopeName: "Other",
    variables: [],
    bulkEditor: true,
  });

  assert.equal(
    saves.length,
    1,
    "the pending f1 save was flushed by the switch",
  );
  assert.equal(saves[0].scopeId, "f1");
  assert.deepEqual(saves[0].variables, [
    { name: "x", value: "1", secure: false },
  ]);
});

test("toggling the bulk editor off reports the change and re-saves as rows", () => {
  const { ed, saves, bulkChanges, fire } = makeEditor();
  ed.load({
    scopeId: "f1",
    scopeName: "Auth",
    variables: [{ name: "a", value: "1", secure: false }],
    bulkEditor: true,
  });

  const toggle = ed.element.querySelector(".vars-bulk-toggle");
  toggle.checked = false;
  fire(toggle, "change");

  assert.deepEqual(bulkChanges.at(-1), { bulkEditor: false });
  assert.deepEqual(saves.at(-1).variables, [
    { name: "a", value: "1", secure: false },
  ]);
});

test("flush is a no-op when there is no pending save", () => {
  const { ed, saves } = makeEditor();
  ed.load({
    scopeId: "f1",
    scopeName: "Auth",
    variables: [],
    bulkEditor: true,
  });
  ed.flush();
  assert.equal(saves.length, 0);
});
