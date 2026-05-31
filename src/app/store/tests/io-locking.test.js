/**
 * io-locking.test.js — Tests for per-path write serialization and the
 * orphaned temp-file garbage collector (feature 03).
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

// ── Per-path serialization ──────────────────────────────────────────────────────

test("writeJSONAsync serializes overlapping writes to the same path (last wins)", async () => {
  const dir = tmpDir();
  const target = path.join(dir, "data.json");

  await Promise.all([
    io.writeJSONAsync(target, { n: 1 }),
    io.writeJSONAsync(target, { n: 2 }),
    io.writeJSONAsync(target, { n: 3 }),
  ]);

  // The file parses cleanly (never a partial temp) and reflects the last write.
  assert.strictEqual(io.readJSON(target).n, 3);
  // No temp files left behind.
  const leftovers = fs.readdirSync(dir).filter((f) => io.isTempFileName(f));
  assert.deepStrictEqual(leftovers, []);
});

test("many concurrent async writes never leave a corrupt file", async () => {
  const dir = tmpDir();
  const target = path.join(dir, "data.json");

  const writes = [];
  for (let i = 0; i < 25; i++) {
    writes.push(io.writeJSONAsync(target, { i }));
  }
  await Promise.all(writes);

  // Whatever landed parses cleanly and is the last-issued value.
  assert.strictEqual(io.readJSON(target).i, 24);
  const leftovers = fs.readdirSync(dir).filter((f) => io.isTempFileName(f));
  assert.deepStrictEqual(leftovers, []);
});

test("writeJSONAsync to different paths both land", async () => {
  const dir = tmpDir();
  const a = path.join(dir, "a.json");
  const b = path.join(dir, "b.json");

  await Promise.all([
    io.writeJSONAsync(a, { k: "a" }),
    io.writeJSONAsync(b, { k: "b" }),
  ]);

  assert.strictEqual(io.readJSON(a).k, "a");
  assert.strictEqual(io.readJSON(b).k, "b");
});

test("atomicWriteAsync cleans up temp file on error", async () => {
  const dir = tmpDir();
  // Renaming a temp file onto an existing directory path fails; the temp file
  // must not be left behind.
  const target = path.join(dir, "subdir");
  fs.mkdirSync(target);

  await assert.rejects(() => io.atomicWriteAsync(target, "data"));

  const leftovers = fs.readdirSync(dir).filter((f) => io.isTempFileName(f));
  assert.deepStrictEqual(leftovers, []);
});
