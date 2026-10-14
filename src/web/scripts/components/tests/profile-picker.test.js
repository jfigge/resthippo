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
 * tests/profile-picker.test.js
 *
 * Unit tests for ProfilePicker — the variable-profile selector that opens a
 * native OS menu (window.hippo.ui.contextMenu.show). Profiles are SCOPED, so the
 * menu is grouped by the owner that defines them: an "All Default" entry, then a
 * separator + disabled heading + radio run per owner. Pins the item list, the
 * per-group independence of the radio dots, the flat ⌥⌘1–9 slot numbering, and
 * that only a real change routes to onActivate.
 *
 * Run with:   node --test components/tests/profile-picker.test.js
 */

"use strict";

// MUST come first — installs the jsdom globals the picker needs.
import { resetDom } from "../../tests/jsdom-setup.js";

import { test } from "node:test";
import assert from "node:assert/strict";

import { ProfilePicker } from "../profile-picker.js";
import { COLLECTION_OWNER_KEY } from "../profile-scope.js";

const P1 = { id: "p1", name: "Staging" };
const P2 = { id: "p2", name: "Prod" };

/** One collection-tier group holding both profiles — the pre-scoping shape. */
const COLL_GROUP = (profiles = [P1, P2]) => [
  {
    ownerKey: COLLECTION_OWNER_KEY,
    ownerId: null,
    ownerName: "Payments",
    tier: "collection",
    profiles,
  },
];

/** Two groups: the collection tier, then a folder that owns its own profile. */
const TWO_GROUPS = [
  ...COLL_GROUP(),
  {
    ownerKey: "auth",
    ownerId: "auth",
    ownerName: "Auth",
    tier: "folder",
    profiles: [{ id: "u1", name: "user1" }],
  },
];

/** Flush the picker's fire-and-forget async menu handler. */
const flush = () => new Promise((r) => setTimeout(r, 0));

/** Rows that carry an id and are selectable (headings and separators dropped). */
const pickable = (items) =>
  items.filter((it) => it.type === "radio" || it.type === "checkbox");

/**
 * Bind a picker to a fresh button, mock the native menu to capture the item list
 * and return `choose(items)` as the clicked id, then click the trigger.
 * @returns {Promise<{ items: any[], activated: object[] }>}
 */
async function openAndPick({ groups, activeByOwner = {}, choose }) {
  const window = resetDom();
  let items = null;
  const activated = [];
  window.hippo = {
    ui: {
      contextMenu: {
        show: async (opts) => {
          items = opts.items;
          return choose ? choose(items) : null;
        },
      },
    },
  };
  const picker = new ProfilePicker({
    onActivate: (sel) => activated.push(sel),
  });
  const btn = document.createElement("button");
  document.body.appendChild(btn);
  picker.bindTrigger(btn);
  picker.load({ groups, activeByOwner });
  btn.dispatchEvent(
    new window.MouseEvent("mousedown", { button: 0, bubbles: true }),
  );
  await flush();
  return { items, activated };
}

test("menu opens with All Default, then a separator + heading + radio run per owner", async () => {
  const { items } = await openAndPick({ groups: TWO_GROUPS });
  assert.deepEqual(
    items.map((it) => it.type ?? "item"),
    [
      "checkbox", // All Default
      "separator",
      "item", // "Payments" heading
      "radio", // its Default
      "radio", // Staging
      "radio", // Prod
      "separator",
      "item", // "Auth" heading
      "radio", // its Default
      "radio", // user1
    ],
  );
  // Headings are labelled by their owner and are never clickable.
  const headings = items.filter((it) => it.enabled === false);
  assert.deepEqual(
    headings.map((h) => h.label),
    ["Payments", "Auth"],
  );
});

test("each owner keeps its own radio dot — several profiles are active at once", async () => {
  const { items } = await openAndPick({
    groups: TWO_GROUPS,
    activeByOwner: { [COLLECTION_OWNER_KEY]: "p2", auth: "u1" },
  });
  const checked = items.filter((it) => it.checked).map((it) => it.label);
  assert.deepEqual(checked, ["Prod", "user1"]);
  assert.equal(
    items[0].checked,
    false,
    "All Default is unchecked while anything is active",
  );
});

test("an owner with no selection shows ITS Default checked, independently", async () => {
  const { items } = await openAndPick({
    groups: TWO_GROUPS,
    activeByOwner: { auth: "u1" },
  });
  // The collection tier falls back to its own Default; Auth keeps user1.
  const checked = items.filter((it) => it.checked).map((it) => it.label);
  assert.deepEqual(checked, ["Default", "user1"]);
  assert.equal(
    items[3].checked,
    true,
    "that Default is the collection group's",
  );
});

