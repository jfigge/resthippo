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
 * profile-scope.js — which variable profiles are VISIBLE where, and in what order.
 *
 * `folder-profiles.js` owns what a profile's values mean; this module owns who can
 * see it. A named profile is OWNED by exactly one scope:
 *
 *   • the COLLECTION tier — `collections[i].variableProfiles` on the manifest
 *     entry, visible from every folder in that collection; or
 *   • one FOLDER — `node.profiles` on that tree node, visible to the folder and
 *     its descendants only.
 *
 * So the set visible at a node is the collection tier plus every ancestor's owned
 * profiles plus the node's own, ordered OUTERMOST → INNERMOST and grouped by
 * owner. A sibling of an owning folder sees none of its profiles.
 *
 * Exactly one profile is active PER OWNER (or none — that owner's Default), held
 * in an `activeByOwner` map keyed by `ownerKey`. At send time those selections
 * LAYER: {@link resolvedFolderChain} hands each folder the ids active in its own
 * scope, outermost first, and the innermost override of a name wins.
 *
 * The active map lives on the manifest collection entry, NOT on tree nodes — a
 * selection must not travel on export, and switching one must not dirty the tree.
 *
 * Every function here is pure: no DOM, no persistence, no mutation of its inputs.
 */

import {
  normalizeVariables,
  varsArrayToMap,
  varsArrayToSecureSet,
} from "./variable-shape.js";
import { resolvedProfileVars } from "./folder-profiles.js";

/**
 * Owner key for the collection tier. "@"-prefixed so it can never collide with a
 * node id (a UUID), which is what every other owner key is.
 */
export const COLLECTION_OWNER_KEY = "@collection";

/**
 * @typedef {object} ProfileGroup
 * @property {string} ownerKey   COLLECTION_OWNER_KEY, or the owning node's id.
 * @property {string|null} ownerId  The owning node's id; null for the collection.
 * @property {string} ownerName  Display label for the group heading.
 * @property {"collection"|"folder"} tier
 * @property {{id:string,name:string}[]} profiles
 */

/** A tree node is a container (collection root row / folder) — legacy type name. */
const isContainer = (n) =>
  !!n && typeof n === "object" && n.type === "collection";

/** Coerce a stored profile list to `[{id,name}]`, dropping malformed entries. */
function normalizeProfiles(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const p of input) {
    if (!p || p.id == null) continue;
    const id = String(p.id);
    if (seen.has(id)) continue; // an id can only be owned once within a scope
    seen.add(id);
    out.push({ id, name: String(p.name ?? "") });
  }
  return out;
}

/**
 * The container chain for `nodeId`, OUTERMOST → INNERMOST, **including the node
 * itself when it is a container** (a folder sees its own profiles; a request sees
 * only its ancestors').
 *
 * This is the mirror of `buildFolderChain` (variable-resolver.js), which returns
 * ancestors nearest-first and excludes the node — the opposite of what scoping
 * needs, so this walks once rather than reversing and re-testing the node.
 *
 * @param {object[]} items   Root-level tree items
 * @param {string|null} nodeId
 * @returns {object[]}
 */
export function containerChain(items, nodeId) {
  if (!nodeId) return [];
  let found = null;
  const walk = (nodes, path) => {
    for (const n of nodes ?? []) {
      if (!n || typeof n !== "object") continue;
      const here = isContainer(n) ? [...path, n] : path;
      if (n.id === nodeId) {
        found = here;
        return true;
      }
      if (
        isContainer(n) &&
        Array.isArray(n.children) &&
        walk(n.children, here)
      ) {
        return true;
      }
    }
    return false;
  };
  walk(items, []);
  return found ?? [];
}

/**
 * The owner groups visible at `nodeId`, outermost → innermost. Owners with no
 * named profiles are omitted, so an empty result means "this node sees no
 * profiles at all" — which is what hides the switcher.
 *
 * @param {{items?: object[], nodeId?: string|null,
 *          collectionProfiles?: {id:string,name:string}[],
 *          collectionLabel?: string}} opts
 * @returns {ProfileGroup[]}
 */
