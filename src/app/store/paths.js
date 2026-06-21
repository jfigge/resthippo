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
 * paths.js — Single source of truth for all filesystem paths in the storage layer.
 *
 * Layout (rooted at `dataDir`):
 *
 *   collections/
 *     index.json                         ← global manifest (collections, settings)
 *     <collectionId>/
 *       metadata.json                    ← collection id + collection-level variables
 *       tree.json                        ← lightweight nav tree (no request bodies)
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
