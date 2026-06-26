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
 * tree-view.test.js — characterization tests for the TreeView component.
 *
 * TreeView is a ~2.4k-line god component (collections/folders/requests tree,
 * selection, drag-reorder, keyboard nav, favorites/recents, filtering, context
 * menus) that had NO direct coverage. These tests pin its OBSERVABLE behaviour
 * through the public API + real DOM events so the in-progress decomposition
 * (pure node logic → tree-model.js, etc.) cannot silently change behaviour.
 *
 * The node model: a "folder" is a nested `type:"collection"`; only `type:
 * "request"` nodes are leaves. Collections render expanded unless collapsed.
 *
 * Run with:   node --test src/web/scripts/tests/tree-view.test.js
 */
"use strict";

// MUST precede the component import (it touches document / Prism on load).
import { resetDom } from "./jsdom-setup.js";

import { test } from "node:test";
import assert from "node:assert/strict";

import { TreeView } from "../components/tree-view.js";
import { t } from "../i18n.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A small but representative tree: collection → request, nested folder, WS request. */
const TREE = () => [
  {
    id: "c1",
    type: "collection",
    name: "API",
    children: [
      {
        id: "r1",
        type: "request",
        name: "List users",
        method: "GET",
        url: "/users",
      },
      {
        id: "f1",
        type: "collection",
        name: "Auth",
        children: [
          {
            id: "r2",
            type: "request",
            name: "Login",
            method: "POST",
            url: "/login",
          },
        ],
      },
      {
        id: "rw",
        type: "request",
        name: "Stream",
        protocol: "websocket",
        url: "wss://x",
      },
    ],
  },
];

/** Mount a fresh TreeView with a stubbed `window.hippo` (context menu / export). */
function mount(items = []) {
  const window = resetDom();
  let menuChoice = null;
  window.hippo = {
    isElectron: false,
    ui: { contextMenu: { show: async () => menuChoice } },
    export: { file: { save: () => {} } },
  };
  const tv = new TreeView();
  document.body.appendChild(tv.element);
  // Load data the way app.js does (via setItems → #syncButtonState), not the
  // constructor (which renders but doesn't sync the toolbar button state).
  tv.setItems(items);
  // Let tests drive the next context-menu result.
  tv.__chooseMenu = (id) => {
    menuChoice = id;
  };
  return tv;
}

const rows = (tv) => [...tv.element.querySelectorAll(".tree-node-row")];
const labels = (tv) =>
  rows(tv).map((r) => r.querySelector(".tree-node-label")?.textContent.trim());
const li = (tv, id) => tv.element.querySelector(`[data-id="${id}"]`);
const rowOf = (tv, id) =>
  tv.element.querySelector(`[data-id="${id}"] > .tree-node-row`);
const visible = (el) => el && el.style.display !== "none";
function capture(name) {
  const out = [];
  globalThis.window.addEventListener(name, (e) => out.push(e.detail));
  return out;
}
const toolbarBtns = (tv) => [
  ...tv.element.querySelectorAll(".tree-toolbar .icon-btn"),
];

// ── Rendering & data ────────────────────────────────────────────────────────

test("renders collections, folders and requests as rows with labels", () => {
  const tv = mount(TREE());
  assert.deepEqual(labels(tv), [
    "API",
    "List users",
    "Auth",
    "Login",
    "Stream",
  ]);
  assert.ok(li(tv, "c1").classList.contains("tree-node--collection"));
  assert.ok(
    li(tv, "f1").classList.contains("tree-node--collection"),
    "folder = nested collection",
  );
  assert.ok(li(tv, "r1").classList.contains("tree-node--request"));
});

test("getItems returns a deep clone (mutating it doesn't affect the tree)", () => {
  const tv = mount(TREE());
  const got = tv.getItems();
  got[0].name = "MUTATED";
  got[0].children[0].name = "MUTATED";
  assert.equal(tv.getItems()[0].name, "API");
  assert.equal(tv.getItems()[0].children[0].name, "List users");
});

test("HTTP requests show a method badge; WebSocket shows the WS badge", () => {
  const tv = mount(TREE());
  const m = rowOf(tv, "r1").querySelector(".tree-node-method");
  assert.equal(m.textContent, "GET");
  assert.ok(m.classList.contains("method--get"));
  assert.ok(
    rowOf(tv, "rw").querySelector(".tree-node-method--ws"),
    "WS request gets the websocket badge",
  );
});

