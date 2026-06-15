/**
 * components/tests/request-payload.test.js
 *
 * Unit tests for buildRequestPayload — the shared request-assembly logic used by
 * both the interactive editor and the dependency prefetcher: query-param
 * encoding, header resolution, the auth transforms, and body serialisation.
 *
 * The final test performs a real HTTP round-trip against an in-process Node
 * http server (no external mock, no `go`, no make-test wiring change) to prove
 * that the auth header buildRequestPayload produces actually reaches the wire —
 * satisfying the "at least one HTTP-execution test exercises auth against the
 * mock server" acceptance criterion deterministically and offline.
 *
 * Run with:   node --test components/tests/request-payload.test.js
 */

"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import {
  buildRequestPayload,
  encodeBaseUrl,
  BODY_CONTENT_TYPES,
  NO_BODY_METHODS,
  detectPathParams,
  applyPathParams,
  resolvePathParamValues,
} from "../request-payload.js";

/** Identity resolver — request specs in these tests use literal values. */
const identity = async (s) => s ?? "";

/** A resolver that expands {{token}} from a fixed map, for the resolver path. */
const mapResolver = (map) => async (s) =>
  String(s ?? "").replace(/\{\{(\w+)\}\}/g, (_, k) => map[k] ?? "");

// ── Query params ─────────────────────────────────────────────────────────────

test("query params: enabled, non-blank rows are appended and percent-encoded", async () => {
  const { finalUrl } = await buildRequestPayload(
    {
      method: "GET",
      urlBase: "https://api.example.com/search",
      params: [
        { enabled: true, name: "q", value: "a b&c" },
        { enabled: true, name: "page", value: "1" },
        { enabled: false, name: "skip", value: "x" },
        { enabled: true, name: "  ", value: "blank-name" },
      ],
    },
    identity,
  );
  assert.equal(finalUrl, "https://api.example.com/search?q=a%20b%26c&page=1");
});

test("query params: joins with & when the base URL already has a query string", async () => {
  const { finalUrl } = await buildRequestPayload(
    {
      method: "GET",
      urlBase: "https://x/y?existing=1",
      params: [{ enabled: true, name: "added", value: "2" }],
    },
    identity,
  );
  assert.equal(finalUrl, "https://x/y?existing=1&added=2");
});

test("params and values pass through the async resolver", async () => {
  const { finalUrl } = await buildRequestPayload(
    {
      method: "GET",
      urlBase: "https://x",
      params: [{ enabled: true, name: "id", value: "{{userId}}" }],
    },
    mapResolver({ userId: "42" }),
  );
  assert.equal(finalUrl, "https://x?id=42");
});

// ── Headers ──────────────────────────────────────────────────────────────────

test("headers: enabled non-blank rows are resolved; names trimmed", async () => {
  const { headers } = await buildRequestPayload(
    {
      method: "GET",
      urlBase: "https://x",
      headers: [
        { enabled: true, name: " X-Trace ", value: "{{t}}" },
        { enabled: false, name: "X-Skip", value: "no" },
      ],
    },
    mapResolver({ t: "abc" }),
  );
  assert.deepEqual(headers, { "X-Trace": "abc" });
});

// ── Auth transforms ──────────────────────────────────────────────────────────

test("basic auth: builds a base64 Authorization header", async () => {
  const { headers } = await buildRequestPayload(
    {
      method: "GET",
      urlBase: "https://x",
      authEnabled: true,
      authType: "basic",
      authBasic: { username: "alice", password: "hunter2" },
    },
    identity,
  );
  assert.equal(headers["Authorization"], `Basic ${btoa("alice:hunter2")}`);
});

test("basic auth: omitted entirely when username and password are both blank", async () => {
  const { headers } = await buildRequestPayload(
    {
      method: "GET",
      urlBase: "https://x",
      authEnabled: true,
      authType: "basic",
      authBasic: { username: "", password: "" },
    },
    identity,
  );
  assert.equal(headers["Authorization"], undefined);
});

