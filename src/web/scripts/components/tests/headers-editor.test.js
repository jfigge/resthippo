/*
 * Copyright 2026 Jason Figge
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This file is part of Rest Hippo.
 *
 * Rest Hippo is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option) any later
 * version.
 *
 * Rest Hippo is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR
 * A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with
 * Rest Hippo. If not, see <https://www.gnu.org/licenses/>.
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
