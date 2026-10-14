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
 * components/tests/vars-profile-bar.test.js
 *
 * The profile switcher on the folder variable editor's toolbar: the grouped
 * selector, owner-gated rename/delete, and the [+] popup's name + scope choice.
 *
 * Run with:   node --test components/tests/vars-profile-bar.test.js
 */

"use strict";

// MUST come first — installs the jsdom globals the component needs.
import { resetDom } from "../../tests/jsdom-setup.js";

import { test } from "node:test";
import assert from "node:assert/strict";

import { VarsProfileBar } from "../vars-profile-bar.js";
import { COLLECTION_OWNER_KEY } from "../profile-scope.js";
import { MAX_NAMED_PROFILES } from "../folder-profiles.js";
import { t } from "../../i18n.js";

const COLL = {
  ownerKey: COLLECTION_OWNER_KEY,
  ownerId: null,
  ownerName: "Payments",
  tier: "collection",
  profiles: [{ id: "prod", name: "Prod" }],
};
const API = {
  ownerKey: "api",
  ownerId: "api",
  ownerName: "API",
  tier: "folder",
  profiles: [{ id: "eu", name: "eu" }],
};
const AUTH = {
  ownerKey: "auth",
  ownerId: "auth",
  ownerName: "Auth",
  tier: "folder",
  profiles: [{ id: "u1", name: "user1" }],
};

/** Mount a bar for the folder `ownerKey`, seeing `groups`. */
function mount({
  groups = [COLL, API, AUTH],
  editingProfileId = null,
  ownerKey = "auth",
} = {}) {
  const window = resetDom();
  const rec = { adds: [], renames: [], deletes: [], selects: [], flushes: 0 };
  const bar = new VarsProfileBar({
    onAdd: (p) => rec.adds.push(p),
    onRename: (p) => rec.renames.push(p),
    onDelete: (p) => rec.deletes.push(p),
    onSelect: (p) => rec.selects.push(p),
    onBeforeSelect: () => rec.flushes++,
  });
  document.body.appendChild(bar.element);
  bar.load({ enabled: true, groups, editingProfileId, ownerKey });
  const q = (sel) => bar.element.querySelector(sel);
  return { window, bar, rec, q };
}

const select = (q) => q(".vars-profile-select");

// ── The grouped selector ────────────────────────────────────────────────────

test("the selector groups profiles under their owner, outermost first", () => {
  const { q } = mount();
  const groups = [...select(q).querySelectorAll("optgroup")];
  assert.deepEqual(
    groups.map((g) => g.label),
    ["Payments", "API", "Auth"],
  );
  assert.deepEqual(
    groups.map((g) =>
      [...g.querySelectorAll("option")].map((o) => o.textContent),
    ),
    [["Prod"], ["eu"], ["user1"]],
  );
});

test("Default is the ungrouped first option and the empty value", () => {
  const { q } = mount();
  const first = select(q).options[0];
  assert.equal(first.value, "");
  assert.equal(first.textContent, t("profiles.default"));
  assert.equal(first.closest("optgroup"), null);
});

test("the selected entry is the profile being edited", () => {
  const { q } = mount({ editingProfileId: "eu" });
  assert.equal(select(q).value, "eu");
});

test("a folder that sees no profiles shows only the [+]", () => {
  const { q } = mount({ groups: [] });
  assert.equal(select(q).style.display, "none");
  assert.equal(q(".vars-profile-del-btn").style.display, "none");
  assert.equal(q(".vars-profile-rename-btn").style.display, "none");
  assert.notEqual(q(".vars-profile-add-btn").style.display, "none");
});

test("moving to a folder with nothing in scope CLEARS the previous folder's options", () => {
  // Hiding alone would leave another branch's profiles (and their enabled
  // rename/delete) sitting in the DOM.
  const { q, bar } = mount({ editingProfileId: "u1", ownerKey: "auth" });
  assert.equal(select(q).querySelectorAll("optgroup").length, 3);

  bar.load({ enabled: true, groups: [], ownerKey: "elsewhere" });
  assert.deepEqual(
    [...select(q).options].map((o) => o.textContent),
    [t("profiles.default")],
  );
  assert.equal(select(q).value, "");
  assert.equal(q(".vars-profile-rename-btn").disabled, true);
  assert.equal(q(".vars-profile-del-btn").disabled, true);
  assert.equal(q(".vars-profile-del-btn").title, t("profiles.delete"));
});

test("the whole bar hides when profiles are disabled (collection scope)", () => {
  const { bar } = mount();
  bar.load({ enabled: false });
  assert.equal(bar.element.style.display, "none");
});

// ── Owner gating ────────────────────────────────────────────────────────────

test("rename + delete are enabled for a profile THIS folder owns", () => {
  const { q } = mount({ editingProfileId: "u1", ownerKey: "auth" });
  assert.equal(q(".vars-profile-rename-btn").disabled, false);
  assert.equal(q(".vars-profile-del-btn").disabled, false);
});

test("rename + delete are disabled for an ANCESTOR's profile, and say where it lives", () => {
  const { q } = mount({ editingProfileId: "eu", ownerKey: "auth" });
  assert.equal(q(".vars-profile-rename-btn").disabled, true);
  assert.equal(q(".vars-profile-del-btn").disabled, true);
  assert.match(q(".vars-profile-del-btn").title, /API/);
  assert.match(q(".vars-profile-del-btn").title, /eu/);
});

test("a collection-tier profile stays manageable from any folder", () => {
  // It has no folder to navigate to, so refusing it everywhere would strand it.
  const { q } = mount({ editingProfileId: "prod", ownerKey: "auth" });
  assert.equal(q(".vars-profile-rename-btn").disabled, false);
  assert.equal(q(".vars-profile-del-btn").disabled, false);
});

