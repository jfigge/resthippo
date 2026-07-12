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
