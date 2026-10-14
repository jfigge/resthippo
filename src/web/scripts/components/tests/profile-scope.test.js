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
 * components/tests/profile-scope.test.js
 *
 * Profile VISIBILITY and layering. A profile owned by a folder is visible to that
 * folder and its descendants only; a sibling of the owner sees none of it. One
 * profile is active per owner, and at send time those selections layer
 * outermost → innermost.
 *
 * Run with:   node --test components/tests/profile-scope.test.js
 */

"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  COLLECTION_OWNER_KEY,
  containerChain,
  profileGroupsForNode,
  flattenGroups,
  activeIdsForGroups,
  ownerOfProfile,
  allProfileGroups,
  pruneActiveSelections,
  resolvedFolderChain,
  collectOwnedProfileIds,
  hoistScopedProfiles,
} from "../profile-scope.js";

/**
 * The shape from the user's own example, plus the collection tier:
 *
 *   collection ................ staging, prod
 *   API/ ...................... eu, us            (top-level folder)
 *     Auth/ ................... user1, user2, admin
 *       r1 (request)
 *   Reports/ .................. (none)            (sibling of API)
 *     r2 (request)
 *
 * So: Auth's descendants see 5 folder-tier profiles, API sees 2, Reports sees 0.
 */
const COLL_PROFILES = [
  { id: "staging", name: "Staging" },
  { id: "prod", name: "Prod" },
];

const TREE = () => [
  {
    id: "api",
    type: "collection",
    name: "API",
    variables: [
      { name: "host", value: "dev.example.com", secure: false },
      { name: "region", value: "dev", secure: false },
    ],
    profiles: [
      { id: "eu", name: "eu" },
      { id: "us", name: "us" },
    ],
    profileValues: { eu: { region: "eu-west-1" }, staging: { host: "stg" } },
    children: [
      {
        id: "auth",
        type: "collection",
        name: "Auth",
        variables: [{ name: "user", value: "dev-user", secure: false }],
        profiles: [
          { id: "user1", name: "user1" },
          { id: "user2", name: "user2" },
          { id: "admin", name: "admin" },
        ],
        profileValues: { user2: { user: "second" }, eu: { user: "eu-user" } },
        children: [{ id: "r1", type: "request", name: "Get token" }],
      },
    ],
  },
  {
    id: "reports",
    type: "collection",
    name: "Reports",
    variables: [],
    children: [{ id: "r2", type: "request", name: "Daily" }],
  },
];

const groupsAt = (nodeId, items = TREE()) =>
  profileGroupsForNode({
    items,
    nodeId,
    collectionProfiles: COLL_PROFILES,
    collectionLabel: "Payments",
  });

// ── containerChain ──────────────────────────────────────────────────────────

test("containerChain: a request sees its ancestors, outermost first, not itself", () => {
  assert.deepEqual(
    containerChain(TREE(), "r1").map((n) => n.id),
    ["api", "auth"],
  );
});

test("containerChain: a folder INCLUDES itself (it can see its own profiles)", () => {
  assert.deepEqual(
    containerChain(TREE(), "auth").map((n) => n.id),
    ["api", "auth"],
  );
  assert.deepEqual(
    containerChain(TREE(), "api").map((n) => n.id),
    ["api"],
  );
});

test("containerChain: unknown / null node → empty chain", () => {
  assert.deepEqual(containerChain(TREE(), "nope"), []);
  assert.deepEqual(containerChain(TREE(), null), []);
  assert.deepEqual(containerChain(null, "api"), []);
});

// ── Visibility: the headline requirement ────────────────────────────────────

