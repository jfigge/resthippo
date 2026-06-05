/**
 * quick-access.js — pure helpers for the Favorites / Recents lists.
 *
 * Both lists are stored in `manifest.settings` as arrays of plain entries:
 *
 *     { collectionId, requestId, name, method }
 *
 * They span every collection, so each entry carries the collection it belongs
 * to (the tree only ever holds one collection at a time). These functions are
 * pure — no DOM, no IPC — so the list bookkeeping (dedupe, cap, prune, refresh)
 * can be unit-tested in isolation. The renderer (app.js / tree-view.js) owns the
 * side effects: persisting to settings and pushing the result into the view.
 */

"use strict";

/** Recents are capped to the most-recently-used N requests. */
export const RECENTS_CAP = 10;

/**
 * Build a quick-access entry from a request node and its collection.
 * @param {object} node          — request node (carries id / name / method)
 * @param {string|null} collectionId
 * @returns {{collectionId: string|null, requestId: string, name: string, method: string}}
 */
export function makeEntry(node, collectionId) {
  return {
    collectionId: collectionId ?? null,
    requestId: node?.id,
    name: node?.name ?? "",
    method: node?.method ?? "GET",
  };
}

/**
 * Prepend `entry` to the recents list, newest-first, de-duplicated by
 * requestId, and capped to `cap`. Returns a new array.
 * @param {object[]} list
 * @param {object} entry
 * @param {number} [cap=RECENTS_CAP]
 */
export function addRecent(list, entry, cap = RECENTS_CAP) {
  if (!entry?.requestId) return list;
  const without = (list ?? []).filter((e) => e.requestId !== entry.requestId);
  return [entry, ...without].slice(0, cap);
}

/**
 * Add `entry` to the favorites list if not already present (matched by
 * requestId). Order is insertion order. Returns a new array (or the original
 * when already favorited).
 * @param {object[]} list
 * @param {object} entry
 */
export function addFavorite(list, entry) {
  if (!entry?.requestId) return list ?? [];
  if ((list ?? []).some((e) => e.requestId === entry.requestId)) return list;
  return [...(list ?? []), entry];
}

/**
 * @param {object[]} list
 * @param {string} requestId
 * @returns {boolean} true when an entry with `requestId` exists.
 */
export function hasId(list, requestId) {
  return (list ?? []).some((e) => e.requestId === requestId);
}

/**
 * Drop every entry whose requestId is in `idSet`. Returns the same array
 * reference when nothing changed so callers can skip a needless persist.
 * @param {object[]} list
 * @param {Set<string>} idSet
 */
export function removeIds(list, idSet) {
  if (!list?.length || !idSet?.size) return list ?? [];
  const next = list.filter((e) => !idSet.has(e.requestId));
  return next.length === list.length ? list : next;
}

/**
 * Drop every entry belonging to `collectionId` (used when a whole collection is
 * deleted). Returns the same array reference when nothing changed.
 * @param {object[]} list
 * @param {string} collectionId
 */
export function removeCollection(list, collectionId) {
  if (!list?.length) return list ?? [];
  const next = list.filter((e) => e.collectionId !== collectionId);
  return next.length === list.length ? list : next;
}

/**
 * Reconcile entries for a single collection against its live requests:
 *   - refresh cached name / method from `liveMap` (handles rename / method change)
 *   - drop entries whose request no longer exists (handles deletion)
 * Entries belonging to other collections are left untouched. Returns the same
 * array reference when nothing changed.
 *
 * @param {object[]} list
 * @param {string} collectionId
 * @param {Map<string,{name: string, method: string}>} liveMap
 */
export function reconcile(list, collectionId, liveMap) {
  if (!list?.length) return list ?? [];
  let changed = false;
  const next = [];
  for (const entry of list) {
    if (entry.collectionId !== collectionId) {
      next.push(entry);
      continue;
    }
    const live = liveMap?.get(entry.requestId);
    if (!live) {
      changed = true; // dropped — request no longer exists
      continue;
    }
    if (live.name !== entry.name || live.method !== entry.method) {
      changed = true;
      next.push({ ...entry, name: live.name, method: live.method });
    } else {
      next.push(entry);
    }
  }
  return changed ? next : list;
}
