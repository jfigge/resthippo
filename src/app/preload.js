// preload.js — Runs in the renderer process before page content loads.
// Exposes a narrow, safe API surface to the renderer via contextBridge.
//
// ⚠️  SANDBOX RESTRICTION: this script runs inside Electron's sandboxed renderer.
//     In sandbox mode, require() is limited to Electron built-in modules ONLY.
//     It CANNOT load relative paths, JSON files, or arbitrary npm packages.
//     Do NOT add require("../anything") here — it will crash the preload in
//     packaged (.asar) builds and silently break all IPC-dependent features.
//     Any value that comes from the main process must go through IPC.
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("wurl", {
  /**
   * Explicit sentinel that the renderer uses to detect the Electron environment.
   * Always true when loaded via Electron's preload; never present in a plain
   * browser context served by the Go dev server.
   */
  isElectron: true,

  /** Platform string: 'darwin' | 'win32' | 'linux' */
  platform: process.platform,


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

  /**
   * Native HTTP execution — performs the actual outgoing request in the main
   * (Node.js) process using Node's built-in http/https modules, completely
   * bypassing Chromium's networking stack and its CORS enforcement.
   *
   * Descriptor shape:
   *   { method, url, headers, body?, bodyFilePath?,
   *     timeout?, followRedirects?, verifySsl? }
   *
   * Result shape:
   *   { status, statusText, headers, cookies, body, elapsed, size, consoleLog, error? }
   */
  http: {
    execute: (descriptor) => ipcRenderer.invoke("http:execute", descriptor),
  },
});
