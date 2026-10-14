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
 * environment-store.js — Manages a collection's global + named environment
 * variables.
 *
 * Environments are scoped per collection: each collection's set lives in
 * collections/<collectionId>/environments.json (so switching the active
 * collection switches its environments + active selection + Global vars).
 * Shape: { globalVariables, activeEnvironmentId, environments:[{id,name,variables}] }
 * Variable collections (globalVariables, each environment's variables) are the
 * canonical array shape: [{ name, value, secure }].
 */
"use strict";

const { readJSON, writeJSON, ensureDir, validateID } = require("./io");
const {
  encryptVariables,
  decryptVariables,
  restoreUndecryptableVariables,
} = require("./crypto");

const DEFAULT_ENVIRONMENTS = Object.freeze({
  globalVariables: [],
  activeEnvironmentId: null,
  environments: [],
});

class EnvironmentStore {
  /**
   * @param {import('./paths').Paths} paths
   */
  constructor(paths) {
    this._paths = paths;
  }

  /**
   * Return a collection's environments data.
   * Returns a safe default when the file does not exist yet.
   *
   * @param {string} collId  Collection ID
   * @returns {object}
   */
  getEnvironments(collId) {
    validateID(collId, "collectionId");
    const data = readJSON(this._paths.environmentsFile(collId));
    if (!data || typeof data !== "object") return { ...DEFAULT_ENVIRONMENTS };
    return {
      ...data,
      globalVariables: decryptVariables(
        data.globalVariables,
        "globalVariables",
        null,
      ),
      environments: Array.isArray(data.environments)
        ? data.environments.map((env) =>
            env && typeof env === "object"
              ? {
                  ...env,
                  variables: decryptVariables(
                    env.variables,
                    "environment",
                    env.id,
                  ),
                }
              : env,
          )
        : data.environments,
    };
  }

  /**
   * Persist a collection's environments data.
   *
   * Secure variable values (globalVariables + each environment's variables) are
   * encrypted at rest. The on-disk document is read first so the clobber guard
   * can restore still-recoverable ciphertext for any secure value the caller
   * left blank because it had failed to decrypt — a transient keystore failure
   * must never wipe a secret.
   *
   * @param {string} collId  Collection ID
   * @param {object} data
   */
  saveEnvironments(collId, data) {
    validateID(collId, "collectionId");
    ensureDir(this._paths.collectionDir(collId));

    const existing = readJSON(this._paths.environmentsFile(collId)) ?? {};
    const existingEnvById = new Map();
    for (const env of Array.isArray(existing.environments)
      ? existing.environments
      : []) {
      if (env && typeof env === "object" && env.id != null) {
        existingEnvById.set(env.id, env);
      }
    }

    const out = {
      ...data,
      globalVariables: restoreUndecryptableVariables(
        encryptVariables(data.globalVariables),
        data.globalVariables,
        existing.globalVariables,
      ),
      environments: Array.isArray(data.environments)
        ? data.environments.map((env) => {
            if (!env || typeof env !== "object") return env;
            const prior = existingEnvById.get(env.id);
            return {
              ...env,
              variables: restoreUndecryptableVariables(
                encryptVariables(env.variables),
                env.variables,
                prior ? prior.variables : undefined,
              ),
            };
          })
        : data.environments,
    };

    writeJSON(this._paths.environmentsFile(collId), out);
  }
}

module.exports = { EnvironmentStore };
