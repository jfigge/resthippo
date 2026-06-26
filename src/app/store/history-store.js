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

/**
 * history-store.js — Request execution history with lazy-loaded response payloads.
 *
 * Layout:
 *   collections/<collId>/history/<reqId>/<histId>.json   ← lightweight entry metadata
 *   collections/<collId>/responses/<reqId>/<histId>.json ← full response payload
 *
 * Separation of metadata from response bodies keeps list operations fast
 * regardless of how large the response bodies are.
 *
 * Pagination is cursor-based: the cursor is the opaque ID of the last entry
 * already consumed. An empty cursor starts from the most recent entry.
 */
"use strict";

const path = require("path");
const {
  readJSON,
  writeJSON,
  ensureDir,
  validateID,
  newUUID,
  notFoundError,
  remove,
  listDir,
  exists,
} = require("./io");

/** Maximum allowed page size. */
const MAX_LIMIT = 100;
/** Default page size when caller omits limit. */
const DEFAULT_LIMIT = 20;

/**
 * Newest-first comparator with a stable secondary key on `id`. Two entries that
 * share a `timestamp` (same-millisecond executions) would otherwise sort in
 * readdir order, which is OS-dependent and can differ between calls — so
 * cursor pagination could skip or repeat an entry at a page boundary, and
 * `_trimRequest` could drop a different entry than `listHistory` pages past.
 * Tiebreaking on the unique id makes the order deterministic and keeps the two
 * call sites in lockstep.
 *
 * @param {{ timestamp?: string, id?: string }} a
 * @param {{ timestamp?: string, id?: string }} b
 * @returns {number}
 */
function byNewestFirst(a, b) {
  const ta = a.timestamp ?? "";
  const tb = b.timestamp ?? "";
  if (tb !== ta) return tb > ta ? 1 : -1;
  const ia = a.id ?? "";
  const ib = b.id ?? "";
  return ib > ia ? 1 : ib < ia ? -1 : 0;
}

class HistoryStore {
  /**
   * @param {import('./paths').Paths}       paths
   * @param {import('./resolver').Resolver} resolver
   */
  constructor(paths, resolver) {
    this._paths = paths;
    this._resolver = resolver;
  }

  // ── List (paginated) ────────────────────────────────────────────────────────

