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
 * Merge an archive's items into a target tree (the active collection's items).
 * Returns a NEW items array (inputs are not mutated) plus create/replace counts.
 *
 * @param {object[]} targetItems   Current tree nodes.
 * @param {object[]} archiveItems  Nodes from the archive.
 * @returns {{ items: object[], created: number, replaced: number }}
 */
export function mergeArchiveIntoTree(targetItems, archiveItems) {
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
        const existing = result[idx];
        const sub = mergeArchiveIntoTree(
          existing.children ?? [],
          node.children ?? [],
        );
        result[idx] = { ...existing, children: sub.items };
        created += sub.created;
        replaced += sub.replaced;
      } else {
        result.push(structuredClone(node));
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
