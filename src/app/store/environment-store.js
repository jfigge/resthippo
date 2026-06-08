/**
 * environment-store.js — Manages global + named environment variables.
 *
 * Data is stored in environments/index.json under the userData root.
 * Shape: { globalVariables, activeEnvironmentId, environments:[{id,name,variables}] }
 * Variable collections (globalVariables, each environment's variables) are the
 * canonical array shape: [{ name, value, secure }].
 */
"use strict";

const { readJSON, writeJSON, ensureDir } = require("./io");
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
   * Return the environments data.
   * Returns a safe default when the file does not exist yet.
   *
   * @returns {object}
   */
  getEnvironments() {
    const data = readJSON(this._paths.environmentsPath());
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
   * Persist the environments data.
   *
   * Secure variable values (globalVariables + each environment's variables) are
   * encrypted at rest. The on-disk document is read first so the clobber guard
   * can restore still-recoverable ciphertext for any secure value the caller
   * left blank because it had failed to decrypt — a transient keystore failure
   * must never wipe a secret.
   *
   * @param {object} data
   */
  saveEnvironments(data) {
    ensureDir(this._paths.environmentsDir());

    const existing = readJSON(this._paths.environmentsPath()) ?? {};
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

    writeJSON(this._paths.environmentsPath(), out);
  }
}

module.exports = { EnvironmentStore };
