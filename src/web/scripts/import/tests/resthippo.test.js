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
 * import/tests/resthippo.test.js
 *
 * Tests the native "Rest Hippo v1" import merge: detection, the identity-aware
 * tree merge (folders reused + recursed by id→name, requests replaced by id→name,
 * misses created), and the environment/variable merge (matched by id→name; vars
 * added only when missing, existing values never overwritten).
 *
 * It also carries the full-fidelity ROUND-TRIP guard (build → JSON → merge): a
 * maximally-rich request/folder must survive export and re-import byte-for-byte.
 * The archive owes its fidelity to cloning tree nodes verbatim, so this locks in
 * that neither side ever starts filtering/cherry-picking node fields — a change
 * that would otherwise silently drop a field (an auth config, a script, captures,
 * a WebSocket setting, …) from a restored collection with no failing test.
 *
 * Run with:   node --test import/tests/resthippo.test.js
 */

"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  detectRestHippo,
  mergeArchiveIntoTree,
  mergeEnvironments,
  mergeVariableList,
  mergeHeaderList,
  mergeProfileList,
} from "../resthippo.js";
import { buildRestHippoArchive } from "../../export/resthippo.js";

test("detectRestHippo: only matches the native envelope", () => {
  assert.equal(
    detectRestHippo({ format: "resthippo", kind: "resthippo-collection" }),
    true,
  );
  assert.equal(detectRestHippo({ format: "resthippo" }), false);
  assert.equal(detectRestHippo({ info: { schema: "getpostman.com" } }), false);
  assert.equal(detectRestHippo(null), false);
});

test("mergeArchiveIntoTree: reuse folder by id, replace request, create new", () => {
  const target = [
    {
      id: "f1",
      type: "collection",
      name: "API",
      variables: [{ name: "keep", value: "me", secure: false }],
      children: [{ id: "r1", type: "request", name: "Get", url: "OLD" }],
    },
  ];
  const archive = [
    {
      id: "f1",
      type: "collection",
      name: "API (renamed in archive)",
      variables: [{ name: "ignored", value: "x", secure: false }],
      children: [
        { id: "r1", type: "request", name: "Get", url: "NEW" }, // replace
        { id: "r2", type: "request", name: "Post", url: "P" }, // create
      ],
    },
  ];

  const { items, created, replaced } = mergeArchiveIntoTree(target, archive);
  assert.equal(created, 1);
  assert.equal(replaced, 1);

  const folder = items[0];
  // Folder reused as-is: original name + variables untouched.
  assert.equal(folder.name, "API");
  assert.deepEqual(folder.variables, [
    { name: "keep", value: "me", secure: false },
  ]);
  // Contents restored into it: r1 replaced, r2 added.
  assert.equal(folder.children.length, 2);
  assert.equal(folder.children.find((n) => n.id === "r1").url, "NEW");
  assert.ok(folder.children.find((n) => n.id === "r2"));

  // Inputs not mutated.
  assert.equal(target[0].children[0].url, "OLD");
});

test("mergeArchiveIntoTree: folder matched by name when id differs", () => {
  const target = [{ id: "f1", type: "collection", name: "API", children: [] }];
  const archive = [
    {
      id: "DIFFERENT",
      type: "collection",
      name: "API",
      children: [{ id: "r9", type: "request", name: "New", url: "u" }],
    },
  ];
  const { items, created } = mergeArchiveIntoTree(target, archive);
  assert.equal(items.length, 1); // reused, not duplicated
  assert.equal(items[0].id, "f1"); // kept existing folder identity
  assert.equal(created, 1); // the request inside it
  assert.equal(items[0].children[0].id, "r9");
});

test("mergeArchiveIntoTree: request matched by name replaces (different id)", () => {
  const target = [{ id: "rA", type: "request", name: "Login", url: "OLD" }];
  const archive = [{ id: "rB", type: "request", name: "Login", url: "NEW" }];
  const { items, created, replaced } = mergeArchiveIntoTree(target, archive);
  assert.equal(items.length, 1);
  assert.equal(replaced, 1);
  assert.equal(created, 0);
  assert.equal(items[0].url, "NEW");
});