test("a folder sees its own profiles plus its ancestors' — 2 at the parent, 5 below the subfolder", () => {
  const atApi = groupsAt("api");
  const atAuth = groupsAt("auth");
  const atR1 = groupsAt("r1");

  const folderNames = (gs) =>
    gs
      .filter((g) => g.tier === "folder")
      .flatMap((g) => g.profiles.map((p) => p.name));

  assert.deepEqual(folderNames(atApi), ["eu", "us"], "API sees only its own 2");
  assert.deepEqual(
    folderNames(atAuth),
    ["eu", "us", "user1", "user2", "admin"],
    "Auth sees its parent's 2 + its own 3",
  );
  assert.deepEqual(
    folderNames(atR1),
    folderNames(atAuth),
    "a request sees exactly what its parent folder sees",
  );
});

test("a SIBLING of the owning folder sees none of its profiles", () => {
  const folderGroups = groupsAt("reports").filter((g) => g.tier === "folder");
  assert.deepEqual(
    folderGroups,
    [],
    "Reports owns nothing and inherits nothing",
  );
  assert.deepEqual(
    groupsAt("r2").filter((g) => g.tier === "folder"),
    [],
  );
});

test("the collection tier is visible from every folder, including one that owns nothing", () => {
  for (const id of ["api", "auth", "r1", "reports", "r2"]) {
    const coll = groupsAt(id).find((g) => g.ownerKey === COLLECTION_OWNER_KEY);
    assert.ok(coll, `collection tier missing at ${id}`);
    assert.deepEqual(
      coll.profiles.map((p) => p.name),
      ["Staging", "Prod"],
    );
    assert.equal(coll.ownerName, "Payments");
  }
});

test("groups are ordered outermost → innermost and labelled by their owner", () => {
  assert.deepEqual(
    groupsAt("r1").map((g) => [g.ownerKey, g.ownerName, g.tier]),
    [
      [COLLECTION_OWNER_KEY, "Payments", "collection"],
      ["api", "API", "folder"],
      ["auth", "Auth", "folder"],
    ],
  );
});

test("an owner with no named profiles is omitted, so an empty result hides the switcher", () => {
  const noColl = profileGroupsForNode({ items: TREE(), nodeId: "r2" });
  assert.deepEqual(noColl, []);
});

// ── flattenGroups / slots ───────────────────────────────────────────────────

test("flattenGroups: outermost→innermost order is what the ⌥⌘1–9 slots address", () => {
  assert.deepEqual(
    flattenGroups(groupsAt("r1")).map((p) => p.name),
    ["Staging", "Prod", "eu", "us", "user1", "user2", "admin"],
  );
});

test("flattenGroups: each entry carries the owner that a selection replaces", () => {
  const flat = flattenGroups(groupsAt("r1"));
  assert.deepEqual(
    flat.find((p) => p.name === "user2"),
    {
      id: "user2",
      name: "user2",
      ownerKey: "auth",
      ownerName: "Auth",
      tier: "folder",
    },
  );
});

test("the visible total may exceed the nine-per-owner cap", () => {
  // Two owners at the cap → 18 visible, 9 addressable. Not an error.
  const many = (prefix) =>
    Array.from({ length: 9 }, (_, i) => ({
      id: `${prefix}${i}`,
      name: `${prefix}${i}`,
    }));
  const items = [
    {
      id: "a",
      type: "collection",
      name: "A",
      profiles: many("a"),
      children: [
        {
          id: "b",
          type: "collection",
          name: "B",
          profiles: many("b"),
          children: [],
        },
      ],
    },
  ];
  const flat = flattenGroups(profileGroupsForNode({ items, nodeId: "b" }));
  assert.equal(flat.length, 18);
});

// ── Active selections ───────────────────────────────────────────────────────

test("activeIdsForGroups: one per owner, ordered outermost → innermost", () => {
  const active = { [COLLECTION_OWNER_KEY]: "prod", api: "eu", auth: "user2" };
  assert.deepEqual(activeIdsForGroups(groupsAt("r1"), active), [
    "prod",
    "eu",
    "user2",
  ]);
});