export function profileGroupsForNode({
  items,
  nodeId,
  collectionProfiles,
  collectionLabel = "",
} = {}) {
  const groups = [];
  const coll = normalizeProfiles(collectionProfiles);
  if (coll.length) {
    groups.push({
      ownerKey: COLLECTION_OWNER_KEY,
      ownerId: null,
      ownerName: collectionLabel,
      tier: "collection",
      profiles: coll,
    });
  }
  for (const node of containerChain(items, nodeId)) {
    const owned = normalizeProfiles(node.profiles);
    if (!owned.length) continue;
    groups.push({
      ownerKey: String(node.id),
      ownerId: String(node.id),
      ownerName: String(node.name ?? ""),
      tier: "folder",
      profiles: owned,
    });
  }
  return groups;
}

/**
 * Flatten groups to one outermost→innermost list — the order the ⌥⌘1–9 slots and
 * the native menu's accelerators address.
 *
 * @param {ProfileGroup[]} groups
 * @returns {{id:string,name:string,ownerKey:string,ownerName:string,tier:string}[]}
 */
export function flattenGroups(groups) {
  const out = [];
  for (const g of groups ?? []) {
    for (const p of g.profiles ?? []) {
      out.push({
        id: p.id,
        name: p.name,
        ownerKey: g.ownerKey,
        ownerName: g.ownerName,
        tier: g.tier,
      });
    }
  }
  return out;
}

/**
 * The ACTIVE profile ids across `groups`, outermost → innermost — the layer order
 * {@link resolvedProfileVars} expects. A selection naming a profile the owner no
 * longer has (deleted, or a stale map entry) is skipped rather than applied.
 *
 * @param {ProfileGroup[]} groups
 * @param {Record<string,string>} [activeByOwner]
 * @returns {string[]}
 */
export function activeIdsForGroups(groups, activeByOwner) {
  const out = [];
  for (const g of groups ?? []) {
    const id = activeByOwner?.[g.ownerKey];
    if (!id) continue; // that owner is on its Default
    if (!(g.profiles ?? []).some((p) => p.id === id)) continue; // stale
    out.push(id);
  }
  return out;
}

/**
 * The group that owns `profileId`, or null. Drives the editor's rename/delete
 * gating (only the owning folder, or the collection tier, may manage a profile).
 *
 * @param {ProfileGroup[]} groups
 * @param {string|null} profileId
 * @returns {ProfileGroup|null}
 */
export function ownerOfProfile(groups, profileId) {
  if (!profileId) return null;
  for (const g of groups ?? []) {
    if ((g.profiles ?? []).some((p) => p.id === profileId)) return g;
  }
  return null;
}

/**
 * Every `{ownerKey, ownerId, profiles}` in a whole tree plus the collection tier —
 * the full ownership index, independent of any one node's scope. Used to validate
 * selections and to detect id collisions on import.
 *
 * @param {object[]} items
 * @param {{id:string,name:string}[]} [collectionProfiles]
 * @returns {ProfileGroup[]}
 */
export function allProfileGroups(items, collectionProfiles) {
  const groups = [];
  const coll = normalizeProfiles(collectionProfiles);
  if (coll.length) {
    groups.push({
      ownerKey: COLLECTION_OWNER_KEY,
      ownerId: null,
      ownerName: "",
      tier: "collection",
      profiles: coll,
    });
  }
  const walk = (nodes) => {
    for (const n of nodes ?? []) {
      if (!isContainer(n)) continue;
      const owned = normalizeProfiles(n.profiles);
      if (owned.length) {
        groups.push({
          ownerKey: String(n.id),
          ownerId: String(n.id),
          ownerName: String(n.name ?? ""),
          tier: "folder",
          profiles: owned,
        });
      }
      walk(n.children);
    }
  };
  walk(items);
  return groups;
}

/**
 * Drop selections whose owner or profile no longer exists — a folder that owned
 * profiles was deleted, or a profile was removed. Returns a NEW map plus whether
 * anything changed, so the caller can skip an otherwise pointless manifest write.
 *
 * @param {Record<string,string>} [activeByOwner]
 * @param {{items?: object[], collectionProfiles?: {id:string,name:string}[]}} opts
 * @returns {{ map: Record<string,string>, changed: boolean }}
 */