  /**
   * Return a cursor-paginated page of history entries for `requestId`,
   * ordered newest-first.
   *
   * @param {string} requestId
   * @param {object} [options]
   * @param {number} [options.limit=20]   Max entries per page (1–100)
   * @param {string} [options.cursor=""]  Opaque cursor from a previous page's nextCursor
   * @returns {{ items: object[], nextCursor: string }}
   */
  listHistory(requestId, options = {}) {
    validateID(requestId, "requestId");
    const collId = this._resolver.resolve(requestId);

    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, options.limit ?? DEFAULT_LIMIT),
    );
    const cursor = options.cursor ?? "";

    const histDir = this._paths.historyDir(collId, requestId);
    if (!exists(histDir)) {
      return { items: [], nextCursor: "" };
    }

    // Load all entry files.
    const files = listDir(histDir).filter((f) => f.endsWith(".json"));

    const entries = [];
    for (const file of files) {
      const data = readJSON(path.join(histDir, file));
      if (data !== null) entries.push(data);
    }

    // Sort newest-first (ISO timestamps compare lexicographically), with a
    // stable id tiebreak so paging is deterministic across calls.
    entries.sort(byNewestFirst);

    // Apply cursor: skip everything up to and including the cursor entry.
    let startIdx = 0;
    if (cursor) {
      const idx = entries.findIndex((e) => e.id === cursor);
      startIdx = idx >= 0 ? idx + 1 : 0;
    }

    const page = entries.slice(startIdx, startIdx + limit);

    // nextCursor = ID of the last item in this page (empty = no more pages).
    let nextCursor = "";
    if (startIdx + limit < entries.length && page.length > 0) {
      nextCursor = page[page.length - 1].id;
    }

    return { items: page, nextCursor };
  }

  // ── Add ─────────────────────────────────────────────────────────────────────

  /**
   * Record a new execution.
   * Assigns `id` and `timestamp` if they are absent.
   * The response payload is written before the entry metadata so that, on a
   * crash between the two writes, only an orphaned response file exists
   * (invisible to list operations).
   *
   * @param {string} requestId
   * @param {object} entry     Execution metadata: { status, durationMs, responseSize, … }
   * @param {object} [response] Full response: { headers, body, contentType, … }
   * @returns {object}         The entry as stored (with id + timestamp assigned)
   */
  addHistory(requestId, entry, response) {
    validateID(requestId, "requestId");
    const collId = this._resolver.resolve(requestId);

    const id = entry.id || newUUID();
    const timestamp = entry.timestamp || new Date().toISOString();
    entry = { ...entry, id, timestamp, requestId };
    validateID(entry.id, "historyId");

    // Write response first (so the entry never references a missing response).
    if (response) {
      ensureDir(this._paths.responsesDir(collId, requestId));
      writeJSON(this._paths.responsePath(collId, requestId, entry.id), {
        ...response,
        historyId: entry.id,
        requestId,
      });
    }

    ensureDir(this._paths.historyDir(collId, requestId));
    writeJSON(this._paths.historyEntryPath(collId, requestId, entry.id), entry);

    return entry;
  }

  // ── Get response (lazy) ─────────────────────────────────────────────────────

  /**
   * Retrieve the full response payload for one history entry.
   *
   * @param {string} requestId
   * @param {string} historyId
   * @returns {object} Response payload
   * @throws code="NOT_FOUND"
   */
  getHistoryResponse(requestId, historyId) {
    validateID(requestId, "requestId");
    validateID(historyId, "historyId");
    const collId = this._resolver.resolve(requestId);
    const data = readJSON(
      this._paths.responsePath(collId, requestId, historyId),
    );
    if (data === null) {
      throw notFoundError(`history response not found: ${historyId}`);
    }
    return data;
  }

  // ── Delete ──────────────────────────────────────────────────────────────────

  /**
   * Permanently delete a history entry and its response payload.
   * Silently ignores missing files.
   *
   * @param {string} requestId
   * @param {string} historyId
   */
  deleteHistory(requestId, historyId) {
    validateID(requestId, "requestId");
    validateID(historyId, "historyId");
    const collId = this._resolver.resolve(requestId);

    const respPath = this._paths.responsePath(collId, requestId, historyId);
    const entryPath = this._paths.historyEntryPath(
      collId,
      requestId,
      historyId,
    );

    remove(respPath);
    remove(entryPath);
  }

  // ── Clear ─────────────────────────────────────────────────────────────────

  /**
   * Permanently delete ALL history entries and response payloads for a request
   * by removing its history and response directories outright.
   * Silently ignores missing directories.
   *
   * @param {string} requestId
   */
  clearHistory(requestId) {
    validateID(requestId, "requestId");
    const collId = this._resolver.resolve(requestId);

    const histDir = this._paths.historyDir(collId, requestId);
    const respDir = this._paths.responsesDir(collId, requestId);

    remove(histDir);
    remove(respDir);
  }

  // ── Trim ────────────────────────────────────────────────────────────────────

  /**
   * Delete the oldest history entries (and their response payloads) for a single
   * request, keeping at most `max` entries.  Skips silently if the directory
   * does not exist or cannot be read.
   *
   * @param {string} collId
   * @param {string} reqId
   * @param {number} max
   */
  _trimRequest(collId, reqId, max) {
    const histDir = this._paths.historyDir(collId, reqId);
    if (!exists(histDir)) return;

    const files = listDir(histDir).filter((f) => f.endsWith(".json"));

    const entries = [];
    for (const file of files) {
      const data = readJSON(path.join(histDir, file));
      if (data?.id) entries.push(data);
    }

    // Sort newest-first — matches listHistory order so we drop the same entries.
    entries.sort(byNewestFirst);

    for (let i = max; i < entries.length; i++) {
      const e = entries[i];
      remove(this._paths.responsePath(collId, reqId, e.id));
      remove(this._paths.historyEntryPath(collId, reqId, e.id));
    }
  }

  /**
   * Trim history across every request in every collection to at most maxEntries.
   * Sweeps all on-disk history directories — covers requests whose history has
   * never been loaded into the renderer's in-memory map.
   *
   * @param {number} maxEntries  Maximum entries to retain per request (0 = delete all)
   */
  trimAllHistory(maxEntries) {
    const max = Math.max(0, maxEntries);
    const collectionsDir = this._paths.collectionsDir();

    const collIds = listDir(collectionsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);

    for (const collId of collIds) {
      const historyBase = path.join(
        this._paths.collectionDir(collId),
        "history",
      );
      for (const entry of listDir(historyBase, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        this._trimRequest(collId, entry.name, max);
      }
    }
  }

  // ── Prune orphaned responses ────────────────────────────────────────────────

  /**
   * Remove orphaned response payloads — response files with no matching history
   * entry. `addHistory` writes the response *before* its entry, so a crash
   * between those two writes leaves a response file that no `listHistory` or
   * `getHistoryResponse` can ever reach (and which `deleteHistory`/`clearHistory`
   * therefore never reclaim). Swept once at startup so the response tree cannot
   * accumulate invisible payloads across crashed writes. Best-effort: skips
   * missing directories.
   *
   * @returns {number}  Count of orphaned response files removed.
   */
  pruneOrphanResponses() {
    let removed = 0;
    const collectionsDir = this._paths.collectionsDir();
    if (!exists(collectionsDir)) return 0;

    const collIds = listDir(collectionsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);

    for (const collId of collIds) {
      const responsesBase = path.join(
        this._paths.collectionDir(collId),
        "responses",
      );
      if (!exists(responsesBase)) continue;
      for (const entry of listDir(responsesBase, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const reqId = entry.name;
        for (const file of listDir(this._paths.responsesDir(collId, reqId))) {
          if (!file.endsWith(".json")) continue;
          const histId = file.slice(0, -5);
          if (!exists(this._paths.historyEntryPath(collId, reqId, histId))) {
            remove(this._paths.responsePath(collId, reqId, histId));
            removed++;
          }
        }
      }
    }
    return removed;
  }
}

module.exports = { HistoryStore };
