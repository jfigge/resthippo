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
