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

"use strict";

// Minimal preload for the standalone user-guide window (docs.html). Exposes only
// what the DocsViewer needs: the platform string and a single read-only IPC to
// fetch a bundled help page's markdown by slug. Kept narrow on purpose — the docs
// window has no business reaching the storage / http surface of the main bridge.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hippo", {
  platform: process.platform,
  docs: {
    /**
     * Read a help page's markdown source by slug (e.g. "getting-started").
     * @param {string} page
     * @returns {Promise<string>}
     */
    read: (page) => ipcRenderer.invoke("docs:read", page),
  },
});