test("mergeArchiveIntoTree: brand-new folder subtree is created and counted", () => {
  const target = [];
  const archive = [
    {
      id: "f2",
      type: "collection",
      name: "New",
      children: [
        { id: "r1", type: "request", name: "a", url: "u" },
        {
          id: "f3",
          type: "collection",
          name: "Sub",
          children: [{ id: "r2", type: "request", name: "b", url: "u" }],
        },
      ],
    },
  ];
  const { items, created } = mergeArchiveIntoTree(target, archive);
  assert.equal(items.length, 1);
  assert.equal(created, 4); // f2 + r1 + f3 + r2
});

test("mergeVariableList: adds missing by name, never overwrites existing", () => {
  const { list, added } = mergeVariableList(
    [{ name: "a", value: "keep", secure: false }],
    [
      { name: "a", value: "OVERWRITE?", secure: true },
      { name: "b", value: "new", secure: false },
    ],
  );
  assert.equal(added, 1);
  assert.equal(list.find((v) => v.name === "a").value, "keep");
  assert.ok(list.find((v) => v.name === "b"));
});

test("mergeHeaderList: adds missing by case-insensitive name, never overwrites existing", () => {
  const { list, added } = mergeHeaderList(
    [{ id: "h1", name: "Content-Type", value: "keep", enabled: true }],
    [
      // Same name (different case) → must NOT overwrite the existing row.
      { id: "h2", name: "content-type", value: "OVERWRITE?", enabled: true },
      { id: "h3", name: "X-New", value: "new", enabled: false },
    ],
  );
  assert.equal(added, 1);
  assert.equal(list.find((h) => h.name === "Content-Type").value, "keep");
  const added1 = list.find((h) => h.name === "X-New");
  assert.ok(added1);
  assert.equal(added1.enabled, false); // disabled flag preserved on import
});

test("mergeProfileList: adds a profile only when both its id AND name are new", () => {
  const { list, added } = mergeProfileList(
    [{ id: "p1", name: "Prod" }],
    [
      { id: "p1", name: "Prod (renamed)" }, // same id → skip
      { id: "OTHER", name: "prod" }, // same name (case-insensitive) → skip
      { id: "p2", name: "Staging" }, // new → add
    ],
  );
  assert.equal(added, 1);
  assert.deepEqual(list, [
    { id: "p1", name: "Prod" },
    { id: "p2", name: "Staging" },
  ]);
});

test("mergeProfileList: tolerant of missing inputs and id-less entries", () => {
  assert.deepEqual(mergeProfileList(null, null), { list: [], added: 0 });
  const { added } = mergeProfileList([], [{ name: "no-id" }]);
  assert.equal(added, 0);
});

test("mergeHeaderList: tolerant of missing/null inputs and blank names", () => {
  assert.deepEqual(mergeHeaderList(null, null), { list: [], added: 0 });
  const { list, added } = mergeHeaderList(
    [],
    [{ name: "   ", value: "x", enabled: true }],
  );
  // A blank-name incoming row is skipped (not added).
  assert.equal(added, 0);
  assert.equal(list.length, 0);
});

