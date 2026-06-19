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

import {
  parseImport,
  parseCurl,
  collectFormFilePaths,
  warnMissingFormFiles,
} from "../index.js";
import { parsePostman } from "../postman.js";
import { parseInsomnia, parseInsomniaV5 } from "../insomnia.js";
import { parseOpenApi } from "../openapi.js";
import { parseHar } from "../har.js";
import { tokenizeCurl } from "../curl.js";
import {
  buildAuth,
  graphqlBody,
  normalizeGraphqlVariables,
  formBody,
  authFromHeaderValue,
  splitUrlQuery,
} from "../shape.js";
import { exportToPostman } from "../../export/postman.js";
import { exportToInsomnia } from "../../export/insomnia.js";

/** Find a request node by name anywhere in a Rest Hippo collection tree. */
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

/** Find a canonical { name, value, secure } variable entry by name. */
const varOf = (list, name) => list.find((v) => v.name === name);

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
  // Variables are returned in the canonical { name, value, secure } array shape.
  assert.deepEqual(variables, [
    { name: "baseUrl", value: "https://api.example.com", secure: false },
  ]);
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

test("postman: maps basic auth into the Rest Hippo auth shape", () => {
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
  assert.equal(varOf(variables, "token").value, "abc");
  // Non-string values are JSON-stringified so they stay recoverable.
  assert.equal(varOf(variables, "obj").value, JSON.stringify({ nested: 1 }));
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

// ── Insomnia v5 import ────────────────────────────────────────────────────────

const INSOMNIA_V5_FIXTURE = {
  type: "collection.insomnia.rest/5.0",
  name: "My Workspace",
  meta: { id: "wrk_abc123" },
  collection: [
    {
      name: "Users",
      meta: { id: "fld_abc123", sortKey: -500 },
      children: [
        {
          name: "Get User",
          url: "https://api.example.com/users/1",
          method: "get",
          meta: { id: "req_abc123", description: "" },
          headers: [
            { name: "Accept", value: "application/json", disabled: false },
          ],
          parameters: [],
          body: {},
          authentication: { type: "bearer", token: "tok-123", disabled: false },
        },
      ],
    },
  ],
  environments: {
    name: "Base Environment",
    meta: { id: "env_abc123" },
    data: { token: "abc", obj: { nested: 1 } },
  },
};

test("insomnia-v5: detects format and extracts base-environment variables", () => {
  const { collection, variables } = parseImport(
    JSON.stringify(INSOMNIA_V5_FIXTURE),
  );
  assert.equal(collection.name, "My Workspace");
  assert.equal(varOf(variables, "token").value, "abc");
  // Non-string values are JSON-stringified so they stay recoverable.
  assert.equal(varOf(variables, "obj").value, JSON.stringify({ nested: 1 }));
});

test("insomnia-v5: builds folder → request hierarchy with auth", () => {
  const { collection } = parseInsomniaV5(INSOMNIA_V5_FIXTURE);
  const folder = collection.children[0];
  assert.equal(folder.name, "Users");

  const req = findRequest(collection, "Get User");
  assert.equal(req.method, "GET");
  assert.equal(req.url, "https://api.example.com/users/1");
  assert.equal(req.authType, "bearer");
  assert.deepEqual(req.authBearer, { token: "tok-123" });
});

test("insomnia-v5: a disabled auth block is treated as no-auth", () => {
  const data = structuredClone(INSOMNIA_V5_FIXTURE);
  data.collection[0].children[0].authentication = {
    type: "bearer",
    token: "x",
    disabled: true,
  };
  const req = findRequest(parseInsomniaV5(data).collection, "Get User");
  assert.equal(req.authEnabled, false);
  assert.equal(req.authType, "none");
});

test("insomnia-v5: dropped sub-environments are reported via warnings", () => {
  const data = structuredClone(INSOMNIA_V5_FIXTURE);
  data.environments.subEnvironments = [
    { name: "Production", meta: { id: "env_prod" }, data: { token: "prod" } },
    { name: "Staging", meta: { id: "env_stg" }, data: { token: "stg" } },
  ];
  const { variables, warnings } = parseInsomniaV5(data);

  // Base environment variables still import unchanged.
  assert.equal(varOf(variables, "token").value, "abc");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Skipped 2 additional Insomnia environments/);
});

test("insomnia-v5: non-HTTP items (no method, no children) are skipped", () => {
  const data = structuredClone(INSOMNIA_V5_FIXTURE);
  // A WebSocket entry has a url but no method and no children array.
  data.collection.push({
    name: "WS Echo",
    url: "ws://localhost/ws",
    meta: { id: "ws-req_abc" },
  });
  const { collection } = parseInsomniaV5(data);
  // Only the folder survives; the WebSocket entry is skipped.
  assert.equal(collection.children.length, 1);
  assert.equal(collection.children[0].type, "collection");
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
  assert.equal(varOf(variables, "baseUrl").value, "https://api.example.com/v2");

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
  assert.equal(varOf(variables, "baseUrl").value, "https://api.legacy.test/v1");
  const req = findRequest(collection, "ping");
  assert.equal(req.url, "https://api.legacy.test/v1/ping");
});

// ── OpenAPI $ref resolution + example bodies ─────────────────────────────────

const OPENAPI_REFS_FIXTURE = {
  openapi: "3.0.1",
  info: { title: "Refs API" },
  servers: [{ url: "https://api.example.com" }],
  components: {
    parameters: {
      ApiVersion: {
        name: "X-Api-Version",
        in: "header",
        schema: { type: "string", enum: ["2024-01", "2024-02"] },
      },
      PageSize: {
        name: "pageSize",
        in: "query",
        schema: { type: "integer", default: 20 },
      },
    },
    schemas: {
      Tag: {
        type: "object",
        properties: { id: { type: "integer" }, label: { type: "string" } },
      },
      Pet: {
        type: "object",
        required: ["name"],
        properties: {
          id: { type: "integer" },
          name: { type: "string" },
          status: { type: "string", enum: ["available", "pending", "sold"] },
          tags: { type: "array", items: { $ref: "#/components/schemas/Tag" } },
        },
      },
      // Self-referential schema — must terminate, not loop forever.
      Node: {
        type: "object",
        properties: {
          value: { type: "string" },
          next: { $ref: "#/components/schemas/Node" },
        },
      },
    },
    requestBodies: {
      PetBody: {
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/Pet" } },
        },
      },
    },
  },
  paths: {
    "/pets": {
      post: {
        operationId: "createPet",
        parameters: [
          { $ref: "#/components/parameters/ApiVersion" },
          { $ref: "#/components/parameters/PageSize" },
        ],
        requestBody: { $ref: "#/components/requestBodies/PetBody" },
      },
    },
    "/vendor": {
      post: {
        operationId: "vendorPost",
        requestBody: {
          content: {
            "application/vnd.api+json": {
              schema: {
                type: "object",
                properties: { ok: { type: "boolean" } },
              },
            },
          },
        },
      },
    },
    "/nodes": {
      post: {
        operationId: "createNode",
        requestBody: {
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Node" },
            },
          },
        },
      },
    },
  },
};

