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
