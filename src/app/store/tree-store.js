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
 * tree-store.js — Manages the lightweight collection navigation tree.
 *
 * The tree (collections/<id>/tree.json) contains only folder structure and
 * requestRef IDs — no request bodies, history, or response payloads.
 *
 * Tree shape:
 *   {
 *     children: [
 *       { id, type: "folder", name, variables?, profiles?, profileValues?,
 *         children: [
 *           { id, type: "requestRef" },
 *           ...
 *       ]},
 *       ...
 *     ]
 *   }
 *
 * `profiles` is the list of variable profiles this folder OWNS ([{id,name}]);
 * `profileValues` its per-profile value overrides, keyed by profile id — for a
 * profile owned by this folder OR by any ancestor. This store passes both through
 * untouched; the shapes are defined in the renderer's components/profile-scope.js
 * and components/folder-profiles.js.
 */
"use strict";

const {
  readJSON,
  writeJSON,
  ensureDir,
  validateID,
  notFoundError,
  exists,
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
      // Reject traversal/forbidden ids before they reach the request file path.
      validateID(node.id, "requestId");
      const p = paths.requestPath(collectionId, node.id);
      if (!exists(p)) {
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
