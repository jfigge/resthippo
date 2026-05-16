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
   * Data persistence — manifest backed by collections.json; per-environment
   * collections backed by <envId>.json files; all in the platform user-data dir.
   *
   * Manifest shape (v2):
   *   { version, environments: [{id,name}], activeEnvironmentId, settings }
   *
   *   macOS:   ~/Library/Application Support/wurl/
   *   Linux:   ~/.config/wurl/
   *   Windows: %APPDATA%\wurl\
   */
  collections: {
    /** @returns {Promise<object>} manifest document */
    load: () => ipcRenderer.invoke("collections:read"),

    /**
     * Persist the full manifest document.
     * @param {object} doc
     * @returns {Promise<void>}
     */
    save: (doc) => ipcRenderer.invoke("collections:write", doc),
  },

  /**
   * Per-environment collections persistence.
   * Each environment's collections live in <userData>/<envId>.json
   */
  env: {
    /** @returns {Promise<{ version: number, collections: object[] }>} */
    load: (envId) => ipcRenderer.invoke("env:read", envId),

    /**
     * @param {string} envId
     * @param {{ version: number, collections: object[] }} doc
     * @returns {Promise<void>}
     */
    save: (envId, doc) => ipcRenderer.invoke("env:write", envId, doc),
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

  /**
   * HTML response live-preview — overlays a WebContentsView on the response body
   * pane and loads the original request URL so the page renders natively.
   *
   * Bounds shape: { x, y, width, height }  (integer pixels, viewport-relative)
   */
  htmlPreview: {
    /** Create/reuse the overlay view, set bounds, and navigate to `url`. */
    loadUrl:  (url, bounds) => ipcRenderer.invoke("htmlPreview:loadUrl",  url, bounds),
    /** Update the overlay view's bounds (used by ResizeObserver). */
    resize:   (bounds)      => ipcRenderer.invoke("htmlPreview:resize",   bounds),
    /** Re-attach and optionally reposition the overlay after it was hidden. */
    show:     (bounds)      => ipcRenderer.invoke("htmlPreview:show",     bounds),
    /** Detach the overlay from the window without destroying it. */
    hide:     ()            => ipcRenderer.invoke("htmlPreview:hide"),
    /** Fully destroy the overlay and release its WebContents. */
    destroy:  ()            => ipcRenderer.invoke("htmlPreview:destroy"),
  },
});