test("openapi: merges $ref'd parameters and pre-fills enum/default hints", () => {
  const { collection } = parseOpenApi(OPENAPI_REFS_FIXTURE);
  const req = findRequest(collection, "createPet");

  // $ref'd header parameter is resolved (not dropped) and pre-filled from enum.
  assert.deepEqual(req.headers, [
    { enabled: true, name: "X-Api-Version", value: "2024-01" },
  ]);
  // $ref'd query parameter resolved and pre-filled from its schema default.
  assert.deepEqual(req.params, [
    { enabled: true, name: "pageSize", value: "20" },
  ]);
});

test("openapi: resolves $ref'd requestBody and synthesizes a schema example", () => {
  const { collection } = parseOpenApi(OPENAPI_REFS_FIXTURE);
  const req = findRequest(collection, "createPet");

  assert.equal(req.bodyType, "json");
  const body = JSON.parse(req.bodyText);
  assert.deepEqual(body, {
    id: 0,
    name: "string",
    status: "available", // first enum value
    tags: [{ id: 0, label: "string" }], // nested $ref through array items
  });
  // Plain application/json stays implicit — no redundant Content-Type header.
  assert.equal(
    req.headers.find((h) => h.name === "Content-Type"),
    undefined,
  );
});

test("openapi: non-default body mime is surfaced as an explicit Content-Type", () => {
  const { collection } = parseOpenApi(OPENAPI_REFS_FIXTURE);
  const req = findRequest(collection, "vendorPost");
  assert.equal(req.bodyType, "json");
  assert.deepEqual(JSON.parse(req.bodyText), { ok: false });
  assert.deepEqual(req.headers, [
    { enabled: true, name: "Content-Type", value: "application/vnd.api+json" },
  ]);
});

test("openapi: a recursive schema example terminates", () => {
  const { collection } = parseOpenApi(OPENAPI_REFS_FIXTURE);
  const req = findRequest(collection, "createNode");
  // The cycle is broken after one level: `next` resolves to null.
  assert.deepEqual(JSON.parse(req.bodyText), { value: "string", next: null });
});

test("openapi: remote $refs are reported as warnings, not silently dropped", () => {
  const spec = {
    openapi: "3.0.1",
    info: { title: "Remote" },
    paths: {
      "/x": {
        get: {
          operationId: "getX",
          parameters: [{ $ref: "external.yaml#/components/parameters/Foo" }],
        },
      },
    },
  };
  const { warnings } = parseOpenApi(spec);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /remote \$ref/i);
  assert.match(warnings[0], /external\.yaml/);
});

