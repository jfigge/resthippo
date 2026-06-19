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
