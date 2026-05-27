/**
 * integration.test.js — Cross-store integration tests simulating real UI workflows.
 *
 * These tests exercise the complete lifecycle that the renderer drives through
 * IPC: manifest management, collection creation, request CRUD, history recording,
 * environment variable handling, and cross-store consistency.
 *
 * Each suite creates an isolated temp directory so tests never share state.
 *
 * Run with:
 *   node --test src/app/store/tests/integration.test.js
 */
"use strict";

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");

const { Stores } = require("../stores");
const { Paths } = require("../paths");
const { Resolver } = require("../resolver");
const { validateID } = require("../io");

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wurl-integration-"));
}

function rmTmpDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function makeRequest(overrides = {}) {
  return {
    id: `req-${Math.random().toString(36).slice(2)}`,
    type: "request",
    name: "Test Request",
    method: "GET",
    url: "https://example.com",
    ...overrides,
  };
}

function makeHistoryEntry(overrides = {}) {
  return {
    status: 200,
    durationMs: 50,
    responseSize: 1024,
    ...overrides,
  };
}

function makeResponse(overrides = {}) {
  return {
    headers: { "content-type": "application/json" },
    body: '{"ok":true}',
    contentType: "application/json",
    ...overrides,
  };
}

// ── Suite setup shorthand ─────────────────────────────────────────────────────

function makeStores(tmpDir) {
  const ss = new Stores(tmpDir);
  return {
    ss,
    manifest: ss.collectionStore(),
    collections: ss.collectionsStore(),
    tree: ss.treeStore(),
    requests: ss.requestStore(),
    history: ss.historyStore(),
    environments: ss.environmentStore(),
  };
}

// =============================================================================
// EnvironmentStore — completely untested in the existing suite
// =============================================================================

describe("EnvironmentStore — first-run defaults", () => {
  let tmpDir, envStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    envStore = new Stores(tmpDir).environmentStore();
  });
  afterEach(() => rmTmpDir(tmpDir));

  test("getEnvironments returns version 1 by default", () => {
    const env = envStore.getEnvironments();
    assert.equal(env.version, 1);
  });

  test("getEnvironments returns empty environments list by default", () => {
    const env = envStore.getEnvironments();
    assert.deepEqual(env.environments, []);
  });

  test("getEnvironments returns empty global variables by default", () => {
    const env = envStore.getEnvironments();
    assert.deepEqual(env.globalVariables, {});
  });

  test("getEnvironments returns null activeEnvironmentId by default", () => {
    const env = envStore.getEnvironments();
    assert.equal(env.activeEnvironmentId, null);
  });
});

describe("EnvironmentStore — save and load round-trip", () => {
  let tmpDir, envStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    envStore = new Stores(tmpDir).environmentStore();
  });
  afterEach(() => rmTmpDir(tmpDir));

  test("saves and retrieves global variables", () => {
    const data = {
      version: 1,
      globalVariables: { baseUrl: "https://api.example.com", apiKey: "abc123" },
      activeEnvironmentId: null,
      environments: [],
    };
    envStore.saveEnvironments(data);
    const loaded = envStore.getEnvironments();
    assert.equal(loaded.globalVariables.baseUrl, "https://api.example.com");
    assert.equal(loaded.globalVariables.apiKey, "abc123");
  });

  test("saves and retrieves named environments", () => {
    const data = {
      version: 1,
      globalVariables: {},
      activeEnvironmentId: "env-staging",
      environments: [
        {
          id: "env-dev",
          name: "Development",
          variables: { host: "dev.api.com" },
        },
        {
          id: "env-staging",
          name: "Staging",
          variables: { host: "stg.api.com" },
        },
        { id: "env-prod", name: "Production", variables: { host: "api.com" } },
      ],
    };
    envStore.saveEnvironments(data);
    const loaded = envStore.getEnvironments();
    assert.equal(loaded.environments.length, 3);
    assert.equal(loaded.activeEnvironmentId, "env-staging");
    assert.equal(loaded.environments[1].variables.host, "stg.api.com");
  });

  test("overwrites previous data on repeated saves", () => {
    envStore.saveEnvironments({
      version: 1,
      globalVariables: { x: "1" },
      activeEnvironmentId: null,
      environments: [],
    });
    envStore.saveEnvironments({
      version: 1,
      globalVariables: { x: "2" },
      activeEnvironmentId: null,
      environments: [],
    });
    const loaded = envStore.getEnvironments();
    assert.equal(loaded.globalVariables.x, "2");
  });

  test("persists across separate store instances (cross-session)", () => {
    envStore.saveEnvironments({
      version: 1,
      globalVariables: { token: "session-token" },
      activeEnvironmentId: "env-1",
      environments: [{ id: "env-1", name: "Prod", variables: {} }],
    });

    const freshStore = new Stores(tmpDir).environmentStore();
    const loaded = freshStore.getEnvironments();
    assert.equal(loaded.globalVariables.token, "session-token");
    assert.equal(loaded.activeEnvironmentId, "env-1");
  });

  test("handles large variable sets without truncation", () => {
    const variables = {};
    for (let i = 0; i < 200; i++) {
      variables[`key${i}`] = `value${i}`;
    }
    envStore.saveEnvironments({
      version: 1,
      globalVariables: variables,
      activeEnvironmentId: null,
      environments: [],
    });
    const loaded = envStore.getEnvironments();
    assert.equal(Object.keys(loaded.globalVariables).length, 200);
    assert.equal(loaded.globalVariables.key199, "value199");
  });
});

// =============================================================================
// Manifest — multi-collection management
// =============================================================================

