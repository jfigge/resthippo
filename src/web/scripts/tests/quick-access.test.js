/**
 * tests/quick-access.test.js
 *
 * Unit tests for the pure Favorites / Recents list helpers: entry creation,
 * recents dedupe + cap + ordering, favorite add/dedupe, and the lifecycle
 * prunes (delete by id, delete by collection, reconcile on rename/move).
 *
 * Run with:   node --test scripts/tests/quick-access.test.js
 */

"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RECENTS_CAP,
  makeEntry,
  addRecent,
  addFavorite,
  hasId,
  removeIds,
  removeCollection,
  reconcile,
} from "../quick-access.js";

test("makeEntry captures id, name, method and collection", () => {
  const e = makeEntry({ id: "r1", name: "List users", method: "GET" }, "c1");
  assert.deepEqual(e, {
    collectionId: "c1",
    requestId: "r1",
    name: "List users",
    method: "GET",
  });
});

test("makeEntry falls back to GET and empty name", () => {
  const e = makeEntry({ id: "r1" }, null);
  assert.equal(e.method, "GET");
  assert.equal(e.name, "");
  assert.equal(e.collectionId, null);
});

test("addRecent prepends newest-first", () => {
  let list = [];
  list = addRecent(list, makeEntry({ id: "a", method: "GET" }, "c1"));
  list = addRecent(list, makeEntry({ id: "b", method: "POST" }, "c1"));
  assert.deepEqual(
    list.map((e) => e.requestId),
    ["b", "a"],
  );
});

test("addRecent dedupes by requestId and moves it to the front", () => {
  let list = [];
  for (const id of ["a", "b", "c"])
    list = addRecent(list, makeEntry({ id }, "c1"));
  list = addRecent(list, makeEntry({ id: "a", name: "again" }, "c1"));
  assert.deepEqual(
    list.map((e) => e.requestId),
    ["a", "c", "b"],
  );
  // Only one entry for "a", and it reflects the latest snapshot.
  assert.equal(list.filter((e) => e.requestId === "a").length, 1);
  assert.equal(list[0].name, "again");
});

test("addRecent caps to RECENTS_CAP, dropping the oldest", () => {
  let list = [];
  for (let i = 0; i < RECENTS_CAP + 5; i++)
    list = addRecent(list, makeEntry({ id: `r${i}` }, "c1"));
  assert.equal(list.length, RECENTS_CAP);
  // newest is the last inserted; oldest survivors start at index RECENTS_CAP+4-...
  assert.equal(list[0].requestId, `r${RECENTS_CAP + 4}`);
  assert.ok(!list.some((e) => e.requestId === "r0"));
});

test("addRecent ignores entries without a requestId", () => {
  const list = [makeEntry({ id: "a" }, "c1")];
  assert.equal(addRecent(list, makeEntry({}, "c1")), list);
});

test("addFavorite appends new and is idempotent", () => {
  let list = [];
  list = addFavorite(list, makeEntry({ id: "a" }, "c1"));
  const same = addFavorite(list, makeEntry({ id: "a" }, "c1"));
  assert.equal(same, list); // unchanged reference when already favorited
  list = addFavorite(list, makeEntry({ id: "b" }, "c2"));
  assert.deepEqual(
    list.map((e) => e.requestId),
    ["a", "b"],
  );
});

test("hasId reports membership", () => {
  const list = [makeEntry({ id: "a" }, "c1")];
  assert.equal(hasId(list, "a"), true);
  assert.equal(hasId(list, "z"), false);
  assert.equal(hasId(undefined, "a"), false);
});

test("removeIds drops matching entries and is reference-stable otherwise", () => {
  const list = [makeEntry({ id: "a" }, "c1"), makeEntry({ id: "b" }, "c1")];
  const pruned = removeIds(list, new Set(["a"]));
  assert.deepEqual(
    pruned.map((e) => e.requestId),
    ["b"],
  );
  assert.equal(removeIds(list, new Set(["zzz"])), list); // no change → same ref
});

test("removeCollection drops every entry in a deleted collection", () => {
  const list = [
    makeEntry({ id: "a" }, "c1"),
    makeEntry({ id: "b" }, "c2"),
    makeEntry({ id: "c" }, "c1"),
  ];
  const pruned = removeCollection(list, "c1");
  assert.deepEqual(
    pruned.map((e) => e.requestId),
    ["b"],
  );
  assert.equal(removeCollection(list, "missing"), list);
});

test("reconcile refreshes name/method for the active collection", () => {
  const list = [
    makeEntry({ id: "a", name: "old", method: "GET" }, "c1"),
    makeEntry({ id: "b", name: "keep", method: "POST" }, "c2"),
  ];
  const live = new Map([["a", { name: "new", method: "PUT" }]]);
  const next = reconcile(list, "c1", live);
  assert.equal(next[0].name, "new");
  assert.equal(next[0].method, "PUT");
  // Entry in another collection is untouched.
  assert.equal(next[1].name, "keep");
});

test("reconcile drops active-collection entries that no longer exist", () => {
  const list = [
    makeEntry({ id: "a" }, "c1"),
    makeEntry({ id: "gone" }, "c1"),
    makeEntry({ id: "b" }, "c2"),
  ];
  const live = new Map([["a", { name: "", method: "GET" }]]);
  const next = reconcile(list, "c1", live);
  assert.deepEqual(
    next.map((e) => e.requestId),
    ["a", "b"],
  );
});

test("reconcile is reference-stable when nothing changed", () => {
  const list = [makeEntry({ id: "a", name: "n", method: "GET" }, "c1")];
  const live = new Map([["a", { name: "n", method: "GET" }]]);
  assert.equal(reconcile(list, "c1", live), list);
});
