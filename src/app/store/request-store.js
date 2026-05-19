/**
 * request-store.js — Granular per-request CRUD backed by the per-file layout.
 *
 * Each request lives at:
 *   collections/<collectionId>/requests/<requestId>.json
 *
 * The resolver cache (requestId → collectionId) is used to locate a request's
 * collection without scanning all directories on every read.
 *
 * CreateRequest / DeleteRequest also keep tree.json in sync with the request set.
 */
"use strict";

const fs = require("fs");
const { readJSON, writeJSON, ensureDir, validateID, newUUID, notFoundError } = require("./io");

// ── Fields that PATCH may update ──────────────────────────────────────────────
const PATCHABLE_FIELDS = [
  "name", "method", "url",
  "bodyType", "bodyText", "bodyFilePath", "bodyFormRows",
  "params", "headers",
  "authEnabled", "authType", "authBasic", "authBearer", "authOAuth2", "authAwsIam",
  "preRequestScript", "afterResponseScript",
];

class RequestStore {
  /**
   * @param {import('./paths').Paths}       paths
   * @param {import('./resolver').Resolver} resolver
   */
  constructor(paths, resolver) {
    this._paths    = paths;
    this._resolver = resolver;
  }

  // ── Read ────────────────────────────────────────────────────────────────────

  /**
   * Retrieve a single request by ID.
   *
   * @param {string} id
   * @returns {object} Full request definition
   * @throws code="NOT_FOUND" if the request does not exist
   */
  getRequest(id) {
    validateID(id, "requestId");
    const collId = this._resolver.resolve(id); // throws NOT_FOUND if unknown
    const data   = readJSON(this._paths.requestPath(collId, id));
    if (data === null) throw notFoundError(`request not found: ${id}`);
    return data;
  }

  // ── Create ──────────────────────────────────────────────────────────────────

  /**
   * Persist a new request under `collectionId`.
   * Assigns an ID if `req.id` is empty.
   * Appends a requestRef to tree.json under the given collection folder.
   *
   * @param {string} collectionId
   * @param {object} req  Request definition (may lack `id`)
   * @returns {object}    The saved request (with `id` assigned)
   * @throws code="INVALID_ID" on bad collectionId or requestId
   */
  createRequest(collectionId, req) {
    validateID(collectionId, "collectionId");
    if (!req.id) req = { ...req, id: newUUID() };
    req = { ...req, type: "request" };

    ensureDir(this._paths.requestsDir(collectionId));
    writeJSON(this._paths.requestPath(collectionId, req.id), req);

    try {
      this._appendToTree(collectionId, collectionId, req.id);
    } catch (treeErr) {
      // Best-effort rollback: remove the request file so we don't leave orphans.
      try { fs.unlinkSync(this._paths.requestPath(collectionId, req.id)); } catch { /* ignore */ }
      throw treeErr;
    }

    this._resolver.set(req.id, collectionId);
    return req;
  }

  // ── Update (partial) ────────────────────────────────────────────────────────

  /**
   * Apply a partial patch to an existing request.
   * Only fields present (non-undefined) in `patch` are updated.
   * Unknown fields in the stored file are preserved.
   *
   * @param {string} id
   * @param {object} patch  Partial request fields
   * @returns {object}      Updated request definition
   * @throws code="NOT_FOUND" if the request does not exist
   */
  updateRequest(id, patch) {
    validateID(id, "requestId");
    const collId  = this._resolver.resolve(id);
    const reqPath = this._paths.requestPath(collId, id);
    const existing = readJSON(reqPath);
    if (existing === null) throw notFoundError(`request not found: ${id}`);

    const updated = { ...existing };
    for (const field of PATCHABLE_FIELDS) {
      if (patch[field] !== undefined) {
        updated[field] = patch[field];
      }
    }

    writeJSON(reqPath, updated);
    return updated;
  }

  // ── Delete ──────────────────────────────────────────────────────────────────

  /**
   * Permanently delete a request by ID.
   * Removes the request file and its requestRef from tree.json.
   *
   * @param {string} id
   * @throws code="NOT_FOUND" if the request does not exist
   */
  deleteRequest(id) {
    validateID(id, "requestId");
    const collId  = this._resolver.resolve(id);
    const reqPath = this._paths.requestPath(collId, id);

    if (!fs.existsSync(reqPath)) throw notFoundError(`request not found: ${id}`);

    fs.unlinkSync(reqPath);

    // Best-effort: keep the tree consistent (file is already gone, so not critical).
    try { this._removeFromTree(collId, id); } catch { /* ignore */ }

    this._resolver.remove(id);
  }

  // ── Tree helpers ────────────────────────────────────────────────────────────

  /**
   * Add a requestRef for `reqId` inside the folder with id == `folderId` in
   * the collection's tree.json. If no such folder exists, a new top-level
   * folder is created using the folderId as the name.
   */
  _appendToTree(envId, folderId, reqId) {
    const treePath = this._paths.treePath(envId);
    const tree     = readJSON(treePath) ?? { children: [] };
    const ref      = { id: reqId, type: "requestRef" };

    if (!_insertRefInTree(tree.children, folderId, ref)) {
      tree.children.push({
        id:       folderId,
        type:     "folder",
        name:     folderId,
        children: [ref],
      });
    }

    ensureDir(this._paths.collectionDir(envId));
    writeJSON(treePath, tree);
  }

  /** Remove the requestRef for `reqId` from the collection's tree.json. */
  _removeFromTree(collId, reqId) {
    const treePath = this._paths.treePath(collId);
    const tree     = readJSON(treePath);
    if (!tree) return;
    tree.children = _removeRefFromTree(tree.children ?? [], reqId);
    writeJSON(treePath, tree);
  }
}

// ── Pure helpers (no this) ────────────────────────────────────────────────────

/**
 * Recursively search `nodes` for a folder with id == `targetId` and push `ref`
 * into its children. Returns true if the folder was found.
 *
 * @param {object[]} nodes
 * @param {string}   targetId
 * @param {object}   ref
 * @returns {boolean}
 */
function _insertRefInTree(nodes, targetId, ref) {
  if (!Array.isArray(nodes)) return false;
  for (const node of nodes) {
    if (node.type === "folder" && node.id === targetId) {
      node.children = node.children ?? [];
      node.children.push(ref);
      return true;
    }
    if (_insertRefInTree(node.children, targetId, ref)) return true;
  }
  return false;
}

/**
 * Recursively filter out the requestRef with id == `reqId` from `nodes`.
 *
 * @param {object[]} nodes
 * @param {string}   reqId
 * @returns {object[]}
 */
function _removeRefFromTree(nodes, reqId) {
  if (!Array.isArray(nodes)) return [];
  return nodes
    .filter(n => !(n.type === "requestRef" && n.id === reqId))
    .map(n => n.type === "folder"
      ? { ...n, children: _removeRefFromTree(n.children, reqId) }
      : n);
}

module.exports = { RequestStore };

