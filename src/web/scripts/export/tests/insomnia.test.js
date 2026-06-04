/**
 * export/tests/insomnia.test.js
 *
 * Unit tests for the Insomnia v4 exporter, focused on secret redaction and the
 * resources-graph structure.
 *
 * Run with:   node --test export/tests/insomnia.test.js
 */

"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import { exportToInsomnia } from "../insomnia.js";

function exportObject(collection, variables) {
  return JSON.parse(exportToInsomnia(collection, variables));
}

function byType(resources, type) {
  return resources.filter((r) => r._type === type);
}

function baseEnv(resources) {
  return byType(resources, "environment").find(
    (e) => e.name === "Base Environment",
  );
}

function findRequest(resources, name) {
  return (
    resources.find((r) => r._type === "request" && r.name === name) ?? null
  );
}

test("secure collection variables are redacted into the base environment", () => {
  const out = exportObject({ id: "c1", name: "C", children: [] }, [
    { name: "host", value: "https://api.example.com", secure: false },
    { name: "apiKey", value: "super-secret", secure: true },
  ]);

  const env = baseEnv(out.resources);
  assert.equal(env.data.host, "https://api.example.com");
  assert.equal(env.data.apiKey, "");
});

test("secure folder-scoped variables are redacted into the group environment", () => {
  const out = exportObject(
    {
      id: "c1",
      name: "C",
      children: [
        {
          type: "collection",
          name: "Folder",
          children: [],
          variables: [
            { name: "token", value: "abc123", secure: true },
            { name: "stage", value: "prod", secure: false },
          ],
        },
      ],
    },
    [],
  );

  const group = byType(out.resources, "request_group").find(
    (g) => g.name === "Folder",
  );
  assert.equal(group.environment.token, "");
  assert.equal(group.environment.stage, "prod");
});

test("basic auth password is redacted, username is kept", () => {
  const out = exportObject({
    id: "c1",
    name: "C",
    children: [
      {
        type: "request",
        name: "R",
        method: "GET",
        url: "https://x",
        authEnabled: true,
        authType: "basic",
        authBasic: { username: "alice", password: "hunter2" },
      },
    ],
  });

  const auth = findRequest(out.resources, "R").authentication;
  assert.equal(auth.type, "basic");
  assert.equal(auth.username, "alice");
  assert.equal(auth.password, "");
});

test("bearer token is redacted", () => {
  const out = exportObject({
    id: "c1",
    name: "C",
    children: [
      {
        type: "request",
        name: "R",
        method: "GET",
        url: "https://x",
        authEnabled: true,
        authType: "bearer",
        authBearer: { token: "tok-secret" },
      },
    ],
  });

  const auth = findRequest(out.resources, "R").authentication;
  assert.equal(auth.type, "bearer");
  assert.equal(auth.token, "");
});

test("oauth2 clientSecret is redacted, non-secret fields are kept", () => {
  const out = exportObject({
    id: "c1",
    name: "C",
    children: [
      {
        type: "request",
        name: "R",
        method: "GET",
        url: "https://x",
        authEnabled: true,
        authType: "oauth2",
        authOAuth2: {
          grantType: "client_credentials",
          clientId: "client-123",
          clientSecret: "shhh",
          accessTokenUrl: "https://auth/token",
          authUrl: "https://auth/authorize",
          scope: "read write",
        },
      },
    ],
  });

  const auth = findRequest(out.resources, "R").authentication;
  assert.equal(auth.type, "oauth2");
  assert.equal(auth.clientSecret, "");
  assert.equal(auth.clientId, "client-123");
  assert.equal(auth.accessTokenUrl, "https://auth/token");
  // wurl `authUrl` maps onto Insomnia's `authorizationUrl`.
  assert.equal(auth.authorizationUrl, "https://auth/authorize");
  assert.equal(auth.scope, "read write");
  assert.equal(auth.grantType, "client_credentials");
});

test("the exported file contains no secret values anywhere", () => {
  const json = exportToInsomnia(
    {
      id: "c1",
      name: "C",
      children: [
        {
          type: "request",
          name: "R",
          method: "POST",
          url: "https://x",
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
});

test("resources graph links workspace → folder → request by parentId", () => {
  const out = exportObject({
    id: "c1",
    name: "My API",
    children: [
      {
        type: "collection",
        name: "Folder",
        children: [
          {
            type: "request",
            name: "Get",
            method: "GET",
            url: "https://x/get",
            headers: [{ enabled: true, name: "H", value: "v" }],
            params: [{ enabled: true, name: "q", value: "1" }],
            bodyType: "json",
            bodyText: '{"a":1}',
          },
        ],
      },
    ],
  });

  assert.equal(out._type, "export");
  assert.equal(out.__export_format, 4);

  const ws = byType(out.resources, "workspace")[0];
  assert.equal(ws.name, "My API");
  assert.equal(ws.parentId, null);

  const folder = byType(out.resources, "request_group").find(
    (g) => g.name === "Folder",
  );
  assert.equal(folder.parentId, ws._id);

  const req = findRequest(out.resources, "Get");
  assert.equal(req.parentId, folder._id);
  assert.equal(req.method, "GET");
  assert.equal(req.body.mimeType, "application/json");
  assert.equal(req.body.text, '{"a":1}');
  assert.ok(req.headers.some((h) => h.name === "H" && h.value === "v"));
  assert.ok(req.parameters.some((p) => p.name === "q" && p.value === "1"));
});