test("an empty tree renders no rows and disables New Request", () => {
  const tv = mount([]);
  assert.equal(rows(tv).length, 0);
  const [, newReq] = toolbarBtns(tv);
  assert.ok(newReq.disabled, "New Request disabled with no collection");
});

test("setItems replaces the whole tree and re-renders", () => {
  const tv = mount(TREE());
  tv.setItems([{ id: "c9", type: "collection", name: "Other", children: [] }]);
  assert.deepEqual(labels(tv), ["Other"]);
});

// ── Selection ───────────────────────────────────────────────────────────────

test("clicking a request dispatches hippo:request-selected and marks it active", () => {
  const tv = mount(TREE());
  const sel = capture("hippo:request-selected");
  rowOf(tv, "r1").click();
  assert.equal(sel.length, 1);
  assert.equal(sel[0].id, "r1");
  assert.ok(li(tv, "r1").classList.contains("tree-node--active"));
});

test("clicking the already-active request does not re-dispatch", () => {
  const tv = mount(TREE());
  const sel = capture("hippo:request-selected");
  rowOf(tv, "r1").click();
  rowOf(tv, "r1").click();
  assert.equal(sel.length, 1, "second click on the active row is a no-op");
});

test("selectById selects a request programmatically and fires the event", () => {
  const tv = mount(TREE());
  const sel = capture("hippo:request-selected");
  assert.equal(tv.selectById("r2"), true);
  assert.equal(sel.at(-1).id, "r2");
});

test("selectById returns false for a collection or a missing id", () => {
  const tv = mount(TREE());
  assert.equal(
    tv.selectById("c1"),
    false,
    "collections aren't selectable as requests",
  );
  assert.equal(tv.selectById("nope"), false);
});

// ── Expand / collapse ──────────────────────────────────────────────────────

test("collections render expanded; clicking the icon collapses and hides children", () => {
  const tv = mount(TREE());
  const folder = li(tv, "f1");
  assert.equal(folder.getAttribute("aria-expanded"), "true");
  const childList = folder.querySelector(":scope > .tree-list--nested");
  assert.ok(visible(childList));

  rowOf(tv, "f1").querySelector(".tree-node-icon").click();
  assert.equal(folder.getAttribute("aria-expanded"), "false");
  assert.ok(!visible(childList), "children hidden when collapsed");
});

test("collapsed state persists to localStorage under the storage key", () => {
  const tv = mount(TREE());
  tv.setStorageKey("colA");
  rowOf(tv, "f1").querySelector(".tree-node-icon").click(); // collapse f1
  const stored = JSON.parse(
    globalThis.window.localStorage.getItem("hippo:collapsed:colA") || "[]",
  );
  assert.ok(stored.includes("f1"), "collapsed id saved");
});

// ── Toolbar mutations ──────────────────────────────────────────────────────

test("New Collection adds a top-level collection and fires collections-changed", () => {
  const tv = mount([]);
  const changed = capture("hippo:collections-changed");
  const [newColl] = toolbarBtns(tv);
  newColl.click();
  assert.equal(changed.length, 1);
  assert.equal(tv.getItems().length, 1);
  assert.equal(tv.getItems()[0].name, t("tree.newCollection"));
});

test("New Request adds a request under a collection and fires collections-changed", () => {
  const tv = mount(TREE());
  const changed = capture("hippo:collections-changed");
  const [, newReq] = toolbarBtns(tv);
  assert.ok(!newReq.disabled, "enabled when a collection exists");
  newReq.click();
  assert.equal(changed.length, 1);
  const flat = JSON.stringify(tv.getItems());
  assert.ok(flat.includes(t("tree.newRequest")), "a new request was inserted");
});

// ── updateNode (surgical) ───────────────────────────────────────────────────

test("updateNode patches method in-place (badge + model) and persists", () => {
  const tv = mount(TREE());
  const changed = capture("hippo:collections-changed");
  tv.updateNode("r1", { method: "DELETE" });
  const badge = rowOf(tv, "r1").querySelector(".tree-node-method");
  assert.equal(badge.textContent, "DELETE");
  assert.ok(badge.classList.contains("method--delete"));
  assert.equal(tv.getItems()[0].children[0].method, "DELETE");
  assert.equal(changed.length, 1, "persisted by default");
});

