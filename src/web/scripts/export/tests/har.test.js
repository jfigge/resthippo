/**
 * export/tests/har.test.js
 *
 * Unit tests for the HAR 1.2 exporter: log structure, the most-recent-run /
 * skip-never-run behaviour, and redaction of credential-bearing headers and
 * cookie values in a recorded exchange.
 *
 * Run with:   node --test export/tests/har.test.js
 */

"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import { exportToHar } from "../har.js";

/** A request node plus a matching run-history record. */
function fixture() {
  const collection = {
    id: "c1",
    type: "collection",
    name: "C",
    children: [
      {
        id: "req-1",
        type: "request",
        name: "List",
        method: "GET",
        url: "https://api.example.com/users",
      },
      // A second request with no history — must be skipped.
      {
        id: "req-2",
        type: "request",
        name: "Unrun",
        method: "GET",
        url: "https://api.example.com/none",
      },
    ],
  };

  const entry = {
    id: "h1",
    requestNode: { method: "GET" },
    requestUrl: "https://api.example.com/users?q=1",
    timestamp: 1700000000000,
    response: {
      request: {
        method: "GET",
        url: "https://api.example.com/users?q=1",
        headers: { Authorization: "Bearer SECRET-TOKEN", "X-Trace": "abc" },
        body: null,
      },
      status: 200,
      statusText: "OK",
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": "sid=SECRET-SETCOOKIE",
      },
      cookies: [{ name: "sid", value: "SECRET-COOKIE", path: "/" }],
      body: '{"ok":true}',
      elapsed: 42,
      size: 11,
    },
  };

  return { collection, entry };
}

test("log skeleton is HAR 1.2 with a wurl creator", () => {
  const { collection } = fixture();
  const out = JSON.parse(exportToHar(collection, new Map()));
  assert.equal(out.log.version, "1.2");
  assert.equal(out.log.creator.name, "wurl");
});

test("emits one entry per request with history; never-run requests are skipped", () => {
  const { collection, entry } = fixture();
  const out = JSON.parse(exportToHar(collection, new Map([["req-1", entry]])));
  assert.equal(out.log.entries.length, 1);

  const e = out.log.entries[0];
  assert.equal(e.request.method, "GET");
  assert.equal(e.response.status, 200);
  assert.equal(e.response.content.text, '{"ok":true}');
  assert.equal(e.response.content.mimeType, "application/json");
  assert.ok(
    e.request.queryString.some((q) => q.name === "q" && q.value === "1"),
  );
});

test("a collection with no run history yields a valid, empty HAR", () => {
  const { collection } = fixture();
  const out = JSON.parse(exportToHar(collection, new Map()));
  assert.deepEqual(out.log.entries, []);
});

test("credential headers and cookie values are redacted; names preserved", () => {
  const { collection, entry } = fixture();
  const json = exportToHar(collection, new Map([["req-1", entry]]));

  // No secret value survives anywhere in the archive.
  assert.ok(!json.includes("SECRET-TOKEN"), "Authorization token leaked");
  assert.ok(!json.includes("SECRET-COOKIE"), "cookie value leaked");
  assert.ok(!json.includes("SECRET-SETCOOKIE"), "Set-Cookie value leaked");

  const e = JSON.parse(json).log.entries[0];
  const auth = e.request.headers.find((h) => h.name === "Authorization");
  assert.equal(auth.value, "", "Authorization value not blanked");
  const trace = e.request.headers.find((h) => h.name === "X-Trace");
  assert.equal(trace.value, "abc", "non-secret header was altered");

  const setCookie = e.response.headers.find((h) => h.name === "Set-Cookie");
  assert.equal(setCookie.value, "", "Set-Cookie value not blanked");

  assert.equal(e.response.cookies[0].name, "sid");
  assert.equal(e.response.cookies[0].value, "", "cookie value not blanked");
});

test("a request body becomes postData with its content type", () => {
  const collection = {
    id: "c1",
    type: "collection",
    name: "C",
    children: [
      {
        id: "req-1",
        type: "request",
        name: "Create",
        method: "POST",
        url: "https://x/items",
      },
    ],
  };
  const entry = {
    id: "h1",
    timestamp: 1700000000000,
    response: {
      request: {
        method: "POST",
        url: "https://x/items",
        headers: { "Content-Type": "application/json" },
        body: '{"a":1}',
      },
      status: 201,
      statusText: "Created",
      headers: {},
      cookies: [],
      body: "",
      elapsed: 5,
      size: 0,
    },
  };

  const out = JSON.parse(exportToHar(collection, new Map([["req-1", entry]])));
  const pd = out.log.entries[0].request.postData;
  assert.equal(pd.mimeType, "application/json");
  assert.equal(pd.text, '{"a":1}');
});