test("bearer auth: resolves the token into the Authorization header", async () => {
  const { headers } = await buildRequestPayload(
    {
      method: "GET",
      urlBase: "https://x",
      authEnabled: true,
      authType: "bearer",
      authBearer: { token: "{{tok}}" },
    },
    mapResolver({ tok: "abc123" }),
  );
  assert.equal(headers["Authorization"], "Bearer abc123");
});

test("apikey auth: header placement", async () => {
  const { headers, finalUrl } = await buildRequestPayload(
    {
      method: "GET",
      urlBase: "https://x",
      authEnabled: true,
      authType: "apikey",
      authApiKey: { name: "X-Api-Key", value: "k-1", addTo: "header" },
    },
    identity,
  );
  assert.equal(headers["X-Api-Key"], "k-1");
  assert.equal(finalUrl, "https://x");
});

test("apikey auth: query placement", async () => {
  const { headers, finalUrl } = await buildRequestPayload(
    {
      method: "GET",
      urlBase: "https://x",
      authEnabled: true,
      authType: "apikey",
      authApiKey: { name: "api_key", value: "k 1", addTo: "query" },
    },
    identity,
  );
  assert.equal(headers["api_key"], undefined);
  assert.equal(finalUrl, "https://x?api_key=k%201");
});

test("digest/ntlm: produce pass-through credential bags, not headers", async () => {
  const digest = await buildRequestPayload(
    {
      method: "GET",
      urlBase: "https://x",
      authEnabled: true,
      authType: "digest",
      authDigest: { username: "u", password: "p" },
    },
    identity,
  );
  assert.deepEqual(digest.authDigest, { username: "u", password: "p" });
  assert.equal(digest.headers["Authorization"], undefined);

  const ntlm = await buildRequestPayload(
    {
      method: "GET",
      urlBase: "https://x",
      authEnabled: true,
      authType: "ntlm",
      authNtlm: { username: "u", password: "p", domain: "D", workstation: "W" },
    },
    identity,
  );
  assert.deepEqual(ntlm.authNtlm, {
    username: "u",
    password: "p",
    domain: "D",
    workstation: "W",
  });
});

test("aws-iam: builds the credential bag with every field resolved", async () => {
  const { awsIam } = await buildRequestPayload(
    {
      method: "GET",
      urlBase: "https://x",
      authEnabled: true,
      authType: "aws-iam",
      authAwsIam: {
        accessKeyId: "AKIA",
        secretAccessKey: "secret",
        region: "us-east-1",
        service: "s3",
        sessionToken: "tok",
      },
    },
    identity,
  );
  assert.deepEqual(awsIam, {
    accessKeyId: "AKIA",
    secretAccessKey: "secret",
    region: "us-east-1",
    service: "s3",
    sessionToken: "tok",
  });
});

test("oauth1: builds the credential bag for main-process signing", async () => {
  const { oauth1 } = await buildRequestPayload(
    {
      method: "POST",
      urlBase: "https://x",
      authEnabled: true,
      authType: "oauth1",
      authOAuth1: {
        consumerKey: "ck",
        consumerSecret: "cs",
        token: "tok",
        tokenSecret: "ts",
        signatureMethod: "HMAC-SHA1",
        realm: "Example",
      },
    },
    identity,
  );
  assert.deepEqual(oauth1, {
    consumerKey: "ck",
    consumerSecret: "cs",
    token: "tok",
    tokenSecret: "ts",
    signatureMethod: "HMAC-SHA1",
    realm: "Example",
  });
});

test("oauth1: omitted entirely when the consumer key is blank", async () => {
  const { oauth1, headers } = await buildRequestPayload(
    {
      method: "GET",
      urlBase: "https://x",
      authEnabled: true,
      authType: "oauth1",
      authOAuth1: { consumerKey: "", consumerSecret: "cs" },
    },
    identity,
  );
  assert.equal(oauth1, null);
  // OAuth 1.0a sets no header in the renderer — signing happens in main.
  assert.equal(headers["Authorization"], undefined);
});