test("swagger 2.0: resolves $ref'd params and definition-backed body example", () => {
  const swagger = {
    swagger: "2.0",
    info: { title: "Legacy Refs" },
    host: "api.legacy.test",
    basePath: "/v1",
    schemes: ["https"],
    parameters: {
      AuthHeader: {
        name: "X-Token",
        in: "header",
        type: "string",
        default: "abc",
      },
    },
    definitions: {
      User: {
        type: "object",
        properties: {
          id: { type: "integer" },
          email: { type: "string", format: "email" },
        },
      },
    },
    paths: {
      "/users": {
        post: {
          operationId: "createUser",
          parameters: [
            { $ref: "#/parameters/AuthHeader" },
            {
              in: "body",
              name: "body",
              schema: { $ref: "#/definitions/User" },
            },
          ],
        },
      },
    },
  };
  const { collection } = parseOpenApi(swagger);
  const req = findRequest(collection, "createUser");
  assert.deepEqual(req.headers, [
    { enabled: true, name: "X-Token", value: "abc" },
  ]);
  assert.equal(req.bodyType, "json");
  assert.deepEqual(JSON.parse(req.bodyText), {
    id: 0,
    email: "user@example.com",
  });
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

  // Importers and exporters now agree on the canonical { name, value, secure }
  // array shape, so the variables pass straight through with no conversion.
  const exported = JSON.parse(exportToPostman(collection, variables));

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

test("round-trip: a Postman secret variable preserves its secure flag", () => {
  const data = {
    info: {
      name: "Secrets",
      schema:
        "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    variable: [
      { key: "apiKey", value: "s3cr3t", type: "secret" },
      { key: "host", value: "https://api.example.com" },
    ],
    item: [],
  };

  // Import maps Postman's type:"secret" onto the canonical secure flag.
  const { collection, variables } = parsePostman(data);
  assert.equal(varOf(variables, "apiKey").secure, true);
  assert.equal(varOf(variables, "host").secure, false);

  // Export re-emits it as type:"secret" with the value redacted, so the secure
  // flag survives a full import → export round-trip.
  const exported = JSON.parse(exportToPostman(collection, variables));
  const apiKey = valueOf(exported.variable, "apiKey");
  assert.equal(apiKey.type, "secret");
  assert.equal(apiKey.value, "");
  assert.equal(valueOf(exported.variable, "host").type, undefined);
});

// ── Import → export round-trip (Insomnia v4) ─────────────────────────────────

test("round-trip: Rest Hippo → Insomnia v4 export → import preserves structure", () => {
  const collection = {
    id: "c1",
    type: "collection",
    name: "Sample API",
    variables: [],
    children: [
      {
        type: "collection",
        name: "Auth",
        variables: [],
        children: [
          {
            type: "request",
            name: "Login",
            method: "POST",
            url: "https://api.example.com/login",
            headers: [{ enabled: true, name: "X-Trace", value: "1" }],
            params: [{ enabled: true, name: "verbose", value: "true" }],
            notes: "Logs a user in",
            bodyType: "json",
            bodyText: '{"user":"alice"}',
            authEnabled: true,
            authType: "basic",
            authBasic: { username: "alice", password: "hunter2" },
          },
        ],
      },
    ],
  };

  const insomniaJson = exportToInsomnia(collection, [
    { name: "baseUrl", value: "https://api.example.com", secure: false },
  ]);
  const { collection: reimported, variables } = parseInsomnia(
    JSON.parse(insomniaJson),
  );

  // Workspace name → collection name; base-environment variable round-trips.
  assert.equal(reimported.name, "Sample API");
  assert.equal(varOf(variables, "baseUrl").value, "https://api.example.com");

  // The nested folder + request survive with their fields intact.
  const login = findRequest(reimported, "Login");
  assert.ok(login, "Login request missing after round-trip");
  assert.equal(login.method, "POST");
  assert.equal(login.url, "https://api.example.com/login");
  assert.equal(login.bodyType, "json");
  assert.equal(login.bodyText, '{"user":"alice"}');
  assert.equal(login.authType, "basic");
  // Username round-trips; password is redacted on export by design.
  assert.equal(login.authBasic.username, "alice");
  assert.equal(login.authBasic.password, "");
  assert.ok(login.headers.some((h) => h.name === "X-Trace" && h.value === "1"));
  assert.ok(
    login.params.some((p) => p.name === "verbose" && p.value === "true"),
  );
});

// ── Round-trip: every auth scheme survives Postman & Insomnia cycles ──────────

/** A single-request collection carrying the given canonical auth fields. */
function collectionWithAuth(authFields) {
  return {
    id: "c1",
    type: "collection",
    name: "Auth RT",
    variables: [],
    children: [
      {
        type: "request",
        name: "Req",
        method: "GET",
        url: "https://api.example.com/x",
        headers: [],
        params: [],
        bodyType: "no-body",
        authEnabled: true,
        ...authFields,
      },
    ],
  };
}

// One case per non-trivial scheme. `check` asserts the identifiers survive and
// the secrets come back blank (redacted on export by design). basic/bearer/oauth2
// are already covered by the dedicated round-trip tests above.
const AUTH_SCHEME_CASES = [
  {
    name: "apikey",
    fields: {
      authType: "apikey",
      authApiKey: { name: "X-API-Key", value: "s3cr3t", addTo: "query" },
    },
    check: (a) => {
      assert.equal(a.authType, "apikey");
      assert.equal(a.authApiKey.name, "X-API-Key");
      assert.equal(a.authApiKey.addTo, "query");
      assert.equal(a.authApiKey.value, "");
    },
  },
  {
    name: "digest",
    fields: {
      authType: "digest",
      authDigest: { username: "alice", password: "hunter2" },
    },
    check: (a) => {
      assert.equal(a.authType, "digest");
      assert.equal(a.authDigest.username, "alice");
      assert.equal(a.authDigest.password, "");
    },
  },
  {
    name: "ntlm",
    fields: {
      authType: "ntlm",
      authNtlm: {
        username: "alice",
        password: "p",
        domain: "CORP",
        workstation: "WS1",
      },
    },
    check: (a) => {
      assert.equal(a.authType, "ntlm");
      assert.equal(a.authNtlm.username, "alice");
      assert.equal(a.authNtlm.domain, "CORP");
      assert.equal(a.authNtlm.workstation, "WS1");
      assert.equal(a.authNtlm.password, "");
    },
  },
  {
    name: "aws-iam",
    fields: {
      authType: "aws-iam",
      authAwsIam: {
        accessKeyId: "AKID",
        secretAccessKey: "SK",
        region: "us-east-1",
        service: "s3",
        sessionToken: "ST",
      },
    },
    check: (a) => {
      assert.equal(a.authType, "aws-iam");
      assert.equal(a.authAwsIam.accessKeyId, "AKID");
      assert.equal(a.authAwsIam.region, "us-east-1");
      assert.equal(a.authAwsIam.service, "s3");
      assert.equal(a.authAwsIam.secretAccessKey, "");
      assert.equal(a.authAwsIam.sessionToken, "");
    },
  },
  {
    name: "oauth1",
    fields: {
      authType: "oauth1",
      authOAuth1: {
        consumerKey: "ck",
        consumerSecret: "cs",
        token: "tk",
        tokenSecret: "ts",
        signatureMethod: "HMAC-SHA256",
        realm: "r",
      },
    },
    check: (a) => {
      assert.equal(a.authType, "oauth1");
      assert.equal(a.authOAuth1.consumerKey, "ck");
      assert.equal(a.authOAuth1.signatureMethod, "HMAC-SHA256");
      assert.equal(a.authOAuth1.realm, "r");
      assert.equal(a.authOAuth1.consumerSecret, "");
      assert.equal(a.authOAuth1.token, "");
      assert.equal(a.authOAuth1.tokenSecret, "");
    },
  },
];

test("round-trip: every auth scheme survives a Postman cycle (secrets redacted)", () => {
  for (const c of AUTH_SCHEME_CASES) {
    const exported = exportToPostman(collectionWithAuth(c.fields), []);
    const req = findRequest(
      parsePostman(JSON.parse(exported)).collection,
      "Req",
    );
    assert.ok(req, `${c.name}: request missing after round-trip`);
    assert.equal(req.authEnabled, true, `${c.name}: authEnabled lost`);
    c.check(req);
  }
});

test("round-trip: every auth scheme survives an Insomnia cycle (secrets redacted)", () => {
  for (const c of AUTH_SCHEME_CASES) {
    const exported = exportToInsomnia(collectionWithAuth(c.fields), []);
    const req = findRequest(
      parseInsomnia(JSON.parse(exported)).collection,
      "Req",
    );
    assert.ok(req, `${c.name}: request missing after round-trip`);
    assert.equal(req.authEnabled, true, `${c.name}: authEnabled lost`);
    c.check(req);
  }
});

// ── Round-trip: GraphQL body (Feature 34) ────────────────────────────────────

test("round-trip: GraphQL body survives a Rest Hippo → Postman → Rest Hippo cycle", () => {
  const query = "query GetUser($id: ID!) { user(id: $id) { id name } }";
  const collection = {
    id: "c1",
    type: "collection",
    name: "GraphQL API",
    variables: [],
    children: [
      {
        type: "request",
        name: "GetUser",
        method: "POST",
        url: "https://api.example.com/graphql",
        params: [],
        headers: [],
        bodyType: "graphql",
        bodyGraphql: { query, variables: '{ "id": "42" }' },
      },
    ],
  };

  const postmanJson = exportToPostman(collection, []);
  const exported = findPostmanRequest(
    JSON.parse(postmanJson).item,
    "GetUser",
  ).request;
  assert.equal(exported.body.mode, "graphql");
  assert.equal(exported.body.graphql.query, query);
  assert.equal(exported.body.graphql.variables, '{ "id": "42" }');

  const { collection: reimported } = parsePostman(JSON.parse(postmanJson));
  const req = findRequest(reimported, "GetUser");
  assert.equal(req.bodyType, "graphql");
  assert.equal(req.bodyGraphql.query, query);
  // Postman keeps the variables string verbatim ⇒ exact round-trip.
  assert.equal(req.bodyGraphql.variables, '{ "id": "42" }');
});

test("round-trip: GraphQL body survives a Rest Hippo → Insomnia → Rest Hippo cycle", () => {
  const query = "query GetUser($id: ID!) { user(id: $id) { id name } }";
  const collection = {
    id: "c1",
    type: "collection",
    name: "GraphQL API",
    variables: [],
    children: [
      {
        type: "request",
        name: "GetUser",
        method: "POST",
        url: "https://api.example.com/graphql",
        params: [],
        headers: [],
        bodyType: "graphql",
        bodyGraphql: { query, variables: '{ "id": "42" }' },
      },
    ],
  };

  const insomniaJson = exportToInsomnia(collection, []);
  const { collection: reimported } = parseInsomnia(JSON.parse(insomniaJson));
  const req = findRequest(reimported, "GetUser");
  assert.equal(req.bodyType, "graphql");
  assert.equal(req.bodyGraphql.query, query);
  // Insomnia stores variables as an object ⇒ compare parsed (formatting differs).
  assert.deepEqual(JSON.parse(req.bodyGraphql.variables), { id: "42" });
});

// ── Round-trip (Postman): multipart file fields + path variables (Feature 49) ─

test("round-trip: form-data file field + path variables survive a Postman cycle", () => {
  const collection = {
    id: "c1",
    type: "collection",
    name: "Files API",
    variables: [],
    children: [
      {
        type: "request",
        name: "Upload",
        method: "POST",
        url: "https://api.example.com/users/:id/files",
        params: [],
        pathParams: [{ id: "p1", name: "id", value: "42" }],
        headers: [],
        bodyType: "form-data",
        bodyFormRows: [
          { enabled: true, name: "caption", value: "hello" },
          {
            enabled: true,
            name: "doc",
            kind: "file",
            filePath: "/tmp/a.pdf",
            fileName: "a.pdf",
            contentType: "application/pdf",
          },
        ],
      },
    ],
  };

  const { collection: reimported } = parsePostman(
    JSON.parse(exportToPostman(collection, [])),
  );
  const upload = findRequest(reimported, "Upload");
  assert.ok(upload, "Upload request missing after round-trip");

  // The path variable and its value survive via Postman's url.variable.
  assert.deepEqual(
    upload.pathParams.map((p) => ({ name: p.name, value: p.value })),
    [{ name: "id", value: "42" }],
  );

  // The multipart body keeps both the text field and the file field.
  assert.equal(upload.bodyType, "form-data");
  const text = upload.bodyFormRows.find((r) => r.name === "caption");
  const file = upload.bodyFormRows.find((r) => r.name === "doc");
  assert.equal(text.value, "hello");
  assert.equal(file.kind, "file");
  assert.equal(file.filePath, "/tmp/a.pdf");
  assert.equal(file.contentType, "application/pdf");
});

// ── Shared canonical-shape builders (import/shape.js) ─────────────────────────

test("shape.buildAuth: neutral descriptor → canonical Rest Hippo auth fields", () => {
  // null / unknown → no-auth; this is what every importer maps an absent or
  // unsupported scheme to.
  assert.deepEqual(buildAuth(null), { authEnabled: false, authType: "none" });
  assert.deepEqual(buildAuth({ type: "saml" }), {
    authEnabled: false,
    authType: "none",
  });

  assert.deepEqual(buildAuth({ type: "basic", username: "u", password: "p" }), {
    authEnabled: true,
    authType: "basic",
    authBasic: { username: "u", password: "p" },
  });
  assert.deepEqual(buildAuth({ type: "bearer", token: "t" }), {
    authEnabled: true,
    authType: "bearer",
    authBearer: { token: "t" },
  });

  assert.deepEqual(
    buildAuth({ type: "apikey", name: "X-Key", value: "v", addTo: "query" }),
    {
      authEnabled: true,
      authType: "apikey",
      authApiKey: { name: "X-Key", value: "v", addTo: "query" },
    },
  );
  // apikey addTo normalizes anything but "query" to "header".
  assert.equal(
    buildAuth({ type: "apikey", addTo: "weird" }).authApiKey.addTo,
    "header",
  );

  assert.deepEqual(
    buildAuth({ type: "digest", username: "u", password: "p" }),
    {
      authEnabled: true,
      authType: "digest",
      authDigest: { username: "u", password: "p" },
    },
  );

  assert.deepEqual(
    buildAuth({
      type: "ntlm",
      username: "u",
      password: "p",
      domain: "CORP",
      workstation: "WS1",
    }),
    {
      authEnabled: true,
      authType: "ntlm",
      authNtlm: {
        username: "u",
        password: "p",
        domain: "CORP",
        workstation: "WS1",
      },
    },
  );

  assert.deepEqual(
    buildAuth({
      type: "aws-iam",
      accessKeyId: "AK",
      secretAccessKey: "SK",
      region: "us-east-1",
      service: "s3",
      sessionToken: "ST",
    }),
    {
      authEnabled: true,
      authType: "aws-iam",
      authAwsIam: {
        accessKeyId: "AK",
        secretAccessKey: "SK",
        region: "us-east-1",
        service: "s3",
        sessionToken: "ST",
      },
    },
  );

  assert.deepEqual(
    buildAuth({
      type: "oauth1",
      consumerKey: "ck",
      consumerSecret: "cs",
      token: "tk",
      tokenSecret: "ts",
      signatureMethod: "HMAC-SHA256",
      realm: "r",
    }),
    {
      authEnabled: true,
      authType: "oauth1",
      authOAuth1: {
        consumerKey: "ck",
        consumerSecret: "cs",
        token: "tk",
        tokenSecret: "ts",
        signatureMethod: "HMAC-SHA256",
        realm: "r",
      },
    },
  );
  // An unsupported oauth1 signature method falls back to HMAC-SHA1.
  assert.equal(
    buildAuth({ type: "oauth1", signatureMethod: "RSA-SHA1" }).authOAuth1
      .signatureMethod,
    "HMAC-SHA1",
  );

  // oauth2 fills Rest Hippo defaults for omitted fields (notably grantType).
  assert.deepEqual(buildAuth({ type: "oauth2", clientId: "cid" }), {
    authEnabled: true,
    authType: "oauth2",
    authOAuth2: {
      grantType: "authorization_code",
      clientId: "cid",
      clientSecret: "",
      accessTokenUrl: "",
      authUrl: "",
      scope: "",
    },
  });
});

test("shape.normalizeGraphqlVariables: string passes through, object stringifies, null → ''", () => {
  assert.equal(normalizeGraphqlVariables('{"id":1}'), '{"id":1}');
  assert.equal(normalizeGraphqlVariables(null), "");
  assert.equal(normalizeGraphqlVariables(undefined), "");
  assert.equal(
    normalizeGraphqlVariables({ id: 1 }),
    JSON.stringify({ id: 1 }, null, 2),
  );
});

test("shape.graphqlBody: builds the canonical graphql body with normalized variables", () => {
  assert.deepEqual(graphqlBody("query { x }", { id: 1 }), {
    bodyType: "graphql",
    bodyGraphql: {
      query: "query { x }",
      variables: JSON.stringify({ id: 1 }, null, 2),
    },
  });
  // Missing query/variables default to empty strings.
  assert.deepEqual(graphqlBody(), {
    bodyType: "graphql",
    bodyGraphql: { query: "", variables: "" },
  });
});

test("shape.formBody: owns the file/text row shape and derives fileName from path", () => {
  const out = formBody("form-data", [
    { enabled: true, name: "caption", value: "hi" },
    {
      enabled: false,
      name: "doc",
      file: { path: "/a/b/c.pdf", contentType: "application/pdf" },
    },
    { enabled: true, name: "bare", file: { path: "" } }, // no contentType → ""
  ]);
  assert.equal(out.bodyType, "form-data");
  assert.deepEqual(out.bodyFormRows, [
    { enabled: true, name: "caption", value: "hi" },
    {
      enabled: false,
      name: "doc",
      value: "",
      kind: "file",
      filePath: "/a/b/c.pdf",
      fileName: "c.pdf",
      contentType: "application/pdf",
    },
    {
      enabled: true,
      name: "bare",
      value: "",
      kind: "file",
      filePath: "",
      fileName: "",
      contentType: "",
    },
  ]);
});

// ── Uniform return shape + warnings channel ──────────────────────────────────

test("all importers return a warnings array (empty for clean input)", () => {
  assert.deepEqual(parsePostman(POSTMAN_FIXTURE).warnings, []);
  assert.deepEqual(parseInsomnia(INSOMNIA_FIXTURE).warnings, []);
  assert.deepEqual(parseInsomniaV5(INSOMNIA_V5_FIXTURE).warnings, []);
  assert.deepEqual(parseOpenApi(OPENAPI_FIXTURE).warnings, []);
});

test("postman: a multi-file form-data field is imported lossily and warned about", () => {
  const data = {
    info: {
      name: "Files",
      schema:
        "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    item: [
      {
        name: "Upload",
        request: {
          method: "POST",
          url: "https://api.example.com/upload",
          body: {
            mode: "formdata",
            formdata: [
              { key: "docs", type: "file", src: ["/tmp/a.pdf", "/tmp/b.pdf"] },
            ],
          },
        },
      },
    ],
  };
  const { collection, warnings } = parsePostman(data);

  // Only the first file survives (Rest Hippo is one file per field) …
  const upload = findRequest(collection, "Upload");
  const file = upload.bodyFormRows.find((r) => r.name === "docs");
  assert.equal(file.filePath, "/tmp/a.pdf");

  // … and that loss is surfaced, not silent.
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /docs/);
  assert.match(warnings[0], /only the first/i);

  // A single-file field does not warn.
  data.item[0].request.body.formdata[0].src = "/tmp/only.pdf";
  assert.deepEqual(parsePostman(data).warnings, []);
});

test("insomnia: dropped sub-environments are reported via warnings", () => {
  const data = structuredClone(INSOMNIA_FIXTURE);
  // Add two extra environments beyond the base; Rest Hippo imports only the base.
  data.resources.push(
    {
      _id: "env_prod",
      _type: "environment",
      parentId: "env_base",
      name: "Production",
      data: { token: "prod" },
    },
    {
      _id: "env_stg",
      _type: "environment",
      parentId: "env_base",
      name: "Staging",
      data: { token: "stg" },
    },
  );
  const { variables, warnings } = parseInsomnia(data);

  // Base environment variables still import unchanged.
  assert.equal(varOf(variables, "token").value, "abc");

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Skipped 2 additional Insomnia environments/);
});