describe("Manifest — multi-collection lifecycle", () => {
  let tmpDir, manifest;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    manifest = new Stores(tmpDir).collectionStore();
  });
  afterEach(() => rmTmpDir(tmpDir));

  test("adding collections to manifest preserves list order", () => {
    manifest.saveManifest({
      version: 2,
      collections: [
        { id: "c1", name: "Alpha" },
        { id: "c2", name: "Beta" },
        { id: "c3", name: "Gamma" },
      ],
      activeCollectionId: "c1",
      settings: {},
    });
    const loaded = manifest.getManifest();
    assert.equal(loaded.collections[0].id, "c1");
    assert.equal(loaded.collections[2].id, "c3");
  });

  test("switching active collection persists", () => {
    manifest.saveManifest({
      version: 2,
      collections: [{ id: "c1" }, { id: "c2" }],
      activeCollectionId: "c1",
      settings: {},
    });
    manifest.saveManifest({
      version: 2,
      collections: [{ id: "c1" }, { id: "c2" }],
      activeCollectionId: "c2",
      settings: {},
    });
    assert.equal(manifest.getManifest().activeCollectionId, "c2");
  });

  test("settings round-trip: theme, fontSize, layout", () => {
    manifest.saveManifest({
      version: 2,
      collections: [],
      activeCollectionId: null,
      settings: {
        theme: "espresso",
        fontSize: 16,
        layout: "portrait",
        timeout: 30000,
      },
    });
    const loaded = manifest.getManifest();
    assert.equal(loaded.settings.theme, "espresso");
    assert.equal(loaded.settings.fontSize, 16);
    assert.equal(loaded.settings.layout, "portrait");
    assert.equal(loaded.settings.timeout, 30000);
  });

  test("removing a collection from manifest reflects in next load", () => {
    manifest.saveManifest({
      version: 2,
      collections: [{ id: "c1" }, { id: "c2" }],
      activeCollectionId: "c1",
      settings: {},
    });
    manifest.saveManifest({
      version: 2,
      collections: [{ id: "c1" }],
      activeCollectionId: "c1",
      settings: {},
    });
    const loaded = manifest.getManifest();
    assert.equal(loaded.collections.length, 1);
    assert.equal(loaded.collections[0].id, "c1");
  });
});

// =============================================================================
// Full Request Lifecycle — what the UI does when working with requests
// =============================================================================

describe("Request lifecycle — create, read, update, delete", () => {
  let tmpDir, stores;
  const COL = "col-lifecycle";

  beforeEach(() => {
    tmpDir = makeTmpDir();
    stores = makeStores(tmpDir);
    stores.collections.saveCollections(COL, { version: 1, collections: [] });
  });
  afterEach(() => rmTmpDir(tmpDir));

  test("UI create → read → update → delete round-trip", () => {
    const req = makeRequest({
      id: "req-full",
      method: "POST",
      url: "/api/v1/users",
    });
    const created = stores.requests.createRequest(COL, req);
    assert.equal(created.id, "req-full");

    const loaded = stores.requests.getRequest("req-full");
    assert.equal(loaded.method, "POST");
    assert.equal(loaded.url, "/api/v1/users");

    const updated = stores.requests.updateRequest("req-full", {
      url: "/api/v2/users",
      method: "PUT",
    });
    assert.equal(updated.url, "/api/v2/users");
    assert.equal(updated.method, "PUT");
    assert.equal(updated.name, "Test Request"); // unchanged

    stores.requests.deleteRequest("req-full");
    assert.throws(
      () => stores.requests.getRequest("req-full"),
      (err) => err.code === "NOT_FOUND",
    );
  });

  test("multiple requests in same collection stay isolated", () => {
    const r1 = stores.requests.createRequest(
      COL,
      makeRequest({ id: "r1", name: "Get Users" }),
    );
    const r2 = stores.requests.createRequest(
      COL,
      makeRequest({ id: "r2", name: "Create User" }),
    );
    const r3 = stores.requests.createRequest(
      COL,
      makeRequest({ id: "r3", name: "Delete User" }),
    );

    assert.equal(stores.requests.getRequest(r1.id).name, "Get Users");
    assert.equal(stores.requests.getRequest(r2.id).name, "Create User");
    assert.equal(stores.requests.getRequest(r3.id).name, "Delete User");
  });

  test("delete one request leaves others intact", () => {
    stores.requests.createRequest(COL, makeRequest({ id: "keep-1" }));
    stores.requests.createRequest(COL, makeRequest({ id: "delete-me" }));
    stores.requests.createRequest(COL, makeRequest({ id: "keep-2" }));

    stores.requests.deleteRequest("delete-me");

    assert.ok(stores.requests.getRequest("keep-1"));
    assert.ok(stores.requests.getRequest("keep-2"));
    assert.throws(
      () => stores.requests.getRequest("delete-me"),
      (err) => err.code === "NOT_FOUND",
    );
  });

  test("updateRequest preserves all non-patched fields", () => {
    const req = makeRequest({
      id: "req-preserve",
      headers: [
        { id: "h1", name: "X-Api-Key", value: "secret", enabled: true },
      ],
      params: [{ id: "p1", name: "limit", value: "50", enabled: true }],
      authType: "bearer",
      authBearer: { token: "my-token" },
    });
    stores.requests.createRequest(COL, req);
    stores.requests.updateRequest("req-preserve", { url: "/new-url" });

    const loaded = stores.requests.getRequest("req-preserve");
    assert.equal(loaded.url, "/new-url");
    assert.deepEqual(loaded.headers, req.headers);
    assert.deepEqual(loaded.params, req.params);
    assert.equal(loaded.authType, "bearer");
    assert.equal(loaded.authBearer.token, "my-token");
  });

  test("request with all auth types persists correctly", () => {
    const req = makeRequest({
      id: "req-auth",
      authEnabled: true,
      authType: "oauth2",
      authOAuth2: {
        grantType: "client_credentials",
        tokenUrl: "https://auth.example.com/token",
        clientId: "my-client",
        clientSecret: "my-secret",
        scope: "read:api",
      },
    });
    stores.requests.createRequest(COL, req);
    const loaded = stores.requests.getRequest("req-auth");
    assert.equal(loaded.authEnabled, true);
    assert.equal(loaded.authOAuth2.grantType, "client_credentials");
    assert.equal(loaded.authOAuth2.clientId, "my-client");
  });

  test("createRequest persists across separate Stores instances", () => {
    stores.requests.createRequest(
      COL,
      makeRequest({ id: "req-cross-session", name: "Cross Session" }),
    );

    const freshStores = makeStores(tmpDir);
    const loaded = freshStores.requests.getRequest("req-cross-session");
    assert.equal(loaded.name, "Cross Session");
  });
});

