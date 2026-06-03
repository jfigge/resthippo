/**
 * import/tests/import.test.js
 *
 * Fixture-driven tests for the importers (Postman v2.1, Insomnia v4, OpenAPI 3 /
 * Swagger 2.0) and format detection, plus an import → export round-trip that
 * asserts the key request fields survive a Postman cycle.
 *
 * Fixtures are inline JSON objects (serialised through parseImport so the JSON
 * parse + detectFormat dispatch is exercised too) rather than separate files —
 * keeps each case readable next to its assertions and avoids a fixtures dir.
 *
 * Run with:   node --test import/tests/import.test.js
 */

"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseImport } from "../index.js";
import { parsePostman } from "../postman.js";
import { parseInsomnia } from "../insomnia.js";
import { parseOpenApi } from "../openapi.js";
import { exportToPostman } from "../../export/postman.js";

/** Find a request node by name anywhere in a wurl collection tree. */
function findRequest(node, name) {
  if (!node) return null;
  if (node.type === "request" && node.name === name) return node;
  for (const child of node.children ?? []) {
    const hit = findRequest(child, name);
    if (hit) return hit;
  }
  return null;
}

/** Find an exported Postman request item by name in the item tree. */
function findPostmanRequest(items, name) {
  for (const it of items ?? []) {
    if (it.name === name && it.request) return it;
    const nested = findPostmanRequest(it.item, name);
    if (nested) return nested;
  }
  return null;
}

const valueOf = (entries, key) => entries.find((e) => e.key === key);

// ── Postman import ───────────────────────────────────────────────────────────

const POSTMAN_FIXTURE = {
  info: {
    name: "Sample API",
    schema:
      "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
  },
  variable: [{ key: "baseUrl", value: "https://api.example.com" }],
  item: [
    {
      name: "Auth",
      item: [
        {
          name: "Login",
          request: {
            method: "post",
            url: "{{baseUrl}}/login?remember=true",
            header: [
              { key: "Accept", value: "application/json" },
              { key: "X-Debug", value: "1", disabled: true },
            ],
            body: {
              mode: "raw",
              raw: '{"user":"alice"}',
              options: { raw: { language: "json" } },
            },
            auth: {
              type: "basic",
              basic: [
                { key: "username", value: "alice" },
                { key: "password", value: "hunter2" },
              ],
            },
          },
        },
      ],
    },
  ],
};

test("postman: detects format and parses collection-level variables", () => {
  const { collection, variables } = parseImport(
    JSON.stringify(POSTMAN_FIXTURE),
  );
  assert.equal(collection.name, "Sample API");
  assert.equal(variables.baseUrl, "https://api.example.com");
});

test("postman: parses nested folder, request, method, body, and headers", () => {
  const { collection } = parsePostman(POSTMAN_FIXTURE);
  const folder = collection.children[0];
  assert.equal(folder.type, "collection");
  assert.equal(folder.name, "Auth");

  const login = findRequest(collection, "Login");
  assert.equal(login.method, "POST"); // uppercased
  assert.equal(login.bodyType, "json");
  assert.equal(login.bodyText, '{"user":"alice"}');

  // disabled header → enabled:false; string-form URL query → params
  assert.deepEqual(login.headers, [
    { enabled: true, name: "Accept", value: "application/json" },
    { enabled: false, name: "X-Debug", value: "1" },
  ]);
  assert.deepEqual(login.params, [
    { enabled: true, name: "remember", value: "true" },
  ]);
});

test("postman: maps basic auth into the wurl auth shape", () => {
  const login = findRequest(parsePostman(POSTMAN_FIXTURE).collection, "Login");
  assert.equal(login.authEnabled, true);
  assert.equal(login.authType, "basic");
  assert.deepEqual(login.authBasic, { username: "alice", password: "hunter2" });
});

// ── Insomnia import ──────────────────────────────────────────────────────────

const INSOMNIA_FIXTURE = {
  _type: "export",
  __export_format: 4,
  resources: [
    { _id: "wrk_1", _type: "workspace", name: "My Workspace" },
    {
      _id: "env_base",
      _type: "environment",
      parentId: "wrk_1",
      name: "Base Environment",
      data: { token: "abc", obj: { nested: 1 } },
    },
    { _id: "grp_1", _type: "request_group", parentId: "wrk_1", name: "Users" },
    {
      _id: "req_1",
      _type: "request",
      parentId: "grp_1",
      name: "Get User",
      method: "get",
      url: "https://api.example.com/users/1",
      headers: [{ name: "Accept", value: "application/json" }],
      authentication: { type: "bearer", token: "tok-123" },
    },
  ],
};

test("insomnia: detects format and extracts base-environment variables", () => {
  const { collection, variables } = parseImport(
    JSON.stringify(INSOMNIA_FIXTURE),
  );
  assert.equal(collection.name, "My Workspace");
  assert.equal(variables.token, "abc");
  // Non-string values are JSON-stringified so they stay recoverable.
  assert.equal(variables.obj, JSON.stringify({ nested: 1 }));
});