test("activeIdsForGroups: an owner with no selection is simply on its Default", () => {
  assert.deepEqual(activeIdsForGroups(groupsAt("r1"), { auth: "admin" }), [
    "admin",
  ]);
  assert.deepEqual(activeIdsForGroups(groupsAt("r1"), {}), []);
  assert.deepEqual(activeIdsForGroups(groupsAt("r1"), undefined), []);
});

test("activeIdsForGroups: a stale selection (profile deleted) is skipped, not applied", () => {
  assert.deepEqual(activeIdsForGroups(groupsAt("r1"), { auth: "ghost" }), []);
});

test("activeIdsForGroups: an out-of-scope owner's selection does not leak in", () => {
  // "auth" is selected while we're looking at API, which is ABOVE Auth.
  assert.deepEqual(activeIdsForGroups(groupsAt("api"), { auth: "user2" }), []);
});

test("ownerOfProfile: finds the owning group, or null", () => {
  const gs = groupsAt("r1");
  assert.equal(ownerOfProfile(gs, "user2").ownerKey, "auth");
  assert.equal(ownerOfProfile(gs, "eu").ownerKey, "api");
  assert.equal(ownerOfProfile(gs, "prod").ownerKey, COLLECTION_OWNER_KEY);
  assert.equal(ownerOfProfile(gs, "nope"), null);
  assert.equal(ownerOfProfile(gs, null), null);
});

// ── pruneActiveSelections ───────────────────────────────────────────────────

test("pruneActiveSelections: keeps live selections anywhere in the tree", () => {
  const active = { [COLLECTION_OWNER_KEY]: "prod", api: "us", auth: "admin" };
  const out = pruneActiveSelections(active, {
    items: TREE(),
    collectionProfiles: COLL_PROFILES,
  });
  assert.deepEqual(out.map, active);
  assert.equal(out.changed, false, "no write when nothing was stale");
});

test("pruneActiveSelections: drops a deleted folder's owner key and a deleted profile", () => {
  const active = { gone: "x", api: "ghost", auth: "admin" };
  const out = pruneActiveSelections(active, {
    items: TREE(),
    collectionProfiles: COLL_PROFILES,
  });
  assert.deepEqual(out.map, { auth: "admin" });
  assert.equal(out.changed, true);
});

test("allProfileGroups: indexes every owner in the tree regardless of scope", () => {
  assert.deepEqual(
    allProfileGroups(TREE(), COLL_PROFILES).map((g) => g.ownerKey),
    [COLLECTION_OWNER_KEY, "api", "auth"],
  );
});

// ── Layered resolution ──────────────────────────────────────────────────────

test("resolvedFolderChain: returns the chain NEAREST-first for the resolver", () => {
  const chain = resolvedFolderChain({
    items: TREE(),
    nodeId: "r1",
    collectionProfiles: COLL_PROFILES,
    activeByOwner: {},
  });
  assert.deepEqual(
    chain.map((f) => f.id),
    ["auth", "api"],
  );
});

test("resolvedFolderChain: with nothing active every folder resolves to its Default", () => {
  const chain = resolvedFolderChain({
    items: TREE(),
    nodeId: "r1",
    collectionProfiles: COLL_PROFILES,
    activeByOwner: {},
  });
  const api = chain.find((f) => f.id === "api");
  assert.equal(api.variables.region, "dev");
  assert.equal(api.variables.host, "dev.example.com");
  assert.equal(chain.find((f) => f.id === "auth").variables.user, "dev-user");
});

test("resolvedFolderChain: an ancestor-owned profile applies at the DESCENDANT too", () => {
  // "eu" is owned by API but Auth stores its own override for it.
  const chain = resolvedFolderChain({
    items: TREE(),
    nodeId: "r1",
    collectionProfiles: COLL_PROFILES,
    activeByOwner: { api: "eu" },
  });
  assert.equal(chain.find((f) => f.id === "api").variables.region, "eu-west-1");
  assert.equal(
    chain.find((f) => f.id === "auth").variables.user,
    "eu-user",
    "Auth's override for the ancestor-owned profile must be applied at Auth",
  );
});