// =============================================================================
// History — full lifecycle including response, delete, trim
// =============================================================================

describe("History — add, list, retrieve response, delete", () => {
  let tmpDir, stores;
  const COL = "col-hist-full";
  const REQ = "req-hist-full";

  beforeEach(() => {
    tmpDir = makeTmpDir();
    stores = makeStores(tmpDir);
    stores.collections.saveCollections(COL, { version: 1, collections: [] });
    stores.requests.createRequest(COL, makeRequest({ id: REQ }));
  });
  afterEach(() => rmTmpDir(tmpDir));

  test("addHistory stores metadata and response separately", () => {
    const response = makeResponse({ body: '{"users":[]}', statusCode: 200 });
    const entry = stores.history.addHistory(
      REQ,
      makeHistoryEntry({ status: 200 }),
      response,
    );

    const listed = stores.history.listHistory(REQ);
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].id, entry.id);

    const resp = stores.history.getHistoryResponse(REQ, entry.id);
    assert.equal(resp.body, '{"users":[]}');
  });

  test("deleteHistory removes both metadata and response", () => {
    const entry = stores.history.addHistory(
      REQ,
      makeHistoryEntry(),
      makeResponse(),
    );

    stores.history.deleteHistory(REQ, entry.id);

    const listed = stores.history.listHistory(REQ);
    assert.equal(listed.items.length, 0);

    assert.throws(
      () => stores.history.getHistoryResponse(REQ, entry.id),
      (err) => err.code === "NOT_FOUND",
    );
  });

  test("deleteHistory on entry without response does not throw", () => {
    const entry = stores.history.addHistory(REQ, makeHistoryEntry());
    assert.doesNotThrow(() => stores.history.deleteHistory(REQ, entry.id));
    assert.equal(stores.history.listHistory(REQ).items.length, 0);
  });

  test("deleteHistory on non-existent entry is silent", () => {
    assert.doesNotThrow(() =>
      stores.history.deleteHistory(REQ, "ghost-hist-id"),
    );
  });

  test("history entries survive across Stores instances", () => {
    const response = makeResponse({ body: "persistent" });
    const entry = stores.history.addHistory(REQ, makeHistoryEntry(), response);

    const freshStores = makeStores(tmpDir);
    const resp = freshStores.history.getHistoryResponse(REQ, entry.id);
    assert.equal(resp.body, "persistent");
  });

  test("adding 15 entries then listing returns all newest-first", () => {
    const entries = [];
    for (let i = 1; i <= 15; i++) {
      const e = stores.history.addHistory(REQ, {
        id: `h-${String(i).padStart(3, "0")}`,
        timestamp: new Date(1_700_000_000_000 + i * 10_000).toISOString(),
        status: 200,
        durationMs: i,
      });
      entries.push(e);
    }

    const page = stores.history.listHistory(REQ, { limit: 100 });
    assert.equal(page.items.length, 15);
    assert.equal(page.items[0].id, "h-015"); // newest first
    assert.equal(page.items[14].id, "h-001");
  });

  test("three-page cursor-based pagination covers all entries exactly once", () => {
    for (let i = 1; i <= 12; i++) {
      stores.history.addHistory(REQ, {
        id: `pg-${String(i).padStart(3, "0")}`,
        timestamp: new Date(1_700_000_000_000 + i * 10_000).toISOString(),
        status: 200,
        durationMs: i,
      });
    }

    const page1 = stores.history.listHistory(REQ, { limit: 5 });
    const page2 = stores.history.listHistory(REQ, {
      limit: 5,
      cursor: page1.nextCursor,
    });
    const page3 = stores.history.listHistory(REQ, {
      limit: 5,
      cursor: page2.nextCursor,
    });

    assert.equal(page1.items.length, 5);
    assert.equal(page2.items.length, 5);
    assert.equal(page3.items.length, 2);
    assert.equal(page3.nextCursor, "");

    // All IDs should be distinct across all pages
    const allIds = [
      ...page1.items.map((e) => e.id),
      ...page2.items.map((e) => e.id),
      ...page3.items.map((e) => e.id),
    ];
    assert.equal(new Set(allIds).size, 12);
  });

  test("deleteHistory then subsequent listHistory is consistent", () => {
    stores.history.addHistory(REQ, {
      id: "keep-a",
      timestamp: new Date(1_700_000_001_000).toISOString(),
      status: 200,
      durationMs: 1,
    });
    const e2 = stores.history.addHistory(REQ, {
      id: "gone",
      timestamp: new Date(1_700_000_002_000).toISOString(),
      status: 404,
      durationMs: 2,
    });
    stores.history.addHistory(REQ, {
      id: "keep-b",
      timestamp: new Date(1_700_000_003_000).toISOString(),
      status: 201,
      durationMs: 3,
    });

    stores.history.deleteHistory(REQ, e2.id);

    const { items } = stores.history.listHistory(REQ, { limit: 100 });
    const ids = items.map((e) => e.id);
    assert.ok(!ids.includes("gone"), "deleted entry must not appear");
    assert.ok(ids.includes("keep-a"), "keep-a must still be present");
    assert.ok(ids.includes("keep-b"), "keep-b must still be present");
  });
});

