/**
 * collection-store.js — Manages the global collections manifest.
 *
 * The manifest (collections/index.json) stores the collections list,
 * the active collection ID, and global application settings.
 * It does not contain request data or collection-level variables.
 */
"use strict";

const { readJSON, writeJSON, ensureDir } = require("./io");
const { encryptSettings, decryptSettings } = require("./crypto");

/** Default manifest returned on first run (no file yet). */
const DEFAULT_MANIFEST = Object.freeze({
  version: 2,
  collections: [],
  activeCollectionId: null,
  settings: {},
});

class CollectionStore {
  /**
   * @param {import('./paths').Paths} paths
   */
  constructor(paths) {
    this._paths = paths;
    ensureDir(this._paths.collectionsDir());
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
}

module.exports = { CollectionStore };