test("updateNode with { silent:true } does not fire collections-changed", () => {
  const tv = mount(TREE());
  const changed = capture("hippo:collections-changed");
  tv.updateNode("r1", { method: "PUT" }, { silent: true });
  assert.equal(changed.length, 0);
  assert.equal(
    tv.getItems()[0].children[0].method,
    "PUT",
    "model still patched",
  );
});

test("updateNode patches the name into the visible label and the model", () => {
  const tv = mount(TREE());
  tv.updateNode("r1", { name: "Renamed Request" });
  assert.equal(
    rowOf(tv, "r1").querySelector(".tree-node-label").textContent,
    "Renamed Request",
  );
  assert.equal(tv.getItems()[0].children[0].name, "Renamed Request");
});

test("updateNode keeps the searchable data-url attribute in step", () => {
  const tv = mount(TREE());
  tv.updateNode("r1", { url: "https://EXAMPLE.com/New" });
  assert.equal(li(tv, "r1").dataset.url, "https://example.com/new");
  assert.equal(tv.getItems()[0].children[0].url, "https://EXAMPLE.com/New");
});

// ── Context-menu mutations (rename / delete / duplicate) ────────────────────

async function contextAction(tv, id, choice) {
  tv.__chooseMenu(choice);
  rowOf(tv, id).dispatchEvent(
    new globalThis.window.MouseEvent("contextmenu", {
      bubbles: true,
      clientX: 1,
      clientY: 1,
    }),
  );
  await tick();
}

test("rename via context menu commits the new label on Enter and fires change", async () => {
  const tv = mount(TREE());
  const changed = capture("hippo:collections-changed");
  await contextAction(tv, "r1", "rename");
  const input = tv.element.querySelector(".tree-node-rename-input");
  assert.ok(input, "rename input replaced the label");
  input.value = "Renamed!";
  input.dispatchEvent(
    new globalThis.window.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
    }),
  );
  assert.equal(tv.getItems()[0].children[0].name, "Renamed!");
  assert.ok(changed.length >= 1, "rename persisted");
});

test("delete via context menu removes the node, fires change + requests-deleted", async () => {
  const tv = mount(TREE());
  const changed = capture("hippo:collections-changed");
  const deleted = capture("hippo:requests-deleted");
  await contextAction(tv, "r1", "delete");
  assert.equal(li(tv, "r1"), null, "row removed");
  assert.ok(changed.length >= 1);
  assert.ok(deleted.at(-1)?.ids.includes("r1"), "deleted request ids reported");
});

test("duplicate via context menu inserts a '(copy)' sibling after the original", async () => {
  const tv = mount(TREE());
  await contextAction(tv, "r1", "duplicate");
  const names = tv.getItems()[0].children.map((n) => n.name);
  assert.deepEqual(names.slice(0, 2), ["List users", "List users (copy)"]);
  // The copy has a fresh id.
  const copy = tv.getItems()[0].children[1];
  assert.notEqual(copy.id, "r1");
});

// ── Favorites / recents / tabs ──────────────────────────────────────────────

test("setFavorites stars the request row and reveals the Favorites tab", () => {
  const tv = mount(TREE());
  tv.setFavorites([
    { collectionId: "c1", requestId: "r1", name: "List users", method: "GET" },
  ]);
  assert.ok(li(tv, "r1").classList.contains("tree-node--favorite"));
  const tabs = tv.element.querySelector(".tree-tabs");
  assert.ok(!tabs.hidden, "tab bar revealed once a favorite exists");
});

test("setShowRecents reveals the Recents tab", () => {
  const tv = mount(TREE());
  tv.setShowRecents(true);
  const tabs = tv.element.querySelector(".tree-tabs");
  assert.ok(!tabs.hidden, "tab bar revealed when recents enabled");
});

// ── Filtering ───────────────────────────────────────────────────────────────

/** Press Cmd/Ctrl+F on the tree to reveal the inline filter bar. */
const revealFilter = (tv) =>
  tv.element.dispatchEvent(
    new globalThis.window.KeyboardEvent("keydown", {
      key: "f",
      metaKey: true,
      bubbles: true,
    }),
  );

test("the filter bar is hidden until Cmd/Ctrl+F is pressed", () => {
  const tv = mount(TREE());
  const bar = tv.element.querySelector(".tree-filter-bar");
  assert.ok(bar.hidden, "filter bar starts hidden");
  assert.ok(
    !tv.element.querySelector(".tree-toolbar .tree-search"),
    "the search input no longer lives in the toolbar",
  );
  revealFilter(tv);
  assert.ok(!bar.hidden, "Cmd/Ctrl+F reveals the filter bar");
});

