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
 * components/tests/profile-controller.test.js
 *
 * The orchestration app.js used to carry inline: creating a profile into either
 * tier, renaming and deleting at the definition site, per-owner activation, the
 * ⌥⌘ slots, and the one-shot migration. Driven entirely through injected fake
 * deps — no DOM, no IPC.
 *
 * Run with:   node --test components/tests/profile-controller.test.js
 */

"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ProfileController,
  PROFILE_SCOPE_COLLECTION,
} from "../profile-controller.js";
import { COLLECTION_OWNER_KEY } from "../profile-scope.js";
import { MAX_NAMED_PROFILES } from "../folder-profiles.js";

const collActive = (state) =>
  state.colls.collections[0].activeVariableProfileIds?.[COLLECTION_OWNER_KEY] ??
  null;

/**
 * A harness holding the state the controller reads and writes, plus recorders
 * for the side effects (manifest writes, tree writes, toasts, editor pushes).
 */
function makeHarness({ items, collections } = {}) {
  const state = {
    colls: {
      activeCollectionId: "c1",
      collections: collections ?? [{ id: "c1", name: "Payments" }],
    },
    items: items ?? [
      {
        id: "api",
        type: "collection",
        name: "API",
        variables: [{ name: "host", value: "dev", secure: false }],
        children: [
          {
            id: "auth",
            type: "collection",
            name: "Auth",
            variables: [],
            children: [{ id: "r1", type: "request", name: "Login" }],
          },
        ],
      },
      {
        id: "reports",
        type: "collection",
        name: "Reports",
        variables: [],
        children: [],
      },
    ],
    selectedRequestId: null,
  };
  const rec = {
    manifests: [],
    trees: [],
    warnings: [],
    infos: [],
    editorPushes: [],
  };

  const treeView = {
    getItems: () => state.items,
    setItems: (next) => {
      state.items = next;
    },
    setProfileState: () => {},
  };

  const controller = new ProfileController({
    getCollections: () => state.colls,
    setCollections: (next) => {
      state.colls = next;
    },
    saveManifest: async (payload) => rec.manifests.push(payload),
    saveTree: async (next) => rec.trees.push(next),
    getTreeView: () => treeView,
    getVarsEditor: () => ({ load: () => {} }),
    getRequestEditor: () => ({ setProfiles: (p) => rec.editorPushes.push(p) }),
    getSettings: () => ({}),
    getSelectedRequestId: () => state.selectedRequestId,
    refreshContext: () => {},
    t: (key, params) => `${key}:${JSON.stringify(params ?? {})}`,
    notify: {
      warning: (m) => rec.warnings.push(m),
      info: (m) => rec.infos.push(m),
    },
  });
  return { controller, state, rec };
}

const entry = (state) => state.colls.collections[0];
const node = (state, id) => {
  const walk = (ns) => {
    for (const n of ns ?? []) {
      if (n.id === id) return n;
      const hit = walk(n.children);
      if (hit) return hit;
    }
    return null;
  };
  return walk(state.items);
};

// ── Creating ────────────────────────────────────────────────────────────────

test("add: folder scope writes the profile onto the folder's node, not the manifest", async () => {
  const { controller, state } = makeHarness();
  controller.setVarsScope({ nodeId: "auth", name: "Auth" });
  await controller.add({ name: "user1" });

  assert.deepEqual(
    node(state, "auth").profiles.map((p) => p.name),
    ["user1"],
  );
  assert.deepEqual(entry(state).variableProfiles ?? [], []);
});

test("add: collection scope writes to the manifest, leaving the tree alone", async () => {
  const { controller, state, rec } = makeHarness();
  controller.setVarsScope({ nodeId: "auth", name: "Auth" });
  await controller.add({ name: "Prod", scope: PROFILE_SCOPE_COLLECTION });

  assert.deepEqual(
    entry(state).variableProfiles.map((p) => p.name),
    ["Prod"],
  );
  assert.equal(node(state, "auth").profiles, undefined);
  assert.equal(
    rec.trees.length,
    0,
    "no tree write for a collection-tier profile",
  );
  assert.equal(
    collActive(state),
    entry(state).variableProfiles[0].id,
    "it activates under the collection sentinel key, not the folder's",
  );
});

