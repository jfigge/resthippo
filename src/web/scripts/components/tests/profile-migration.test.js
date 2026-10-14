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
 * components/tests/profile-migration.test.js
 *
 * Moving collection-wide profiles down to the folder that owns them. The signal
 * is a NON-EMPTY override map (a bare `profileValues` key is bookkeeping noise
 * from the old applyProfileEdit), and the owner is lifted to the top of the
 * branch it belongs to.
 *
 * Run with:   node --test components/tests/profile-migration.test.js
 */

"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  migrateProfileScopes,
  PROFILE_SCOPE_VERSION,
} from "../profile-migration.js";
import { COLLECTION_OWNER_KEY } from "../profile-scope.js";

const folder = (id, name, profileValues, children = []) => ({
  id,
  type: "collection",
  name,
  variables: [],
  ...(profileValues ? { profileValues } : {}),
  children,
});

/**
 * The real shape of the dev store's COLLECTIONS collection — the case this
 * migration was designed against. Note the EMPTY maps under One / One-One-One:
 * bookkeeping written by the old applyProfileEdit, not evidence of use.
 */
const LIVE_TREE = () => [
  folder("rest", "Rest", null, [folder("body", "Body", null, [])]),
  folder(
    "sp",
    "Swagger Petstore",
    { fred: { baseUrl: "x", name: "y" }, banana: {} },
    [
      folder("store", "store", { fred: { name: "s" }, banana: { name: "b" } }),
      folder("user", "user", null),
    ],
  ),
  folder("one", "One", { fred: {}, banana: {} }, [
    folder("one-one", "One-One", null, [
      folder("ooo", "One-One-One", {
        fred: {},
        banana: {},
        jaosn: { ooo: "v" },
      }),
    ]),
    folder("one-two", "One-Two", null),
  ]),
  folder("two", "Two", null, [folder("two-one", "Two-One", null)]),
];

const LIVE_PROFILES = [
  { id: "fred", name: "Fred" },
  { id: "banana", name: "banana" },
  { id: "jaosn", name: "000-jaosn" },
];

const ownerOf = (out, profileId) =>
  out.moved.find((m) => m.profileId === profileId)?.ownerId ?? null;

/** Every node id that ended up owning `profileId` in the rewritten tree. */
function ownersInTree(items, profileId) {
  const found = [];
  const walk = (nodes) => {
    for (const n of nodes ?? []) {
      if (n?.type !== "collection") continue;
      if ((n.profiles ?? []).some((p) => p.id === profileId)) found.push(n.id);
      walk(n.children);
    }
  };
  walk(items);
  return found;
}

// ── The live-store case ─────────────────────────────────────────────────────

test("live shape: each profile lands on the folder it belongs to", () => {
  const out = migrateProfileScopes({
    items: LIVE_TREE(),
    variableProfiles: LIVE_PROFILES,
  });
  assert.equal(out.changed, true);
  assert.equal(
    ownerOf(out, "fred"),
    "sp",
    "used at Swagger Petstore + store → the branch top",
  );
  assert.equal(
    ownerOf(out, "banana"),
    "sp",
    "only used at store, lifted to the branch top",
  );
  assert.equal(
    ownerOf(out, "jaosn"),
    "ooo",
    "used only at One-One-One → stays deep",
  );
});

test("live shape: moved profiles leave the collection tier and appear on their node", () => {
  const out = migrateProfileScopes({
    items: LIVE_TREE(),
    variableProfiles: LIVE_PROFILES,
  });
  assert.deepEqual(out.variableProfiles, [], "all three found a folder owner");
  assert.deepEqual(ownersInTree(out.items, "fred"), ["sp"]);
  assert.deepEqual(ownersInTree(out.items, "banana"), ["sp"]);
  assert.deepEqual(ownersInTree(out.items, "jaosn"), ["ooo"]);
});

