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
ipcRenderer.on("hippo:ui-font-change", (_event, direction) => {
  window.dispatchEvent(
    new CustomEvent("hippo:ui-font-change", { detail: direction }),
  );
});

// Collection import (file / URL / cURL) and "Export All" were removed from the
// native File menu — those flows now start in the renderer (Collections dialog
// Import/Export buttons; the tree toolbar's [+] menu for cURL), which dispatch
// the hippo:* events directly, so no menu:* bridge is needed for them here.

// Edit-menu Undo/Redo (and their ⌘Z/⌘⇧Z accelerators) are routed here instead
// of using native roles, so the focused multi-line code editor can run its own
// snapshot undo/redo; app.js falls back to document.execCommand for plain inputs.
ipcRenderer.on("menu:edit-action", (_event, action) => {
  window.dispatchEvent(
    new CustomEvent("hippo:edit-action", { detail: { action } }),
  );
});

ipcRenderer.on("menu:backup-export", () => {
  window.dispatchEvent(new CustomEvent("hippo:backup-export-requested"));
});

ipcRenderer.on("menu:backup-import", () => {
  window.dispatchEvent(new CustomEvent("hippo:backup-import-requested"));
});

// Keyboard-shortcut / menu commands (Feature 47). Each fires from both the
// menu accelerator and a menu click; app.js binds the matching command.
ipcRenderer.on("menu:new-request", () => {
  window.dispatchEvent(new CustomEvent("hippo:new-request"));
});

ipcRenderer.on("menu:new-collection", () => {
  window.dispatchEvent(new CustomEvent("hippo:new-collection"));
});

ipcRenderer.on("menu:new-ws-request", () => {
  window.dispatchEvent(new CustomEvent("hippo:new-ws-request"));
});

ipcRenderer.on("menu:open-settings", () => {
  window.dispatchEvent(new CustomEvent("hippo:open-settings"));
});

ipcRenderer.on("menu:keyboard-shortcuts", () => {
  window.dispatchEvent(new CustomEvent("hippo:keyboard-shortcuts"));
});

ipcRenderer.on("menu:show-about", () => {
  window.dispatchEvent(new CustomEvent("hippo:show-about"));
});

ipcRenderer.on("menu:cycle-layout", () => {
  window.dispatchEvent(new CustomEvent("hippo:cycle-layout"));
});

ipcRenderer.on("theme:preview", (_event, themeData) => {
  window.dispatchEvent(
    new CustomEvent("hippo:theme-preview", { detail: themeData }),
  );
});

ipcRenderer.on("theme:editor:notify", (_event, customThemes) => {
  window.dispatchEvent(
    new CustomEvent("hippo:custom-themes-changed", { detail: customThemes }),
  );
});

ipcRenderer.on("theme:editor:apply", (_event, themeId) => {
  window.dispatchEvent(
    new CustomEvent("hippo:theme-apply", { detail: themeId }),
  );
});

// Auto-update (Feature 36): the main-process updater pushes each lifecycle event
// on an `updater:*` channel; mirror each into a `hippo:updater-*` DOM event so
// app.js (toasts) and the Settings → About panel (status line) can react.
ipcRenderer.on("updater:checking", (_event, detail) => {
  window.dispatchEvent(new CustomEvent("hippo:updater-checking", { detail }));
});
ipcRenderer.on("updater:available", (_event, detail) => {
  window.dispatchEvent(new CustomEvent("hippo:updater-available", { detail }));
});
ipcRenderer.on("updater:not-available", (_event, detail) => {
  window.dispatchEvent(
    new CustomEvent("hippo:updater-not-available", { detail }),
  );
});
ipcRenderer.on("updater:progress", (_event, detail) => {
  window.dispatchEvent(new CustomEvent("hippo:updater-progress", { detail }));
});
ipcRenderer.on("updater:downloaded", (_event, detail) => {
  window.dispatchEvent(new CustomEvent("hippo:updater-downloaded", { detail }));
});
ipcRenderer.on("updater:error", (_event, detail) => {
  window.dispatchEvent(new CustomEvent("hippo:updater-error", { detail }));
});

