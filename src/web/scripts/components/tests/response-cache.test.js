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