export function pruneActiveSelections(
  activeByOwner,
  { items, collectionProfiles } = {},
) {
  const groups = allProfileGroups(items, collectionProfiles);
  const byKey = new Map(groups.map((g) => [g.ownerKey, g]));
  const map = {};
  let changed = false;
  for (const [ownerKey, profileId] of Object.entries(activeByOwner ?? {})) {
    const g = byKey.get(ownerKey);
    if (profileId && g && g.profiles.some((p) => p.id === profileId)) {
      map[ownerKey] = profileId;
    } else {
      changed = true;
    }
  }
  return { map, changed };
}

/**
 * THE single site of layered profile resolution: the resolver-ready folder chain
 * for `nodeId`.
 *
 * Returns the chain **nearest-first** (what `resolveVariable` walks), each entry
 * carrying map-shaped `variables` — the folder's Default with every in-scope
 * active profile's overrides applied outermost-owner → innermost — and a parallel
 * `secureVariables` name set (the map form drops the secure flag).
 *
 * The single accumulating pass is correct because every folder in the chain is an
 * ancestor of `nodeId`: its in-scope id list is exactly a prefix of the node's, so
 * ids only ever get appended as we descend. A folder's OWN profile applies at that
 * folder (a profile is visible to its owner, not just its descendants).
 *
 * @param {{items?: object[], nodeId?: string|null,
 *          collectionProfiles?: {id:string,name:string}[],
 *          activeByOwner?: Record<string,string>}} opts
 * @returns {{id:string,name:string,variables:object,secureVariables:Set<string>}[]}
 */
export function resolvedFolderChain({
  items,
  nodeId,
  collectionProfiles,
  activeByOwner,
} = {}) {
  const chain = containerChain(items, nodeId); // outermost → innermost
  if (!chain.length) return [];

  // The collection tier is in scope everywhere, so it seeds the layer list.
  const collProfiles = normalizeProfiles(collectionProfiles);
  const collActive = activeByOwner?.[COLLECTION_OWNER_KEY];
  let ids =
    collActive && collProfiles.some((p) => p.id === collActive)
      ? [collActive]
      : [];

  const out = [];
  for (const folder of chain) {
    const own = activeByOwner?.[String(folder.id)];
    if (own && normalizeProfiles(folder.profiles).some((p) => p.id === own)) {
      ids = [...ids, own];
    }
    out.push({
      ...folder,
      variables: varsArrayToMap(
        resolvedProfileVars(folder.variables, folder.profileValues, ids),
      ),
      secureVariables: varsArrayToSecureSet(folder.variables),
    });
  }
  return out.reverse(); // resolveVariable() walks nearest-first
}

/**
 * Every profile id owned anywhere inside `node`'s subtree (the node included).
 * Used when a subtree is duplicated, exported, or imported.
 *
 * @param {object} node
 * @returns {string[]}
 */
export function collectOwnedProfileIds(node) {
  const out = [];
  const walk = (n) => {
    if (!isContainer(n)) return;
    for (const p of normalizeProfiles(n.profiles)) out.push(p.id);
    for (const c of n.children ?? []) walk(c);
  };
  walk(node);
  return out;
}

/**
 * Copy the FOLDER-tier profiles an exported subtree still depends on onto its
 * root. Exporting a nested folder otherwise loses the profiles owned by its
 * ancestors while the subtree's `profileValues` still key to them, so the archive
 * would carry values no profile claims.
 *
 * Collection-tier profiles are NOT hoisted — they travel in the archive's own
 * `collectionProfiles` field.
 *
 * @param {object} rootNode   the subtree being exported
 * @param {ProfileGroup[]} groups  groups in scope at `rootNode`
 * @returns {object} a new node (or `rootNode` when nothing needed hoisting)
 */
export function hoistScopedProfiles(rootNode, groups) {
  if (!isContainer(rootNode)) return rootNode;
  const own = normalizeProfiles(rootNode.profiles);
  const seen = new Set(own.map((p) => p.id));
  const extra = [];
  for (const g of groups ?? []) {
    if (g.tier !== "folder") continue;
    if (g.ownerId === rootNode.id) continue; // already its own
    for (const p of g.profiles ?? []) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      extra.push({ id: p.id, name: p.name });
    }
  }
  if (!extra.length) return rootNode;
  // Ancestors first, then the node's own — preserving outermost→innermost order.
  return { ...rootNode, profiles: [...extra, ...own] };
}

/** Re-export so callers need only one import for the shape helpers they pair with. */
export { normalizeProfiles, normalizeVariables };