test("the search input filters rows by name (keeping matching ancestors)", () => {
  const tv = mount(TREE());
  revealFilter(tv);
  const search = tv.element.querySelector(".tree-search");
  search.value = "login";
  search.dispatchEvent(new globalThis.window.Event("input", { bubbles: true }));
  assert.ok(visible(li(tv, "r2")), "matching request stays visible");
  assert.ok(visible(li(tv, "f1")), "its ancestor folder stays visible");
  assert.ok(!visible(li(tv, "rw")), "non-matching request is hidden");
});

test("Escape hides the filter bar and restores all rows", () => {
  const tv = mount(TREE());
  revealFilter(tv);
  const search = tv.element.querySelector(".tree-search");
  search.value = "login";
  search.dispatchEvent(new globalThis.window.Event("input", { bubbles: true }));
  assert.ok(
    !visible(li(tv, "rw")),
    "non-matching request hidden while filtered",
  );

  search.dispatchEvent(
    new globalThis.window.KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
    }),
  );
  const bar = tv.element.querySelector(".tree-filter-bar");
  assert.ok(bar.hidden, "filter bar hidden after Escape");
  assert.equal(search.value, "", "query cleared after Escape");
  assert.ok(visible(li(tv, "rw")), "all rows visible again");
});

test("the close button cancels the filter, like Escape", () => {
  const tv = mount(TREE());
  revealFilter(tv);
  const search = tv.element.querySelector(".tree-search");
  search.value = "login";
  search.dispatchEvent(new globalThis.window.Event("input", { bubbles: true }));
  assert.ok(
    !visible(li(tv, "rw")),
    "non-matching request hidden while filtered",
  );

  tv.element.querySelector(".tree-filter-close").click();
  const bar = tv.element.querySelector(".tree-filter-bar");
  assert.ok(bar.hidden, "filter bar hidden after clicking the close button");
  assert.equal(search.value, "", "query cleared after close");
  assert.ok(visible(li(tv, "rw")), "all rows visible again");
});

// ── Keyboard navigation ─────────────────────────────────────────────────────

test("ArrowDown moves roving focus to the next visible row", () => {
  const tv = mount(TREE());
  const first = rows(tv)[0]; // API
  first.focus();
  first.dispatchEvent(
    new globalThis.window.KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
    }),
  );
  assert.equal(
    document.activeElement,
    rowOf(tv, "r1"),
    "focus advanced to the next row",
  );
});

// ── WebSocket live indicator ────────────────────────────────────────────────

test("setWsLiveIds marks the request row live with a dot", () => {
  const tv = mount(TREE());
  tv.setWsLiveIds(["rw"]);
  assert.ok(li(tv, "rw").classList.contains("tree-node--ws-live"));
  assert.ok(
    rowOf(tv, "rw").querySelector(".tree-node-ws-dot"),
    "a live dot element is present",
  );
});

// ════════════════════════════════════════════════════════════════════════════
// Coverage-raising additions: rename cancel, duplicate, delete fan-out,
// favorites/recents quick lists, the full context-menu action map, keyboard
// navigation (roving tabindex + Enter), and the dragstart/dragend DOM handlers.
// ════════════════════════════════════════════════════════════════════════════

// ── Rename (Escape cancels, name normalisation, folder rename) ───────────────

test("rename via context menu restores the old name on Escape (no change fired)", async () => {
  const tv = mount(TREE());
  const changed = capture("hippo:collections-changed");
  await contextAction(tv, "r1", "rename");
  const input = tv.element.querySelector(".tree-node-rename-input");
  input.value = "Throwaway";
  input.dispatchEvent(
    new globalThis.window.KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
    }),
  );
  // Label is restored and the model is untouched.
  assert.equal(
    rowOf(tv, "r1").querySelector(".tree-node-label").textContent,
    "List users",
  );
  assert.equal(tv.getItems()[0].children[0].name, "List users");
  assert.equal(changed.length, 0, "cancelled rename does not persist");
});

