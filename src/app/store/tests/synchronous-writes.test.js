/**
 * synchronous-writes.test.js — pins the invariant the store layer's
 * read-modify-write safety actually rests on: every store operation is
 * SYNCHRONOUS.
 *
 * Why this matters (and why there is no lock/mutex in the store):
 *
 *   Several store methods are read-modify-write — they readJSON() the current
 *   document, merge in the caller's change (the environment/variable clobber
 *   guard, request PATCH, tree edits), then writeJSON() the result. That is a
 *   classic lost-update hazard *if* the operation can be interleaved with a
 *   second writer. In Node's single-threaded event loop it can only interleave
 *   if it yields — i.e. if there is an `await` (or any other microtask/IO
 *   suspension) between the read and the write. As long as every such method
 *   runs straight through synchronously, the runtime guarantees no other JS can
 *   observe or clobber the half-applied state, so the read-modify-write is
 *   effectively atomic and no serialization is required. (atomicWrite's
 *   tmp-then-rename additionally makes each individual write crash-atomic, and
 *   the app holds a single-instance lock, so there is no second OS process
 *   writing the same files either.)
 *
 *   The moment a store file introduces `async`/`await` or `fs.promises`, that
 *   guarantee silently disappears and the lost-update race becomes real. This
 *   test fails at that point on purpose: whoever makes a store path asynchronous
 *   must, in the same change, serialize that read-modify-write (e.g. a per-path
 *   async mutex/queue) and then update this guard to reflect the new contract.
 *
 * Scope: the production store modules under src/app/store (the tests/ subtree is
 * excluded — test code may legitimately be async).
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const STORE_DIR = path.join(__dirname, "..");

/** Production store source files (top-level *.js in store/, excluding tests/). */
function storeSourceFiles() {
  return fs
    .readdirSync(STORE_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".js"))
    .map((e) => e.name);
}

/**
 * Strip line and block comments so a stray "await" / "async" in prose doesn't
 * trip the scan. Deliberately simple: the store sources contain no regex
 * literals delimited with `//`, so naive line-comment removal is safe here.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

// Patterns that introduce a suspension point (and thus an interleave window)
// between a synchronous readJSON() and writeJSON().
const ASYNC_MARKERS = [
  { re: /\basync\b/, label: "async function" },
  { re: /\bawait\b/, label: "await expression" },
  { re: /\bfs\.promises\b/, label: "fs.promises" },
  {
    re: /require\(\s*["']fs\/promises["']\s*\)/,
    label: 'require("fs/promises")',
  },
];

test("the store layer stays fully synchronous (read-modify-write is atomic)", () => {
  const offenders = [];
  for (const name of storeSourceFiles()) {
    const code = stripComments(
      fs.readFileSync(path.join(STORE_DIR, name), "utf8"),
    );
    for (const { re, label } of ASYNC_MARKERS) {
      if (re.test(code)) offenders.push(`${name}: ${label}`);
    }
  }

  assert.deepStrictEqual(
    offenders,
    [],
    "A store module introduced an asynchronous path. Read-modify-write store " +
      "methods rely on running synchronously (no await between read and write) " +
      "to be race-free. Before making a store path async, serialize its " +
      "read-modify-write (e.g. a per-path async queue) and update this guard.\n" +
      `Offenders:\n  ${offenders.join("\n  ")}`,
  );
});

test("guard self-check: the async-marker scan actually fires", () => {
  // Cheap sanity check that the markers match real async source, so the guard
  // above can't silently pass because the regexes are broken.
  const sample = stripComments(
    "async function f() { await fs.promises.readFile('x'); }",
  );
  const hits = ASYNC_MARKERS.filter(({ re }) => re.test(sample)).map(
    (m) => m.label,
  );
  assert.ok(hits.includes("async function"));
  assert.ok(hits.includes("await expression"));
  assert.ok(hits.includes("fs.promises"));
});
