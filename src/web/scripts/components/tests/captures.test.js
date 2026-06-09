"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import { applyCaptures } from "../captures.js";

const rule = (over = {}) => ({
  id: "r1",
  enabled: true,
  source: "body",
  path: ".access_token",
  target: { scope: "environment", name: "authToken" },
  secure: false,
  ...over,
});

// ── body extraction ──────────────────────────────────────────────────────────

test("body: extracts a top-level field via dot-path", () => {
  const res = {
    status: 200,
    headers: {},
    body: '{"access_token":"abc123","expires_in":3600}',
  };
  const { writes, warnings } = applyCaptures(res, [rule()]);
  assert.deepEqual(writes, [
    { scope: "environment", name: "authToken", value: "abc123", secure: false },
  ]);
  assert.deepEqual(warnings, []);
});

test("body: extracts a nested field and an array index", () => {
  const res = {
    status: 200,
    headers: {},
    body: '{"data":{"items":[{"id":42}]}}',
  };
  const rules = [
    rule({
      path: ".data.items.[0].id",
      target: { scope: "global", name: "first" },
    }),
  ];
  const { writes } = applyCaptures(res, rules);
  assert.deepEqual(writes, [
    { scope: "global", name: "first", value: "42", secure: false },
  ]);
});

test("body: a missing path yields a warning and no write", () => {
  const res = { status: 200, headers: {}, body: '{"other":1}' };
  const { writes, warnings } = applyCaptures(res, [rule()]);
  assert.deepEqual(writes, []);
  assert.deepEqual(warnings, [{ name: "authToken", scope: "environment" }]);
});

test("body: a non-JSON body yields a warning and no write", () => {
  const res = { status: 200, headers: {}, body: "<html>not json</html>" };
  const { writes, warnings } = applyCaptures(res, [rule()]);
  assert.deepEqual(writes, []);
  assert.deepEqual(warnings, [{ name: "authToken", scope: "environment" }]);
});

test("body: an unsupported (complex) path is reported, not thrown", () => {
  const res = { status: 200, headers: {}, body: '{"a":[1,2,3]}' };
  const rules = [rule({ path: ".a | length" })];
  const { writes, warnings } = applyCaptures(res, rules);
  assert.deepEqual(writes, []);
  assert.equal(warnings.length, 1);
});

// ── header extraction ────────────────────────────────────────────────────────

test("header: reads the lowercase-keyed map case-insensitively", () => {
  const res = {
    status: 200,
    headers: { "x-request-id": "req-xyz" },
    body: "",
  };
  const rules = [
    rule({
      source: "header",
      path: "X-Request-Id",
      target: { scope: "collection", name: "requestId" },
    }),
  ];
  const { writes } = applyCaptures(res, rules);
  assert.deepEqual(writes, [
    { scope: "collection", name: "requestId", value: "req-xyz", secure: false },
  ]);
});

test("header: an absent header yields a warning and no write", () => {
  const res = { status: 200, headers: {}, body: "" };
  const rules = [rule({ source: "header", path: "x-missing" })];
  const { writes, warnings } = applyCaptures(res, rules);
  assert.deepEqual(writes, []);
  assert.equal(warnings.length, 1);
});

// ── status extraction ────────────────────────────────────────────────────────

test("status: captures the numeric status as a string", () => {
  const res = { status: 201, headers: {}, body: "" };
  const rules = [
    rule({
      source: "status",
      path: "",
      target: { scope: "global", name: "lastStatus" },
    }),
  ];
  const { writes } = applyCaptures(res, rules);
  assert.deepEqual(writes, [
    { scope: "global", name: "lastStatus", value: "201", secure: false },
  ]);
});

// ── rule handling ────────────────────────────────────────────────────────────

test("disabled rules are skipped entirely", () => {
  const res = { status: 200, headers: {}, body: '{"access_token":"abc"}' };
  const { writes, warnings } = applyCaptures(res, [rule({ enabled: false })]);
  assert.deepEqual(writes, []);
  assert.deepEqual(warnings, []);
});

test("a rule with an empty target name is skipped (not warned)", () => {
  const res = { status: 200, headers: {}, body: '{"access_token":"abc"}' };
  const rules = [rule({ target: { scope: "environment", name: "  " } })];
  const { writes, warnings } = applyCaptures(res, rules);
  assert.deepEqual(writes, []);
  assert.deepEqual(warnings, []);
});

test("the secure flag is carried onto the write", () => {
  const res = { status: 200, headers: {}, body: '{"access_token":"abc"}' };
  const { writes } = applyCaptures(res, [rule({ secure: true })]);
  assert.equal(writes[0].secure, true);
});

test("multiple rules accumulate writes and warnings independently", () => {
  const res = {
    status: 200,
    headers: { etag: "v7" },
    body: '{"id":"u1"}',
  };
  const rules = [
    rule({ path: ".id", target: { scope: "environment", name: "userId" } }),
    rule({
      source: "header",
      path: "etag",
      target: { scope: "global", name: "etag" },
    }),
    rule({ path: ".missing", target: { scope: "collection", name: "nope" } }),
  ];
  const { writes, warnings } = applyCaptures(res, rules);
  assert.deepEqual(writes, [
    { scope: "environment", name: "userId", value: "u1", secure: false },
    { scope: "global", name: "etag", value: "v7", secure: false },
  ]);
  assert.deepEqual(warnings, [{ name: "nope", scope: "collection" }]);
});

test("non-array rules return empty results", () => {
  const res = { status: 200, headers: {}, body: "{}" };
  assert.deepEqual(applyCaptures(res, null), { writes: [], warnings: [] });
  assert.deepEqual(applyCaptures(res, undefined), { writes: [], warnings: [] });
});
