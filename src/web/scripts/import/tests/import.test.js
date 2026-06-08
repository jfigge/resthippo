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
import {
  buildAuth,
  graphqlBody,
  normalizeGraphqlVariables,
  formBody,
} from "../shape.js";
import { exportToPostman } from "../../export/postman.js";
import { exportToInsomnia } from "../../export/insomnia.js";

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

test("round-trip: wurl → Insomnia v4 export → import preserves structure", () => {
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

// ── Round-trip: GraphQL body (Feature 34) ────────────────────────────────────

test("round-trip: GraphQL body survives a wurl → Postman → wurl cycle", () => {
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

test("round-trip: GraphQL body survives a wurl → Insomnia → wurl cycle", () => {
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

test("shape.buildAuth: neutral descriptor → canonical wurl auth fields", () => {
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

  // oauth2 fills wurl defaults for omitted fields (notably grantType).
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

  // Only the first file survives (wurl is one file per field) …
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
  // Add two extra environments beyond the base; wurl imports only the base.
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
