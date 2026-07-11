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

// main.js — Electron main process for Rest Hippo
"use strict";

const {
  app,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  shell,
  Menu,
  dialog,
  nativeImage,
  screen,
  crashReporter,
} = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { spawn } = require("child_process");
const { URL } = require("url");

const { Stores } = require("./store/stores");
const {
  archiveHasSecrets,
  encryptArchiveSecrets,
  decryptArchiveSecrets,
} = require("./store/collection-archive");
const io = require("./store/io");
const crypto = require("./store/crypto");
const { MODES } = require("./store/secret-storage");
const { createLogger } = require("./logger");
const { buildReport } = require("./diagnostics");
const { loadCatalog, label: i18nLabel } = require("./i18n");
const { registerHttpEngine } = require("./net/http-engine");
const { registerScripting } = require("./scripting/sandbox");
const { registerContextMenu } = require("./ipc/context-menu");
const { registerStoreIPC } = require("./ipc/store");
const { registerWebSocketIPC } = require("./ipc/websocket");
const { registerOAuthIPC } = require("./ipc/oauth");
const updater = require("./updater");
const cliLauncher = require("./cli-launcher");
const { isMas, isStoreBuild, distribution } = require("./store-build");
const { ENV_ALLOW_PREFIX, isAllowedEnvName, readEnv } = require("./env-access");

const isDev = process.argv.includes("--dev");
const isDebug = process.argv.includes("--hot-reload");

// ─── Voluntary "tip jar" (Feature 53) ───────────────────────────────────────────
// The single source of truth for the optional donation link. Rest Hippo is free
// with no paid tier, license check, or unlock — this opens a hosted page in the
// system browser so people who value the app can leave a thank-you (suggested
// $5). The provider owns the transaction end-to-end; no card data ever touches
// the app, donating gates nothing, and we never verify, track, or phone home
// about it. Swap this one constant to change the destination (must be https:).
const DONATE_URL = "https://github.com/sponsors/jfigge";

// devPort is resolved asynchronously inside app.whenReady().
// It is declared here so createWindow() can close over the final value.
let devPort = 0;

// Handle to the spawned Go dev-server process (dev mode only, no SERVER_PORT env).
let _devServerProcess = null;

// ─── HTML Preview state ────────────────────────────────────────────────────────
// Tracks the main BrowserWindow and an optional WebContentsView overlay that
// renders live HTML responses inside the response body pane.
let _mainWin = null; // set once createWindow() runs
let _themeEditorWin = null; // singleton theme editor window
let _docsWin = null; // singleton user-guide window
let _htmlPreviewView = null; // WebContentsView instance, created lazily
let _htmlPreviewAdded = false; // whether the view is currently a child of contentView
let _pdfPreviewView = null; // WebContentsView for native PDF preview, created lazily
let _pdfPreviewAdded = false; // whether the PDF view is currently a child of contentView
let _pdfPreviewPath = null; // temp .pdf file currently loaded in the PDF view
let _rejectionDialogOpen = false; // guards against stacking unhandledRejection dialogs

// ─── Single-instance lock ───────────────────────────────────────────────────────
// The storage layer's safety model is "single-process, single-writer": atomic
// temp-then-rename plus in-process write serialization. A second instance opening
// the same userData dir defeats that serialization, so only the first instance is
// allowed to run; a duplicate launch focuses the existing window and quits.
//
// Skipped under hot-reload (`--hot-reload`), whose self-relaunch (app.relaunch +
// app.exit) would otherwise risk racing the lock and leaving the reloaded
// instance with no window. The packaged app and normal launches are unaffected.
const _isPrimaryInstance = isDebug ? true : app.requestSingleInstanceLock();

// ─── Persistent logging ─────────────────────────────────────────────────────────
// A rotating log under userData makes diagnostics survive past stdout: route every
// main-process console.* line into it (install() tees while preserving the console)
// and write explicit lifecycle/error events through logger.error/info. Resolve the
// directory before app is ready (getPath('userData') is available pre-ready) so the
// earliest startup logs are captured; fall back to a temp dir if that ever throws.
const logger = createLogger({
  dir: (() => {
    try {
      return path.join(app.getPath("userData"), "logs");
    } catch {
      return path.join(os.tmpdir(), "resthippo-logs");
    }
  })(),
});
logger.install();

// ─── Native crash dumps (local only) ────────────────────────────────────────────
// Capture renderer/GPU process crashes as local minidumps under userData/Crashpad.
// uploadToServer:false keeps everything on-disk — no telemetry, no remote upload.
try {
  crashReporter.start({ submitURL: "", uploadToServer: false, compress: true });
} catch (err) {
  // Non-fatal: native crash dumps just won't be collected on this platform.
  console.error("[main] crashReporter init failed:", err && err.message);
}

// ─── Global crash handlers ──────────────────────────────────────────────────────
// Without these, a throw or rejection outside a safeCall wrapper vanishes silently.
// Log everything; for a fatal uncaught exception also show a native dialog (once
// the app is ready, so the dialog APIs and localized labels are available) and
// exit, since the process state is undefined. An unhandled rejection is usually
// recoverable, so it is logged and reported but does not tear the app down.
process.on("uncaughtException", (err) => {
  try {
    logger.error("uncaughtException", err);
  } catch {
    /* logging must never mask the original failure */
  }
  if (app.isReady()) showFatalErrorDialog(err);
  app.exit(1);
});

process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  try {
    logger.error("unhandledRejection", err);
  } catch {
    /* best-effort */
  }
  if (app.isReady()) showRejectionDialog(err);
});

if (!_isPrimaryInstance) {
  logger.info("startup", "another instance is already running — quitting");
  app.quit();
} else {
  // A second launch hands control back here: surface the existing window.
  app.on("second-instance", () => {
    if (_mainWin && !_mainWin.isDestroyed()) {
      if (_mainWin.isMinimized()) _mainWin.restore();
      _mainWin.show();
      _mainWin.focus();
    }
  });
}

// ─── Storage layer ─────────────────────────────────────────────────────────────
// The Stores factory is created lazily on first IPC call (after app is ready)
// so that app.getPath('userData') is available.
//
// New filesystem layout (under the platform user-data directory):
//   collections/
//     index.json                         ← manifest (collections, settings)
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

// ── Main-process error conventions ──────────────────────────────────────────
// Two rules keep error handling uniform across io / crypto / backup / http / ws.
//
// 1. ERROR TAGGING. Thrown errors advertise their kind on a single discriminator
//    field, `.code` (a stable machine-readable string). io.js (INVALID_ID,
//    NOT_FOUND), backup.js (INVALID_BACKUP) and crypto.js (DecryptError /
//    PasswordError, whose `.code` mirrors the legacy `.reason` alias) all set it,
//    and net/retry.js classifies HTTP failures off `result.error.code`. Callers
//    discriminate on `.code` alone — never a mix of `.code`/`.reason`/`.name`.
//
// 2. RETURN SHAPES. There is one shape per operation class:
//      • Storage / throwing ops  → throw a tagged error; the IPC handler wraps it
//        in safeCall / safeCallWrite (below) so the renderer sees a quiet
//        fallback or a discriminable `{ __hippoError }` envelope.
//      • Result-or-error ops (http:execute, http:body:get, functions:invoke) →
//        return the result envelope carrying a structured `{ name, message }`
//        under `error` on failure (never a bare string).
//      • Streaming / command-ack ops (ws send/ping/close, http:body:save) →
//        return `{ ok, reason }`.

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

/**
 * Wrap a *write* store call. Unlike safeCall (which returns a look-alike
 * fallback that the renderer cannot distinguish from success), a failed write
 * returns a discriminable `{ __hippoError: true }` envelope so the renderer's
 * data-store can detect the failure and surface a user-visible error toast
 * instead of silently proceeding as if the save succeeded.
 *
 * @param {string}   channel  IPC channel name (for log context)
 * @param {Function} fn       Synchronous store function (return value ignored)
 * @returns {*}  the handler's result on success, or an error envelope on failure
 */
function safeCallWrite(channel, fn) {
  try {
    const result = fn();
    return result === undefined ? null : result;
  } catch (err) {
    console.error(`[main] ${channel} error:`, err.message);
    return { __hippoError: true, channel, message: err.message };
  }
}

/**
 * Resolve the active catalog (persisted preference → OS locale → English) and
 * return a label getter `m(key, fallback)` for the strings the main process
 * renders itself — the native application menu and OS dialogs, which can't reach
 * the renderer's t(). Re-read per call so a locale change without a main-process
 * restart is reflected the next time a menu or dialog is built.
 * @returns {(key: string, fallback: string) => string}
 */
function activeLabels() {
  const cat = loadCatalog({
    requested: safeCall(
      "i18n:labels",
      () => getStores().collectionStore().getManifest()?.settings?.locale,
    ),
    systemLocale: app.getLocale(),
  });
  return (key, fallback) => i18nLabel(cat, key, fallback);
}

/** Fill {name} placeholders in a resolved label (main-side label() has no interp). */
function fmtLabel(str, params) {
  return String(str).replace(/\{(\w+)\}/g, (m, k) =>
    Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : m,
  );
}

// ── Choosing safeCall vs safeCallWrite ──────────────────────────────────────
// Reads and best-effort writes use safeCall (quiet: log + look-alike fallback).
// Authoritative writes — those persisting user-authored data the user expects to
// stick (manifest, collection blob, tree, requests, environments, cookies) — use
// safeCallWrite, so a failure returns a discriminable { __hippoError } envelope
// the renderer surfaces as a toast instead of proceeding as if the save worked.
// Best-effort writes (on-disk reclamation that runs AFTER an authoritative save,
// and auto-captured history telemetry) intentionally stay on safeCall because a
// failure is not user-actionable data loss; each such handler says so inline.

// ─── Store IPC ────────────────────────────────────────────────────────────────
// store:* (manifest, collections, tree, requests, history, environments,
// cookies) + i18n:load. Pure store delegation; see ipc/store.js. Registered
// before app.whenReady() so it's ready the moment the renderer first invokes.
registerStoreIPC({ ipcMain, app, getStores, safeCall, safeCallWrite });

