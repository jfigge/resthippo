/**
 * tree-model.test.js — unit tests for the pure node-tree operations extracted
 * from TreeView (tree-model.js). No DOM: these exercise the tree logic directly,
 * with a focus on depth handling, immutability, and the reference-change
 * semantics the view relies on.
 *
 * Run with:   node --test src/web/scripts/components/tests/tree-model.test.js
 */
"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import * as M from "../tree-model.js";

/** Fresh sample tree: two top-level collections, one nested folder. */
const tree = () => [
  {
    id: "c1",
    type: "collection",
    name: "A",
    children: [
      { id: "r1", type: "request", name: "R1", method: "GET" },
      {
        id: "f1",
        type: "collection",
        name: "F",
        children: [{ id: "r2", type: "request", name: "R2", method: "POST" }],
      },
    ],
  },
  {
    id: "c2",
    type: "collection",
    name: "B",
    children: [{ id: "r3", type: "request", name: "R3" }],
  },
];

// ── findNode / findParentId ─────────────────────────────────────────────────

test("findNode locates a node at any depth, or returns null", () => {
  const t = tree();
  assert.equal(M.findNode(t, "c1").name, "A");
  assert.equal(M.findNode(t, "r2").name, "R2", "found two levels deep");
  assert.equal(M.findNode(t, "nope"), null);
});

test("findParentId returns null for top-level, the parent id when nested, undefined when missing", () => {
  const t = tree();
  assert.equal(M.findParentId(t, "c1"), null, "top-level has no parent");
  assert.equal(M.findParentId(t, "r1"), "c1");
  assert.equal(M.findParentId(t, "r2"), "f1", "nested parent");
  assert.equal(M.findParentId(t, "missing"), undefined);
});

// ── insertChild ─────────────────────────────────────────────────────────────

test("insertChild prepends to the parent's children, immutably", () => {
  const t = tree();
  const child = { id: "rNew", type: "request", name: "New" };
  const out = M.insertChild(t, "c1", child);
  assert.deepEqual(
    out[0].children.map((n) => n.id),
    ["rNew", "r1", "f1"],
    "prepended",
  );
  assert.deepEqual(
    t[0].children.map((n) => n.id),
    ["r1", "f1"],
    "original untouched",
  );
});

test("insertChild works on a deeply-nested parent", () => {
  const out = M.insertChild(tree(), "f1", {
    id: "x",
    type: "request",
    name: "X",
  });
  assert.deepEqual(
    M.findNode(out, "f1").children.map((n) => n.id),
    ["x", "r2"],
  );
});

// ── removeNode ──────────────────────────────────────────────────────────────

test("removeNode deletes at any depth, keeps siblings, and is immutable", () => {
  const t = tree();
  const out = M.removeNode(t, "r2");
  assert.equal(M.findNode(out, "r2"), null);
  assert.equal(M.findNode(out, "r1").name, "R1", "sibling kept");
  assert.equal(M.findNode(t, "r2").name, "R2", "original untouched");
});

test("removeNode removes a whole subtree (collection + descendants)", () => {
  const out = M.removeNode(tree(), "f1");
  assert.equal(M.findNode(out, "f1"), null);
  assert.equal(M.findNode(out, "r2"), null, "descendant gone with the folder");
});

// ── updateNodeName / patchNodeFields ────────────────────────────────────────

test("updateNodeName renames at depth, immutably", () => {
  const t = tree();
  const out = M.updateNodeName(t, "r2", "Renamed");
  assert.equal(M.findNode(out, "r2").name, "Renamed");
  assert.equal(M.findNode(t, "r2").name, "R2");
});

test("patchNodeFields merges fields without dropping existing ones, immutably", () => {
  const t = tree();
  const out = M.patchNodeFields(t, "r1", { method: "DELETE", url: "/x" });
  const r1 = M.findNode(out, "r1");
  assert.equal(r1.method, "DELETE");
  assert.equal(r1.url, "/x");
  assert.equal(r1.name, "R1", "untouched field preserved");
  assert.equal(M.findNode(t, "r1").method, "GET", "original untouched");
});

// ── insertNodeAfter / insertBefore ──────────────────────────────────────────

test("insertNodeAfter places the node right after the target (top-level + nested)", () => {
  const top = M.insertNodeAfter(tree(), "c1", {
    id: "cX",
    type: "collection",
    name: "X",
    children: [],
  });
  assert.deepEqual(
    top.map((n) => n.id),
    ["c1", "cX", "c2"],
  );

  const nested = M.insertNodeAfter(tree(), "r1", {
    id: "rX",
    type: "request",
    name: "X",
  });
  assert.deepEqual(
    M.findNode(nested, "c1").children.map((n) => n.id),
    ["r1", "rX", "f1"],
  );
});

test("insertBefore places the node right before the target (top-level + nested)", () => {
  const top = M.insertBefore(tree(), "c2", {
    id: "cX",
    type: "collection",
    name: "X",
    children: [],
  });
  assert.deepEqual(
    top.map((n) => n.id),
    ["c1", "cX", "c2"],
  );

  const nested = M.insertBefore(tree(), "r2", {
    id: "rX",
    type: "request",
    name: "X",
  });
  assert.deepEqual(
    M.findNode(nested, "f1").children.map((n) => n.id),
    ["rX", "r2"],
  );
});

// ── cloneWithNewIds ─────────────────────────────────────────────────────────

test("cloneWithNewIds regenerates every id (node + descendants) but preserves fields", () => {
  const original = M.findNode(tree(), "c1");
  const clone = M.cloneWithNewIds(original);
  assert.notEqual(clone.id, original.id);
  assert.notEqual(clone.children[0].id, "r1", "child id regenerated");
  assert.notEqual(
    clone.children[1].children[0].id,
    "r2",
    "grandchild id regenerated",
  );
  assert.equal(clone.name, "A", "name preserved");
  assert.equal(clone.children[0].name, "R1");
});

test("cloneWithNewIds regenerates request-level row-array ids (params/headers/bodyFormRows)", () => {
  const req = {
    id: "r",
    type: "request",
    name: "R",
    params: [{ id: "p1", name: "a" }],
    headers: [{ id: "h1", name: "X" }],
    bodyFormRows: [{ id: "b1", name: "f" }],
  };
  const clone = M.cloneWithNewIds(req);
  assert.notEqual(clone.params[0].id, "p1");
  assert.notEqual(clone.headers[0].id, "h1");
  assert.notEqual(clone.bodyFormRows[0].id, "b1");
  assert.equal(clone.params[0].name, "a", "row data preserved");
});

// ── getFlatRequests / collectRequestIds ─────────────────────────────────────

test("getFlatRequests returns only requests, in depth-first visual order", () => {
  assert.deepEqual(
    M.getFlatRequests(tree()).map((n) => n.id),
    ["r1", "r2", "r3"],
  );
});

test("collectRequestIds: a request yields itself; a folder/collection yields all descendants", () => {
  const t = tree();
  assert.deepEqual(M.collectRequestIds(M.findNode(t, "r1")), ["r1"]);
  assert.deepEqual(M.collectRequestIds(M.findNode(t, "f1")), ["r2"]);
  assert.deepEqual(
    M.collectRequestIds(M.findNode(t, "c1")),
    ["r1", "r2"],
    "depth-first",
  );
});
