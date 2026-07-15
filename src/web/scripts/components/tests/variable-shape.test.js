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
 * variable-shape.test.js — the variable normalisation / flattening helpers.
 * varsArrayToMap runs over variables that can arrive from an imported
 * (untrusted) collection, so a `__proto__` entry must not re-parent the map or
 * pollute Object.prototype.
 *
 * Run with:  node --test src/web/scripts/components/tests/variable-shape.test.js
 */
"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import { varsArrayToMap, varsArrayToSecureSet } from "../variable-shape.js";

test("flattens an array to a name→value map, last write wins, empties dropped", () => {
  const map = varsArrayToMap([
    { name: "base", value: "https://x" },
    { name: "", value: "ignored" },
    { name: "base", value: "https://y" },
  ]);
  assert.deepEqual(map, { base: "https://y" });
});

test("a `__proto__` variable does not re-parent the map or pollute the prototype", () => {
  const before = Object.prototype.polluted;
  const map = varsArrayToMap([
    { name: "__proto__", value: { polluted: "yes" } },
    { name: "ok", value: "1" },
  ]);
  // The map keeps a normal prototype (not the injected object)...
  assert.equal(Object.getPrototypeOf(map), Object.prototype);
  // ...global Object.prototype is untouched...
  assert.equal(Object.prototype.polluted, before);
  assert.equal({}.polluted, undefined);
  // ...and normal variables still resolve.
  assert.equal(map.ok, "1");
});

test("varsArrayToSecureSet collects names flagged secure", () => {
  const set = varsArrayToSecureSet([
    { name: "token", value: "s", secure: true },
    { name: "base", value: "u" },
  ]);
  assert.ok(set.has("token"));
  assert.ok(!set.has("base"));
});
