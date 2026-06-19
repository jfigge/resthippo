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