test("parseImport surfaces sub-parser warnings on the uniform return", () => {
  // The dispatcher does not strip warnings; the consumer (app.js) reads them.
  const data = structuredClone(INSOMNIA_FIXTURE);
  data.resources.push({
    _id: "env_prod",
    _type: "environment",
    parentId: "env_base",
    name: "Production",
    data: {},
  });
  const { warnings } = parseImport(JSON.stringify(data));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Skipped 1 additional Insomnia environment;/);
});

// ── Shared import helpers (shape.js) ─────────────────────────────────────────

test("shape.authFromHeaderValue: maps Bearer/Basic, ignores other schemes", () => {
  assert.deepEqual(authFromHeaderValue("Bearer tok-123"), {
    type: "bearer",
    token: "tok-123",
  });
  // Basic is base64(user:pass) → decoded username/password.
  const basic = `Basic ${btoa("alice:hunter2")}`;
  assert.deepEqual(authFromHeaderValue(basic), {
    type: "basic",
    username: "alice",
    password: "hunter2",
  });
  // A password may itself contain ":"; only the first colon splits.
  assert.deepEqual(authFromHeaderValue(`Basic ${btoa("u:a:b")}`), {
    type: "basic",
    username: "u",
    password: "a:b",
  });
  assert.equal(authFromHeaderValue("Digest realm=x"), null);
  assert.equal(authFromHeaderValue("Basic !!!not-base64"), null);
  assert.equal(authFromHeaderValue(""), null);
  assert.equal(authFromHeaderValue(undefined), null);
});