test("mergeEnvironments: match by id/name, create missing, add-only vars", () => {
  const current = {
    activeEnvironmentId: "e1",
    globalVariables: [{ name: "g1", value: "a", secure: false }],
    environments: [
      {
        id: "e1",
        name: "Dev",
        variables: [{ name: "v1", value: "x", secure: false }],
      },
    ],
  };
  const archive = {
    globalVariables: [
      { name: "g1", value: "NEW", secure: false }, // exists → kept
      { name: "g2", value: "b", secure: false }, // added
    ],
    environments: [
      {
        id: "e1",
        name: "Dev",
        variables: [
          { name: "v1", value: "NEW", secure: false }, // exists → kept
          { name: "v2", value: "y", secure: false }, // added
        ],
      },
      {
        id: "e2",
        name: "Prod",
        variables: [{ name: "p", value: "z", secure: false }],
      },
    ],
  };

  const { environments, createdEnvs, addedVars } = mergeEnvironments(
    current,
    archive,
  );
  assert.equal(createdEnvs, 1); // Prod
  assert.equal(addedVars, 3); // g2 + v2 + p

  // Global: g1 kept, g2 added.
  assert.equal(
    environments.globalVariables.find((v) => v.name === "g1").value,
    "a",
  );
  assert.ok(environments.globalVariables.find((v) => v.name === "g2"));

  // Dev reused: v1 kept, v2 added.
  const dev = environments.environments.find((e) => e.id === "e1");
  assert.equal(dev.variables.find((v) => v.name === "v1").value, "x");
  assert.ok(dev.variables.find((v) => v.name === "v2"));

  // Prod created with the exported id.
  const prod = environments.environments.find((e) => e.name === "Prod");
  assert.equal(prod.id, "e2");

  // activeEnvironmentId preserved.
  assert.equal(environments.activeEnvironmentId, "e1");
});

test("mergeEnvironments: environment matched by name when id differs", () => {
  const current = {
    globalVariables: [],
    environments: [{ id: "e1", name: "Dev", variables: [] }],
  };
  const archive = {
    globalVariables: [],
    environments: [
      {
        id: "ZZZ",
        name: "Dev",
        variables: [{ name: "k", value: "v", secure: false }],
      },
    ],
  };
  const { environments, createdEnvs } = mergeEnvironments(current, archive);
  assert.equal(createdEnvs, 0); // matched Dev by name, not created
  assert.equal(environments.environments.length, 1);
  assert.equal(environments.environments[0].id, "e1");
  assert.ok(environments.environments[0].variables.find((v) => v.name === "k"));
});

// ── Full-fidelity round-trip (build → JSON → merge) ─────────────────────────
// The native format's promise is "fully restore a collection". These lock that
// in field-by-field so a future refactor that filters node fields on export,
// cherry-picks on import, or moves a field off the tree node can't silently
// drop it from a restored collection without turning a test red.

/** A request touching every stored field: all body kinds, all auth types,
 *  scripts, tests and captures. (Only one body/auth is ever "active" at a time,
 *  but a full clone must keep every stored field, so the fixture sets them all.) */
function richHttpRequest() {
  return {
    id: "req-http",
    type: "request",
    name: "Everything",
    method: "POST",
    url: "{{baseUrl}}/things/{{id}}",
    params: [{ id: "p1", name: "q", value: "1", enabled: true }],
    pathParams: [{ id: "pp1", name: "id", value: "42" }],
    headers: [
      { id: "h1", name: "X-On", value: "a", enabled: true },
      { id: "h2", name: "X-Off", value: "b", enabled: false },
    ],
    notes: "some **markdown** notes",
    bodyType: "graphql",
    bodyText: '{"raw":true}',
    bodyFormRows: [
      { id: "fr1", name: "file", value: "x", type: "file", enabled: true },
    ],
    bodyFilePath: "/tmp/upload.bin",
    bodyGraphql: {
      query: "query($id:ID!){ thing(id:$id){ name } }",
      variables: '{"id":"42"}',
    },
    authEnabled: true,
    authType: "oauth2",
    authBasic: { username: "u", password: "p" },
    authBearer: { token: "{{token}}" },
    authApiKey: { key: "X-Api-Key", value: "k", addTo: "header" },
    authDigest: { username: "u", password: "p", algorithm: "MD5" },
    authNtlm: { username: "u", password: "p", domain: "D", workstation: "W" },
    authOAuth1: {
      consumerKey: "ck",
      consumerSecret: "cs",
      signatureMethod: "HMAC-SHA1",
    },
    authOAuth2: {
      grantType: "authorization_code",
      clientId: "id",
      tokenUrl: "http://t",
      accessToken: "at",
    },
    authAwsIam: {
      accessKeyId: "ak",
      secretAccessKey: "sk",
      region: "us-east-1",
      service: "s3",
    },
    preRequestScript: "hippo.variables.set('global','a','1')",
    preRequestScriptEnabled: true,
    afterResponseScript: "hippo.test('ok', hippo.response.status === 200)",
    afterResponseScriptEnabled: false,
    scriptSplit: 0.4,
    assertions: [
      { id: "a1", source: "status", op: "eq", expected: "200", enabled: true },
    ],
    captures: [
      {
        id: "c1",
        from: "body",
        path: "$.id",
        scope: "environment",
        name: "id",
        enabled: true,
      },
    ],
  };
}

