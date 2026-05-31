/**
 * backup.test.js — Tests for the whole-workspace backup export / import store.
 *
 * Covers the security-critical secret handling (redacted by default, preserved
 * only on the explicit machine-only path) and the export → wipe → import
 * round-trip required by Feature 04's acceptance criteria.
 *
 * Run with:
 *   node --test src/app/store/tests/backup.test.js
 */
"use strict";

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");

const { Stores } = require("../stores");
const { BACKUP_KIND } = require("../backup");
const { CURRENT_SCHEMA_VERSION } = require("../migrations");

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wurl-test-"));
}

function rmTmpDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** A request fixture carrying a secret in its auth block. */
function makeRequest(overrides = {}) {
  return {
    id: "req-1",
    type: "request",
    name: "Secret Request",
    method: "GET",
    url: "https://example.com",
    authBasic: { username: "user", password: "s3cret-pw" },
    ...overrides,
  };
}

/** Seed a workspace (manifest + one collection w/ request + environments). */
function seedWorkspace(stores) {
  stores.collectionStore().saveManifest({
    version: 2,
    collections: [{ id: "coll-1", name: "My Collection" }],
    activeCollectionId: "coll-1",
    settings: { theme: "mocha", fontSize: 14, proxyUrl: "http://proxy.secret" },
  });

  stores.collectionsStore().saveCollections("coll-1", {
    version: 1,
    variables: { base: "https://api.test" },
    collections: [
      {
        id: "folder-1",
        type: "collection",
        name: "Folder",
        variables: {},
        children: [makeRequest()],
      },
    ],
  });

  stores.environmentStore().saveEnvironments({
    version: 1,
    globalVariables: { region: "eu" },
    activeEnvironmentId: "env-1",
    environments: [{ id: "env-1", name: "Dev", variables: { host: "dev" } }],
  });
}

