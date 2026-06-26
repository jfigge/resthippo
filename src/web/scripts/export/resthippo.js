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

"use strict";

/**
 * export/resthippo.js — the native "Rest Hippo v1" interchange format.
 *
 * Unlike the lossy interchange exporters (Postman/Insomnia/OpenAPI/HAR), this is
 * a LOSSLESS native archive: it serializes the exported folders and requests
 * verbatim (every request field — method, url, params, headers, every auth type,
 * captures, notes, scripts, body — and every folder/collection variable) so an
 * import can fully restore them. The tree nodes already carry the canonical Rest
 * Hippo request/folder shape, so they are cloned as-is rather than mapped.
 *
 * Secrets are NOT redacted here (the whole point is full restore). Instead, when
 * the archive contains any secret the renderer prompts for a password and the
 * main process re-encrypts the secret fields into portable `encp:v2:` ciphertext
 * (the same scheme the Backup feature uses) before the file is written. Building
 * the plaintext structure stays here; the encryption lives in main where the
 * crypto helpers live (the renderer is sandboxed).
 *
 * Variables are captured REFERENCED-ONLY: only those a request/folder in the
 * exported set actually uses (`{{name}}`, followed transitively) are included.
 * This applies uniformly to the `environments` section (named environments + the
 * global scope; an environment that contributes nothing is dropped) AND to the
 * collection-scope variables — so exporting a single folder never drags in the
 * whole collection's (possibly secret) variables and needlessly forces a
 * password. Folder-level variables are the one exception: they travel inside
 * their folder node verbatim, as part of that folder's own definition.
 *
 * Collection-level DEFAULT HEADERS travel verbatim (in full, like the items) —
 * they are part of the collection's definition, not referenced-filtered. Their
 * `{{name}}` references DO seed the referenced-variable set, so a variable a
 * default header relies on is exported alongside it.
 */

import { isFunctionCall } from "../components/variable-resolver.js";
import { normalizeVariables } from "../components/variable-shape.js";

/** Discriminators written on every Rest Hippo v1 archive (used by import detection). */
export const RESTHIPPO_FORMAT = "resthippo";
export const RESTHIPPO_FORMAT_VERSION = 1;
export const RESTHIPPO_KIND = "resthippo-collection";

// Matches {{name}} tokens — the same syntax the variable resolver uses. Function
// pills (e.g. {{uuid()}}) resolve at send time, not against a stored variable, so
// they are skipped when collecting references.
const VAR_TOKEN_RE = /\{\{([^{}]+)\}\}/g;

/**
 * Build the plaintext Rest Hippo v1 archive object for an exported set.
 *
 * @param {object} opts
 * @param {object[]} opts.items   Top-level tree nodes (folders/requests) — the
 *   exported set, exactly as held in the live tree (full-fidelity request bodies).
 * @param {Array|object} [opts.collectionVariables]  The active collection's
 *   collection-level variables (any canonical/legacy shape); filtered to the
 *   referenced-only subset in the archive.
 * @param {Array} [opts.collectionHeaders]  The collection's default headers
 *   ([{ id, name, value, enabled }]); included verbatim (not referenced-filtered).
 * @param {{ globalVariables?: Array, environments?: Array }} [opts.environments]
 *   The workspace environment store (decrypted, in-memory).
 * @param {string} opts.exportedAt  ISO timestamp (supplied by the caller; the
 *   renderer has a clock, this pure module does not).
 * @returns {object} The archive object (secretsMode defaults to "none"; main
 *   overwrites it to "password" when it encrypts secret fields).
 */