/** A WebSocket request touching every WS-only field. */
function richWsRequest() {
  return {
    id: "req-ws",
    type: "request",
    name: "Socket",
    protocol: "websocket",
    url: "wss://{{host}}/ws",
    headers: [{ id: "h1", name: "Origin", value: "http://x", enabled: true }],
    wsMessage: '{"ping":true}',
    wsMessageFormat: "json",
    wsSubprotocols: ["graphql-ws", "soap"],
    authEnabled: false,
    authType: "none",
  };
}

/** Export a set of nodes to a native archive, cross the on-disk JSON boundary,
 *  then re-import into an empty tree. Returns the restored top-level items. */
function roundTrip(items) {
  const archive = buildRestHippoArchive({
    items,
    collectionVariables: [],
    collectionHeaders: [],
    environments: { globalVariables: [], environments: [] },
    exportedAt: "2026-07-07T00:00:00.000Z",
  });
  // The archive is written to disk as JSON, so prove it survives that boundary
  // too (nothing depends on a non-JSON type).
  const onDisk = JSON.parse(JSON.stringify(archive));
  return mergeArchiveIntoTree([], onDisk.items).items;
}

test("round-trip: a folder of rich HTTP + WebSocket requests survives export→import unchanged", () => {
  const folder = {
    id: "f1",
    type: "collection",
    name: "All",
    variables: [{ name: "folderVar", value: "fv", secure: false }],
    // Folder-variable profile overrides must ride verbatim on the node.
    profileValues: { prof1: { folderVar: "prod-value" } },
    children: [richHttpRequest(), richWsRequest()],
  };
  const original = structuredClone(folder);

  const restored = roundTrip([folder]);

  // Byte-for-byte: every folder field (incl. folder-level variables) and every
  // request field is preserved.
  assert.deepEqual(restored, [original]);
});

test("round-trip: every canonical request field is individually preserved (off-node-drift guard)", () => {
  const original = richHttpRequest();
  const [restored] = roundTrip([original]);

  // Named per-field so a dropped field points at exactly what regressed, and the
  // list doubles as the documented canonical request-node field set.
  const FIELDS = [
    "method",
    "url",
    "params",
    "pathParams",
    "headers",
    "notes",
    "bodyType",
    "bodyText",
    "bodyFormRows",
    "bodyFilePath",
    "bodyGraphql",
    "authEnabled",
    "authType",
    "authBasic",
    "authBearer",
    "authApiKey",
    "authDigest",
    "authNtlm",
    "authOAuth1",
    "authOAuth2",
    "authAwsIam",
    "preRequestScript",
    "preRequestScriptEnabled",
    "afterResponseScript",
    "afterResponseScriptEnabled",
    "scriptSplit",
    "assertions",
    "captures",
  ];
  for (const field of FIELDS) {
    assert.deepEqual(
      restored[field],
      original[field],
      `request field "${field}" was lost in the export→import round-trip`,
    );
  }
});

test("round-trip: every canonical WebSocket field is individually preserved", () => {
  const original = richWsRequest();
  const [restored] = roundTrip([original]);

  for (const field of [
    "protocol",
    "url",
    "headers",
    "wsMessage",
    "wsMessageFormat",
    "wsSubprotocols",
    "authEnabled",
    "authType",
  ]) {
    assert.deepEqual(
      restored[field],
      original[field],
      `WebSocket field "${field}" was lost in the export→import round-trip`,
    );
  }
});
