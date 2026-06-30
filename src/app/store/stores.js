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
 * stores.js — Factory that wires all filesystem store implementations together.
 *
 * All stores share a single Paths instance and a single Resolver cache so that
 * cache invalidations made by one store (e.g. CollectionsStore.saveCollections)
 * are immediately visible to others (e.g. RequestStore.getRequest).
 *
 * Usage:
 *
 *   const { Stores } = require('./store/stores');
 *   const ss = new Stores(app.getPath('userData'));
 *
 *   ipcMain.handle('store:manifest:get', () => ss.collectionStore().getManifest());
 *   ipcMain.handle('store:requests:get', (_e, id) => ss.requestStore().getRequest(id));
 *   ...
 */
"use strict";

const io = require("./io");
const { Paths } = require("./paths");
const { Resolver } = require("./resolver");
const { SecretStorage } = require("./secret-storage");
const { CollectionRepository } = require("./collection-repository");
const { CollectionStore } = require("./collection-store");
const { CollectionsStore } = require("./collections-store");
const { TreeStore } = require("./tree-store");
const { RequestStore } = require("./request-store");
const { HistoryStore } = require("./history-store");
const { EnvironmentStore } = require("./environment-store");
const { CookieStore } = require("./cookie-store");
const { BackupStore } = require("./backup");

/**
 * Merge two raw variable lists ([{ name, value, secure }]) by name; entries in
 * `overlay` win a name clash. Used to fold a collection's variables onto its
 * Global set (collection wins). Operates on raw (possibly-encrypted) values.
 *
 * @param {Array|undefined} base
 * @param {Array|undefined} overlay
 * @returns {Array}
 */
function mergeVarsRaw(base, overlay) {
  const byName = new Map();
  for (const v of Array.isArray(base) ? base : []) {
    if (v && typeof v === "object" && v.name) byName.set(v.name, v);
  }
  for (const v of Array.isArray(overlay) ? overlay : []) {
    if (v && typeof v === "object" && v.name) byName.set(v.name, v);
  }
  return [...byName.values()];
}

class Stores {
  /**
   * @param {string} dataDir  Root data directory (e.g. app.getPath('userData')).
   */
  constructor(dataDir) {
    this._paths = new Paths(dataDir);
    this._resolver = new Resolver(this._paths);

    // Resolve the secret-storage backend and configure crypto BEFORE any store is
    // built — the very first manifest read decrypts settings, so the active mode
    // and keys must be in place first (and resolving the mode must never touch the
    // keystore, so it can't trigger the macOS keychain prompt). On a fresh config
    // the mode is inferred from existing ciphertext and persisted.
    this._secretStorage = new SecretStorage(this._paths);
    this._secretStorage.bootstrap();

    // Sweep orphaned temp files left by any prior crashed write before stores run.
    io.gcOrphanTempFiles(this._paths.dataDir);

    // Single owner of the per-collection file layout (request files for now);
    // shared so CollectionsStore and RequestStore read/write them one way.
    this._repository = new CollectionRepository(this._paths);

    this._collectionStore = new CollectionStore(this._paths, this._resolver);
    this._collectionsStore = new CollectionsStore(
      this._paths,
      this._resolver,
      this._repository,
    );
    this._treeStore = new TreeStore(this._paths, this._resolver);
    // History store is built before the request store so the latter can cascade
    // history deletion when a request is removed.
    this._historyStore = new HistoryStore(this._paths, this._resolver);
    this._requestStore = new RequestStore(
      this._paths,
      this._resolver,
      this._historyStore,
      this._repository,
    );
    this._environmentStore = new EnvironmentStore(this._paths);
    this._cookieStore = new CookieStore(this._paths);
    this._backupStore = new BackupStore(this._paths, this._resolver);

    // Reclaim any response payload written without its history entry (a crash
    // between HistoryStore.addHistory's two writes leaves one stranded and
    // invisible to every list/get/delete path). Best-effort — never block
    // startup on a sweep error.
    try {
      this._historyStore.pruneOrphanResponses();
    } catch {
      // ignore — orphan cleanup is non-critical
    }

    // One-time relocation of the legacy workspace-wide environments file into
    // each collection's own environments.json (environments are now scoped per
    // collection). Best-effort — never block startup on a migration error.
    try {
      this._migrateLegacyEnvironments();
    } catch (err) {
      console.warn(
        `[store] legacy environments migration skipped: ${err.message}`,
      );
    }

    // Fold each collection's own variables into its Global environment
    // (collection-level variables were removed — Global is the collection-wide
    // tier now). Runs AFTER the env relocation above so a legacy workspace set is
    // seeded into Global first and the collection's vars then layer on top.
    // Best-effort — never block startup on a migration error.
    try {
      this._foldCollectionVarsIntoGlobal();
    } catch (err) {
      console.warn(`[store] collection-variable fold skipped: ${err.message}`);
    }
  }

