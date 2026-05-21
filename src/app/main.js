// main.js — Electron main process for wurl
"use strict";

const { app, BrowserWindow, WebContentsView, ipcMain, shell, Menu, nativeImage, session } = require("electron");
const fs           = require("fs");
const path         = require("path");
const http         = require("http");
const https        = require("https");
const net          = require("net");
const { spawn }    = require("child_process");
const { URL }      = require("url");

const { Stores }   = require("./store/stores");

const isDev = process.argv.includes("--dev");

// devPort is resolved asynchronously inside app.whenReady().
// It is declared here so createWindow() can close over the final value.
let devPort = 0;

// Handle to the spawned Go dev-server process (dev mode only, no SERVER_PORT env).
let _devServerProcess = null;

// ─── HTML Preview state ────────────────────────────────────────────────────────
// Tracks the main BrowserWindow and an optional WebContentsView overlay that
// renders live HTML responses inside the response body pane.
let _mainWin           = null;   // set once createWindow() runs
let _htmlPreviewView   = null;   // WebContentsView instance, created lazily
let _htmlPreviewAdded  = false;  // whether the view is currently a child of contentView

// ─── Storage layer ─────────────────────────────────────────────────────────────
// The Stores factory is created lazily on first IPC call (after app is ready)
// so that app.getPath('userData') is available.
//
// New filesystem layout (under the platform user-data directory):
//   collections/
//     index.json                         ← manifest (environments, settings)
//     <collId>/
//       metadata.json                    ← name + variables
//       tree.json                        ← lightweight nav tree
//       requests/<reqId>.json            ← one file per request
//       history/<reqId>/<histId>.json    ← execution metadata (no body)
//       responses/<reqId>/<histId>.json  ← full response payload (lazy)

let _stores = null;

/**
 * Return the shared Stores factory, creating it on first call.
 * Safe to call from any ipcMain handler.
 * @returns {Stores}
 */
function getStores() {
  if (!_stores) {
    _stores = new Stores(app.getPath("userData"));
  }
  return _stores;
}

/**
 * Wrap a store call so errors are logged and a safe fallback is returned
 * instead of triggering an unhandled rejection in the renderer.
 *
 * @param {string}   channel   IPC channel name (for log context)
 * @param {Function} fn        Synchronous store function
 * @param {*}        fallback  Value returned on error
 */
function safeCall(channel, fn, fallback = null) {
  try {
    return fn();
  } catch (err) {
    console.error(`[main] ${channel} error:`, err.message);
    return fallback;
  }
}

// ─── Store IPC ────────────────────────────────────────────────────────────────
// Register handlers before app.whenReady() so they are ready the moment the
// renderer process makes its first invoke() call.
(function initStoreIPC() {
  // ── Manifest (global environments list + settings) ──────────────────────────

  ipcMain.handle("store:manifest:get", () =>
    safeCall("store:manifest:get",
      () => getStores().collectionStore().getManifest(),
      { version: 2, environments: [], activeEnvironmentId: null, settings: {} },
    ),
  );

  ipcMain.handle("store:manifest:save", (_event, data) =>
    safeCall("store:manifest:save",
      () => { getStores().collectionStore().saveManifest(data); },
    ),
  );

  // ── Environment blob (assembles / decomposes per-file layout) ───────────────
  // Used by data-store.js to keep the same high-level collections API.

  ipcMain.handle("store:env:get", (_event, id) =>
    safeCall("store:env:get",
      () => getStores().environmentStore().getEnvironment(id),
      { version: 1, collections: [] },
    ),
  );

  ipcMain.handle("store:env:save", (_event, id, data) =>
    safeCall("store:env:save",
      () => { getStores().environmentStore().saveEnvironment(id, data); },
    ),
  );

  // ── Collection navigation tree ──────────────────────────────────────────────

  ipcMain.handle("store:tree:get", (_event, collectionId) =>
    safeCall("store:tree:get",
      () => getStores().treeStore().getTree(collectionId),
      { children: [] },
    ),
  );

  ipcMain.handle("store:tree:save", (_event, collectionId, tree) =>
    safeCall("store:tree:save",
      () => { getStores().treeStore().saveTree(collectionId, tree); },
    ),
  );

  // ── Granular request CRUD ───────────────────────────────────────────────────

  ipcMain.handle("store:requests:get", (_event, id) =>
    safeCall("store:requests:get",
      () => getStores().requestStore().getRequest(id),
    ),
  );

  ipcMain.handle("store:requests:create", (_event, collectionId, req) =>
    safeCall("store:requests:create",
      () => getStores().requestStore().createRequest(collectionId, req),
    ),
  );

  ipcMain.handle("store:requests:update", (_event, id, patch) =>
    safeCall("store:requests:update",
      () => getStores().requestStore().updateRequest(id, patch),
    ),
  );

  ipcMain.handle("store:requests:delete", (_event, id) =>
    safeCall("store:requests:delete",
      () => { getStores().requestStore().deleteRequest(id); },
    ),
  );

  // ── Request execution history ───────────────────────────────────────────────

  ipcMain.handle("store:history:list", (_event, requestId, options) =>
    safeCall("store:history:list",
      () => getStores().historyStore().listHistory(requestId, options ?? {}),
      { items: [], nextCursor: "" },
    ),
  );

  ipcMain.handle("store:history:add", (_event, requestId, entry, response) =>
    safeCall("store:history:add",
      () => getStores().historyStore().addHistory(requestId, entry, response),
    ),
  );

  ipcMain.handle("store:history:response:get", (_event, requestId, historyId) =>
    safeCall("store:history:response:get",
      () => getStores().historyStore().getHistoryResponse(requestId, historyId),
    ),
  );
})();

