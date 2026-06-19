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

test("isCodeToken accepts 100–599 only", () => {
  assert.equal(isCodeToken("200"), true);
  assert.equal(isCodeToken("599"), true);
  assert.equal(isCodeToken("099"), false);
  assert.equal(isCodeToken("600"), false);
  assert.equal(isCodeToken("20"), false);
  assert.equal(isCodeToken("2xx"), false);
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