// =============================================================================
// History trimming — trimAllHistory
// =============================================================================

describe("History trimming — trimAllHistory", () => {
  let tmpDir, stores;
  const COL = "col-trim";
  const REQ1 = "req-trim-1";
  const REQ2 = "req-trim-2";

  beforeEach(() => {
    tmpDir = makeTmpDir();
    stores = makeStores(tmpDir);
    stores.collections.saveCollections(COL, { version: 1, collections: [] });
    stores.requests.createRequest(COL, makeRequest({ id: REQ1 }));
    stores.requests.createRequest(COL, makeRequest({ id: REQ2 }));
  });
  afterEach(() => rmTmpDir(tmpDir));

  function addEntries(reqId, count) {
    for (let i = 1; i <= count; i++) {
      stores.history.addHistory(reqId, {
        id: `${reqId}-e${String(i).padStart(3, "0")}`,
        timestamp: new Date(1_700_000_000_000 + i * 10_000).toISOString(),
        status: 200,
        durationMs: i,
      });
    }
  }

  test("trimAllHistory(0) deletes all history for all requests", () => {
    addEntries(REQ1, 5);
    addEntries(REQ2, 3);

    stores.history.trimAllHistory(0);

    assert.equal(
      stores.history.listHistory(REQ1, { limit: 100 }).items.length,
      0,
    );
    assert.equal(
      stores.history.listHistory(REQ2, { limit: 100 }).items.length,
      0,
    );
  });

  test("trimAllHistory(2) keeps only the 2 newest entries per request", () => {
    addEntries(REQ1, 7);
    addEntries(REQ2, 5);

    stores.history.trimAllHistory(2);

    const page1 = stores.history.listHistory(REQ1, { limit: 100 });
    const page2 = stores.history.listHistory(REQ2, { limit: 100 });

    assert.equal(page1.items.length, 2);
    assert.equal(page2.items.length, 2);

    // Verify the two kept entries are the newest ones
    assert.equal(page1.items[0].id, `${REQ1}-e007`);
    assert.equal(page1.items[1].id, `${REQ1}-e006`);
  });

  test("trimAllHistory leaves requests themselves untouched", () => {
    addEntries(REQ1, 10);
    stores.history.trimAllHistory(0);
    assert.doesNotThrow(() => stores.requests.getRequest(REQ1));
  });

  test("trimAllHistory on empty directory is a no-op", () => {
    assert.doesNotThrow(() => stores.history.trimAllHistory(5));
    assert.equal(stores.history.listHistory(REQ1).items.length, 0);
  });

  test("trimAllHistory(max) when count == max makes no change", () => {
    addEntries(REQ1, 3);
    stores.history.trimAllHistory(3);
    assert.equal(
      stores.history.listHistory(REQ1, { limit: 100 }).items.length,
      3,
    );
  });

  test("trimAllHistory trims across multiple collections", () => {
    const COL2 = "col-trim-b";
    const REQ3 = "req-trim-3";
    stores.collections.saveCollections(COL2, { version: 1, collections: [] });
    stores.requests.createRequest(COL2, makeRequest({ id: REQ3 }));

    addEntries(REQ1, 5);
    addEntries(REQ3, 5);

    stores.history.trimAllHistory(2);

    assert.equal(
      stores.history.listHistory(REQ1, { limit: 100 }).items.length,
      2,
    );
    assert.equal(
      stores.history.listHistory(REQ3, { limit: 100 }).items.length,
      2,
    );
  });
});

// =============================================================================
// Multi-collection isolation — UI switches between collections
// =============================================================================

describe("Multi-collection isolation", () => {
  let tmpDir, stores;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    stores = makeStores(tmpDir);
  });
  afterEach(() => rmTmpDir(tmpDir));

  test("requests in different collections share no requestRef leakage", () => {
    stores.collections.saveCollections("colA", { version: 1, collections: [] });
    stores.collections.saveCollections("colB", { version: 1, collections: [] });

    stores.requests.createRequest(
      "colA",
      makeRequest({ id: "req-a", name: "Collection A Request" }),
    );
    stores.requests.createRequest(
      "colB",
      makeRequest({ id: "req-b", name: "Collection B Request" }),
    );

    // Each resolves to its own collection
    const resolver = new Resolver(new Paths(tmpDir));
    assert.equal(resolver.resolve("req-a"), "colA");
    assert.equal(resolver.resolve("req-b"), "colB");

    assert.equal(
      stores.requests.getRequest("req-a").name,
      "Collection A Request",
    );
    assert.equal(
      stores.requests.getRequest("req-b").name,
      "Collection B Request",
    );
  });

  test("history for collection A does not appear in collection B requests", () => {
    stores.collections.saveCollections("colA", { version: 1, collections: [] });
    stores.collections.saveCollections("colB", { version: 1, collections: [] });

    stores.requests.createRequest("colA", makeRequest({ id: "req-col-a" }));
    stores.requests.createRequest("colB", makeRequest({ id: "req-col-b" }));

    stores.history.addHistory(
      "req-col-a",
      makeHistoryEntry({ status: 200 }),
      makeResponse({ body: "from colA" }),
    );

    assert.equal(stores.history.listHistory("req-col-a").items.length, 1);
    assert.equal(stores.history.listHistory("req-col-b").items.length, 0);
  });

  test("deleting all requests from one collection leaves the other intact", () => {
    stores.collections.saveCollections("keep", { version: 1, collections: [] });
    stores.collections.saveCollections("wipe", { version: 1, collections: [] });

    stores.requests.createRequest("keep", makeRequest({ id: "keep-req-1" }));
    stores.requests.createRequest("keep", makeRequest({ id: "keep-req-2" }));
    stores.requests.createRequest("wipe", makeRequest({ id: "wipe-req-1" }));
    stores.requests.createRequest("wipe", makeRequest({ id: "wipe-req-2" }));

    stores.requests.deleteRequest("wipe-req-1");
    stores.requests.deleteRequest("wipe-req-2");

    assert.doesNotThrow(() => stores.requests.getRequest("keep-req-1"));
    assert.doesNotThrow(() => stores.requests.getRequest("keep-req-2"));
  });

  test("collections data is scoped per collection ID", () => {
    stores.collections.saveCollections("colX", {
      version: 1,
      variables: { env: "X" },
      collections: [
        { id: "root-x", type: "collection", name: "Root X", children: [] },
      ],
    });
    stores.collections.saveCollections("colY", {
      version: 1,
      variables: { env: "Y" },
      collections: [
        { id: "root-y", type: "collection", name: "Root Y", children: [] },
      ],
    });

    const x = stores.collections.getCollections("colX");
    const y = stores.collections.getCollections("colY");

    assert.equal(x.variables.env, "X");
    assert.equal(y.variables.env, "Y");
    assert.equal(x.collections[0].name, "Root X");
    assert.equal(y.collections[0].name, "Root Y");
  });
});

