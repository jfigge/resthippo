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

"use strict";

/**
 * profile-migration.js — one-shot move of collection-wide profiles down to the
 * folder that actually owns them.
 *
 * Before scoping, every named profile lived on the manifest collection entry
 * (`variableProfiles`) and was offered under every folder. This computes, for each
 * such profile, the folder it belongs to and rewrites it onto that node's
 * `profiles`; a profile genuinely used across the collection stays where it is.
 *
 * ## What counts as "using" a profile
 *
 * A NON-EMPTY `profileValues[profileId]` map. A bare key means nothing: the old
 * `applyProfileEdit` wrote `profileValues[pid] = {}` for every known profile on
 * every folder-variable save, so almost every folder carries a key for almost
 * every profile. Counting bare keys makes this migration a near no-op. (The empty
 * writes are fixed at the source in folder-profiles.js; this rule also makes the
 * migration correct for stores written before that fix.)
 *
 * ## Choosing the owner
 *
 *   1. `dca` — the deepest common ancestor of every folder that USES the profile.
 *      No users, or users spanning two top-level folders (no common ancestor
 *      inside the tree) → the profile stays collection-wide.
 *   2. Lift `dca` to the SHALLOWEST of its own ancestors-or-self that carries any
 *      key for the profile, falling back to `dca` itself. This keeps a profile at
 *      the top of the branch it belongs to instead of burying it in the one leaf
 *      that happens to hold the only override. The lift can never leave `dca`'s
 *      ancestor chain, so the profile stays visible to every folder that uses it.
 *
 * ## Safety
 *
 * `profileValues` are never touched — they are id-keyed, so they keep resolving
 * verbatim under the new owner. That is what makes this lossless: a profile only
 * ever moves between the two tiers. The caller must persist the TREE FIRST and the
 * manifest second, so a crash between the two leaves a profile listed in both
 * tiers (visible twice — ugly, recoverable) rather than in neither (lost).
 *
 * Pure: no DOM, no persistence, no mutation of the inputs.
 */

import { COLLECTION_OWNER_KEY } from "./profile-scope.js";

/** Stamped on a collection entry once migrated; makes the run idempotent. */
export const PROFILE_SCOPE_VERSION = 2;

const isContainer = (n) =>
  !!n && typeof n === "object" && n.type === "collection";

/**
 * Index every container's root→node id path, plus which profile ids it holds a
 * key for and which it holds a NON-EMPTY map for.
 *
 * @param {object[]} items
 * @returns {{paths: Map<string,string[]>, anyKey: Map<string,Set<string>>,
 *            used: Map<string,Set<string>>}}
 *   `anyKey`/`used` are keyed by profileId → set of node ids.
 */
function indexTree(items) {
  const paths = new Map();
  const anyKey = new Map();
  const used = new Map();
  const add = (map, pid, nodeId) => {
    if (!map.has(pid)) map.set(pid, new Set());
    map.get(pid).add(nodeId);
  };
  const walk = (nodes, prefix) => {
    for (const n of nodes ?? []) {
      if (!isContainer(n)) continue;
      const id = String(n.id);
      const path = [...prefix, id];
      paths.set(id, path);
      for (const [pid, map] of Object.entries(n.profileValues ?? {})) {
        add(anyKey, pid, id);
        if (map && typeof map === "object" && Object.keys(map).length > 0) {
          add(used, pid, id);
        }
      }
      walk(n.children, path);
    }
  };
  walk(items, []);
  return { paths, anyKey, used };
}

/** The longest common prefix of a list of root→node id paths. */
function commonPrefix(pathList) {
  if (!pathList.length) return [];
  let prefix = pathList[0];
  for (const p of pathList.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < p.length && prefix[i] === p[i]) i++;
    prefix = prefix.slice(0, i);
    if (!prefix.length) break;
  }
  return prefix;
}

/**
 * Decide the owning node id for one profile, or null to leave it collection-wide.
 *
 * @param {string} profileId
 * @param {ReturnType<typeof indexTree>} index
 * @returns {string|null}
 */