/** Recursively find a request node by id within a legacy collection blob. */
function findRequest(nodes, id) {
  for (const node of nodes ?? []) {
    if (node.type === "request" && node.id === id) return node;
    const nested = findRequest(node.children, id);
    if (nested) return nested;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────────────

describe("BackupStore.exportAll", () => {
  let tmpDir;
  let stores;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    stores = new Stores(tmpDir);
    seedWorkspace(stores);
  });

  afterEach(() => rmTmpDir(tmpDir));

  test("produces a wurl-backup envelope with all entities", () => {
    const env = stores.backupStore().exportAll();

    assert.equal(env.kind, BACKUP_KIND);
    assert.equal(env.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.equal(env.secretsIncluded, false);
    assert.ok(typeof env.exportedAt === "string" && env.exportedAt.length > 0);

    assert.equal(env.collections.length, 1);
    assert.equal(env.collections[0].id, "coll-1");
    assert.equal(env.collections[0].requests.length, 1);

    assert.ok(env.manifest);
    assert.equal(env.manifest.collections[0].id, "coll-1");
    assert.equal(env.environments.environments[0].name, "Dev");
  });

  test("redacts secrets by default", () => {
    const env = stores.backupStore().exportAll();

    const req = env.collections[0].requests[0];
    assert.equal(req.authBasic.password, "");
    assert.equal(req.authBasic.username, "user"); // non-secret preserved
    assert.equal(env.manifest.settings.proxyUrl, "");
    assert.equal(env.manifest.settings.theme, "mocha"); // non-secret preserved
  });

  test("never leaks a plaintext secret in the default export", () => {
    const serialized = JSON.stringify(stores.backupStore().exportAll());
    assert.ok(!serialized.includes("s3cret-pw"));
    assert.ok(!serialized.includes("proxy.secret"));
  });

  test("includeSecrets preserves on-disk secret values verbatim", () => {
    const env = stores.backupStore().exportAll({ includeSecrets: true });

    assert.equal(env.secretsIncluded, true);
    assert.equal(
      env.collections[0].requests[0].authBasic.password,
      "s3cret-pw",
    );
    assert.equal(env.manifest.settings.proxyUrl, "http://proxy.secret");
  });

  test("stamps a caller-supplied exportedAt", () => {
    const env = stores
      .backupStore()
      .exportAll({ exportedAt: "2026-01-01T00:00:00.000Z" });
    assert.equal(env.exportedAt, "2026-01-01T00:00:00.000Z");
  });

  test("excludes history / response payloads", () => {
    const env = stores.backupStore().exportAll();
    assert.equal(env.history, undefined);
    assert.equal(env.responses, undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Import + round-trip
// ─────────────────────────────────────────────────────────────────────────────

describe("BackupStore.importAll", () => {
  let srcDir;
  let src;

  beforeEach(() => {
    srcDir = makeTmpDir();
    src = new Stores(srcDir);
    seedWorkspace(src);
  });

  afterEach(() => rmTmpDir(srcDir));

  test("round-trips onto a clean profile (replace mode)", () => {
    const env = src.backupStore().exportAll({ includeSecrets: true });

    const destDir = makeTmpDir();
    try {
      const dest = new Stores(destDir);
      const result = dest.backupStore().importAll(env, { mode: "replace" });

      assert.equal(result.collections, 1);
      assert.equal(result.requests, 1);
      assert.equal(result.mode, "replace");

      // Collections + request (secret intact via include-secrets path).
      const blob = dest.collectionsStore().getCollections("coll-1");
      const req = findRequest(blob.collections, "req-1");
      assert.ok(req, "request should be restored");
      assert.equal(req.authBasic.password, "s3cret-pw");
      assert.equal(blob.variables.base, "https://api.test");

      // Manifest + settings.
      const manifest = dest.collectionStore().getManifest();
      assert.equal(manifest.activeCollectionId, "coll-1");
      assert.equal(manifest.settings.proxyUrl, "http://proxy.secret");

      // Environments.
      const envs = dest.environmentStore().getEnvironments();
      assert.equal(envs.environments[0].name, "Dev");
      assert.equal(envs.globalVariables.region, "eu");
    } finally {
      rmTmpDir(destDir);
    }
  });

  test("redacted backup restores with blank secrets, not plaintext", () => {
    const env = src.backupStore().exportAll(); // default: redacted

    const destDir = makeTmpDir();
    try {
      const dest = new Stores(destDir);
      dest.backupStore().importAll(env, { mode: "replace" });

      const blob = dest.collectionsStore().getCollections("coll-1");
      const req = findRequest(blob.collections, "req-1");
      assert.equal(req.authBasic.password, "");
      assert.equal(dest.collectionStore().getManifest().settings.proxyUrl, "");
    } finally {
      rmTmpDir(destDir);
    }
  });

  test("merge mode unions collections and keeps existing settings", () => {
    // Destination already has its own collection + settings.
    const destDir = makeTmpDir();
    try {
      const dest = new Stores(destDir);
      dest.collectionStore().saveManifest({
        version: 2,
        collections: [{ id: "existing", name: "Existing" }],
        activeCollectionId: "existing",
        settings: { theme: "latte" },
      });
      dest.collectionsStore().saveCollections("existing", {
        version: 1,
        collections: [],
      });

      const env = src.backupStore().exportAll({ includeSecrets: true });
      dest.backupStore().importAll(env, { mode: "merge" });

      const manifest = dest.collectionStore().getManifest();
      const ids = manifest.collections.map((c) => c.id).sort();
      assert.deepEqual(ids, ["coll-1", "existing"]);
      // Existing settings/active selection preserved in merge.
      assert.equal(manifest.settings.theme, "latte");
      assert.equal(manifest.activeCollectionId, "existing");

      // Both collections' data present on disk.
      assert.ok(
        findRequest(
          dest.collectionsStore().getCollections("coll-1").collections,
          "req-1",
        ),
      );
    } finally {
      rmTmpDir(destDir);
    }
  });

  test("replace mode wipes collections absent from the backup", () => {
    const destDir = makeTmpDir();
    try {
      const dest = new Stores(destDir);
      dest.collectionsStore().saveCollections("stale", {
        version: 1,
        collections: [],
      });

      const env = src.backupStore().exportAll({ includeSecrets: true });
      dest.backupStore().importAll(env, { mode: "replace" });

      // The stale collection directory is gone.
      assert.equal(
        fs.existsSync(path.join(destDir, "collections", "stale")),
        false,
      );
      assert.ok(fs.existsSync(path.join(destDir, "collections", "coll-1")));
    } finally {
      rmTmpDir(destDir);
    }
  });

  test("rejects a non-backup document", () => {
    const dest = new Stores(makeTmpDir());
    assert.throws(() => dest.backupStore().importAll({ kind: "something" }), {
      code: "INVALID_BACKUP",
    });
    assert.throws(() => dest.backupStore().importAll(null), {
      code: "INVALID_BACKUP",
    });
  });
});