// =============================================================================
// ID validation and security — prevent directory traversal
// =============================================================================

describe("ID validation — security boundaries", () => {
  let tmpDir, stores;
  const COL = "col-sec";

  beforeEach(() => {
    tmpDir = makeTmpDir();
    stores = makeStores(tmpDir);
    stores.collections.saveCollections(COL, { version: 1, collections: [] });
  });
  afterEach(() => rmTmpDir(tmpDir));

  const TRAVERSAL_IDS = [
    "../../../etc/passwd",
    "..\\..\\windows\\system32",
    "foo/../bar",
    "./relative",
    "..",
    ".",
  ];

  const FORBIDDEN_CHAR_IDS = [
    "id with/slash",
    "id with\\backslash",
    "id<with>angle",
    "id:colon",
    'id"quote',
    "id|pipe",
    "id?question",
    "id*star",
    "id\x00null",
    "id\x1fcontrol",
  ];

  for (const badId of TRAVERSAL_IDS) {
    test(`validateID rejects traversal attempt: ${JSON.stringify(badId)}`, () => {
      assert.throws(
        () => validateID(badId),
        (err) => err.code === "INVALID_ID",
      );
    });
  }

  for (const badId of FORBIDDEN_CHAR_IDS) {
    test(`validateID rejects forbidden chars: ${JSON.stringify(badId)}`, () => {
      assert.throws(
        () => validateID(badId),
        (err) => err.code === "INVALID_ID",
      );
    });
  }

  test("validateID rejects empty string", () => {
    assert.throws(
      () => validateID(""),
      (err) => err.code === "INVALID_ID",
    );
  });

  test("validateID rejects non-string values", () => {
    assert.throws(
      () => validateID(null),
      (err) => err.code === "INVALID_ID",
    );
    assert.throws(
      () => validateID(undefined),
      (err) => err.code === "INVALID_ID",
    );
    assert.throws(
      () => validateID(42),
      (err) => err.code === "INVALID_ID",
    );
    assert.throws(
      () => validateID({}),
      (err) => err.code === "INVALID_ID",
    );
  });

  test("getRequest with traversal ID throws INVALID_ID not NOT_FOUND", () => {
    assert.throws(
      () => stores.requests.getRequest("../../../evil"),
      (err) => err.code === "INVALID_ID",
    );
  });

  test("createRequest with traversal collectionId throws INVALID_ID", () => {
    assert.throws(
      () => stores.requests.createRequest("../../../evil", makeRequest()),
      (err) => err.code === "INVALID_ID",
    );
  });

  test("valid UUIDs and slug-style IDs are accepted", () => {
    assert.doesNotThrow(() =>
      validateID("550e8400-e29b-41d4-a716-446655440000"),
    );
    assert.doesNotThrow(() => validateID("my-collection-01"));
    assert.doesNotThrow(() => validateID("req_get_users"));
    assert.doesNotThrow(() => validateID("col.v2"));
  });

  test("updateRequest with traversal ID throws INVALID_ID", () => {
    assert.throws(
      () => stores.requests.updateRequest("../../evil", { name: "x" }),
      (err) => err.code === "INVALID_ID",
    );
  });

  test("deleteRequest with traversal ID throws INVALID_ID", () => {
    assert.throws(
      () => stores.requests.deleteRequest("../../evil"),
      (err) => err.code === "INVALID_ID",
    );
  });

  test("listHistory with traversal requestId throws INVALID_ID", () => {
    assert.throws(
      () => stores.history.listHistory("../../evil"),
      (err) => err.code === "INVALID_ID",
    );
  });
});

// =============================================================================
// Tree store — nested folder structures
// =============================================================================

