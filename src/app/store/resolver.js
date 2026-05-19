/**
 * resolver.js — In-memory requestID → collectionID cache.
 *
 * The cache is built lazily by scanning collections/ * /requests/*.json.
 * Incremental updates (set/remove) keep the cache consistent without a full
 * rebuild on every write.  invalidate() forces a rebuild on the next resolve().
 */
"use strict";

const fs = require("fs");

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
      const err = new Error(`request not found: ${requestId}`);
      err.code = "NOT_FOUND";
      throw err;
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
    if (!fs.existsSync(collectionsDir)) return;

    let entries;
    try {
      entries = fs.readdirSync(collectionsDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const collId  = entry.name;
      const reqsDir = this._paths.requestsDir(collId);
      if (!fs.existsSync(reqsDir)) continue;

      let files;
      try {
        files = fs.readdirSync(reqsDir);
      } catch {
        continue;
      }

      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        this._cache.set(file.slice(0, -5), collId);
      }
    }
  }
}

module.exports = { Resolver };