export function buildRestHippoArchive({
  items,
  collectionVariables,
  collectionHeaders,
  environments,
  exportedAt,
} = {}) {
  const nodes = Array.isArray(items) ? structuredClone(items) : [];
  const collVars = normalizeVariables(collectionVariables);
  // Default headers travel in full, like the items (not referenced-filtered).
  const collHeaders = Array.isArray(collectionHeaders)
    ? structuredClone(collectionHeaders)
    : [];
  const globalVars = normalizeVariables(environments?.globalVariables);
  const envs = (
    Array.isArray(environments?.environments) ? environments.environments : []
  ).map((env) => ({
    id: env?.id ?? null,
    name: env?.name ?? "",
    variables: normalizeVariables(env?.variables),
  }));

  const referenced = collectReferencedVariables(
    nodes,
    [collVars, globalVars, ...envs.map((e) => e.variables)],
    // Default-header values can reference {{vars}} too — seed them so a variable
    // a header relies on is pulled into the referenced-only export.
    collHeaders.map((h) => h?.value),
  );

  // Filter collection vars, globals, and each environment to the referenced-only
  // set; drop environments that then contribute nothing. (Folder-scope vars stay
  // inside their node — see the module header.)
  const refdCollVars = collVars.filter((v) => referenced.has(v.name));
  const refdGlobal = globalVars.filter((v) => referenced.has(v.name));
  const refdEnvs = envs
    .map((env) => ({
      id: env.id,
      name: env.name,
      variables: env.variables.filter((v) => referenced.has(v.name)),
    }))
    .filter((env) => env.variables.length > 0);

  return {
    format: RESTHIPPO_FORMAT,
    formatVersion: RESTHIPPO_FORMAT_VERSION,
    kind: RESTHIPPO_KIND,
    exportedAt: exportedAt ?? null,
    app: { name: "Rest Hippo" },
    secretsMode: "none",
    collectionVariables: refdCollVars,
    collectionHeaders: collHeaders,
    items: nodes,
    environments: {
      globalVariables: refdGlobal,
      environments: refdEnvs,
    },
  };
}

/**
 * Collect the set of variable names that the exported set needs in order to
 * resolve — every `{{name}}` referenced directly in a request/folder field, plus
 * the transitive closure through variable values (a referenced variable whose own
 * value references another variable pulls that one in too).
 *
 * @param {object[]} nodes      The exported tree nodes (already cloned).
 * @param {Array[]} scopeLists  Canonical variable arrays from every scope, used to
 *   resolve value→value references for the closure.
 * @param {string[]} [extraSeedStrings]  Extra strings (e.g. collection default
 *   header values) whose `{{name}}` tokens also seed the referenced set.
 * @returns {Set<string>}
 */
export function collectReferencedVariables(
  nodes,
  scopeLists = [],
  extraSeedStrings = [],
) {
  // name → set of names its value(s) reference, unioned across every scope a name
  // appears in (over-inclusion is safe: better to ship a needed variable than miss
  // one). Folder-level variable values are reached through the node walk below.
  const adjacency = new Map();
  const addEdges = (name, value) => {
    if (!name) return;
    const refs = adjacency.get(name) ?? new Set();
    forEachToken(value, (token) => refs.add(token));
    adjacency.set(name, refs);
  };
  for (const list of scopeLists) {
    for (const entry of list ?? []) addEdges(entry?.name, entry?.value);
  }

  // Seed: every {{token}} that appears in any string anywhere in the exported
  // nodes (request fields AND folder variable values, since those are strings in
  // the node tree).
  const referenced = new Set();
  walkStrings(nodes, (str) =>
    forEachToken(str, (token) => referenced.add(token)),
  );
  // Folder variable values also seed edges so the closure can follow them.
  walkFolderVariables(nodes, (entry) => addEdges(entry?.name, entry?.value));

  // Extra seed strings (e.g. collection default-header values) contribute their
  // {{tokens}} to the referenced set directly.
  for (const str of extraSeedStrings ?? []) {
    forEachToken(str, (token) => referenced.add(token));
  }

  // Transitive closure over the value-reference graph.
  const queue = [...referenced];
  while (queue.length > 0) {
    const name = queue.shift();
    for (const next of adjacency.get(name) ?? []) {
      if (!referenced.has(next)) {
        referenced.add(next);
        queue.push(next);
      }
    }
  }
  return referenced;
}

/** Invoke `fn` for each non-function {{token}} found in a string value. */
function forEachToken(value, fn) {
  if (typeof value !== "string" || value.indexOf("{{") === -1) return;
  VAR_TOKEN_RE.lastIndex = 0;
  let match;
  while ((match = VAR_TOKEN_RE.exec(value)) !== null) {
    const name = match[1].trim();
    if (name && !isFunctionCall(name)) fn(name);
  }
}

/** Depth-first walk invoking `fn` on every string value reachable in `value`. */
function walkStrings(value, fn) {
  if (typeof value === "string") {
    fn(value);
  } else if (Array.isArray(value)) {
    for (const item of value) walkStrings(item, fn);
  } else if (value && typeof value === "object") {
    for (const key of Object.keys(value)) walkStrings(value[key], fn);
  }
}

/** Visit every folder node's variable entries across the tree. */
function walkFolderVariables(nodes, fn) {
  for (const node of nodes ?? []) {
    if (!node || typeof node !== "object") continue;
    if (node.type === "collection") {
      for (const entry of normalizeVariables(node.variables)) fn(entry);
      walkFolderVariables(node.children ?? [], fn);
    }
  }
}