describe("Tree store — nested folder structures", () => {
  let tmpDir, stores;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    stores = makeStores(tmpDir);
  });
  afterEach(() => rmTmpDir(tmpDir));

  test("tree with multiple folders persists hierarchy", () => {
    const COL = "col-tree-nested";
    stores.collections.saveCollections(COL, {
      version: 1,
      collections: [
        {
          id: "f1",
          type: "folder",
          name: "Users",
          children: [makeRequest({ id: "req-users-list" })],
        },
        {
          id: "f2",
          type: "folder",
          name: "Posts",
          children: [
            makeRequest({ id: "req-posts-list" }),
            makeRequest({ id: "req-posts-create" }),
          ],
        },
      ],
    });

    const tree = {
      children: [
        {
          id: "f1",
          type: "folder",
          name: "Users",
          children: [{ id: "req-users-list", type: "requestRef" }],
        },
        {
          id: "f2",
          type: "folder",
          name: "Posts",
          children: [
            { id: "req-posts-list", type: "requestRef" },
            { id: "req-posts-create", type: "requestRef" },
          ],
        },
      ],
    };

    stores.tree.saveTree(COL, tree);
    const loaded = stores.tree.getTree(COL);
    assert.equal(loaded.children.length, 2);
    assert.equal(loaded.children[0].children.length, 1);
    assert.equal(loaded.children[1].children.length, 2);
  });

  test("tree with deeply nested folders persists all levels", () => {
    const COL = "col-tree-deep";
    stores.collections.saveCollections(COL, { version: 1, collections: [] });
    stores.requests.createRequest(COL, makeRequest({ id: "req-deep" }));

    const deepTree = {
      children: [
        {
          id: "folder-a",
          type: "folder",
          name: "A",
          children: [
            {
              id: "folder-b",
              type: "folder",
              name: "B",
              children: [
                {
                  id: "folder-c",
                  type: "folder",
                  name: "C",
                  children: [{ id: "req-deep", type: "requestRef" }],
                },
              ],
            },
          ],
        },
      ],
    };

    stores.tree.saveTree(COL, deepTree);
    const loaded = stores.tree.getTree(COL);
    assert.equal(
      loaded.children[0].children[0].children[0].children[0].id,
      "req-deep",
    );
  });

  test("saveTree rejects dangling requestRef not backed by a request file", () => {
    const COL = "col-tree-ghost";
    stores.collections.saveCollections(COL, { version: 1, collections: [] });

    assert.throws(
      () =>
        stores.tree.saveTree(COL, {
          children: [{ id: "ghost-req", type: "requestRef" }],
        }),
      (err) => err.code === "NOT_FOUND",
    );
  });

  test("getTree returns empty tree for unknown collection", () => {
    const t = stores.tree.getTree("no-such-col");
    assert.deepEqual(t, { children: [] });
  });
});

// =============================================================================
// Cross-store consistency — what the UI relies on across store boundaries
// =============================================================================

describe("Cross-store consistency", () => {
  let tmpDir, stores;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    stores = makeStores(tmpDir);
  });
  afterEach(() => rmTmpDir(tmpDir));

  test("resolver shared: createRequest via requestStore is resolvable by historyStore", () => {
    stores.collections.saveCollections("col-shared", {
      version: 1,
      collections: [],
    });
    const req = stores.requests.createRequest(
      "col-shared",
      makeRequest({ id: "req-shared" }),
    );

    assert.doesNotThrow(() =>
      stores.history.addHistory(req.id, makeHistoryEntry(), makeResponse()),
    );
  });

  test("after deleteRequest the resolver no longer maps the ID", () => {
    stores.collections.saveCollections("col-del", {
      version: 1,
      collections: [],
    });
    stores.requests.createRequest("col-del", makeRequest({ id: "req-del" }));
    stores.requests.deleteRequest("req-del");

    assert.throws(
      () => stores.requests.getRequest("req-del"),
      (err) => err.code === "NOT_FOUND",
    );
  });

  test("saveCollections bulk write populates the resolver for requestStore", () => {
    stores.collections.saveCollections("col-bulk", {
      version: 1,
      collections: [
        {
          id: "folder-bulk",
          type: "collection",
          name: "Bulk",
          children: [makeRequest({ id: "req-from-bulk" })],
        },
      ],
    });

    // requestStore should find it via the resolver
    const loaded = stores.requests.getRequest("req-from-bulk");
    assert.equal(loaded.id, "req-from-bulk");
  });

  test("complete UI session: create collection → add requests → run → history → delete", () => {
    const COL = "col-session";
    stores.manifest.saveManifest({
      version: 2,
      collections: [{ id: COL, name: "My API" }],
      activeCollectionId: COL,
      settings: {},
    });
    stores.collections.saveCollections(COL, { version: 1, collections: [] });

    // User creates 2 requests
    const r1 = stores.requests.createRequest(
      COL,
      makeRequest({ id: "sess-r1", name: "List Items" }),
    );
    const r2 = stores.requests.createRequest(
      COL,
      makeRequest({ id: "sess-r2", name: "Create Item" }),
    );

    // User executes them (history is recorded)
    stores.history.addHistory(
      r1.id,
      makeHistoryEntry({ status: 200 }),
      makeResponse({ body: "[]" }),
    );
    stores.history.addHistory(
      r1.id,
      makeHistoryEntry({ status: 200 }),
      makeResponse({ body: "[{id:1}]" }),
    );
    stores.history.addHistory(
      r2.id,
      makeHistoryEntry({ status: 201 }),
      makeResponse({ body: "{}" }),
    );

    // Verify history
    assert.equal(stores.history.listHistory(r1.id).items.length, 2);
    assert.equal(stores.history.listHistory(r2.id).items.length, 1);

    // User deletes r2
    stores.requests.deleteRequest(r2.id);

    // r1 still has history and is accessible
    assert.doesNotThrow(() => stores.requests.getRequest(r1.id));
    assert.equal(stores.history.listHistory(r1.id).items.length, 2);

    // r2 is gone from the store
    assert.throws(
      () => stores.requests.getRequest(r2.id),
      (err) => err.code === "NOT_FOUND",
    );
  });
});

