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
 * collections-popup.test.js — the CollectionsPopup left-pane list + settings.
 *
 * CollectionsPopup is a large DOM singleton with an all-private internals, so it
 * is exercised through its public seam (constructor callbacks + update()). These
 * cover the load-bearing list behaviours: one row per collection, active/selected
 * marking, the "can't delete the only collection" guard, the select/export
 * callbacks, the selected-was-deleted fallback, and the remove-headers setting —
 * without opening it through PopupManager.
 */
"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "../../tests/jsdom-setup.js";
import { CollectionsPopup } from "../collections-popup.js";

const ENVS = {
  globalVariables: [],
  activeEnvironmentId: null,
  environments: [],
};

const coll = (id, name) => ({ id, name, variables: [], headers: [] });

/** Fresh DOM + popup wired with recording callbacks. */
function makePopup() {
  resetDom();
  // Defensive: data-store cookie helpers reach for window.hippo; nothing in the
  // list/update path calls them, but stub it so an accidental touch can't throw.
  window.hippo = { cookies: {}, http: {} };
  const calls = { select: [], export: [] };
  const popup = new CollectionsPopup({
    onSelect: (p) => calls.select.push(p),
    onExportCollection: (p) => calls.export.push(p),
  });
  return { popup, el: popup.element, calls };
}

const items = (el) => [...el.querySelectorAll(".coll-list-item")];

// ── list rendering ─────────────────────────────────────────────────────────────

test("update renders one row per collection and marks the active one", () => {
  const { popup, el } = makePopup();
  popup.update({
    collections: [coll("a", "Alpha"), coll("b", "Beta")],
    activeCollectionId: "b",
    environments: ENVS,
  });

  const rows = items(el);
  assert.equal(rows.length, 2);
  assert.equal(
    rows[0].querySelector(".coll-list-item-name").textContent,
    "Alpha",
  );
  assert.ok(
    rows[1].classList.contains("coll-list-item--active"),
    "Beta is active",
  );
  assert.equal(rows[1].getAttribute("aria-selected"), "true");
  assert.ok(!rows[0].classList.contains("coll-list-item--active"));
  // The active row shows a check; the inactive one does not.
  assert.ok(
    rows[1].querySelector(".coll-list-item-check").innerHTML.length > 0,
  );
  assert.equal(rows[0].querySelector(".coll-list-item-check").innerHTML, "");
});

test("the delete action is disabled when only one collection remains", () => {
  const { popup, el } = makePopup();
  popup.update({
    collections: [coll("only", "Solo")],
    activeCollectionId: "only",
    environments: ENVS,
  });
  const del = items(el)[0].querySelector(".coll-action-btn--danger");
  assert.equal(del.disabled, true, "cannot delete the only collection");

  popup.update({
    collections: [coll("a", "A"), coll("b", "B")],
    activeCollectionId: "a",
    environments: ENVS,
  });
  const dels = items(el).map((li) =>
    li.querySelector(".coll-action-btn--danger"),
  );
  assert.ok(
    dels.every((d) => !d.disabled),
    "deletable once more than one exists",
  );
});

test("update reflects added/removed collections in the list", () => {
  const { popup, el } = makePopup();
  popup.update({
    collections: [coll("a", "A")],
    activeCollectionId: "a",
    environments: ENVS,
  });
  assert.equal(items(el).length, 1);

  popup.update({
    collections: [coll("a", "A"), coll("b", "B"), coll("c", "C")],
    activeCollectionId: "a",
    environments: ENVS,
  });
  assert.equal(items(el).length, 3);
});

// ── row interactions → creator callbacks ───────────────────────────────────────

test("clicking a collection name invokes onSelect and marks it selected", () => {
  const { popup, el, calls } = makePopup();
  popup.update({
    collections: [coll("a", "A"), coll("b", "B")],
    activeCollectionId: "a",
    environments: ENVS,
  });

  el.querySelectorAll(".coll-list-item-name")[1].click(); // select B (not active)
  assert.deepEqual(calls.select, [{ id: "b" }]);
  // Re-render marks the now-selected, non-active row.
  assert.ok(
    items(el)[1].classList.contains("coll-list-item--selected"),
    "non-active selection carries the selected modifier",
  );
});

test("clicking the export action invokes onExportCollection with the id", () => {
  const { popup, el, calls } = makePopup();
  popup.update({
    collections: [coll("a", "A")],
    activeCollectionId: "a",
    environments: ENVS,
  });
  // The first action button *within the list row* is export (rename/delete follow).
  items(el)[0].querySelector(".coll-action-btn").click();
  assert.deepEqual(calls.export, [{ id: "a" }]);
});

// ── selected-was-deleted fallback ──────────────────────────────────────────────

test("when the selected collection is deleted, selection falls back to active", () => {
  const { popup, el } = makePopup();
  popup.update({
    collections: [coll("a", "A"), coll("b", "B")],
    activeCollectionId: "a",
    environments: ENVS,
  });
  el.querySelectorAll(".coll-list-item-name")[1].click(); // select B

  // B is removed out from under the popup; active stays A.
  popup.update({
    collections: [coll("a", "A")],
    activeCollectionId: "a",
    environments: ENVS,
  });
  const rows = items(el);
  assert.equal(rows.length, 1);
  // No orphaned "selected" marker remains; the sole row is the active one.
  assert.ok(rows[0].classList.contains("coll-list-item--active"));
  assert.ok(!rows[0].classList.contains("coll-list-item--selected"));
});

// ── settings ───────────────────────────────────────────────────────────────────

test("applySettings({removeHeaders}) toggles the KV column-header visibility", () => {
  const { popup, el } = makePopup();
  popup.update({
    collections: [coll("a", "A")],
    activeCollectionId: "a",
    environments: ENVS,
  });
  const header = el.querySelector(".coll-kv-header");
  assert.ok(header, "column header exists");

  popup.applySettings({ removeHeaders: true });
  assert.equal(header.style.display, "none");
  popup.applySettings({ removeHeaders: false });
  assert.notEqual(header.style.display, "none");
});
