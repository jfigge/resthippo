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
 * paths.js — Single source of truth for all filesystem paths in the storage layer.
 *
 * Layout (rooted at `dataDir`):
 *
 *   collections/
 *     index.json                         ← global manifest (collections, settings)
 *     <collectionId>/
 *       metadata.json                    ← collection id + collection-level variables
 *       tree.json                        ← lightweight nav tree (no request bodies)
 *       environments.json                ← this collection's global + named environments
 *       cookies.json                     ← persistent cookie jar (captured Set-Cookie)
 *       requests/
 *         <requestId>.json               ← one file per request
 *       history/
 *         <requestId>/
 *           <historyId>.json             ← execution metadata (no response body)
 *       responses/
 *         <requestId>/
 *           <historyId>.json             ← full response payload (lazy-loaded)
 *
 * Note: "collectionId" was previously called "environmentId" in the legacy API surface.
 */
"use strict";

const path = require("path");

class Paths {
  /**
   * @param {string} dataDir  Root data directory (platform user-data dir or custom).
   */
  constructor(dataDir) {
    this.dataDir = dataDir;
  }

  // ── Top-level ───────────────────────────────────────────────────────────────

  collectionsDir() {
    return path.join(this.dataDir, "collections");
  }

  /** Global manifest: collections list + settings. */
  manifestPath() {
    return path.join(this.collectionsDir(), "index.json");
  }

  /**
   * Legacy workspace-wide environments file (a single set shared by every
   * collection). Environments are now per-collection (see `environmentsFile`);
   * these two remain only so the one-time migration and the legacy-backup reader
   * can still locate the old file.
   */
  environmentsDir() {
    return path.join(this.dataDir, "environments");
  }
  environmentsPath() {
    return path.join(this.dataDir, "environments", "index.json");
  }

  /**
   * Secret-storage mode config (UNENCRYPTED — read at bootstrap before any
   * decrypt, so it must never depend on the keystore). Holds the active mode and,
   * for master-password mode, the PBKDF2 salt + a verifier token.
   */
  secretStorageConfigPath() {
    return path.join(this.dataDir, "secret-storage.json");
  }

  /** App-key file (0600): the random 256-bit key for "app key" storage mode. */
  secretKeyPath() {
    return path.join(this.dataDir, "secret.key");
  }

  /**
   * Scratch directory for response bodies too large to keep in renderer memory.
   * Lives under `dataDir` so the startup orphan-temp sweep recurses into it and
   * reaps any spill files left behind by a previous session.
   */
  responseCacheDir() {
    return path.join(this.dataDir, "response-cache");
  }

  // ── Per-collection paths ────────────────────────────────────────────────────

  collectionDir(collId) {
    return path.join(this.collectionsDir(), collId);
  }

  /** Collection metadata: id + env-level variables. */
  metadataPath(collId) {
    return path.join(this.collectionDir(collId), "metadata.json");
  }

  /** Lightweight navigation tree (folder hierarchy + requestRef IDs). */
  treePath(collId) {
    return path.join(this.collectionDir(collId), "tree.json");
  }

  /** This collection's global + named environment variables. */
  environmentsFile(collId) {
    return path.join(this.collectionDir(collId), "environments.json");
  }

  /** Per-collection cookie jar (captured Set-Cookie state). */
  cookiesPath(collId) {
    return path.join(this.collectionDir(collId), "cookies.json");
  }

  // ── Per-request paths ───────────────────────────────────────────────────────

  requestsDir(collId) {
    return path.join(this.collectionDir(collId), "requests");
  }

  /** Full request definition file. */
  requestPath(collId, reqId) {
    return path.join(this.requestsDir(collId), `${reqId}.json`);
  }

  // ── Per-history-entry paths ─────────────────────────────────────────────────

  historyDir(collId, reqId) {
    return path.join(this.collectionDir(collId), "history", reqId);
  }

  /** Lightweight history entry (no response body). */
  historyEntryPath(collId, reqId, histId) {
    return path.join(this.historyDir(collId, reqId), `${histId}.json`);
  }

  // ── Per-response paths ──────────────────────────────────────────────────────

  responsesDir(collId, reqId) {
    return path.join(this.collectionDir(collId), "responses", reqId);
  }

  /** Full response payload (body, headers) — lazy-loaded. */
  responsePath(collId, reqId, histId) {
    return path.join(this.responsesDir(collId, reqId), `${histId}.json`);
  }
}

module.exports = { Paths };
