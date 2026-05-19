/**
 * stores.js — Factory that wires all filesystem store implementations together.
 *
 * All stores share a single Paths instance and a single Resolver cache so that
 * cache invalidations made by one store (e.g. EnvironmentStore.saveEnvironment)
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

const { Paths }            = require("./paths");
const { Resolver }         = require("./resolver");
const { CollectionStore }  = require("./collection-store");
const { EnvironmentStore } = require("./environment-store");
const { TreeStore }        = require("./tree-store");
const { RequestStore }     = require("./request-store");
const { HistoryStore }     = require("./history-store");

class Stores {
  /**
   * @param {string} dataDir  Root data directory (e.g. app.getPath('userData')).
   */
  constructor(dataDir) {
    this._paths    = new Paths(dataDir);
    this._resolver = new Resolver(this._paths);
  }

  /** Manifest store — GET/PUT global environments + settings. */
  collectionStore() {
    return new CollectionStore(this._paths);
  }

  /**
   * Legacy environment-blob store — assembles / decomposes the old monolithic
   * per-environment JSON so the renderer data-store API stays unchanged.
   */
  environmentStore() {
    return new EnvironmentStore(this._paths, this._resolver);
  }

  /** Lightweight navigation tree store. */
  treeStore() {
    return new TreeStore(this._paths, this._resolver);
  }

  /** Granular per-request CRUD store. */
  requestStore() {
    return new RequestStore(this._paths, this._resolver);
  }

  /** Execution history store (metadata + lazy-loaded response payloads). */
  historyStore() {
    return new HistoryStore(this._paths, this._resolver);
  }
}

module.exports = { Stores };

