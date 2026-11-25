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

"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeStatusMatch,
  statusMatches,
  isCodeToken,
} from "../status-match.js";

// ── normalizeStatusMatch ─────────────────────────────────────────────────────

test("normalize: an absent selector defaults to 2xx", () => {
  assert.deepEqual(normalizeStatusMatch(undefined), ["2xx"]);
  assert.deepEqual(normalizeStatusMatch(null), ["2xx"]);
  assert.deepEqual(normalizeStatusMatch("2xx"), ["2xx"]); // non-array → default
});

test("normalize: an explicit empty array is preserved", () => {
  assert.deepEqual(normalizeStatusMatch([]), []);
});

test("normalize: keeps valid tokens, drops junk, de-duplicates", () => {
  assert.deepEqual(
    normalizeStatusMatch(["2xx", "404", "any", "999", "", "abc", "404"]),
    ["2xx", "404", "any"],
  );
});

test("normalize: trims whitespace around tokens", () => {
  assert.deepEqual(normalizeStatusMatch([" 2xx ", " 201 "]), ["2xx", "201"]);
});

test("isCodeToken accepts HTTP codes and exit codes (0–599)", () => {
  assert.equal(isCodeToken("200"), true);
  assert.equal(isCodeToken("599"), true);
  // Exit codes for Command requests (Feature 70).
  assert.equal(isCodeToken("0"), true);
  assert.equal(isCodeToken("20"), true);
  assert.equal(isCodeToken("127"), true);
  assert.equal(isCodeToken("099"), false); // no leading zeros
  assert.equal(isCodeToken("600"), false);
  assert.equal(isCodeToken("2xx"), false);
});

test("HTTP matching ignores exit-code-only tokens", () => {
  assert.equal(statusMatches(200, ["0"]), false);
  assert.equal(statusMatches(0, ["0"]), false);
});

test("command mode: groups read as outcomes, exact tokens as exit codes", () => {
  const cmd = { command: true };
  assert.equal(statusMatches(0, ["2xx"], cmd), true);
  assert.equal(statusMatches(1, ["2xx"], cmd), false);
  assert.equal(statusMatches(1, ["4xx"], cmd), true);
  assert.equal(statusMatches(0, ["5xx"], cmd), false);
  assert.equal(statusMatches(3, ["3"], cmd), true);
  assert.equal(statusMatches(3, ["any"], cmd), true);
  assert.equal(statusMatches(0, ["0"], cmd), true);
  assert.equal(statusMatches(0, [], cmd), false);
});

// ── statusMatches ────────────────────────────────────────────────────────────

test("matches: a group token covers its whole class", () => {
  assert.equal(statusMatches(200, ["2xx"]), true);
  assert.equal(statusMatches(299, ["2xx"]), true);
  assert.equal(statusMatches(300, ["2xx"]), false);
  assert.equal(statusMatches(404, ["4xx"]), true);
  assert.equal(statusMatches(500, ["5xx"]), true);
});

test("matches: an exact code matches only that code", () => {
  assert.equal(statusMatches(201, ["201"]), true);
  assert.equal(statusMatches(200, ["201"]), false);
});

test("matches: 'any' matches every code", () => {
  assert.equal(statusMatches(204, ["any"]), true);
  assert.equal(statusMatches(404, ["any"]), true);
  assert.equal(statusMatches(503, ["any"]), true);
});

test("matches: a mix of group + exact code fires on either", () => {
  const sel = ["2xx", "404"];
  assert.equal(statusMatches(200, sel), true);
  assert.equal(statusMatches(404, sel), true);
  assert.equal(statusMatches(403, sel), false);
});

test("matches: an empty selector matches nothing", () => {
  assert.equal(statusMatches(200, []), false);
  assert.equal(statusMatches(200, null), false);
  assert.equal(statusMatches(200, undefined), false);
});

test("matches: a non-finite status never matches", () => {
  assert.equal(statusMatches(0, ["any"]), false);
  assert.equal(statusMatches(NaN, ["2xx"]), false);
});
