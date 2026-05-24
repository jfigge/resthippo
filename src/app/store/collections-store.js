/**
 * collections-store.js — Assembles / decomposes the legacy collection blob.
 *
 * The legacy API shape is:
 *   { version: 1, collections: [ <nested collDoc tree> ], variables: {...} }
 *
 * where each collDoc is:
 *   { id, type: "collection", name, variables, children: [ <request | collDoc> ] }
 *
 * and each request is the full request JSON object.
 *
 * Internally the data lives in the new per-file layout:
 *   collections/<id>/metadata.json   ← id + collection-level variables
 *   collections/<id>/tree.json       ← folder hierarchy + requestRef IDs (no bodies)
 *   collections/<id>/requests/<reqId>.json ← one file per request
 *
 * Assembly   (getCollections): read metadata + tree + individual request files.
 * Decomposition (saveCollections): walk the blob, write separate files, invalidate cache.
 */
"use strict";

const { readJSON, writeJSON, ensureDir, validateID } = require("./io");
const { encryptRequest, decryptRequest } = require("./crypto");

class CollectionsStore{
  /**
   * @param {import('./paths').Paths}    paths
   * @param {import('./resolver').Resolver} resolver
   */
  constructor(paths, resolver) {
    this._paths    = paths;
    this._resolver = resolver;
  }

  // ── Read ────────────────────────────────────────────────────────────────────

  /**
   * Assemble and return the legacy collection blob for `id`.
   * Returns a minimal default `{ version:1, collections:[] }` when no data exists.
   *
   * @param {string} id  Collection ID
   * @returns {object}   Legacy blob: { version, collections, variables }
   */
  getCollections(id) {
    validateID(id, "collectionId");

    const meta = readJSON(this._paths.metadataPath(id));
    if (meta === null) {
      return { version: 1, collections: [] };
    }

    const tree = readJSON(this._paths.treePath(id));
    if (tree === null) {
      return { version: 1, collections: [], variables: meta.variables ?? {} };
    }

    const collections = this._buildLegacyCollections(id, tree.children ?? []);
    return { version: 1, collections, variables: meta.variables ?? {} };
  }

  // ── Write ───────────────────────────────────────────────────────────────────

  /**
   * Decompose the legacy blob and write per-file layout.
   * Invalidates the resolver cache so new request→collection mappings are found.
   *
   * @param {string} id    Environment / collection ID
   * @param {object} data  Legacy blob: { version?, collections?, variables? }
   */
  saveCollections(id, data) {
    validateID(id, "collectionId");

    const collections = Array.isArray(data.collections) ? data.collections : [];
    const variables   = (data.variables && typeof data.variables === "object") ? data.variables : {};

    ensureDir(this._paths.collectionDir(id));
    ensureDir(this._paths.requestsDir(id));

    // Write metadata (collection-level variables).
    writeJSON(this._paths.metadataPath(id), { id, variables });

    // Decompose collections into tree nodes + individual request files.
    const reqFiles  = {};
    const treeNodes = collections.map(coll => this._decomposeCollDoc(coll, reqFiles));

    // Write tree (no request bodies).
    writeJSON(this._paths.treePath(id), { children: treeNodes });

    // Write individual request files (encrypt secrets before persisting).
    for (const [reqId, reqData] of Object.entries(reqFiles)) {
      try { validateID(reqId, "requestId"); } catch { continue; }
      writeJSON(this._paths.requestPath(id, reqId), encryptRequest(reqData));
    }

    // Invalidate resolver so it rescans for new request→collection mappings.
    this._resolver.invalidate();
  }

  // ── Private: assembly ───────────────────────────────────────────────────────

  /** Convert top-level tree nodes (folders) into legacyCollDoc objects. */
  _buildLegacyCollections(collId, nodes) {
    return nodes
      .filter(n => n.type === "folder")
      .map(n => ({
        id:        n.id,
        type:      "collection",
        name:      n.name,
        variables: n.variables ?? {},
        children:  this._buildLegacyChildren(collId, n.children ?? []),
      }));
  }

  /** Recursively build the children array: requestRefs → full request, folders → legacyCollDoc. */
  _buildLegacyChildren(collId, nodes) {
    const result = [];
    for (const node of nodes) {
      if (node.type === "requestRef") {
        const req = readJSON(this._paths.requestPath(collId, node.id));
        if (req !== null) result.push(decryptRequest(req));
      } else if (node.type === "folder") {
        result.push({
          id:        node.id,
          type:      "collection",
          name:      node.name,
          variables: node.variables ?? {},
          children:  this._buildLegacyChildren(collId, node.children ?? []),
        });
      }
    }
    return result;
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
  _decomposeCollDoc(coll, reqFiles) {
    const node = {
      id:        coll.id,
      type:      "folder",
      name:      coll.name,
      variables: coll.variables ?? {},
      children:  [],
    };
    for (const child of (coll.children ?? [])) {
      if (child.type === "request") {
        node.children.push({ id: child.id, type: "requestRef" });
        reqFiles[child.id] = child;
      } else if (child.type === "collection") {
        node.children.push(this._decomposeCollDoc(child, reqFiles));
      }
    }
    return node;
  }
}

module.exports = { CollectionsStore};

