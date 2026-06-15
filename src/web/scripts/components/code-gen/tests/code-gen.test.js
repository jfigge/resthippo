/**
 * code-gen/tests/code-gen.test.js
 *
 * Unit tests for the multi-language code generators (Feature 38): the
 * request→model normalizer (buildRequestModel) and each target's snippet output
 * (generateCode). Models are built from inline request nodes with an empty
 * resolver context so {{var}} resolution, request shape (method/url/params/
 * headers/auth/body), and per-language rendering are all exercised.
 *
 * Run with:   node --test components/code-gen/tests/code-gen.test.js
 */

"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildRequestModel, generateCode, TARGETS } from "../index.js";

// Empty resolver context — no env / folder variables. resolveString returns
// strings with no {{tokens}} unchanged, so request fields pass through verbatim.
const CTX = { envVariables: {}, folderChain: [] };

const GET_NODE = {
  type: "request",
  method: "GET",
  url: "https://api.example.com/users",
  params: [{ enabled: true, name: "page", value: "2" }],
};

const JSON_POST_NODE = {
  type: "request",
  method: "POST",
  url: "https://api.example.com/users",
  bodyType: "json",
  bodyText: '{"name":"Ada","active":true}',
};

// ── buildRequestModel ───────────────────────────────────────────────────────

test("buildRequestModel: GET bakes enabled query params into the URL", () => {
  const m = buildRequestModel(GET_NODE, CTX);
  assert.equal(m.method, "GET");
  assert.equal(m.url, "https://api.example.com/users?page=2");
  assert.deepEqual(m.body, { kind: "none" });
  assert.deepEqual(m.notes, []);
});

test("buildRequestModel: JSON POST sets a raw body + default Content-Type", () => {
  const m = buildRequestModel(JSON_POST_NODE, CTX);
  assert.equal(m.body.kind, "raw");
  assert.equal(m.body.text, '{"name":"Ada","active":true}');
  assert.deepEqual(
    m.headers.find((h) => h.name === "Content-Type"),
    { name: "Content-Type", value: "application/json" },
  );
});

test("buildRequestModel: a user Content-Type header wins over the default", () => {
  const m = buildRequestModel(
    {
      ...JSON_POST_NODE,
      headers: [
        {
          enabled: true,
          name: "Content-Type",
          value: "application/vnd.api+json",
        },
      ],
    },
    CTX,
  );
  const cts = m.headers.filter((h) => h.name === "Content-Type");
  assert.equal(cts.length, 1);
  assert.equal(cts[0].value, "application/vnd.api+json");
});

test("buildRequestModel: disabled params/headers are dropped", () => {
  const m = buildRequestModel(
    {
      type: "request",
      method: "GET",
      url: "https://x.test",
      params: [{ enabled: false, name: "skip", value: "1" }],
      headers: [{ enabled: false, name: "X-Skip", value: "1" }],
    },
    CTX,
  );
  // encodeBaseUrl normalizes a bare host with a trailing slash (URL parsing).
  assert.equal(m.url, "https://x.test/");
  assert.equal(m.headers.length, 0);
});

test("buildRequestModel: basic auth → Authorization: Basic <base64>", () => {
  const m = buildRequestModel(
    {
      type: "request",
      method: "GET",
      url: "https://x.test",
      authType: "basic",
      authBasic: { username: "user", password: "pass" },
    },
    CTX,
  );
  const auth = m.headers.find((h) => h.name === "Authorization");
  assert.equal(auth.value, `Basic ${btoa("user:pass")}`);
});

test("buildRequestModel: bearer auth → Authorization: Bearer <token>", () => {
  const m = buildRequestModel(
    {
      type: "request",
      method: "GET",
      url: "https://x.test",
      authType: "bearer",
      authBearer: { token: "abc123" },
    },
    CTX,
  );
  assert.equal(
    m.headers.find((h) => h.name === "Authorization").value,
    "Bearer abc123",
  );
});

test("buildRequestModel: AWS SigV4 emits a note and no Authorization header", () => {
  const m = buildRequestModel(
    {
      type: "request",
      method: "GET",
      url: "https://x.test",
      authType: "aws-iam",
    },
    CTX,
  );
  assert.equal(
    m.headers.find((h) => h.name === "Authorization"),
    undefined,
  );
  assert.equal(m.notes.length, 1);
  assert.match(m.notes[0], /AWS Signature v4/);
});

test("buildRequestModel: multipart strips a stray Content-Type header", () => {
  const m = buildRequestModel(
    {
      type: "request",
      method: "POST",
      url: "https://x.test",
      bodyType: "form-data",
      headers: [
        { enabled: true, name: "Content-Type", value: "multipart/form-data" },
      ],
      bodyFormRows: [{ enabled: true, kind: "text", name: "a", value: "1" }],
    },
    CTX,
  );
  assert.equal(m.body.kind, "multipart");
  assert.equal(
    m.headers.find((h) => h.name.toLowerCase() === "content-type"),
    undefined,
  );
});

test("buildRequestModel: a GET drops a body even if one is configured", () => {
  const m = buildRequestModel(
    {
      type: "request",
      method: "GET",
      url: "https://x.test",
      bodyType: "json",
      bodyText: "{}",
    },
    CTX,
  );
  assert.deepEqual(m.body, { kind: "none" });
});

test("buildRequestModel: {{var}} tokens resolve from the context", () => {
  const ctx = { envVariables: { host: "example.org" }, folderChain: [] };
  const m = buildRequestModel(
    { type: "request", method: "GET", url: "https://{{host}}/v1" },
    ctx,
  );
  assert.equal(m.url, "https://example.org/v1");
});