// =============================================================================
// Resolver — cache invalidation and multi-collection edge cases
// =============================================================================

describe("Resolver — cache invalidation and edge cases", () => {
  let tmpDir, ss;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    ss = new Stores(tmpDir);
  });
  afterEach(() => rmTmpDir(tmpDir));

  test("fresh Resolver built from disk sees requests created by another instance", () => {
    ss.collectionsStore().saveCollections("col-disk", {
      version: 1,
      collections: [
        {
          id: "f1",
          type: "collection",
          name: "F1",
          children: [makeRequest({ id: "req-disk" })],
        },
      ],
    });

    const freshResolver = new Resolver(new Paths(tmpDir));
    assert.equal(freshResolver.resolve("req-disk"), "col-disk");
  });

  test("resolver.remove then resolve throws NOT_FOUND", () => {
    const resolver = new Resolver(new Paths(tmpDir));
    resolver.set("req-temp", "col-temp");
    resolver.remove("req-temp");
    assert.throws(
      () => resolver.resolve("req-temp"),
      (err) => err.code === "NOT_FOUND",
    );
  });

  test("invalidate forces rebuild from disk on next resolve", () => {
    const resolver = new Resolver(new Paths(tmpDir));

    // Disk state added after resolver was constructed
    ss.collectionsStore().saveCollections("col-late", {
      version: 1,
      collections: [
        {
          id: "f1",
          type: "collection",
          name: "F",
          children: [makeRequest({ id: "req-late" })],
        },
      ],
    });

    resolver.invalidate();
    assert.equal(resolver.resolve("req-late"), "col-late");
  });

  test("two requests with different IDs in different collections resolve independently", () => {
    const resolver = new Resolver(new Paths(tmpDir));
    resolver.set("rx", "colA");
    resolver.set("ry", "colB");
    assert.equal(resolver.resolve("rx"), "colA");
    assert.equal(resolver.resolve("ry"), "colB");
  });
});

// =============================================================================
// Atomic write — correctness and idempotency
// =============================================================================

describe("Atomic write — data integrity", () => {
  let tmpDir, stores;
  const COL = "col-atomic";

  beforeEach(() => {
    tmpDir = makeTmpDir();
    stores = makeStores(tmpDir);
    stores.collections.saveCollections(COL, { version: 1, collections: [] });
  });
  afterEach(() => rmTmpDir(tmpDir));

  test("overwriting a request stores the latest version only", () => {
    stores.requests.createRequest(
      COL,
      makeRequest({ id: "req-overwrite", name: "Original" }),
    );
    stores.requests.updateRequest("req-overwrite", { name: "Updated" });
    stores.requests.updateRequest("req-overwrite", { name: "Final" });

    const loaded = stores.requests.getRequest("req-overwrite");
    assert.equal(loaded.name, "Final");

    // Verify there is exactly one request file on disk
    const p = new Paths(tmpDir);
    const reqFile = p.requestPath(COL, "req-overwrite");
    assert.ok(fs.existsSync(reqFile));
  });

  test("no residual .tmp files after successful write", () => {
    stores.requests.createRequest(COL, makeRequest({ id: "req-tmp-check" }));
    const reqDir = new Paths(tmpDir).requestsDir(COL);
    const tmpFiles = fs.readdirSync(reqDir).filter((f) => f.endsWith(".tmp"));
    assert.equal(tmpFiles.length, 0, "no .tmp files should remain");
  });

  test("manifest write is idempotent — same data produces same outcome", () => {
    const data = {
      version: 2,
      collections: [{ id: "c1", name: "Test" }],
      activeCollectionId: "c1",
      settings: { theme: "dark" },
    };
    stores.manifest.saveManifest(data);
    stores.manifest.saveManifest(data);
    stores.manifest.saveManifest(data);

    const loaded = stores.manifest.getManifest();
    assert.equal(loaded.collections.length, 1);
    assert.equal(loaded.settings.theme, "dark");
  });
});

// =============================================================================
// Variables — collection-level and nested scope preservation
// =============================================================================

