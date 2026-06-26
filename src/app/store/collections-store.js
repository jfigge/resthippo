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
 * collections-store.js — Assembles / decomposes the legacy collection blob.
 *
 * The legacy API shape is:
 *   { collections: [ <nested collDoc tree> ], variables: {...}, headers: [...] }
 *
 * where each collDoc is:
 *   { id, type: "collection", name, variables, children: [ <request | collDoc> ] }
 *
 * and each request is the full request JSON object. `headers` are the
 * collection-level default HTTP headers ([{ id, name, value, enabled }]).
 *
 * Internally the data lives in the new per-file layout:
 *   collections/<id>/metadata.json   ← id + collection-level variables + default headers
 *   collections/<id>/tree.json       ← folder hierarchy + requestRef IDs (no bodies)
 *   collections/<id>/requests/<reqId>.json ← one file per request
 *
 * Assembly   (getCollections): read metadata + tree + individual request files.
 * Decomposition (saveCollections): walk the blob, write separate files, invalidate cache.
 */
"use strict";

const {
  readJSON,
  writeJSON,
  ensureDir,
  validateID,
  isValidID,
} = require("./io");
const {
  encryptVariables,
  decryptVariables,
  restoreUndecryptableVariables,
} = require("./crypto");
const { CollectionRepository } = require("./collection-repository");

class CollectionsStore {
  /**
   * @param {import('./paths').Paths}    paths
   * @param {import('./resolver').Resolver} resolver
   */
  constructor(paths, resolver, repository) {
    this._paths = paths;
    this._resolver = resolver;
    this._repo = repository ?? new CollectionRepository(paths);
  }

  // ── Read ────────────────────────────────────────────────────────────────────

  /**
   * Assemble and return the legacy collection blob for `id`.
   * Returns a minimal default `{ collections:[] }` when no data exists.
   *
   * @param {string} id  Collection ID
   * @returns {object}   Legacy blob: { collections, variables, headers }
   */
  getCollections(id) {
    validateID(id, "collectionId");

    const meta = readJSON(this._paths.metadataPath(id));
    if (meta === null) {
      return { collections: [] };
    }

    const variables = decryptVariables(meta.variables ?? [], "collection", id);
    // Collection-level default headers — plain (non-secret), stored verbatim.
    const headers = Array.isArray(meta.headers) ? meta.headers : [];

    const tree = readJSON(this._paths.treePath(id));
    if (tree === null) {
      return { collections: [], variables, headers };
    }

    const collections = this._buildLegacyCollections(id, tree.children ?? []);
    return { collections, variables, headers };
  }

  // ── Write ───────────────────────────────────────────────────────────────────

  /**
   * Decompose the legacy blob and write per-file layout.
   * Invalidates the resolver cache so new request→collection mappings are found.
   *
   * @param {string} id    Environment / collection ID
   * @param {object} data  Legacy blob: { collections?, variables?, headers? }
   */
  saveCollections(id, data) {
    validateID(id, "collectionId");

    const collections = Array.isArray(data.collections) ? data.collections : [];
    const incomingVars = Array.isArray(data.variables) ? data.variables : [];
    // Collection-level default headers — non-secret, persisted verbatim.
    const headers = Array.isArray(data.headers) ? data.headers : [];

    // Read existing on-disk data first so the clobber guard can restore still-
    // recoverable ciphertext for any secure value the caller left blank because
    // it had failed to decrypt — a transient keystore failure must never wipe a
    // secret. This applies to collection-level variables (metadata) and to each
    // folder's variables (correlated by folder id in the existing tree).
    const existingMeta = readJSON(this._paths.metadataPath(id));
    const existingTree = readJSON(this._paths.treePath(id));
    const existingFolderVars = new Map();
    this._collectFolderVars(existingTree?.children ?? [], existingFolderVars);

    ensureDir(this._paths.collectionDir(id));
    ensureDir(this._paths.requestsDir(id));

    // Write metadata (collection-level variables, secrets encrypted at rest).
    const variables = restoreUndecryptableVariables(
      encryptVariables(incomingVars),
      incomingVars,
      existingMeta?.variables,
    );
    writeJSON(this._paths.metadataPath(id), { id, variables, headers });

    // Decompose collections into tree nodes + individual request files.
    const reqFiles = {};
    const treeNodes = collections.map((coll) =>
      this._decomposeCollDoc(coll, reqFiles, existingFolderVars),
    );

    // Write tree (no request bodies).
    writeJSON(this._paths.treePath(id), { children: treeNodes });

    // Write individual request files (encrypt secrets before persisting).
    for (const [reqId, reqData] of Object.entries(reqFiles)) {
      try {
        validateID(reqId, "requestId");
      } catch {
        continue;
      }
      this._repo.writeRequest(id, reqId, reqData);
    }

    // Invalidate resolver so it rescans for new request→collection mappings.
    this._resolver.invalidate();
  }