test("add: the new profile becomes active for ITS owner", async () => {
  const { controller, state } = makeHarness();
  controller.setVarsScope({ nodeId: "auth", name: "Auth" });
  await controller.add({ name: "user1" });
  const id = node(state, "auth").profiles[0].id;
  assert.deepEqual(controller.activeByOwner(), { auth: id });
});

test("add: a duplicate name anywhere IN SCOPE is rejected", async () => {
  const { controller, rec } = makeHarness();
  controller.setVarsScope({ nodeId: "api", name: "API" });
  await controller.add({ name: "eu" });
  controller.setVarsScope({ nodeId: "auth", name: "Auth" });
  await controller.add({ name: "EU" }); // the ancestor's, case-insensitively

  assert.equal(rec.warnings.length, 1);
  assert.match(rec.warnings[0], /profiles\.duplicate/);
});

test("add: the same name in an unrelated branch is allowed", async () => {
  const { controller, state } = makeHarness();
  controller.setVarsScope({ nodeId: "api", name: "API" });
  await controller.add({ name: "Prod" });
  controller.setVarsScope({ nodeId: "reports", name: "Reports" });
  await controller.add({ name: "Prod" });

  assert.equal(node(state, "api").profiles.length, 1);
  assert.equal(node(state, "reports").profiles.length, 1);
  assert.notEqual(
    node(state, "api").profiles[0].id,
    node(state, "reports").profiles[0].id,
    "two independent profiles that merely share a name",
  );
});

test("add: the cap is PER OWNER — a full folder does not block its parent", async () => {
  const { controller, state, rec } = makeHarness();
  controller.setVarsScope({ nodeId: "auth", name: "Auth" });
  for (let i = 0; i < MAX_NAMED_PROFILES; i++)
    await controller.add({ name: `p${i}` });
  assert.equal(node(state, "auth").profiles.length, MAX_NAMED_PROFILES);

  await controller.add({ name: "one-too-many" });
  assert.match(rec.warnings.at(-1), /profiles\.limitOwner/);
  assert.equal(node(state, "auth").profiles.length, MAX_NAMED_PROFILES);

  controller.setVarsScope({ nodeId: "api", name: "API" });
  await controller.add({ name: "parent-still-fine" });
  assert.equal(node(state, "api").profiles.length, 1);
});

// ── Renaming ────────────────────────────────────────────────────────────────

test("rename: updates the owner's definition in place, keeping the id", async () => {
  const { controller, state } = makeHarness();
  controller.setVarsScope({ nodeId: "auth", name: "Auth" });
  await controller.add({ name: "user1" });
  const id = node(state, "auth").profiles[0].id;

  await controller.rename({ profileId: id, name: "user-one" });
  assert.deepEqual(node(state, "auth").profiles, [{ id, name: "user-one" }]);
});

test("rename: a collection-tier profile is renamed on the manifest", async () => {
  const { controller, state } = makeHarness();
  controller.setVarsScope({ nodeId: "auth", name: "Auth" });
  await controller.add({ name: "Prod", scope: PROFILE_SCOPE_COLLECTION });
  const id = entry(state).variableProfiles[0].id;

  await controller.rename({ profileId: id, name: "Production" });
  assert.deepEqual(entry(state).variableProfiles, [{ id, name: "Production" }]);
});

// ── Activation ──────────────────────────────────────────────────────────────

test("select: each owner keeps its own selection — they coexist", async () => {
  const { controller, state } = makeHarness();
  controller.setVarsScope({ nodeId: "api", name: "API" });
  await controller.add({ name: "eu" });
  controller.setVarsScope({ nodeId: "auth", name: "Auth" });
  await controller.add({ name: "user1" });

  const eu = node(state, "api").profiles[0].id;
  const u1 = node(state, "auth").profiles[0].id;
  assert.deepEqual(controller.activeByOwner(), { api: eu, auth: u1 });
});

test("select: a null profileId returns just that owner to its Default", async () => {
  const { controller, state } = makeHarness();
  controller.setVarsScope({ nodeId: "api", name: "API" });
  await controller.add({ name: "eu" });
  controller.setVarsScope({ nodeId: "auth", name: "Auth" });
  await controller.add({ name: "user1" });
  const u1 = node(state, "auth").profiles[0].id;

  await controller.select({ ownerKey: "api", profileId: null });
  assert.deepEqual(controller.activeByOwner(), { auth: u1 });
});