// ─── HTTP Execute IPC ─────────────────────────────────────────────────────────
// Performs the actual outgoing HTTP/HTTPS request in the main (Node.js) process
// so the sandboxed renderer never touches the network directly.
// Returns a rich result object including a verbose console log.
(function initHttpIPC() {
  /**
   * Perform one HTTP request leg (no redirect logic here — handled below).
   * Returns a Promise that always resolves (never rejects) with a result object.
   *
   * @param {object}   desc        - Normalised request descriptor
   * @param {string[]} consoleLog  - Mutable array for verbose output lines
   * @param {number}   startTime   - Date.now() at the very start of the call
   * @param {number}   redirects   - How many redirects have been followed so far
   */
  function doRequest(desc, consoleLog, startTime, redirects) {
    const {
      method          = "GET",
      url: rawUrl,
      headers         = {},
      body            = null,
      bodyFilePath    = null,
      timeout         = 30000,
      followRedirects = true,
      verifySsl       = true,
      maxRedirects    = 10,
    } = desc;

    return new Promise((resolve) => {
      // ── Parse URL ──────────────────────────────────────────────────────────
      let parsed;
      try {
        parsed = new URL(rawUrl);
      } catch (e) {
        consoleLog.push(`* URL parse error: ${e.message}`);
        resolve({
          status: 0, statusText: "", headers: {}, cookies: [], body: "",
          elapsed: Date.now() - startTime, size: 0, consoleLog,
          error: { name: "TypeError", message: e.message },
        });
        return;
      }

      const isHttps    = parsed.protocol === "https:";
      const lib        = isHttps ? https : http;
      const defaultPort = isHttps ? 443 : 80;
      const port       = parsed.port ? parseInt(parsed.port, 10) : defaultPort;
      const effectiveMethod = method.toUpperCase();

      // ── Resolve body ───────────────────────────────────────────────────────
      const reqHeaders = { ...headers };
      let bodyBuffer   = null;

      if (redirects === 0) {
        if (bodyFilePath) {
          try {
            bodyBuffer = fs.readFileSync(bodyFilePath);
            if (!reqHeaders["Content-Length"])
              reqHeaders["Content-Length"] = String(bodyBuffer.length);
          } catch (e) {
            consoleLog.push(`* File read error: ${e.message}`);
          }
        } else if (body) {
          bodyBuffer = Buffer.from(body, "utf8");
          if (!reqHeaders["Content-Length"])
            reqHeaders["Content-Length"] = String(bodyBuffer.length);
        }
      }

      // ── Outgoing request log ──────────────────────────────────────────────
      const httpVersion = isHttps ? "HTTP/2" : "HTTP/1.1";
      consoleLog.push(`> ${effectiveMethod} ${parsed.pathname}${parsed.search} ${httpVersion}`);
      consoleLog.push(`> Host: ${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`);
      Object.entries(reqHeaders).forEach(([k, v]) => consoleLog.push(`> ${k}: ${v}`));
      consoleLog.push(">");

      // ── Log request body (if any) with "|" prefix ─────────────────────
      if (bodyBuffer) {
        consoleLog.push("");
        bodyBuffer.toString("utf8").split("\n").forEach(line => consoleLog.push(`| ${line}`));
        consoleLog.push("");
        consoleLog.push("* We are completely uploaded and fine");
      }

      // ── Make the request ───────────────────────────────────────────────────
      consoleLog.push(`* Trying to resolve host '${parsed.hostname}'...`);
      const options = {
        hostname: parsed.hostname,
        port,
        path: parsed.pathname + parsed.search,
        method: effectiveMethod,
        headers: reqHeaders,
        timeout,
        rejectUnauthorized: verifySsl,
      };

      const req = lib.request(options, (res) => {
        const code    = res.statusCode;
        const phrase  = res.statusMessage;

        // ── Redirect handling ────────────────────────────────────────────────
        if (followRedirects && [301, 302, 303, 307, 308].includes(code)) {
          const location = res.headers["location"];
          consoleLog.push(`< ${httpVersion} ${code} ${phrase}`);
          Object.entries(res.headers).forEach(([k, v]) => {
            const vals = Array.isArray(v) ? v : [v];
            vals.forEach(vi => consoleLog.push(`< ${k}: ${vi}`));
          });
          consoleLog.push("<");
          consoleLog.push("");

          if (!location) {
            consoleLog.push("* Redirect missing Location header — stopping");
            res.resume();
            resolve({
              status: code, statusText: phrase,
              headers: flatHeaders(res.headers), cookies: extractCookies(res.headers),
              body: "", elapsed: Date.now() - startTime, size: 0, consoleLog,
            });
            return;
          }
          if (redirects >= maxRedirects) {
            consoleLog.push(`* Too many redirects (max ${maxRedirects})`);
            res.resume();
            resolve({
              status: code, statusText: phrase,
              headers: flatHeaders(res.headers), cookies: extractCookies(res.headers),
              body: "", elapsed: Date.now() - startTime, size: 0, consoleLog,
              error: { name: "RedirectError", message: `Too many redirects (max ${maxRedirects})` },
            });
            return;
          }

          let redirectUrl;
          try { redirectUrl = new URL(location, rawUrl).toString(); }
          catch (_) { redirectUrl = location; }

          // HTTP 303 → always GET; POST 301/302 → GET (browser convention)
          const newMethod = (code === 303 || ([301, 302].includes(code) && effectiveMethod === "POST"))
            ? "GET" : effectiveMethod;

          consoleLog.push(`* Connection to host ${parsed.hostname} left intact`);
          consoleLog.push(`* Issue another request to this URL: '${redirectUrl}'`);
          if (newMethod !== effectiveMethod) {
            consoleLog.push(`* Switch to ${newMethod}`);
          }
          res.resume(); // drain the redirect body

          doRequest(
            { ...desc, method: newMethod, url: redirectUrl,
              body:         newMethod === "GET" ? null : body,
              bodyFilePath: newMethod === "GET" ? null : bodyFilePath },
            consoleLog, startTime, redirects + 1
          ).then(resolve);
          return;
        }

        // ── Normal response ──────────────────────────────────────────────────
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const elapsed   = Date.now() - startTime;
          const rawBody   = Buffer.concat(chunks);
          const bodyText  = rawBody.toString("utf8");
          const size      = rawBody.length;

          consoleLog.push(`< ${httpVersion} ${code} ${phrase}`);
          Object.entries(res.headers).forEach(([k, v]) => {
            const vals = Array.isArray(v) ? v : [v];
            vals.forEach(vi => consoleLog.push(`< ${k}: ${vi}`));
          });
          consoleLog.push("<");
          consoleLog.push("");
          consoleLog.push(`* Received ${size} B chunk`);
          consoleLog.push(`* Connection to host ${parsed.hostname} left intact`);

          resolve({
            status: code, statusText: phrase,
            headers: flatHeaders(res.headers),
            cookies: extractCookies(res.headers),
            body: bodyText, elapsed, size, consoleLog,
          });
        });

        res.on("error", (err) => {
          const elapsed = Date.now() - startTime;
          consoleLog.push(`* Stream error: ${err.message}`);
          resolve({
            status: code, statusText: phrase, headers: {}, cookies: [],
            body: "", elapsed, size: 0, consoleLog,
            error: { name: "StreamError", message: err.message },
          });
        });
      });

      req.on("socket", (socket) => {
        // ── DNS resolution ──────────────────────────────────────────────────
        socket.on("lookup", (err, address, _family, hostname) => {
          if (err) {
            consoleLog.push(`* Could not resolve host '${hostname}': ${err.message}`);
          } else {
            consoleLog.push(`* Resolved '${hostname}' → ${address}`);
            consoleLog.push(`* Trying ${address}:${port}...`);
          }
        });

        // ── TCP connection established ───────────────────────────────────────
        socket.on("connect", () => {
          const remoteAddr = socket.remoteAddress;
          const remotePort = socket.remotePort;
          consoleLog.push(`* Connected to ${parsed.hostname} (${remoteAddr}) port ${remotePort}`);
          if (isHttps) {
            consoleLog.push(`* Performing TLS handshake with '${parsed.hostname}'...`);
          }
        });

        // ── TLS handshake complete (HTTPS only) ─────────────────────────────
        if (isHttps) {
          socket.on("secureConnect", () => {
            const protocol = socket.getProtocol();
            const cipher   = socket.getCipher();
            consoleLog.push(
              `* SSL connection using ${protocol} / ${cipher.standardName || cipher.name}`
            );
            const alpn = socket.alpnProtocol;
            if (alpn && alpn !== false) {
              consoleLog.push(`* ALPN: server accepted '${alpn}'`);
            }
          });
        }
      });

      req.on("timeout", () => {
        consoleLog.push(`* Timed out after ${timeout}ms`);
        req.destroy(new Error(`Request timed out after ${timeout}ms`));
      });

      req.on("error", (err) => {
        const elapsed = Date.now() - startTime;
        consoleLog.push(`* ${err.message}`);
        resolve({
          status: 0, statusText: "", headers: {}, cookies: [],
          body: "", elapsed, size: 0, consoleLog,
          error: { name: err.code || err.name || "NetworkError", message: err.message },
        });
      });

      if (bodyBuffer) req.write(bodyBuffer);
      req.end();
    });
  }

  /** Flatten Node's multi-value header object into a plain key→string map. */
  function flatHeaders(hdrs) {
    const out = {};
    Object.entries(hdrs).forEach(([k, v]) => {
      out[k] = Array.isArray(v) ? v.join(", ") : v;
    });
    return out;
  }

  /** Extract Set-Cookie header values as a string array. */
  function extractCookies(hdrs) {
    const sc = hdrs["set-cookie"];
    return Array.isArray(sc) ? sc : (sc ? [sc] : []);
  }

  // ── IPC handler ─────────────────────────────────────────────────────────────
  ipcMain.handle("http:execute", async (_event, descriptor) => {
    const consoleLog = [];
    const startTime  = Date.now();
    const _timeout = descriptor.timeout || 30000;
    consoleLog.push(`* Preparing request to ${descriptor.url}`);
    consoleLog.push(`* Current time is ${new Date().toISOString()}`);
    consoleLog.push(`* Enable automatic URL encoding`);
    consoleLog.push(`* Using default HTTP version`);
    consoleLog.push(`* Enable timeout of ${_timeout}ms`);
    consoleLog.push(descriptor.verifySsl === false ? `* Disable SSL validation` : `* Enable SSL validation`);
    console.log("[http:execute] →", descriptor.method, descriptor.url);
    try {
      const result = await doRequest(descriptor, consoleLog, startTime, 0);
      console.log("[http:execute] ←", result.status, result.statusText, `${result.elapsed}ms`);
      return result;
    } catch (err) {
      console.error("[http:execute] unexpected error:", err);
      consoleLog.push(`* Unexpected error: ${err.message}`);
      return {
        status: 0, statusText: "", headers: {}, cookies: [], body: "",
        elapsed: Date.now() - startTime, size: 0, consoleLog,
        error: { name: err.name || "Error", message: err.message },
      };
    }
  });
})();