test("insomnia: builds folder → request hierarchy with auth", () => {
  const { collection } = parseInsomnia(INSOMNIA_FIXTURE);
  const folder = collection.children[0];
  assert.equal(folder.name, "Users");

  const req = findRequest(collection, "Get User");
  assert.equal(req.method, "GET");
  assert.equal(req.url, "https://api.example.com/users/1");
  assert.equal(req.authType, "bearer");
  assert.deepEqual(req.authBearer, { token: "tok-123" });
});

test("insomnia: a disabled auth block is treated as no-auth", () => {
  const data = structuredClone(INSOMNIA_FIXTURE);
  data.resources[3].authentication = {
    type: "bearer",
    token: "x",
    disabled: true,
  };
  const req = findRequest(parseInsomnia(data).collection, "Get User");
  assert.equal(req.authEnabled, false);
  assert.equal(req.authType, "none");
});

// ── OpenAPI / Swagger import ─────────────────────────────────────────────────

const OPENAPI_FIXTURE = {
  openapi: "3.0.1",
  info: { title: "Petstore" },
  servers: [
    {
      url: "https://api.example.com/{basePath}",
      variables: { basePath: { default: "v2" } },
    },
  ],
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer" },
    },
  },
  paths: {
    "/pets/{petId}": {
      get: {
        operationId: "getPet",
        tags: ["Pets"],
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "petId", in: "path" },
          { name: "verbose", in: "query" },
        ],
      },
    },
  },
};

test("openapi: detects format, resolves templated base URL and converts path params", () => {
  const { collection, variables } = parseImport(
    JSON.stringify(OPENAPI_FIXTURE),
  );
  assert.equal(collection.name, "Petstore");
  assert.equal(variables.baseUrl, "https://api.example.com/v2");

  const req = findRequest(collection, "getPet");
  // {petId} → {{petId}}, base server var substituted.
  assert.equal(req.url, "https://api.example.com/v2/pets/{{petId}}");
  assert.equal(req.method, "GET");
});

test("openapi: groups operations under their tag and maps bearer security", () => {
  const { collection } = parseOpenApi(OPENAPI_FIXTURE);
  const tagFolder = collection.children[0];
  assert.equal(tagFolder.type, "collection");
  assert.equal(tagFolder.name, "Pets");

  const req = findRequest(collection, "getPet");
  assert.equal(req.authType, "bearer");
  // query param surfaced; path param excluded from params.
  assert.deepEqual(req.params, [{ enabled: true, name: "verbose", value: "" }]);
});

test("swagger 2.0: detected and base URL built from host + basePath", () => {
  const swagger = {
    swagger: "2.0",
    info: { title: "Legacy API" },
    host: "api.legacy.test",
    basePath: "/v1",
    schemes: ["https"],
    paths: {
      "/ping": { get: { operationId: "ping" } },
    },
  };
  const { collection, variables } = parseImport(JSON.stringify(swagger));
  assert.equal(variables.baseUrl, "https://api.legacy.test/v1");
  const req = findRequest(collection, "ping");
  assert.equal(req.url, "https://api.legacy.test/v1/ping");
});

// ── Format detection failure ─────────────────────────────────────────────────

test("parseImport throws on an unrecognised format", () => {
  assert.throws(
    () => parseImport(JSON.stringify({ hello: "world" })),
    /Unrecognized format/,
  );
});

test("parseImport throws on content that is neither JSON nor YAML", () => {
  assert.throws(
    () => parseImport("{ this is : not valid"),
    /not valid JSON or YAML/,
  );
});

// ── Import → export round-trip (Postman) ─────────────────────────────────────

test("round-trip: key request fields survive Postman import → export", () => {
  const { collection, variables } = parsePostman(POSTMAN_FIXTURE);

  // Collection variables are an object on import; the exporter wants the
  // canonical { name, value, secure } array shape.
  const varList = Object.entries(variables).map(([name, value]) => ({
    name,
    value,
    secure: false,
  }));

  const exported = JSON.parse(exportToPostman(collection, varList));

  // Collection name and variable round-trip.
  assert.equal(exported.info.name, "Sample API");
  assert.equal(
    valueOf(exported.variable, "baseUrl").value,
    "https://api.example.com",
  );

  // The request survives with its method, body, and auth scheme intact.
  const login = findPostmanRequest(exported.item, "Login").request;
  assert.equal(login.method, "POST");
  assert.equal(login.body.mode, "raw");
  assert.equal(login.body.raw, '{"user":"alice"}');
  assert.equal(login.body.options.raw.language, "json");
  assert.equal(login.auth.type, "basic");
  // Username round-trips; password is redacted on export by design.
  assert.equal(valueOf(login.auth.basic, "username").value, "alice");
  assert.equal(valueOf(login.auth.basic, "password").value, "");
});
