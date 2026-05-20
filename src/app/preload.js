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

// ─── Main → Renderer push events ─────────────────────────────────────────────
ipcRenderer.on("wurl:ui-font-change", (_event, direction) => {
  window.dispatchEvent(
    new CustomEvent("wurl:ui-font-change", { detail: direction })
  );
});

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
   * Storage layer — exposes the new per-file storage architecture through IPC.
   *
   * All methods return Promises.  Storage is located in the platform user-data dir:
   *   macOS:   ~/Library/Application Support/wurl/
   *   Linux:   ~/.config/wurl/
   *   Windows: %APPDATA%\wurl\
   *
   * Layout:
   *   collections/
   *     index.json                         ← manifest (environments, settings)
   *     <collId>/
   *       metadata.json                    ← name, variables
   *       tree.json                        ← lightweight nav tree
   *       requests/<reqId>.json            ← per-request files
   *       history/<reqId>/<histId>.json    ← execution metadata
   *       responses/<reqId>/<histId>.json  ← full response payloads (lazy)
   */
  store: {
    /**
     * Global manifest: environments list + application settings.
     * Shape: { version: 2, environments: [{id, name}], activeEnvironmentId, settings }
     */
    manifest: {
      /** @returns {Promise<object>} */
      get:  ()     => ipcRenderer.invoke("store:manifest:get"),
      /** @param {object} data @returns {Promise<void>} */
      save: (data) => ipcRenderer.invoke("store:manifest:save", data),
    },

    /**
     * Per-environment blob — assembles { version, collections[], variables }
     * from the new per-file layout for backward-compatible renderer access.
     */
    env: {
      /** @param {string} id @returns {Promise<{ version, collections, variables }>} */
      get:  (id)       => ipcRenderer.invoke("store:env:get", id),
      /** @param {string} id @param {object} data @returns {Promise<void>} */
      save: (id, data) => ipcRenderer.invoke("store:env:save", id, data),
    },

    /**
     * Lightweight navigation tree (folder hierarchy + requestRef IDs).
     * Never contains full request bodies.
     */
    tree: {
      /** @param {string} collectionId @returns {Promise<{ children: object[] }>} */
      get:  (collectionId)       => ipcRenderer.invoke("store:tree:get", collectionId),
      /** @param {string} collectionId @param {{ children: object[] }} tree @returns {Promise<void>} */
      save: (collectionId, tree) => ipcRenderer.invoke("store:tree:save", collectionId, tree),
    },

    /**
     * Granular per-request CRUD.
     * Requests are located by ID; no collection context is needed for reads.
     */
    requests: {
      /** @param {string} id @returns {Promise<object|null>} */
      get:    (id)                => ipcRenderer.invoke("store:requests:get", id),
      /** @param {string} collectionId @param {object} data @returns {Promise<object>} */
      create: (collectionId, data) => ipcRenderer.invoke("store:requests:create", collectionId, data),
      /** @param {string} id @param {object} patch @returns {Promise<object>} */
      update: (id, patch)          => ipcRenderer.invoke("store:requests:update", id, patch),
      /** @param {string} id @returns {Promise<void>} */
      delete: (id)                 => ipcRenderer.invoke("store:requests:delete", id),
    },

    /**
     * Request execution history with lazy-loaded response payloads.
     */
    history: {
      /**
       * List history newest-first with cursor pagination.
       * @param {string} requestId
       * @param {{ limit?: number, cursor?: string }} [options]
       * @returns {Promise<{ items: object[], nextCursor: string }>}
       */
      list: (requestId, options) =>
        ipcRenderer.invoke("store:history:list", requestId, options),
      /**
       * Record a new execution.
       * @param {string} requestId
       * @param {object} entry     Execution metadata
       * @param {object} [response] Full response payload
       * @returns {Promise<object>}
       */
      add: (requestId, entry, response) =>
        ipcRenderer.invoke("store:history:add", requestId, entry, response),
      /**
       * Lazy-load the full response payload for one history entry.
       * @param {string} requestId
       * @param {string} historyId
       * @returns {Promise<object|null>}
       */
      getResponse: (requestId, historyId) =>
        ipcRenderer.invoke("store:history:response:get", requestId, historyId),
    },
  },

  /**
   * Native HTTP execution — performs the actual outgoing request in the main
   * (Node.js) process using Node's built-in http/https modules, completely
   * bypassing Chromium's networking stack and its CORS enforcement.
   *
   * Descriptor: { method, url, headers, body?, bodyFilePath?, timeout?, followRedirects?, verifySsl? }
   * Result:     { status, statusText, headers, cookies, body, elapsed, size, consoleLog, error? }
   */
  http: {
    execute: (descriptor) => ipcRenderer.invoke("http:execute", descriptor),
  },

  /**
   * OAuth 2.0 popup authorization — opens a BrowserWindow that navigates to
   * the IdP login page, intercepts the redirect callback, and returns the
   * full callback URL that contains the authorization code / token.
   *
   * MUST only be called for flows that require a browser-based login page
   * (Authorization Code, Implicit).  Machine-to-machine flows (Client
   * Credentials, Resource Owner Password) call the token endpoint directly
   * via window.wurl.http.execute and do not need a popup.
   *
   * Parameters:
   *   authUrl     {string} — Full authorization URL (with all query params)
   *   redirectUri {string} — The redirect_uri registered with the OAuth server
   *   title       {string} — Optional window title
   *
   * Returns:
   *   { url: string|null, cancelled: boolean }
   *     url       — callback URL (with code= / token= in query / fragment)
   *     cancelled — true when the user closed the window without completing
   */
  oauth: {
    openPopup: (authUrl, redirectUri, title) =>
      ipcRenderer.invoke("oauth:open-popup", { authUrl, redirectUri, title }),
  },

  /**
   * HTML response live-preview — overlays a WebContentsView on the response body
   * pane and loads the original request URL so the page renders natively.
   *
   * Bounds shape: { x, y, width, height }  (integer pixels, viewport-relative)
   */
  htmlPreview: {
    loadUrl: (url, bounds) => ipcRenderer.invoke("htmlPreview:loadUrl",  url, bounds),
    resize:  (bounds)      => ipcRenderer.invoke("htmlPreview:resize",   bounds),
    show:    (bounds)      => ipcRenderer.invoke("htmlPreview:show",     bounds),
    hide:    ()            => ipcRenderer.invoke("htmlPreview:hide"),
    destroy: ()            => ipcRenderer.invoke("htmlPreview:destroy"),
  },
});