// ─── OAuth 2.0 Popup IPC ─────────────────────────────────────────────────────
// Opens a BrowserWindow popup for OAuth authorization code / implicit flows.
// The popup navigates to the IdP login page; when the IdP redirects back to
// the registered redirect_uri the navigation is intercepted, the callback URL
// is extracted, and the window is closed automatically.
//
// Returns: { url: string, cancelled: boolean }
//   url       – the full callback URL (includes code= / token= etc.)
//   cancelled – true when the user closes the window without completing login
(function initOAuthIPC() {
  /**
   * Test whether a navigation URL matches the registered redirect URI.
   * Handles both http:// and https:// redirect URIs.
   *
   * @param {string} navUrl      URL being navigated to
   * @param {string} redirectUri Registered redirect URI
   * @returns {boolean}
   */
  function _matchesRedirect(navUrl, redirectUri) {
    if (!navUrl || !redirectUri) return false;
    try {
      const nav      = new URL(navUrl);
      const redirect = new URL(redirectUri);
      // urn: schemes (urn:ietf:wg:oauth:2.0:oob) cannot be matched via URL navigation
      if (redirect.protocol === "urn:") return false;
      const sameOrigin =
        nav.protocol.toLowerCase() === redirect.protocol.toLowerCase() &&
        nav.hostname.toLowerCase()  === redirect.hostname.toLowerCase() &&
        nav.port                    === redirect.port;
      const samePath =
        nav.pathname === redirect.pathname ||
        (redirect.pathname === "/" && (nav.pathname === "" || nav.pathname === "/"));
      return sameOrigin && samePath;
    } catch {
      // Fallback for unusual URI schemes
      return navUrl.startsWith(redirectUri);
    }
  }

  ipcMain.handle("oauth:open-popup", (_event, { authUrl, redirectUri, title }) => {
    return new Promise((resolve) => {
      const popup = new BrowserWindow({
        width:  860,
        height: 720,
        title:  title || "OAuth Authorization",
        parent: _mainWin || undefined,
        modal:  false,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration:  false,
          sandbox:          true,
          webSecurity:      true,
        },
        autoHideMenuBar: true,
      });

      let _resolved = false;

      /**
       * Resolve the pending promise and close the popup exactly once.
       * @param {{ url: string|null, cancelled: boolean }} result
       */
      function _finish(result) {
        if (_resolved) return;
        _resolved = true;
        try {
          if (!popup.isDestroyed()) {
            popup.webContents.stop();
            popup.close();
          }
        } catch (_e) { /* already destroyed */ }
        resolve(result);
      }

      // ── Intercept any navigation to the redirect URI (fires BEFORE request) ──
      popup.webContents.on("will-navigate", (e, url) => {
        if (_matchesRedirect(url, redirectUri)) {
          e.preventDefault();
          _finish({ url, cancelled: false });
        }
      });

      // ── Intercept server-initiated redirects (3xx) ─────────────────────────
      popup.webContents.on("will-redirect", (e, url) => {
        if (_matchesRedirect(url, redirectUri)) {
          e.preventDefault();
          _finish({ url, cancelled: false });
        }
      });

      // ── Catch successful navigations (e.g. custom protocol handlers) ───────
      popup.webContents.on("did-navigate",         (_e, url) => { if (_matchesRedirect(url, redirectUri)) _finish({ url, cancelled: false }); });
      popup.webContents.on("did-navigate-in-page", (_e, url) => { if (_matchesRedirect(url, redirectUri)) _finish({ url, cancelled: false }); });

      // ── Catch failed loads — e.g. http://localhost redirect with no listener ─
      // The browser will fail to connect to the localhost redirect, but the URL
      // still contains the authorization code we need.
      popup.webContents.on("did-fail-load", (_e, _code, _desc, validatedUrl) => {
        if (_matchesRedirect(validatedUrl, redirectUri)) {
          _finish({ url: validatedUrl, cancelled: false });
        }
      });

      // ── User closed the window before completing login ─────────────────────
      popup.on("closed", () => _finish({ url: null, cancelled: true }));

      // ── Load the authorization URL ─────────────────────────────────────────
      popup.loadURL(authUrl).catch((err) => {
        console.error("[oauth:popup] loadURL error:", err.message);
        _finish({ url: null, cancelled: true });
      });
    });
  });

  /**
   * Clear the default Electron session's storage data and cache.
   *
   * Erases all cookies, localStorage, sessionStorage, IndexedDB entries, and
   * the network cache that may be holding an authenticated IdP session.  After
   * calling this, the next OAuth authorization-code / implicit flow will present
   * a fresh login page rather than silently re-using a cached session.
   */
  ipcMain.handle("oauth:clear-session", async () => {
    try {
      await session.defaultSession.clearStorageData({
        storages: [
          "cookies",
          "sessionstorage",
          "localstorage",
          "indexdb",
          "shadercache",
          "websql",
          "serviceworkers",
          "cachestorage",
        ],
      });
      await session.defaultSession.clearCache();
      console.log("[oauth] Session cleared");
    } catch (err) {
      console.error("[oauth] clearSession error:", err.message);
    }
  });
})();