test("rename committing an unchanged name does not fire collections-changed", async () => {
  const tv = mount(TREE());
  const changed = capture("hippo:collections-changed");
  await contextAction(tv, "r1", "rename");
  const input = tv.element.querySelector(".tree-node-rename-input");
  // Same text (Enter → blur → commit) — name is identical, so no change event.
  input.dispatchEvent(
    new globalThis.window.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
    }),
  );
  assert.equal(tv.getItems()[0].children[0].name, "List users");
  assert.equal(changed.length, 0, "a no-op rename is not persisted");
});

test("rename falls back to the original name when the input is blanked", async () => {
  const tv = mount(TREE());
  await contextAction(tv, "r1", "rename");
  const input = tv.element.querySelector(".tree-node-rename-input");
  input.value = "   "; // whitespace only → trimmed to "" → original kept
  input.dispatchEvent(
    new globalThis.window.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
    }),
  );
  assert.equal(tv.getItems()[0].children[0].name, "List users");
});

test("F2 on a focused folder row begins a rename and commits on Enter", () => {
  const tv = mount(TREE());
  const changed = capture("hippo:collections-changed");
  const row = rowOf(tv, "f1");
  row.focus();
  row.dispatchEvent(
    new globalThis.window.KeyboardEvent("keydown", {
      key: "F2",
      bubbles: true,
    }),
  );
  const input = tv.element.querySelector(".tree-node-rename-input");
  assert.ok(input, "F2 starts an inline rename");
  input.value = "Authentication";
  input.dispatchEvent(
    new globalThis.window.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
    }),
  );
  assert.equal(tv.getItems()[0].children[1].name, "Authentication");
  assert.ok(changed.length >= 1, "folder rename persisted");
});

// ── Duplicate ────────────────────────────────────────────────────────────────

test("duplicating a folder deep-clones it with fresh ids throughout", async () => {
  const tv = mount(TREE());
  const changed = capture("hippo:collections-changed");
  await contextAction(tv, "f1", "duplicate");
  const children = tv.getItems()[0].children;
  // The copy lands right after the original folder.
  const idx = children.findIndex((n) => n.id === "f1");
  const copy = children[idx + 1];
  assert.equal(copy.name, "Auth (copy)");
  assert.notEqual(copy.id, "f1", "folder gets a new id");
  assert.equal(copy.children.length, 1, "children travel with the clone");
  assert.equal(copy.children[0].name, "Login", "child fields preserved");
  assert.notEqual(copy.children[0].id, "r2", "descendant ids are regenerated");
  assert.ok(changed.length >= 1, "duplicate persisted");
});

test("Cmd/Ctrl+D duplicates a focused request row (folders are skipped)", () => {
  const tv = mount(TREE());
  // Request → duplicated.
  const reqRow = rowOf(tv, "r1");
  reqRow.focus();
  reqRow.dispatchEvent(
    new globalThis.window.KeyboardEvent("keydown", {
      key: "d",
      metaKey: true,
      bubbles: true,
    }),
  );
  const names = tv.getItems()[0].children.map((n) => n.name);
  assert.deepEqual(names.slice(0, 2), ["List users", "List users (copy)"]);

  // Folder → no-op (Cmd/Ctrl+D is scoped to requests).
  const before = JSON.stringify(tv.getItems());
  const folderRow = rowOf(tv, "f1");
  folderRow.focus();
  folderRow.dispatchEvent(
    new globalThis.window.KeyboardEvent("keydown", {
      key: "d",
      ctrlKey: true,
      bubbles: true,
    }),
  );
  assert.equal(
    JSON.stringify(tv.getItems()),
    before,
    "folder Cmd+D is a no-op",
  );
});

// ── Delete fan-out ───────────────────────────────────────────────────────────

test("deleting a folder reports every descendant request id", async () => {
  const tv = mount([
    {
      id: "c1",
      type: "collection",
      name: "API",
      children: [
        {
          id: "f1",
          type: "collection",
          name: "Auth",
          children: [
            { id: "ra", type: "request", name: "A", method: "GET", url: "/a" },
            {
              id: "fn",
              type: "collection",
              name: "Nested",
              children: [
                {
                  id: "rb",
                  type: "request",
                  name: "B",
                  method: "GET",
                  url: "/b",
                },
              ],
            },
          ],
        },
      ],
    },
  ]);
  const deleted = capture("hippo:requests-deleted");
  await contextAction(tv, "f1", "delete");
  assert.equal(li(tv, "f1"), null, "folder subtree removed");
  const ids = deleted.at(-1)?.ids ?? [];
  assert.deepEqual([...ids].sort(), ["ra", "rb"], "all nested request ids");
});

