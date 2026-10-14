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
 * import/resthippo.js — import side of the native "Rest Hippo v1" format.
 *
 * Where the lossy importers (Postman/Insomnia/…) APPEND a freshly-parsed tree as
 * a new collection, the native format MERGES its archive into the active
 * collection with identity-aware matching, so re-importing an export restores in
 * place rather than duplicating:
 *
 *   - environments  — matched by id, then name; created from the exported id+name
 *                     when absent. Variables within a matched environment (and the
 *                     global scope) are added only when missing — an existing
 *                     value is never overwritten.
 *   - folders       — matched by id, then name; a match is REUSED as-is (its own
 *                     name/variables left untouched) and the archive's contents are
 *                     restored INTO it (recurse). A miss creates the whole subtree.
 *   - requests      — matched by id, then name; a match is DELETED and REPLACED by
 *                     the archived definition (the full, authoritative copy). A
 *                     miss creates it.
 *
 * Every function here is pure: it takes the current state + the archive and
 * returns the merged state plus stats. The app persists the result and decrypts
 * secrets (in main) before calling in.
 */

import { normalizeVariables } from "../components/variable-shape.js";
import { RESTHIPPO_FORMAT, RESTHIPPO_KIND } from "../export/resthippo.js";

/** True when a parsed object is a Rest Hippo v1 archive. */
export function detectRestHippo(data) {
  return (
    !!data &&
    typeof data === "object" &&
    data.format === RESTHIPPO_FORMAT &&
    data.kind === RESTHIPPO_KIND
  );
}

/**
 * Every variable-profile id owned by a container anywhere in `nodes`, plus the
 * ids each node holds VALUES for. Used to detect collisions on import.
 * @param {object[]} nodes
 * @returns {Set<string>}
 */