// ─── HTML Preview IPC ─────────────────────────────────────────────────────────
// Creates/manages a WebContentsView that overlays the response body pane and
// loads the last request URL so the user sees a live browser preview.
(function initHtmlPreviewIPC() {
  /**
   * Ensure the WebContentsView exists and is attached to the main window.
   * @returns {WebContentsView|null}
   */
  function _ensureView() {
    if (!_mainWin || _mainWin.isDestroyed()) return null;

    if (!_htmlPreviewView) {
      _htmlPreviewView = new WebContentsView({
        webPreferences: {
          sandbox:          true,
          contextIsolation: true,
          nodeIntegration:  false,
          webSecurity:      true,
        },
      });
    }

    if (!_htmlPreviewAdded) {
      _mainWin.contentView.addChildView(_htmlPreviewView);
      _htmlPreviewAdded = true;
    }

    return _htmlPreviewView;
  }

  /**
   * Convert a {x, y, width, height} rect to integer pixel bounds.
   */
  function _intBounds(b) {
    return {
      x:      Math.round(b.x      ?? 0),
      y:      Math.round(b.y      ?? 0),
      width:  Math.max(1, Math.round(b.width  ?? 0)),
      height: Math.max(1, Math.round(b.height ?? 0)),
    };
  }

  /**
   * Load a URL into the preview view and set its bounds.
   * Creates the view if it does not yet exist.
   */
  ipcMain.handle("htmlPreview:loadUrl", async (_event, url, bounds) => {
    const view = _ensureView();
    if (!view) return;

    view.setBounds(_intBounds(bounds));
    try {
      await view.webContents.loadURL(url);
    } catch (err) {
      console.error("[htmlPreview] loadURL error:", err.message);
    }
  });

  /**
   * Reposition/resize the preview view (called by the ResizeObserver in renderer).
   */
  ipcMain.handle("htmlPreview:resize", async (_event, bounds) => {
    if (!_htmlPreviewView) return;
    _htmlPreviewView.setBounds(_intBounds(bounds));
  });

  /**
   * Show the preview view at the given bounds (re-attaches if needed).
   */
  ipcMain.handle("htmlPreview:show", async (_event, bounds) => {
    const view = _ensureView();
    if (!view) return;
    if (bounds) view.setBounds(_intBounds(bounds));
  });

  /**
   * Temporarily hide the preview view by removing it from the content view.
   * The instance is retained so it can be re-shown without reloading.
   */
  ipcMain.handle("htmlPreview:hide", async (_event) => {
    if (_htmlPreviewView && _htmlPreviewAdded && _mainWin && !_mainWin.isDestroyed()) {
      _mainWin.contentView.removeChildView(_htmlPreviewView);
      _htmlPreviewAdded = false;
    }
  });

  /**
   * Capture the current pixel content of the preview view as a PNG data URL.
   * Called just before hiding the view for a popup so a static snapshot can
   * stand in while the popup is open.
   */
  ipcMain.handle("htmlPreview:capture", async (_event) => {
    if (!_htmlPreviewView || !_htmlPreviewAdded) return null;
    try {
      const image = await _htmlPreviewView.webContents.capturePage();
      return image.toDataURL();
    } catch (err) {
      console.error("[htmlPreview] capturePage error:", err.message);
      return null;
    }
  });

  /**
   * Destroy the preview view entirely (called when the response changes or the
   * user switches to raw mode).
   */
  ipcMain.handle("htmlPreview:destroy", async (_event) => {
    if (_htmlPreviewAdded && _mainWin && !_mainWin.isDestroyed()) {
      _mainWin.contentView.removeChildView(_htmlPreviewView);
      _htmlPreviewAdded = false;
    }
    if (_htmlPreviewView) {
      // Electron cleans up the WebContents when the view is GC'd, but navigating
      // to about:blank first ensures the previous page's resources are released.
      try { _htmlPreviewView.webContents.loadURL("about:blank"); } catch {}
      _htmlPreviewView = null;
    }
  });

  // ── Function evaluation ───────────────────────────────────────────────────
  ipcMain.handle("functions:invoke", async (_event, fn, args) => {
    const crypto = require("crypto");
    try {
      switch (fn) {
        case "jq": {
          // Simple dot-path evaluation in Node (mirrors the JS client-side helper).
          // Complex queries fall through to the error path; the renderer handles them
          // with its own simpleJq() first and only calls here for full jq.
          const { json, query } = args;
          let val = JSON.parse(json);
          const q = (query ?? ".").trim();
          if (q === ".") {
            return { result: typeof val === "string" ? val : JSON.stringify(val) };
          }
          if (/^(\.[a-zA-Z_][a-zA-Z0-9_]*|\.\[\d+\])+$/.test(q)) {
            for (const seg of q.match(/\.[a-zA-Z_][a-zA-Z0-9_]*|\.\[\d+\]/g) ?? []) {
              val = seg.startsWith(".[")
                ? val?.[parseInt(seg.slice(2, -1), 10)]
                : val?.[seg.slice(1)];
            }
            if (val == null) return { result: "" };
            return { result: typeof val === "string" ? val : JSON.stringify(val) };
          }
          return { error: "complex jq queries require the dev server" };
        }
        case "hmac": {
          const { algo, key, message } = args;
          const alg = algo === "SHA512" ? "sha512" : "sha256";
          const mac = crypto.createHmac(alg, key ?? "").update(message ?? "").digest("hex");
          return { result: mac };
        }
        case "hash": {
          const { algo, value } = args;
          const alg = algo === "SHA512" ? "sha512" : "sha256";
          return { result: crypto.createHash(alg).update(value ?? "").digest("hex") };
        }
        default:
          return { error: `unknown function: ${fn}` };
      }
    } catch (err) {
      return { error: err.message ?? String(err) };
    }
  });
})();

