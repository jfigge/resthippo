"use strict";

// Minimal preload for the standalone user-guide window (docs.html). Exposes only
// what the DocsViewer needs: the platform string and a single read-only IPC to
// fetch a bundled help page's markdown by slug. Kept narrow on purpose — the docs
// window has no business reaching the storage / http surface of the main bridge.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("wurl", {
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
