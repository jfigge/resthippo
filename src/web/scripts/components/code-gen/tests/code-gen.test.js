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
import { shellSingleQuote } from "../util.js";

// Empty resolver context — no env / folder variables. resolveString returns
// strings with no {{tokens}} unchanged, so request fields pass through verbatim.
const CTX = { collectionVariables: {}, folderChain: [] };

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

test("buildRequestModel: collection default headers merge before request headers", () => {
  const ctx = {
    collectionVariables: {},
    folderChain: [],
    collectionHeaders: [{ enabled: true, name: "X-Default", value: "d" }],
  };
  const m = buildRequestModel(
    {
      type: "request",
      method: "GET",
      url: "https://x.test",
      headers: [{ enabled: true, name: "X-Trace", value: "t" }],
    },
    ctx,
  );
  assert.deepEqual(m.headers, [
    { name: "X-Default", value: "d" },
    { name: "X-Trace", value: "t" },
  ]);
});

test("buildRequestModel: an enabled request header overrides a collection default (case-insensitive)", () => {
  const ctx = {
    collectionVariables: {},
    folderChain: [],
    collectionHeaders: [{ enabled: true, name: "content-type", value: "a" }],
  };
  const m = buildRequestModel(
    {
      type: "request",
      method: "GET",
      url: "https://x.test",
      headers: [{ enabled: true, name: "Content-Type", value: "b" }],
    },
    ctx,
  );
  const cts = m.headers.filter((h) => h.name.toLowerCase() === "content-type");
  assert.equal(cts.length, 1);
  assert.deepEqual(cts[0], { name: "Content-Type", value: "b" });
});

test("buildRequestModel: a disabled request header suppresses the collection default", () => {
  const ctx = {
    collectionVariables: {},
    folderChain: [],
    collectionHeaders: [{ enabled: true, name: "X-Default", value: "d" }],
  };
  const m = buildRequestModel(
    {
      type: "request",
      method: "GET",
      url: "https://x.test",
      headers: [{ enabled: false, name: "x-default", value: "" }],
    },
    ctx,
  );
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
  const ctx = { collectionVariables: { host: "example.org" }, folderChain: [] };
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

// ── Escaping / injection safety ──────────────────────────────────────────────
//
// A request carrying shell- or string-significant bytes (quotes, newlines,
// $(), backticks) in its headers/body/path must produce output where those
// bytes are inert — never a command injection or a broken literal. These tie
// each generator to its escaping helper so a regression in either surfaces.

// single + double quotes, command substitution and backticks in one value.
const EVIL = 'a\'b "c" $(whoami) `id`';

test("cURL: header values are shell-single-quoted, neutralising $()/backticks", () => {
  const node = {
    type: "request",
    method: "POST",
    url: "https://x.test/p",
    headers: [{ enabled: true, name: "X-Evil", value: EVIL }],
    bodyType: "json",
    bodyText: "{}",
  };
  const code = generateCode("curl", buildRequestModel(node, CTX));
  assert.ok(
    code.includes(`--header ${shellSingleQuote(`X-Evil: ${EVIL}`)}`),
    code,
  );
  // The single quote is broken out via '\'' — so $() and `` stay literal.
  assert.ok(code.includes("'\\''"), code);
});

test("cURL: raw body and a file-body path are shell-escaped", () => {
  const raw = generateCode(
    "curl",
    buildRequestModel(
      {
        type: "request",
        method: "POST",
        url: "https://x.test",
        bodyType: "json",
        bodyText: EVIL,
      },
      CTX,
    ),
  );
  assert.ok(raw.includes(`--data ${shellSingleQuote(EVIL)}`), raw);

  const filePath = "/tmp/o'brien.bin";
  const fileCode = generateCode(
    "curl",
    buildRequestModel(
      {
        type: "request",
        method: "POST",
        url: "https://x.test",
        bodyType: "file",
        bodyFilePath: filePath,
      },
      CTX,
    ),
  );
  // The `@` stays inside the quoted token; the embedded quote is escaped.
  assert.ok(
    fileCode.includes(`--data-binary ${shellSingleQuote(`@${filePath}`)}`),
    fileCode,
  );
});

test("HTTPie: header and raw body are shell-single-quoted", () => {
  const node = {
    type: "request",
    method: "POST",
    url: "https://x.test/p",
    headers: [{ enabled: true, name: "X-Evil", value: EVIL }],
    bodyType: "json",
    bodyText: EVIL,
  };
  const code = generateCode("httpie", buildRequestModel(node, CTX));
  assert.ok(code.includes(`printf %s ${shellSingleQuote(EVIL)}`), code);
  assert.ok(code.includes(shellSingleQuote(`X-Evil:${EVIL}`)), code);
});

test("fetch & Python: a body with quotes/newlines is JSON-string-escaped", () => {
  const bodyText = 'a"b\nc';
  const node = {
    type: "request",
    method: "POST",
    url: "https://x.test",
    bodyType: "json",
    bodyText,
  };
  const fetchCode = generateCode("fetch", buildRequestModel(node, CTX));
  const pyCode = generateCode("python", buildRequestModel(node, CTX));
  // No raw newline/quote break-out — both reuse JSON.stringify escaping.
  assert.ok(fetchCode.includes(`body: ${JSON.stringify(bodyText)}`), fetchCode);
  assert.ok(pyCode.includes(JSON.stringify(bodyText)), pyCode);
});

test("Go: a body containing a backtick can't use a raw string and is escaped", () => {
  // A newline alone would prefer a `…` raw literal; the backtick forbids it, so
  // it must fall back to a double-quoted (escaped) literal instead.
  const bodyText = "line1\n`cmd`\nline2";
  const node = {
    type: "request",
    method: "POST",
    url: "https://x.test",
    bodyType: "json",
    bodyText,
  };
  const code = generateCode("go", buildRequestModel(node, CTX));
  assert.ok(code.includes(JSON.stringify(bodyText)), code);
  assert.doesNotMatch(code, /NewReader\(`/);
});