// ─── Dev-server port helpers ──────────────────────────────────────────────────

/**
 * Probe whether nothing is listening on `port` at 127.0.0.1.
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

/**
 * Return a random unused port in the IANA ephemeral range [49152, 65534].
 * Keeps trying random candidates until it finds one that is free.
 * @returns {Promise<number>}
 */
async function findFreePort() {
  const MIN = 49152;
  const MAX = 65534;
  while (true) {
    const candidate = Math.floor(Math.random() * (MAX - MIN + 1)) + MIN;
    if (await isPortFree(candidate)) return candidate;
  }
}

/**
 * Poll 127.0.0.1:port until something accepts connections or the deadline passes.
 * Used to wait for the Go server to finish compiling and start up.
 * @param {number} port
 * @param {number} maxWaitMs
 */
function waitForPort(port, maxWaitMs = 30000) {
  const deadline = Date.now() + maxWaitMs;
  return new Promise((resolve, reject) => {
    function attempt() {
      const sock = net.createConnection(port, "127.0.0.1");
      sock.once("connect", () => { sock.destroy(); resolve(); });
      sock.once("error",   () => {
        sock.destroy();
        if (Date.now() >= deadline) {
          reject(new Error(`Timed out waiting for dev server on port ${port}`));
        } else {
          setTimeout(attempt, 150);
        }
      });
    }
    attempt();
  });
}

