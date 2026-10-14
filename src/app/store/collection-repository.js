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
 * collection-repository.js — single owner of the per-collection file layout.
 *
 * The per-file storage layout (metadata.json + tree.json + requests/<id>.json)
 * was historically hard-coded — path *and* encryption — in three places at once
 * (CollectionsStore's blob assemble/decompose, RequestStore's granular CRUD, and
 * BackupStore's import). This module is the start of consolidating that into one
 * owner so the layout and its encrypt-on-write / decrypt-on-read boundary live
 * in a single place.
 *
 * Stage 1 owns the **request files**: it is the only module that reads, writes,
 * or removes `requests/<id>.json` and the only one that applies the request
 * keystore encryption (`encryptRequest` / `decryptRequest`) to them — including
 * the secret-preserving clobber guard on update. Metadata and tree files are not
 * yet folded in (a later sub-stage), and BackupStore stays separate because it
 * persists requests in the portable password/machine encryption regime, not the
 * keystore one.
 *
 * Callers own ID validation: they legitimately differ on skip-vs-throw for an
 * untrusted id (a poisoned tree degrades; a direct CRUD call throws), so the
 * repository takes already-validated ids and does no validation itself.
 */
"use strict";

const fs = require("fs");
const {
  readJSON,
  writeJSON,
  ensureDir,
  remove,
  notFoundError,
} = require("./io");
const { encryptRequest, decryptRequest } = require("./crypto");

class CollectionRepository {
  /** @param {import('./paths').Paths} paths */
  constructor(paths) {
    this._paths = paths;
  }

  /**
   * Read + decrypt a request file.
   * @returns {object|null} the decrypted request, or null when the file is absent.
   */
  readRequest(collId, reqId) {
    const raw = readJSON(this._paths.requestPath(collId, reqId));
    return raw === null ? null : decryptRequest(raw);
  }

  /** Encrypt + write a request file, creating the requests/ dir if needed. */
  writeRequest(collId, reqId, request) {
    ensureDir(this._paths.requestsDir(collId));
    writeJSON(this._paths.requestPath(collId, reqId), encryptRequest(request));
  }

  /**
   * Encrypt + write an updated request, preserving still-recoverable ciphertext
   * for any secret field that failed to decrypt and that the patch did not
   * re-supply, so a transient keystore failure can never overwrite a secret with
   * a blank.
   *
   * @param {string} collId
   * @param {string} reqId
   * @param {object} updated  decrypted + patched plaintext to persist
   * @param {object} opts
   * @param {string[]} opts.failedPaths "parent.field" paths that failed to decrypt
   * @param {object} opts.patch         the caller's patch (to detect deliberate overwrites)
   */
  writeUpdatedRequest(collId, reqId, updated, { failedPaths, patch }) {
    const reqPath = this._paths.requestPath(collId, reqId);
    const encrypted = encryptRequest(updated);
    if (failedPaths?.length) {
      // Re-read the stored ciphertext to restore any secret that failed to
      // decrypt and the patch didn't re-supply (rare; only when decrypt failed).
      const stored = readJSON(reqPath) ?? {};
      for (const path of failedPaths) {
        const [parent, field] = path.split(".");
        if (patch[parent] !== undefined) continue; // user is overwriting on purpose
        const original = stored[parent]?.[field];
        if (original === undefined) continue;
        encrypted[parent] = { ...encrypted[parent], [field]: original };
      }
    }
    ensureDir(this._paths.requestsDir(collId));
    writeJSON(reqPath, encrypted);
  }

  /**
   * Strictly delete a request file: throws NOT_FOUND when it does not exist (the
   * caller distinguishes "deleted" from "never existed") and propagates any other
   * error rather than swallowing it.
   */
  removeRequest(collId, reqId) {
    try {
      fs.unlinkSync(this._paths.requestPath(collId, reqId));
    } catch (err) {
      if (err.code === "ENOENT")
        throw notFoundError(`request not found: ${reqId}`);
      throw err;
    }
  }

  /** Best-effort request-file removal (swallows errors) — e.g. create rollback. */
  removeRequestQuiet(collId, reqId) {
    remove(this._paths.requestPath(collId, reqId));
  }
}

module.exports = { CollectionRepository };
