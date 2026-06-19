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
 * captures-xml.test.js — XML body extraction for post-response captures.
 *
 * Captures parses an XML body to an element tree (via the renderer's DOMParser)
 * and walks the same dot-path used for JSON/YAML, rooted at the document
 * element's tag. Unlike the Filter's XPath path — which jsdom can't evaluate —
 * this only needs DOM traversal, which jsdom does implement, so it is unit-
 * tested here. The jsdom side-effect import MUST come first so `DOMParser` is on
 * the globals before captures.js is loaded.
 */
"use strict";

import "../../tests/jsdom-setup.js";

import { test } from "node:test";
import assert from "node:assert/strict";

import { applyCaptures } from "../captures.js";

const rule = (over = {}) => ({
  id: "r1",
  enabled: true,
  source: "body",
  path: ".root.access_token",
  target: { scope: "environment", name: "authToken" },
  secure: false,
  ...over,
});

test("body: extracts a value from an XML body (rooted at the document element)", () => {
  const res = {
    status: 200,
    headers: {},
    body: "<root><access_token>xml-abc</access_token></root>",
  };
  const { writes, warnings } = applyCaptures(res, [rule()]);
  assert.deepEqual(writes, [
    {
      scope: "environment",
      name: "authToken",
      value: "xml-abc",
      secure: false,
    },
  ]);
  assert.deepEqual(warnings, []);
});

test("body: extracts a nested XML field", () => {
  const res = {
    status: 200,
    headers: {},
    body: "<auth><data><token>nested-tok</token></data></auth>",
  };
  const rules = [
    rule({
      path: ".auth.data.token",
      target: { scope: "global", name: "tok" },
    }),
  ];
  const { writes } = applyCaptures(res, rules);
  assert.deepEqual(writes, [
    { scope: "global", name: "tok", value: "nested-tok", secure: false },
  ]);
});

test("body: repeated XML child tags become an indexable array", () => {
  const res = {
    status: 200,
    headers: {},
    body: "<list><item>one</item><item>two</item></list>",
  };
  const rules = [
    rule({
      path: ".list.item.[1]",
      target: { scope: "environment", name: "second" },
    }),
  ];
  const { writes } = applyCaptures(res, rules);
  assert.deepEqual(writes, [
    { scope: "environment", name: "second", value: "two", secure: false },
  ]);
});

test("body: an XML declaration prologue is tolerated", () => {
  const res = {
    status: 200,
    headers: {},
    body: '<?xml version="1.0"?>\n<root><id>42</id></root>',
  };
  const rules = [
    rule({ path: ".root.id", target: { scope: "environment", name: "id" } }),
  ];
  const { writes } = applyCaptures(res, rules);
  assert.deepEqual(writes, [
    { scope: "environment", name: "id", value: "42", secure: false },
  ]);
});

test("body: malformed XML yields a warning and no write", () => {
  const res = {
    status: 200,
    headers: {},
    body: "<root><unclosed></root>",
  };
  const { writes, warnings } = applyCaptures(res, [
    rule({ path: ".root.unclosed" }),
  ]);
  assert.deepEqual(writes, []);
  assert.equal(warnings.length, 1);
});

test("body: an XML body missing the path yields a warning", () => {
  const res = {
    status: 200,
    headers: {},
    body: "<root><other>1</other></root>",
  };
  const { writes, warnings } = applyCaptures(res, [rule()]);
  assert.deepEqual(writes, []);
  assert.equal(warnings.length, 1);
});

test("status gate still applies to XML rules (default 2xx)", () => {
  const body = "<root><msg>boom</msg></root>";
  const rules = [
    rule({ path: ".root.msg", target: { scope: "environment", name: "msg" } }),
  ];
  // 500 doesn't match the default 2xx selector → skipped, no write.
  assert.deepEqual(applyCaptures({ status: 500, headers: {}, body }, rules), {
    writes: [],
    warnings: [],
  });
  // Opt the rule into 5xx and it fires.
  const onErr = [
    rule({
      path: ".root.msg",
      status: ["5xx"],
      target: { scope: "environment", name: "msg" },
    }),
  ];
  assert.deepEqual(
    applyCaptures({ status: 500, headers: {}, body }, onErr).writes,
    [{ scope: "environment", name: "msg", value: "boom", secure: false }],
  );
});