/**
 * Spawn the Go dev server (via `go run`) on the given port.
 * Stores the child process in `_devServerProcess` so it can be killed on quit.
 * @param {number} port
 */
async function startDevServer(port) {
  const goMain  = path.join(__dirname, "..", "cmd", "main.go");
  const webDir  = path.join(__dirname, "..", "web");
  const dataDir = path.join(__dirname, "..", "..", "data");

  console.log(`[dev-server] spawning on port ${port}`);

  const proc = spawn(
    "go",
    ["run", goMain, "-port", String(port), "-web", webDir, "-data", dataDir],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } },
  );

  proc.stdout.on("data", (d) => process.stdout.write(`[dev-server] ${d}`));
  proc.stderr.on("data", (d) => process.stderr.write(`[dev-server] ${d}`));
  proc.on("exit",  (code, sig) => console.log(`[dev-server] exit code=${code} signal=${sig}`));
  proc.on("error", (err)       => console.error("[dev-server] spawn error:", err.message));

  _devServerProcess = proc;

  // go run needs to compile first — allow up to 30 s
  await waitForPort(port, 30000);
  console.log(`[dev-server] ready on port ${port}`);
}

// ─── App icon ─────────────────────────────────────────────────────────────────
// Resolved once at startup; used for both the BrowserWindow and the macOS dock.
const APP_ICON_PATH = path.join(__dirname, "..", "web", "wurl-logo.png");
const appIcon = nativeImage.createFromPath(APP_ICON_PATH);

