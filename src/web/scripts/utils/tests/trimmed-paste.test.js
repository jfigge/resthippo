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
 * Tests for utils/trimmed-paste.js — pasted text is trimmed at both ends before
 * insertion into a bulk-editor textarea.
 */
"use strict";

import "../../tests/jsdom-setup.js";

import { test } from "node:test";
import assert from "node:assert/strict";

import { trimPastedText, wireTrimmedPaste } from "../trimmed-paste.js";

/** Build a wired textarea holding `value` with the selection at [start, end). */
function setup(value, start = value.length, end = start) {
  const ta = document.createElement("textarea");
  document.body.appendChild(ta);
  wireTrimmedPaste(ta);
  ta.value = value;
  ta.setSelectionRange(start, end);
  let inputs = 0;
  ta.addEventListener("input", () => inputs++);
  return { ta, inputs: () => inputs };
}

/** Dispatch a paste event carrying `text`; returns the event. */
function paste(ta, text) {
  const e = new Event("paste", { bubbles: true, cancelable: true });
  e.clipboardData = { getData: (type) => (type === "text/plain" ? text : "") };
  ta.dispatchEvent(e);
  return e;
}

test("trims leading/trailing whitespace and newline from the pasted value", () => {
  const { ta, inputs } = setup("token=");
  const e = paste(ta, "  abc123 \t\n");
  assert.equal(e.defaultPrevented, true);
  assert.equal(ta.value, "token=abc123");
  assert.equal(ta.selectionStart, "token=abc123".length);
  assert.equal(inputs(), 1);
});

test("already-trimmed text is left to the native paste", () => {
  const { ta, inputs } = setup("token=");
  const e = paste(ta, "abc123");
  assert.equal(e.defaultPrevented, false);
  assert.equal(ta.value, "token=");
  assert.equal(inputs(), 0);
});

test("multi-line paste keeps interior newlines and trims only the ends", () => {
  const { ta } = setup("");
  paste(ta, "\n  a=1\n  b=2  \n\n");
  assert.equal(ta.value, "a=1\n  b=2");
});

test("replaces the selected range", () => {
  const { ta } = setup("token=old\nx=1", 6, 9);
  paste(ta, " new ");
  assert.equal(ta.value, "token=new\nx=1");
});

test("whitespace-only paste inserts nothing", () => {
  const { ta, inputs } = setup("token=");
  const e = paste(ta, "   \n");
  assert.equal(e.defaultPrevented, true);
  assert.equal(ta.value, "token=");
  assert.equal(inputs(), 1);
});

test("an empty clipboard is ignored", () => {
  const { ta } = setup("token=");
  const e = paste(ta, "");
  assert.equal(e.defaultPrevented, false);
});

test("trimPastedText strips edge whitespace and invisible zero-width characters", () => {
  assert.equal(trimPastedText("  abc \t\r\n"), "abc");
  assert.equal(trimPastedText("\u00A0abc\u00A0"), "abc"); // NBSP
  assert.equal(trimPastedText("\uFEFFabc"), "abc"); // BOM
  assert.equal(trimPastedText("\u200Babc\u200C\u200D"), "abc"); // ZWSP/ZWNJ/ZWJ
  assert.equal(trimPastedText("\u2060 abc \u2060"), "abc"); // word joiner
  assert.equal(trimPastedText("\u180Eabc"), "abc");
  assert.equal(trimPastedText("\u2028abc\u2029"), "abc"); // line/para separators
  assert.equal(trimPastedText("\u3000abc"), "abc"); // ideographic space
});

test("trimPastedText keeps interior whitespace and zero-width characters", () => {
  assert.equal(trimPastedText(" a b\u200Bc\n d "), "a b\u200Bc\n d");
  assert.equal(trimPastedText(" \u200B\n "), "");
});

test("a zero-width space that String.trim() misses is stripped from a paste", () => {
  const { ta } = setup("token=");
  const e = paste(ta, "\u200Babc123\u200B");
  assert.equal(e.defaultPrevented, true);
  assert.equal(ta.value, "token=abc123");
});

test("works on a text <input> as well as a textarea", () => {
  const input = document.createElement("input");
  input.type = "text";
  document.body.appendChild(input);
  wireTrimmedPaste(input);
  input.value = "";
  input.setSelectionRange(0, 0);
  let inputs = 0;
  input.addEventListener("input", () => inputs++);
  paste(input, "\t value \n");
  assert.equal(input.value, "value");
  assert.equal(inputs, 1);
});

test("a read-only field is never written by the paste fallback", () => {
  const { ta, inputs } = setup("locked");
  ta.readOnly = true;
  const e = paste(ta, " new ");
  assert.equal(e.defaultPrevented, false);
  assert.equal(ta.value, "locked");
  assert.equal(inputs(), 0);
});
