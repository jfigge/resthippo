/**
 * io-locking.test.js — Tests for the orphaned temp-file garbage collector
 * (feature 03), the temp-name matcher, and the remove/listDir/exists
 * filesystem helpers.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const io = require("../io");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wurl-io-lock-test-"));
}

// ── Orphan-scan matcher ─────────────────────────────────────────────────────────

test("isTempFileName matches temp files and rejects real data files", () => {
  assert.ok(io.isTempFileName("manifest.json.wurltmp-1.tmp"));
  assert.ok(io.isTempFileName("collection.json.wurltmp-42.tmp"));
  // Real data files and look-alikes must never match.
  assert.ok(!io.isTempFileName("manifest.json"));
  assert.ok(!io.isTempFileName("collection.json"));
  assert.ok(!io.isTempFileName("report.tmp")); // ends in .tmp but no infix
  assert.ok(!io.isTempFileName("backup.wurltmp-.tmp")); // infix but no counter
});

// ── Startup GC ──────────────────────────────────────────────────────────────────

test("gcOrphanTempFiles removes old orphans but spares fresh temps and real data", () => {
  const dir = tmpDir();
  const sub = path.join(dir, "collections", "c1");
  fs.mkdirSync(sub, { recursive: true });

  const orphan = path.join(dir, "manifest.json.wurltmp-1.tmp");
  const nestedOrphan = path.join(sub, "collection.json.wurltmp-2.tmp");
  const freshTemp = path.join(dir, "manifest.json.wurltmp-3.tmp");
  const realData = path.join(dir, "manifest.json");
  const lookalike = path.join(dir, "report.tmp"); // .tmp suffix, not one of ours

  for (const f of [orphan, nestedOrphan, freshTemp, realData, lookalike]) {
    fs.writeFileSync(f, "x");
  }

  const now = Date.now();
  // Age the two orphans well past the threshold.
  const old = new Date(now - 60_000);
  fs.utimesSync(orphan, old, old);
  fs.utimesSync(nestedOrphan, old, old);

  const removed = io.gcOrphanTempFiles(dir, { maxAgeMs: 5000, now });
  const removedSet = new Set(removed.map((p) => path.resolve(p)));

  // Old orphans gone — including one nested in a subdirectory.
  assert.ok(removedSet.has(path.resolve(orphan)));
  assert.ok(removedSet.has(path.resolve(nestedOrphan)));
  assert.strictEqual(fs.existsSync(orphan), false);
  assert.strictEqual(fs.existsSync(nestedOrphan), false);

  // Fresh temp (younger than threshold) is kept — it may be an in-flight write.
  assert.strictEqual(fs.existsSync(freshTemp), true);
  // Real data and the unrelated .tmp file are never touched.
  assert.strictEqual(fs.existsSync(realData), true);
  assert.strictEqual(fs.existsSync(lookalike), true);
});

test("gcOrphanTempFiles tolerates a missing directory", () => {
  const dir = tmpDir();
  const missing = path.join(dir, "does-not-exist");
  assert.deepStrictEqual(io.gcOrphanTempFiles(missing), []);
});

// ── Filesystem helpers: remove / listDir / exists ───────────────────────────────

test("remove deletes a single file", () => {
  const dir = tmpDir();
  const file = path.join(dir, "data.json");
  fs.writeFileSync(file, "x");

  io.remove(file);
  assert.strictEqual(fs.existsSync(file), false);
});

test("remove deletes a directory tree recursively", () => {
  const dir = tmpDir();
  const tree = path.join(dir, "a", "b");
  fs.mkdirSync(tree, { recursive: true });
  fs.writeFileSync(path.join(tree, "f.json"), "x");

  io.remove(path.join(dir, "a"));
  assert.strictEqual(fs.existsSync(path.join(dir, "a")), false);
});

test("remove is a best-effort no-op on a missing path", () => {
  const dir = tmpDir();
  assert.doesNotThrow(() => io.remove(path.join(dir, "never-existed")));
});

test("listDir returns entry names", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "a.json"), "1");
  fs.writeFileSync(path.join(dir, "b.json"), "2");

  assert.deepStrictEqual(io.listDir(dir).sort(), ["a.json", "b.json"]);
});

test("listDir forwards options (withFileTypes yields Dirents)", () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, "sub"));
  fs.writeFileSync(path.join(dir, "file.json"), "x");

  const entries = io.listDir(dir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  const files = entries.filter((e) => e.isFile()).map((e) => e.name);

  assert.deepStrictEqual(dirs, ["sub"]);
  assert.deepStrictEqual(files, ["file.json"]);
});

test("listDir returns [] for a missing directory", () => {
  const dir = tmpDir();
  assert.deepStrictEqual(io.listDir(path.join(dir, "missing")), []);
});

test("exists reflects presence of files and directories", () => {
  const dir = tmpDir();
  const file = path.join(dir, "here.json");

  assert.strictEqual(io.exists(file), false);
  fs.writeFileSync(file, "x");
  assert.strictEqual(io.exists(file), true);
  assert.strictEqual(io.exists(dir), true);
});
