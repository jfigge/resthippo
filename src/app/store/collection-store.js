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
 * collection-store.js — Manages the global collections manifest.
 *
 * The manifest (collections/index.json) stores the collections list,
 * the active collection ID, and global application settings.
 * It does not contain request data or collection-level variables.
 */
"use strict";

const { readJSON, writeJSON, ensureDir, validateID, remove } = require("./io");
const {
  encryptSettings,
  decryptSettings,
  restoreUndecryptableSettings,
} = require("./crypto");

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
    // Build a fresh default (not a shallow spread of the frozen template, whose
    // nested `collections`/`settings` would be shared frozen references).
    const manifest = data ?? {
      collections: [],
      activeCollectionId: null,
      settings: {},
    };
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
    let toWrite = data;
    if (data.settings) {
      let settings = encryptSettings(data.settings);
      // Anti-clobber: preserve on-disk secret ciphertext that the incoming data
      // blanked because it could not be decrypted on read (a locked
      // master-password session, or a transient keystore failure). Without this,
      // an unrelated settings change made while secrets are unreadable would wipe
      // them. Mirrors the request/variable guards.
      const existing = readJSON(this._paths.manifestPath());
      settings = restoreUndecryptableSettings(
        settings,
        data.settings,
        existing?.settings,
      );
      toWrite = { ...data, settings };
    }
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
