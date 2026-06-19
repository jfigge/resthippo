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
 * body-filter.test.js — the response body filter engine (jq / yq).
 *
 * Covers the JSON (jq) and YAML (yq) paths, which are pure data transforms with
 * no DOM dependency. The XML path uses the renderer's native DOMParser +
 * document.evaluate (XPath), which jsdom does not implement, so it is exercised
 * at runtime rather than here.
 */
"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import { filterBody, isFilterable } from "../response/body-filter.js";

const JSON_BODY = JSON.stringify({
  items: [
    { name: "a", active: true, n: 3 },
    { name: "b", active: false, n: 1 },
    { name: "c", active: true, n: 2 },
  ],
  meta: { total: 3 },
});

const YAML_BODY = [
  "items:",
  "  - name: a",
  "    active: true",
  "    n: 3",
  "  - name: b",
  "    active: false",
  "    n: 1",
  "meta:",
  "  total: 2",
  "",
].join("\n");

test("isFilterable: only json / yaml / xml are filterable", () => {
  assert.equal(isFilterable("json"), true);
  assert.equal(isFilterable("yaml"), true);
  assert.equal(isFilterable("xml"), true);
  assert.equal(isFilterable("html"), false);
  assert.equal(isFilterable("markdown"), false);
  assert.equal(isFilterable("other"), false);
});

test("json: a single jq output is pretty-printed", () => {
  assert.equal(filterBody("json", JSON_BODY, ".meta"), '{\n  "total": 3\n}');
});

test("json: select() filters and each output is one line", () => {
  assert.equal(
    filterBody("json", JSON_BODY, ".items[] | select(.active) | .name"),
    '"a"\n"c"',
  );
});

test("json: a builtin over a collected array (add) evaluates", () => {
  assert.equal(filterBody("json", JSON_BODY, "[.items[].n] | add"), "6");
});

test("json: a missing field normalizes to literal null", () => {
  assert.equal(filterBody("json", JSON_BODY, ".nope"), "null");
});

test("json: a malformed body throws (caller surfaces the message)", () => {
  assert.throws(() => filterBody("json", "{ not json", ".x"));
});

test("json: an invalid jq program throws", () => {
  assert.throws(() => filterBody("json", JSON_BODY, ".items["));
});

test("yaml: the result is re-emitted as YAML", () => {
  assert.equal(filterBody("yaml", YAML_BODY, ".meta"), "total: 2");
});

test("yaml: multiple jq outputs become a multi-document YAML stream", () => {
  assert.equal(
    filterBody("yaml", YAML_BODY, ".items[] | select(.active) | .name"),
    "a",
  );
  assert.equal(filterBody("yaml", YAML_BODY, ".items[].name"), "a\n---\nb");
});

test("an unsupported category throws", () => {
  assert.throws(() => filterBody("html", "<p>hi</p>", "//p"));
});