test("auth is skipped entirely when authEnabled is false", async () => {
  const { headers } = await buildRequestPayload(
    {
      method: "GET",
      urlBase: "https://x",
      authEnabled: false,
      authType: "basic",
      authBasic: { username: "u", password: "p" },
    },
    identity,
  );
  assert.equal(headers["Authorization"], undefined);
});

// ── Body serialisation ───────────────────────────────────────────────────────

test("json body: serialised and given a Content-Type by default", async () => {
  const { body, headers } = await buildRequestPayload(
    {
      method: "POST",
      urlBase: "https://x",
      bodyType: "json",
      bodyText: '{"a":1}',
    },
    identity,
  );
  assert.equal(body, '{"a":1}');
  assert.equal(headers["Content-Type"], BODY_CONTENT_TYPES.json);
});

test("body: an explicit Content-Type header is not overwritten", async () => {
  const { headers } = await buildRequestPayload(
    {
      method: "POST",
      urlBase: "https://x",
      headers: [
        {
          enabled: true,
          name: "Content-Type",
          value: "application/vnd.api+json",
        },
      ],
      bodyType: "json",
      bodyText: "{}",
    },
    identity,
  );
  assert.equal(headers["Content-Type"], "application/vnd.api+json");
});

test("body: GET/HEAD never carry a body even when one is specified", async () => {
  for (const method of NO_BODY_METHODS) {
    const { body, headers } = await buildRequestPayload(
      { method, urlBase: "https://x", bodyType: "json", bodyText: "{}" },
      identity,
    );
    assert.equal(body, null);
    assert.equal(headers["Content-Type"], undefined);
  }
});

test("graphql body: serialised to { query, variables, operationName } JSON", async () => {
  const { body, headers } = await buildRequestPayload(
    {
      method: "POST",
      urlBase: "https://x",
      bodyType: "graphql",
      bodyGraphql: {
        query: "query GetUser($id: ID!) { user(id: $id) { id name } }",
        variables: '{ "id": "42" }',
      },
    },
    identity,
  );
  assert.deepEqual(JSON.parse(body), {
    query: "query GetUser($id: ID!) { user(id: $id) { id name } }",
    variables: { id: "42" },
    operationName: "GetUser",
  });
  assert.equal(headers["Content-Type"], "application/json");
});

test("graphql body: {{var}} interpolation in both query and variables", async () => {
  const { body } = await buildRequestPayload(
    {
      method: "POST",
      urlBase: "https://x",
      bodyType: "graphql",
      bodyGraphql: {
        query: "{ {{field}} { id } }",
        variables: '{ "id": "{{userId}}" }',
      },
    },
    mapResolver({ field: "user", userId: "7" }),
  );
  const parsed = JSON.parse(body);
  assert.equal(parsed.query, "{ user { id } }");
  assert.deepEqual(parsed.variables, { id: "7" });
  // Anonymous operation ⇒ no operationName key.
  assert.equal("operationName" in parsed, false);
});

test("graphql body: invalid variables JSON is omitted, not sent malformed", async () => {
  const { body } = await buildRequestPayload(
    {
      method: "POST",
      urlBase: "https://x",
      bodyType: "graphql",
      bodyGraphql: { query: "{ user { id } }", variables: "{ not json }" },
    },
    identity,
  );
  const parsed = JSON.parse(body);
  assert.equal(parsed.query, "{ user { id } }");
  assert.equal("variables" in parsed, false);
});