test("shape.splitUrlQuery: strips query into rows, drops fragment", () => {
  assert.deepEqual(splitUrlQuery("https://x.test/p?a=1&b=2#frag"), {
    base: "https://x.test/p",
    params: [
      { enabled: true, name: "a", value: "1" },
      { enabled: true, name: "b", value: "2" },
    ],
  });
  assert.deepEqual(splitUrlQuery("https://x.test/p"), {
    base: "https://x.test/p",
    params: [],
  });
});

// ── cURL import ──────────────────────────────────────────────────────────────

test("curl.tokenizeCurl: honours quotes and \\-newline continuations", () => {
  const cmd = "curl 'https://a.test' \\\n  -H \"X-A: 1\" \\\n  -d 'a b'";
  assert.deepEqual(tokenizeCurl(cmd), [
    "curl",
    "https://a.test",
    "-H",
    "X-A: 1",
    "-d",
    "a b",
  ]);
});

test("curl: representative command (method + headers + JSON -d) maps correctly", () => {
  const { collection, warnings } = parseCurl(
    `curl -X POST 'https://api.example.com/v1/users?team=eng' \\
       -H 'Content-Type: application/json' \\
       -H 'Accept: application/json' \\
       -d '{"name":"Ada"}'`,
  );
  assert.equal(collection.name, "Imported from cURL");
  assert.equal(collection.children.length, 1);
  const req = collection.children[0];

  assert.equal(req.type, "request");
  assert.equal(req.method, "POST");
  // Query is stripped off the URL and lives in params (no double-send).
  assert.equal(req.url, "https://api.example.com/v1/users");
  assert.deepEqual(req.params, [{ enabled: true, name: "team", value: "eng" }]);
  assert.deepEqual(req.headers, [
    { enabled: true, name: "Content-Type", value: "application/json" },
    { enabled: true, name: "Accept", value: "application/json" },
  ]);
  assert.equal(req.bodyType, "json");
  assert.equal(req.bodyText, '{"name":"Ada"}');
  assert.equal(warnings.length, 0);
});

