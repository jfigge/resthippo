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
 * response-cache.test.js — the last-response cache extracted from app.js. The
 * keying rule (seed under BOTH id and name so a reference stored either way
 * resolves) is the load-bearing behaviour.
 */
"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import { ResponseCache } from "../response-cache.js";

test("set() seeds bodies/headers/statuses under both id and name", () => {
  const c = new ResponseCache();
  c.set({ id: "r1", name: "Login" }, "body", { ct: "json" }, 200);
  for (const key of ["r1", "Login"]) {
    assert.equal(c.bodies[key], "body");
    assert.deepEqual(c.headers[key], { ct: "json" });
    assert.equal(c.statuses[key], 200);
  }
});

test("a missing id or name is skipped (no 'undefined' key)", () => {
  const c = new ResponseCache();
  c.set({ id: "r1" }, "b", {}, 200); // no name
  assert.ok("r1" in c.bodies);
  assert.ok(!("undefined" in c.bodies));

  c.set({ name: "N" }, "b2", {}, 201); // no id
  assert.equal(c.bodies.N, "b2");
  assert.equal(c.statuses.N, 201);
});

test("a later set overwrites the same key (latest response wins)", () => {
  const c = new ResponseCache();
  c.set({ id: "r1" }, "old", {}, 200);
  c.set({ id: "r1" }, "new", { x: 1 }, 500);
  assert.equal(c.bodies.r1, "new");
  assert.deepEqual(c.headers.r1, { x: 1 });
  assert.equal(c.statuses.r1, 500);
});

test("a null/undefined ref is a no-op", () => {
  const c = new ResponseCache();
  assert.doesNotThrow(() => c.set(null, "b", {}, 200));
  assert.doesNotThrow(() => c.set(undefined, "b", {}, 200));
  assert.deepEqual(c.bodies, {});
  assert.deepEqual(c.statuses, {});
});

test("distinct instances do not share state", () => {
  const a = new ResponseCache();
  const b = new ResponseCache();
  a.set({ id: "r1" }, "a-body", {}, 200);
  assert.deepEqual(b.bodies, {});
});
