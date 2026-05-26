/**
 * tree-store.js — Manages the lightweight collection navigation tree.
 *
 * The tree (collections/<id>/tree.json) contains only folder structure and
 * requestRef IDs — no request bodies, history, or response payloads.
 *
 * Tree shape:
 *   {
 *     children: [
 *       { id, type: "folder", name, children: [
 *           { id, type: "requestRef" },
 *           ...
 *       ]},
 *       ...
 *     ]
 *   }
 */
"use strict";

const fs = require("fs");
const {
  readJSON,
  writeJSON,
  ensureDir,
  validateID,
  notFoundError,
} = require("./io");

class TreeStore {
  /**
   * @param {import('./paths').Paths}       paths
   * @param {import('./resolver').Resolver} resolver
   */
  constructor(paths, resolver) {
    this._paths = paths;
    this._resolver = resolver;
  }

  /**
   * Return the navigation tree for the given collection.
   * Returns `{ children: [] }` when no tree has been saved yet.
   *
   * @param {string} collectionId
   * @returns {{ children: object[] }}
   */
  getTree(collectionId) {
    validateID(collectionId, "collectionId");
    return readJSON(this._paths.treePath(collectionId)) ?? { children: [] };
  }

  /**
   * Replace the navigation tree for the given collection.
   * All requestRef IDs in the new tree must have a corresponding request file;
   * an error (code "NOT_FOUND") is thrown for any dangling references.
   *
   * @param {string} collectionId
   * @param {{ children: object[] }} tree
   */
  saveTree(collectionId, tree) {
    validateID(collectionId, "collectionId");
    _validateTreeRefs(tree.children ?? [], collectionId, this._paths);
    ensureDir(this._paths.collectionDir(collectionId));
    writeJSON(this._paths.treePath(collectionId), tree);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Recursively verify that every requestRef in `nodes` has a file on disk.
 * Throws notFoundError on the first missing reference.
 *
 * @param {object[]} nodes
 * @param {string}   collectionId
 * @param {import('./paths').Paths} paths
 */
function _validateTreeRefs(nodes, collectionId, paths) {
  for (const node of nodes) {
    if (node.type === "requestRef") {
      const p = paths.requestPath(collectionId, node.id);
      if (!fs.existsSync(p)) {
        throw notFoundError(
          `requestRef ${node.id} not found in collection ${collectionId}`,
        );
      }
    } else if (node.type === "folder" && Array.isArray(node.children)) {
      _validateTreeRefs(node.children, collectionId, paths);
    }
  }
}

module.exports = { TreeStore };