describe("Variable scoping — collections and nested folders", () => {
  let tmpDir, stores;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    stores = makeStores(tmpDir);
  });
  afterEach(() => rmTmpDir(tmpDir));

  test("collection-level variables persist and are distinct from other collections", () => {
    stores.collections.saveCollections("colVarA", {
      version: 1,
      variables: { base: "https://a.com", key: "keyA" },
      collections: [],
    });
    stores.collections.saveCollections("colVarB", {
      version: 1,
      variables: { base: "https://b.com", key: "keyB" },
      collections: [],
    });

    const a = stores.collections.getCollections("colVarA");
    const b = stores.collections.getCollections("colVarB");

    assert.equal(a.variables.base, "https://a.com");
    assert.equal(b.variables.base, "https://b.com");
    assert.notEqual(a.variables.key, b.variables.key);
  });

  test("folder-level variables within a collection are preserved", () => {
    stores.collections.saveCollections("colVarFolders", {
      version: 1,
      variables: { global: "gval" },
      collections: [
        {
          id: "f1",
          type: "collection",
          name: "Users Folder",
          variables: { scope: "users" },
          children: [],
        },
        {
          id: "f2",
          type: "collection",
          name: "Admin Folder",
          variables: { scope: "admin" },
          children: [],
        },
      ],
    });

    const loaded = stores.collections.getCollections("colVarFolders");
    assert.equal(loaded.variables.global, "gval");
    assert.equal(loaded.collections[0].variables.scope, "users");
    assert.equal(loaded.collections[1].variables.scope, "admin");
  });

  test("deeply nested folder variables are preserved at all levels", () => {
    stores.collections.saveCollections("colVarDeep", {
      version: 1,
      variables: { level: "root" },
      collections: [
        {
          id: "l1",
          type: "collection",
          name: "Level 1",
          variables: { level: "one" },
          children: [
            {
              id: "l2",
              type: "collection",
              name: "Level 2",
              variables: { level: "two" },
              children: [
                {
                  id: "l3",
                  type: "collection",
                  name: "Level 3",
                  variables: { level: "three" },
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    });

    const loaded = stores.collections.getCollections("colVarDeep");
    assert.equal(loaded.variables.level, "root");
    assert.equal(loaded.collections[0].variables.level, "one");
    assert.equal(loaded.collections[0].children[0].variables.level, "two");
    assert.equal(
      loaded.collections[0].children[0].children[0].variables.level,
      "three",
    );
  });
});

// =============================================================================
// Edge cases — boundary conditions and error paths
// =============================================================================

describe("Edge cases — boundary conditions", () => {
  let tmpDir, stores;
  const COL = "col-edge";

  beforeEach(() => {
    tmpDir = makeTmpDir();
    stores = makeStores(tmpDir);
    stores.collections.saveCollections(COL, { version: 1, collections: [] });
  });
  afterEach(() => rmTmpDir(tmpDir));

  test("listHistory limit=1 returns only the single newest entry", () => {
    const REQ = "req-limit-edge";
    stores.requests.createRequest(COL, makeRequest({ id: REQ }));
    for (let i = 1; i <= 5; i++) {
      stores.history.addHistory(REQ, {
        id: `le-${i}`,
        timestamp: new Date(1_700_000_000_000 + i * 1_000).toISOString(),
        status: 200,
        durationMs: i,
      });
    }
    const { items, nextCursor } = stores.history.listHistory(REQ, { limit: 1 });
    assert.equal(items.length, 1);
    assert.equal(items[0].id, "le-5");
    assert.ok(nextCursor !== "");
  });

  test("listHistory limit > MAX_LIMIT is clamped to 100", () => {
    const REQ = "req-clamp";
    stores.requests.createRequest(COL, makeRequest({ id: REQ }));
    for (let i = 1; i <= 5; i++) {
      stores.history.addHistory(REQ, { status: 200, durationMs: i });
    }
    const { items } = stores.history.listHistory(REQ, { limit: 9999 });
    assert.equal(items.length, 5); // only 5 exist; clamping doesn't break anything
  });

  test("request with empty body and no auth fields round-trips cleanly", () => {
    const req = makeRequest({
      id: "req-minimal",
      bodyType: "none",
      authEnabled: false,
    });
    stores.requests.createRequest(COL, req);
    const loaded = stores.requests.getRequest("req-minimal");
    assert.equal(loaded.bodyType, "none");
    assert.equal(loaded.authEnabled, false);
  });

  test("request with Unicode in name and URL persists correctly", () => {
    const req = makeRequest({
      id: "req-unicode",
      name: "Ünïcödé Rëqüëst 🚀",
      url: "https://api.example.com/données?q=café",
    });
    stores.requests.createRequest(COL, req);
    const loaded = stores.requests.getRequest("req-unicode");
    assert.equal(loaded.name, "Ünïcödé Rëqüëst 🚀");
    assert.equal(loaded.url, "https://api.example.com/données?q=café");
  });

  test("request with very long URL persists without truncation", () => {
    const longUrl = "https://api.example.com/" + "x".repeat(4096);
    stores.requests.createRequest(
      COL,
      makeRequest({ id: "req-longurl", url: longUrl }),
    );
    const loaded = stores.requests.getRequest("req-longurl");
    assert.equal(loaded.url, longUrl);
  });

  test("history entry with very large response body persists correctly", () => {
    const REQ = "req-big-body";
    stores.requests.createRequest(COL, makeRequest({ id: REQ }));
    const bigBody = JSON.stringify({ data: "x".repeat(100_000) });
    const entry = stores.history.addHistory(
      REQ,
      makeHistoryEntry(),
      makeResponse({ body: bigBody }),
    );
    const resp = stores.history.getHistoryResponse(REQ, entry.id);
    assert.equal(resp.body, bigBody);
  });

  test("manifest with many settings fields round-trips completely", () => {
    const settings = {
      theme: "mocha",
      fontSize: 14,
      fontFamily: "JetBrains Mono",
      layout: "landscape",
      timeout: 60000,
      sslVerify: false,
      followRedirects: true,
      historyCount: 5,
      showListHeaders: true,
      bulkEditorMode: false,
      doubleClickExecute: true,
    };
    stores.manifest.saveManifest({
      version: 2,
      collections: [],
      activeCollectionId: null,
      settings,
    });
    const loaded = stores.manifest.getManifest();
    assert.equal(loaded.settings.theme, "mocha");
    assert.equal(loaded.settings.sslVerify, false);
    assert.equal(loaded.settings.historyCount, 5);
    assert.equal(loaded.settings.doubleClickExecute, true);
  });

  test("getHistoryResponse throws NOT_FOUND for valid requestId but missing histId", () => {
    const REQ = "req-missing-resp";
    stores.requests.createRequest(COL, makeRequest({ id: REQ }));
    assert.throws(
      () => stores.history.getHistoryResponse(REQ, "missing-hist-id"),
      (err) => err.code === "NOT_FOUND",
    );
  });

  test("environment with 0 named environments and empty global variables is valid", () => {
    const envStore = stores.environments;
    envStore.saveEnvironments({
      version: 1,
      globalVariables: {},
      activeEnvironmentId: null,
      environments: [],
    });
    const loaded = envStore.getEnvironments();
    assert.deepEqual(loaded.globalVariables, {});
    assert.deepEqual(loaded.environments, []);
  });
});