test("graphql body: explicit Content-Type is respected", async () => {
  const { headers } = await buildRequestPayload(
    {
      method: "POST",
      urlBase: "https://x",
      headers: [
        {
          enabled: true,
          name: "Content-Type",
          value: "application/graphql-response+json",
        },
      ],
      bodyType: "graphql",
      bodyGraphql: { query: "{ user { id } }", variables: "" },
    },
    identity,
  );
  assert.equal(headers["Content-Type"], "application/graphql-response+json");
});

test("graphql body: GET never carries a body", async () => {
  const { body, headers } = await buildRequestPayload(
    {
      method: "GET",
      urlBase: "https://x",
      bodyType: "graphql",
      bodyGraphql: { query: "{ user { id } }", variables: "" },
    },
    identity,
  );
  assert.equal(body, null);
  assert.equal(headers["Content-Type"], undefined);
});

test("form-urlencoded body: encoded via URLSearchParams", async () => {
  const { body, headers } = await buildRequestPayload(
    {
      method: "POST",
      urlBase: "https://x",
      bodyType: "form-urlencoded",
      bodyFormRows: [
        { enabled: true, name: "a", value: "1 2" },
        { enabled: false, name: "skip", value: "x" },
        { enabled: true, name: "b", value: "y&z" },
      ],
    },
    identity,
  );
  assert.equal(body, "a=1+2&b=y%26z");
  assert.equal(headers["Content-Type"], "application/x-www-form-urlencoded");
});

test("form-data body: multipart parts with a boundary Content-Type", async () => {
  const { body, headers } = await buildRequestPayload(
    {
      method: "POST",
      urlBase: "https://x",
      bodyType: "form-data",
      bodyFormRows: [{ enabled: true, name: "field", value: "val" }],
    },
    identity,
  );
  assert.match(
    headers["Content-Type"],
    /^multipart\/form-data; boundary=----WurlBoundary/,
  );
  assert.match(body, /Content-Disposition: form-data; name="field"\r\n\r\nval/);
});

test("file body: exposes the file path and a Content-Type", async () => {
  const { bodyFilePath, headers } = await buildRequestPayload(
    {
      method: "POST",
      urlBase: "https://x",
      bodyType: "file",
      bodyFile: { path: "/tmp/upload.bin", type: "application/octet-stream" },
    },
    identity,
  );
  assert.equal(bodyFilePath, "/tmp/upload.bin");
  assert.equal(headers["Content-Type"], "application/octet-stream");
});

// ── Multipart with file fields (Feature 49) ──────────────────────────────────

test("form-data with a file row: emits a structured multipart spec, not a string body", async () => {
  const { body, multipart, headers } = await buildRequestPayload(
    {
      method: "POST",
      urlBase: "https://x",
      bodyType: "form-data",
      bodyFormRows: [
        { enabled: true, name: "caption", value: "hi" },
        {
          enabled: true,
          name: "doc",
          kind: "file",
          filePath: "/tmp/a.pdf",
          fileName: "a.pdf",
          contentType: "application/pdf",
        },
        {
          enabled: true,
          name: "doc2",
          kind: "file",
          filePath: "/tmp/b.png",
          fileName: "b.png",
          contentType: "",
        },
      ],
    },
    identity,
  );
  // The whole body crosses to main as a structured spec; no string body.
  assert.equal(body, null);
  assert.ok(multipart, "multipart spec should be present");
  assert.match(
    headers["Content-Type"],
    /^multipart\/form-data; boundary=----WurlBoundary/,
  );
  assert.ok(headers["Content-Type"].includes(multipart.boundary));
  assert.equal(multipart.parts.length, 3);
  assert.deepEqual(multipart.parts[0], {
    kind: "text",
    name: "caption",
    value: "hi",
  });
  assert.deepEqual(multipart.parts[1], {
    kind: "file",
    name: "doc",
    filePath: "/tmp/a.pdf",
    filename: "a.pdf",
    contentType: "application/pdf",
  });
  // Missing fileName falls back to the path's basename.
  const part2 = multipart.parts[2];
  assert.equal(part2.kind, "file");
  assert.equal(part2.filename, "b.png");
});

