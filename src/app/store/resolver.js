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
 * resolver.js — In-memory requestID → collectionID cache.
 *
 * The cache is built lazily by scanning collections/ * /requests/*.json.
 * Incremental updates (set/remove) keep the cache consistent without a full
 * rebuild on every write.  invalidate() forces a rebuild on the next resolve().
 *
 * A request file should live in exactly one collection. If the same requestID
 * is found in two collections (a merged backup, a hand-copied directory), the
 * rebuild resolves it deterministically to the lexicographically-first
 * collection, records it in duplicates(), and warns — rather than silently
 * routing reads/writes to whichever directory the filesystem listed last.
 *
 * The scan is restricted to the collections the manifest (collections/index.json)
 * actually lists. The on-disk directory set can include ORPHANS — e.g. a default
 * collection that a previous session seeded but never persisted to the manifest,
 * or a hand-copied directory — and those hold the same request IDs as the live
 * collection. Scanning them would make every request resolve ambiguously and warn
 * on every startup. The manifest is the source of truth for which collections
 * exist, so orphan directories are skipped. (When there is no manifest at all —
 * a true pre-seed first run — the scan falls back to every directory so a store
 * built before the manifest still resolves.)
 */
"use strict";

const { listDir, readJSON, notFoundError } = require("./io");

class Resolver {
  /**
   * @param {import('./paths').Paths} paths
   */
  constructor(paths) {
    this._paths = paths;
    /** @type {Map<string, string>|null} null = rebuild required */
    this._cache = null;
    /**
     * Request IDs found in more than one collection as of the last rebuild,
     * each mapped to the colliding collection IDs (sorted; [0] is the resolved
     * owner). Empty for a consistent store. See _rebuild().
     * @type {Map<string, string[]>}
     */
    this._duplicates = new Map();
  }

  /**
   * Returns the collectionID that owns the given requestID.
   *
   * @param {string} requestId
   * @returns {string} collectionId
   * @throws {Error} code="NOT_FOUND" if the request is unknown
   */
  resolve(requestId) {
    this._ensure();
    const collId = this._cache.get(requestId);
    if (!collId) {
      throw notFoundError(`request not found: ${requestId}`);
    }
    return collId;
  }

  /**
   * Incrementally add or update a requestID → collectionID mapping.
   * Call after CreateRequest.
   *
   * @param {string} requestId
   * @param {string} collectionId
   */
  set(requestId, collectionId) {
    this._ensure();
    this._cache.set(requestId, collectionId);
  }

  /**
   * Incrementally remove a mapping.
   * Call after DeleteRequest.
   *
   * @param {string} requestId
   */
  remove(requestId) {
    if (this._cache) this._cache.delete(requestId);
  }

  /**
   * Force a full cache rebuild on the next resolve/set call.
   * Call after any bulk write (e.g. SaveEnvironment) that may have changed
   * the request → collection mapping for many requests at once.
   */
  invalidate() {
    this._cache = null;
  }

  /**
   * Request IDs that resolve ambiguously because the same request file exists in
   * more than one collection directory — as of the last rebuild. Each maps to the
   * colliding collection IDs (sorted; [0] is the one resolve() returns). Empty for
   * a consistent store. A duplicate normally means a backup was merged or a
   * collection directory was hand-copied; the extra copies should be removed.
   * Returns a copy so callers can't mutate the resolver's state.
   *
   * @returns {Map<string, string[]>}
   */
  duplicates() {
    this._ensure();
    return new Map(this._duplicates);
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  _ensure() {
    if (this._cache) return;
    this._cache = new Map();
    this._duplicates = new Map();
    this._rebuild();
  }

  _rebuild() {
    const collectionsDir = this._paths.collectionsDir();

    // The manifest is the source of truth for which collections exist; restrict
    // the scan to its ids so orphan directories (a seeded-but-unpersisted
    // default, a hand-copied dir) can't pollute resolution. null = no manifest
    // yet → scan every directory (legacy/pre-seed fallback). See the file header.
    const manifest = readJSON(this._paths.manifestPath());
    const validIds =
      manifest && Array.isArray(manifest.collections)
        ? new Set(manifest.collections.map((c) => c && c.id).filter(Boolean))
        : null;

    // Scan collections in a STABLE (sorted) order. readdir order is filesystem-
    // dependent, so without sorting a request that exists in two collections
    // (e.g. after a merged backup or a hand-copied directory) would resolve to
    // whichever the OS happened to list last — nondeterministically. Sorting
    // makes the lexicographically-first collection the deterministic owner.
    const collIds = listDir(collectionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => validIds === null || validIds.has(name))
      .sort();

    // reqId → every collection containing a file for it, so a request present in
    // two collections is detected rather than silently overwritten.
    const owners = new Map();
    for (const collId of collIds) {
      for (const file of listDir(this._paths.requestsDir(collId))) {
        if (!file.endsWith(".json")) continue;
        const reqId = file.slice(0, -5);
        if (reqId.length === 0) continue;
        const list = owners.get(reqId);
        if (list) list.push(collId);
        else owners.set(reqId, [collId]);
      }
    }

    for (const [reqId, list] of owners) {
      // First (lexicographically-smallest) collection wins, deterministically.
      this._cache.set(reqId, list[0]);
      if (list.length > 1) {
        this._duplicates.set(reqId, list);
        // Surface the inconsistency (teed to the log file by the main process's
        // console capture) without throwing — the store must still load.
        console.warn(
          `[resolver] request "${reqId}" exists in ${list.length} collections ` +
            `(${list.join(", ")}); resolving to "${list[0]}". This usually means ` +
            `a backup was merged or a collection directory was copied — remove ` +
            `the duplicate copies to make resolution unambiguous.`,
        );
      }
    }
  }
}

module.exports = { Resolver };