test("resolvedFolderChain: collection-tier and folder-tier selections layer together", () => {
  const chain = resolvedFolderChain({
    items: TREE(),
    nodeId: "r1",
    collectionProfiles: COLL_PROFILES,
    activeByOwner: {
      [COLLECTION_OWNER_KEY]: "staging",
      api: "eu",
      auth: "user2",
    },
  });
  const api = chain.find((f) => f.id === "api");
  assert.equal(api.variables.host, "stg", "from the collection-tier profile");
  assert.equal(
    api.variables.region,
    "eu-west-1",
    "from the folder-tier profile",
  );
  assert.equal(chain.find((f) => f.id === "auth").variables.user, "second");
});

test("resolvedFolderChain: a profile is NOT applied outside its owner's subtree", () => {
  // "user2" is owned by Auth. Selecting it must change nothing at API, which is
  // above Auth — even though API is in the same collection.
  const items = TREE();
  items[0].profileValues = {
    ...items[0].profileValues,
    user2: { region: "LEAK" },
  };
  const chain = resolvedFolderChain({
    items,
    nodeId: "api",
    collectionProfiles: COLL_PROFILES,
    activeByOwner: { auth: "user2" },
  });
  assert.equal(
    chain.find((f) => f.id === "api").variables.region,
    "dev",
    "a descendant-owned profile must never reach an ancestor folder",
  );
});

test("resolvedFolderChain: a sibling subtree is untouched by another branch's selection", () => {
  const chain = resolvedFolderChain({
    items: TREE(),
    nodeId: "r2",
    collectionProfiles: COLL_PROFILES,
    activeByOwner: { api: "eu", auth: "user2" },
  });
  assert.deepEqual(
    chain.map((f) => f.id),
    ["reports"],
  );
  assert.deepEqual(chain[0].variables, {});
});

test("resolvedFolderChain: carries a secureVariables set taken from the Default", () => {
  const items = TREE();
  items[0].variables.push({ name: "token", value: "t", secure: true });
  const chain = resolvedFolderChain({
    items,
    nodeId: "r1",
    collectionProfiles: COLL_PROFILES,
    activeByOwner: { api: "eu" },
  });
  const api = chain.find((f) => f.id === "api");
  assert.ok(api.secureVariables.has("token"));
  assert.ok(!api.secureVariables.has("region"));
});

test("resolvedFolderChain: unknown node → empty chain", () => {
  assert.deepEqual(resolvedFolderChain({ items: TREE(), nodeId: "nope" }), []);
});

// ── Subtree helpers ─────────────────────────────────────────────────────────

test("collectOwnedProfileIds: every id owned anywhere in the subtree", () => {
  const api = TREE()[0];
  assert.deepEqual(collectOwnedProfileIds(api), [
    "eu",
    "us",
    "user1",
    "user2",
    "admin",
  ]);
  assert.deepEqual(collectOwnedProfileIds(TREE()[1]), []);
});

test("hoistScopedProfiles: an exported subtree carries its ancestors' in-scope profiles", () => {
  const auth = TREE()[0].children[0];
  const out = hoistScopedProfiles(auth, groupsAt("auth"));
  assert.deepEqual(
    out.profiles.map((p) => p.id),
    ["eu", "us", "user1", "user2", "admin"],
    "ancestors first, then the node's own",
  );
  assert.deepEqual(
    auth.profiles.map((p) => p.id),
    ["user1", "user2", "admin"],
    "the input node is not mutated",
  );
});

test("hoistScopedProfiles: collection-tier profiles are NOT hoisted (they travel separately)", () => {
  const out = hoistScopedProfiles(TREE()[0].children[0], groupsAt("auth"));
  assert.ok(!out.profiles.some((p) => p.id === "staging" || p.id === "prod"));
});

test("hoistScopedProfiles: nothing to hoist → the same node back", () => {
  const api = TREE()[0];
  assert.equal(hoistScopedProfiles(api, groupsAt("api")), api);
});