test("rename + delete are disabled on Default", () => {
  const { q } = mount({ editingProfileId: null });
  assert.equal(q(".vars-profile-rename-btn").disabled, true);
  assert.equal(q(".vars-profile-del-btn").disabled, true);
});

test("delete on an ancestor's profile does not fire the callback", () => {
  const { q, rec } = mount({ editingProfileId: "eu", ownerKey: "auth" });
  q(".vars-profile-del-btn").click();
  assert.deepEqual(rec.deletes, []);
});

test("delete on an owned profile fires with its id", () => {
  const { q, rec } = mount({ editingProfileId: "u1", ownerKey: "auth" });
  q(".vars-profile-del-btn").click();
  assert.deepEqual(rec.deletes, [{ profileId: "u1" }]);
});

// ── Selecting ───────────────────────────────────────────────────────────────

test("selecting a profile reports it with ITS owner, after flushing the edit", () => {
  const { q, rec, window } = mount({ editingProfileId: null });
  const sel = select(q);
  sel.value = "eu";
  sel.dispatchEvent(new window.Event("change", { bubbles: true }));
  assert.deepEqual(rec.selects, [{ ownerKey: "api", profileId: "eu" }]);
  assert.equal(rec.flushes, 1, "the in-flight edit is saved before switching");
});

test("selecting Default clears the owner of whatever was being edited", () => {
  const { q, rec, window } = mount({
    editingProfileId: "u1",
    ownerKey: "auth",
  });
  const sel = select(q);
  sel.value = "";
  sel.dispatchEvent(new window.Event("change", { bubbles: true }));
  assert.deepEqual(rec.selects, [{ ownerKey: "auth", profileId: null }]);
});

// ── The [+] popup ───────────────────────────────────────────────────────────

const popup = () => document.querySelector(".vars-profile-popup");

test("[+] opens a popup offering a name and a scope, defaulting to this folder", () => {
  const { q } = mount();
  q(".vars-profile-add-btn").click();
  const radios = [
    ...popup().querySelectorAll("input[name=vars-profile-scope]"),
  ];
  assert.deepEqual(
    radios.map((r) => r.value),
    ["folder", "collection"],
  );
  assert.equal(radios[0].checked, true, "scoping to this folder leads");
});

test("committing the [+] popup reports the name and the chosen scope", () => {
  const { q, rec, window } = mount();
  q(".vars-profile-add-btn").click();
  const pop = popup();
  pop.querySelector("input[type=text]").value = "  sandbox  ";
  pop.querySelector('input[value="collection"]').checked = true;
  pop.querySelector('input[value="folder"]').checked = false;
  pop
    .querySelector("input[type=text]")
    .dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  assert.deepEqual(rec.adds, [{ name: "sandbox", scope: "collection" }]);
});

test("Escape cancels the [+] popup without adding", () => {
  const { q, rec, window } = mount();
  q(".vars-profile-add-btn").click();
  const input = popup().querySelector("input[type=text]");
  input.value = "nope";
  input.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  assert.equal(popup(), null);
  assert.deepEqual(rec.adds, []);
});

test("a blank name is not committed", () => {
  const { q, rec, window } = mount();
  q(".vars-profile-add-btn").click();
  const input = popup().querySelector("input[type=text]");
  input.value = "   ";
  input.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
  );
  assert.deepEqual(rec.adds, []);
});

test("the rename popup pre-fills the name and carries no scope choice", () => {
  const { q, rec, window } = mount({
    editingProfileId: "u1",
    ownerKey: "auth",
  });
  q(".vars-profile-rename-btn").click();
  const input = popup().querySelector("input[type=text]");
  assert.equal(input.value, "user1");
  assert.equal(
    popup().querySelector("input[type=radio]"),
    null,
    "scope is fixed on rename",
  );
  input.value = "user-one";
  input.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
  );
  assert.deepEqual(rec.renames, [{ profileId: "u1", name: "user-one" }]);
});

// ── The per-owner cap ───────────────────────────────────────────────────────

const full = (ownerKey, tier, ownerName) => ({
  ownerKey,
  ownerId: tier === "folder" ? ownerKey : null,
  ownerName,
  tier,
  profiles: Array.from({ length: MAX_NAMED_PROFILES }, (_, i) => ({
    id: `${ownerKey}${i}`,
    name: `${ownerKey}${i}`,
  })),
});

test("a full folder disables only ITS scope in the popup, not the collection's", () => {
  const { q } = mount({
    groups: [COLL, full("auth", "folder", "Auth")],
    ownerKey: "auth",
  });
  assert.equal(q(".vars-profile-add-btn").disabled, false);
  q(".vars-profile-add-btn").click();
  const radios = [
    ...popup().querySelectorAll("input[name=vars-profile-scope]"),
  ];
  assert.equal(radios[0].disabled, true, "this folder is full");
  assert.equal(radios[1].disabled, false, "the collection still has room");
  assert.equal(
    radios[1].checked,
    true,
    "so the popup pre-selects the usable scope",
  );
});

test("[+] only gives up when BOTH scopes are full", () => {
  const { q } = mount({
    groups: [
      full(COLLECTION_OWNER_KEY, "collection", "Payments"),
      full("auth", "folder", "Auth"),
    ],
    ownerKey: "auth",
  });
  assert.equal(q(".vars-profile-add-btn").disabled, true);
  assert.match(q(".vars-profile-add-btn").title, /9/);
});

test("load() closes an open popup so it never outlives its folder", () => {
  const { q, bar } = mount();
  q(".vars-profile-add-btn").click();
  assert.ok(popup());
  bar.load({ enabled: true, groups: [AUTH], ownerKey: "auth" });
  assert.equal(popup(), null);
});