function ownerForProfile(profileId, { paths, anyKey, used }) {
  const users = [...(used.get(profileId) ?? [])];
  if (!users.length) return null; // never actually used → stays collection-wide

  const dcaPath = commonPrefix(users.map((id) => paths.get(id) ?? []));
  if (!dcaPath.length) return null; // spans two top-level folders → stays

  // Lift to the shallowest ancestor-or-self of the DCA that holds any key for it.
  const keyed = anyKey.get(profileId) ?? new Set();
  const lifted = dcaPath.find((id) => keyed.has(id));
  return lifted ?? dcaPath[dcaPath.length - 1];
}

/** Rebuild the tree with each move's profile appended to its new owner's node. */
function attachProfiles(items, byOwner) {
  const walk = (nodes) =>
    (nodes ?? []).map((n) => {
      if (!isContainer(n)) return n;
      const owned = byOwner.get(String(n.id));
      const next = { ...n };
      if (owned?.length) {
        next.profiles = [
          ...(Array.isArray(n.profiles) ? n.profiles : []),
          ...owned.map((p) => ({ id: p.id, name: p.name })),
        ];
      }
      if (Array.isArray(n.children)) next.children = walk(n.children);
      return next;
    });
  return walk(items);
}

/**
 * Move collection-wide profiles onto the folders that own them.
 *
 * Idempotent: a collection already stamped at {@link PROFILE_SCOPE_VERSION}
 * returns `changed: false` with its inputs untouched.
 *
 * @param {{items?: object[], variableProfiles?: {id:string,name:string}[],
 *          activeVariableProfileId?: string|null,
 *          activeVariableProfileIds?: Record<string,string>,
 *          profileScopeVersion?: number}} state
 * @returns {{changed: boolean, items: object[],
 *            variableProfiles: {id:string,name:string}[],
 *            activeVariableProfileIds: Record<string,string>,
 *            profileScopeVersion: number,
 *            moved: {profileId:string,name:string,ownerId:string}[]}}
 */
export function migrateProfileScopes({
  items,
  variableProfiles,
  activeVariableProfileId,
  activeVariableProfileIds,
  profileScopeVersion,
} = {}) {
  const tree = Array.isArray(items) ? items : [];
  const profiles = Array.isArray(variableProfiles) ? variableProfiles : [];
  const legacyActive = activeVariableProfileId ?? null;
  const activeMap = { ...(activeVariableProfileIds ?? {}) };

  if ((profileScopeVersion ?? 0) >= PROFILE_SCOPE_VERSION) {
    return {
      changed: false,
      items: tree,
      variableProfiles: profiles,
      activeVariableProfileIds: activeMap,
      profileScopeVersion: profileScopeVersion ?? PROFILE_SCOPE_VERSION,
      moved: [],
    };
  }

  const index = indexTree(tree);
  const moved = [];
  for (const p of profiles) {
    if (!p || p.id == null) continue;
    const ownerId = ownerForProfile(String(p.id), index);
    if (ownerId) {
      moved.push({
        profileId: String(p.id),
        name: String(p.name ?? ""),
        ownerId,
      });
    }
  }

  const movedById = new Map(moved.map((m) => [m.profileId, m]));
  const byOwner = new Map();
  for (const m of moved) {
    if (!byOwner.has(m.ownerId)) byOwner.set(m.ownerId, []);
    byOwner.get(m.ownerId).push({ id: m.profileId, name: m.name });
  }

  // The single legacy selection becomes an entry under whichever tier now owns it.
  if (legacyActive) {
    const m = movedById.get(String(legacyActive));
    activeMap[m ? m.ownerId : COLLECTION_OWNER_KEY] = String(legacyActive);
  }

  return {
    changed: true,
    items: moved.length ? attachProfiles(tree, byOwner) : tree,
    variableProfiles: profiles.filter(
      (p) => p && p.id != null && !movedById.has(String(p.id)),
    ),
    activeVariableProfileIds: activeMap,
    profileScopeVersion: PROFILE_SCOPE_VERSION,
    moved,
  };
}
