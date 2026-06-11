/**
 * tests/logger.test.js
 *
 * Unit tests for the persistent rotating log (app/logger.js). The logger is the
 * backbone of the diagnostics feature, so the behaviours a bug report depends on
 * are pinned here: lines are written with level + scope, the level threshold is
 * honoured, the file rotates and never keeps more than `maxFiles`, Error objects
 * are expanded to name/message/stack (not the offending value), the console tee
 * persists output while still calling the original, and a write failure is
 * swallowed rather than thrown.
 *
 * Pure Node — the logger takes its directory as a parameter, so no Electron /
 * userData is needed.
 *
 * Run with:   node --test tests/logger.test.js
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createLogger, formatArg } = require("../logger");

/** Fresh, unique temp dir per test so runs never collide. */
let _dirCounter = 0;
function tmpDir() {
  _dirCounter += 1;
  const dir = path.join(
    os.tmpdir(),
    `wurl-logger-test-${process.pid}-${_dirCounter}`,
  );
  fs.rmSync(dir, { recursive: true, force: true });
  return dir;
}

test("writes a line with timestamp, level and scope", () => {
  const dir = tmpDir();
  const log = createLogger({ dir });
  log.info("startup", "hello world");

  const text = fs.readFileSync(path.join(dir, "main.log"), "utf8");
  assert.match(text, /\[info\] \[startup\] hello world/);
  // ISO-8601 timestamp prefix.
  assert.match(text, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});

test("joins multiple message parts with spaces", () => {
  const dir = tmpDir();
  const log = createLogger({ dir });
  log.warn("http", "status", 404, "not found");
  const text = fs.readFileSync(path.join(dir, "main.log"), "utf8");
  assert.match(text, /\[warn\] \[http\] status 404 not found/);
});

test("honours the minimum level (info drops debug)", () => {
  const dir = tmpDir();
  const log = createLogger({ dir, level: "info" });
  log.debug("x", "should be dropped");
  log.error("x", "should be kept");
  const text = fs.readFileSync(path.join(dir, "main.log"), "utf8");
  assert.doesNotMatch(text, /should be dropped/);
  assert.match(text, /should be kept/);
});

test("expands Error to name/message/stack, never a bare value", () => {
  const dir = tmpDir();
  const log = createLogger({ dir });
  const err = new Error("boom");
  err.name = "DecryptError";
  log.error("crypto", err);
  const text = fs.readFileSync(path.join(dir, "main.log"), "utf8");
  assert.match(text, /DecryptError: boom/);
  assert.match(text, /at /); // stack frame present
});

test("formatArg JSON-encodes plain objects and tolerates cycles", () => {
  assert.equal(formatArg({ a: 1 }), '{"a":1}');
  const cyclic = {};
  cyclic.self = cyclic;
  // Falls back to String() rather than throwing on a circular structure.
  assert.equal(typeof formatArg(cyclic), "string");
});

test("rotates when the file exceeds maxBytes and caps the file count", () => {
  const dir = tmpDir();
  // Tiny cap so a handful of lines forces several rotations; keep 3 files total.
  const log = createLogger({ dir, maxBytes: 200, maxFiles: 3 });
  for (let i = 0; i < 50; i++) {
    log.info("rot", `line number ${i} ${"x".repeat(40)}`);
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("main"))
    .sort();
  // Never more than maxFiles: main.log + main.1.log + main.2.log.
  assert.ok(files.length <= 3, `expected <= 3 files, got ${files}`);
  assert.ok(files.includes("main.log"));
  assert.ok(files.includes("main.1.log"));
  // The current file holds the most recent line.
  const current = fs.readFileSync(path.join(dir, "main.log"), "utf8");
  assert.match(current, /line number 49/);
});

test("listFiles is current-first; readFiles is oldest-first for chronological reads", () => {
  const dir = tmpDir();
  const log = createLogger({ dir, maxBytes: 120, maxFiles: 4 });
  for (let i = 0; i < 20; i++) log.info("seq", `entry ${i} ${"y".repeat(30)}`);

  const list = log.listFiles().map((p) => path.basename(p));
  assert.equal(list[0], "main.log", "listFiles puts the live file first");

  const read = log.readFiles();
  // readFiles reverses to oldest-first, so the last bundle entry is main.log.
  assert.equal(read[read.length - 1].name, "main.log");
  read.forEach((f) => assert.equal(typeof f.content, "string"));
});

test("install() tees console.* to the file and still calls the original", () => {
  const dir = tmpDir();
  const log = createLogger({ dir });

  const seen = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...a) => seen.push(["log", ...a]);
  console.error = (...a) => seen.push(["error", ...a]);
  try {
    log.install();
    console.log("teed message");
    console.error("teed error");
    log.uninstall();
  } finally {
    console.log = realLog;
    console.error = realError;
  }

  // Original collectors still fired.
  assert.deepEqual(seen[0], ["log", "teed message"]);
  assert.deepEqual(seen[1], ["error", "teed error"]);

  const text = fs.readFileSync(path.join(dir, "main.log"), "utf8");
  assert.match(text, /\[info\] \[console\] teed message/);
  assert.match(text, /\[error\] \[console\] teed error/);
});

test("uninstall() restores the original console methods", () => {
  const dir = tmpDir();
  const log = createLogger({ dir });
  const before = console.log;
  log.install();
  assert.notEqual(
    console.log,
    before,
    "console.log is patched while installed",
  );
  log.uninstall();
  assert.equal(console.log, before, "console.log restored after uninstall");
});

test("a write to an unwritable directory does not throw", () => {
  // Point at a path whose parent is a file, so mkdir/append fail; the logger must
  // swallow it (logging is best-effort and must never crash the app).
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "not-a-dir");
  fs.writeFileSync(filePath, "x");
  const log = createLogger({ dir: path.join(filePath, "logs") });
  assert.doesNotThrow(() => log.error("x", "still fine"));
});