test("live shape: profileValues are never touched — the move is lossless", () => {
  const before = LIVE_TREE();
  const out = migrateProfileScopes({
    items: before,
    variableProfiles: LIVE_PROFILES,
  });
  const pv = (items, id) => {
    let hit = null;
    const walk = (ns) => {
      for (const n of ns ?? []) {
        if (n?.type !== "collection") continue;
        if (n.id === id) hit = n.profileValues;
        walk(n.children);
      }
    };
    walk(items);
    return hit;
  };
  for (const id of ["sp", "store", "one", "ooo"]) {
    assert.deepEqual(
      pv(out.items, id),
      pv(before, id),
      `profileValues changed at ${id}`,
    );
  }
});

test("live shape: the input tree is not mutated", () => {
  const before = LIVE_TREE();
  migrateProfileScopes({ items: before, variableProfiles: LIVE_PROFILES });
  assert.equal(
    before[1].profiles,
    undefined,
    "Swagger Petstore gained nothing in place",
  );
});

// ── The signal: empty maps must not count ───────────────────────────────────

test("an EMPTY override map is bookkeeping, not use", () => {
  // Only One-One-One holds a real value. The empty key in the OTHER branch must
  // not make the profile look collection-wide.
  const items = [
    folder("sp", "Swagger Petstore", { p: {} }),
    folder("one", "One", null, [
      folder("ooo", "One-One-One", { p: { k: "v" } }),
    ]),
  ];
  const out = migrateProfileScopes({
    items,
    variableProfiles: [{ id: "p", name: "P" }],
  });
  assert.equal(ownerOf(out, "p"), "ooo");
});

test("an empty key ON AN ANCESTOR still drives the lift (the `banana` case)", () => {
  // Deliberate asymmetry: an empty map never counts as USE, but it does mark a
  // folder the profile was visible under, which is what lifts the owner to the
  // top of the branch instead of burying it in the one leaf holding a value.
  // This is exactly how live `banana` — real value only at Swagger Petstore/store,
  // empty key at Swagger Petstore — ends up owned by Swagger Petstore.
  const items = [
    folder("sp", "Swagger Petstore", { p: {} }, [
      folder("store", "store", { p: { name: "b" } }),
      folder("user", "user", null),
    ]),
  ];
  const out = migrateProfileScopes({
    items,
    variableProfiles: [{ id: "p", name: "P" }],
  });
  assert.equal(
    ownerOf(out, "p"),
    "sp",
    "lifted off the leaf so the sibling `user` folder can see it too",
  );
});

test("a profile with NO values anywhere stays collection-wide", () => {
  const items = [folder("sp", "Swagger Petstore", { p: {} })];
  const out = migrateProfileScopes({
    items,
    variableProfiles: [{ id: "p", name: "P" }],
  });
  assert.deepEqual(out.moved, []);
  assert.deepEqual(out.variableProfiles, [{ id: "p", name: "P" }]);
});

test("a profile used under two different top-level folders stays collection-wide", () => {
  const items = [
    folder("a", "A", { p: { k: "1" } }),
    folder("b", "B", { p: { k: "2" } }),
  ];
  const out = migrateProfileScopes({
    items,
    variableProfiles: [{ id: "p", name: "P" }],
  });
  assert.deepEqual(out.moved, [], "no common ancestor inside the tree");
  assert.deepEqual(out.variableProfiles, [{ id: "p", name: "P" }]);
});

// ── The lift ────────────────────────────────────────────────────────────────

test("the owner lifts to the shallowest ancestor holding any key for the profile", () => {
  const items = [
    folder("top", "Top", { p: {} }, [
      folder("mid", "Mid", null, [folder("leaf", "Leaf", { p: { k: "v" } })]),
    ]),
  ];
  const out = migrateProfileScopes({
    items,
    variableProfiles: [{ id: "p", name: "P" }],
  });
  assert.equal(
    ownerOf(out, "p"),
    "top",
    "Top carries a key, so the profile belongs there",
  );
});

test("the lift never leaves the used-by branch", () => {
  // "other" also carries a key but is in a different branch — it must not win.
  const items = [
    folder("other", "Other", { p: {} }),
    folder("top", "Top", null, [folder("leaf", "Leaf", { p: { k: "v" } })]),
  ];
  const out = migrateProfileScopes({
    items,
    variableProfiles: [{ id: "p", name: "P" }],
  });
  assert.equal(
    ownerOf(out, "p"),
    "leaf",
    "no ancestor of the DCA holds a key → stay at the DCA",
  );
});