// ─── Window state persistence ─────────────────────────────────────────────────
// Window size is stored in a dedicated file (window-state.json) inside the
// platform user-data directory.  Using a separate file — instead of the shared
// manifest/settings JSON — prevents read-write races with the renderer's own
// settings saves.
//
// Only the "normal" (non-minimised, non-maximised, non-fullscreen) size is
// saved so the window always opens at a sensible restored size.

const _WINDOW_STATE_DEFAULTS = { width: 1280, height: 820 };

/** Full path to the window state file (resolved after app.whenReady). */
let _windowStatePath = null;

/** Pending debounce timer for the resize handler. */
let _windowSaveTimer = null;

/**
 * Read the persisted window size from disk.
 * Falls back to defaults when the file is absent, corrupted, or contains
 * values outside the minimum window bounds.
 *
 * Must be called after app.whenReady() so app.getPath() is available.
 *
 * @returns {{ width: number, height: number }}
 */
function loadWindowState() {
  _windowStatePath = path.join(app.getPath("userData"), "window-state.json");
  try {
    const raw    = JSON.parse(fs.readFileSync(_windowStatePath, "utf8"));
    const width  = Number.isFinite(raw.width)  && raw.width  >= 800 ? Math.round(raw.width)  : _WINDOW_STATE_DEFAULTS.width;
    const height = Number.isFinite(raw.height) && raw.height >= 560 ? Math.round(raw.height) : _WINDOW_STATE_DEFAULTS.height;
    return { width, height };
  } catch {
    return { ..._WINDOW_STATE_DEFAULTS };
  }
}

/**
 * Write the current outer window size to disk.
 * Skips saving when the window is in a transient state (minimised, maximised,
 * fullscreen) so those states don't override the last normal size.
 *
 * @param {Electron.BrowserWindow} win
 */
function saveWindowState(win) {
  if (
    !win || win.isDestroyed() ||
    win.isMinimized() || win.isMaximized() || win.isFullScreen()
  ) return;

  const [width, height] = win.getSize();
  try {
    fs.writeFileSync(_windowStatePath, JSON.stringify({ width, height }), "utf8");
  } catch (err) {
    console.error("[main] Failed to save window state:", err.message);
  }
}