test("curl: -u maps to basic auth; method defaults to GET", () => {
  const req = parseCurl("curl -u alice:s3cr3t https://api.test/me").collection
    .children[0];
  assert.equal(req.method, "GET");
  assert.equal(req.authType, "basic");
  assert.deepEqual(req.authBasic, { username: "alice", password: "s3cr3t" });
});

test("curl: an Authorization: Bearer header becomes bearer auth, not a header", () => {
  const req = parseCurl(
    "curl https://api.test/me -H 'Authorization: Bearer abc.def'",
  ).collection.children[0];
  assert.equal(req.authType, "bearer");
  assert.deepEqual(req.authBearer, { token: "abc.def" });
  assert.deepEqual(req.headers, []); // lifted out of the header list
});

test("curl: -F builds a form-data body with file rows (no warning from the parser)", () => {
  // The parser only builds the rows; the "re-attach" warning is decided later by
  // warnMissingFormFiles once the main process has checked the path on disk.
  const { collection, warnings } = parseCurl(
    "curl https://up.test/f -F field=value -F doc=@/tmp/report.pdf",
  );
  const req = collection.children[0];
  assert.equal(req.method, "POST"); // a body implies POST
  assert.equal(req.bodyType, "form-data");
  assert.deepEqual(req.bodyFormRows[0], {
    enabled: true,
    name: "field",
    value: "value",
  });
  assert.equal(req.bodyFormRows[1].kind, "file");
  assert.equal(req.bodyFormRows[1].filePath, "/tmp/report.pdf");
  assert.equal(req.bodyFormRows[1].fileName, "report.pdf");
  assert.equal(warnings.length, 0);
});