// ─── HTTP Execute IPC ─────────────────────────────────────────────────────────
// The outgoing request engine + its http:execute / http:body:* / http:stream:*
// handlers live in net/http-engine.js; main.js injects the Electron + store
// collaborators it needs (see registerHttpEngine).
registerHttpEngine({
  ipcMain,
  app,
  dialog,
  getMainWin: () => _mainWin,
  getStores,
  safeCall,
});

// ─── Scripting IPC (Feature 25) ──────────────────────────────────────────────
// Pre-request / after-response scripts run in a locked-down vm sandbox in the
// main process (the renderer never executes arbitrary code). The sandbox is a
// pure compute unit: it returns the mutated request, variable writes and console
// output; the renderer persists variable writes through the existing capture
// write-back path. See scripting/sandbox.js for the security model.
registerScripting({ ipcMain, safeCall });

// ─── WebSocket IPC (Feature 32) ──────────────────────────────────────────────
// Owns every live ws://wss:// connection in the main process — the sandboxed
// renderer can't open raw sockets. Connections are driven by the request/reply
// channels ws:open / ws:send / ws:close / ws:ping and stream their lifecycle +
// inbound frames back over the ws:status / ws:message push channels. Proxy and
// TLS settings are honored exactly as on the HTTP path (see net/websocket.js).
// ws:open / ws:send / ws:close / ws:ping + the ws:status / ws:message push
// channels and per-renderer socket cleanup; see ipc/websocket.js.
registerWebSocketIPC({ ipcMain, app });

// ─── OAuth 2.0 Popup IPC ─────────────────────────────────────────────────────
// oauth:open-popup (sandboxed BrowserWindow that intercepts the redirect_uri
// callback) + oauth:clear-session; see ipc/oauth.js.
registerOAuthIPC({ ipcMain, getMainWin: () => _mainWin, activeLabels });

// ─── Native context menu IPC ──────────────────────────────────────────────────
// ui:context-menu:show — pops a real OS context menu at (x, y); see
// ipc/context-menu.js.
registerContextMenu({ ipcMain, getMainWin: () => _mainWin });

// ─── User-guide docs IPC ──────────────────────────────────────────────────────
// Returns the markdown source of a bundled help page so the renderer's DocsViewer
// can render it. Loading text over IPC (rather than fetch) works identically under
// both load modes — file:// (make debug / packaged) and the http dev server.
// `page` is a bare slug; the file lives at src/web/docs/<slug>.md. The slug is
// strictly validated and the resolved path is confirmed to stay inside docsDir,
// so a crafted name can't escape the docs directory.
(function initDocsIPC() {
  const docsDir = path.join(__dirname, "..", "web", "docs");

  ipcMain.handle("docs:read", async (_event, page) => {
    if (typeof page !== "string" || !/^[A-Za-z0-9-]+$/.test(page)) {
      throw new Error(`Invalid docs page: ${page}`);
    }
    const filePath = path.join(docsDir, `${page}.md`);
    // Defense in depth: even with the regex above, confirm containment.
    if (path.relative(docsDir, filePath).startsWith("..")) {
      throw new Error(`Docs page outside docs dir: ${page}`);
    }
    return fs.promises.readFile(filePath, "utf8");
  });
})();

// ─── Edit context menu IPC ────────────────────────────────────────────────────
// Pops a Cut / Copy / Paste / Select All menu for text input fields.
// Called from the renderer's contextmenu handler when the target is editable.
(function initEditContextMenuIPC() {
  ipcMain.handle(
    "ui:context-menu:edit",
    (event, { x, y, extraItems, opts } = {}) => {
      return new Promise((resolve) => {
        let resultId = null;
        const win =
          BrowserWindow.fromWebContents(event.sender) ?? _mainWin ?? undefined;

        // Turn a caller-supplied custom item into a menu template entry. A click
        // records the item's id (resolved when the menu closes); separators and
        // checkbox/radio state pass through. Plain items (id + label) become
        // ordinary clickable rows — e.g. the editor's custom Undo / Redo, whose
        // logic lives in the renderer, not in a native role.
        const pushCustom = (list) => {
          for (const item of list ?? []) {
            if (item?.type === "separator") {
              template.push({ type: "separator" });
              continue;
            }
            const entry = {
              label: String(item.label ?? ""),
              enabled: item.enabled !== false,
              click: () => {
                resultId = item.id ?? null;
              },
            };
            if (item.type === "checkbox" || item.type === "radio") {
              entry.type = item.type;
              entry.checked = !!item.checked;
            }
            template.push(entry);
          }
        };

        // Native clipboard labels follow the app's selected locale (not just the
        // OS): resolve the active catalog (persisted preference → OS locale →
        // English) and label the roles from it. Re-read per open so a locale
        // change without a main-process restart is reflected. extraItems /
        // leadingItems arrive already translated from the renderer.
        const cat = loadCatalog({
          requested: safeCall(
            "ui:context-menu:edit:locale",
            () => getStores().collectionStore().getManifest()?.settings?.locale,
          ),
          systemLocale: app.getLocale(),
        });
        const m = (key, fallback) => i18nLabel(cat, key, fallback);

        // opts.leadingItems (custom) come first, then the native edit roles, then
        // any extraItems (e.g. the code editor's view toggles).
        const template = [];
        pushCustom(opts?.leadingItems);
        template.push(
          { label: m("menu.cut", "Cut"), role: "cut" },
          { label: m("menu.copy", "Copy"), role: "copy" },
          { label: m("menu.paste", "Paste"), role: "paste" },
          { type: "separator" },
          { label: m("menu.selectAll", "Select All"), role: "selectAll" },
        );
        pushCustom(extraItems);

        const menu = Menu.buildFromTemplate(template);
        const popupOpts = { window: win, callback: () => resolve(resultId) };
        if (Number.isFinite(x) && Number.isFinite(y)) {
          popupOpts.x = Math.round(x);
          popupOpts.y = Math.round(y);
        }
        menu.popup(popupOpts);
      });
    },
  );
})();

// ─── HTML Preview IPC ─────────────────────────────────────────────────────────
// Creates/manages a WebContentsView that overlays the response body pane and
// loads the last request URL so the user sees a live browser preview.
(function initHtmlPreviewIPC() {
  /** @returns {boolean} true only for an http(s) URL — the sole previewable schemes. */
  function _isHttpUrl(url) {
    try {
      const proto = new URL(url).protocol;
      return proto === "http:" || proto === "https:";
    } catch {
      return false;
    }
  }

  /**
   * Lock the preview's web contents down to a passive viewer. The previewed page
   * is untrusted (it is the response's own request URL — possibly from an
   * imported collection or a redirect) and runs with scripting enabled, so:
   *   • deny window.open / target=_blank so it can't spawn windows;
   *   • deny every permission request (camera, geolocation, notifications, …);
   *   • allow only http(s) navigation, blocking file:/javascript:/data: etc.
   * It also runs in its own session partition (see _ensureView) so it cannot
   * read the default session's cookies — notably the IdP cookies the OAuth popup
   * sets there.
   * @param {Electron.WebContents} wc
   */
  function _hardenPreviewView(wc) {
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    wc.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    const blockNonHttp = (e, url) => {
      if (!_isHttpUrl(url)) e.preventDefault();
    };
    wc.on("will-navigate", blockNonHttp);
    wc.on("will-redirect", blockNonHttp);
  }

  /**
   * Ensure the WebContentsView exists and is attached to the main window.
   * @returns {WebContentsView|null}
   */
  function _ensureView() {
    if (!_mainWin || _mainWin.isDestroyed()) return null;

    if (!_htmlPreviewView) {
      _htmlPreviewView = new WebContentsView({
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
          // Ephemeral, non-default partition: previewed pages get a clean,
          // isolated cookie store and cannot read the app's / OAuth popup's
          // default-session cookies.
          partition: "preview-html",
        },
      });
      _hardenPreviewView(_htmlPreviewView.webContents);
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
      x: Math.round(b.x ?? 0),
      y: Math.round(b.y ?? 0),
      width: Math.max(1, Math.round(b.width ?? 0)),
      height: Math.max(1, Math.round(b.height ?? 0)),
    };
  }

  /**
   * Load a URL into the preview view and set its bounds.
   * Creates the view if it does not yet exist.
   */
  ipcMain.handle("preview:html:load-url", async (_event, url, bounds) => {
    // Only ever load http(s) into the preview — never file:, javascript:, data:,
    // chrome:, etc. The URL is the response's request URL, which can be
    // attacker-influenced (imported collection, redirect target).
    if (!_isHttpUrl(url)) {
      console.warn("[htmlPreview] refused to load non-http(s) URL");
      return;
    }

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
  ipcMain.handle("preview:html:resize", async (_event, bounds) => {
    if (!_htmlPreviewView) return;
    _htmlPreviewView.setBounds(_intBounds(bounds));
  });

  /**
   * Show the preview view at the given bounds (re-attaches if needed).
   */
  ipcMain.handle("preview:html:show", async (_event, bounds) => {
    const view = _ensureView();
    if (!view) return;
    if (bounds) view.setBounds(_intBounds(bounds));
  });

  /**
   * Temporarily hide the preview view by removing it from the content view.
   * The instance is retained so it can be re-shown without reloading.
   */
  ipcMain.handle("preview:html:hide", async (_event) => {
    if (
      _htmlPreviewView &&
      _htmlPreviewAdded &&
      _mainWin &&
      !_mainWin.isDestroyed()
    ) {
      _mainWin.contentView.removeChildView(_htmlPreviewView);
      _htmlPreviewAdded = false;
    }
  });

  /**
   * Capture the current pixel content of the preview view as a PNG data URL.
   * Called just before hiding the view for a popup so a static snapshot can
   * stand in while the popup is open.
   */
  ipcMain.handle("preview:html:capture", async (_event) => {
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
  ipcMain.handle("preview:html:destroy", async (_event) => {
    if (_htmlPreviewAdded && _mainWin && !_mainWin.isDestroyed()) {
      _mainWin.contentView.removeChildView(_htmlPreviewView);
      _htmlPreviewAdded = false;
    }
    if (_htmlPreviewView) {
      // Electron cleans up the WebContents when the view is GC'd, but navigating
      // to about:blank first ensures the previous page's resources are released.
      try {
        _htmlPreviewView.webContents.loadURL("about:blank");
      } catch {}
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
            return {
              result: typeof val === "string" ? val : JSON.stringify(val),
            };
          }
          if (/^(\.[a-zA-Z_][a-zA-Z0-9_]*|\.\[\d+\])+$/.test(q)) {
            for (const seg of q.match(/\.[a-zA-Z_][a-zA-Z0-9_]*|\.\[\d+\]/g) ??
              []) {
              val = seg.startsWith(".[")
                ? val?.[parseInt(seg.slice(2, -1), 10)]
                : val?.[seg.slice(1)];
            }
            if (val == null) return { result: "" };
            return {
              result: typeof val === "string" ? val : JSON.stringify(val),
            };
          }
          return {
            error: {
              name: "JqUnsupported",
              message: "complex jq queries require the dev server",
            },
          };
        }
        case "hmac": {
          const { algo, key, message } = args;
          const alg = algo === "SHA512" ? "sha512" : "sha256";
          const mac = crypto
            .createHmac(alg, key ?? "")
            .update(message ?? "")
            .digest("hex");
          return { result: mac };
        }
        case "hash": {
          const { algo, value } = args;
          const alg = algo === "SHA512" ? "sha512" : "sha256";
          return {
            result: crypto
              .createHash(alg)
              .update(value ?? "")
              .digest("hex"),
          };
        }
        case "env": {
          // Only RESTHIPPO_*-prefixed vars are exposed; reading an arbitrary
          // host env var (AWS_SECRET_ACCESS_KEY, tokens, …) from a possibly
          // untrusted/imported collection is an exfiltration vector. The gate
          // and rationale live in env-access.js.
          const { name } = args;
          if (!isAllowedEnvName(name) && typeof name === "string" && name) {
            logger.warn(
              "functions:invoke",
              `env access denied for "${name}" — only ${ENV_ALLOW_PREFIX}* variables are readable`,
            );
          }
          return { result: readEnv(name) };
        }
        default:
          return {
            error: {
              name: "UnknownFunction",
              message: `unknown function: ${fn}`,
            },
          };
      }
    } catch (err) {
      // Match the structured { name, message } error the rest of the HTTP path
      // returns rather than a bare string (see error-conventions note above).
      return {
        error: {
          name: err.name || "Error",
          message: err.message ?? String(err),
        },
      };
    }
  });
})();

