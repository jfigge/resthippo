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
const { PasswordError } = require("../crypto");
const { CURRENT_SCHEMA_VERSION } = require("../migrations");

const PW = "correct horse battery staple";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "resthippo-test-"));
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
    variables: [
      { name: "base", value: "https://api.test", secure: false },
      { name: "apiKey", value: "sk-collection-secret", secure: true },
    ],
    collections: [
      {
        id: "folder-1",
        type: "collection",
        name: "Folder",
        variables: [
          { name: "folderKey", value: "folder-secret", secure: true },
        ],
        children: [makeRequest()],
      },
    ],
  });

  stores.environmentStore().saveEnvironments({
    version: 1,
    globalVariables: [
      { name: "region", value: "eu", secure: false },
      { name: "globalToken", value: "glob-secret", secure: true },
    ],
    activeEnvironmentId: "env-1",
    environments: [
      {
        id: "env-1",
        name: "Dev",
        variables: [
          { name: "host", value: "dev", secure: false },
          { name: "envSecret", value: "env-secret-val", secure: true },
        ],
      },
    ],
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

/** Recursively find a folder node by id within a legacy collection blob. */
function findFolder(nodes, id) {
  for (const node of nodes ?? []) {
    if (node.id === id && node.type !== "request") return node;
    const nested = findFolder(node.children, id);
    if (nested) return nested;
  }
  return null;
}

/** Value of a named variable in a list (array shape). */
function varValue(list, name) {
  return (list ?? []).find((v) => v.name === name)?.value;
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

  test("produces a resthippo-backup envelope with all entities", () => {
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

  test("builds recovery tree when source tree is empty but requests exist", () => {
    // Force tree.json to empty — simulates a source machine whose tree was
    // wiped by a broken prior restore while request files remain on disk.
    const treeFile = path.join(tmpDir, "collections", "coll-1", "tree.json");
    fs.writeFileSync(treeFile, JSON.stringify({ children: [] }));

    const env = stores.backupStore().exportAll();
    const coll = env.collections.find((c) => c.id === "coll-1");
    assert.ok(coll, "collection must be present");
    assert.ok(
      (coll.tree.children ?? []).length > 0,
      "exported tree must not be empty when request files exist",
    );
    assert.ok(
      JSON.stringify(coll.tree).includes("req-1"),
      "exported tree must reference req-1",
    );
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
      assert.equal(
        blob.variables.find((v) => v.name === "base").value,
        "https://api.test",
      );

      // Manifest + settings.
      const manifest = dest.collectionStore().getManifest();
      assert.equal(manifest.activeCollectionId, "coll-1");
      assert.equal(manifest.settings.proxyUrl, "http://proxy.secret");

      // Environments.
      const envs = dest.environmentStore().getEnvironments();
      assert.equal(envs.environments[0].name, "Dev");
      assert.equal(
        envs.globalVariables.find((v) => v.name === "region").value,
        "eu",
      );
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

  test("merge mode matches collections by name when IDs differ", () => {
    // The most common cross-machine scenario: source and destination both have
    // a collection with the same name but different UUIDs.  After merge the
    // backup data must land in the existing slot — not create a duplicate.
    const env = src.backupStore().exportAll({ includeSecrets: true });

    const destDir = makeTmpDir();
    try {
      const dest = new Stores(destDir);
      dest.collectionStore().saveManifest({
        version: 2,
        collections: [{ id: "dest-coll", name: "My Collection" }],
        activeCollectionId: "dest-coll",
        settings: { theme: "latte" },
      });
      dest.collectionsStore().saveCollections("dest-coll", {
        version: 1,
        collections: [],
      });

      dest.backupStore().importAll(env, { mode: "merge" });

      const manifest = dest.collectionStore().getManifest();
      // No duplicate — only one "My Collection" entry with the destination's ID.
      assert.equal(manifest.collections.length, 1);
      assert.equal(manifest.collections[0].id, "dest-coll");
      assert.equal(manifest.collections[0].name, "My Collection");
      // Active selection and settings preserved (current wins in merge).
      assert.equal(manifest.activeCollectionId, "dest-coll");
      assert.equal(manifest.settings.theme, "latte");
      // Backup data is accessible via the destination's collection ID.
      assert.ok(
        findRequest(
          dest.collectionsStore().getCollections("dest-coll").collections,
          "req-1",
        ),
        "backup request must be accessible under the destination collection ID",
      );
    } finally {
      rmTmpDir(destDir);
    }
  });

  test("merge mode does not import orphaned source collection directories", () => {
    // exportAll scans the filesystem and may include directories that were
    // never registered in the source manifest. They must not be written to or
    // registered in the destination.
    const env = src.backupStore().exportAll({ includeSecrets: true });
    const orphanColl = {
      id: "orphan-abc",
      metadata: { id: "orphan-abc", variables: [] },
      tree: { children: [] },
      requests: [],
    };
    const envWithOrphan = {
      ...env,
      collections: [...env.collections, orphanColl],
    };

    const destDir = makeTmpDir();
    try {
      const dest = new Stores(destDir);
      dest.backupStore().importAll(envWithOrphan, { mode: "merge" });

      const manifest = dest.collectionStore().getManifest();
      assert.ok(
        !manifest.collections.some((c) => c.id === "orphan-abc"),
        "orphaned collection must not appear in the manifest",
      );
      assert.equal(
        fs.existsSync(path.join(destDir, "collections", "orphan-abc")),
        false,
        "orphaned collection directory must not be created",
      );
    } finally {
      rmTmpDir(destDir);
    }
  });

  test("merge mode registers collections when backup manifest uses legacy environments key", () => {
    // Simulates a backup produced before the manifest key was renamed from
    // `environments` to `collections`. _mergeManifest handles these via the
    // environments key fallback.
    const env = src.backupStore().exportAll({ includeSecrets: true });
    const legacyManifest = {
      ...env.manifest,
      environments: env.manifest.collections,
    };
    delete legacyManifest.collections;
    const legacyEnv = { ...env, manifest: legacyManifest };

    const destDir = makeTmpDir();
    try {
      const dest = new Stores(destDir);
      dest.collectionStore().saveManifest({
        version: 2,
        collections: [{ id: "existing", name: "Existing" }],
        activeCollectionId: "existing",
        settings: { theme: "latte" },
      });

      dest.backupStore().importAll(legacyEnv, { mode: "merge" });

      const manifest = dest.collectionStore().getManifest();
      const ids = manifest.collections.map((c) => c.id).sort();
      assert.ok(
        ids.includes("existing"),
        "existing collection must be preserved",
      );
      assert.ok(
        ids.includes("coll-1"),
        "restored collection must be registered",
      );
    } finally {
      rmTmpDir(destDir);
    }
  });

  test("restores requests when backup tree is empty", () => {
    // Simulates a backup created from a machine where tree.json was empty
    // (e.g. after a broken prior restore left requests on disk but no tree).
    // The requests must be accessible after import rather than silently lost.
    const env = src.backupStore().exportAll({ includeSecrets: true });
    const envWithEmptyTree = {
      ...env,
      collections: env.collections.map((c) => ({
        ...c,
        tree: { children: [] },
      })),
    };

    const destDir = makeTmpDir();
    try {
      const dest = new Stores(destDir);
      dest.backupStore().importAll(envWithEmptyTree, { mode: "replace" });

      const blob = dest.collectionsStore().getCollections("coll-1");
      const req = findRequest(blob.collections, "req-1");
      assert.ok(req, "request must be visible even when backup tree was empty");
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

// ─────────────────────────────────────────────────────────────────────────────
// Password-protected (portable) backups
// ─────────────────────────────────────────────────────────────────────────────

describe("BackupStore password mode", () => {
  let srcDir;
  let src;

  beforeEach(() => {
    srcDir = makeTmpDir();
    src = new Stores(srcDir);
    seedWorkspace(src);
  });

  afterEach(() => rmTmpDir(srcDir));

  test("requires a password to export in password mode", () => {
    assert.throws(() => src.backupStore().exportAll({ mode: "password" }), {
      message: /password is required/,
    });
  });

  test("encrypts all secret locations as portable ciphertext", () => {
    const env = src.backupStore().exportAll({ mode: "password", password: PW });

    assert.equal(env.secretsMode, "password");
    assert.equal(env.secretsIncluded, true);

    const meta = env.collections[0].metadata;
    assert.equal(varValue(meta.variables, "base"), "https://api.test"); // non-secret kept
    assert.match(varValue(meta.variables, "apiKey"), /^encp:v2:/);

    const folder = findFolder(env.collections[0].tree.children, "folder-1");
    assert.match(varValue(folder.variables, "folderKey"), /^encp:v2:/);

    assert.match(
      varValue(env.environments.globalVariables, "globalToken"),
      /^encp:v2:/,
    );
    assert.match(
      varValue(env.environments.environments[0].variables, "envSecret"),
      /^encp:v2:/,
    );

    const req =
      findRequest(env.collections[0].requests, "req-1") ??
      env.collections[0].requests[0];
    assert.match(req.authBasic.password, /^encp:v2:/);
    assert.match(env.manifest.settings.proxyUrl, /^encp:v2:/);
  });

  test("never leaks a plaintext secret in a password export", () => {
    const serialized = JSON.stringify(
      src.backupStore().exportAll({ mode: "password", password: PW }),
    );
    for (const secret of [
      "sk-collection-secret",
      "folder-secret",
      "glob-secret",
      "env-secret-val",
      "s3cret-pw",
      "proxy.secret",
    ]) {
      assert.ok(!serialized.includes(secret), `leaked ${secret}`);
    }
  });

  test("round-trips secrets with the correct password", () => {
    const env = src.backupStore().exportAll({ mode: "password", password: PW });

    const destDir = makeTmpDir();
    try {
      const dest = new Stores(destDir);
      dest.backupStore().importAll(env, { mode: "replace", password: PW });

      const blob = dest.collectionsStore().getCollections("coll-1");
      assert.equal(varValue(blob.variables, "apiKey"), "sk-collection-secret");
      const folder = findFolder(blob.collections, "folder-1");
      assert.equal(varValue(folder.variables, "folderKey"), "folder-secret");
      const req = findRequest(blob.collections, "req-1");
      assert.equal(req.authBasic.password, "s3cret-pw");

      const envs = dest.environmentStore().getEnvironments();
      assert.equal(
        varValue(envs.globalVariables, "globalToken"),
        "glob-secret",
      );
      assert.equal(
        varValue(envs.environments[0].variables, "envSecret"),
        "env-secret-val",
      );

      assert.equal(
        dest.collectionStore().getManifest().settings.proxyUrl,
        "http://proxy.secret",
      );
    } finally {
      rmTmpDir(destDir);
    }
  });

  test("import without a password clears secrets but keeps the secure flag", () => {
    const env = src.backupStore().exportAll({ mode: "password", password: PW });

    const destDir = makeTmpDir();
    try {
      const dest = new Stores(destDir);
      dest.backupStore().importAll(env, { mode: "replace" }); // no password

      const blob = dest.collectionsStore().getCollections("coll-1");
      const apiKey = blob.variables.find((v) => v.name === "apiKey");
      assert.equal(apiKey.value, "");
      assert.equal(apiKey.secure, true);
      // Non-secret survives untouched.
      assert.equal(varValue(blob.variables, "base"), "https://api.test");

      const req = findRequest(blob.collections, "req-1");
      assert.equal(req.authBasic.password, "");
    } finally {
      rmTmpDir(destDir);
    }
  });

  test("import with the wrong password throws PasswordError", () => {
    const env = src.backupStore().exportAll({ mode: "password", password: PW });

    const destDir = makeTmpDir();
    try {
      const dest = new Stores(destDir);
      assert.throws(
        () =>
          dest
            .backupStore()
            .importAll(env, { mode: "replace", password: "wrong" }),
        (err) => err instanceof PasswordError && err.reason === "bad-password",
      );
    } finally {
      rmTmpDir(destDir);
    }
  });
});