test("curl: a -F file field without @ but with ;filename= is a file row", () => {
  // Rest Hippo's own cURL export emits file fields as `name=path;type=…;filename=…`
  // (no leading `@`); the `;filename=` attribute marks it as a file part.
  const { collection, warnings } = parseCurl(
    `curl --request POST --url 'http://127.0.0.1:8888/echo' \\
       --form 'Text1=Example1' \\
       --form 'Text2=' \\
       --form 'File1=/Users/jason/Downloads/graphql.json;type=application/json;filename=graphql.json'`,
  );
  const req = collection.children[0];
  assert.equal(req.bodyType, "form-data");
  assert.deepEqual(req.bodyFormRows[0], {
    enabled: true,
    name: "Text1",
    value: "Example1",
  });
  // An empty value stays a text field, not a file.
  assert.deepEqual(req.bodyFormRows[1], {
    enabled: true,
    name: "Text2",
    value: "",
  });
  const file = req.bodyFormRows[2];
  assert.equal(file.kind, "file");
  assert.equal(file.filePath, "/Users/jason/Downloads/graphql.json");
  assert.equal(file.fileName, "graphql.json");
  assert.equal(file.contentType, "application/json");
  assert.equal(warnings.length, 0); // existence-checked later, not in the parser
});

test("import.collectFormFilePaths: gathers file-row paths from a parsed import", () => {
  const parsed = parseCurl(
    "curl https://up.test/f -F a=@/p/one.png -F b=text -F c=@/p/two.bin",
  );
  assert.deepEqual(collectFormFilePaths(parsed.collection), [
    "/p/one.png",
    "/p/two.bin",
  ]);
});

