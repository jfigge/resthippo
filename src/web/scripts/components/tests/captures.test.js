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

// ── YAML body extraction ─────────────────────────────────────────────────────

test("body: extracts a top-level field from a YAML body", () => {
  const res = {
    status: 200,
    headers: {},
    body: "access_token: ya29-abc\nexpires_in: 3600\n",
  };
  const { writes, warnings } = applyCaptures(res, [rule()]);
  assert.deepEqual(writes, [
    {
      scope: "environment",
      name: "authToken",
      value: "ya29-abc",
      secure: false,
    },
  ]);
  assert.deepEqual(warnings, []);
});

test("body: extracts a nested YAML field and a sequence index", () => {
  const res = {
    status: 200,
    headers: {},
    body: "data:\n  items:\n    - id: 42\n",
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

test("body: a YAML body missing the path yields a warning", () => {
  const res = { status: 200, headers: {}, body: "other: 1\n" };
  const { writes, warnings } = applyCaptures(res, [rule()]);
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

// ── per-rule status gating ───────────────────────────────────────────────────

test("status gate: an absent selector defaults to 2xx-only", () => {
  const ok = { status: 200, headers: {}, body: '{"access_token":"abc"}' };
  const err = { status: 500, headers: {}, body: '{"access_token":"abc"}' };
  // 200 matches the default 2xx → writes; 500 does not → no write, no warning.
  assert.equal(applyCaptures(ok, [rule()]).writes.length, 1);
  assert.deepEqual(applyCaptures(err, [rule()]), { writes: [], warnings: [] });
});

test("status gate: a rule fires only on its selected codes", () => {
  const body = '{"error":"bad"}';
  const rules = [
    rule({
      path: ".error",
      status: ["4xx"],
      target: { scope: "environment", name: "lastError" },
    }),
  ];
  assert.deepEqual(applyCaptures({ status: 404, headers: {}, body }, rules), {
    writes: [
      {
        scope: "environment",
        name: "lastError",
        value: "bad",
        secure: false,
      },
    ],
    warnings: [],
  });
  // A 2xx response does not match the 4xx selector → silently skipped.
  assert.deepEqual(applyCaptures({ status: 200, headers: {}, body }, rules), {
    writes: [],
    warnings: [],
  });
});

test("status gate: different rules capture different codes from one response", () => {
  const okBody = '{"token":"t1"}';
  const errBody = '{"message":"nope"}';
  const rules = [
    rule({
      path: ".token",
      status: ["2xx"],
      target: { scope: "environment", name: "token" },
    }),
    rule({
      path: ".message",
      status: ["4xx", "5xx"],
      target: { scope: "environment", name: "error" },
    }),
  ];
  // On 200 only the 2xx rule applies.
  assert.deepEqual(
    applyCaptures({ status: 200, headers: {}, body: okBody }, rules).writes,
    [{ scope: "environment", name: "token", value: "t1", secure: false }],
  );
  // On 503 only the 4xx/5xx rule applies.
  assert.deepEqual(
    applyCaptures({ status: 503, headers: {}, body: errBody }, rules).writes,
    [{ scope: "environment", name: "error", value: "nope", secure: false }],
  );
});

test("status gate: an exact code selector matches only that code", () => {
  const body = '{"id":"u1"}';
  const rules = [rule({ path: ".id", status: ["201"] })];
  assert.equal(
    applyCaptures({ status: 201, headers: {}, body }, rules).writes.length,
    1,
  );
  assert.equal(
    applyCaptures({ status: 200, headers: {}, body }, rules).writes.length,
    0,
  );
});

test("status gate: 'any' captures on success and error alike", () => {
  const rules = [rule({ source: "status", path: "", status: ["any"] })];
  assert.equal(
    applyCaptures({ status: 204, headers: {}, body: "" }, rules).writes[0]
      .value,
    "204",
  );
  assert.equal(
    applyCaptures({ status: 500, headers: {}, body: "" }, rules).writes[0]
      .value,
    "500",
  );
});

test("status gate: an empty selector matches nothing", () => {
  const ok = { status: 200, headers: {}, body: '{"access_token":"abc"}' };
  assert.deepEqual(applyCaptures(ok, [rule({ status: [] })]), {
    writes: [],
    warnings: [],
  });
});