test("select: a null ownerKey clears every owner IN SCOPE, sparing the rest", async () => {
  const { controller, state } = makeHarness();
  controller.setVarsScope({ nodeId: "reports", name: "Reports" });
  await controller.add({ name: "weekly" });
  const weekly = node(state, "reports").profiles[0].id;

  controller.setVarsScope({ nodeId: "auth", name: "Auth" });
  await controller.add({ name: "user1" });

  // The vars scope is Auth, so Reports' selection is out of scope and survives.
  await controller.select({ ownerKey: null });
  assert.deepEqual(
    controller.activeByOwner(),
    { reports: weekly },
    "stepping into another branch must not lose a selection there",
  );
});

test("editingProfileId: the INNERMOST active profile in scope", async () => {
  const { controller, state } = makeHarness();
  controller.setVarsScope({ nodeId: "api", name: "API" });
  await controller.add({ name: "eu" });
  controller.setVarsScope({ nodeId: "auth", name: "Auth" });
  await controller.add({ name: "user1" });
  const u1 = node(state, "auth").profiles[0].id;
  const eu = node(state, "api").profiles[0].id;

  assert.equal(controller.editingProfileId("auth"), u1);
  assert.equal(
    controller.editingProfileId("api"),
    eu,
    "Auth's is out of scope here",
  );
  assert.equal(controller.editingProfileId("reports"), null);
});

// ── Keyboard slots ──────────────────────────────────────────────────────────

test("selectSlot: N addresses the Nth visible profile, outermost first", async () => {
  const { controller, state } = makeHarness();
  controller.setVarsScope({ nodeId: "api", name: "API" });
  await controller.add({ name: "eu" });
  await controller.add({ name: "us" });
  controller.setVarsScope({ nodeId: "auth", name: "Auth" });
  await controller.add({ name: "user1" });

  const us = node(state, "api").profiles[1].id;
  await controller.selectSlot(2); // eu, us, user1 → slot 2 is "us"
  assert.equal(controller.activeByOwner().api, us);
});

test("selectSlot: 0 clears every in-scope owner and announces it", async () => {
  const { controller, rec } = makeHarness();
  controller.setVarsScope({ nodeId: "auth", name: "Auth" });
  await controller.add({ name: "user1" });

  await controller.selectSlot(0);
  assert.deepEqual(controller.activeByOwner(), {});
  assert.match(rec.infos.at(-1), /profiles\.switchedAllDefault/);
});

test("selectSlot: an empty slot, and an already-active one, are silent no-ops", async () => {
  const { controller, rec } = makeHarness();
  controller.setVarsScope({ nodeId: "auth", name: "Auth" });
  await controller.add({ name: "user1" });
  const before = { ...controller.activeByOwner() };
  rec.infos.length = 0;

  await controller.selectSlot(7); // nothing in that slot
  await controller.selectSlot(1); // already active
  assert.deepEqual(controller.activeByOwner(), before);
  assert.deepEqual(rec.infos, []);
});

// ── Deleting ────────────────────────────────────────────────────────────────

test("remove: drops the definition, every folder's overrides, and the selection", async () => {
  const { controller, state } = makeHarness();
  controller.setVarsScope({ nodeId: "api", name: "API" });
  await controller.add({ name: "eu" });
  const eu = node(state, "api").profiles[0].id;

  // Values for it exist at the owner and at a descendant.
  node(state, "api").profileValues = { [eu]: { host: "eu" } };
  node(state, "auth").profileValues = { [eu]: { user: "eu-user" } };

  await controller.remove({ profileId: eu });
  assert.deepEqual(node(state, "api").profiles, []);
  assert.deepEqual(node(state, "api").profileValues, {});
  assert.deepEqual(node(state, "auth").profileValues, {});
  assert.deepEqual(controller.activeByOwner(), {});
});

test("remove: a collection-tier profile leaves the manifest list", async () => {
  const { controller, state } = makeHarness();
  controller.setVarsScope({ nodeId: "auth", name: "Auth" });
  await controller.add({ name: "Prod", scope: PROFILE_SCOPE_COLLECTION });
  const id = entry(state).variableProfiles[0].id;

  await controller.remove({ profileId: id });
  assert.deepEqual(entry(state).variableProfiles, []);
});