test("import.warnMissingFormFiles: warns only for the file paths reported missing", () => {
  const parsed = parseCurl(
    "curl https://up.test/f -F here=@/exists/a.png -F gone=@/missing/b.png",
  );
  assert.equal(parsed.warnings.length, 0); // the parser itself never warns
  warnMissingFormFiles(parsed, ["/missing/b.png"]);
  assert.equal(parsed.warnings.length, 1);
  assert.match(parsed.warnings[0], /\/missing\/b\.png/);
  // The file that exists on disk produces no warning.
  assert.ok(!parsed.warnings.some((w) => /\/exists\//.test(w)));
});

test("import.warnMissingFormFiles: empty missing set adds nothing", () => {
  const parsed = parseCurl("curl https://up.test/f -F doc=@/p/x.pdf");
  warnMissingFormFiles(parsed, []);
  assert.equal(parsed.warnings.length, 0);
});

test("curl: -G sends -d data as query params, leaving no body", () => {
  const req = parseCurl(
    "curl -G https://search.test/q --data-urlencode 'q=hello world' -d limit=10",
  ).collection.children[0];
  assert.equal(req.method, "GET");
  assert.equal(req.bodyType, "no-body");
  assert.deepEqual(req.params, [
    { enabled: true, name: "q", value: "hello world" },
    { enabled: true, name: "limit", value: "10" },
  ]);
});

test("curl: no Content-Type with key=value data → form-urlencoded; -X overrides default", () => {
  const req = parseCurl("curl -X PUT https://api.test/x -d a=1 -d b=2")
    .collection.children[0];
  assert.equal(req.method, "PUT");
  assert.equal(req.bodyType, "form-urlencoded");
  assert.deepEqual(req.bodyFormRows, [
    { enabled: true, name: "a", value: "1" },
    { enabled: true, name: "b", value: "2" },
  ]);
});

test("curl: bundled/attached short flags parse (-sS, -XPOST, -H attached)", () => {
  const req = parseCurl("curl -sSL -XPOST -H'X-Test: y' https://api.test/x")
    .collection.children[0];
  assert.equal(req.method, "POST");
  assert.deepEqual(req.headers, [
    { enabled: true, name: "X-Test", value: "y" },
  ]);
});

test("curl: -I implies a HEAD request", () => {
  const req = parseCurl("curl -I https://api.test/ping").collection.children[0];
  assert.equal(req.method, "HEAD");
});

test("curl: an unsupported value-bearing option is reported via warnings", () => {
  const { warnings } = parseCurl("curl https://api.test/x --max-time 30");
  assert.ok(warnings.some((w) => /max-time/.test(w)));
});

test("curl: a command with no URL throws", () => {
  assert.throws(() => parseCurl("curl -X POST -H 'A: b'"), /No URL/);
});

// ── HAR import ───────────────────────────────────────────────────────────────

const HAR_FIXTURE = {
  log: {
    version: "1.2",
    creator: { name: "Firefox", version: "1" },
    entries: [
      {
        request: {
          method: "GET",
          url: "https://api.example.com/users?page=2",
          headers: [
            { name: ":authority", value: "api.example.com" },
            { name: "Accept", value: "application/json" },
            { name: "Authorization", value: "Bearer har-tok" },
          ],
          queryString: [{ name: "page", value: "2" }],
        },
        response: { status: 200, content: { text: "ignored" } },
      },
      {
        request: {
          method: "POST",
          url: "https://api.example.com/login",
          headers: [{ name: "Content-Type", value: "application/json" }],
          postData: { mimeType: "application/json", text: '{"u":"a"}' },
        },
        response: { status: 201 },
      },
    ],
  },
};

test("har: detected via parseImport and entries become requests", () => {
  const { collection } = parseImport(JSON.stringify(HAR_FIXTURE));
  assert.equal(collection.name, "Imported from HAR");
  // Single host → no wrapping folder; requests sit directly under the collection.
  assert.equal(collection.children.length, 2);

  const get = findRequest(collection, "GET /users");
  assert.equal(get.method, "GET");
  assert.equal(get.url, "https://api.example.com/users"); // query stripped
  assert.deepEqual(get.params, [{ enabled: true, name: "page", value: "2" }]);
  // Pseudo-header dropped; Authorization lifted to auth.
  assert.deepEqual(get.headers, [
    { enabled: true, name: "Accept", value: "application/json" },
  ]);
  assert.equal(get.authType, "bearer");
  assert.deepEqual(get.authBearer, { token: "har-tok" });

  const post = findRequest(collection, "POST /login");
  assert.equal(post.bodyType, "json");
  assert.equal(post.bodyText, '{"u":"a"}');
});

test("har: multiple hosts are grouped into a folder each", () => {
  const data = {
    log: {
      entries: [
        { request: { method: "GET", url: "https://a.test/x" } },
        { request: { method: "GET", url: "https://b.test/y" } },
        { request: { method: "GET", url: "https://a.test/z" } },
      ],
    },
  };
  const { collection } = parseHar(data);
  assert.deepEqual(
    collection.children.map((c) => ({ type: c.type, name: c.name })),
    [
      { type: "collection", name: "a.test" },
      { type: "collection", name: "b.test" },
    ],
  );
  assert.equal(collection.children[0].children.length, 2); // a.test has 2
  assert.equal(collection.children[1].children.length, 1); // b.test has 1
});

test("har: form-urlencoded postData params become a form body", () => {
  const data = {
    log: {
      entries: [
        {
          request: {
            method: "POST",
            url: "https://api.test/form",
            headers: [],
            postData: {
              mimeType: "application/x-www-form-urlencoded",
              params: [
                { name: "grant_type", value: "password" },
                { name: "user", value: "ada" },
              ],
            },
          },
        },
      ],
    },
  };
  const req = parseHar(data).collection.children[0];
  assert.equal(req.bodyType, "form-urlencoded");
  assert.deepEqual(req.bodyFormRows, [
    { enabled: true, name: "grant_type", value: "password" },
    { enabled: true, name: "user", value: "ada" },
  ]);
});

test("har: entries with no request URL are skipped and reported", () => {
  const data = {
    log: {
      entries: [
        { request: { method: "GET", url: "https://a.test/x" } },
        { request: { method: "GET" } }, // no url
        {}, // no request
      ],
    },
  };
  const { collection, warnings } = parseHar(data);
  assert.equal(collection.children.length, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Skipped 2 HAR entries/);
});

test("har: all importers (incl. har/curl) return a warnings array", () => {
  assert.ok(Array.isArray(parseHar({ log: { entries: [] } }).warnings));
  assert.ok(Array.isArray(parseCurl("curl https://a.test").warnings));
});
