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

test("log skeleton is HAR 1.2 with a Rest Hippo creator", () => {
  const { collection } = fixture();
  const out = JSON.parse(exportToHar(collection, new Map()));
  assert.equal(out.log.version, "1.2");
  assert.equal(out.log.creator.name, "Rest Hippo");
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

/** One-request collection + a single run, for body-redaction cases. */
function bodyFixture(sentBody, sentCt, respBody, respCt) {
  const collection = {
    id: "c1",
    type: "collection",
    name: "C",
    children: [
      {
        id: "req-1",
        type: "request",
        name: "Token",
        method: "POST",
        url: "https://idp/token",
      },
    ],
  };
  const entry = {
    id: "h1",
    timestamp: 1700000000000,
    response: {
      request: {
        method: "POST",
        url: "https://idp/token",
        headers: sentCt ? { "Content-Type": sentCt } : {},
        body: sentBody,
      },
      status: 200,
      statusText: "OK",
      headers: respCt ? { "Content-Type": respCt } : {},
      cookies: [],
      body: respBody ?? "",
      elapsed: 5,
      size: 0,
    },
  };
  return { collection, entry };
}

test("a form-urlencoded token-request body blanks secrets, keeps identifiers", () => {
  const { collection, entry } = bodyFixture(
    "grant_type=password&username=alice&password=SECRET-PW&client_secret=SECRET-CS&scope=read",
    "application/x-www-form-urlencoded",
  );
  const json = exportToHar(collection, new Map([["req-1", entry]]));
  assert.ok(!json.includes("SECRET-PW"), "password leaked");
  assert.ok(!json.includes("SECRET-CS"), "client_secret leaked");

  const params = new URLSearchParams(
    JSON.parse(json).log.entries[0].request.postData.text,
  );
  assert.equal(params.get("password"), "");
  assert.equal(params.get("client_secret"), "");
  assert.equal(params.get("grant_type"), "password"); // identifier kept
  assert.equal(params.get("username"), "alice"); // identifier kept
  assert.equal(params.get("scope"), "read");
});

test("a JSON token response blanks access/refresh tokens, keeps non-secrets", () => {
  const { collection, entry } = bodyFixture(
    null,
    null,
    JSON.stringify({
      access_token: "SECRET-AT",
      refresh_token: "SECRET-RT",
      data: { api_key: "SECRET-NESTED" }, // nested secret must also go
      token_type: "Bearer",
      expires_in: 3600,
      scope: "read",
    }),
    "application/json",
  );
  const json = exportToHar(collection, new Map([["req-1", entry]]));
  assert.ok(!json.includes("SECRET-AT"), "access_token leaked");
  assert.ok(!json.includes("SECRET-RT"), "refresh_token leaked");
  assert.ok(!json.includes("SECRET-NESTED"), "nested api_key leaked");

  const content = JSON.parse(
    JSON.parse(json).log.entries[0].response.content.text,
  );
  assert.equal(content.access_token, "");
  assert.equal(content.refresh_token, "");
  assert.equal(content.data.api_key, "");
  assert.equal(content.expires_in, 3600); // non-secret kept
  assert.equal(content.scope, "read");
});

test("an opaque (non-structured) body is exported verbatim", () => {
  // Documents the known limitation: HTML/text/binary can't be parsed for
  // secrets, so they pass through unchanged.
  const { collection, entry } = bodyFixture(
    "<form><input name=password value=hunter2></form>",
    "text/html",
  );
  const pd = JSON.parse(exportToHar(collection, new Map([["req-1", entry]])))
    .log.entries[0].request.postData;
  assert.equal(pd.text, "<form><input name=password value=hunter2></form>");
});

test("the secret-field heuristic also catches pwd / signature / jwt / otp", () => {
  const { collection, entry } = bodyFixture(
    "pwd=SECRET-PWD&user_pwd=SECRET-UPWD&signature=SECRET-SIG&jwt=SECRET-JWT&otp=123456&username=alice",
    "application/x-www-form-urlencoded",
  );
  const json = exportToHar(collection, new Map([["req-1", entry]]));
  for (const s of ["SECRET-PWD", "SECRET-UPWD", "SECRET-SIG", "SECRET-JWT"]) {
    assert.ok(!json.includes(s), `${s} leaked`);
  }
  const params = new URLSearchParams(
    JSON.parse(json).log.entries[0].request.postData.text,
  );
  assert.equal(params.get("pwd"), "");
  assert.equal(params.get("user_pwd"), "");
  assert.equal(params.get("signature"), "");
  assert.equal(params.get("jwt"), "");
  assert.equal(params.get("otp"), ""); // value 123456 blanked
  assert.equal(params.get("username"), "alice"); // identifier kept
});

test("query-string secrets are blanked in request.url and queryString", () => {
  const collection = {
    id: "c1",
    type: "collection",
    name: "C",
    children: [
      {
        id: "req-1",
        type: "request",
        name: "Q",
        method: "GET",
        url: "https://api/x",
      },
    ],
  };
  const entry = {
    id: "h1",
    timestamp: 1700000000000,
    response: {
      request: {
        method: "GET",
        url: "https://api/x?access_token=SECRET-QT&api_key=SECRET-QK&q=1",
        headers: {},
        body: null,
      },
      status: 200,
      statusText: "OK",
      headers: {},
      cookies: [],
      body: "",
      elapsed: 1,
      size: 0,
    },
  };
  const json = exportToHar(collection, new Map([["req-1", entry]]));
  assert.ok(!json.includes("SECRET-QT"), "access_token in query leaked");
  assert.ok(!json.includes("SECRET-QK"), "api_key in query leaked");

  const e = JSON.parse(json).log.entries[0];
  const u = new URL(e.request.url);
  assert.equal(u.searchParams.get("access_token"), "");
  assert.equal(u.searchParams.get("api_key"), "");
  assert.equal(u.searchParams.get("q"), "1"); // non-secret kept
  const qs = Object.fromEntries(
    e.request.queryString.map((p) => [p.name, p.value]),
  );
  assert.equal(qs.access_token, "");
  assert.equal(qs.q, "1");
});

test("a pathologically deep JSON body fails closed (secret blanked, not leaked)", () => {
  let obj = { api_key: "SECRET-DEEP" };
  for (let i = 0; i < 400; i++) obj = { nested: obj }; // > MAX_REDACT_DEPTH
  const { collection, entry } = bodyFixture(
    null,
    null,
    JSON.stringify(obj),
    "application/json",
  );
  const json = exportToHar(collection, new Map([["req-1", entry]]));
  assert.ok(!json.includes("SECRET-DEEP"), "deeply nested secret leaked");
});
