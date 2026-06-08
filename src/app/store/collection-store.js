/**
 * collection-store.js — Manages the global collections manifest.
 *
 * The manifest (collections/index.json) stores the collections list,
 * the active collection ID, and global application settings.
 * It does not contain request data or collection-level variables.
 */
"use strict";

const { readJSON, writeJSON, ensureDir, validateID, remove } = require("./io");
const { encryptSettings, decryptSettings } = require("./crypto");

/** Default manifest returned on first run (no file yet). */
const DEFAULT_MANIFEST = Object.freeze({
  collections: [],
  activeCollectionId: null,
  settings: {},
});

class CollectionStore {
  /**
   * @param {import('./paths').Paths}       paths
   * @param {import('./resolver').Resolver} resolver
   *   Shared resolver cache, invalidated when a collection is deleted so stale
   *   request→collection mappings cannot resolve to the removed collection.
   */
  constructor(paths, resolver) {
    this._paths = paths;
    this._resolver = resolver;
  }

  /**
   * Return the global manifest.
   * Returns a safe default when the manifest file does not exist yet.
   *
   * @returns {object}
   */
  getManifest() {
    const data = readJSON(this._paths.manifestPath());
    const manifest = data ?? { ...DEFAULT_MANIFEST };
    if (manifest.settings)
      manifest.settings = decryptSettings(manifest.settings);
    return manifest;
  }

  /**
   * Atomically persist the global manifest.
   * Settings secrets (e.g. proxyUrl) are encrypted before writing.
   *
   * @param {object} data
   */
  saveManifest(data) {
    ensureDir(this._paths.collectionsDir());
    const toWrite = data.settings
      ? { ...data, settings: encryptSettings(data.settings) }
      : data;
    writeJSON(this._paths.manifestPath(), toWrite);
  }

  /**
   * Permanently delete a collection's entire on-disk directory — metadata, tree,
   * cookies, and every request, history entry, and response payload beneath it —
   * then invalidate the resolver so cached request→collection mappings for the
   * removed collection are dropped.
   *
   * The manifest is the source of truth for which collections exist; the caller
   * is responsible for removing the collection from it (saveManifest). This only
   * reclaims the backing files. A missing directory is not an error
   * (best-effort, idempotent).
   *
   * @param {string} collectionId
   */
  deleteCollection(collectionId) {
    validateID(collectionId, "collectionId");
    remove(this._paths.collectionDir(collectionId));
    this._resolver.invalidate();
  }
}

module.exports = { CollectionStore };
