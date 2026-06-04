/**
 * export/tests/openapi.test.js
 *
 * Unit tests for the (best-effort) OpenAPI 3 exporter: document structure,
 * path/parameter mapping, security schemes, and the guarantee that no secret
 * value — auth credential or `secure` variable — ever reaches the document.
 *
 * Run with:   node --test export/tests/openapi.test.js
 */

"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import { exportToOpenApi } from "../openapi.js";

function exportObject(collection, variables) {
  return JSON.parse(exportToOpenApi(collection, variables));
}

test("document has openapi version, info title, server, and paths", () => {
  const out = exportObject({
    id: "c1",
    name: "My API",
    children: [
      {
        type: "request",
        name: "List Users",
        method: "GET",
        url: "https://api.example.com/users?page=1",
        params: [{ enabled: true, name: "page", value: "1" }],
      },
      {
        type: "request",
        name: "Get User",
        method: "GET",
        url: "https://api.example.com/users/{{id}}",
      },
    ],
  });

  assert.equal(out.openapi, "3.0.3");
  assert.equal(out.info.title, "My API");
  assert.deepEqual(out.servers, [{ url: "https://api.example.com" }]);

  assert.ok(out.paths["/users"].get, "GET /users missing");
  assert.ok(out.paths["/users/{id}"].get, "GET /users/{id} missing");
  assert.deepEqual(out.paths["/users"].get.responses, {
    200: { description: "OK" },
  });
});

test("wurl {{var}} path segments become declared path parameters", () => {
  const out = exportObject({
    id: "c1",
    name: "C",
    children: [
      {
        type: "request",
        name: "Get",
        method: "GET",
        url: "https://x/users/{{id}}",
      },
    ],
  });

  const params = out.paths["/users/{id}"].get.parameters ?? [];
  assert.ok(
    params.some(
      (p) => p.name === "id" && p.in === "path" && p.required === true,
    ),
    "path parameter {id} was not declared",
  );
});

test("query and header rows become parameters; reserved headers are excluded", () => {
  const out = exportObject({
    id: "c1",
    name: "C",
    children: [
      {
        type: "request",
        name: "Search",
        method: "GET",
        url: "https://x/search",
        params: [{ enabled: true, name: "q", value: "term" }],
        headers: [
          { enabled: true, name: "X-Trace", value: "1" },
          { enabled: true, name: "Authorization", value: "Bearer xyz" },
        ],
      },
    ],
  });

  const params = out.paths["/search"].get.parameters ?? [];
  assert.ok(params.some((p) => p.name === "q" && p.in === "query"));
  assert.ok(params.some((p) => p.name === "X-Trace" && p.in === "header"));
  // Authorization is owned by security, not parameters.
  assert.ok(!params.some((p) => p.name === "Authorization"));
});

test("json body becomes a requestBody example", () => {
  const out = exportObject({
    id: "c1",
    name: "C",
    children: [
      {
        type: "request",
        name: "Create",
        method: "POST",
        url: "https://x/items",
        bodyType: "json",
        bodyText: '{"a":1}',
      },
    ],
  });

  const media =
    out.paths["/items"].post.requestBody.content["application/json"];
  assert.deepEqual(media.example, { a: 1 });
});

test("folders become operation tags", () => {
  const out = exportObject({
    id: "c1",
    name: "API",
    children: [
      {
        type: "collection",
        name: "Users",
        children: [
          {
            type: "request",
            name: "List",
            method: "GET",
            url: "https://x/users",
          },
        ],
      },
    ],
  });

  assert.deepEqual(out.paths["/users"].get.tags, ["Users"]);
  assert.ok(out.tags.some((t) => t.name === "Users"));
});

test("auth becomes a security scheme; no secret value is emitted", () => {
  const json = exportToOpenApi(
    {
      id: "c1",
      name: "C",
      children: [
        {
          type: "request",
          name: "Login",
          method: "POST",
          url: "https://x/login",
          authEnabled: true,
          authType: "basic",
          authBasic: { username: "alice", password: "PASS-LEAK" },
        },
      ],
    },
    [{ name: "apiKey", value: "VAR-LEAK", secure: true }],
  );

  assert.ok(!json.includes("PASS-LEAK"), "basic password leaked into export");
  assert.ok(!json.includes("VAR-LEAK"), "secure variable leaked into export");

  const out = JSON.parse(json);
  assert.equal(out.components.securitySchemes.basicAuth.scheme, "basic");
  assert.deepEqual(out.paths["/login"].post.security, [{ basicAuth: [] }]);
});

test("oauth2 maps to a flow; clientSecret never appears", () => {
  const out = exportObject({
    id: "c1",
    name: "C",
    children: [
      {
        type: "request",
        name: "R",
        method: "GET",
        url: "https://x/data",
        authEnabled: true,
        authType: "oauth2",
        authOAuth2: {
          grantType: "client_credentials",
          clientId: "client-123",
          clientSecret: "shhh",
          accessTokenUrl: "https://auth/token",
          authUrl: "https://auth/authorize",
          scope: "read",
        },
      },
    ],
  });

  const scheme = out.components.securitySchemes.oauth2Auth;
  assert.equal(scheme.type, "oauth2");
  assert.equal(scheme.flows.clientCredentials.tokenUrl, "https://auth/token");
  assert.ok(
    !JSON.stringify(out).includes("shhh"),
    "oauth2 clientSecret leaked into export",
  );
});