// ── generateCode — per target ───────────────────────────────────────────────

test("every target generates a non-empty snippet for GET and JSON POST", () => {
  for (const target of TARGETS) {
    for (const node of [GET_NODE, JSON_POST_NODE]) {
      const code = generateCode(target.id, buildRequestModel(node, CTX));
      assert.ok(
        typeof code === "string" && code.trim().length > 0,
        `${target.id} produced empty output`,
      );
    }
  }
});

test("cURL: reproduces the long-form command with --data for a JSON POST", () => {
  const code = generateCode("curl", buildRequestModel(JSON_POST_NODE, CTX));
  assert.match(code, /^curl --request POST/);
  assert.match(code, /--url 'https:\/\/api\.example\.com\/users'/);
  assert.match(code, /--header 'Content-Type: application\/json'/);
  assert.match(code, /--data '\{"name":"Ada","active":true\}'/);
});

test("cURL: GET keeps the baked-in query string", () => {
  const code = generateCode("curl", buildRequestModel(GET_NODE, CTX));
  assert.match(code, /--url 'https:\/\/api\.example\.com\/users\?page=2'/);
  assert.doesNotMatch(code, /--data/);
});

test("JavaScript fetch: uses fetch() with method/headers/body", () => {
  const code = generateCode("fetch", buildRequestModel(JSON_POST_NODE, CTX));
  assert.match(code, /await fetch\("https:\/\/api\.example\.com\/users", \{/);
  assert.match(code, /method: "POST"/);
  assert.match(code, /"Content-Type": "application\/json"/);
  assert.match(code, /body: "\{\\"name\\":\\"Ada\\",\\"active\\":true\}"/);
});

test("Python requests: uses requests.request with data=payload", () => {
  const code = generateCode("python", buildRequestModel(JSON_POST_NODE, CTX));
  assert.match(code, /^import requests/);
  assert.match(
    code,
    /requests\.request\("POST", "https:\/\/api\.example\.com\/users"/,
  );
  assert.match(code, /data=payload/);
  assert.match(code, /print\(response\.text\)/);
});

test("Go net/http: builds a runnable program with strings.NewReader body", () => {
  const code = generateCode("go", buildRequestModel(JSON_POST_NODE, CTX));
  assert.match(code, /^package main/);
  assert.match(code, /"net\/http"/);
  assert.match(code, /"strings"/);
  assert.match(
    code,
    /payload := strings\.NewReader\(`\{"name":"Ada","active":true\}`\)/,
  );
  assert.match(code, /http\.NewRequest\("POST", url, payload\)/);
});

test("Go net/http: GET with no body passes nil and omits strings import", () => {
  const code = generateCode("go", buildRequestModel(GET_NODE, CTX));
  assert.match(code, /http\.NewRequest\("GET", url, nil\)/);
  assert.doesNotMatch(code, /"strings"/);
});

test("Go net/http: path/filepath is imported only when actually used", () => {
  const fileRow = (extra) => ({
    type: "request",
    method: "POST",
    url: "https://x.test/upload",
    bodyType: "form-data",
    bodyFormRows: [
      {
        enabled: true,
        kind: "file",
        name: "doc",
        filePath: "/tmp/a.pdf",
        ...extra,
      },
    ],
  });
  // A supplied filename → no filepath.Base() → the import must be absent, or the
  // generated program would fail to compile ("imported and not used").
  const named = generateCode(
    "go",
    buildRequestModel(fileRow({ fileName: "a.pdf" }), CTX),
  );
  assert.doesNotMatch(named, /path\/filepath/);
  // No filename → filepath.Base(path) derives it → the import must be present.
  const unnamed = generateCode("go", buildRequestModel(fileRow({}), CTX));
  assert.match(unnamed, /"path\/filepath"/);
  assert.match(unnamed, /filepath\.Base\(/);
});

test("HTTPie: pipes a raw JSON body via stdin", () => {
  const code = generateCode("httpie", buildRequestModel(JSON_POST_NODE, CTX));
  assert.match(
    code,
    /^printf %s '\{"name":"Ada","active":true\}' \| http POST/,
  );
  assert.match(code, /'Content-Type:application\/json'/);
});

test("HTTPie: --form for an urlencoded body, dropping the form Content-Type arg", () => {
  const node = {
    type: "request",
    method: "POST",
    url: "https://x.test/form",
    bodyType: "form-urlencoded",
    bodyFormRows: [
      { enabled: true, name: "a", value: "1" },
      { enabled: true, name: "b", value: "two words" },
    ],
  };
  const code = generateCode("httpie", buildRequestModel(node, CTX));
  assert.match(code, /http --form POST 'https:\/\/x\.test\/form'/);
  assert.match(code, /'a=1'/);
  assert.match(code, /'b=two words'/);
  assert.doesNotMatch(code, /Content-Type/);
});

test("notes render as the target's line comment ahead of the snippet", () => {
  const model = buildRequestModel(
    {
      type: "request",
      method: "GET",
      url: "https://x.test",
      authType: "aws-iam",
    },
    CTX,
  );
  assert.match(generateCode("curl", model), /^# AWS Signature v4/);
  assert.match(generateCode("fetch", model), /^\/\/ AWS Signature v4/);
});

test("an unknown target id falls back to cURL", () => {
  const code = generateCode("nope", buildRequestModel(GET_NODE, CTX));
  assert.match(code, /^curl --request GET/);
});
