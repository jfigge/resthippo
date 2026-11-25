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
 * store/command-approvals.js — local approvals for Command requests (Feature 70).
 *
 * A Command request runs an arbitrary program, so a collection imported from
 * someone else must not be able to run one silently (as a chained dependency or
 * in a folder run). Before a command template runs for the first time — or
 * after it changes — the user confirms it; the approval is remembered here as
 * requestId → hash of the UNRESOLVED template (command line + env rows), so a
 * changed command asks again while changing variable values does not.
 *
 * The file is local to this machine and deliberately outside the collections
 * tree: it is never exported, backed up, or projected into the git repo.
 */
"use strict";

const fs = require("fs");
const io = require("./io");

/** Cap on remembered approvals (oldest dropped first). */
const MAX_APPROVALS = 5000;

class CommandApprovals {
  #file;
  /** @type {Map<string,string>|null} lazily loaded */
  #map = null;

  /** @param {string} file absolute path of the approvals JSON file */
  constructor(file) {
    this.#file = file;
  }

  #load() {
    if (this.#map) return this.#map;
    this.#map = new Map();
    try {
      const raw = JSON.parse(fs.readFileSync(this.#file, "utf8"));
      const entries =
        raw && typeof raw.approvals === "object" ? raw.approvals : {};
      for (const [id, hash] of Object.entries(entries)) {
        if (typeof hash === "string") this.#map.set(id, hash);
      }
    } catch {
      // missing or corrupt → no approvals (fail closed: the user is asked again)
    }
    return this.#map;
  }

  #save() {
    const approvals = Object.fromEntries(this.#map);
    io.atomicWrite(
      this.#file,
      JSON.stringify({ version: 1, approvals }, null, 2),
    );
  }

  /** @returns {boolean} true when `hash` is the approved template for `requestId` */
  isApproved(requestId, hash) {
    if (!requestId || !hash) return false;
    return this.#load().get(String(requestId)) === String(hash);
  }

  /** Remember `hash` as approved for `requestId` (replaces any older approval). */
  grant(requestId, hash) {
    if (!requestId || !hash) return false;
    const map = this.#load();
    const id = String(requestId);
    map.delete(id); // re-insert → most recent last
    map.set(id, String(hash));
    while (map.size > MAX_APPROVALS) map.delete(map.keys().next().value);
    this.#save();
    return true;
  }

  /** Forget an approval (e.g. the request was deleted). */
  revoke(requestId) {
    const map = this.#load();
    if (!map.delete(String(requestId))) return false;
    this.#save();
    return true;
  }
}

module.exports = { CommandApprovals, MAX_APPROVALS };
