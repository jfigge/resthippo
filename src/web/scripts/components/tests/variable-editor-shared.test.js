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
 * tests/variable-editor-shared.test.js
 *
 * Unit tests for the secure-variable editor machinery shared by VariablesPopup,
 * CollectionsPopup and EnvironmentsPopup: the bulk-text <→> rows converters
 * (pure) and the buildVariableRow DOM builder (under jsdom).
 *
 * Run with:   node --test components/tests/variable-editor-shared.test.js
 */

"use strict";

// MUST come first — installs the jsdom globals buildVariableRow needs.
import { resetDom } from "../../tests/jsdom-setup.js";

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  variablesToText,
  textToVariables,
  variablesToRows,
  rowsToVariables,
  buildVariableRow,
} from "../variable-editor-shared.js";

// ── Conversions (pure) ───────────────────────────────────────────────────────

test("variablesToText prefixes secure rows with '$ '", () => {
  assert.equal(
    variablesToText([
      { name: "base", value: "https://x", secure: false },
      { name: "key", value: "s3cr3t", secure: true },
    ]),
    "base=https://x\n$ key=s3cr3t",
  );
});

test("textToVariables parses the '$ ' secure marker and ignores '='-less lines", () => {
  const out = textToVariables("base=https://x\n$ key=s3cr3t\n\nnope\n# c=1");
  assert.deepEqual(out, [
    { name: "base", value: "https://x", secure: false },
    { name: "key", value: "s3cr3t", secure: true },
    // "# c=1" is NOT a secure/disabled marker here ('#' is not '$ '), so it
    // parses as a normal variable named "# c".
    { name: "# c", value: "1", secure: false },
  ]);
});

test("text → variables → text round-trips, preserving the secure flag", () => {
  const text = "a=1\n$ b=2";
  assert.equal(variablesToText(textToVariables(text)), text);
});

test("variablesToRows assigns ids and preserves fields; rowsToVariables drops blank names", () => {
  const rows = variablesToRows([{ name: "a", value: "1", secure: true }]);
  assert.equal(rows.length, 1);
  assert.ok(typeof rows[0].id === "string" && rows[0].id.length > 0);
  assert.equal(rows[0].secure, true);

  const vars = rowsToVariables([
    { name: "keep", value: "v", secure: false },
    { name: "   ", value: "dropped", secure: true },
  ]);
  assert.deepEqual(vars, [{ name: "keep", value: "v", secure: false }]);
});

// ── buildVariableRow (jsdom) ─────────────────────────────────────────────────

function makeRow(overrides = {}, cbs = {}) {
  resetDom();
  const row = {
    id: "r1",
    name: "token",
    value: "abc",
    secure: false,
    ...overrides,
  };
  const el = buildVariableRow({
    row,
    rowClass: "vars-kv-row params-row",
    ...cbs,
  });
  document.body.appendChild(el);
  return { row, el };
}

test("buildVariableRow renders the name/value with the row's data", () => {
  const { el } = makeRow();
  assert.equal(el.querySelector(".params-name").value, "token");
  assert.equal(el.querySelector(".params-value").value, "abc");
  assert.equal(el.dataset.id, "r1");
});

test("buildVariableRow: editing inputs mutates the row and fires onChange", () => {
  let changes = 0;
  const { row, el } = makeRow({}, { onChange: () => changes++ });
  const valIn = el.querySelector(".params-value");
  valIn.value = "xyz";
  valIn.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(row.value, "xyz");
  assert.equal(changes, 1);
});

test("buildVariableRow: the secure toggle flips row.secure, reveal, and mask", () => {
  let changes = 0;
  const { row, el } = makeRow({}, { onChange: () => changes++ });
  const secureBtn = el.querySelector(".params-secure-btn");
  const valIn = el.querySelector(".params-value");
  const reveal = el.querySelector(".params-reveal-btn");

  // Not secure initially: reveal hidden, value not masked.
  assert.equal(reveal.style.display, "none");
  assert.equal(valIn.classList.contains("params-value--masked"), false);

  secureBtn.click();
  assert.equal(row.secure, true);
  assert.equal(changes, 1);
  assert.notEqual(reveal.style.display, "none"); // shown for secure rows
  assert.equal(valIn.classList.contains("params-value--masked"), true);
  assert.equal(secureBtn.classList.contains("params-secure-btn--active"), true);
});

test("buildVariableRow: reveal toggle unmasks a secure value", () => {
  const { el } = makeRow({ secure: true });
  const valIn = el.querySelector(".params-value");
  const reveal = el.querySelector(".params-reveal-btn");
  assert.equal(valIn.classList.contains("params-value--masked"), true);
  reveal.click();
  assert.equal(valIn.classList.contains("params-value--masked"), false);
});

test("buildVariableRow: Enter in the name input fires onEnter", () => {
  let entered = 0;
  const { el } = makeRow({}, { onEnter: () => entered++ });
  el.querySelector(".params-name").dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
  );
  assert.equal(entered, 1);
});

test("buildVariableRow: confirmed delete fires onDelete", () => {
  let deleted = 0;
  const { el } = makeRow({}, { onDelete: () => deleted++ });
  const del = el.querySelector(".params-delete-btn");
  del.click(); // arm
  del.click(); // confirm
  assert.equal(deleted, 1);
});

test("buildVariableRow: lockStructure disables secure + delete, keeps name read-only and value/reveal editable", () => {
  resetDom();
  let changes = 0;
  const row = { id: "r1", name: "token", value: "abc", secure: true };
  const el = buildVariableRow({
    row,
    rowClass: "vars-kv-row params-row",
    lockStructure: true,
    onChange: () => changes++,
  });
  document.body.appendChild(el);

  const nameIn = el.querySelector(".params-name");
  const valIn = el.querySelector(".params-value");
  const secureBtn = el.querySelector(".params-secure-btn");
  const del = el.querySelector(".params-delete-btn");

  // Name is read-only; the row carries the locked modifier class.
  assert.equal(nameIn.readOnly, true);
  assert.equal(el.classList.contains("vars-kv-row--locked"), true);

  // Secure + delete buttons are rendered but disabled and inert (no listeners).
  assert.equal(secureBtn.disabled, true);
  assert.equal(del.disabled, true);
  // The disabled delete control still shows its (trash) icon, not an empty button.
  assert.ok(
    del.querySelector("svg"),
    "disabled delete button renders its icon",
  );
  secureBtn.click();
  assert.equal(row.secure, true); // unchanged — click does nothing

  // The reveal (eye) toggle for a secure value still works.
  const reveal = el.querySelector(".params-reveal-btn");
  assert.equal(valIn.classList.contains("params-value--masked"), true);
  reveal.click();
  assert.equal(valIn.classList.contains("params-value--masked"), false);

  // Value stays editable and still fires onChange.
  valIn.value = "xyz";
  valIn.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(row.value, "xyz");
  assert.equal(changes, 1);
});
