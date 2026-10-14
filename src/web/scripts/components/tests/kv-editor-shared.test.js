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
 * kv-editor-shared.test.js — the pure bulk-text <→> rows converters shared by the
 * Params and Headers editors. These drive the bulk-edit round-trip (enabled state
 * via a "# " prefix, name-only rows, first-separator splitting, and the header
 * colon-vs-equals preference), so a regression here silently corrupts saved
 * requests on a bulk edit.
 */
"use strict";

// jsdom-setup first — the module pulls in icons/delete-confirm/i18n at load.
import "../../tests/jsdom-setup.js";

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  kvRowsToText,
  headerRowsToText,
  textToKvRows,
  textToHeaderRows,
} from "../kv-editor-shared.js";

/** Drop the random id so rows compare by their meaningful fields. */
const bare = (rows) =>
  rows.map(({ name, value, enabled }) => ({ name, value, enabled }));

// ── serialize ────────────────────────────────────────────────────────────────

test("kvRowsToText serializes name=value, prefixing disabled rows with '# '", () => {
  assert.equal(
    kvRowsToText([
      { name: "a", value: "1", enabled: true },
      { name: "b", value: "2", enabled: false },
    ]),
    "a=1\n# b=2",
  );
});

test("headerRowsToText serializes 'Name: value' with the disabled prefix", () => {
  assert.equal(
    headerRowsToText([
      { name: "Accept", value: "application/json", enabled: true },
      { name: "X-Off", value: "z", enabled: false },
    ]),
    "Accept: application/json\n# X-Off: z",
  );
});

// ── parse: kv (name=value) ─────────────────────────────────────────────────────

test("textToKvRows parses enabled/disabled rows and skips blank lines", () => {
  assert.deepEqual(bare(textToKvRows("a=1\n\n# b=2\n")), [
    { name: "a", value: "1", enabled: true },
    { name: "b", value: "2", enabled: false },
  ]);
});

test("textToKvRows: a name-only line becomes a name with an empty value", () => {
  assert.deepEqual(bare(textToKvRows("solo")), [
    { name: "solo", value: "", enabled: true },
  ]);
});

test("textToKvRows splits on the FIRST '=' so values may contain '='", () => {
  assert.deepEqual(bare(textToKvRows("q=a=b=c")), [
    { name: "q", value: "a=b=c", enabled: true },
  ]);
});

test("textToKvRows drops a leading-'=' line (empty name) but keeps real rows", () => {
  assert.deepEqual(bare(textToKvRows("=orphan\nok=1")), [
    { name: "ok", value: "1", enabled: true },
  ]);
});

// ── parse: headers (colon or equals) ────────────────────────────────────────────

test("textToHeaderRows prefers the colon separator and trims the value", () => {
  assert.deepEqual(bare(textToHeaderRows("Content-Type:  application/json")), [
    { name: "Content-Type", value: "application/json", enabled: true },
  ]);
});

test("textToHeaderRows falls back to '=' when no colon precedes it", () => {
  assert.deepEqual(bare(textToHeaderRows("X-Token=abc")), [
    { name: "X-Token", value: "abc", enabled: true },
  ]);
});

test("textToHeaderRows: an earlier colon wins over a later equals", () => {
  // "a: b=c" → colon at 1 precedes '=' at 4 → name "a", value "b=c".
  assert.deepEqual(bare(textToHeaderRows("a: b=c")), [
    { name: "a", value: "b=c", enabled: true },
  ]);
});

test("textToHeaderRows: an earlier equals wins over a later colon", () => {
  // "a=b:c" → '=' at 1 precedes colon at 3 → name "a", value "b:c".
  assert.deepEqual(bare(textToHeaderRows("a=b:c")), [
    { name: "a", value: "b:c", enabled: true },
  ]);
});

test("textToHeaderRows honours the disabled '# ' prefix", () => {
  assert.deepEqual(bare(textToHeaderRows("# Accept: */*")), [
    { name: "Accept", value: "*/*", enabled: false },
  ]);
});

// ── round-trip properties ───────────────────────────────────────────────────────

test("property: kv rows survive a rows → text → rows round-trip (clean values)", () => {
  const rows = [
    { name: "user", value: "alice", enabled: true },
    { name: "token", value: "a=b=c", enabled: true }, // '=' in value
    { name: "off", value: "x", enabled: false }, // disabled state
  ];
  assert.deepEqual(bare(textToKvRows(kvRowsToText(rows))), rows);
});

test("property: header rows survive a rows → text → rows round-trip (clean values)", () => {
  const rows = [
    { name: "Accept", value: "application/json", enabled: true },
    { name: "Authorization", value: "Bearer xyz", enabled: true },
    { name: "X-Debug", value: "1", enabled: false },
  ];
  assert.deepEqual(bare(textToHeaderRows(headerRowsToText(rows))), rows);
});