  /**
   * Relocate the legacy single workspace environments file
   * (environments/index.json) into per-collection environments.json files.
   *
   * Environments used to be workspace-global; they are now scoped per
   * collection. On the first launch after that change, every existing
   * collection receives an identical copy of the old set (Global + named
   * environments + active selection), after which they diverge independently.
   *
   * Idempotent and crash-safe:
   *   - Copies the legacy file's RAW contents (ciphertext preserved — no
   *     decrypt/re-encrypt round-trip that a transient keystore failure could
   *     turn into a blanked secret; the ciphertext is machine-bound and stays
   *     valid in place).
   *   - Skips any collection that already has its own environments.json, so a
   *     partial run resumes safely and an edited per-collection set is never
   *     clobbered.
   *   - Retires the legacy file (→ index.json.migrated) only once every
   *     collection has been seeded, so the trigger survives a mid-run crash.
   *   - No collections yet → leaves the legacy file for a later boot.
   */
  _migrateLegacyEnvironments() {
    const legacyPath = this._paths.environmentsPath();
    const legacy = io.readJSON(legacyPath);
    if (
      legacy === null ||
      typeof legacy !== "object" ||
      Array.isArray(legacy)
    ) {
      return; // no legacy file (already migrated / fresh install)
    }

    const manifest = this._collectionStore.getManifest();
    const collections = Array.isArray(manifest?.collections)
      ? manifest.collections
      : [];
    if (collections.length === 0) {
      return; // no collections to seed yet — retry on a later boot
    }

    for (const coll of collections) {
      if (!coll || !io.isValidID(coll.id)) continue;
      const dest = this._paths.environmentsFile(coll.id);
      if (io.exists(dest)) continue; // already seeded — never clobber
      io.ensureDir(this._paths.collectionDir(coll.id));
      io.writeJSON(dest, legacy);
    }

    // Every collection seeded — retire the legacy file so this never runs again.
    const migratedPath = `${legacyPath}.migrated`;
    io.remove(migratedPath); // best-effort clear of any prior partial
    io.move(legacyPath, migratedPath);
  }

  /**
   * Fold each collection's own variables (`metadata.variables`) into that
   * collection's Global environment, then clear them.
   *
   * Collection-level variables were removed: the per-collection Global
   * environment is now the collection-wide variable tier. On the first launch
   * after that change every collection's variables move into its Global set; the
   * collection variable wins a name clash (it previously outranked Global).
   *
   * Reads/writes RAW ciphertext (the at-rest encrypted form is machine-bound and
   * identical between the metadata and environment scopes — the encrypt kind/id
   * is log context only — so no decrypt/re-encrypt round-trip is needed and a
   * transient keystore failure can't blank a secret).
   *
   * Idempotent and self-healing: a collection whose `metadata.variables` is
   * already empty is skipped, so re-runs are no-ops and any later stray
   * collection variable (e.g. from an old-format import) is folded on the next
   * launch.
   */
  _foldCollectionVarsIntoGlobal() {
    const manifest = this._collectionStore.getManifest();
    const collections = Array.isArray(manifest?.collections)
      ? manifest.collections
      : [];

    for (const coll of collections) {
      if (!coll || !io.isValidID(coll.id)) continue;
      const metaPath = this._paths.metadataPath(coll.id);
      const meta = io.readJSON(metaPath);
      if (
        !meta ||
        !Array.isArray(meta.variables) ||
        meta.variables.length === 0
      ) {
        continue; // nothing to fold (already migrated / empty)
      }

      // Merge collection vars into Global, collection winning a name clash.
      const envPath = this._paths.environmentsFile(coll.id);
      const env = io.readJSON(envPath) ?? {
        globalVariables: [],
        activeEnvironmentId: null,
        environments: [],
      };
      env.globalVariables = mergeVarsRaw(env.globalVariables, meta.variables);
      io.ensureDir(this._paths.collectionDir(coll.id));
      io.writeJSON(envPath, env);

      // The collection no longer carries its own variables.
      meta.variables = [];
      io.writeJSON(metaPath, meta);
    }
  }

  /** Manifest store — GET/PUT global collections + settings. */
  collectionStore() {
    return this._collectionStore;
  }

  /**
   * Legacy collection-blob store — assembles / decomposes the old monolithic
   * per-collection JSON so the renderer data-store API stays unchanged.
   */
  collectionsStore() {
    return this._collectionsStore;
  }

  /** Lightweight navigation tree store. */
  treeStore() {
    return this._treeStore;
  }

  /** Granular per-request CRUD store. */
  requestStore() {
    return this._requestStore;
  }

  /** Execution history store (metadata + lazy-loaded response payloads). */
  historyStore() {
    return this._historyStore;
  }

  /** Global + named environment variables store. */
  environmentStore() {
    return this._environmentStore;
  }

  /** Per-collection persistent cookie jar. */
  cookieStore() {
    return this._cookieStore;
  }

  /** Whole-workspace backup export / import store. */
  backupStore() {
    return this._backupStore;
  }

  /** Selectable secret-storage backend (mode config, keys, migration). */
  secretStorage() {
    return this._secretStorage;
  }

  /** Shared Paths instance — the single source of truth for filesystem paths. */
  paths() {
    return this._paths;
  }

  /** Single owner of the per-collection file layout (request files). */
  repository() {
    return this._repository;
  }
}

module.exports = { Stores };
