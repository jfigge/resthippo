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

const {
  readJSON,
  writeJSON,
  ensureDir,
  validateID,
  newUUID,
  notFoundError,
} = require("./io");
const { CollectionRepository } = require("./collection-repository");

// ── Fields that PATCH may update ──────────────────────────────────────────────
const PATCHABLE_FIELDS = [
  "name",
  // Free-text notes tab — a persisted, user-authored request field. Omitting it
  // would make a granular update silently drop notes edits.
  "notes",
  "method",
  "url",
  // protocol distinguishes a WebSocket request ("websocket") from a normal HTTP
  // request (absent / "http"); the ws* fields below back the WebSocket composer.
  "protocol",
  "wsMessage",
  "wsMessageFormat",
  "wsSubprotocols",
  // Live streaming responses (Feature 33): consume SSE / chunked bodies live.
  "streaming",
  "bodyType",
  "bodyText",
  "bodyFilePath",
  "bodyFormRows",
  "bodyGraphql",
  "params",
  "pathParams",
  "headers",
  "authEnabled",
  "authType",
  "authBasic",
  "authBearer",
  "authApiKey",
  "authDigest",
  "authNtlm",
  "authOAuth1",
  "authOAuth2",
  "authAwsIam",
  "preRequestScript",
  "afterResponseScript",
  // Scripting (Feature 25): per-pane enable flags (scripts run only when enabled)
  // and the persisted Scripts-tab splitter ratio (pre-pane height, % of pane).
  "preRequestScriptEnabled",
  "afterResponseScriptEnabled",
  "scriptSplit",
  // Post-response capture rules (Feature 03): extract values from a successful
  // response and write them into a variable scope. See components/captures.js.
  "captures",
];

class RequestStore {
  /**
   * @param {import('./paths').Paths}                 paths
   * @param {import('./resolver').Resolver}           resolver
   * @param {import('./history-store').HistoryStore} [history]
   *   History store used to cascade-delete a request's run history and response
   *   payloads when the request is removed. Optional so the store still works in
   *   isolation (e.g. focused unit tests); when absent, history is left in place.
   */
  constructor(paths, resolver, history, repository) {
    this._paths = paths;
    this._resolver = resolver;
    this._history = history ?? null;
    this._repo = repository ?? new CollectionRepository(paths);
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
    const req = this._repo.readRequest(collId, id);
    if (req === null) throw notFoundError(`request not found: ${id}`);
    return req;
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

    this._repo.writeRequest(collectionId, req.id, req);

    try {
      this._appendToTree(collectionId, collectionId, req.id);
    } catch (treeErr) {
      // Best-effort rollback: remove the request file so we don't leave orphans.
      this._repo.removeRequestQuiet(collectionId, req.id);
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
    const collId = this._resolver.resolve(id);
    const decrypted = this._repo.readRequest(collId, id);
    if (decrypted === null) throw notFoundError(`request not found: ${id}`);

    // Merge the patch (plaintext from the renderer) onto the decrypted plaintext;
    // the repository re-encrypts and applies the secret-preserving clobber guard
    // so a field that failed to decrypt can't be blanked over recoverable
    // ciphertext.
    const failedPaths = decrypted._decryptErrors ?? [];
    const updated = { ...decrypted };
    delete updated._decryptErrors;
    for (const field of PATCHABLE_FIELDS) {
      if (patch[field] !== undefined) {
        updated[field] = patch[field];
      }
    }

    this._repo.writeUpdatedRequest(collId, id, updated, { failedPaths, patch });
    return updated;
  }

  // ── Delete ──────────────────────────────────────────────────────────────────

  /**
   * Permanently delete a request by ID.
   * Removes the request file, its requestRef from tree.json, and its entire run
   * history + response payloads, so no orphaned timeline data outlives the
   * request. (Auth secrets live encrypted inside the request file itself, so
   * they go with it; there are no separate keystore entries to reclaim.)
   *
   * @param {string} id
   * @throws code="NOT_FOUND" if the request does not exist
   */
  deleteRequest(id) {
    validateID(id, "requestId");
    const collId = this._resolver.resolve(id);

    // Strict delete (not fire-and-forget): a missing file must surface as
    // NOT_FOUND and any other error must propagate — the repository enforces both.
    this._repo.removeRequest(collId, id);

    // Best-effort: keep the tree consistent (file is already gone, so not critical).
    try {
      this._removeFromTree(collId, id);
    } catch {
      /* ignore */
    }

    // Cascade: drop this request's run history + response payloads. Must run
    // before the resolver entry is removed below, since clearHistory resolves
    // requestId → collection through the same cache.
    if (this._history) {
      try {
        this._history.clearHistory(id);
      } catch {
        /* best-effort: never block deletion on history cleanup */
      }
    }

    this._resolver.remove(id);
  }

  // ── Tree helpers ────────────────────────────────────────────────────────────

  /**
   * Add a requestRef for `reqId` inside the folder with id == `folderId` in
   * the collection's tree.json. If no such folder exists, a new top-level
   * folder is created using the folderId as the name.
   */
  _appendToTree(collId, folderId, reqId) {
    const treePath = this._paths.treePath(collId);
    const tree = readJSON(treePath) ?? { children: [] };
    const ref = { id: reqId, type: "requestRef" };

    if (!_insertRefInTree(tree.children, folderId, ref)) {
      tree.children.push({
        id: folderId,
        type: "folder",
        name: folderId,
        children: [ref],
      });
    }

    ensureDir(this._paths.collectionDir(collId));
    writeJSON(treePath, tree);
  }

  /** Remove the requestRef for `reqId` from the collection's tree.json. */
  _removeFromTree(collId, reqId) {
    const treePath = this._paths.treePath(collId);
    const tree = readJSON(treePath);
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
    .filter((n) => !(n.type === "requestRef" && n.id === reqId))
    .map((n) =>
      n.type === "folder"
        ? { ...n, children: _removeRefFromTree(n.children, reqId) }
        : n,
    );
}

module.exports = { RequestStore };