function collectProfileIds(nodes) {
  const out = new Set();
  const walk = (ns) => {
    for (const n of ns ?? []) {
      if (n?.type !== "collection") continue;
      for (const p of n.profiles ?? [])
        if (p?.id != null) out.add(String(p.id));
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/**
 * Give a freshly imported subtree its own profile ids wherever the archive's
 * would collide with one already in use, rekeying every descendant's
 * `profileValues` so the overrides follow. Returns a NEW node.
 *
 * Only ids that actually collide are touched, so re-importing an archive into
 * the folder it came from keeps its ids and stays idempotent; importing the same
 * archive a second time as a NEW folder gets an independent set instead of two
 * owners claiming one profile.
 *
 * @param {object} node
 * @param {Set<string>} usedIds  ids already owned in the target (mutated: the new
 *   ids are added so two imported siblings can't collide with each other either)
 * @returns {object}
 */
function deconflictProfileIds(node, usedIds) {
  const map = new Map();
  const walk = (n) => {
    if (!n || n.type !== "collection") return n;
    const out = { ...n };
    if (Array.isArray(n.profiles)) {
      out.profiles = n.profiles.map((p) => {
        const id = String(p?.id ?? "");
        if (!id) return p;
        if (!usedIds.has(id)) {
          usedIds.add(id);
          return { ...p, id };
        }
        const fresh = newId();
        map.set(id, fresh);
        usedIds.add(fresh);
        return { ...p, id: fresh };
      });
    }
    // A node can only hold values for a profile owned by itself or an ancestor,
    // and this walk is top-down, so `map` is complete by the time it is read.
    if (n.profileValues && typeof n.profileValues === "object") {
      out.profileValues = Object.fromEntries(
        Object.entries(n.profileValues).map(([pid, values]) => [
          map.get(pid) ?? pid,
          values,
        ]),
      );
    }
    if (Array.isArray(n.children)) out.children = n.children.map(walk);
    return out;
  };
  return walk(node);
}

/**
 * Merge an archive's items into a target tree (the active collection's items).
 * Returns a NEW items array (inputs are not mutated) plus create/replace counts.
 *
 * Folder-owned variable profiles travel inside the nodes. A folder matched to an
 * existing one has its profiles merged in (add-if-missing); a folder created
 * fresh has any COLLIDING profile id regenerated, so an archive imported twice
 * never leaves two owners claiming the same profile.
 *
 * @param {object[]} targetItems   Current tree nodes.
 * @param {object[]} archiveItems  Nodes from the archive.
 * @param {Set<string>} [usedIds]  internal — profile ids already in use.
 * @returns {{ items: object[], created: number, replaced: number }}
 */
export function mergeArchiveIntoTree(targetItems, archiveItems, usedIds) {
  const used = usedIds ?? collectProfileIds(targetItems);
  const result = Array.isArray(targetItems) ? [...targetItems] : [];
  let created = 0;
  let replaced = 0;

  const indexOfMatch = (type, node) => {
    let idx =
      node.id != null
        ? result.findIndex((n) => n && n.type === type && n.id === node.id)
        : -1;
    if (idx === -1 && node.name != null) {
      idx = result.findIndex(
        (n) => n && n.type === type && n.name === node.name,
      );
    }
    return idx;
  };

  for (const node of archiveItems ?? []) {
    if (!node || typeof node !== "object") continue;

    if (node.type === "collection") {
      const idx = indexOfMatch("collection", node);
      if (idx >= 0) {
        // Reuse the existing folder; restore the archive's contents into it.
        // The spread keeps the EXISTING node's fields, so the archive's owned
        // profiles would be dropped — merge them in explicitly (add-if-missing by
        // id or name, the same contract as the collection tier).
        const existing = result[idx];
        const sub = mergeArchiveIntoTree(
          existing.children ?? [],
          node.children ?? [],
          used,
        );
        result[idx] = { ...existing, children: sub.items };
        const ownProfiles = mergeProfileList(existing.profiles, node.profiles);
        if (ownProfiles.list.length) {
          result[idx].profiles = ownProfiles.list;
          for (const p of ownProfiles.list) used.add(String(p.id));
        }
        created += sub.created;
        replaced += sub.replaced;
      } else {
        result.push(deconflictProfileIds(structuredClone(node), used));
        const counts = countNodes(node);
        created += counts.folders + counts.requests;
      }
    } else if (node.type === "request") {
      const idx = indexOfMatch("request", node);
      if (idx >= 0) {
        result[idx] = structuredClone(node); // delete + replace with the archive copy
        replaced += 1;
      } else {
        result.push(structuredClone(node));
        created += 1;
      }
    }
  }

  return { items: result, created, replaced };
}

/**
 * Merge the archive's environments section into the current environment store.
 *
 * @param {object} current   { globalVariables, activeEnvironmentId, environments }
 * @param {object} archiveEnv  { globalVariables, environments }
 * @returns {{ environments: object, createdEnvs: number, addedVars: number }}
 */
export function mergeEnvironments(current, archiveEnv) {
  const cur = current ?? {};
  const curEnvs = Array.isArray(cur.environments) ? cur.environments : [];

  const globalMerge = mergeVariableList(
    cur.globalVariables,
    archiveEnv?.globalVariables,
  );
  let addedVars = globalMerge.added;
  let createdEnvs = 0;

  const environments = [...curEnvs];
  for (const incoming of archiveEnv?.environments ?? []) {
    if (!incoming || typeof incoming !== "object") continue;
    let idx =
      incoming.id != null
        ? environments.findIndex((e) => e && e.id === incoming.id)
        : -1;
    if (idx === -1 && incoming.name != null) {
      idx = environments.findIndex((e) => e && e.name === incoming.name);
    }
    if (idx >= 0) {
      const merged = mergeVariableList(
        environments[idx].variables,
        incoming.variables,
      );
      environments[idx] = { ...environments[idx], variables: merged.list };
      addedVars += merged.added;
    } else {
      const variables = normalizeVariables(incoming.variables);
      environments.push({
        id: incoming.id ?? newId(),
        name: incoming.name ?? "",
        variables,
      });
      createdEnvs += 1;
      addedVars += variables.length;
    }
  }

  return {
    environments: { ...cur, globalVariables: globalMerge.list, environments },
    createdEnvs,
    addedVars,
  };
}

/**
 * Add every incoming variable whose name is not already present in the target
 * (matched by name). Existing entries are never overwritten. Returns a NEW array.
 *
 * @param {Array|object} targetVars
 * @param {Array|object} incomingVars
 * @returns {{ list: object[], added: number }}
 */
export function mergeVariableList(targetVars, incomingVars) {
  const list = normalizeVariables(targetVars);
  const names = new Set(list.map((v) => v.name));
  let added = 0;
  for (const entry of normalizeVariables(incomingVars)) {
    if (!entry.name || names.has(entry.name)) continue;
    list.push(entry);
    names.add(entry.name);
    added += 1;
  }
  return { list, added };
}

/**
 * Add every incoming default header whose name (case-insensitive — header names
 * are case-insensitive) is not already present in the target; existing rows are
 * never overwritten, so re-importing restores in place without duplicating.
 * Returns a NEW array.
 *
 * @param {Array} targetHeaders
 * @param {Array} incomingHeaders
 * @returns {{ list: object[], added: number }}
 */
export function mergeHeaderList(targetHeaders, incomingHeaders) {
  const list = normalizeHeaderRows(targetHeaders);
  const names = new Set(list.map((h) => h.name.trim().toLowerCase()));
  let added = 0;
  for (const entry of normalizeHeaderRows(incomingHeaders)) {
    const key = entry.name.trim().toLowerCase();
    if (!key || names.has(key)) continue;
    list.push(entry);
    names.add(key);
    added += 1;
  }
  return { list, added };
}

/**
 * Merge an archive's folder-variable PROFILE list into the collection's, adding
 * a profile when neither its id NOR its (case-insensitive) name is already
 * present. Re-importing an export restores the same profiles in place without
 * duplicating. Folder value-overrides ride verbatim on the nodes and key by the
 * archive's profile ids, so ids are preserved as-is. Returns a NEW array.
 *
 * @param {{id:string,name:string}[]} targetProfiles
 * @param {{id:string,name:string}[]} incomingProfiles
 * @returns {{ list: {id:string,name:string}[], added: number }}
 */
export function mergeProfileList(targetProfiles, incomingProfiles) {
  const list = Array.isArray(targetProfiles)
    ? targetProfiles.filter((p) => p && p.id != null).map((p) => ({ ...p }))
    : [];
  const ids = new Set(list.map((p) => String(p.id)));
  const names = new Set(list.map((p) => String(p.name ?? "").toLowerCase()));
  let added = 0;
  for (const p of incomingProfiles ?? []) {
    if (!p || p.id == null) continue;
    const id = String(p.id);
    const name = String(p.name ?? "");
    if (ids.has(id) || names.has(name.toLowerCase())) continue;
    list.push({ id, name });
    ids.add(id);
    names.add(name.toLowerCase());
    added += 1;
  }
  return { list, added };
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Coerce a header list to canonical { id, name, value, enabled } rows. */
function normalizeHeaderRows(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const h of input) {
    if (!h || typeof h !== "object") continue;
    out.push({
      id: h.id ?? newId(),
      name: String(h.name ?? ""),
      value: String(h.value ?? ""),
      enabled: h.enabled !== false,
    });
  }
  return out;
}

/** Count the folders and requests in a node subtree (for stats / new subtrees). */
function countNodes(node) {
  let folders = 0;
  let requests = 0;
  const visit = (n) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "request") {
      requests += 1;
    } else if (n.type === "collection") {
      folders += 1;
      for (const child of n.children ?? []) visit(child);
    }
  };
  visit(node);
  return { folders, requests };
}

/** A fresh id for an environment the archive didn't carry one for (defensive). */
function newId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `env-${Math.floor(Math.random() * 1e9).toString(36)}`
  );
}
