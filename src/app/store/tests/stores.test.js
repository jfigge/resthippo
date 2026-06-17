/**
 * stores.test.js — Unit + integration tests for the Electron storage layer.
 *
 * Each test suite creates a fresh temp directory and cleans it up on completion,
 * so tests are fully isolated from each other and from production data.
 *
 * Run with:
 *   node --test src/app/store/tests/stores.test.js
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
const { CollectionsStore } = require("../collections-store");
const { _setSafeStorage } = require("../crypto");

// ── Helper: temp directory lifecycle ──────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wurl-test-"));
}

function rmTmpDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Helper: fixture request ────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// CollectionStore
// ─────────────────────────────────────────────────────────────────────────────

describe("CollectionStore", () => {
  let tmpDir;
  let store;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new Stores(tmpDir).collectionStore();
  });

  afterEach(() => rmTmpDir(tmpDir));

  test("getManifest returns default on first run", () => {
    const manifest = store.getManifest();
    assert.deepEqual(manifest.collections, []);
    assert.equal(manifest.activeCollectionId, null);
  });

  test("saveManifest then getManifest round-trips correctly", () => {
    const data = {
      version: 2,
      collections: [{ id: "env-1", name: "Dev" }],
      activeCollectionId: "env-1",
      settings: { theme: "mocha", fontSize: 14 },
    };
    store.saveManifest(data);
    const loaded = store.getManifest();
    assert.deepEqual(loaded.collections, data.collections);
    assert.equal(loaded.activeCollectionId, "env-1");
    assert.equal(loaded.settings.theme, "mocha");
  });

  test("saveManifest creates directories if needed", () => {
    // dataDir/collections/ does not exist yet
    const nested = makeTmpDir();
    rmTmpDir(nested); // remove so it doesn't exist pre-write
    const s = new Stores(nested).collectionStore();
    assert.doesNotThrow(() => s.saveManifest({ version: 2, collections: [] }));
    rmTmpDir(nested);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CollectionsStore
// ─────────────────────────────────────────────────────────────────────────────

describe("CollectionsStore", () => {
  let tmpDir;
  let ss;
  let store;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    ss = new Stores(tmpDir);
    store = ss.collectionsStore();
  });

  afterEach(() => rmTmpDir(tmpDir));

  test("getCollections returns minimal default on first run", () => {
    const env = store.getCollections("env-abc");
    assert.deepEqual(env.collections, []);
  });

  test("saveCollections then getCollections round-trips nested structure", () => {
    const req = makeRequest({ id: "r1", name: "First", method: "POST" });
    const data = {
      version: 1,
      variables: [
        { name: "baseUrl", value: "https://api.example.com", secure: false },
      ],
      collections: [
        {
          id: "col-1",
          type: "collection",
          name: "My API",
          variables: [{ name: "v", value: "1", secure: false }],
          children: [req],
        },
      ],
    };

    store.saveCollections("env-x", data);
    const loaded = store.getCollections("env-x");

    assert.equal(
      loaded.variables.find((v) => v.name === "baseUrl").value,
      "https://api.example.com",
    );
    assert.equal(loaded.collections.length, 1);
    assert.equal(loaded.collections[0].name, "My API");
    assert.equal(loaded.collections[0].children.length, 1);
    assert.equal(loaded.collections[0].children[0].id, "r1");
    assert.equal(loaded.collections[0].children[0].method, "POST");
  });

  test("saveCollections writes individual request files", () => {
    const p = new Paths(tmpDir);
    const req = makeRequest({ id: "req-file-test" });
    store.saveCollections("env-y", {
      version: 1,
      collections: [
        { id: "c1", type: "collection", name: "C1", children: [req] },
      ],
    });

    const reqFile = p.requestPath("env-y", "req-file-test");
    assert.ok(fs.existsSync(reqFile), "request file should exist");
    const stored = JSON.parse(fs.readFileSync(reqFile, "utf8"));
    assert.equal(stored.id, "req-file-test");
  });

  test("saveCollections invalidates the resolver cache", () => {
    const resolver = new Resolver(new Paths(tmpDir));
    const envStore = new CollectionsStore(new Paths(tmpDir), resolver);

    const req = makeRequest({ id: "req-cache" });
    envStore.saveCollections("env-z", {
      version: 1,
      collections: [
        { id: "c1", type: "collection", name: "C", children: [req] },
      ],
    });

    // Resolver cache should have been invalidated; a fresh resolve should work.
    const collId = resolver.resolve("req-cache");
    assert.equal(collId, "env-z");
  });

  test("preserves variables for nested collections", () => {
    const inner = makeRequest({ id: "inner-req" });
    const data = {
      version: 1,
      collections: [
        {
          id: "outer",
          type: "collection",
          name: "Outer",
          variables: [{ name: "a", value: "1", secure: false }],
          children: [
            {
              id: "inner",
              type: "collection",
              name: "Inner",
              variables: [{ name: "b", value: "2", secure: false }],
              children: [inner],
            },
          ],
        },
      ],
    };
    store.saveCollections("env-nested", data);
    const loaded = store.getCollections("env-nested");
    assert.equal(
      loaded.collections[0].variables.find((v) => v.name === "a").value,
      "1",
    );
    assert.equal(
      loaded.collections[0].children[0].variables.find((v) => v.name === "b")
        .value,
      "2",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TreeStore
// ─────────────────────────────────────────────────────────────────────────────

describe("TreeStore", () => {
  let tmpDir;
  let ss;
  let treeStore;
  let envStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    ss = new Stores(tmpDir);
    treeStore = ss.treeStore();
    envStore = ss.collectionsStore();
  });

  afterEach(() => rmTmpDir(tmpDir));

  test("getTree returns empty tree on first run", () => {
    const t = treeStore.getTree("col-empty");
    assert.deepEqual(t, { children: [] });
  });

  test("saveTree then getTree round-trips correctly", () => {
    // Seed a request file so the ref is valid.
    envStore.saveCollections("col-t1", {
      version: 1,
      collections: [
        {
          id: "folder-1",
          type: "collection",
          name: "Folder",
          children: [makeRequest({ id: "req-tree-1" })],
        },
      ],
    });

    const tree = {
      children: [
        {
          id: "folder-1",
          type: "folder",
          name: "Folder",
          children: [{ id: "req-tree-1", type: "requestRef" }],
        },
      ],
    };
    treeStore.saveTree("col-t1", tree);
    const loaded = treeStore.getTree("col-t1");
    assert.equal(loaded.children.length, 1);
    assert.equal(loaded.children[0].id, "folder-1");
    assert.equal(loaded.children[0].children[0].id, "req-tree-1");
  });

  test("saveTree rejects dangling requestRef", () => {
    // No request file for "ghost-req"
    const tree = { children: [{ id: "ghost-req", type: "requestRef" }] };
    assert.throws(
      () => treeStore.saveTree("col-ghost", tree),
      (err) => err.code === "NOT_FOUND",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RequestStore
// ─────────────────────────────────────────────────────────────────────────────

describe("RequestStore", () => {
  let tmpDir;
  let ss;
  let reqStore;
  let envStore;
  const COL = "col-req";

  beforeEach(() => {
    tmpDir = makeTmpDir();
    ss = new Stores(tmpDir);
    reqStore = ss.requestStore();
    envStore = ss.collectionsStore();

    // Seed an empty collection so the resolver knows about it.
    envStore.saveCollections(COL, { version: 1, collections: [] });
  });

  afterEach(() => rmTmpDir(tmpDir));

  test("getRequest throws NOT_FOUND for unknown ID", () => {
    assert.throws(
      () => reqStore.getRequest("no-such-req"),
      (err) => err.code === "NOT_FOUND",
    );
  });

  test("createRequest assigns ID if absent", () => {
    const req = reqStore.createRequest(COL, {
      name: "No ID",
      method: "GET",
      url: "/",
    });
    assert.ok(req.id, "should have been assigned an ID");
    assert.equal(req.type, "request");
  });

  test("createRequest → getRequest round-trip", () => {
    const req = makeRequest({ id: "req-roundtrip" });
    const created = reqStore.createRequest(COL, req);
    const loaded = reqStore.getRequest(created.id);
    assert.equal(loaded.id, "req-roundtrip");
    assert.equal(loaded.method, "GET");
    assert.equal(loaded.url, "https://example.com");
  });

  test("createRequest appends requestRef to tree.json", () => {
    const req = makeRequest({ id: "req-tree-append" });
    reqStore.createRequest(COL, req);

    const treeFile = new Paths(tmpDir).treePath(COL);
    const tree = JSON.parse(fs.readFileSync(treeFile, "utf8"));
    const allIds = _flattenRefs(tree.children);
    assert.ok(
      allIds.includes("req-tree-append"),
      "requestRef should be in tree",
    );
  });

  test("updateRequest applies partial patch", () => {
    const req = makeRequest({ id: "req-patch", method: "GET", url: "/old" });
    reqStore.createRequest(COL, req);

    const updated = reqStore.updateRequest("req-patch", {
      url: "/new",
      method: "POST",
    });
    assert.equal(updated.url, "/new");
    assert.equal(updated.method, "POST");
    assert.equal(updated.name, "Test Request"); // unchanged

    // Persisted value should also reflect the patch.
    const reloaded = reqStore.getRequest("req-patch");
    assert.equal(reloaded.url, "/new");
  });

  test("updateRequest persists the notes field (PATCHABLE_FIELDS regression)", () => {
    reqStore.createRequest(COL, makeRequest({ id: "req-notes", url: "/x" }));
    const updated = reqStore.updateRequest("req-notes", {
      notes: "remember the milk",
    });
    assert.equal(updated.notes, "remember the milk");
    // Persisted, not merely returned — proves notes is on the patch allowlist
    // (a granular edit must not silently drop the notes tab).
    assert.equal(reqStore.getRequest("req-notes").notes, "remember the milk");
  });

  test("updateRequest preserves fields not in patch", () => {
    const req = makeRequest({
      id: "req-preserve",
      headers: [{ id: "h1", name: "X-Foo", value: "bar", enabled: true }],
    });
    reqStore.createRequest(COL, req);
    reqStore.updateRequest("req-preserve", { name: "New Name" });
    const loaded = reqStore.getRequest("req-preserve");
    assert.deepEqual(loaded.headers, req.headers);
  });

  test("updateRequest throws NOT_FOUND for missing request", () => {
    assert.throws(
      () => reqStore.updateRequest("ghost", { name: "X" }),
      (err) => err.code === "NOT_FOUND",
    );
  });

  test("deleteRequest removes the request", () => {
    const req = makeRequest({ id: "req-delete" });
    reqStore.createRequest(COL, req);
    reqStore.deleteRequest("req-delete");
    assert.throws(
      () => reqStore.getRequest("req-delete"),
      (err) => err.code === "NOT_FOUND",
    );
  });

  test("deleteRequest removes requestRef from tree.json", () => {
    const req = makeRequest({ id: "req-tree-remove" });
    reqStore.createRequest(COL, req);
    reqStore.deleteRequest("req-tree-remove");

    const treeFile = new Paths(tmpDir).treePath(COL);
    const tree = JSON.parse(fs.readFileSync(treeFile, "utf8"));
    const allIds = _flattenRefs(tree.children);
    assert.ok(
      !allIds.includes("req-tree-remove"),
      "requestRef should be gone from tree",
    );
  });

  test("deleteRequest throws NOT_FOUND for missing request", () => {
    assert.throws(
      () => reqStore.deleteRequest("ghost"),
      (err) => err.code === "NOT_FOUND",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RequestStore — decrypt-failure clobber guard
// ─────────────────────────────────────────────────────────────────────────────

describe("RequestStore decrypt-failure clobber guard", () => {
  let tmpDir;
  let reqStore;
  const COL = "col-clobber";
  const REQ = "req-clobber";

  // Reversible mock: encrypts on write, decrypts on read. Used so createRequest
  // produces a real enc:v1: ciphertext on disk that we can later observe.
  const reversible = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`PT:${s}`, "utf8"),
    decryptString: (buf) => buf.toString("utf8").slice(3),
  };

  // Throwing mock: reports available but cannot decrypt (simulates a corrupted
  // blob / keystore mismatch). encryptString still works so non-secret fields
  // re-encrypt normally on save.
  const throwing = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`PT:${s}`, "utf8"),
    decryptString: () => {
      throw new Error("boom");
    },
  };

  beforeEach(() => {
    tmpDir = makeTmpDir();
    const ss = new Stores(tmpDir);
    reqStore = ss.requestStore();
    ss.collectionsStore().saveCollections(COL, { version: 1, collections: [] });
  });

  afterEach(() => {
    _setSafeStorage(null);
    rmTmpDir(tmpDir);
  });

  test("a failed decrypt does not clobber recoverable ciphertext on save", () => {
    // 1. Store a request with an encrypted secret using the reversible mock.
    _setSafeStorage(reversible);
    reqStore.createRequest(
      COL,
      makeRequest({
        id: REQ,
        authBasic: { username: "u", password: "topsecret" },
      }),
    );

    const reqPath = new Paths(tmpDir).requestPath(COL, REQ);
    const onDisk = JSON.parse(fs.readFileSync(reqPath, "utf8"));
    const storedCipher = onDisk.authBasic.password;
    assert.ok(
      storedCipher.startsWith("enc:v1:"),
      "password should be stored as ciphertext",
    );

    // 2. Decryption now fails; patch a non-secret field (auth block untouched).
    _setSafeStorage(throwing);
    reqStore.updateRequest(REQ, { name: "Renamed" });

    // 3. The original ciphertext must survive — not be blanked over.
    const after = JSON.parse(fs.readFileSync(reqPath, "utf8"));
    assert.equal(
      after.authBasic.password,
      storedCipher,
      "recoverable ciphertext must be preserved after a failed decrypt + save",
    );
    assert.equal(after.name, "Renamed", "non-secret patch should still apply");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HistoryStore
// ─────────────────────────────────────────────────────────────────────────────

describe("HistoryStore", () => {
  let tmpDir;
  let ss;
  let histStore;
  let envStore;
  let reqStore;
  const COL = "col-hist";
  const REQ = "req-hist";

  beforeEach(() => {
    tmpDir = makeTmpDir();
    ss = new Stores(tmpDir);
    histStore = ss.historyStore();
    envStore = ss.collectionsStore();
    reqStore = ss.requestStore();

    // Seed collection + request so resolver knows about them.
    envStore.saveCollections(COL, { version: 1, collections: [] });
    reqStore.createRequest(COL, makeRequest({ id: REQ }));
  });

  afterEach(() => rmTmpDir(tmpDir));

  test("listHistory returns empty page when no history exists", () => {
    const page = histStore.listHistory(REQ);
    assert.deepEqual(page, { items: [], nextCursor: "" });
  });

  test("addHistory → listHistory returns entry", () => {
    const entry = histStore.addHistory(REQ, {
      status: 200,
      durationMs: 42,
      responseSize: 512,
    });
    const { items } = histStore.listHistory(REQ);
    assert.equal(items.length, 1);
    assert.equal(items[0].id, entry.id);
    assert.equal(items[0].status, 200);
    assert.equal(items[0].requestId, REQ);
  });

  test("addHistory assigns id and timestamp when absent", () => {
    const entry = histStore.addHistory(REQ, { status: 404, durationMs: 13 });
    assert.ok(entry.id, "id should be assigned");
    assert.ok(entry.timestamp, "timestamp should be assigned");
    assert.equal(entry.requestId, REQ);
  });

  test("listHistory orders entries newest-first", () => {
    for (let i = 1; i <= 5; i++) {
      histStore.addHistory(REQ, {
        id: `hist-${i}`,
        timestamp: new Date(Date.now() + i * 1000).toISOString(),
        status: i * 100,
        durationMs: i,
      });
    }
    const { items } = histStore.listHistory(REQ);
    assert.equal(items[0].id, "hist-5"); // newest first
    assert.equal(items[4].id, "hist-1");
  });

  test("listHistory paginates with limit", () => {
    for (let i = 1; i <= 10; i++) {
      histStore.addHistory(REQ, {
        id: `hist-pg-${i}`,
        timestamp: new Date(Date.now() + i * 1000).toISOString(),
        status: 200,
        durationMs: i,
      });
    }
    const page1 = histStore.listHistory(REQ, { limit: 4 });
    assert.equal(page1.items.length, 4);
    assert.ok(page1.nextCursor !== "", "should have a next cursor");

    const page2 = histStore.listHistory(REQ, {
      limit: 4,
      cursor: page1.nextCursor,
    });
    assert.equal(page2.items.length, 4);
    // page2 must not overlap with page1
    const ids1 = new Set(page1.items.map((e) => e.id));
    for (const item of page2.items) {
      assert.ok(
        !ids1.has(item.id),
        `${item.id} should not appear in both pages`,
      );
    }

    const page3 = histStore.listHistory(REQ, {
      limit: 4,
      cursor: page2.nextCursor,
    });
    assert.equal(page3.items.length, 2);
    assert.equal(page3.nextCursor, "");
  });

  test("addHistory + getHistoryResponse round-trips response", () => {
    const response = {
      headers: { "content-type": "application/json" },
      body: '{"ok":true}',
    };
    const entry = histStore.addHistory(
      REQ,
      { status: 200, durationMs: 10 },
      response,
    );
    const loaded = histStore.getHistoryResponse(REQ, entry.id);
    assert.equal(loaded.body, '{"ok":true}');
    assert.equal(loaded.headers["content-type"], "application/json");
  });

  test("getHistoryResponse throws NOT_FOUND for missing response", () => {
    assert.throws(
      () => histStore.getHistoryResponse(REQ, "no-such-hist"),
      (err) => err.code === "NOT_FOUND",
    );
  });

  test("addHistory without response — listHistory still works", () => {
    histStore.addHistory(REQ, { status: 200, durationMs: 1 });
    const { items } = histStore.listHistory(REQ);
    assert.equal(items.length, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Resolver
// ─────────────────────────────────────────────────────────────────────────────

describe("Resolver", () => {
  let tmpDir;
  let ss;
  let resolver;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    ss = new Stores(tmpDir);
    resolver = new Resolver(new Paths(tmpDir));
  });

  afterEach(() => rmTmpDir(tmpDir));

  test("throws NOT_FOUND for unknown request", () => {
    assert.throws(
      () => resolver.resolve("ghost"),
      (err) => err.code === "NOT_FOUND",
    );
  });

  test("rebuilds cache from disk (created via CollectionsStore)", () => {
    const req = makeRequest({ id: "req-resolve" });
    ss.collectionsStore().saveCollections("col-resolve", {
      version: 1,
      collections: [
        { id: "f1", type: "collection", name: "F1", children: [req] },
      ],
    });

    // Fresh resolver after disk write
    const freshResolver = new Resolver(new Paths(tmpDir));
    assert.equal(freshResolver.resolve("req-resolve"), "col-resolve");
  });

  test("set() and remove() maintain cache incrementally", () => {
    resolver.set("req-a", "col-a");
    assert.equal(resolver.resolve("req-a"), "col-a");
    resolver.remove("req-a");
    assert.throws(
      () => resolver.resolve("req-a"),
      (err) => err.code === "NOT_FOUND",
    );
  });

  test("invalidate() triggers full rebuild on next resolve()", () => {
    // Seed data on disk
    const req = makeRequest({ id: "req-invalidate" });
    ss.collectionsStore().saveCollections("col-inv", {
      version: 1,
      collections: [
        { id: "f1", type: "collection", name: "F", children: [req] },
      ],
    });

    // Force the existing resolver to rebuild
    resolver.invalidate();
    assert.equal(resolver.resolve("req-invalidate"), "col-inv");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stores factory
// ─────────────────────────────────────────────────────────────────────────────

describe("Stores factory", () => {
  test("returns distinct store instances that share the resolver", () => {
    const tmpDir = makeTmpDir();
    try {
      const ss = new Stores(tmpDir);
      // Smoke test: all factory methods return the right types
      assert.ok(ss.collectionStore().getManifest, "collectionStore");
      assert.ok(ss.collectionsStore().getCollections, "collectionsStore");
      assert.ok(ss.treeStore().getTree, "treeStore");
      assert.ok(ss.requestStore().getRequest, "requestStore");
      assert.ok(ss.historyStore().listHistory, "historyStore");
    } finally {
      rmTmpDir(tmpDir);
    }
  });

  test("resolver is shared: createRequest via requestStore is visible to historyStore", () => {
    const tmpDir = makeTmpDir();
    try {
      const ss = new Stores(tmpDir);
      ss.collectionsStore().saveCollections("col-shared", {
        version: 1,
        collections: [],
      });
      const req = ss
        .requestStore()
        .createRequest("col-shared", makeRequest({ id: "req-shared" }));

      // HistoryStore uses the same resolver, so it should locate the collection.
      assert.doesNotThrow(() =>
        ss.historyStore().addHistory(req.id, { status: 200, durationMs: 1 }),
      );
    } finally {
      rmTmpDir(tmpDir);
    }
  });
});

// ── Utility ───────────────────────────────────────────────────────────────────

/** Collect all requestRef IDs from a tree nodes array (recursive). */
function _flattenRefs(nodes) {
  const ids = [];
  for (const n of nodes ?? []) {
    if (n.type === "requestRef") ids.push(n.id);
    else if (n.children) ids.push(..._flattenRefs(n.children));
  }
  return ids;
}