// ── Stale selections ────────────────────────────────────────────────────────

test("pruneStale: forgets a deleted folder's selection, and only writes when needed", async () => {
  const { controller, state, rec } = makeHarness();
  controller.setVarsScope({ nodeId: "auth", name: "Auth" });
  await controller.add({ name: "user1" });
  rec.manifests.length = 0;

  assert.equal(await controller.pruneStale(), false, "nothing stale yet");
  assert.equal(rec.manifests.length, 0, "no pointless manifest write");

  // The folder that owned it is deleted out from under the selection.
  state.items = state.items.filter((n) => n.id !== "api");
  assert.equal(await controller.pruneStale(), true);
  assert.deepEqual(controller.activeByOwner(), {});
});

// ── Migration ───────────────────────────────────────────────────────────────

test("migrateIfNeeded: moves a collection-wide profile onto its folder and stamps the entry", async () => {
  const { controller, state } = makeHarness({
    collections: [
      {
        id: "c1",
        name: "Payments",
        variableProfiles: [{ id: "p", name: "Prod" }],
        activeVariableProfileId: "p",
      },
    ],
  });
  node(state, "auth").profileValues = { p: { host: "prod" } };

  await controller.migrateIfNeeded(state.items);

  assert.deepEqual(entry(state).variableProfiles, []);
  assert.deepEqual(
    node(state, "auth").profiles,
    [{ id: "p", name: "Prod" }],
    "the live tree was updated in place",
  );
  assert.deepEqual(entry(state).activeVariableProfileIds, { auth: "p" });
  assert.equal(entry(state).profileScopeVersion, 2);
});

test("migrateIfNeeded: writes the TREE before the manifest", async () => {
  const { controller, state, rec } = makeHarness({
    collections: [
      {
        id: "c1",
        name: "Payments",
        variableProfiles: [{ id: "p", name: "Prod" }],
      },
    ],
  });
  node(state, "auth").profileValues = { p: { host: "prod" } };
  const order = [];
  const origTree = rec.trees.push.bind(rec.trees);
  rec.trees.push = (...a) => {
    order.push("tree");
    return origTree(...a);
  };
  const origMan = rec.manifests.push.bind(rec.manifests);
  rec.manifests.push = (...a) => {
    order.push("manifest");
    return origMan(...a);
  };

  await controller.migrateIfNeeded(state.items);
  assert.deepEqual(
    order,
    ["tree", "manifest"],
    "a crash between the two must leave the profile in BOTH tiers, never neither",
  );
});

test("migrateIfNeeded: a stamped collection is a no-op", async () => {
  const { controller, state, rec } = makeHarness({
    collections: [
      {
        id: "c1",
        name: "Payments",
        variableProfiles: [{ id: "p", name: "Prod" }],
        profileScopeVersion: 2,
      },
    ],
  });
  node(state, "auth").profileValues = { p: { host: "prod" } };

  await controller.migrateIfNeeded(state.items);
  assert.deepEqual(entry(state).variableProfiles, [{ id: "p", name: "Prod" }]);
  assert.equal(rec.trees.length, 0);
  assert.equal(rec.manifests.length, 0);
});

// ── Pushing to the switcher ─────────────────────────────────────────────────

test("pushToEditor: sends the groups visible at the SELECTED REQUEST", async () => {
  const { controller, state, rec } = makeHarness();
  controller.setVarsScope({ nodeId: "auth", name: "Auth" });
  await controller.add({ name: "user1" });

  state.selectedRequestId = "r1"; // under Auth
  controller.pushToEditor();
  assert.deepEqual(
    rec.editorPushes.at(-1).groups.map((g) => g.ownerKey),
    ["auth"],
  );

  // A request outside that subtree sees nothing, so the switcher hides.
  state.items.push({
    id: "elsewhere",
    type: "collection",
    name: "Elsewhere",
    variables: [],
    children: [{ id: "r9", type: "request", name: "Other" }],
  });
  state.selectedRequestId = "r9";
  controller.pushToEditor();
  assert.deepEqual(rec.editorPushes.at(-1).groups, []);
});