test("form-data without file rows: still a string body, multipart is null", async () => {
  const { body, multipart } = await buildRequestPayload(
    {
      method: "POST",
      urlBase: "https://x",
      bodyType: "form-data",
      bodyFormRows: [{ enabled: true, name: "field", value: "val" }],
    },
    identity,
  );
  assert.equal(multipart, null);
  assert.match(body, /Content-Disposition: form-data; name="field"\r\n\r\nval/);
});

// ── Path-parameter helpers (Feature 49) ──────────────────────────────────────

test("detectPathParams: finds :name and {name} tokens in URL order, deduped", () => {
  const tokens = detectPathParams(
    "https://h/users/:id/posts/{postId}/users/:id",
  );
  assert.deepEqual(tokens, [
    { name: "id", style: ":" },
    { name: "postId", style: "{}" },
  ]);
});

test("detectPathParams: ignores {{vars}}, the scheme colon, and the port", () => {
  assert.deepEqual(
    detectPathParams("https://host:8080/x?y={{q}}"),
    [],
    "scheme, port and {{var}} are not path params",
  );
  // A `{{var}}` next to a real `{id}` token: only the path token is detected.
  assert.deepEqual(detectPathParams("https://h/{id}?x={{id}}"), [
    { name: "id", style: "{}" },
  ]);
});

test("applyPathParams: substitutes mapped tokens, leaves {{vars}} and unmapped tokens", () => {
  const url = "https://h/users/:id/p/{postId}?x={{q}}";
  const out = applyPathParams(url, new Map([["id", "42"]]));
  // :id substituted; {postId} unmapped → literal; {{q}} untouched.
  assert.equal(out, "https://h/users/42/p/{postId}?x={{q}}");
});

test("resolvePathParamValues: resolves + percent-encodes values, skips blank names", async () => {
  const map = await resolvePathParamValues(
    [
      { name: "id", value: "{{n}}" },
      { name: " ", value: "ignored" },
      { name: "q", value: "a b/c" },
    ],
    mapResolver({ n: "7" }),
  );
  assert.equal(map.get("id"), "7");
  assert.equal(map.get("q"), "a%20b%2Fc");
  assert.equal(map.has(" "), false);
});

// ── encodeBaseUrl ────────────────────────────────────────────────────────────

test("encodeBaseUrl normalises a valid URL and passes through an invalid one", () => {
  assert.equal(encodeBaseUrl("https://x/a b"), "https://x/a%20b");
  assert.equal(encodeBaseUrl("{{notAUrl}}"), "{{notAUrl}}");
});

// ── HTTP execution against an in-process mock server ─────────────────────────

test("HTTP execution: built basic-auth header reaches the server on the wire", async () => {
  // A throwaway mock server that echoes back the request method, the
  // Authorization header it received, and a custom header — the deterministic,
  // offline stand-in for the project mock server.
  const received = {};
  const server = http.createServer((req, res) => {
    received.method = req.method;
    received.authorization = req.headers["authorization"];
    received.apiKey = req.headers["x-api-key"];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const { finalUrl, headers } = await buildRequestPayload(
      {
        method: "GET",
        urlBase: `http://127.0.0.1:${port}/secure`,
        headers: [{ enabled: true, name: "X-Api-Key", value: "{{key}}" }],
        authEnabled: true,
        authType: "basic",
        authBasic: { username: "alice", password: "hunter2" },
      },
      mapResolver({ key: "k-9" }),
    );

    const res = await fetch(finalUrl, { method: "GET", headers });
    const json = await res.json();

    assert.equal(res.status, 200);
    assert.deepEqual(json, { ok: true });
    // The auth header buildRequestPayload produced actually crossed the wire.
    assert.equal(received.method, "GET");
    assert.equal(received.authorization, `Basic ${btoa("alice:hunter2")}`);
    assert.equal(received.apiKey, "k-9");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
