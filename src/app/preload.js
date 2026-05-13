// preload.js — Runs in the renderer process before page content loads.
// Exposes a narrow, safe API surface to the renderer via contextBridge.
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("wurl", {
  /** Platform string: 'darwin' | 'win32' | 'linux' */
  platform: process.platform,

  /** App version from package.json */
  version: require("../package.json").version,

  /**
   * Collections persistence — backed by a JSON file in the platform user-data
   * directory, accessed via ipcMain handlers in main.js.
   *
   *   macOS:   ~/Library/Application Support/wurl/collections.json
   *   Linux:   ~/.config/wurl/collections.json
   *   Windows: %APPDATA%\wurl\collections.json
   */
  collections: {
    /** @returns {Promise<object[]>} the stored collections array ([] on first run) */
    load: () => ipcRenderer.invoke("collections:read"),

    /**
     * Persist the full collections array.
     * @param {object[]} items
     * @returns {Promise<void>}
     */
    save: (items) => ipcRenderer.invoke("collections:write", items),
  },
});