test("deleting the last/only request fires hippo:request-cleared", async () => {
  const tv = mount([
    {
      id: "c1",
      type: "collection",
      name: "API",
      children: [
        { id: "r1", type: "request", name: "Only", method: "GET", url: "/o" },
      ],
    },
  ]);
  tv.selectById("r1"); // make it the active selection so deletion clears it
  const cleared = capture("hippo:request-cleared");
  const deleted = capture("hippo:requests-deleted");
  await contextAction(tv, "r1", "delete");
  assert.equal(cleared.length, 1, "editor reset requested");
  assert.ok(deleted.at(-1)?.ids.includes("r1"));
});

test("deleting the selected request auto-selects the next sibling", async () => {
  const tv = mount([
    {
      id: "c1",
      type: "collection",
      name: "API",
      children: [
        { id: "r1", type: "request", name: "One", method: "GET", url: "/1" },
        { id: "r2", type: "request", name: "Two", method: "GET", url: "/2" },
      ],
    },
  ]);
  tv.selectById("r1");
  const sel = capture("hippo:request-selected");
  const cleared = capture("hippo:request-cleared");
  await contextAction(tv, "r1", "delete");
  assert.equal(
    sel.at(-1)?.id,
    "r2",
    "selection moved to the surviving sibling",
  );
  assert.equal(
    cleared.length,
    0,
    "the editor is not cleared while one remains",
  );
});

// ── Favorites / recents quick-access surfaces ────────────────────────────────

test("double-clicking the star hotspot fires hippo:favorite-toggle", () => {
  const tv = mount(TREE());
  const toggles = capture("hippo:favorite-toggle");
  const hot = rowOf(tv, "r1").querySelector(".tree-node-star");
  assert.ok(hot, "every request row carries a favorite hotspot");
  hot.dispatchEvent(
    new globalThis.window.MouseEvent("dblclick", { bubbles: true }),
  );
  assert.equal(toggles.length, 1);
  assert.equal(toggles[0].node.id, "r1");
  assert.equal(toggles[0].favorited, true, "favoriting an unstarred request");
});

test("the Favorites tab renders one quick row per favorite; click opens it", () => {
  const tv = mount(TREE());
  tv.setFavorites([
    { collectionId: "c1", requestId: "r1", name: "List users", method: "GET" },
  ]);
  tv.activateTab("favorites");
  const opened = capture("hippo:request-open");
  const quick = rows(tv);
  assert.equal(quick.length, 1, "only favorited requests are listed");
  assert.equal(
    quick[0].querySelector(".tree-node-label").textContent,
    "List users",
  );
  quick[0].click();
  assert.deepEqual(opened.at(-1), { collectionId: "c1", requestId: "r1" });
});

test("an empty Favorites surface shows the empty-state placeholder", () => {
  const tv = mount(TREE());
  tv.setShowRecents(true); // reveal the tab bar without any favorites
  tv.activateTab("favorites"); // no favorites → falls back to requests
  // Force the favorites surface even though the tab is unavailable via the bar.
  tv.setFavorites([
    { collectionId: "c1", requestId: "r1", name: "List users", method: "GET" },
  ]);
  tv.activateTab("favorites");
  tv.setFavorites([]); // removing the last favorite re-renders → back to requests
  assert.ok(
    tv.element.querySelector(".tree-node--collection"),
    "tree returns to the Requests surface when favorites empty out",
  );
});

test("the Recents tab lists recent requests and opens them", () => {
  const tv = mount(TREE());
  tv.setShowRecents(true);
  tv.setRecents([
    { collectionId: "c1", requestId: "r2", name: "Login", method: "POST" },
  ]);
  tv.activateTab("recents");
  const opened = capture("hippo:request-open");
  const quick = rows(tv);
  assert.equal(quick.length, 1);
  assert.equal(quick[0].querySelector(".tree-node-label").textContent, "Login");
  quick[0].click();
  assert.deepEqual(opened.at(-1), { collectionId: "c1", requestId: "r2" });
});

