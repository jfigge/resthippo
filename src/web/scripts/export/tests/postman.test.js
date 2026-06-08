/**
 * export/tests/postman.test.js
 *
 * Unit tests for the Postman v2.1 exporter, focused on secret redaction.
 *
 * Run with:   node --test export/tests/postman.test.js
 *
 * Dependencies: none external — uses Node's built-in test runner and assert.
 * `crypto.randomUUID()` (used by the exporter for a fallback id) is available
 * as a global in supported Node versions.
 */

"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import { exportToPostman } from "../postman.js";

/** Parse the exporter output back into an object for assertions. */
function exportObject(collection, variables) {
  return JSON.parse(exportToPostman(collection, variables));
}

/** Find a request item by name anywhere in the exported item tree. */
function findRequest(items, name) {
  for (const it of items ?? []) {
    if (it.name === name && it.request) return it;
    const nested = findRequest(it.item, name);
    if (nested) return nested;
  }
  return null;
}

/** Look up a Postman auth/variable entry's value by its key. */
function valueOf(entries, key) {
  return entries.find((e) => e.key === key);
}

test("secure collection variables are redacted, plain ones pass through", () => {
  const out = exportObject({ id: "c1", name: "C", children: [] }, [
    { name: "host", value: "https://api.example.com", secure: false },
    { name: "apiKey", value: "super-secret", secure: true },
  ]);

  const host = valueOf(out.variable, "host");
  const apiKey = valueOf(out.variable, "apiKey");

  assert.equal(host.value, "https://api.example.com");
  assert.equal(host.type, undefined);

  // Secret: key preserved, value stripped, flagged as a Postman secret.
  assert.equal(apiKey.value, "");
  assert.equal(apiKey.type, "secret");
});

test("secure folder-scoped variables are redacted", () => {
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

  const folder = out.item.find((i) => i.name === "Folder");
  const token = valueOf(folder.variable, "token");
  const stage = valueOf(folder.variable, "stage");

  assert.equal(token.value, "");
  assert.equal(token.type, "secret");
  assert.equal(stage.value, "prod");
  assert.equal(stage.type, undefined);
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

  const req = findRequest(out.item, "R").request;
  assert.equal(valueOf(req.auth.basic, "username").value, "alice");
  assert.equal(valueOf(req.auth.basic, "password").value, "");
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

  const req = findRequest(out.item, "R").request;
  assert.equal(valueOf(req.auth.bearer, "token").value, "");
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

  const oauth2 = findRequest(out.item, "R").request.auth.oauth2;
  assert.equal(valueOf(oauth2, "clientSecret").value, "");
  assert.equal(valueOf(oauth2, "clientId").value, "client-123");
  assert.equal(valueOf(oauth2, "accessTokenUrl").value, "https://auth/token");
  assert.equal(valueOf(oauth2, "authUrl").value, "https://auth/authorize");
  assert.equal(valueOf(oauth2, "scope").value, "read write");
  assert.equal(valueOf(oauth2, "grant_type").value, "client_credentials");
});

test("api-key auth keeps name/placement, redacts the value", () => {
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
        authType: "apikey",
        authApiKey: { name: "X-API-Key", value: "k-secret", addTo: "query" },
      },
    ],
  });

  const auth = findRequest(out.item, "R").request.auth;
  assert.equal(auth.type, "apikey");
  assert.equal(valueOf(auth.apikey, "key").value, "X-API-Key");
  assert.equal(valueOf(auth.apikey, "in").value, "query");
  assert.equal(valueOf(auth.apikey, "value").value, "");
});

test("digest auth keeps username, redacts the password", () => {
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
        authType: "digest",
        authDigest: { username: "alice", password: "d-secret" },
      },
    ],
  });

  const auth = findRequest(out.item, "R").request.auth;
  assert.equal(auth.type, "digest");
  assert.equal(valueOf(auth.digest, "username").value, "alice");
  assert.equal(valueOf(auth.digest, "password").value, "");
});

test("ntlm auth keeps username/domain/workstation, redacts the password", () => {
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
        authType: "ntlm",
        authNtlm: {
          username: "alice",
          password: "n-secret",
          domain: "CORP",
          workstation: "WS1",
        },
      },
    ],
  });

  const auth = findRequest(out.item, "R").request.auth;
  assert.equal(auth.type, "ntlm");
  assert.equal(valueOf(auth.ntlm, "username").value, "alice");
  assert.equal(valueOf(auth.ntlm, "domain").value, "CORP");
  assert.equal(valueOf(auth.ntlm, "workstation").value, "WS1");
  assert.equal(valueOf(auth.ntlm, "password").value, "");
});

test("aws-iam auth keeps accessKeyId/region/service, redacts the secret key & token", () => {
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
        authType: "aws-iam",
        authAwsIam: {
          accessKeyId: "AKIA-ID",
          secretAccessKey: "aws-secret",
          region: "us-east-1",
          service: "s3",
          sessionToken: "aws-token",
        },
      },
    ],
  });

  const auth = findRequest(out.item, "R").request.auth;
  assert.equal(auth.type, "awsv4");
  assert.equal(valueOf(auth.awsv4, "accessKey").value, "AKIA-ID");
  assert.equal(valueOf(auth.awsv4, "region").value, "us-east-1");
  assert.equal(valueOf(auth.awsv4, "service").value, "s3");
  assert.equal(valueOf(auth.awsv4, "secretKey").value, "");
  assert.equal(valueOf(auth.awsv4, "sessionToken").value, "");
});

test("the exported file contains no secret values anywhere", () => {
  const json = exportToPostman(
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
        {
          type: "request",
          name: "RK",
          method: "GET",
          url: "https://x",
          authEnabled: true,
          authType: "apikey",
          authApiKey: { name: "X-Key", value: "KEY-LEAK", addTo: "header" },
        },
        {
          type: "request",
          name: "RD",
          method: "GET",
          url: "https://x",
          authEnabled: true,
          authType: "digest",
          authDigest: { username: "u", password: "DIGEST-LEAK" },
        },
        {
          type: "request",
          name: "RN",
          method: "GET",
          url: "https://x",
          authEnabled: true,
          authType: "ntlm",
          authNtlm: { username: "u", password: "NTLM-LEAK", domain: "D" },
        },
        {
          type: "request",
          name: "RA",
          method: "GET",
          url: "https://x",
          authEnabled: true,
          authType: "aws-iam",
          authAwsIam: {
            accessKeyId: "AKIA-ID",
            secretAccessKey: "AWS-SECRET-LEAK",
            sessionToken: "AWS-TOKEN-LEAK",
          },
        },
      ],
    },
    [{ name: "apiKey", value: "VAR-LEAK", secure: true }],
  );

  for (const leak of [
    "PASS-LEAK",
    "KEY-LEAK",
    "DIGEST-LEAK",
    "NTLM-LEAK",
    "AWS-SECRET-LEAK",
    "AWS-TOKEN-LEAK",
    "VAR-LEAK",
  ]) {
    assert.ok(!json.includes(leak), `${leak} leaked into export`);
  }
});
