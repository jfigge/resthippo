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
 * drag-drop.test.js — truth table for computeDropPos (the geometry-free half of
 * the tree's drag-and-drop). The ratio-from-a-real-row-rect half is covered by
 * the e2e geometry harness, which jsdom can't exercise (rects are stubbed to 0).
 *
 * Run with:   node --test src/web/scripts/components/tests/drag-drop.test.js
 */
"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDropPos } from "../drag-drop.js";

test("request target: before in the top half, after in the bottom half", () => {
  assert.equal(computeDropPos(0.0, "request", false, false), "before");
  assert.equal(computeDropPos(0.49, "request", true, true), "before");
  assert.equal(computeDropPos(0.5, "request", false, false), "after");
  assert.equal(computeDropPos(1.0, "request", false, false), "after");
});

test("request → collection: before <0.25, inside the middle, after >0.75", () => {
  assert.equal(computeDropPos(0.1, "collection", false, false), "before");
  assert.equal(computeDropPos(0.24, "collection", true, false), "before");
  assert.equal(computeDropPos(0.25, "collection", false, false), "inside"); // lower boundary → inside
  assert.equal(computeDropPos(0.5, "collection", false, false), "inside");
  assert.equal(computeDropPos(0.75, "collection", false, false), "inside"); // upper boundary → inside
  assert.equal(computeDropPos(0.76, "collection", false, false), "after");
  assert.equal(computeDropPos(0.9, "collection", false, false), "after");
});

test("collection → open collection: before <0.25, otherwise nest inside", () => {
  assert.equal(computeDropPos(0.1, "collection", true, true), "before");
  assert.equal(computeDropPos(0.24, "collection", true, true), "before");
  assert.equal(computeDropPos(0.25, "collection", true, true), "inside");
  assert.equal(computeDropPos(0.9, "collection", true, true), "inside");
});

test("collection → closed collection: sibling before <0.5 else after (never nests)", () => {
  assert.equal(computeDropPos(0.1, "collection", false, true), "before");
  assert.equal(computeDropPos(0.49, "collection", false, true), "before");
  assert.equal(computeDropPos(0.5, "collection", false, true), "after");
  assert.equal(computeDropPos(0.9, "collection", false, true), "after");
});

test("isOpen only affects a collection dragged onto a collection", () => {
  // Request dragged onto a collection: the open flag must not change the result.
  assert.equal(
    computeDropPos(0.5, "collection", true, false),
    computeDropPos(0.5, "collection", false, false),
  );
});