  // ── Private: assembly ───────────────────────────────────────────────────────

  /** Convert top-level tree nodes (folders) into legacyCollDoc objects. */
  _buildLegacyCollections(collId, nodes) {
    return nodes
      .filter((n) => n.type === "folder")
      .map((n) => ({
        id: n.id,
        type: "collection",
        name: n.name,
        variables: decryptVariables(n.variables ?? [], "folder", n.id),
        children: this._buildLegacyChildren(collId, n.children ?? []),
      }));
  }

  /** Recursively build the children array: requestRefs → full request, folders → legacyCollDoc. */
  _buildLegacyChildren(collId, nodes) {
    const result = [];
    for (const node of nodes) {
      if (node.type === "requestRef") {
        // The ref id is interpolated into the request file path, so a traversal
        // value ("../../x") from a tampered tree.json or a malicious imported
        // backup could read outside the requests dir. Skip such a ref rather
        // than throw, so a poisoned tree degrades to "request missing".
        if (!isValidID(node.id)) continue;
        const req = this._repo.readRequest(collId, node.id);
        if (req !== null) result.push(req);
      } else if (node.type === "folder") {
        result.push({
          id: node.id,
          type: "collection",
          name: node.name,
          variables: decryptVariables(node.variables ?? [], "folder", node.id),
          children: this._buildLegacyChildren(collId, node.children ?? []),
        });
      }
    }
    return result;
  }

  /**
   * Recursively map folder id → its raw on-disk variable list across an internal
   * tree's nodes. Used so the save-path clobber guard can match each folder's
   * incoming variables against the ciphertext currently on disk.
   */
  _collectFolderVars(nodes, out) {
    for (const node of nodes ?? []) {
      if (!node || node.type !== "folder") continue;
      if (node.id != null) out.set(node.id, node.variables);
      this._collectFolderVars(node.children ?? [], out);
    }
  }

  // ── Private: decomposition ──────────────────────────────────────────────────

  /**
   * Recursively walk a legacyCollDoc tree, extracting request objects into
   * `reqFiles` and returning an internalTreeNode (folder/requestRef).
   *
   * @param {object} coll    legacyCollDoc
   * @param {object} reqFiles mutable { reqId → reqData } accumulator
   * @returns {object} internalTreeNode
   */
  _decomposeCollDoc(coll, reqFiles, existingFolderVars) {
    const incomingVars = Array.isArray(coll.variables) ? coll.variables : [];
    const node = {
      id: coll.id,
      type: "folder",
      name: coll.name,
      variables: restoreUndecryptableVariables(
        encryptVariables(incomingVars),
        incomingVars,
        existingFolderVars?.get(coll.id),
      ),
      children: [],
    };
    for (const child of coll.children ?? []) {
      if (child.type === "request") {
        node.children.push({ id: child.id, type: "requestRef" });
        reqFiles[child.id] = child;
      } else if (child.type === "collection") {
        node.children.push(
          this._decomposeCollDoc(child, reqFiles, existingFolderVars),
        );
      }
    }
    return node;
  }
}

module.exports = { CollectionsStore };