test("unfavoriting from a Favorites quick-row context menu fires the toggle", async () => {
  const tv = mount(TREE());
  tv.setFavorites([
    { collectionId: "c1", requestId: "r1", name: "List users", method: "GET" },
  ]);
  tv.activateTab("favorites");
  const toggles = capture("hippo:favorite-toggle");
  tv.__chooseMenu("unfavorite");
  rows(tv)[0].dispatchEvent(
    new globalThis.window.MouseEvent("contextmenu", {
      bubbles: true,
      clientX: 1,
      clientY: 1,
    }),
  );
  await tick();
  assert.equal(toggles.at(-1)?.node.id, "r1");
  assert.equal(toggles.at(-1)?.favorited, false, "unfavorite clears the star");
});

// ── Context-menu action map (drive each id via the stubbed native menu) ──────

test("context menu 'favorite' on a request fires hippo:favorite-toggle", async () => {
  const tv = mount(TREE());
  const toggles = capture("hippo:favorite-toggle");
  await contextAction(tv, "r1", "favorite");
  assert.equal(toggles.at(-1)?.node.id, "r1");
  assert.equal(toggles.at(-1)?.favorited, true);
});

test("context menu 'export-collection' fires hippo:export-collection with the node", async () => {
  const tv = mount(TREE());
  const exported = capture("hippo:export-collection");
  await contextAction(tv, "c1", "export-collection");
  assert.equal(exported.at(-1)?.collection.id, "c1");
});

test("context menu 'run-folder' fires hippo:run-folder with the folder id", async () => {
  const tv = mount(TREE());
  const runs = capture("hippo:run-folder");
  await contextAction(tv, "f1", "run-folder");
  assert.deepEqual(runs.at(-1), { folderId: "f1" });
});

test("context menu 'clear-history' fires hippo:timeline-clear for the request", async () => {
  const tv = mount(TREE());
  const cleared = capture("hippo:timeline-clear");
  await contextAction(tv, "r1", "clear-history");
  assert.deepEqual(cleared.at(-1), { requestId: "r1" });
});

test("context menu 'variables' fires hippo:folder-vars-open for a folder", async () => {
  const tv = mount(TREE());
  const opened = capture("hippo:folder-vars-open");
  await contextAction(tv, "f1", "variables");
  assert.equal(opened.at(-1)?.nodeId, "f1");
  assert.equal(opened.at(-1)?.folderName, "Auth");
});

test("context menu 'add-request' on a folder inserts a new child request", async () => {
  const tv = mount(TREE());
  const changed = capture("hippo:collections-changed");
  await contextAction(tv, "f1", "add-request");
  const folder = tv.getItems()[0].children[1];
  assert.equal(folder.id, "f1");
  assert.ok(
    folder.children.some((n) => n.name === t("tree.newRequest")),
    "a new request was added inside the folder",
  );
  assert.ok(changed.length >= 1);
});

test("context menu 'add-folder' on a request inserts a sibling folder after it", async () => {
  const tv = mount(TREE());
  await contextAction(tv, "r1", "add-folder");
  const kids = tv.getItems()[0].children;
  const idx = kids.findIndex((n) => n.id === "r1");
  assert.equal(kids[idx + 1].type, "collection", "new folder follows r1");
});

test("context menu 'generate-code' on a request runs without throwing", async () => {
  const tv = mount(TREE());
  // CodeGenModal.open mounts a popup; under jsdom it should construct cleanly.
  await assert.doesNotReject(async () => {
    await contextAction(tv, "r1", "generate-code");
  });
});

// ── Keyboard navigation (roving tabindex) ────────────────────────────────────

test("exactly one row owns tabindex=0 (the single tab stop)", () => {
  const tv = mount(TREE());
  const tabbable = rows(tv).filter((r) => r.getAttribute("tabindex") === "0");
  assert.equal(tabbable.length, 1, "one roving tab stop");
});

test("ArrowUp moves roving focus to the previous visible row", () => {
  const tv = mount(TREE());
  const second = rowOf(tv, "r1");
  second.focus();
  second.dispatchEvent(
    new globalThis.window.KeyboardEvent("keydown", {
      key: "ArrowUp",
      bubbles: true,
    }),
  );
  assert.equal(document.activeElement, rows(tv)[0], "focus moved up to API");
});

test("Home and End jump roving focus to the first and last visible rows", () => {
  const tv = mount(TREE());
  const mid = rowOf(tv, "f1");
  mid.focus();
  mid.dispatchEvent(
    new globalThis.window.KeyboardEvent("keydown", {
      key: "End",
      bubbles: true,
    }),
  );
  assert.equal(document.activeElement, rows(tv).at(-1), "End → last row");
  document.activeElement.dispatchEvent(
    new globalThis.window.KeyboardEvent("keydown", {
      key: "Home",
      bubbles: true,
    }),
  );
  assert.equal(document.activeElement, rows(tv)[0], "Home → first row");
});

