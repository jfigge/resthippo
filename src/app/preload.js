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
   * Data persistence — backed by a JSON file in the platform user-data
   * directory, accessed via ipcMain handlers in main.js.
   *
   * The stored document shape is:
   *   { version: number, collections: object[], settings: object }
   *
   *   macOS:   ~/Library/Application Support/wurl/collections.json
   *   Linux:   ~/.config/wurl/collections.json
   *   Windows: %APPDATA%\wurl\collections.json
   */
  collections: {
    /** @returns {Promise<{ version: number, collections: object[], settings: object }>} */
    load: () => ipcRenderer.invoke("collections:read"),

    /**
     * Persist the full data document.
     * @param {{ version: number, collections: object[], settings: object }} doc
     * @returns {Promise<void>}
     */
    save: (doc) => ipcRenderer.invoke("collections:write", doc),
  },
});