test("with no keyed ancestor the owner is the exact deepest common ancestor", () => {
  const items = [
    folder("top", "Top", null, [
      folder("l1", "L1", { p: { k: "1" } }),
      folder("l2", "L2", { p: { k: "2" } }),
    ]),
  ];
  const out = migrateProfileScopes({
    items,
    variableProfiles: [{ id: "p", name: "P" }],
  });
  assert.equal(ownerOf(out, "p"), "top");
});

// ── The active selection ────────────────────────────────────────────────────

test("a legacy selection follows its profile to the new owner", () => {
  const out = migrateProfileScopes({
    items: LIVE_TREE(),
    variableProfiles: LIVE_PROFILES,
    activeVariableProfileId: "jaosn",
  });
  assert.deepEqual(out.activeVariableProfileIds, { ooo: "jaosn" });
});

test("a legacy selection on a profile that stayed lands on the collection tier", () => {
  const items = [
    folder("a", "A", { p: { k: "1" } }),
    folder("b", "B", { p: { k: "2" } }),
  ];
  const out = migrateProfileScopes({
    items,
    variableProfiles: [{ id: "p", name: "P" }],
    activeVariableProfileId: "p",
  });
  assert.deepEqual(out.activeVariableProfileIds, {
    [COLLECTION_OWNER_KEY]: "p",
  });
});

test("no legacy selection → an empty active map", () => {
  const out = migrateProfileScopes({
    items: LIVE_TREE(),
    variableProfiles: LIVE_PROFILES,
  });
  assert.deepEqual(out.activeVariableProfileIds, {});
});

// ── Idempotency ─────────────────────────────────────────────────────────────

test("a second run is a no-op", () => {
  const first = migrateProfileScopes({
    items: LIVE_TREE(),
    variableProfiles: LIVE_PROFILES,
    activeVariableProfileId: "fred",
  });
  assert.equal(first.profileScopeVersion, PROFILE_SCOPE_VERSION);

  const second = migrateProfileScopes({
    items: first.items,
    variableProfiles: first.variableProfiles,
    activeVariableProfileIds: first.activeVariableProfileIds,
    profileScopeVersion: first.profileScopeVersion,
  });
  assert.equal(second.changed, false);
  assert.equal(second.items, first.items, "same reference — nothing rebuilt");
  assert.deepEqual(second.variableProfiles, first.variableProfiles);
  assert.deepEqual(
    second.activeVariableProfileIds,
    first.activeVariableProfileIds,
  );
});

test("an already-stamped collection is left alone even with profiles still listed", () => {
  const out = migrateProfileScopes({
    items: LIVE_TREE(),
    variableProfiles: LIVE_PROFILES,
    profileScopeVersion: PROFILE_SCOPE_VERSION,
  });
  assert.equal(out.changed, false);
  assert.deepEqual(out.variableProfiles, LIVE_PROFILES);
});

test("an empty collection migrates cleanly and gets stamped", () => {
  const out = migrateProfileScopes({ items: [], variableProfiles: [] });
  assert.equal(out.changed, true);
  assert.deepEqual(out.moved, []);
  assert.equal(out.profileScopeVersion, PROFILE_SCOPE_VERSION);
});

test("missing / malformed state does not throw", () => {
  const out = migrateProfileScopes();
  assert.equal(out.changed, true);
  assert.deepEqual(out.items, []);
  assert.deepEqual(out.variableProfiles, []);
});

test("an existing node.profiles list is preserved, not replaced", () => {
  const items = [
    {
      ...folder("top", "Top", { p: { k: "v" } }),
      profiles: [{ id: "existing", name: "Existing" }],
    },
  ];
  const out = migrateProfileScopes({
    items,
    variableProfiles: [{ id: "p", name: "P" }],
  });
  assert.deepEqual(
    out.items[0].profiles.map((p) => p.id),
    ["existing", "p"],
  );
});
