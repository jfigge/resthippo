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
  return fs.mkdtempSync(path.join(os.tmpdir(), "resthippo-io-lock-test-"));
}

// ── Orphan-scan matcher ─────────────────────────────────────────────────────────

test("isTempFileName matches temp files and rejects real data files", () => {
  assert.ok(io.isTempFileName("manifest.json.resthippotmp-1.tmp"));
  assert.ok(io.isTempFileName("collection.json.resthippotmp-42.tmp"));
  // Real data files and look-alikes must never match.
  assert.ok(!io.isTempFileName("manifest.json"));
  assert.ok(!io.isTempFileName("collection.json"));
  assert.ok(!io.isTempFileName("report.tmp")); // ends in .tmp but no infix
  assert.ok(!io.isTempFileName("backup.resthippotmp-.tmp")); // infix but no counter
});

// ── Startup GC ──────────────────────────────────────────────────────────────────

test("gcOrphanTempFiles removes old orphans but spares fresh temps and real data", () => {
  const dir = tmpDir();
  const sub = path.join(dir, "collections", "c1");
  fs.mkdirSync(sub, { recursive: true });

  const orphan = path.join(dir, "manifest.json.resthippotmp-1.tmp");
  const nestedOrphan = path.join(sub, "collection.json.resthippotmp-2.tmp");
  const freshTemp = path.join(dir, "manifest.json.resthippotmp-3.tmp");
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

// ── Atomic write: content + durability ──────────────────────────────────────────

test("atomicWrite writes exact content and leaves no temp file behind", () => {
  const dir = tmpDir();
  const file = path.join(dir, "doc.json");

  io.atomicWrite(file, '{"a":1}');

  assert.strictEqual(fs.readFileSync(file, "utf8"), '{"a":1}');
  const leftovers = fs.readdirSync(dir).filter((n) => io.isTempFileName(n));
  assert.deepStrictEqual(
    leftovers,
    [],
    "no orphan temp file after a clean write",
  );
});

test("atomicWrite fsyncs the temp file and the parent directory before returning", () => {
  const dir = tmpDir();
  const file = path.join(dir, "doc.json");

  const realFsync = fs.fsyncSync;
  const realOpen = fs.openSync;
  let fsyncs = 0;
  let dirOpenedForFsync = false;
  fs.fsyncSync = (fd) => {
    fsyncs += 1;
    return realFsync(fd);
  };
  fs.openSync = (p, ...rest) => {
    // The directory-fsync path opens the parent dir; record the attempt even on
    // platforms where the subsequent openSync/fsync is rejected and swallowed.
    if (path.resolve(p) === path.resolve(dir)) dirOpenedForFsync = true;
    return realOpen(p, ...rest);
  };
  try {
    io.atomicWrite(file, "durable");
  } finally {
    fs.fsyncSync = realFsync;
    fs.openSync = realOpen;
  }

  assert.strictEqual(fs.readFileSync(file, "utf8"), "durable");
  assert.ok(
    fsyncs >= 1,
    "temp file contents must be fsync'd before the rename",
  );
  assert.ok(dirOpenedForFsync, "parent directory must be opened for an fsync");
});

// ── move (rename) ────────────────────────────────────────────────────────────────

test("move renames a file, preserving its content", () => {
  const dir = tmpDir();
  const src = path.join(dir, "a.json");
  const dest = path.join(dir, "b.json");
  fs.writeFileSync(src, "payload");

  io.move(src, dest);

  assert.strictEqual(fs.existsSync(src), false);
  assert.strictEqual(fs.readFileSync(dest, "utf8"), "payload");
});

test("move renames a directory tree", () => {
  const dir = tmpDir();
  const src = path.join(dir, "from");
  const dest = path.join(dir, "to");
  fs.mkdirSync(path.join(src, "nested"), { recursive: true });
  fs.writeFileSync(path.join(src, "nested", "f.json"), "x");

  io.move(src, dest);

  assert.strictEqual(fs.existsSync(src), false);
  assert.strictEqual(
    fs.readFileSync(path.join(dest, "nested", "f.json"), "utf8"),
    "x",
  );
});

test("move propagates ENOENT on a missing source (unlike remove)", () => {
  const dir = tmpDir();
  assert.throws(
    () => io.move(path.join(dir, "missing"), path.join(dir, "dest")),
    { code: "ENOENT" },
  );
});
