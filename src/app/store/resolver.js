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
 */
"use strict";

const { listDir, notFoundError } = require("./io");

class Resolver {
  /**
   * @param {import('./paths').Paths} paths
   */
  constructor(paths) {
    this._paths = paths;
    /** @type {Map<string, string>|null} null = rebuild required */
    this._cache = null;
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

  // ── Private helpers ─────────────────────────────────────────────────────────

  _ensure() {
    if (this._cache) return;
    this._cache = new Map();
    this._rebuild();
  }

  _rebuild() {
    const collectionsDir = this._paths.collectionsDir();

    for (const entry of listDir(collectionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const collId = entry.name;
      const reqsDir = this._paths.requestsDir(collId);

      for (const file of listDir(reqsDir)) {
        if (!file.endsWith(".json")) continue;
        const reqId = file.slice(0, -5);
        if (reqId.length === 0) continue;
        this._cache.set(reqId, collId);
      }
    }
  }
}

module.exports = { Resolver };
