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
 * headers-editor.test.js — the HeadersEditor data API. setHeaders() normalizes a
 * tolerant input shape (coercion + enabled defaulting + junk skipping) and
 * getHeaders() returns fresh, decoupled copies; setHeaders must not fire
 * onChange (it's a load, not an edit); applySettings toggles the column header.
 */
"use strict";

import { resetDom } from "../../tests/jsdom-setup.js";

import { test } from "node:test";
import assert from "node:assert/strict";

import { HeadersEditor } from "../headers-editor.js";

/** Fresh DOM + editor with a recording onChange. */
function makeEditor() {
  resetDom();
  const changes = [];
  const ed = new HeadersEditor({ onChange: (rows) => changes.push(rows) });
  return { ed, changes };
}

/** Rows without their random ids, for value comparison. */
const bare = (rows) =>
  rows.map(({ name, value, enabled }) => ({ name, value, enabled }));

test("setHeaders → getHeaders round-trips, defaulting enabled to true", () => {
  const { ed } = makeEditor();
  ed.setHeaders([
    { name: "Accept", value: "application/json" },
    { name: "X-Off", value: "z", enabled: false },
  ]);
  assert.deepEqual(bare(ed.getHeaders()), [
    { name: "Accept", value: "application/json", enabled: true },
    { name: "X-Off", value: "z", enabled: false },
  ]);
});

test("setHeaders normalizes a tolerant shape: coerces, defaults, skips junk", () => {
  const { ed } = makeEditor();
  ed.setHeaders([
    null,
    "not-an-object",
    { name: 123, value: true }, // coerced to strings
    { value: "no-name-ok" }, // name defaults to ""
  ]);
  assert.deepEqual(bare(ed.getHeaders()), [
    { name: "123", value: "true", enabled: true },
    { name: "", value: "no-name-ok", enabled: true },
  ]);
});

test("setHeaders with a non-array clears to an empty list", () => {
  const { ed } = makeEditor();
  ed.setHeaders([{ name: "A", value: "1" }]);
  assert.equal(ed.getHeaders().length, 1);
  ed.setHeaders("nope");
  assert.deepEqual(ed.getHeaders(), []);
});

test("an explicit id is preserved through the round-trip", () => {
  const { ed } = makeEditor();
  ed.setHeaders([{ id: "fixed-1", name: "A", value: "1" }]);
  assert.equal(ed.getHeaders()[0].id, "fixed-1");
});

test("getHeaders returns decoupled copies (mutating them can't corrupt state)", () => {
  const { ed } = makeEditor();
  ed.setHeaders([{ name: "A", value: "1" }]);
  const first = ed.getHeaders();
  first[0].name = "MUTATED";
  assert.equal(ed.getHeaders()[0].name, "A", "internal rows are untouched");
});

test("setHeaders is a load, not an edit — it never fires onChange", () => {
  const { ed, changes } = makeEditor();
  ed.setHeaders([{ name: "A", value: "1" }]);
  assert.equal(changes.length, 0);
});

test("setHeaders renders one row per header into the list", () => {
  const { ed } = makeEditor();
  ed.setHeaders([
    { name: "A", value: "1" },
    { name: "B", value: "2" },
    { name: "C", value: "3" },
  ]);
  const list = ed.element.querySelector(".params-list");
  assert.equal(list.childElementCount, 3);
});

test("applySettings({removeHeaders}) toggles the column-header row", () => {
  const { ed } = makeEditor();
  const hdr = ed.element.querySelector(".params-header-row");
  assert.ok(hdr, "column header row exists");
  ed.applySettings({ removeHeaders: true });
  assert.equal(hdr.style.display, "none");
  ed.applySettings({ removeHeaders: false });
  assert.notEqual(hdr.style.display, "none");
  // An absent flag is a no-op (doesn't force it visible/hidden).
  ed.applySettings({ removeHeaders: true });
  ed.applySettings({});
  assert.equal(hdr.style.display, "none", "unchanged when the flag is omitted");
});