// ─── PDF Preview IPC ──────────────────────────────────────────────────────────
// Renders a PDF response body natively. The renderer hands over the bytes as
// base64; we write them to a temp .pdf under the response cache and load that
// file into an isolated WebContentsView with `plugins` enabled so Chromium's
// built-in pdfium viewer renders it. The view overlays the response body pane,
// mirroring the HTML-preview overlay (same bounds/show/hide/resize protocol).
(function initPdfPreviewIPC() {
  function _ensureView() {
    if (!_mainWin || _mainWin.isDestroyed()) return null;

    if (!_pdfPreviewView) {
      _pdfPreviewView = new WebContentsView({
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
          // Enables Chromium's bundled PDF viewer on THIS isolated view only —
          // the main window keeps plugins disabled.
          plugins: true,
          // Ephemeral, non-default partition — like the HTML preview view, the
          // untrusted PDF renders in its own isolated session rather than the
          // app's default session.
          partition: "preview-pdf",
        },
      });
    }

    if (!_pdfPreviewAdded) {
      _mainWin.contentView.addChildView(_pdfPreviewView);
      _pdfPreviewAdded = true;
    }

    return _pdfPreviewView;
  }

  function _intBounds(b) {
    return {
      x: Math.round(b?.x ?? 0),
      y: Math.round(b?.y ?? 0),
      width: Math.max(1, Math.round(b?.width ?? 0)),
      height: Math.max(1, Math.round(b?.height ?? 0)),
    };
  }

  /** Remove the just-loaded temp .pdf, if any. */
  function _cleanupTemp() {
    if (_pdfPreviewPath) {
      // best-effort — startup GC will reap it otherwise
      io.remove(_pdfPreviewPath);
      _pdfPreviewPath = null;
    }
  }

  /**
   * Write base64 PDF bytes to a temp file and load it into the preview view.
   */
  ipcMain.handle(
    "preview:pdf:load-file",
    async (_event, { base64 } = {}, bounds) => {
      const view = _ensureView();
      if (!view) return { ok: false };
      if (!base64) return { ok: false };

      try {
        const cacheDir = getStores().paths().responseCacheDir();
        io.ensureDir(cacheDir);
        _cleanupTemp();
        const pdfPath = path.join(cacheDir, `pdf-${io.newUUID()}.pdf`);
        await fs.promises.writeFile(pdfPath, Buffer.from(base64, "base64"));
        _pdfPreviewPath = pdfPath;
        view.setBounds(_intBounds(bounds));
        // loadFile resolves an absolute path to a file:// URL cross-platform
        // (handles Windows drive letters); Chromium's pdfium viewer renders it.
        await view.webContents.loadFile(pdfPath);
        return { ok: true };
      } catch (err) {
        console.error("[pdfPreview] loadFile error:", err.message);
        return { ok: false, error: err.message };
      }
    },
  );

  ipcMain.handle("preview:pdf:resize", async (_event, bounds) => {
    if (!_pdfPreviewView) return;
    _pdfPreviewView.setBounds(_intBounds(bounds));
  });

  ipcMain.handle("preview:pdf:show", async (_event, bounds) => {
    const view = _ensureView();
    if (!view) return;
    if (bounds) view.setBounds(_intBounds(bounds));
  });

  ipcMain.handle("preview:pdf:hide", async (_event) => {
    if (
      _pdfPreviewView &&
      _pdfPreviewAdded &&
      _mainWin &&
      !_mainWin.isDestroyed()
    ) {
      _mainWin.contentView.removeChildView(_pdfPreviewView);
      _pdfPreviewAdded = false;
    }
  });

  ipcMain.handle("preview:pdf:destroy", async (_event) => {
    if (_pdfPreviewAdded && _mainWin && !_mainWin.isDestroyed()) {
      _mainWin.contentView.removeChildView(_pdfPreviewView);
      _pdfPreviewAdded = false;
    }
    if (_pdfPreviewView) {
      try {
        _pdfPreviewView.webContents.loadURL("about:blank");
      } catch {
        // ignore — the view is being discarded anyway
      }
      _pdfPreviewView = null;
    }
    _cleanupTemp();
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
      sock.once("connect", () => {
        sock.destroy();
        resolve();
      });
      sock.once("error", () => {
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
  const goMain = path.join(__dirname, "..", "cmd", "main.go");
  const webDir = path.join(__dirname, "..", "web");
  const dataDir = path.join(__dirname, "..", "..", "data");

  console.log(`[dev-server] spawning on port ${port}`);

  const proc = spawn(
    "go",
    ["run", goMain, "-port", String(port), "-web", webDir, "-data", dataDir],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } },
  );

  proc.stdout.on("data", (d) => process.stdout.write(`[dev-server] ${d}`));
  proc.stderr.on("data", (d) => process.stderr.write(`[dev-server] ${d}`));
  proc.on("exit", (code, sig) =>
    console.log(`[dev-server] exit code=${code} signal=${sig}`),
  );
  proc.on("error", (err) =>
    console.error("[dev-server] spawn error:", err.message),
  );

  _devServerProcess = proc;

  // go run needs to compile first — allow up to 30 s
  await waitForPort(port, 30000);
  console.log(`[dev-server] ready on port ${port}`);
}

// ─── Hot-reload (debug mode) ──────────────────────────────────────────────────
// Watches web/ for renderer changes (reload) and app/ for main-process changes
// (full relaunch). Uses only Node built-ins — no extra npm packages required.
function startHotReload(win) {
  const webDir = path.join(__dirname, "..", "web");
  const appDir = __dirname;

  let rendererTimer = null;
  let mainTimer = null;

  // web/ changes → reload the renderer (CSS, JS, HTML)
  const webWatcher = fs.watch(
    webDir,
    { recursive: true },
    (_event, filename) => {
      if (!filename) return;
      clearTimeout(rendererTimer);
      rendererTimer = setTimeout(() => {
        if (win && !win.isDestroyed()) {
          console.log(`[hot-reload] renderer ← ${filename}`);
          win.webContents.reload();
        }
      }, 150);
    },
  );

  // app/ changes → relaunch the whole process (modules are cached by require())
  const appWatcher = fs.watch(
    appDir,
    { recursive: true },
    (_event, filename) => {
      if (!filename) return;
      clearTimeout(mainTimer);
      mainTimer = setTimeout(() => {
        console.log(`[hot-reload] main-process ← ${filename} — relaunching`);
        app.relaunch();
        app.exit(0);
      }, 500);
    },
  );

  app.on("will-quit", () => {
    webWatcher.close();
    appWatcher.close();
  });
}

// ─── App icon ─────────────────────────────────────────────────────────────────
// Resolved once at startup; used for both the BrowserWindow and the macOS dock.
// macOS expects the icon artwork to sit inside the system "safe area" — a rounded
// square filling ~80% of the canvas with transparent padding on every side — so
// the dock renders it at the same visual weight as native apps. We therefore use
// the pre-padded `resthippo-mac-icon.png` on darwin. Windows gets the
// multi-resolution `resthippo-icon.ico` so the shell/taskbar can pick a
// purpose-rendered size (16/24/32…) instead of blurrily downscaling one bitmap;
// Linux keeps the edge-to-edge logo, which is designed to fill its canvas.
const APP_ICON_PATH = path.join(
  __dirname,
  "..",
  "web",
  process.platform === "darwin"
    ? "resthippo-mac-icon.png"
    : process.platform === "win32"
      ? "resthippo-icon.ico"
      : "resthippo-logo.png",
);
const appIcon = nativeImage.createFromPath(APP_ICON_PATH);

// Set the dock icon synchronously before whenReady() — in Electron 14+ this is
// safe and eliminates the brief Electron-default-icon flash during launch.
if (process.platform === "darwin" && app.dock) {
  app.dock.setIcon(appIcon);
}

// ─── Window state persistence ─────────────────────────────────────────────────
// Window size is stored in a dedicated file (window-state.json) inside the
// platform user-data directory.  Using a separate file — instead of the shared
// manifest/settings JSON — prevents read-write races with the renderer's own
// settings saves.  Reads/writes go through io.js (atomic temp-then-rename +
// tolerant read), so this file gets the same crash-safety as every other store.
//
// Only the "normal" (non-minimised, non-maximised, non-fullscreen) size is
// saved so the window always opens at a sensible restored size.

const _WINDOW_STATE_DEFAULTS = {
  width: 1280,
  height: 820,
  x: undefined,
  y: undefined,
};

/** Full path to the window state file (resolved after app.whenReady). */
let _windowStatePath = null;

/** Pending debounce timer for the resize handler. */
let _windowSaveTimer = null;

/**
 * Returns true if the point (x, y) falls within any connected display,
 * giving at least a 32 px margin so a sliver of the title bar is always
 * reachable even when the window is partially off-screen.
 */
function _isPositionOnScreen(x, y) {
  const MARGIN = 32;
  return screen
    .getAllDisplays()
    .some(
      ({ bounds: b }) =>
        x >= b.x - MARGIN &&
        x < b.x + b.width - MARGIN &&
        y >= b.y - MARGIN &&
        y < b.y + b.height - MARGIN,
    );
}

/**
 * Read the persisted window size and position from disk.
 * Falls back to defaults when the file is absent, corrupted, contains
 * values outside the minimum window bounds, or the saved position is
 * entirely off-screen.
 *
 * Must be called after app.whenReady() so app.getPath() and screen are available.
 *
 * @returns {{ width: number, height: number, x: number|undefined, y: number|undefined }}
 */
function loadWindowState() {
  _windowStatePath = path.join(app.getPath("userData"), "window-state.json");
  try {
    // io.readJSON returns null for a missing file and throws on a corrupt one;
    // either way we fall back to defaults (the catch handles the corrupt case).
    const raw = io.readJSON(_windowStatePath);
    if (!raw || typeof raw !== "object") return { ..._WINDOW_STATE_DEFAULTS };
    const width =
      Number.isFinite(raw.width) && raw.width >= 800
        ? Math.round(raw.width)
        : _WINDOW_STATE_DEFAULTS.width;
    const height =
      Number.isFinite(raw.height) && raw.height >= 560
        ? Math.round(raw.height)
        : _WINDOW_STATE_DEFAULTS.height;
    const hasPos = Number.isFinite(raw.x) && Number.isFinite(raw.y);
    if (hasPos && _isPositionOnScreen(Math.round(raw.x), Math.round(raw.y))) {
      return { width, height, x: Math.round(raw.x), y: Math.round(raw.y) };
    }
    return { width, height, x: undefined, y: undefined };
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
    !win ||
    win.isDestroyed() ||
    win.isMinimized() ||
    win.isMaximized() ||
    win.isFullScreen()
  )
    return;

  const [width, height] = win.getSize();
  const [x, y] = win.getPosition();
  try {
    // Atomic temp-then-rename via the shared store I/O, so a crash mid-write
    // can't corrupt window-state.json (same guarantee every other JSON file gets).
    io.writeJSON(_windowStatePath, { width, height, x, y });
  } catch (err) {
    console.error("[main] Failed to save window state:", err.message);
  }
}

// ─── Window creation ──────────────────────────────────────────────────────────
/**
 * @param {{ width: number, height: number }} [savedState]
 */
function createWindow(savedState = _WINDOW_STATE_DEFAULTS) {
  const posOpts =
    savedState.x !== undefined && savedState.y !== undefined
      ? { x: savedState.x, y: savedState.y }
      : {};
  const win = new BrowserWindow({
    width: savedState.width,
    height: savedState.height,
    ...posOpts,
    // Minimum enforced so splitter drag minimums (nav≥160, res≥160, request≥200)
    // are always achievable without the window becoming unusably cramped.
    //   landscape  : 160 + 4 + 200 + 4 + 160 = 528 px minimum columns
    //   height     : 44 header + 500 content   = 544 px
    minWidth: 800,
    minHeight: 400,
    title: "Rest Hippo",
    icon: appIcon,
    backgroundColor: "#1e1e2e",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, // Renderer cannot access Node APIs directly
      nodeIntegration: false, // Keep Node out of the renderer
      sandbox: true, // Extra process isolation
      // Keep Chromium's web security ON. All outgoing HTTP/WS for the tool runs
      // through the main-process IPC bridge (Node's http/https), so the renderer
      // never needs cross-origin fetch — disabling webSecurity bought nothing and
      // only weakened defense-in-depth (it would let a malicious response body
      // rendered in-app reach arbitrary origins). The dev-server build talks to
      // its own origin (/api/*), which same-origin policy already permits.
      webSecurity: true,
    },
  });

  if (isDev) {
    // Development: load from the Go dev server (port resolved in app.whenReady)
    win.loadURL(`http://localhost:${devPort}`);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    // Production / debug: load bundled web assets from disk
    win.loadFile(path.join(__dirname, "..", "web", "index.html"));
  }

  // Re-localize the native application menu on every load. The renderer reloads
  // the window when the language setting changes (app.js → location.reload), so
  // rebuilding here re-reads the persisted locale and keeps the menu in step
  // with the renderer's language without a process restart.
  win.webContents.on("did-finish-load", () => buildMenu());

  // Disable Chromium's built-in visual zoom (pinch / ctrl+wheel) so the app
  // can intercept those gestures and adjust the settings font-size instead.
  // Level limits (1,1) means the page is always at 100% visual zoom.
  win.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {});

  // Open <a target="_blank"> links in the system browser. Only hand safe web
  // schemes to the OS — shell.openExternal will launch arbitrary URI handlers
  // (file:, smb:, custom protocols), a known RCE/credential-leak vector.
  win.webContents.setWindowOpenHandler(({ url }) => {
    let scheme = "";
    try {
      scheme = new URL(url).protocol;
    } catch {
      return { action: "deny" };
    }
    if (scheme === "http:" || scheme === "https:" || scheme === "mailto:") {
      shell.openExternal(url).catch(() => {});
    }
    return { action: "deny" };
  });

  // Navigation lockdown: the main window is a single-page app that only ever
  // loads its own index.html (prod) / dev-server root and reloads in place (a
  // locale change calls location.reload). Block any attempt to drive the top
  // frame to a different document — e.g. a crafted response body or injected
  // link trying to navigate the app off its own origin. External links are
  // already routed to the OS browser by the window-open handler above; an
  // in-place reload navigates to the same URL and is allowed through.
  // (programmatic loadURL/loadFile do not emit will-navigate, so the initial
  // load is unaffected.)
  const blockOffAppNavigation = (e, url) => {
    if (url !== win.webContents.getURL()) {
      e.preventDefault();
      console.warn("[main] blocked top-frame navigation to", url);
    }
  };
  win.webContents.on("will-navigate", blockOffAppNavigation);
  win.webContents.on("will-redirect", blockOffAppNavigation);

  // Track the main window globally so the HTML preview IPC can reference it.
  _mainWin = win;
  win.on("closed", () => {
    _mainWin = null;
    _htmlPreviewView = null;
    _htmlPreviewAdded = false;
    // Reset the PDF-preview singletons too: like the HTML view they were bound
    // to this (now-destroyed) window. Leaving them dangling would let a
    // recreated main window reuse a WebContentsView tied to the dead window and
    // leak the temp .pdf. _ensureView() recreates them lazily on next preview.
    _pdfPreviewView = null;
    _pdfPreviewAdded = false;
    if (_pdfPreviewPath) {
      try {
        io.remove(_pdfPreviewPath);
      } catch {
        /* best-effort temp cleanup */
      }
      _pdfPreviewPath = null;
    }
  });

  // ── Persist window size across sessions ────────────────────────────────────
  // Save on every resize (debounced) and also on close so the very last size
  // is captured even if the debounce timer hasn't fired yet.
  win.on("resize", () => {
    clearTimeout(_windowSaveTimer);
    _windowSaveTimer = setTimeout(() => saveWindowState(win), 500);
  });
  win.on("move", () => {
    clearTimeout(_windowSaveTimer);
    _windowSaveTimer = setTimeout(() => saveWindowState(win), 500);
  });
  win.on("close", () => {
    clearTimeout(_windowSaveTimer);
    saveWindowState(win);
  });

  return win;
}

