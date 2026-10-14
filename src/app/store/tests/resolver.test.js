/*
 * Copyright 2026 Jason Figge
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This file is part of Rest Hippo.
 *
 * Rest Hippo is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option) any later
 * version.
 *
 * Rest Hippo is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR
 * A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with
 * Rest Hippo. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * resolver.test.js — requestID → collectionID resolution, with emphasis on the
 * duplicate-request-ID case (a request file present in two collection
 * directories, e.g. after a merged backup or a hand-copied collection dir): it
 * must resolve deterministically and be reported, not silently last-write-wins.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { Paths } = require("../paths");
const { Resolver } = require("../resolver");

/** Build a temp store dir and return a Paths rooted at it. */
function tmpPaths() {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "resthippo-resolver-test-"),
  );
  return new Paths(dir);
}

/** Write an (empty) request file `<collId>/requests/<reqId>.json`. */
function putRequest(paths, collId, reqId) {
  const dir = paths.requestsDir(collId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${reqId}.json`), "{}");
}

/** Write the global manifest listing the given collection ids. */
function putManifest(paths, collIds) {
  fs.mkdirSync(paths.collectionsDir(), { recursive: true });
  fs.writeFileSync(
    paths.manifestPath(),
    JSON.stringify({ collections: collIds.map((id) => ({ id })) }),
  );
}

/** Capture console.warn calls for the duration of `fn`. */
function captureWarn(fn) {
  const warnings = [];
  const orig = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    fn();
  } finally {
    console.warn = orig;
  }
  return warnings;
}

test("resolve() maps a request to its owning collection", () => {
  const paths = tmpPaths();
  putRequest(paths, "collA", "req-1");
  putRequest(paths, "collB", "req-2");
  const r = new Resolver(paths);

  assert.equal(r.resolve("req-1"), "collA");
  assert.equal(r.resolve("req-2"), "collB");
  assert.equal(r.duplicates().size, 0);
});

test("resolve() throws NOT_FOUND for an unknown request", () => {
  const paths = tmpPaths();
  putRequest(paths, "collA", "req-1");
  const r = new Resolver(paths);

  assert.throws(
    () => r.resolve("nope"),
    (err) => err.code === "NOT_FOUND",
  );
});

test("a duplicate request ID resolves to the lexicographically-first collection", () => {
  const paths = tmpPaths();
  // Same request file copied into two collections. Create them in an order that
  // does NOT match the sorted order, to prove resolution is order-independent.
  putRequest(paths, "zeta", "dup-req");
  putRequest(paths, "alpha", "dup-req");
  const r = new Resolver(paths);

  let warnings;
  let owner;
  warnings = captureWarn(() => {
    owner = r.resolve("dup-req");
  });

  assert.equal(
    owner,
    "alpha",
    "first-by-sort collection wins, not last-scanned",
  );
  const dups = r.duplicates();
  assert.deepEqual(dups.get("dup-req"), ["alpha", "zeta"]);
  assert.equal(dups.size, 1);
  assert.equal(
    warnings.length,
    1,
    "exactly one warning per duplicated request",
  );
  assert.match(warnings[0], /dup-req/);
  assert.match(warnings[0], /alpha/);
  assert.match(warnings[0], /zeta/);
});

test("duplicate resolution is stable across an invalidate()/rebuild", () => {
  const paths = tmpPaths();
  putRequest(paths, "collB", "dup-req");
  putRequest(paths, "collA", "dup-req");
  const r = new Resolver(paths);

  let before;
  captureWarn(() => {
    before = r.resolve("dup-req");
  });
  r.invalidate();
  let after;
  captureWarn(() => {
    after = r.resolve("dup-req");
  });
  assert.equal(before, "collA");
  assert.equal(after, before, "same owner after a rebuild");
});

test("duplicates() only reports requests in more than one collection", () => {
  const paths = tmpPaths();
  putRequest(paths, "collA", "solo-1");
  putRequest(paths, "collA", "shared");
  putRequest(paths, "collB", "shared");
  putRequest(paths, "collB", "solo-2");
  const r = new Resolver(paths);

  captureWarn(() => r.resolve("shared"));
  const dups = r.duplicates();
  assert.deepEqual([...dups.keys()], ["shared"]);
  assert.equal(r.resolve("solo-1"), "collA");
  assert.equal(r.resolve("solo-2"), "collB");
});

test("a directory not listed in the manifest (an orphan) is skipped", () => {
  const paths = tmpPaths();
  // The live collection (in the manifest) and an orphan copy left on disk — e.g.
  // a previous session's seeded-but-unpersisted default. Both hold the same
  // request file plus the orphan has one of its own.
  putRequest(paths, "live", "shared-req");
  putRequest(paths, "orphan", "shared-req");
  putRequest(paths, "orphan", "orphan-only");
  putManifest(paths, ["live"]);
  const r = new Resolver(paths);

  let owner;
  const warnings = captureWarn(() => {
    owner = r.resolve("shared-req");
  });
  assert.equal(
    owner,
    "live",
    "resolves to the manifest collection, not the orphan",
  );
  assert.equal(
    warnings.length,
    0,
    "no duplicate warning — the orphan is ignored",
  );
  assert.equal(r.duplicates().size, 0);
  assert.throws(
    () => r.resolve("orphan-only"),
    (err) => err.code === "NOT_FOUND",
    "a request that lives only in an orphan dir is not resolvable",
  );
});

test("a genuine duplicate across two MANIFEST collections is still reported", () => {
  const paths = tmpPaths();
  // Both collections are real (listed) — a legitimately merged backup. The
  // manifest gate must not suppress this case.
  putRequest(paths, "zeta", "dup-req");
  putRequest(paths, "alpha", "dup-req");
  putManifest(paths, ["alpha", "zeta"]);
  const r = new Resolver(paths);

  let owner;
  const warnings = captureWarn(() => {
    owner = r.resolve("dup-req");
  });
  assert.equal(owner, "alpha");
  assert.deepEqual(r.duplicates().get("dup-req"), ["alpha", "zeta"]);
  assert.equal(warnings.length, 1);
});

test("a non-directory entry (index.json manifest) is ignored by the scan", () => {
  const paths = tmpPaths();
  putRequest(paths, "collA", "req-1");
  // The global manifest lives directly under collections/ — it must not be
  // treated as a collection directory.
  fs.writeFileSync(paths.manifestPath(), "{}");
  const r = new Resolver(paths);

  assert.equal(r.resolve("req-1"), "collA");
  assert.equal(r.duplicates().size, 0);
});
