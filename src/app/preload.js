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

const { contextBridge, ipcRenderer, webUtils } = require("electron");

// ─── Main → Renderer push events ─────────────────────────────────────────────
ipcRenderer.on("wurl:ui-font-change", (_event, direction) => {
  window.dispatchEvent(
    new CustomEvent("wurl:ui-font-change", { detail: direction }),
  );
});

ipcRenderer.on("menu:import", () => {
  window.dispatchEvent(new CustomEvent("wurl:import-requested"));
});

// Edit-menu Undo/Redo (and their ⌘Z/⌘⇧Z accelerators) are routed here instead
// of using native roles, so the focused multi-line code editor can run its own
// snapshot undo/redo; app.js falls back to document.execCommand for plain inputs.
ipcRenderer.on("menu:edit-action", (_event, action) => {
  window.dispatchEvent(
    new CustomEvent("wurl:edit-action", { detail: { action } }),
  );
});

ipcRenderer.on("menu:export-all", () => {
  window.dispatchEvent(new CustomEvent("wurl:export-all-requested"));
});

ipcRenderer.on("menu:backup-export", () => {
  window.dispatchEvent(new CustomEvent("wurl:backup-export-requested"));
});

ipcRenderer.on("menu:backup-import", () => {
  window.dispatchEvent(new CustomEvent("wurl:backup-import-requested"));
});

ipcRenderer.on("theme:preview", (_event, themeData) => {
  window.dispatchEvent(
    new CustomEvent("wurl:theme-preview", { detail: themeData }),
  );
});

ipcRenderer.on("theme:editor:notify", (_event, customThemes) => {
  window.dispatchEvent(
    new CustomEvent("wurl:custom-themes-changed", { detail: customThemes }),
  );
});