// ─── Import / Export IPC ──────────────────────────────────────────────────────
ipcMain.handle(
  "export:file:save",
  async (_event, { filename, content, filters, encoding }) => {
    const result = await dialog.showSaveDialog(_mainWin ?? undefined, {
      defaultPath: filename,
      filters: filters ?? [{ name: "JSON", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePath) return false;
    // Binary bodies arrive as base64 and are decoded back to raw bytes so the
    // saved file is byte-accurate; text is written as UTF-8 as before.
    if (encoding === "base64") {
      await fs.promises.writeFile(
        result.filePath,
        Buffer.from(content, "base64"),
      );
    } else {
      await fs.promises.writeFile(result.filePath, content, "utf-8");
    }
    return true;
  },
);

ipcMain.handle("import:file:open", async () => {
  const m = activeLabels();
  const result = await dialog.showOpenDialog(_mainWin ?? undefined, {
    title: m("dialog.importCollectionTitle", "Import Collection"),
    filters: [
      {
        name: m("dialog.apiCollectionsFilter", "API Collections"),
        extensions: ["json", "yaml", "yml", "har"],
      },
    ],
    properties: ["openFile"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const content = await fs.promises.readFile(result.filePaths[0], "utf-8");
  return { filename: path.basename(result.filePaths[0]), content };
});

// Read a file the user TYPED as a path into the import modal's smart field (the
// renderer sandbox can't read a path itself). Returns { filename, content } for a
// readable regular file, or null for anything else — a non-string/empty path, a
// path that isn't a readable file, or a Mac App Store build (which can't reach
// arbitrary paths; the modal's Browse… button is the sandbox-safe fallback, just
// as import:files:check returns [] under isMas). Never throws to the renderer.
ipcMain.handle("import:file:read", async (_event, filePath) => {
  if (isMas()) return null;
  if (typeof filePath !== "string" || !filePath.trim()) return null;
  try {
    const st = await fs.promises.stat(filePath);
    if (!st.isFile()) return null;
    const content = await fs.promises.readFile(filePath, "utf-8");
    return { filename: path.basename(filePath), content };
  } catch {
    return null; // not found / unreadable / permission denied
  }
});

// Report which of the given paths are NOT readable files on disk. The cURL
// importer (`-F name=@file`) references local file paths the renderer cannot
// stat from its sandbox; it uses this to warn only about files that are actually
// missing — an existing file is read at send time, so there's nothing to
// re-attach. Returns the subset of `paths` that don't resolve to a file.
ipcMain.handle("import:files:check", async (_event, paths) => {
  // Mac App Store sandbox: can't stat arbitrary cURL `-F @path` paths. Report none
  // missing (safe degradation — the importer just skips the warning). See
  // store-build.js. Direct + Microsoft Store builds keep the check.
  if (isMas()) return [];
  if (!Array.isArray(paths)) return [];
  const missing = [];
  for (const p of paths) {
    if (typeof p !== "string" || !p) {
      missing.push(p);
      continue;
    }
    try {
      const st = await fs.promises.stat(p);
      if (!st.isFile()) missing.push(p);
    } catch {
      missing.push(p); // not found / unreadable
    }
  }
  return missing;
});

// ─── Certificate file picker (mTLS / custom CA settings) ──────────────────────
// The Certificates settings panel stores cert/key/PFX/CA file PATHS (the bytes
// are read by the main process at send time). This returns the chosen absolute
// path — never the file content — so nothing sensitive crosses IPC here. `kind`
// selects sensible default file-type filters; an "All Files" fallback is always
// appended so unusual extensions are still selectable.
ipcMain.handle("dialog:file:pick", async (_event, { kind } = {}) => {
  const m = activeLabels();
  const byKind = {
    pem: {
      name: m("dialog.certPemFilter", "PEM Certificates"),
      extensions: ["pem", "crt", "cer"],
    },
    key: {
      name: m("dialog.certKeyFilter", "Private Keys"),
      extensions: ["pem", "key"],
    },
    pfx: {
      name: m("dialog.certPfxFilter", "PKCS#12 / PFX"),
      extensions: ["pfx", "p12"],
    },
    ca: {
      name: m("dialog.certCaFilter", "CA Certificates"),
      extensions: ["pem", "crt", "cer"],
    },
  };
  const filters = [
    ...(byKind[kind] ? [byKind[kind]] : []),
    { name: m("dialog.allFilesFilter", "All Files"), extensions: ["*"] },
  ];
  const result = await dialog.showOpenDialog(_mainWin ?? undefined, {
    title: m("dialog.pickCertificateTitle", "Select File"),
    filters,
    properties: ["openFile"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// ─── Backup (export-all / import-all) ─────────────────────────────────────────
// The renderer owns the user-facing flow: a theme-styled modal collects the
// secret mode (none / machine / password) and any password, then drives these
// IPC handlers. The main process still owns the native file dialogs, all FS I/O,
// the store access and every encryption step — secrets never reach the renderer.
// The renderer only ever passes back the plaintext password it collected.

/** YYYY-MM-DD for a default backup filename. */
function _backupDateStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The live main window, or undefined if it has gone away. */
function _backupWin() {
  return _mainWin && !_mainWin.isDestroyed() ? _mainWin : undefined;
}

/** Success-dialog detail line describing what was done with secrets. */
function _exportDetail(m, mode) {
  if (mode === "password")
    return m(
      "dialog.exportDetailPassword",
      "Secrets are included and encrypted with your password.",
    );
  if (mode === "machine")
    return m(
      "dialog.exportDetailMachine",
      "Secrets are included and encrypted to this machine.",
    );
  return m("dialog.exportDetailNone", "Secrets were removed from this backup.");
}

/**
 * Create a backup. The renderer modal supplies the chosen secret mode and, for
 * password mode, the password. This runs the native save dialog, writes the
 * file, and shows the native success/error box.
 *
 * @returns {Promise<{ ok: boolean, canceled?: boolean, error?: string }>}
 */
ipcMain.handle("backup:export", async (_event, { mode, password } = {}) => {
  const win = _backupWin();
  const m = activeLabels();

  const save = await dialog.showSaveDialog(win, {
    title: m("dialog.createBackupTitle", "Create Backup"),
    defaultPath: `resthippo-backup-${_backupDateStamp()}.json`,
    filters: [
      {
        name: m("dialog.resthippoBackupFilter", "Rest Hippo Backup"),
        extensions: ["json"],
      },
    ],
  });
  if (save.canceled || !save.filePath) return { ok: false, canceled: true };

  try {
    const envelope = getStores().backupStore().exportAll({ mode, password });
    await fs.promises.writeFile(
      save.filePath,
      JSON.stringify(envelope, null, 2),
      "utf-8",
    );
    await dialog.showMessageBox(win, {
      type: "info",
      icon: appIcon,
      buttons: [m("common.ok", "OK")],
      title: m("dialog.backupCreatedTitle", "Backup Created"),
      message: m("dialog.backupCreatedMsg", "Backup created successfully."),
      detail: _exportDetail(m, mode),
    });
    return { ok: true };
  } catch (err) {
    console.error("[main] backup export error:", err.message);
    await dialog.showMessageBox(win, {
      type: "error",
      icon: appIcon,
      buttons: [m("common.ok", "OK")],
      title: m("dialog.createBackupFailedTitle", "Create Backup Failed"),
      message: m(
        "dialog.createBackupFailedMsg",
        "Could not create the backup.",
      ),
      detail: err.message,
    });
    return { ok: false, error: err.message };
  }
});

/**
 * Import step 1 — pick and read the backup file. Returns the file path and its
 * secret mode so the renderer modal can decide whether to offer a password
 * field. The envelope itself (which may hold secrets) stays in the main process.
 *
 * @returns {Promise<{ ok: boolean, canceled?: boolean, filePath?: string,
 *                      secretsMode?: string, error?: string }>}
 */
ipcMain.handle("backup:prepare", async () => {
  const win = _backupWin();
  const m = activeLabels();

  const open = await dialog.showOpenDialog(win, {
    title: m("dialog.restoreBackupTitle", "Restore Backup"),
    filters: [
      {
        name: m("dialog.resthippoBackupFilter", "Rest Hippo Backup"),
        extensions: ["json"],
      },
    ],
    properties: ["openFile"],
  });
  if (open.canceled || open.filePaths.length === 0)
    return { ok: false, canceled: true };

  const filePath = open.filePaths[0];
  try {
    const raw = await fs.promises.readFile(filePath, "utf-8");
    const envelope = JSON.parse(raw);
    if (!envelope || envelope.kind !== "resthippo-backup") {
      return {
        ok: false,
        error: m(
          "dialog.invalidBackup",
          "The selected file is not a valid Rest Hippo backup.",
        ),
      };
    }
    const secretsMode =
      envelope.secretsMode ?? (envelope.secretsIncluded ? "machine" : "none");
    return { ok: true, filePath, secretsMode };
  } catch {
    return {
      ok: false,
      error: m("dialog.readBackupFailed", "Could not read the backup file."),
    };
  }
});

/**
 * Import step 2 — apply the chosen backup with merge/replace and an optional
 * password (required only to recover password-protected secrets; omitting it
 * clears those secret values while keeping the variables marked secure). On a
 * wrong password this returns `{ ok:false, reason:"bad-password" }` so the
 * renderer can keep its modal open and re-prompt. On success the window reloads.
 *
 * @returns {Promise<{ ok: boolean, reason?: string, error?: string }>}
 */
ipcMain.handle(
  "backup:import",
  async (_event, { filePath, mode, password } = {}) => {
    const win = _backupWin();
    const m = activeLabels();

    let envelope;
    try {
      const raw = await fs.promises.readFile(filePath, "utf-8");
      envelope = JSON.parse(raw);
    } catch {
      return {
        ok: false,
        error: m("dialog.readBackupFailed", "Could not read the backup file."),
      };
    }

    try {
      const result = getStores()
        .backupStore()
        .importAll(envelope, {
          mode: mode === "replace" ? "replace" : "merge",
          password,
        });
      if (win) win.webContents.reload();
      // The reload tears down the renderer modal, so report success natively.
      await dialog.showMessageBox(win, {
        type: "info",
        icon: appIcon,
        buttons: [m("common.ok", "OK")],
        title: m("dialog.backupRestoredTitle", "Backup Restored"),
        message: m("dialog.backupRestoredMsg", "Backup restored successfully."),
        detail: fmtLabel(
          m(
            "dialog.backupRestoredDetail",
            "Restored {collections} collection(s) and {requests} request(s).",
          ),
          { collections: result.collections, requests: result.requests },
        ),
      });
      return { ok: true };
    } catch (err) {
      // Both failure kinds are discriminated on the single canonical `.code`
      // field (PasswordError and the INVALID_BACKUP factory both set it).
      if (err && err.code === "bad-password") {
        // Leave the modal open so the renderer can re-prompt for the password.
        return { ok: false, reason: "bad-password" };
      }
      console.error("[main] backup import error:", err.message);
      const detail =
        err.code === "INVALID_BACKUP"
          ? m(
              "dialog.invalidBackup",
              "The selected file is not a valid Rest Hippo backup.",
            )
          : err.message;
      await dialog.showMessageBox(win, {
        type: "error",
        icon: appIcon,
        buttons: [m("common.ok", "OK")],
        title: m("dialog.restoreBackupFailedTitle", "Restore Backup Failed"),
        message: m(
          "dialog.restoreBackupFailedMsg",
          "Could not restore the backup.",
        ),
        detail,
      });
      return { ok: false, error: detail };
    }
  },
);

// ─── Secret-storage mode IPC ──────────────────────────────────────────────────
// The active at-rest backend (app key / OS keychain / master password) is chosen
// here; the renderer Security panel only picks a mode and, for master-password,
// supplies a password. All crypto + file I/O is owned by the main process. On a
// mode change / unlock the window reloads so every panel re-reads freshly
// (de)crypted secrets — the same precedent as backup:import. (The main-process
// crypto singleton survives the renderer reload, so we reconfigure it here.)

ipcMain.handle("secret-storage:get-mode", () =>
  safeCall(
    "secret-storage:get-mode",
    () => {
      const config = getStores().secretStorage().readConfig();
      return {
        mode: crypto.getMode(),
        locked: crypto.isLocked(),
        available: crypto.isAvailable(), // OS keychain usable on this platform?
        hasPassword: !!(config && config.verifier),
      };
    },
    { mode: "app-key", locked: false, available: false, hasPassword: false },
  ),
);

ipcMain.handle("secret-storage:unlock", (_event, { password } = {}) => {
  const sec = getStores().secretStorage();
  const config = sec.readConfig();
  // Unlock applies to a master-password profile, OR one interrupted mid-migration
  // to/from master-password whose mode flip didn't land — both carry the
  // kdf+verifier needed to derive and verify the key.
  const marker = sec.pendingMigration();
  const masterMigration =
    marker &&
    (marker.from === "master-password" || marker.to === "master-password");
  if (
    !config ||
    (config.mode !== "master-password" && !masterMigration) ||
    !config.verifier
  ) {
    return { ok: false, reason: "not-applicable" };
  }
  const key = sec.verifyMasterPassword(password, config);
  if (!key) return { ok: false, reason: "bad-password" };
  crypto.setMasterKey(key);
  // Finish an interrupted migration to/from master-password (no-op otherwise).
  sec.resumeMigration({ masterKey: key });
  const win = _backupWin();
  if (win) win.webContents.reload();
  return { ok: true };
});

ipcMain.handle("secret-storage:lock", () => {
  crypto.lock();
  const win = _backupWin();
  if (win) win.webContents.reload();
  return { ok: true };
});

ipcMain.handle("secret-storage:set-mode", (_event, { mode, password } = {}) => {
  if (!MODES.includes(mode)) return { ok: false, reason: "invalid-mode" };
  const sec = getStores().secretStorage();
  const current = crypto.getMode();
  // Re-selecting the current mode is a no-op. This includes re-entering a master
  // password: a same-mode "re-key" is NOT a real migration (reencryptValue skips
  // same-prefix values, so the secrets stay sealed under the OLD key while the
  // flip would write the NEW verifier — leaving them unrecoverable). Re-keying the
  // master password is a distinct feature, not implemented here; treat it as a
  // no-op rather than the data-loss path. The UI already hides the master fields
  // when the target equals the current mode.
  if (mode === current) {
    return { ok: true, unchanged: true };
  }

  try {
    // Leaving master-password needs the session unlocked — the old ciphertext
    // must be decryptable to migrate it forward.
    if (current === "master-password" && crypto.isLocked()) {
      return { ok: false, reason: "locked" };
    }

    // Prepare the TARGET backend's durable key material BEFORE converting any
    // file. A crash mid-migration is then recoverable: the key/verifier are on
    // disk and the mode flip (below) is the final write, so re-running converts
    // any stragglers with the SAME key.
    let prep = null;
    let markerExtra = {};
    if (mode === "app-key") {
      crypto.configure({ appKey: sec.ensureAppKey() }); // active mode still `current`
    } else if (mode === "master-password") {
      if (typeof password !== "string" || password.length === 0) {
        return { ok: false, reason: "password-required" };
      }
      prep = sec.prepareMasterPassword(password);
      markerExtra = { kdf: prep.kdf, verifier: prep.verifier };
    } else if (mode === "os-keychain" && !crypto.isAvailable()) {
      return { ok: false, reason: "keychain-unavailable" };
    }

    // Durably record the in-flight migration BEFORE converting any file (the
    // mode stays `current` until the flip below). A crash mid-convert is then
    // finished automatically on the next launch by resumeMigration(), instead of
    // leaving a half-converted store for the user to re-migrate by hand.
    sec.markMigration(current, mode, markerExtra);
    if (mode === "master-password") crypto.setMasterKey(prep.key);

    // Re-encrypt every secret to the target (decrypts the current backend's
    // values first — this also coalesces the macOS prompt into one preflight).
    const result = sec.reencryptAll(mode);
    if (!result.ok) {
      // Pass 1 aborted having written nothing — drop the spurious marker so the
      // next launch doesn't try to "resume" a migration that never converted.
      sec.clearMigration();
      return {
        ok: false,
        reason: "migration-failed",
        failures: result.failures,
      };
    }

    // Flip the mode LAST (atomicity anchor) and reconfigure the live backend.
    if (mode === "app-key") {
      sec.writeConfig({ mode });
      crypto.configure({ mode, appKey: sec.readAppKey(), masterKey: null });
    } else if (mode === "os-keychain") {
      sec.writeConfig({ mode });
      crypto.configure({ mode, appKey: null, masterKey: null });
    } else {
      sec.writeConfig({ mode, kdf: prep.kdf, verifier: prep.verifier });
      crypto.configure({ mode, appKey: null, masterKey: prep.key });
    }

    // Leaving app-key mode: every secret was just re-encrypted under the new
    // backend, so the on-device key protects nothing in the live store. Remove it
    // — AFTER the mode flip above, so a crash can never strand `enck:` values with
    // their key already deleted.
    if (mode !== "app-key") sec.deleteAppKey();

    const win = _backupWin();
    if (win) win.webContents.reload();
    return { ok: true };
  } catch (err) {
    console.error("[main] secret-storage:set-mode error:", err.message);
    return { ok: false, reason: "error", message: err.message };
  }
});

// ─── Native collection archive (Rest Hippo v1) IPC ────────────────────────────
// The renderer builds the plaintext archive (it already holds the decrypted tree
// + environments); the main process owns only the secret crypto + file dialogs.
//
// Save is a two-step handshake so credentials are never written in the clear: the
// renderer first calls with no password, and when the archive carries secrets the
// handler returns `{ needsPassword: true }` (without touching the filesystem) so
// the renderer can prompt, then call again with the password.
ipcMain.handle(
  "collection-archive:save",
  async (_event, { archive, password, filename } = {}) => {
    if (!archive || typeof archive !== "object") {
      return { ok: false, error: "no archive" };
    }
    const hasSecrets = archiveHasSecrets(archive);
    if (hasSecrets && !password) return { needsPassword: true };

    const m = activeLabels();
    const out = hasSecrets
      ? encryptArchiveSecrets(archive, password)
      : { ...archive, secretsMode: "none" };

    const save = await dialog.showSaveDialog(_mainWin ?? undefined, {
      title: m("dialog.exportCollectionTitle", "Export Collection"),
      defaultPath: filename || "collection.resthippo.json",
      filters: [
        {
          name: m("dialog.resthippoArchiveFilter", "Rest Hippo Collection"),
          extensions: ["json"],
        },
      ],
    });
    if (save.canceled || !save.filePath) return { ok: false, canceled: true };

    try {
      await fs.promises.writeFile(
        save.filePath,
        JSON.stringify(out, null, 2),
        "utf-8",
      );
      return { ok: true, secretsMode: out.secretsMode };
    } catch (err) {
      console.error("[main] collection archive save error:", err.message);
      return { ok: false, error: err.message };
    }
  },
);

// Recover a password-protected archive's secrets for import. A wrong password is
// reported (not thrown) so the renderer can keep its prompt open and re-ask.
ipcMain.handle(
  "collection-archive:decrypt",
  async (_event, { archive, password } = {}) => {
    if (!archive || typeof archive !== "object") {
      return { ok: false, error: "no archive" };
    }
    try {
      return { ok: true, archive: decryptArchiveSecrets(archive, password) };
    } catch (err) {
      if (err && err.code === "bad-password") {
        return { ok: false, reason: "bad-password" };
      }
      console.error("[main] collection archive decrypt error:", err.message);
      return { ok: false, error: err.message };
    }
  },
);

// ─── App revision info ────────────────────────────────────────────────────────
// The About UI now lives in the renderer (components/about-dialog.js), opened from
// the brand-mark click and the Help ▸ About menu; it reads version/build metadata
// over app:info:get (collectAppInfo, below). This just parses REVISION_INFO.txt.
function readRevisionInfo() {
  const candidates = [
    path.join(__dirname, "..", "REVISION_INFO.txt"), // packaged / build/src/
    path.join(__dirname, "..", "..", "build", "src", "REVISION_INFO.txt"), // make debug (runs from src/)
  ];
  for (const p of candidates) {
    try {
      const raw = fs.readFileSync(p, "utf8");
      return Object.fromEntries(
        raw
          .trim()
          .split("\n")
          .map((l) => l.split("=").map((s) => s.trim())),
      );
    } catch {
      /* try next */
    }
  }
  return null;
}

// ─── Theme editor ─────────────────────────────────────────────────────────────
function showThemeEditor() {
  if (_themeEditorWin) {
    _themeEditorWin.focus();
    return;
  }
  let theme = "grey-dark";
  try {
    const manifest = getStores().collectionStore().getManifest();
    theme = manifest?.settings?.theme ?? "grey-dark";
  } catch {}
  _themeEditorWin = new BrowserWindow({
    width: 900,
    height: 640,
    minWidth: 700,
    minHeight: 480,
    resizable: true,
    autoHideMenuBar: true,
    title: activeLabels()(
      "themeEditor.windowTitle",
      "Theme Editor — Rest Hippo",
    ),
    icon: appIcon,
    backgroundColor: "#1e1e2e",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload-theme-editor.js"),
    },
  });
  _themeEditorWin.loadFile(
    path.join(__dirname, "..", "web", "theme-editor.html"),
    { query: { theme } },
  );
  _themeEditorWin.once("closed", () => {
    _themeEditorWin = null;
  });
}

// ─── User guide ───────────────────────────────────────────────────────────────
// Independent, non-modal window (no `parent`) so the guide can stay open beside
// the main window while the user keeps working. Markdown is rendered in-window;
// its narrow preload (preload-docs.js) only exposes the docs:read IPC.
function showDocsWindow() {
  if (_docsWin) {
    _docsWin.focus();
    return;
  }
  let theme = "grey-dark";
  try {
    theme =
      getStores().collectionStore().getManifest()?.settings?.theme ??
      "grey-dark";
  } catch {
    /* fall back to default theme */
  }
  _docsWin = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 640,
    minHeight: 480,
    resizable: true,
    autoHideMenuBar: true,
    title: activeLabels()("menu.userGuide", "Rest Hippo User Guide"),
    icon: appIcon,
    backgroundColor: "#1e1e2e",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload-docs.js"),
    },
  });
  _docsWin.loadFile(path.join(__dirname, "..", "web", "docs.html"), {
    query: { theme },
  });

  // Open <a target="_blank"> doc links (DOMPurify forces target=_blank) in the
  // system browser. Mirror the main window: only hand safe web schemes to the OS.
  _docsWin.webContents.setWindowOpenHandler(({ url }) => {
    let scheme = "";
    try {
      scheme = new URL(url).protocol;
    } catch {
      return { action: "deny" };
    }
    if (scheme === "http:" || scheme === "https:" || scheme === "mailto:") {
      shell.openExternal(url).catch(() => {});
    }
    return { action: "deny" };
  });

  _docsWin.once("closed", () => {
    _docsWin = null;
  });
}

(function initThemeEditorIPC() {
  ipcMain.handle("ui:open-theme-editor", () => showThemeEditor());
  // Open a vetted https URL in the OS browser (the About dialog's voluntary
  // donation link). https-only — the renderer never hands us anything else here.
  ipcMain.handle("ui:open-external", (_e, url) => {
    let scheme = "";
    try {
      scheme = new URL(String(url)).protocol;
    } catch {
      return false;
    }
    if (scheme === "https:") {
      shell.openExternal(String(url)).catch(() => {});
      return true;
    }
    return false;
  });
  ipcMain.on("theme:preview", (_e, themeData) => {
    if (_mainWin && !_mainWin.isDestroyed())
      _mainWin.webContents.send("theme:preview", themeData);
  });
  ipcMain.on("theme:editor:notify", (_e, customThemes) => {
    if (_mainWin && !_mainWin.isDestroyed())
      _mainWin.webContents.send("theme:editor:notify", customThemes);
  });
  ipcMain.on("theme:editor:apply", (_e, themeId) => {
    if (_mainWin && !_mainWin.isDestroyed())
      _mainWin.webContents.send("theme:editor:apply", themeId);
  });

  ipcMain.handle("theme:export", async (_e, themeData) => {
    const m = activeLabels();
    const safe = (themeData.name ?? "theme").replace(/[^a-z0-9_\- ]/gi, "_");
    const { canceled, filePath } = await dialog.showSaveDialog(
      _themeEditorWin ?? _mainWin ?? undefined,
      {
        title: m("dialog.exportThemeTitle", "Export Theme"),
        defaultPath: `${safe}.resthippo-theme.json`,
        filters: [
          {
            name: m("dialog.resthippoThemeFilter", "Rest Hippo Theme"),
            extensions: ["json"],
          },
        ],
      },
    );
    if (canceled || !filePath) return false;
    fs.writeFileSync(
      filePath,
      JSON.stringify({ "resthippo-theme": "1", ...themeData }, null, 2),
    );
    return true;
  });

  ipcMain.handle("theme:import", async () => {
    const m = activeLabels();
    const { canceled, filePaths } = await dialog.showOpenDialog(
      _themeEditorWin ?? _mainWin ?? undefined,
      {
        title: m("dialog.importThemeTitle", "Import Theme"),
        filters: [
          {
            name: m("dialog.resthippoThemeFilter", "Rest Hippo Theme"),
            extensions: ["json"],
          },
        ],
        properties: ["openFile"],
      },
    );
    if (canceled || !filePaths.length) return null;
    try {
      return JSON.parse(fs.readFileSync(filePaths[0], "utf-8"));
    } catch {
      return null;
    }
  });
})();

// ─── Diagnostics & logs ───────────────────────────────────────────────────────
// Back the Help → Reveal Logs / Export Diagnostics menu items and the fatal /
// unhandled-rejection dialogs raised by the global crash handlers above.

/**
 * Non-sensitive app / build / runtime metadata for the diagnostics header.
 * Mirrors the About dialog's revision info plus engine + platform versions.
 * @returns {Record<string, string>}
 */
function collectAppInfo() {
  const rev = readRevisionInfo() || {};
  return {
    version: app.getVersion(),
    build: rev.VERSION || "unknown",
    branch: rev.BRANCH || "unknown",
    commit: rev.COMMIT || "unknown",
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: `${process.platform} ${process.arch}`,
    os: os.release(),
    locale: app.getLocale(),
    // "store" for Mac App Store / Microsoft Store builds (self-updates handled by
    // the store), "direct" for the GitHub-release builds. See store-build.js.
    distribution: distribution(),
    // Voluntary donation URL for the About dialog's "Support" link, or null when
    // it must be hidden — the Mac App Store bars external non-IAP purchase links
    // (Apple Guideline 3.1.1). Shown in Microsoft Store + direct builds.
    donate: isMas() ? null : DONATE_URL,
  };
}

/** Open the log directory in the OS file manager (creating it if needed). */
/**
 * Open the voluntary donation page (DONATE_URL) in the OS browser. https-only:
 * shell.openExternal will launch arbitrary URI handlers (file:, custom schemes),
 * so we hand it nothing but a vetted https URL — the same scheme-allow-list
 * discipline the window-open handlers use. Runs entirely in main; the Help-menu
 * click handler calls it directly with no IPC.
 */
function openDonateLink() {
  try {
    if (new URL(DONATE_URL).protocol === "https:") {
      shell.openExternal(DONATE_URL).catch(() => {});
    }
  } catch {
    /* malformed URL — open nothing */
  }
}

function revealLogs() {
  const dir = logger.dir();
  io.ensureDir(dir);
  shell.openPath(dir).then((err) => {
    if (err) console.error("[main] revealLogs openPath error:", err);
  });
}

/**
 * Bundle the app info + every (rotated) log file into a single .txt and save it
 * via the native dialog, so a user can attach it to a bug report. The full
 * report is assembled in the main process; nothing crosses to the renderer.
 */
async function exportDiagnostics() {
  const win = _backupWin();
  const m = activeLabels();
  const save = await dialog.showSaveDialog(win, {
    title: m("dialog.exportDiagnosticsTitle", "Export Diagnostics"),
    defaultPath: `resthippo-diagnostics-${_backupDateStamp()}.txt`,
    filters: [
      {
        name: m("dialog.diagnosticsFilter", "Diagnostics"),
        extensions: ["txt"],
      },
    ],
  });
  if (save.canceled || !save.filePath) return;

  try {
    const report = buildReport({
      app: collectAppInfo(),
      logs: logger.readFiles(),
      generatedAt: new Date().toISOString(),
    });
    await fs.promises.writeFile(save.filePath, report, "utf-8");
    await dialog.showMessageBox(win, {
      type: "info",
      icon: appIcon,
      buttons: [m("common.ok", "OK")],
      title: m("dialog.diagnosticsExportedTitle", "Diagnostics Exported"),
      message: m(
        "dialog.diagnosticsExportedMsg",
        "Diagnostics were saved successfully.",
      ),
    });
  } catch (err) {
    logger.error("diagnostics", err);
    await dialog.showMessageBox(win, {
      type: "error",
      icon: appIcon,
      buttons: [m("common.ok", "OK")],
      title: m(
        "dialog.diagnosticsExportFailedTitle",
        "Export Diagnostics Failed",
      ),
      message: m(
        "dialog.diagnosticsExportFailedMsg",
        "Could not export diagnostics.",
      ),
      detail: err.message,
    });
  }
}

/**
 * Blocking error dialog shown by the uncaughtException handler before the app
 * exits. Synchronous (showMessageBoxSync) so it paints before app.exit(). Wrapped
 * so a failure here can never re-enter the crash path.
 * @param {Error} err
 */
function showFatalErrorDialog(err) {
  try {
    const m = activeLabels();
    const hint = fmtLabel(
      m(
        "dialog.fatalErrorLogHint",
        "Details were written to the log in:\n{path}",
      ),
      { path: logger.dir() },
    );
    const detail = `${err && err.stack ? err.stack : String(err)}\n\n${hint}`;
    dialog.showMessageBoxSync(
      _mainWin && !_mainWin.isDestroyed() ? _mainWin : undefined,
      {
        type: "error",
        icon: appIcon,
        buttons: [m("common.ok", "OK")],
        title: m("dialog.fatalErrorTitle", "Rest Hippo encountered a problem"),
        message: m(
          "dialog.fatalErrorMsg",
          "An unexpected error occurred and Rest Hippo needs to close.",
        ),
        detail,
      },
    );
  } catch {
    /* dialog failed — there is nothing more we can do but exit */
  }
}

/**
 * Non-blocking notice for an unhandled promise rejection. The app keeps running,
 * so this is informational rather than fatal.
 * @param {Error} err
 */
function showRejectionDialog(err) {
  // Coalesce: keep at most one rejection notice on screen. Each dialog is
  // non-modal, so a rejection thrown in a loop would otherwise stack an
  // unbounded pile of them. Subsequent rejections are still logged by the
  // caller — they're just not re-surfaced until the current notice is
  // dismissed, at which point a genuinely new failure can show again.
  if (_rejectionDialogOpen) return;
  _rejectionDialogOpen = true;
  try {
    const m = activeLabels();
    const shown = dialog.showMessageBox(
      _mainWin && !_mainWin.isDestroyed() ? _mainWin : undefined,
      {
        type: "warning",
        icon: appIcon,
        buttons: [m("common.ok", "OK")],
        title: m("dialog.unhandledRejectionTitle", "Unexpected error"),
        message: m(
          "dialog.unhandledRejectionMsg",
          "An unexpected error occurred. Rest Hippo will keep running.",
        ),
        detail: err.message,
      },
    );
    Promise.resolve(shown).finally(() => {
      _rejectionDialogOpen = false;
    });
  } catch {
    /* best-effort notice */
    _rejectionDialogOpen = false;
  }
}

// Mirror critical renderer errors (uncaught exceptions / promise rejections) into
// the same persistent log as the main process, so a renderer-side failure is
// recoverable from a bug report. Fire-and-forget from the renderer's perspective.
(function initDiagnosticsIPC() {
  ipcMain.handle("diagnostics:error:report", (_event, info = {}) => {
    const where = info && info.source ? info.source : "renderer";
    const parts = [info && info.message, info && info.stack].filter(Boolean);
    logger.error(
      "renderer",
      `${where}: ${parts.join("\n") || "unknown renderer error"}`,
    );
    return null;
  });
})();

// ─── Auto-update (Feature 36) ─────────────────────────────────────────────────
// The updater itself lives in updater.js; here we expose the on-demand check /
// install to the renderer (the Help menu calls checkForUpdates directly in main)
// and a read-only app-info accessor for the Settings → About version display.
// initUpdater() + the debounced startup check run from app.whenReady() below.
(function initUpdaterIPC() {
  ipcMain.handle("updater:check", () => {
    updater.checkForUpdates({ manual: true });
    return null;
  });
  ipcMain.handle("updater:install", () => {
    updater.quitAndInstall();
    return null;
  });
  ipcMain.handle("app:info:get", () => collectAppInfo());
})();

// ─── CLI launcher ─────────────────────────────────────────────────────────────
// Install / remove the `hippo` shell command (the VS Code "Install 'code' command
// in PATH" equivalent). The per-platform mechanics live in cli-launcher.js; these
// handlers are thin pass-throughs whose return shapes the renderer maps to toasts.
(function initCliIPC() {
  ipcMain.handle("cli:status", () => cliLauncher.status());
  ipcMain.handle("cli:install", () => cliLauncher.install());
  ipcMain.handle("cli:uninstall", () => cliLauncher.uninstall());
})();

// ─── Application menu ─────────────────────────────────────────────────────────
function buildMenu() {
  const m = activeLabels();
  const template = [
    {
      label: "Rest Hippo", // app name — proper noun, shown verbatim in every locale
      // keep Rest Hippo app menu first on macOS
      submenu: [
        {
          label: m("menu.about", "About Rest Hippo"),
          click: () => {
            if (_mainWin && !_mainWin.isDestroyed())
              _mainWin.webContents.send("menu:show-about");
          },
        },
        {
          label: m("menu.themeEditor", "Theme Editor…"),
          click: showThemeEditor,
        },
        {
          label: m("menu.settings", "Settings…"),
          accelerator: "CmdOrCtrl+,",
          click: () => {
            if (_mainWin && !_mainWin.isDestroyed())
              _mainWin.webContents.send("menu:open-settings");
          },
        },
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
      label: m("menu.file", "File"),
      submenu: [
        {
          label: m("menu.newRequest", "New Request"),
          accelerator: "CmdOrCtrl+N",
          click: () => {
            if (_mainWin && !_mainWin.isDestroyed())
              _mainWin.webContents.send("menu:new-request");
          },
        },
        {
          label: m("menu.newCollection", "New Folder"),
          accelerator: "CmdOrCtrl+Shift+N",
          click: () => {
            if (_mainWin && !_mainWin.isDestroyed())
              _mainWin.webContents.send("menu:new-collection");
          },
        },
        {
          label: m("menu.newWsRequest", "New WebSocket Request"),
          accelerator: "CmdOrCtrl+Alt+N",
          click: () => {
            if (_mainWin && !_mainWin.isDestroyed())
              _mainWin.webContents.send("menu:new-ws-request");
          },
        },
        // Collection import (file / URL / cURL) and export now live in the
        // Collections dialog (Import / Export buttons) and the tree toolbar's
        // [+] secondary-click menu (Import from cURL). Only whole-workspace
        // backup/restore remains in the File menu.
        { type: "separator" },
        {
          label: m("menu.createBackup", "Create Backup…"),
          click: () => {
            if (_mainWin && !_mainWin.isDestroyed())
              _mainWin.webContents.send("menu:backup-export");
          },
        },
        {
          label: m("menu.restoreBackup", "Restore Backup…"),
          click: () => {
            if (_mainWin && !_mainWin.isDestroyed())
              _mainWin.webContents.send("menu:backup-import");
          },
        },
      ],
    },
    {
      label: m("menu.edit", "Edit"),
      submenu: [
        // Routed to the renderer (not native roles) so the multi-line code
        // editor's own snapshot undo/redo can take over when it's focused; the
        // renderer falls back to document.execCommand for plain inputs.
        {
          label: m("menu.undo", "Undo"),
          accelerator: "CmdOrCtrl+Z",
          click: () => {
            if (_mainWin && !_mainWin.isDestroyed())
              _mainWin.webContents.send("menu:edit-action", "undo");
          },
        },
        {
          label: m("menu.redo", "Redo"),
          accelerator: "Shift+CmdOrCtrl+Z",
          click: () => {
            if (_mainWin && !_mainWin.isDestroyed())
              _mainWin.webContents.send("menu:edit-action", "redo");
          },
        },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: m("menu.view", "View"),
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        {
          label: m("menu.cycleLayout", "Cycle Layout"),
          accelerator: "CmdOrCtrl+\\",
          click: () => {
            if (_mainWin && !_mainWin.isDestroyed())
              _mainWin.webContents.send("menu:cycle-layout");
          },
        },
        { type: "separator" },
        // Custom font-size zoom — delegates to the renderer's zoom handler so
        // the settings fontSize is adjusted (and persisted) instead of performing
        // a Chromium visual zoom that bypasses the app theming system. The
        // accelerators are advertised only (registerAccelerator:false): the
        // renderer owns the keystroke (it also handles wheel/pinch and lets the
        // combo pass through inside text fields), so the menu must not bind it.
        {
          label: m("menu.fontIncrease", "Increase Font Size"),
          accelerator: "CmdOrCtrl+Plus",
          registerAccelerator: false,
          click: () => {
            if (_mainWin && !_mainWin.isDestroyed())
              _mainWin.webContents.send("hippo:ui-font-change", "in");
          },
        },
        {
          label: m("menu.fontDecrease", "Decrease Font Size"),
          accelerator: "CmdOrCtrl+-",
          registerAccelerator: false,
          click: () => {
            if (_mainWin && !_mainWin.isDestroyed())
              _mainWin.webContents.send("hippo:ui-font-change", "out");
          },
        },
        {
          label: m("menu.fontReset", "Reset Font Size"),
          accelerator: "CmdOrCtrl+0",
          registerAccelerator: false,
          click: () => {
            if (_mainWin && !_mainWin.isDestroyed())
              _mainWin.webContents.send("hippo:ui-font-change", "reset");
          },
        },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: m("menu.window", "Window"),
      submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }],
    },
    {
      label: m("menu.help", "Help"),
      // role: "help" lets macOS group this as the standard Help menu.
      role: "help",
      submenu: [
        {
          label: m("menu.userGuide", "Rest Hippo User Guide"),
          accelerator: "CmdOrCtrl+/",
          click: showDocsWindow,
        },
        {
          label: m("menu.keyboardShortcuts", "Keyboard Shortcuts"),
          accelerator: "CmdOrCtrl+K",
          click: () => {
            if (_mainWin && !_mainWin.isDestroyed())
              _mainWin.webContents.send("menu:keyboard-shortcuts");
          },
        },
        // On-demand update check (Feature 36). Triggered directly in main — the
        // updater pushes its result to the renderer for the toast / status.
        // Omitted in store builds: the App Store / Microsoft Store deliver their
        // own updates and the in-app updater is disabled (see store-build.js).
        ...(isStoreBuild()
          ? []
          : [
              {
                label: m("menu.checkUpdates", "Check for Updates…"),
                click: () => updater.checkForUpdates({ manual: true }),
              },
            ]),
        // Voluntary tip jar — opens the donation page in the browser. Passive:
        // no accelerator, no badge, never nags (Feature 53). Omitted in the Mac
        // App Store build: Apple's Guideline 3.1.1 forbids external links to
        // non-IAP purchase mechanisms, and a passive donation link counts. The
        // Microsoft Store permits it (policy §10.8), so it stays there and in the
        // direct builds — hence isMas(), not isStoreBuild(). See store-build.js.
        ...(isMas()
          ? []
          : [
              {
                label: m("menu.support", "Support Rest Hippo…"),
                click: openDonateLink,
              },
            ]),
        { type: "separator" },
        { label: m("menu.revealLogs", "Reveal Logs"), click: revealLogs },
        {
          label: m("menu.exportDiagnostics", "Export Diagnostics…"),
          click: exportDiagnostics,
        },
      ],
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
  // A duplicate instance never sets up a window or the dev server — it has
  // already requested focus of the primary via second-instance and is quitting.
  if (!_isPrimaryInstance) return;

  logger.info(
    "startup",
    `Rest Hippo ${app.getVersion()} ready (${process.platform})`,
  );

  // In dev mode: resolve the port, spawning the Go server if needed.
  if (isDev) {
    if (process.env.SERVER_PORT) {
      // Caller already started the Go server on a known port — just connect.
      devPort = parseInt(process.env.SERVER_PORT, 10);
      console.log(
        `[main] Connecting to external dev server on port ${devPort}`,
      );
    } else {
      // Pick a random unused high port and start the Go server ourselves.
      devPort = await findFreePort();
      await startDevServer(devPort);
    }
  }

  // Enforce the history-retention setting on disk before the renderer asks for
  // its first page. Bounds the history store independently of the renderer so
  // listHistory pages stay fast no matter how much accumulated while closed.
  try {
    const manifest = getStores().collectionStore().getManifest();
    const historyCount = manifest?.settings?.historyCount ?? 5;
    getStores().historyStore().trimAllHistory(historyCount);
  } catch (err) {
    console.error("[main] startup history trim failed:", err.message);
  }

  buildMenu();
  const savedState = loadWindowState();
  const win = createWindow(savedState);
  if (isDebug) startHotReload(win);

  // Auto-update (Feature 36): wire the updater to the live window so manual
  // checks (Help → Check for Updates… / Settings → About) keep working, then run
  // a debounced silent startup check — but only when the user has opted in via
  // the autoUpdateCheck setting. The default (absent / false) is off, so a fresh
  // or unconfigured install makes no automatic outbound update call until the
  // user enables it in Settings. No-op in dev/unpacked either way.
  updater.initUpdater(() => _mainWin, logger);
  let autoUpdateCheck = false;
  try {
    autoUpdateCheck =
      getStores().collectionStore().getManifest()?.settings?.autoUpdateCheck ===
      true;
  } catch {
    /* manifest unreadable — leave automatic checks off */
  }
  if (autoUpdateCheck) {
    setTimeout(() => updater.checkForUpdates({ manual: false }), 10000);
  }

  // macOS: re-open a window when the dock icon is clicked with no open windows.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0)
      createWindow(loadWindowState());
  });
});