contextBridge.exposeInMainWorld("hippo", {
  /**
   * Explicit sentinel that the renderer uses to detect the Electron environment.
   * Always true when loaded via Electron's preload; never present in a plain
   * browser context served by the Go dev server.
   */
  isElectron: true,

  /** Platform string: 'darwin' | 'win32' | 'linux' */
  platform: process.platform,

  /**
   * True in a sandboxed store build (Mac App Store / Microsoft Store), where the
   * self-updater and the `hippo` CLI launcher are unavailable. Read directly from
   * the Electron-set process globals (no IPC needed). The renderer uses it to hide
   * the auto-update toggle in Settings → About. See src/app/store-build.js.
   */
  isStoreBuild: process.mas === true || process.windowsStore === true,

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
   *   macOS:   ~/Library/Application Support/Rest Hippo/
   *   Linux:   ~/.config/Rest Hippo/
   *   Windows: %APPDATA%\Rest Hippo\
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

    /**
     * Collection lifecycle plus the per-collection blob, which assembles
     * { version, collections[], variables, headers } from the per-file layout for
     * backward-compatible renderer access. `headers` are the collection-level
     * default HTTP headers.
     */
    collections: {
      /** @param {string} id @returns {Promise<{ version, collections, variables, headers }>} */
      get: (id) => ipcRenderer.invoke("store:collections:get", id),
      /** @param {string} id @param {object} data @returns {Promise<void>} */
      save: (id, data) =>
        ipcRenderer.invoke("store:collections:save", id, data),
      /**
       * Granular save of ONLY the navigation tree (folder structure + folder
       * variables + profile overrides + requestRef IDs) — for a folder-variable
       * change. Send a body-stripped tree; request files are left untouched.
       * @param {string} id @param {object} data @returns {Promise<void>}
       */
      saveTree: (id, data) =>
        ipcRenderer.invoke("store:collections:save-tree", id, data),
      /**
       * Permanently delete a collection's on-disk directory and all its data
       * (requests, history, responses, cookies, metadata).
       * @param {string} id @returns {Promise<void>}
       */
      delete: (id) => ipcRenderer.invoke("store:collections:delete", id),
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
     * A collection's global + named environment variables (scoped per
     * collection — pass the target collection's ID).
     * Shape: { version:1, globalVariables:[], activeEnvironmentId:null, environments:[{id,name,variables}] }
     */
    environments: {
      /** @param {string} collectionId @returns {Promise<object>} */
      get: (collectionId) =>
        ipcRenderer.invoke("store:environments:get", collectionId),
      /** @param {string} collectionId @param {object} data @returns {Promise<void>} */
      save: (collectionId, data) =>
        ipcRenderer.invoke("store:environments:save", collectionId, data),
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
    /**
     * Stop an in-flight buffered (non-streaming) request — the Stop button.
     * Destroys the underlying socket in the main process so a slow or large
     * download actually ends, rather than running to completion after the
     * renderer has discarded the result. Pass the id minted for the send (the
     * same id used as streamId). A live streaming response uses stream.abort
     * below instead. → { ok } | { ok: false, reason }
     */
    abort: (streamId) => ipcRenderer.invoke("http:abort", { streamId }),
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
   * Sandboxed scripting (Feature 25) — pre-request / after-response scripts run
   * in a locked-down vm context in the main process; the renderer never executes
   * arbitrary code. Each call is a pure round-trip: the renderer hands in a
   * snapshot, main runs the script and returns the result envelope.
   *
   *   runPre({ code, request, environment, variables })
   *     → { request, varWrites, logs, error }   (request = mutated outgoing req)
   *   runPost({ code, request, response, environment, variables })
   *     → { varWrites, logs, error }
   *   validate(code)  → { error }   (compile-only; for live syntax squiggles)
   *
   * varWrites = [{ scope, name, value }] (scope: global|environment|collection);
   * logs = [{ level, text }]; error = null | { name, message, line?, col? }.
   */
  script: {
    runPre: (payload) => ipcRenderer.invoke("script:run-pre", payload),
    runPost: (payload) => ipcRenderer.invoke("script:run-post", payload),
    validate: (code) => ipcRenderer.invoke("script:validate", code),
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
   * via window.hippo.http.execute and do not need a popup.
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
      /**
       * Read a file the user typed as a path into the import modal's smart
       * field. Returns { filename, content } for a readable regular file, or
       * null for a bad/empty path, an unreadable file, or a Mac App Store build
       * (where the Browse… native picker is the sandbox-safe fallback).
       * @param {string} filePath
       * @returns {Promise<{ filename: string, content: string }|null>}
       */
      read: (filePath) => ipcRenderer.invoke("import:file:read", filePath),
      /**
       * Given a list of local file paths, return the subset that are not
       * readable files on disk. Used by the cURL importer to warn only about
       * `-F` file fields whose path is actually missing.
       * @param {string[]} paths
       * @returns {Promise<string[]>}
       */
      checkMissing: (paths) => ipcRenderer.invoke("import:files:check", paths),
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
   * Native "Rest Hippo v1" collection archive. The renderer builds the plaintext
   * archive (it already holds the decrypted tree + environments); the main
   * process owns the secret crypto and the file dialog.
   */
  collectionArchive: {
    /**
     * Save an archive. Call first with no password: if the archive carries
     * secrets the result is `{ needsPassword: true }` (nothing written) so the
     * renderer can prompt and call again with the password.
     * @param {{ archive: object, password?: string, filename?: string }} opts
     * @returns {Promise<{ ok?: boolean, canceled?: boolean, needsPassword?: boolean, error?: string }>}
     */
    save: (opts) => ipcRenderer.invoke("collection-archive:save", opts),
    /**
     * Decrypt a password-protected archive's secrets for import. Returns
     * `{ ok:false, reason:"bad-password" }` on a wrong password so the renderer
     * can re-prompt.
     * @param {{ archive: object, password?: string }} opts
     * @returns {Promise<{ ok: boolean, archive?: object, reason?: string, error?: string }>}
     */
    decrypt: (opts) => ipcRenderer.invoke("collection-archive:decrypt", opts),
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
   * Selectable secret-storage backend (app key / OS keychain / master password).
   * The main process owns the config, keys, and the re-encryption migration; the
   * renderer Security panel only chooses a mode and supplies a master password.
   * set-mode and unlock reload the window on success.
   */
  secretStorage: {
    /**
     * Current backend + session state.
     * @returns {Promise<{ mode: string, locked: boolean, available: boolean,
     *                      hasPassword: boolean }>}
     */
    getMode: () => ipcRenderer.invoke("secret-storage:get-mode"),
    /**
     * Switch the at-rest backend (re-encrypts every secret). `opts.mode` is
     * "app-key" | "os-keychain" | "master-password"; `opts.password` is required
     * when switching TO master-password.
     * @returns {Promise<{ ok: boolean, reason?: string, failures?: Array }>}
     */
    setMode: (opts) => ipcRenderer.invoke("secret-storage:set-mode", opts),
    /**
     * Unlock a locked master-password session for this run.
     * @returns {Promise<{ ok: boolean, reason?: string }>}
     */
    unlock: (password) =>
      ipcRenderer.invoke("secret-storage:unlock", { password }),
    /** Drop the in-memory master key (re-locks secrets). */
    lock: () => ipcRenderer.invoke("secret-storage:lock"),
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
       * Items may carry an `iconDataUrl` (a small PNG data URL) shown as the
       * item's icon — on macOS it is treated as a template image.
       *
       * @param {{
       *   items: Array<{ id?: string, label?: string, type?: "separator"|"checkbox"|"radio", checked?: boolean, enabled?: boolean, iconDataUrl?: string }>,
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

    /**
     * Open a vetted https URL in the OS browser — the About dialog's voluntary
     * donation link. Rejected (returns false) for any non-https scheme.
     * @param {string} url
     * @returns {Promise<boolean>}
     */
    openExternal: (url) => ipcRenderer.invoke("ui:open-external", url),
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

  /**
   * Auto-update (Feature 36). `check()` runs an on-demand update check;
   * `install()` quits and installs an already-downloaded update (user-confirmed,
   * wired to the "Restart" toast action / Settings button). Update lifecycle is
   * delivered via the `hippo:updater-*` DOM events dispatched above, not here.
   */
  updater: {
    check: () => ipcRenderer.invoke("updater:check"),
    install: () => ipcRenderer.invoke("updater:install"),
  },

  /**
   * Read-only app / build metadata for the Settings → About panel (version,
   * build, engine versions). Mirrors the native About dialog's header.
   */
  app: {
    info: () => ipcRenderer.invoke("app:info:get"),
  },

  /**
   * Command-line launcher — install / remove the `hippo` shell command so the
   * app can be started from a terminal (the VS Code "Install 'code' command in
   * PATH" equivalent). `status()` reports availability + whether it's installed;
   * `install()`/`uninstall()` return `{ ok, reason?, path?, onPath? }`. See
   * src/app/cli-launcher.js.
   */
  cli: {
    /** @returns {Promise<{ available: boolean, installed: boolean, platform: string, target: string|null }>} */
    status: () => ipcRenderer.invoke("cli:status"),
    /** @returns {Promise<{ ok: boolean, reason?: string, path?: string, onPath?: boolean }>} */
    install: () => ipcRenderer.invoke("cli:install"),
    /** @returns {Promise<{ ok: boolean, reason?: string, removed?: boolean }>} */
    uninstall: () => ipcRenderer.invoke("cli:uninstall"),
  },
});
