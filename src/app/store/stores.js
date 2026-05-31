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
const { CollectionStore } = require("./collection-store");
const { CollectionsStore } = require("./collections-store");
const { TreeStore } = require("./tree-store");
const { RequestStore } = require("./request-store");
const { HistoryStore } = require("./history-store");
const { EnvironmentStore } = require("./environment-store");

class Stores {
  /**
   * @param {string} dataDir  Root data directory (e.g. app.getPath('userData')).
   */
  constructor(dataDir) {
    this._paths = new Paths(dataDir);
    this._resolver = new Resolver(this._paths);

    // Sweep orphaned temp files left by any prior crashed write before stores run.
    io.gcOrphanTempFiles(this._paths.dataDir);

    this._collectionStore = new CollectionStore(this._paths);
    this._collectionsStore = new CollectionsStore(this._paths, this._resolver);
    this._treeStore = new TreeStore(this._paths, this._resolver);
    this._requestStore = new RequestStore(this._paths, this._resolver);
    this._historyStore = new HistoryStore(this._paths, this._resolver);
    this._environmentStore = new EnvironmentStore(this._paths);
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
}

module.exports = { Stores };
