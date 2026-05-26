/**
 * environment-store.js — Manages global + named environment variables.
 *
 * Data is stored in environments/index.json under the userData root.
 * Shape: { version, globalVariables, activeEnvironmentId, environments:[{id,name,variables}] }
 */
"use strict";

const { readJSON, writeJSON, ensureDir } = require("./io");

const DEFAULT_ENVIRONMENTS = Object.freeze({
  version: 1,
  globalVariables: {},
  activeEnvironmentId: null,
  environments: [],
});

class EnvironmentStore {
  /**
   * @param {import('./paths').Paths} paths
   */
  constructor(paths) {
    this._paths = paths;
    ensureDir(this._paths.environmentsDir());
  }

  /**
   * Return the environments data.
   * Returns a safe default when the file does not exist yet.
   *
   * @returns {object}
   */
  getEnvironments() {
    return (
      readJSON(this._paths.environmentsPath()) ?? { ...DEFAULT_ENVIRONMENTS }
    );
  }

  /**
   * Persist the environments data.
   *
   * @param {object} data
   */
  saveEnvironments(data) {
    ensureDir(this._paths.environmentsDir());
    writeJSON(this._paths.environmentsPath(), data);
  }
}

module.exports = { EnvironmentStore };