ipcRenderer.on("theme:editor:apply", (_event, themeId) => {
  window.dispatchEvent(
    new CustomEvent("wurl:theme-apply", { detail: themeId }),
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
   * Internationalization — the main process resolves the active locale
   * (persisted preference → OS locale → English) and returns the bundled
   * catalog plus the English fallback. The renderer awaits load() once at
   * startup; see src/web/scripts/i18n.js.
   */
  i18n: {
    /**
     * @returns {Promise<{ requested, system, active, lang, messages, fallback }>}
     */
    load: () => ipcRenderer.invoke("i18n:load"),
  },

  /**
   * Resolve the absolute filesystem path for a File chosen via an
   * <input type="file"> in the renderer. Electron removed the legacy
   * File.path property in v32; webUtils.getPathForFile — callable only from a
   * privileged context such as this preload — is the supported replacement.
   * Returns "" when the path can't be resolved (e.g. a non-disk File).
   *
   * @param {File} file
   * @returns {string}
   */
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || "";
    } catch {
      return "";
    }
  },

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
   *     index.json                         ← manifest (collections, settings)
   *     <collId>/
   *       metadata.json                    ← name, variables
   *       tree.json                        ← lightweight nav tree
   *       requests/<reqId>.json            ← per-request files
   *       history/<reqId>/<histId>.json    ← execution metadata
   *       responses/<reqId>/<histId>.json  ← full response payloads (lazy)
   */
  store: {
    /**
     * Global manifest: collections list + application settings.
     * Shape: { version: 2, collections: [{id, name}], activeCollectionId, settings }
     */
    manifest: {
      /** @returns {Promise<object>} */
      get: () => ipcRenderer.invoke("store:manifest:get"),
      /** @param {object} data @returns {Promise<void>} */
      save: (data) => ipcRenderer.invoke("store:manifest:save", data),
    },

    /** Collection lifecycle operations beyond the manifest list. */
    collections: {
      /**
       * Permanently delete a collection's on-disk directory and all its data
       * (requests, history, responses, cookies, metadata).
       * @param {string} id @returns {Promise<void>}
       */
      delete: (id) => ipcRenderer.invoke("store:collections:delete", id),
    },

    /**
     * Per-collection blob — assembles { version, collections[], variables }
     * from the new per-file layout for backward-compatible renderer access.
     */
    env: {
      /** @param {string} id @returns {Promise<{ version, collections, variables }>} */
      get: (id) => ipcRenderer.invoke("store:env:get", id),
      /** @param {string} id @param {object} data @returns {Promise<void>} */
      save: (id, data) => ipcRenderer.invoke("store:env:save", id, data),
    },

    /**
     * Lightweight navigation tree (folder hierarchy + requestRef IDs).
     * Never contains full request bodies.
     */
    tree: {
      /** @param {string} collectionId @returns {Promise<{ children: object[] }>} */
      get: (collectionId) => ipcRenderer.invoke("store:tree:get", collectionId),
      /** @param {string} collectionId @param {{ children: object[] }} tree @returns {Promise<void>} */
      save: (collectionId, tree) =>
        ipcRenderer.invoke("store:tree:save", collectionId, tree),
    },

    /**
     * Granular per-request CRUD.
     * Requests are located by ID; no collection context is needed for reads.
     */
    requests: {
      /** @param {string} id @returns {Promise<object|null>} */
      get: (id) => ipcRenderer.invoke("store:requests:get", id),
      /** @param {string} collectionId @param {object} data @returns {Promise<object>} */
      create: (collectionId, data) =>
        ipcRenderer.invoke("store:requests:create", collectionId, data),
      /** @param {string} id @param {object} patch @returns {Promise<object>} */
      update: (id, patch) =>
        ipcRenderer.invoke("store:requests:update", id, patch),
      /** @param {string} id @returns {Promise<void>} */
      delete: (id) => ipcRenderer.invoke("store:requests:delete", id),
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
      /**
       * Delete a history entry and its response payload.
       * @param {string} requestId
       * @param {string} historyId
       * @returns {Promise<void>}
       */
      delete: (requestId, historyId) =>
        ipcRenderer.invoke("store:history:delete", requestId, historyId),
      /**
       * Delete every history entry and response payload for a request.
       * @param {string} requestId
       * @returns {Promise<void>}
       */
      clear: (requestId) =>
        ipcRenderer.invoke("store:history:clear", requestId),
      /**
       * Trim all on-disk history across every collection to at most maxEntries
       * per request.  Sweeps directories the renderer may not have loaded yet.
       * @param {number} maxEntries
       * @returns {Promise<void>}
       */
      trim: (maxEntries) =>
        ipcRenderer.invoke("store:history:trim", maxEntries),
    },

    /**
     * Global + named environment variables.
     * Shape: { version:1, globalVariables:{}, activeEnvironmentId:null, environments:[{id,name,variables}] }
     */
    environments: {
      /** @returns {Promise<object>} */
      get: () => ipcRenderer.invoke("store:environments:get"),
      /** @param {object} data @returns {Promise<void>} */
      save: (data) => ipcRenderer.invoke("store:environments:save", data),
    },

    /**
     * Per-collection persistent cookie jar. Capture/attachment of cookies on
     * requests happens automatically inside the main process; these calls back
     * the cookie-manager UI (view / edit / delete / clear). A jar entry is
     * { name, value, domain, path, hostOnly, secure, httpOnly, sameSite, expires, creation }.
     */
    cookies: {
      /** @param {string} collectionId @returns {Promise<object[]>} */
      list: (collectionId) =>
        ipcRenderer.invoke("store:cookies:list", collectionId),
      /** @param {string} collectionId @param {object} cookie @returns {Promise<void>} */
      upsert: (collectionId, cookie) =>
        ipcRenderer.invoke("store:cookies:upsert", collectionId, cookie),
      /** @param {string} collectionId @param {{name,domain,path}} ident @returns {Promise<void>} */
      delete: (collectionId, ident) =>
        ipcRenderer.invoke("store:cookies:delete", collectionId, ident),
      /** @param {string} collectionId @returns {Promise<void>} */
      clear: (collectionId) =>
        ipcRenderer.invoke("store:cookies:clear", collectionId),
    },
  },

  /**
   * Native HTTP execution — performs the actual outgoing request in the main
   * (Node.js) process using Node's built-in http/https modules, completely
   * bypassing Chromium's networking stack and its CORS enforcement.
   *
   * Descriptor: { method, url, headers, body?, bodyFilePath?, multipart?, timeout?, followRedirects?, verifySsl? }
   *   multipart — { boundary, parts } for a form-data body with file fields; main
   *               reads each file's bytes (only the path crosses IPC) and streams it.
   * Result:     { status, statusText, headers, cookies, body, elapsed, size, consoleLog, error?,
   *              truncated?, bodyRef?, fullSize? }
   *
   * When a response is too large for renderer memory it is spilled to a temp
   * file in the main process: `truncated` is set, `body` carries only a preview,
   * and `bodyRef` redeems the full payload via body.get / body.save below.
   */
  http: {
    execute: (descriptor) => ipcRenderer.invoke("http:execute", descriptor),
    body: {
      /** Fetch the full text of a spilled response body. → { body, size, contentType } | { error } */
      get: (ref) => ipcRenderer.invoke("http:body:get", ref),
      /** Save a spilled response body straight to a user-chosen file. → { ok, path? , reason? } */
      save: (ref, filename) =>
        ipcRenderer.invoke("http:body:save", { ref, filename }),
    },

    /**
     * Live streaming responses (Feature 33). A request executed with
     * `streamCapable: true` whose final 2xx is `text/event-stream` — or is
     * `application/x-ndjson` when it carries `streamNdjson: true` (the global
     * "Stream NDJSON responses live" setting) — resolves http.execute() early
     * with `{ streaming: true, streamId, sse, ... }` and then forwards its body
     * over these push channels keyed by `streamId`:
     *   http:stream:data  → { streamId, kind: "event"|"line", index, ts,
     *                          event?|data?, totalBytes, count }
     *   http:stream:end   → { streamId, ts, totalBytes, eventCount, elapsed,
     *                          status, bodyRef, aborted, lastEvents }
     *   http:stream:error → { streamId, ts, totalBytes, eventCount, elapsed,
     *                          status, bodyRef, name, message, lastEvents }
     *
     * lastEvents is the final handful of events (data capped) the renderer keeps
     * in the Timeline record it writes when the stream ends.
     *
     * abort() stops a running stream (its end push reports aborted:true);
     * save() writes the bytes received so far on a running stream to a file
     * (after it ends, redeem the end push's bodyRef via http.body.save).
     * onData/onEnd/onError/onHint register a push listener and RETURN an
     * unsubscribe function — call it to detach the listener (no leaks across
     * reloads).
     */
    stream: {
      abort: (streamId) =>
        ipcRenderer.invoke("http:stream:abort", { streamId }),
      save: (streamId, filename) =>
        ipcRenderer.invoke("http:stream:save", { streamId, filename }),
      /** @param {(payload: object) => void} cb @returns {() => void} unsubscribe */
      onData: (cb) => {
        const listener = (_event, payload) => cb(payload);
        ipcRenderer.on("http:stream:data", listener);
        return () => ipcRenderer.removeListener("http:stream:data", listener);
      },
      /** @param {(payload: object) => void} cb @returns {() => void} unsubscribe */
      onEnd: (cb) => {
        const listener = (_event, payload) => cb(payload);
        ipcRenderer.on("http:stream:end", listener);
        return () => ipcRenderer.removeListener("http:stream:end", listener);
      },
      /** @param {(payload: object) => void} cb @returns {() => void} unsubscribe */
      onError: (cb) => {
        const listener = (_event, payload) => cb(payload);
        ipcRenderer.on("http:stream:error", listener);
        return () => ipcRenderer.removeListener("http:stream:error", listener);
      },
      /**
       * Headers-time heads-up for a buffered application/x-ndjson response whose
       * live streaming is off: `{ streamId }`. Fires while the request is still
       * running (before its buffered body lands) so the renderer can show a
       * "streaming is off" hint; no end/error follows — the normal response does.
       * @param {(payload: object) => void} cb @returns {() => void} unsubscribe
       */
      onHint: (cb) => {
        const listener = (_event, payload) => cb(payload);
        ipcRenderer.on("http:stream:hint", listener);
        return () => ipcRenderer.removeListener("http:stream:hint", listener);
      },
    },
  },

  /**
   * WebSocket client (Feature 32) — the socket lives in the main process; the
   * renderer drives it over IPC and receives a live stream of status changes and
   * inbound frames.
   *
   * open() resolves to { id }; that id keys every later send/close/ping and tags
   * the ws:status / ws:message pushes so a single console can demultiplex them.
   *
   *   open(opts)  opts = { url, headers?, subprotocols?, verifySsl?, proxy?,
   *                        proxyUsername?, proxyPassword?, proxyBypass?, timeout? }
   *   send({ id, data })   → { ok, reason? }
   *   close({ id, code?, reason? }) → { ok, reason? }
   *   ping({ id })         → { ok, reason? }
   *
   * onStatus(cb) / onMessage(cb) register a push listener and RETURN an
   * unsubscribe function — call it to detach the listener (no leaks across reloads).
   */
  ws: {
    open: (opts) => ipcRenderer.invoke("ws:open", opts),
    send: (args) => ipcRenderer.invoke("ws:send", args),
    close: (args) => ipcRenderer.invoke("ws:close", args),
    ping: (args) => ipcRenderer.invoke("ws:ping", args),
    /** @param {(status: object) => void} cb @returns {() => void} unsubscribe */
    onStatus: (cb) => {
      const listener = (_event, payload) => cb(payload);
      ipcRenderer.on("ws:status", listener);
      return () => ipcRenderer.removeListener("ws:status", listener);
    },
    /** @param {(frame: object) => void} cb @returns {() => void} unsubscribe */
    onMessage: (cb) => {
      const listener = (_event, payload) => cb(payload);
      ipcRenderer.on("ws:message", listener);
      return () => ipcRenderer.removeListener("ws:message", listener);
    },
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
    /**
     * Clear all Electron session storage (cookies, localStorage, cache, …)
     * so the next OAuth login flow starts with a completely fresh browser session.
     * No-op in dev-server / plain-browser context.
     * @returns {Promise<void>}
     */
    clearSession: () => ipcRenderer.invoke("oauth:clear-session"),
  },

  /**
   * Native response previews — each overlays an isolated WebContentsView on the
   * response body pane. Bounds shape: { x, y, width, height } (integer pixels,
   * viewport-relative).
   *
   *   html — loads the original request URL so the page renders natively.
   *   pdf  — Chromium's native pdfium viewer; the renderer passes the PDF bytes
   *          as base64 and the main process writes them to a temp file.
   */
  preview: {
    html: {
      loadUrl: (url, bounds) =>
        ipcRenderer.invoke("preview:html:load-url", url, bounds),
      resize: (bounds) => ipcRenderer.invoke("preview:html:resize", bounds),
      show: (bounds) => ipcRenderer.invoke("preview:html:show", bounds),
      hide: () => ipcRenderer.invoke("preview:html:hide"),
      capture: () => ipcRenderer.invoke("preview:html:capture"),
      destroy: () => ipcRenderer.invoke("preview:html:destroy"),
    },
    pdf: {
      loadFile: (base64, bounds) =>
        ipcRenderer.invoke("preview:pdf:load-file", { base64 }, bounds),
      resize: (bounds) => ipcRenderer.invoke("preview:pdf:resize", bounds),
      show: (bounds) => ipcRenderer.invoke("preview:pdf:show", bounds),
      hide: () => ipcRenderer.invoke("preview:pdf:hide"),
      destroy: () => ipcRenderer.invoke("preview:pdf:destroy"),
    },
  },

  functions: {
    invoke: (fn, args) => ipcRenderer.invoke("functions:invoke", fn, args),
  },

  /**
   * Native file picker for the Certificates settings panel (mTLS / custom CA).
   * Returns the chosen absolute path, or null when cancelled. `kind` selects
   * sensible default file-type filters: "pem" | "key" | "pfx" | "ca". Only the
   * path is returned — the main process reads cert bytes at send time, so no
   * file content crosses IPC here.
   *
   * @param {"pem"|"key"|"pfx"|"ca"} kind
   * @returns {Promise<string|null>}
   */
  dialog: {
    pickFile: (kind) => ipcRenderer.invoke("dialog:file:pick", { kind }),
  },

  /**
   * Collection import — opens a native file dialog and returns the file content.
   * Returns null when the user cancels without selecting a file.
   *
   * @returns {Promise<{ filename: string, content: string }|null>}
   */
  import: {
    file: {
      open: () => ipcRenderer.invoke("import:file:open"),
    },
  },

  /**
   * Collection export — opens a native save dialog and writes the given content.
   * Returns true on success, false if the user cancelled.
   *
   * @param {string} filename  Suggested filename (e.g. "My_Collection.json")
   * @param {string} content   File content to write (base64 when encoding is "base64")
   * @param {Array}  [filters] Save-dialog file-type filters
   * @param {string} [encoding] "base64" to decode bytes before writing; UTF-8 otherwise
   * @returns {Promise<boolean>}
   */
  export: {
    file: {
      save: (filename, content, filters, encoding) =>
        ipcRenderer.invoke("export:file:save", {
          filename,
          content,
          filters,
          encoding,
        }),
    },
  },

  /**
   * Whole-workspace backup. The main process owns the native file dialogs, all
   * encryption and every secret value; the renderer only collects the secret
   * mode and (for password mode) the plaintext password it passes back here.
   */
  backup: {
    /**
     * Create a backup. `opts.mode` is "none" | "machine" | "password";
     * `opts.password` is required for password mode.
     * @returns {Promise<{ ok: boolean, canceled?: boolean, error?: string }>}
     */
    export: (opts) => ipcRenderer.invoke("backup:export", opts),
    /**
     * Pick and validate a backup file. Returns its path and secret mode so the
     * renderer can decide whether to prompt for a password.
     * @returns {Promise<{ ok: boolean, canceled?: boolean, filePath?: string,
     *                      secretsMode?: string, error?: string }>}
     */
    prepare: () => ipcRenderer.invoke("backup:prepare"),
    /**
     * Apply a backup. `opts.mode` is "merge" | "replace"; `opts.password` is
     * needed only to recover password-protected secrets.
     * @returns {Promise<{ ok: boolean, reason?: string, error?: string }>}
     */
    import: (opts) => ipcRenderer.invoke("backup:import", opts),
  },

  /**
   * UI bridges to native chrome that the renderer cannot create itself.
   */
  ui: {
    contextMenu: {
      /**
       * Show a native OS context menu at (x, y) and resolve with the id of the
       * clicked item, or null if the menu was dismissed.
       *
       * @param {{
       *   items: Array<{ id?: string, label?: string, type?: "separator", enabled?: boolean }>,
       *   x?: number,
       *   y?: number,
       * }} options
       * @returns {Promise<string|null>}
       */
      show: ({ items, x, y } = {}) =>
        ipcRenderer.invoke("ui:context-menu:show", { items, x, y }),

      /**
       * Show a Cut / Copy / Paste / Select All menu for the focused text input,
       * optionally with custom items appended (extraItems) and/or prepended
       * (opts.leadingItems) — both support separator / checkbox / radio / plain
       * (id + label) entries. Resolves the clicked custom item's id, or null (the
       * native edit roles resolve null too).
       *
       * @param {number} x
       * @param {number} y
       * @param {Array<{ id?: string, label?: string, type?: "separator"|"checkbox"|"radio", checked?: boolean, enabled?: boolean }>} [extraItems]
       * @param {{ leadingItems?: Array<object> }} [opts]
       * @returns {Promise<string|null>}
       */
      edit: (x, y, extraItems, opts) =>
        ipcRenderer.invoke("ui:context-menu:edit", { x, y, extraItems, opts }),
    },

    openThemeEditor: () => ipcRenderer.invoke("ui:open-theme-editor"),
  },

  /**
   * Diagnostics — mirror critical renderer errors (uncaught exceptions and
   * unhandled promise rejections) to the main process so they land in the
   * persistent log alongside main-process diagnostics. Fire-and-forget: the
   * renderer never needs the result, and a logging failure must not surface.
   *
   * @param {{ source?: string, message?: string, stack?: string }} info
   * @returns {Promise<null>}
   */
  diagnostics: {
    reportError: (info) => ipcRenderer.invoke("diagnostics:error:report", info),
  },
});