test("All Default is checked when nothing is active", async () => {
  const { items } = await openAndPick({ groups: TWO_GROUPS });
  assert.equal(items[0].checked, true);
  assert.equal(items[0].accelerator, "Alt+CmdOrCtrl+0");
});

test("⌥⌘1–9 number the FLAT outermost→innermost profile order, skipping Defaults", async () => {
  const { items } = await openAndPick({ groups: TWO_GROUPS });
  const withAccel = items
    .filter((it) => it.accelerator)
    .map((it) => [it.label, it.accelerator]);
  assert.deepEqual(withAccel, [
    ["All Default", "Alt+CmdOrCtrl+0"],
    ["Staging", "Alt+CmdOrCtrl+1"],
    ["Prod", "Alt+CmdOrCtrl+2"],
    ["user1", "Alt+CmdOrCtrl+3"],
  ]);
});

test("only the first nine visible profiles get a shortcut", async () => {
  const many = Array.from({ length: 12 }, (_, i) => ({
    id: `p${i}`,
    name: `P${i}`,
  }));
  const { items } = await openAndPick({ groups: COLL_GROUP(many) });
  const accel = items.filter((it) => it.accelerator);
  assert.equal(accel.length, 10, "All Default + nine profiles");
});

test("choosing a profile routes its owner and id to onActivate", async () => {
  const { activated } = await openAndPick({
    groups: TWO_GROUPS,
    choose: (items) => items.find((it) => it.label === "user1").id,
  });
  assert.deepEqual(activated, [{ ownerKey: "auth", profileId: "u1" }]);
});

test("choosing a group's Default returns just that owner to Default", async () => {
  const { activated } = await openAndPick({
    groups: TWO_GROUPS,
    activeByOwner: { [COLLECTION_OWNER_KEY]: "p1", auth: "u1" },
    // The second "Default" radio belongs to the Auth group.
    choose: (items) => items.filter((it) => it.label === "Default")[1].id,
  });
  assert.deepEqual(activated, [{ ownerKey: "auth", profileId: null }]);
});

test("All Default routes a null ownerKey, clearing every owner in scope", async () => {
  const { activated } = await openAndPick({
    groups: TWO_GROUPS,
    activeByOwner: { [COLLECTION_OWNER_KEY]: "p1", auth: "u1" },
    choose: (items) => items[0].id,
  });
  assert.deepEqual(activated, [{ ownerKey: null, profileId: null }]);
});

test("re-selecting the already-active profile is a no-op", async () => {
  const { activated } = await openAndPick({
    groups: TWO_GROUPS,
    activeByOwner: { [COLLECTION_OWNER_KEY]: "p2" },
    choose: (items) => items.find((it) => it.label === "Prod").id,
  });
  assert.deepEqual(activated, []);
});

test("clicking a group heading does nothing", async () => {
  const { activated } = await openAndPick({
    groups: TWO_GROUPS,
    choose: (items) => items.find((it) => it.enabled === false).id,
  });
  assert.deepEqual(activated, []);
});

test("dismissing the menu does not activate anything", async () => {
  const { activated } = await openAndPick({
    groups: TWO_GROUPS,
    activeByOwner: { [COLLECTION_OWNER_KEY]: "p1" },
    choose: () => null, // dismissed
  });
  assert.deepEqual(activated, []);
});

test("no groups in scope → the menu never opens", async () => {
  const { items, activated } = await openAndPick({ groups: [] });
  assert.equal(items, null, "a folder that sees no profiles gets no menu");
  assert.deepEqual(activated, []);
});

test("no native menu host (non-Electron) is a safe no-op", async () => {
  const window = resetDom();
  window.hippo = { isElectron: false }; // no ui.contextMenu
  const activated = [];
  const picker = new ProfilePicker({
    onActivate: (sel) => activated.push(sel),
  });
  const btn = document.createElement("button");
  document.body.appendChild(btn);
  picker.bindTrigger(btn);
  picker.load({ groups: TWO_GROUPS, activeByOwner: {} });
  btn.dispatchEvent(
    new window.MouseEvent("mousedown", { button: 0, bubbles: true }),
  );
  await flush();
  assert.deepEqual(activated, []);
});

test("pickable rows all carry an id the picker can decode", async () => {
  const { items } = await openAndPick({ groups: TWO_GROUPS });
  for (const it of pickable(items))
    assert.ok(it.id, `missing id on ${it.label}`);
});