// ─── Window creation ──────────────────────────────────────────────────────────
/**
 * @param {{ width: number, height: number }} [savedState]
 */
function createWindow(savedState = _WINDOW_STATE_DEFAULTS) {
  const win = new BrowserWindow({
    width:  savedState.width,
    height: savedState.height,
    // Minimum enforced so splitter drag minimums (nav≥160, res≥160, request≥200)
    // are always achievable without the window becoming unusably cramped.
    //   landscape  : 160 + 4 + 200 + 4 + 160 = 528 px minimum columns
    //   height     : 44 header + 500 content   = 544 px
    minWidth: 800,
    minHeight: 560,
    title: "wurl",
    icon: appIcon,
    backgroundColor: "#1e1e2e",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,   // Renderer cannot access Node APIs directly
      nodeIntegration: false,   // Keep Node out of the renderer
      sandbox: true,            // Extra process isolation
      // Disable Chromium's web security (CORS, same-origin policy) so the
      // renderer can make fetch() calls to any host without restriction.
      // This is intentional for a desktop HTTP testing tool — requests from
      // the renderer go through the main-process IPC bridge (Node.js http/https),
      // not through Chromium's networking stack, but disabling web security
      // prevents Chromium from blocking anything that might slip through.
      webSecurity: false,
    },
  });

  if (isDev) {
    // Development: load from the Go dev server (port resolved in app.whenReady)
    win.loadURL(`http://localhost:${devPort}`);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    // Production: load bundled web assets
    win.loadFile(path.join(__dirname, "..", "web", "index.html"));
  }

  // Disable Chromium's built-in visual zoom (pinch / ctrl+wheel) so the app
  // can intercept those gestures and adjust the settings font-size instead.
  // Level limits (1,1) means the page is always at 100% visual zoom.
  win.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {});

  // Open <a target="_blank"> links in the system browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Track the main window globally so the HTML preview IPC can reference it.
  _mainWin = win;
  win.on("closed", () => {
    _mainWin          = null;
    _htmlPreviewView  = null;
    _htmlPreviewAdded = false;
  });

  // ── Persist window size across sessions ────────────────────────────────────
  // Save on every resize (debounced) and also on close so the very last size
  // is captured even if the debounce timer hasn't fired yet.
  win.on("resize", () => {
    clearTimeout(_windowSaveTimer);
    _windowSaveTimer = setTimeout(() => saveWindowState(win), 500);
  });
  win.on("close", () => {
    clearTimeout(_windowSaveTimer);
    saveWindowState(win);
  });

  return win;
}

// ─── Application menu ─────────────────────────────────────────────────────────
function buildMenu() {
  const template = [
    {
      label: "wurl",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        // Custom font-size zoom — delegates to the renderer's zoom handler so
        // the settings fontSize is adjusted (and persisted) instead of performing
        // a Chromium visual zoom that bypasses the app theming system.
        {
          label: "Increase Font Size",
          click: () => {
            if (_mainWin && !_mainWin.isDestroyed())
              _mainWin.webContents.send("wurl:ui-font-change", "in");
          },
        },
        {
          label: "Decrease Font Size",
          click: () => {
            if (_mainWin && !_mainWin.isDestroyed())
              _mainWin.webContents.send("wurl:ui-font-change", "out");
          },
        },
        {
          label: "Reset Font Size",
          click: () => {
            if (_mainWin && !_mainWin.isDestroyed())
              _mainWin.webContents.send("wurl:ui-font-change", "reset");
          },
        },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

// Always quit when the last window is closed — including on macOS.
// Standard macOS apps linger in the Dock after the window closes, but for an
// HTTP testing tool "close window = quit" is the expected behaviour.
app.on("window-all-closed", () => app.quit());

// Kill the spawned dev server (if any) before the process exits.
app.on("will-quit", () => {
  if (_devServerProcess) {
    _devServerProcess.kill();
    _devServerProcess = null;
  }
});

app.whenReady().then(async () => {
  // Set the macOS dock icon (no-op on Windows/Linux).
  if (process.platform === "darwin" && app.dock) {
    app.dock.setIcon(appIcon);
  }

  // In dev mode: resolve the port, spawning the Go server if needed.
  if (isDev) {
    if (process.env.SERVER_PORT) {
      // Caller already started the Go server on a known port — just connect.
      devPort = parseInt(process.env.SERVER_PORT, 10);
      console.log(`[main] Connecting to external dev server on port ${devPort}`);
    } else {
      // Pick a random unused high port and start the Go server ourselves.
      devPort = await findFreePort();
      await startDevServer(devPort);
    }
  }

  buildMenu();
  const savedState = loadWindowState();
  createWindow(savedState);

  // macOS: re-open a window when the dock icon is clicked with no open windows.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(loadWindowState());
  });
});

