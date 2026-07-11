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
 * collection-archive.js — secret handling for the native "Rest Hippo v1"
 * collection archive (export/import of a single collection, with environments).
 *
 * The renderer builds the plaintext archive structure (it holds the decrypted
 * tree + environments already). This main-process module owns the only step the
 * sandboxed renderer cannot do: turning the archive's secret fields into the
 * portable `encp:v2:` ciphertext used by the Backup feature, and back.
 *
 *   - When the archive carries any secret, the export prompts for a password and
 *     `encryptArchiveSecrets` re-encrypts every secret field under it.
 *   - On import `decryptArchiveSecrets` recovers them (or, with no/wrong password,
 *     clears the value while keeping the `secure` flag — the secret is re-entered).
 *
 * It reuses the per-field crypto helpers (`exportRequestSecrets`,
 * `exportVariableSecrets`, …) so the archive secrets are byte-for-byte compatible
 * with backup secrets and the taxonomy of "what is a secret" lives in one place.
 */
"use strict";

const {
  REQUEST_SECRET_PATHS,
  exportRequestSecrets,
  importRequestSecrets,
  exportVariableSecrets,
  importVariableSecrets,
  exportProfileValueSecrets,
  importProfileValueSecrets,
  secureNamesOf,
} = require("./crypto");

/**
 * Does the plaintext archive contain any secret worth password-protecting? A
 * request auth secret with a non-empty value, or a `secure` variable with a
 * non-empty value, anywhere in the items / collection vars / environments.
 *
 * @param {object} archive
 * @returns {boolean}
 */
function archiveHasSecrets(archive) {
  if (!archive || typeof archive !== "object") return false;

  const nodesHaveSecret = (nodes) =>
    (Array.isArray(nodes) ? nodes : []).some((n) => {
      if (!n || typeof n !== "object") return false;
      if (n.type === "request") return requestHasSecret(n);
      if (n.type === "collection")
        return (
          varsHaveSecret(n.variables) ||
          profileValuesHaveSecret(
            n.profileValues,
            secureNamesOf(n.variables),
          ) ||
          nodesHaveSecret(n.children)
        );
      return false;
    });

  if (nodesHaveSecret(archive.items)) return true;
  if (varsHaveSecret(archive.collectionVariables)) return true;

  const env = archive.environments ?? {};
  if (varsHaveSecret(env.globalVariables)) return true;
  for (const e of env.environments ?? []) {
    if (varsHaveSecret(e?.variables)) return true;
  }
  return false;
}

function requestHasSecret(req) {
  for (const [parent, field] of REQUEST_SECRET_PATHS) {
    const v = req?.[parent]?.[field];
    if (typeof v === "string" && v !== "") return true;
  }
  return false;
}

function varsHaveSecret(list) {
  return (
    Array.isArray(list) &&
    list.some(
      (v) =>
        v &&
        typeof v === "object" &&
        v.secure &&
        typeof v.value === "string" &&
        v.value !== "",
    )
  );
}

/** True when any secret-named profile override carries a non-empty value. */
function profileValuesHaveSecret(profileValues, secureNames) {
  if (
    !profileValues ||
    typeof profileValues !== "object" ||
    !secureNames.size
  ) {
    return false;
  }
  for (const map of Object.values(profileValues)) {
    if (!map || typeof map !== "object") continue;
    for (const [name, value] of Object.entries(map)) {
      if (secureNames.has(name) && typeof value === "string" && value !== "") {
        return true;
      }
    }
  }
  return false;
}

/**
 * Re-encrypt every secret field in the archive under `password` (portable
 * `encp:v2:`), tagging the envelope `secretsMode: "password"`.
 *
 * @param {object} archive  Plaintext archive from the renderer.
 * @param {string} password
 * @returns {object} New archive (input not mutated).
 */
function encryptArchiveSecrets(archive, password) {
  return {
    ...archive,
    secretsMode: "password",
    collectionVariables: exportVariableSecrets(
      archive.collectionVariables,
      password,
    ),
    items: mapNodeSecrets(
      archive.items,
      (req) => exportRequestSecrets(req, password),
      (list) => exportVariableSecrets(list, password),
      (pv, secureNames) => exportProfileValueSecrets(pv, secureNames, password),
    ),
    environments: mapEnvSecrets(archive.environments, (list) =>
      exportVariableSecrets(list, password),
    ),
  };
}

/**
 * Recover every portable secret in the archive. With the right password they
 * decrypt to plaintext; with no/wrong password the underlying helpers throw
 * (wrong) or clear the value (none). Tags the envelope back to `secretsMode:
 * "none"` since the returned archive is plaintext.
 *
 * @param {object} archive
 * @param {string} [password]
 * @returns {object} New plaintext archive (input not mutated).
 * @throws {PasswordError} on a wrong password.
 */
function decryptArchiveSecrets(archive, password) {
  return {
    ...archive,
    secretsMode: "none",
    collectionVariables: importVariableSecrets(
      archive.collectionVariables,
      password,
    ),
    items: mapNodeSecrets(
      archive.items,
      (req) => importRequestSecrets(req, password),
      (list) => importVariableSecrets(list, password),
      (pv, secureNames) => importProfileValueSecrets(pv, secureNames, password),
    ),
    environments: mapEnvSecrets(archive.environments, (list) =>
      importVariableSecrets(list, password),
    ),
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Walk items applying `reqFn` to requests, `varFn` to folder variables, and
 * `profFn(profileValues, secureNames)` to a folder's secret profile overrides
 * (its `secureNames` derived from the folder's own variables).
 */
function mapNodeSecrets(nodes, reqFn, varFn, profFn) {
  return (Array.isArray(nodes) ? nodes : []).map((n) => {
    if (!n || typeof n !== "object") return n;
    if (n.type === "request") return reqFn(n);
    if (n.type === "collection") {
      const out = {
        ...n,
        variables: varFn(n.variables),
        children: mapNodeSecrets(n.children, reqFn, varFn, profFn),
      };
      if (n.profileValues !== undefined) {
        out.profileValues = profFn(n.profileValues, secureNamesOf(n.variables));
      }
      return out;
    }
    return n;
  });
}

/** Apply `varFn` to the global + every environment's variable list. */
function mapEnvSecrets(environments, varFn) {
  const env = environments ?? {};
  return {
    globalVariables: varFn(env.globalVariables),
    environments: (env.environments ?? []).map((e) => ({
      ...e,
      variables: varFn(e?.variables),
    })),
  };
}

module.exports = {
  archiveHasSecrets,
  encryptArchiveSecrets,
  decryptArchiveSecrets,
};
