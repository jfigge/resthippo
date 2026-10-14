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
