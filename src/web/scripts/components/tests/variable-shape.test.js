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