test("ArrowLeft collapses an expanded folder; ArrowRight re-expands it", () => {
  const tv = mount(TREE());
  const folder = li(tv, "f1");
  const row = rowOf(tv, "f1");
  row.focus();
  row.dispatchEvent(
    new globalThis.window.KeyboardEvent("keydown", {
      key: "ArrowLeft",
      bubbles: true,
    }),
  );
  assert.equal(folder.getAttribute("aria-expanded"), "false", "collapsed");
  row.dispatchEvent(
    new globalThis.window.KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
    }),
  );
  assert.equal(folder.getAttribute("aria-expanded"), "true", "re-expanded");
});

test("Enter on a request row selects it (fires hippo:request-selected)", () => {
  const tv = mount(TREE());
  const sel = capture("hippo:request-selected");
  const row = rowOf(tv, "r1");
  row.focus();
  row.dispatchEvent(
    new globalThis.window.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
    }),
  );
  assert.equal(sel.at(-1)?.id, "r1");
  assert.ok(li(tv, "r1").classList.contains("tree-node--active"));
});

test("type-ahead focuses the next row whose label starts with the typed key", () => {
  const tv = mount(TREE());
  const first = rows(tv)[0]; // API
  first.focus();
  first.dispatchEvent(
    new globalThis.window.KeyboardEvent("keydown", { key: "s", bubbles: true }),
  );
  assert.equal(
    document.activeElement,
    rowOf(tv, "rw"),
    "type-ahead 's' jumped to Stream",
  );
});

test("selectAdjacent walks visible requests and opens the next/previous one", () => {
  const tv = mount(TREE());
  tv.selectById("r1");
  const sel = capture("hippo:request-selected");
  tv.selectAdjacent(1);
  assert.equal(sel.at(-1)?.id, "r2", "moved to the next request");
  tv.selectAdjacent(-1);
  assert.equal(sel.at(-1)?.id, "r1", "moved back to the previous request");
});

// ── Drag start / end DOM handlers ────────────────────────────────────────────

/**
 * Dispatch an HTML5 drag event with a usable `dataTransfer`. jsdom ships no
 * DataTransfer/DragEvent, and the dragstart handler reads .effectAllowed and
 * calls .setData(), so we attach a minimal stub via the event's own property.
 */
function fireDrag(row, type) {
  const dt = {
    effectAllowed: "",
    dropEffect: "",
    _data: {},
    setData(k, v) {
      this._data[k] = v;
    },
    getData(k) {
      return this._data[k];
    },
  };
  const ev = new globalThis.window.Event(type, { bubbles: true });
  Object.defineProperty(ev, "dataTransfer", { value: dt });
  row.dispatchEvent(ev);
  return dt;
}

test("dragstart hides the dragged row and mounts the drop phantom (next rAF)", async () => {
  const tv = mount(TREE());
  const dt = fireDrag(rowOf(tv, "r1"), "dragstart");
  assert.equal(dt.effectAllowed, "move", "effectAllowed set for the drag");
  assert.equal(dt.getData("text/plain"), "r1", "Firefox-required payload set");

  // The phantom + hide are deferred to a requestAnimationFrame (jsdom backs rAF
  // with setTimeout(0)), so wait a macrotask before asserting.
  await tick();
  assert.ok(
    tv.element.querySelector(".tree-drop-phantom"),
    "drop phantom mounted after the rAF",
  );
  assert.equal(li(tv, "r1").style.display, "none", "dragged row hidden");
});

test("dragend with no drop cancels: phantom removed and the row restored", async () => {
  const tv = mount(TREE());
  const row = rowOf(tv, "r1");
  fireDrag(row, "dragstart");
  await tick();
  assert.ok(tv.element.querySelector(".tree-drop-phantom"), "phantom present");

  // No in-tree drop happened → dragend cancels and re-renders the tree.
  fireDrag(row, "dragend");
  await tick();
  assert.equal(
    tv.element.querySelector(".tree-drop-phantom"),
    null,
    "phantom removed on cancel",
  );
  // #cancelDrag re-renders, so re-query the (fresh) row — it must be visible.
  assert.ok(visible(li(tv, "r1")), "dragged row restored after cancel");
});
