// main.js — Electron main process for wurl
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
  session,
  screen,
  crashReporter,
} = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");
const net = require("net");
const tls = require("tls");
const { Readable } = require("stream");
const { StringDecoder } = require("string_decoder");
const { spawn } = require("child_process");
const { URL } = require("url");

const { Stores } = require("./store/stores");
const io = require("./store/io");
const { createLogger } = require("./logger");
const { buildReport } = require("./diagnostics");
const { loadCatalog, label: i18nLabel } = require("./i18n");
const { isBinaryContentType, looksBinary } = require("./http-content-type");
const aws4 = require("aws4");
const {
  withProxyCredentials,
  hostBypassesProxy,
  makeProxyAgent,
} = require("./net/proxy");
const {
  selectClientCert,
  hostSkipsTlsVerify,
  loadClientCertMaterial,
  loadCaBundle,
} = require("./net/tls");
const { normalizeRetry, retryReason, backoffDelay } = require("./net/retry");
const { computeTiming, formatTiming } = require("./net/timing");
const { WebSocketHub } = require("./net/websocket");
const { SseParser, LineBuffer, isEventStream, isNdjson } = require("./net/sse");
const {
  parseChallenge,
  selectDigestChallenge,
  buildAuthorization: buildDigestAuthorization,
} = require("./auth/digest");
const {
  createType1Message,
  selectNtlmChallenge,
  decodeType2Message,
  createType3Message,
} = require("./auth/ntlm");

const isDev = process.argv.includes("--dev");
const isDebug = process.argv.includes("--hot-reload");

// devPort is resolved asynchronously inside app.whenReady().
// It is declared here so createWindow() can close over the final value.
let devPort = 0;

// Handle to the spawned Go dev-server process (dev mode only, no SERVER_PORT env).
let _devServerProcess = null;

// ─── HTML Preview state ────────────────────────────────────────────────────────
// Tracks the main BrowserWindow and an optional WebContentsView overlay that
// renders live HTML responses inside the response body pane.
let _mainWin = null; // set once createWindow() runs
let _aboutWin = null; // singleton about window
let _themeEditorWin = null; // singleton theme editor window
let _docsWin = null; // singleton user-guide window
let _htmlPreviewView = null; // WebContentsView instance, created lazily
let _htmlPreviewAdded = false; // whether the view is currently a child of contentView
let _pdfPreviewView = null; // WebContentsView for native PDF preview, created lazily
let _pdfPreviewAdded = false; // whether the PDF view is currently a child of contentView
let _pdfPreviewPath = null; // temp .pdf file currently loaded in the PDF view

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
      return path.join(os.tmpdir(), "wurl-logs");
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
//        fallback or a discriminable `{ __wurlError }` envelope.
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
 * returns a discriminable `{ __wurlError: true }` envelope so the renderer's
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
    return { __wurlError: true, channel, message: err.message };
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
// safeCallWrite, so a failure returns a discriminable { __wurlError } envelope
// the renderer surfaces as a toast instead of proceeding as if the save worked.
// Best-effort writes (on-disk reclamation that runs AFTER an authoritative save,
// and auto-captured history telemetry) intentionally stay on safeCall because a
// failure is not user-actionable data loss; each such handler says so inline.

// ─── Store IPC ────────────────────────────────────────────────────────────────
// Register handlers before app.whenReady() so they are ready the moment the
// renderer process makes its first invoke() call.
(function initStoreIPC() {
  // ── Manifest (global collections list + settings) ───────────────────────────

  ipcMain.handle("store:manifest:get", () =>
    safeCall(
      "store:manifest:get",
      () => getStores().collectionStore().getManifest(),
      { version: 2, collections: [], activeCollectionId: null, settings: {} },
    ),
  );

  ipcMain.handle("store:manifest:save", (_event, data) =>
    safeCallWrite("store:manifest:save", () => {
      getStores().collectionStore().saveManifest(data);
    }),
  );

  // ── i18n catalog ────────────────────────────────────────────────────────────
  // Resolve the active locale (persisted preference → OS locale → English) and
  // return its bundled catalog plus the English fallback. The renderer awaits
  // this once at startup, before any component renders. Lives here because it
  // reads both the manifest settings and the on-disk catalogs — main-process
  // concerns the sandboxed renderer cannot reach.
  ipcMain.handle("i18n:load", () =>
    safeCall(
      "i18n:load",
      () => {
        const manifest = getStores().collectionStore().getManifest();
        return loadCatalog({
          requested: manifest?.settings?.locale,
          systemLocale: app.getLocale(),
        });
      },
      loadCatalog({ requested: "system", systemLocale: "en" }),
    ),
  );

  // Remove a collection's backing directory (requests, history, responses,
  // cookies, metadata). The renderer updates the manifest separately. This is
  // best-effort reclamation AFTER the authoritative manifest save, so it uses the
  // quiet safeCall path (a failed cleanup is not user-actionable data loss).
  ipcMain.handle("store:collections:delete", (_event, id) =>
    safeCall("store:collections:delete", () => {
      getStores().collectionStore().deleteCollection(id);
    }),
  );

  // ── Collection blob (assembles / decomposes per-file layout) ────────────────
  // Used by data-store.js to keep the same high-level collections API.

  ipcMain.handle("store:env:get", (_event, id) =>
    safeCall(
      "store:env:get",
      () => getStores().collectionsStore().getCollections(id),
      { version: 1, collections: [] },
    ),
  );

  ipcMain.handle("store:env:save", (_event, id, data) =>
    safeCallWrite("store:env:save", () => {
      getStores().collectionsStore().saveCollections(id, data);
    }),
  );

  // ── Collection navigation tree ──────────────────────────────────────────────

  ipcMain.handle("store:tree:get", (_event, collectionId) =>
    safeCall(
      "store:tree:get",
      () => getStores().treeStore().getTree(collectionId),
      { children: [] },
    ),
  );

  // Authoritative write (nav tree is source of truth for folder structure).
  ipcMain.handle("store:tree:save", (_event, collectionId, tree) =>
    safeCallWrite("store:tree:save", () => {
      getStores().treeStore().saveTree(collectionId, tree);
    }),
  );

  // ── Granular request CRUD ───────────────────────────────────────────────────

  ipcMain.handle("store:requests:get", (_event, id) =>
    safeCall("store:requests:get", () =>
      getStores().requestStore().getRequest(id),
    ),
  );

  // Authoritative writes. (Both channels are wired but currently unused by the
  // renderer, which persists requests via the per-collection env blob.)
  ipcMain.handle("store:requests:create", (_event, collectionId, req) =>
    safeCallWrite("store:requests:create", () =>
      getStores().requestStore().createRequest(collectionId, req),
    ),
  );

  ipcMain.handle("store:requests:update", (_event, id, patch) =>
    safeCallWrite("store:requests:update", () =>
      getStores().requestStore().updateRequest(id, patch),
    ),
  );

  // Best-effort reclamation of a request's backing file AFTER the tree (source of
  // truth) was already saved loudly via store:env:save. Quiet path: an unlink
  // failure (incl. ENOENT for an already-removed file) is not data loss.
  ipcMain.handle("store:requests:delete", (_event, id) =>
    safeCall("store:requests:delete", () => {
      getStores().requestStore().deleteRequest(id);
    }),
  );

  // ── Request execution history ───────────────────────────────────────────────
  // History is auto-captured telemetry recorded on every send/purge. The mutating
  // handlers below (add / delete / clear / trim) stay on the quiet safeCall path:
  // a lost or unpruned entry is not the user-authored data loss that safeCallWrite
  // exists to surface, and toasting per-entry would nag on a loop. Failures log.

  ipcMain.handle("store:history:list", (_event, requestId, options) =>
    safeCall(
      "store:history:list",
      () =>
        getStores()
          .historyStore()
          .listHistory(requestId, options ?? {}),
      { items: [], nextCursor: "" },
    ),
  );

  ipcMain.handle("store:history:add", (_event, requestId, entry, response) =>
    safeCall("store:history:add", () =>
      getStores().historyStore().addHistory(requestId, entry, response),
    ),
  );

  ipcMain.handle("store:history:response:get", (_event, requestId, historyId) =>
    safeCall("store:history:response:get", () =>
      getStores().historyStore().getHistoryResponse(requestId, historyId),
    ),
  );

  ipcMain.handle("store:history:delete", (_event, requestId, historyId) =>
    safeCall("store:history:delete", () =>
      getStores().historyStore().deleteHistory(requestId, historyId),
    ),
  );

  ipcMain.handle("store:history:clear", (_event, requestId) =>
    safeCall("store:history:clear", () =>
      getStores().historyStore().clearHistory(requestId),
    ),
  );

  ipcMain.handle("store:history:trim", (_event, maxEntries) =>
    safeCall("store:history:trim", () =>
      getStores().historyStore().trimAllHistory(maxEntries),
    ),
  );

  // ── Global + named environment variables ─────────────────────────────────────

  ipcMain.handle("store:environments:get", () =>
    safeCall(
      "store:environments:get",
      () => getStores().environmentStore().getEnvironments(),
      {
        version: 1,
        globalVariables: {},
        activeEnvironmentId: null,
        environments: [],
      },
    ),
  );

  // Authoritative write (user-authored global + named environment variables).
  ipcMain.handle("store:environments:save", (_event, data) =>
    safeCallWrite("store:environments:save", () => {
      getStores().environmentStore().saveEnvironments(data);
    }),
  );

  // ── Persistent cookie jar (per collection) ───────────────────────────────────
  // Capture/attachment happens automatically inside http:execute; these handlers
  // back the cookie-manager UI (view / edit / delete / clear).

  ipcMain.handle("store:cookies:list", (_event, collectionId) =>
    safeCall(
      "store:cookies:list",
      () => getStores().cookieStore().listCookies(collectionId),
      [],
    ),
  );

  // Authoritative writes (user edits to the persistent cookie jar via the manager).
  ipcMain.handle("store:cookies:upsert", (_event, collectionId, cookie) =>
    safeCallWrite("store:cookies:upsert", () => {
      getStores().cookieStore().upsertCookie(collectionId, cookie);
    }),
  );

  ipcMain.handle("store:cookies:delete", (_event, collectionId, ident) =>
    safeCallWrite("store:cookies:delete", () => {
      getStores().cookieStore().deleteCookie(collectionId, ident);
    }),
  );

  ipcMain.handle("store:cookies:clear", (_event, collectionId) =>
    safeCallWrite("store:cookies:clear", () => {
      getStores().cookieStore().clearJar(collectionId);
    }),
  );
})();

// ─── HTTP Execute IPC ─────────────────────────────────────────────────────────
// Performs the actual outgoing HTTP/HTTPS request in the main (Node.js) process
// so the sandboxed renderer never touches the network directly.
// Returns a rich result object including a verbose console log.
(function initHttpIPC() {
  // ── Large-response spill-to-disk ───────────────────────────────────────────
  //
  // Responses below the threshold stay fully in renderer memory as today. Above
  // it, the body is streamed to a temp file under `response-cache/` (with the
  // socket paused under backpressure so memory stays bounded), and only a small
  // preview crosses to the renderer. The renderer can then fetch the full body
  // or save it straight to disk on demand via `http:body:get` / `http:body:save`.

  /** Spill bodies larger than this (bytes) to disk instead of buffering. */
  const RESPONSE_SPILL_THRESHOLD = 8 * 1024 * 1024; // 8 MB
  /** Preview kept in memory / sent to the renderer for a spilled response. */
  const RESPONSE_PREVIEW_BYTES = 256 * 1024; // 256 KB
  /** Most-recent spilled bodies retained before the oldest is evicted. */
  const SPILL_REGISTRY_MAX = 20;

  /** ref → { path, size, contentType, isBinary } for bodies spilled to disk. */
  const spilledBodies = new Map();

  /**
   * Register a spilled body and return an opaque ref the renderer can redeem.
   * Evicts (and unlinks) the oldest entry once the registry is full — Map
   * preserves insertion order, so the first key is the least-recently spilled.
   * @param {{ path: string, size: number, contentType: string, isBinary: boolean }} entry
   * @returns {string} ref
   */
  function registerSpilledBody(entry) {
    const ref = io.newUUID();
    spilledBodies.set(ref, entry);
    while (spilledBodies.size > SPILL_REGISTRY_MAX) {
      const oldestRef = spilledBodies.keys().next().value;
      const old = spilledBodies.get(oldestRef);
      spilledBodies.delete(oldestRef);
      // Already gone (manual delete or startup GC) is fine — best-effort.
      io.remove(old.path);
    }
    return ref;
  }

  // ── Live streaming responses (Feature 33) ──────────────────────────────────
  //
  // A `text/event-stream` response (or any response on a request the user marked
  // as streaming) is not buffered: its body is forwarded to the renderer as it
  // arrives over the push channels http:stream:data / -end / -error, while a copy
  // is spilled to disk so the full stream can still be saved. The descriptor's
  // `_stream` context (set in the http:execute handler) carries the stream id and
  // the sender; the in-flight request is tracked here so it can be aborted (Stop)
  // and torn down when its renderer goes away.

  /** streamId → { req, senderId, spillPath, spillStream, bytes, events, recent, ended, contentType, aborted } */
  const activeStreams = new Map();

  // The renderer writes one Timeline record per streaming run (Feature 33). We
  // keep the last few events here (each event's data capped) and hand them off
  // in the stream end/error payload so that record is bounded in size.
  const STREAM_RECORD_EVENTS = 5;
  const STREAM_RECORD_EVENT_MAX = 2048;

  /** Push to a renderer only while its webContents is still alive. */
  function sendTo(sender, channel, payload) {
    if (sender && !sender.isDestroyed()) {
      sender.send(channel, payload);
    }
  }

  /**
   * Assemble a multipart/form-data body from a { boundary, parts } spec built by
   * the renderer (request-payload.js). Text parts are inlined; file parts are
   * streamed from disk — the bytes are read HERE, in the main process, so only
   * the file path ever crossed IPC. `statSync` lets us set an exact
   * Content-Length while still streaming the bytes (so large files don't buffer).
   *
   * Returns the precomputed byte length plus two consumers: `createStream()` for
   * the normal streamed send, and `toBuffer()` for the rare AWS-SigV4 case that
   * must hash the whole body. Throws (caught by the caller) if a file part can't
   * be stat'd / read — a missing upload file is a hard error, not a silent skip.
   *
   * @param {{ boundary: string, parts: object[] }} multipart
   */
  function buildMultipartBody(multipart) {
    const { boundary } = multipart;
    const CRLF = "\r\n";
    // Strip CR/LF and neutralise quotes in field names/filenames so they can't
    // break out of the Content-Disposition header (RFC 7578 sanitisation).
    const clean = (s) =>
      String(s ?? "").replace(/[\r\n"]/g, (c) => (c === '"' ? "%22" : ""));

    const segments = multipart.parts.map((part) => {
      let header = `--${boundary}${CRLF}Content-Disposition: form-data; name="${clean(part.name)}"`;
      if (part.kind === "file") {
        header += `; filename="${clean(part.filename)}"${CRLF}`;
        header += `Content-Type: ${part.contentType || "application/octet-stream"}${CRLF}${CRLF}`;
        return {
          header: Buffer.from(header),
          file: part.filePath,
          contentLen: fs.statSync(part.filePath).size,
        };
      }
      header += `${CRLF}${CRLF}`;
      const buf = Buffer.from(part.value ?? "", "utf8");
      return { header: Buffer.from(header), buf, contentLen: buf.length };
    });
    const closing = Buffer.from(`--${boundary}--${CRLF}`);
    const crlfLen = Buffer.byteLength(CRLF);

    let length = closing.length;
    for (const s of segments)
      length += s.header.length + s.contentLen + crlfLen;

    return {
      length,
      createStream() {
        return Readable.from(
          (async function* () {
            for (const s of segments) {
              yield s.header;
              if (s.file) {
                for await (const chunk of fs.createReadStream(s.file))
                  yield chunk;
              } else {
                yield s.buf;
              }
              yield Buffer.from(CRLF);
            }
            yield closing;
          })(),
        );
      },
      toBuffer() {
        const chunks = [];
        for (const s of segments) {
          chunks.push(s.header);
          chunks.push(s.file ? fs.readFileSync(s.file) : s.buf);
          chunks.push(Buffer.from(CRLF));
        }
        chunks.push(closing);
        return Buffer.concat(chunks);
      },
    };
  }

  /** A credential-free, scheme://host[:port] view of a proxy URL for logging. */
  function describeProxy(proxyUrl) {
    try {
      const u = new URL(proxyUrl);
      return `${u.protocol}//${u.host}`;
    } catch {
      return "(invalid proxy URL)";
    }
  }

  /**
   * Resolve the mTLS / custom-trust configuration for an outgoing request from
   * the global settings (Certificates panel), reading and decrypting the
   * manifest in the main process so passphrases never round-trip through the
   * renderer for the send. Reading happens ONCE per http:execute (the result is
   * threaded onto the descriptor as `_tls` and reused across redirect/auth legs),
   * and the custom CA bundle is read here too so the files are loaded a single
   * time per request rather than per leg. Returns null when nothing is
   * configured, leaving Node's default TLS behaviour completely untouched.
   *
   * @param {string[]} consoleLog
   * @returns {{ clientCerts: Array, insecureHosts: string, caBundle: Buffer[]|null }|null}
   */
  function loadTlsConfig(consoleLog) {
    return safeCall(
      "tls config",
      () => {
        const settings =
          getStores().collectionStore().getManifest().settings || {};
        const clientCerts = Array.isArray(settings.clientCerts)
          ? settings.clientCerts
          : [];
        const caPaths = Array.isArray(settings.caCerts)
          ? settings.caCerts.filter(Boolean)
          : [];
        const insecureHosts = settings.tlsInsecureHosts || "";
        if (!clientCerts.length && !caPaths.length && !insecureHosts) {
          return null;
        }
        const caBundle = loadCaBundle(
          caPaths,
          (p) => fs.readFileSync(p),
          tls.rootCertificates,
          (p, err) =>
            consoleLog.push(`* Custom CA load error (${p}): ${err.message}`),
        );
        if (caBundle) {
          consoleLog.push(
            `* Trusting ${caPaths.length} custom CA file(s) in addition to the system roots`,
          );
        }
        return { clientCerts, insecureHosts, caBundle };
      },
      null,
    );
  }

  /**
   * Apply the resolved TLS config to one request leg's options, by host:
   *   • a matching client certificate is presented (mTLS);
   *   • the custom CA bundle is trusted (global, with verification still on);
   *   • a host on the insecure list has verification skipped for that host only.
   * Mutates `options` in place. A configured-but-unreadable client cert is
   * surfaced in the Console rather than silently sending with no identity.
   *
   * @param {object} options
   * @param {string} host
   * @param {number|string} port
   * @param {{ clientCerts: Array, insecureHosts: string, caBundle: Buffer[]|null }} cfg
   * @param {string[]} consoleLog
   */
  function applyTlsOptions(options, host, port, cfg, consoleLog) {
    if (cfg.caBundle) options.ca = cfg.caBundle;

    if (hostSkipsTlsVerify(host, port, cfg.insecureHosts)) {
      options.rejectUnauthorized = false;
      consoleLog.push(
        `* TLS verification skipped for ${host} (matches insecure-hosts list)`,
      );
    }

    const entry = selectClientCert(host, port, cfg.clientCerts);
    if (entry) {
      try {
        Object.assign(
          options,
          loadClientCertMaterial(entry, (p) => fs.readFileSync(p)),
        );
        consoleLog.push(
          `* Presenting client certificate for ${host} (${entry.format === "pfx" ? "PFX" : "PEM"})`,
        );
      } catch (err) {
        consoleLog.push(
          `* Client certificate error for ${host}: ${err.message}`,
        );
      }
    }
  }

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
      method = "GET",
      url: rawUrl,
      headers = {},
      body = null,
      bodyFilePath = null,
      multipart = null,
      timeout = 30000,
      followRedirects = true,
      verifySsl = true,
      maxRedirects = 10,
      awsIam = null,
      authDigest = null,
      authNtlm = null,
      proxy = null,
      proxyUsername = "",
      proxyPassword = "",
      proxyBypass = "",
      collectionId = null,
      useCookieJar = true,
    } = desc;

    return new Promise((resolve) => {
      // ── Parse URL ──────────────────────────────────────────────────────────
      let parsed;
      try {
        parsed = new URL(rawUrl);
      } catch (e) {
        consoleLog.push(`* URL parse error: ${e.message}`);
        resolve({
          status: 0,
          statusText: "",
          headers: {},
          cookies: [],
          body: "",
          elapsed: Date.now() - startTime,
          size: 0,
          consoleLog,
          error: { name: "TypeError", message: e.message },
        });
        return;
      }

      const isHttps = parsed.protocol === "https:";
      const lib = isHttps ? https : http;
      const defaultPort = isHttps ? 443 : 80;
      const port = parsed.port ? parseInt(parsed.port, 10) : defaultPort;
      const effectiveMethod = method.toUpperCase();

      // ── NTLM negotiate (MS-NLMP) ──────────────────────────────────────────
      // NTLM is connection-bound: the Type 2 challenge and the Type 3 response
      // MUST travel on ONE keep-alive socket. We drive the handshake by
      // recursion with a dedicated single-socket agent (_ntlmAgent) threaded
      // through both legs so they share the connection. This first entry sends
      // the Type 1 negotiate (no body); the 401 it earns carries Type 2, which
      // the response handler answers with Type 3 + the real body. The agent is
      // destroyed once the whole chain settles, so no keep-alive socket leaks.
      if (
        authNtlm?.username &&
        redirects === 0 &&
        !desc._ntlmNegotiate &&
        !desc._ntlmAuthorized
      ) {
        const ntlmAgent = new lib.Agent({
          keepAlive: true,
          maxSockets: 1,
          maxFreeSockets: 1,
        });
        if (proxy) {
          consoleLog.push(
            "* NTLM handshake bypasses the configured proxy (target-server auth)",
          );
        }
        const negHeaders = { ...headers };
        for (const k of Object.keys(negHeaders)) {
          if (k.toLowerCase() === "authorization") delete negHeaders[k];
        }
        negHeaders.Authorization = createType1Message();
        negHeaders["Content-Length"] = "0"; // negotiate leg carries no body
        doRequest(
          {
            ...desc,
            headers: negHeaders,
            _ntlmNegotiate: true,
            _ntlmAgent: ntlmAgent,
          },
          consoleLog,
          startTime,
          redirects,
        ).then((result) => {
          ntlmAgent.destroy();
          resolve(result);
        });
        return;
      }

      // ── Resolve body ───────────────────────────────────────────────────────
      const reqHeaders = { ...headers };
      let bodyBuffer = null;
      let multipartStream = null; // set when streaming a multipart/form-data body

      // ── Attach matching jar cookies ─────────────────────────────────────────
      // The jar lives in the main process; selectCookies() only returns cookies
      // whose domain/path/secure/expiry match this URL, so cookies are never
      // sent across non-matching domains. A user-set Cookie header is preserved
      // and the jar's cookies are merged in after it.
      if (useCookieJar && collectionId) {
        const jarHeader = safeCall(
          "cookie attach",
          () => getStores().cookieStore().cookieHeaderFor(collectionId, rawUrl),
          "",
        );
        if (jarHeader) {
          const existingKey = Object.keys(reqHeaders).find(
            (k) => k.toLowerCase() === "cookie",
          );
          if (existingKey && reqHeaders[existingKey]) {
            reqHeaders[existingKey] =
              `${reqHeaders[existingKey]}; ${jarHeader}`;
          } else {
            reqHeaders[existingKey || "Cookie"] = jarHeader;
          }
        }
      }

      if (redirects === 0 && !desc._ntlmNegotiate) {
        if (multipart) {
          let built;
          try {
            built = buildMultipartBody(multipart);
          } catch (e) {
            consoleLog.push(`* Multipart file error: ${e.message}`);
            resolve({
              status: 0,
              statusText: "",
              headers: {},
              cookies: [],
              body: "",
              elapsed: Date.now() - startTime,
              size: 0,
              consoleLog,
              error: { name: "FileError", message: e.message },
            });
            return;
          }
          if (awsIam?.accessKeyId && awsIam?.secretAccessKey) {
            // SigV4 must hash the whole body — buffer it (rare combo).
            consoleLog.push(
              "* AWS SigV4 + multipart: buffering body in memory so it can be signed",
            );
            bodyBuffer = built.toBuffer();
            if (!reqHeaders["Content-Length"])
              reqHeaders["Content-Length"] = String(bodyBuffer.length);
          } else {
            multipartStream = built.createStream();
            if (!reqHeaders["Content-Length"])
              reqHeaders["Content-Length"] = String(built.length);
          }
        } else if (bodyFilePath) {
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

      // ── AWS SigV4 signing ─────────────────────────────────────────────────
      if (awsIam?.accessKeyId && awsIam?.secretAccessKey) {
        const signOpts = {
          host: parsed.hostname + (parsed.port ? `:${parsed.port}` : ""),
          path: parsed.pathname + parsed.search,
          method: effectiveMethod,
          headers: { ...reqHeaders },
          service: awsIam.service || undefined,
          region: awsIam.region || undefined,
          body: bodyBuffer ? bodyBuffer.toString("utf8") : undefined,
        };
        const creds = {
          accessKeyId: awsIam.accessKeyId,
          secretAccessKey: awsIam.secretAccessKey,
        };
        if (awsIam.sessionToken) creds.sessionToken = awsIam.sessionToken;
        aws4.sign(signOpts, creds);
        Object.assign(reqHeaders, signOpts.headers);
      }

      // ── Outgoing request log ──────────────────────────────────────────────
      // Node's https module speaks HTTP/1.1 by default; ALPN-negotiated HTTP/2
      // would require the http2 module, which this layer does not use.
      const httpVersion = "HTTP/1.1";
      consoleLog.push(
        `> ${effectiveMethod} ${parsed.pathname}${parsed.search} ${httpVersion}`,
      );
      consoleLog.push(
        `> Host: ${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`,
      );
      Object.entries(reqHeaders).forEach(([k, v]) =>
        consoleLog.push(`> ${k}: ${v}`),
      );
      consoleLog.push(">");

      // ── Log request body (if any) with "|" prefix ─────────────────────
      if (bodyBuffer) {
        consoleLog.push("");
        bodyBuffer
          .toString("utf8")
          .split("\n")
          .forEach((line) => consoleLog.push(`| ${line}`));
        consoleLog.push("");
        consoleLog.push("* We are completely uploaded and fine");
      } else if (multipartStream) {
        // The body is streamed (file bytes never buffer), so only summarise it.
        consoleLog.push("");
        consoleLog.push(
          `| [multipart/form-data — ${multipart.parts.length} part(s), streamed from disk]`,
        );
        consoleLog.push("");
        consoleLog.push("* We are completely uploaded and fine");
      }

      // ── Proxy agent selection ───────────────────────────────────────────────
      // Separate (encrypted) credentials are merged into the URL here, never
      // stored inline. Hosts matching the NO_PROXY-style bypass list connect
      // directly. NTLM keeps its own single-socket agent and always bypasses the
      // proxy (the handshake is target-server auth, set up above).
      let proxyAgent = null;
      if (proxy && !desc._ntlmAgent) {
        if (hostBypassesProxy(parsed.hostname, port, proxyBypass)) {
          consoleLog.push(
            `* Bypassing proxy for ${parsed.hostname} (matches no-proxy list)`,
          );
        } else {
          try {
            const effectiveProxyUrl = withProxyCredentials(
              proxy,
              proxyUsername,
              proxyPassword,
            );
            proxyAgent = makeProxyAgent(effectiveProxyUrl, isHttps);
            consoleLog.push(`* Proxying via ${describeProxy(proxy)}`);
          } catch (e) {
            consoleLog.push(`* Invalid proxy configuration: ${e.message}`);
          }
        }
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
        ...(desc._ntlmAgent
          ? { agent: desc._ntlmAgent }
          : proxyAgent
            ? { agent: proxyAgent }
            : {}),
      };

      // ── Per-host TLS material (mTLS client cert, custom CA, verify override) ─
      // Resolved once per request (desc._tls) and applied by host on every leg,
      // so redirects to another host re-match and OAuth token fetches (which run
      // through this same path) are covered automatically.
      if (isHttps && desc._tls) {
        applyTlsOptions(options, parsed.hostname, port, desc._tls, consoleLog);
      }

      // Per-leg timing marks (absolute ms). The socket handler and the response
      // path below populate the rest; computeTiming turns them into the phase
      // waterfall surfaced on the result. Each recursive leg (redirect / auth)
      // gets its own marks, so the resolved result carries the FINAL leg's
      // breakdown — the connection that produced the response the user sees.
      const t = { start: Date.now() };

      const req = lib.request(options, (res) => {
        // First response byte (headers received) — the TTFB marker.
        t.response = Date.now();
        const code = res.statusCode;
        const phrase = res.statusMessage;

        // ── Redirect handling ────────────────────────────────────────────────
        if (followRedirects && [301, 302, 303, 307, 308].includes(code)) {
          // Capture the redirect's own Set-Cookie (login flows set their session
          // cookie on the 302 before bouncing to the authenticated page).
          captureCookies(useCookieJar, collectionId, rawUrl, res.headers);
          const location = res.headers["location"];
          consoleLog.push(`< ${httpVersion} ${code} ${phrase}`);
          Object.entries(res.headers).forEach(([k, v]) => {
            const vals = Array.isArray(v) ? v : [v];
            vals.forEach((vi) => consoleLog.push(`< ${k}: ${vi}`));
          });
          consoleLog.push("<");
          consoleLog.push("");

          if (!location) {
            consoleLog.push("* Redirect missing Location header — stopping");
            res.resume();
            resolve({
              status: code,
              statusText: phrase,
              headers: flatHeaders(res.headers),
              cookies: extractCookies(res.headers),
              body: "",
              elapsed: Date.now() - startTime,
              size: 0,
              consoleLog,
            });
            return;
          }
          if (redirects >= maxRedirects) {
            consoleLog.push(`* Too many redirects (max ${maxRedirects})`);
            res.resume();
            resolve({
              status: code,
              statusText: phrase,
              headers: flatHeaders(res.headers),
              cookies: extractCookies(res.headers),
              body: "",
              elapsed: Date.now() - startTime,
              size: 0,
              consoleLog,
              error: {
                name: "RedirectError",
                message: `Too many redirects (max ${maxRedirects})`,
              },
            });
            return;
          }

          let redirectUrl;
          try {
            redirectUrl = new URL(location, rawUrl).toString();
          } catch {
            redirectUrl = location;
          }

          // HTTP 303 → always GET; POST 301/302 → GET (browser convention)
          const newMethod =
            code === 303 ||
            ([301, 302].includes(code) && effectiveMethod === "POST")
              ? "GET"
              : effectiveMethod;

          consoleLog.push(
            `* Issue another request to this URL: '${redirectUrl}'`,
          );
          if (newMethod !== effectiveMethod) {
            consoleLog.push(`* Switch to ${newMethod}`);
          }
          res.resume(); // drain the redirect body

          doRequest(
            {
              ...desc,
              method: newMethod,
              url: redirectUrl,
              body: newMethod === "GET" ? null : body,
              bodyFilePath: newMethod === "GET" ? null : bodyFilePath,
              multipart: newMethod === "GET" ? null : multipart,
            },
            consoleLog,
            startTime,
            redirects + 1,
          ).then(resolve);
          return;
        }

        // ── Digest auth challenge (RFC 2617 / RFC 7616) ──────────────────────
        // Digest is not connection-bound — the nonce travels in this 401's
        // WWW-Authenticate header — so we answer it as a one-shot retry that
        // recomputes the Authorization header and re-sends. The _digestRetried
        // guard stops a loop when the credentials themselves are wrong (the
        // second 401 falls through to be surfaced normally). The challenge is
        // read from res.rawHeaders so a value containing commas survives intact.
        if (code === 401 && authDigest?.username && !desc._digestRetried) {
          const challenge = parseChallenge(
            selectDigestChallenge(
              rawHeaderValues(res.rawHeaders, "www-authenticate"),
            ),
          );
          const digestHeader = challenge
            ? buildDigestAuthorization({
                method: effectiveMethod,
                uri: parsed.pathname + parsed.search,
                username: authDigest.username,
                password: authDigest.password || "",
                challenge,
                entityBody: bodyBuffer,
              })
            : null;
          if (digestHeader) {
            consoleLog.push(`< ${httpVersion} ${code} ${phrase}`);
            Object.entries(res.headers).forEach(([k, v]) => {
              const vals = Array.isArray(v) ? v : [v];
              vals.forEach((vi) => consoleLog.push(`< ${k}: ${vi}`));
            });
            consoleLog.push("<");
            consoleLog.push("");
            consoleLog.push(
              "* Server requested Digest auth — re-sending with credentials",
            );
            // Some servers pin the nonce to a session cookie set on the 401.
            captureCookies(useCookieJar, collectionId, rawUrl, res.headers);
            res.resume(); // drain the challenge body

            // Rebuild from the ORIGINAL desc headers (not reqHeaders) so the
            // recursion re-merges the cookie jar once; replace any stale
            // Authorization with the freshly computed Digest credential.
            const retryHeaders = { ...headers };
            for (const k of Object.keys(retryHeaders)) {
              if (k.toLowerCase() === "authorization") delete retryHeaders[k];
            }
            retryHeaders.Authorization = digestHeader;

            doRequest(
              { ...desc, headers: retryHeaders, _digestRetried: true },
              consoleLog,
              startTime,
              redirects,
            ).then(resolve);
            return;
          }
          // Unsatisfiable challenge (no Digest offer, missing realm/nonce, or an
          // algorithm we don't implement): fall through and surface the 401.
        }

        // ── NTLM challenge → response (MS-NLMP) ──────────────────────────────
        // The negotiate (Type 1) leg always earns a 401 carrying the Type 2
        // challenge in WWW-Authenticate. We read it from rawHeaders (a blob
        // contains '=' padding), compute Type 3, and re-send on the SAME pinned
        // socket (_ntlmAgent) — this leg carries the real request body. The
        // _ntlmAuthorized flag stops a loop: a second 401 (bad credentials)
        // falls through and is surfaced normally. If the server omits a Type 2
        // blob we also fall through and surface the 401.
        if (code === 401 && desc._ntlmNegotiate && authNtlm?.username) {
          const type2b64 = selectNtlmChallenge(
            rawHeaderValues(res.rawHeaders, "www-authenticate"),
          );
          const type2 = type2b64 ? decodeType2Message(type2b64) : null;
          if (type2) {
            consoleLog.push(`< ${httpVersion} ${code} ${phrase}`);
            Object.entries(res.headers).forEach(([k, v]) => {
              const vals = Array.isArray(v) ? v : [v];
              vals.forEach((vi) => consoleLog.push(`< ${k}: ${vi}`));
            });
            consoleLog.push("<");
            consoleLog.push("");
            consoleLog.push(
              "* Server sent NTLM challenge — answering on the same connection",
            );
            captureCookies(useCookieJar, collectionId, rawUrl, res.headers);
            res.resume(); // drain the challenge body; keep the socket alive

            const type3 = createType3Message({
              type2,
              username: authNtlm.username,
              password: authNtlm.password || "",
              domain: authNtlm.domain || "",
              workstation: authNtlm.workstation || "",
            });

            // Rebuild from the ORIGINAL headers so the cookie jar re-merges
            // once and the negotiate leg's Content-Length:0 is dropped; the
            // body (suppressed on the negotiate leg) is sent on this leg.
            const authHeaders = { ...headers };
            for (const k of Object.keys(authHeaders)) {
              if (k.toLowerCase() === "authorization") delete authHeaders[k];
            }
            authHeaders.Authorization = type3;

            doRequest(
              {
                ...desc,
                headers: authHeaders,
                _ntlmNegotiate: false,
                _ntlmAuthorized: true,
              },
              consoleLog,
              startTime,
              redirects,
            ).then(resolve);
            return;
          }
          // No usable Type 2 challenge — fall through and surface the 401.
        }

        // ── Streaming response (Feature 33) ──────────────────────────────────
        // When the caller opted in (interactive send) and this final 2xx is a
        // text/event-stream — or an application/x-ndjson and the global
        // streamNdjson setting is on — forward the body live over the
        // http:stream:* push channels instead of buffering it. Non-2xx responses
        // always buffer so error pages and the retry layer are unaffected.
        const streamCtx = desc._stream;
        const streamContentType = res.headers["content-type"] || "";
        if (
          streamCtx &&
          code >= 200 &&
          code < 300 &&
          (isEventStream(streamContentType) ||
            (streamCtx.streamNdjson && isNdjson(streamContentType)))
        ) {
          const { id: streamId, sender } = streamCtx;
          const sse = isEventStream(streamContentType);
          const decoder = new StringDecoder("utf8");
          const parser = sse ? new SseParser() : new LineBuffer();

          // Disable the idle socket timeout — a long-lived or sparsely-emitting
          // stream (SSE keep-alives, an idle LLM) must not be killed mid-stream.
          // The user's Stop (req.destroy) and renderer teardown end it instead.
          req.setTimeout(0);

          consoleLog.push(`< ${httpVersion} ${code} ${phrase}`);
          Object.entries(res.headers).forEach(([k, v]) => {
            const vals = Array.isArray(v) ? v : [v];
            vals.forEach((vi) => consoleLog.push(`< ${k}: ${vi}`));
          });
          consoleLog.push("<");
          consoleLog.push("");
          consoleLog.push(
            sse
              ? "* text/event-stream — forwarding Server-Sent Events live"
              : "* Streaming response body live (chunked)",
          );

          // Login flows can set a session cookie on the streaming response too.
          captureCookies(useCookieJar, collectionId, rawUrl, res.headers);

          // Mirror the raw bytes to a temp file so the full stream can be saved
          // on demand, even while it is still running (http:stream:save) or after
          // it ends (the bodyRef redeemed via http:body:save).
          let spillStream = null;
          let spillPath = null;
          let spillError = null;
          try {
            const cacheDir = getStores().paths().responseCacheDir();
            io.ensureDir(cacheDir);
            spillPath = io.newTempPath(cacheDir, "stream");
            spillStream = fs.createWriteStream(spillPath);
            spillStream.on("error", (err) => {
              spillError = err;
            });
          } catch (err) {
            spillError = err;
          }

          const entry = {
            req,
            senderId: sender.id,
            spillPath,
            spillStream,
            bytes: 0,
            events: 0,
            recent: [], // last STREAM_RECORD_EVENTS items, for the Timeline record
            ended: false,
            aborted: false,
            contentType: streamContentType,
          };
          activeStreams.set(streamId, entry);

          // Cap a stored event's data so the (persisted) Timeline record can't be
          // bloated by one huge frame; the full stream still lives in the spill.
          const capData = (s) => {
            const str = String(s ?? "");
            return str.length > STREAM_RECORD_EVENT_MAX
              ? str.slice(0, STREAM_RECORD_EVENT_MAX)
              : str;
          };

          let index = 0;
          const emitItem = (item) => {
            entry.events += 1;
            const ts = Date.now();
            sendTo(sender, "http:stream:data", {
              streamId,
              kind: sse ? "event" : "line",
              index: index++,
              ts,
              ...(sse ? { event: item } : { data: item }),
              totalBytes: entry.bytes,
              count: entry.events,
            });
            // Retain the last few events (data capped) for the Timeline record.
            entry.recent.push(
              sse
                ? {
                    kind: "event",
                    ts,
                    event: {
                      event: item.event,
                      data: capData(item.data),
                      id: item.id,
                    },
                  }
                : { kind: "line", ts, data: capData(item) },
            );
            if (entry.recent.length > STREAM_RECORD_EVENTS)
              entry.recent.shift();
          };
          const pump = (text) => {
            for (const item of parser.feed(text)) emitItem(item);
          };

          res.on("data", (chunk) => {
            entry.bytes += chunk.length;
            if (spillStream && !spillError) {
              // Pause the socket when the write buffer fills, resume on drain —
              // keeps disk-spill memory bounded for a fast producer.
              if (!spillStream.write(chunk)) {
                res.pause();
                spillStream.once("drain", () => res.resume());
              }
            }
            const text = decoder.write(chunk);
            if (text) pump(text);
          });

          const finalize = ({ aborted = false, error = null } = {}) => {
            if (entry.ended) return;
            entry.ended = true;
            // On a clean end, flush any buffered tail bytes / partial final line.
            if (!aborted && !error) {
              try {
                const tail = decoder.end();
                if (tail) pump(tail);
                for (const item of parser.flush()) emitItem(item);
              } catch {
                // best-effort — a decode/parse error at EOF is non-fatal
              }
            }
            const done = () => {
              let bodyRef = null;
              if (!spillError && entry.bytes > 0 && spillPath) {
                bodyRef = registerSpilledBody({
                  path: spillPath,
                  size: entry.bytes,
                  contentType: streamContentType,
                  isBinary: false,
                });
              } else if (spillPath) {
                io.remove(spillPath);
              }
              activeStreams.delete(streamId);
              const base = {
                streamId,
                ts: Date.now(),
                totalBytes: entry.bytes,
                eventCount: entry.events,
                elapsed: Date.now() - startTime,
                status: code,
                bodyRef,
                // Last few events, for the renderer's Timeline record (Feature 33).
                lastEvents: entry.recent,
              };
              if (error && !aborted) {
                sendTo(sender, "http:stream:error", {
                  ...base,
                  name: error.name || "StreamError",
                  message: error.message || String(error),
                });
              } else {
                sendTo(sender, "http:stream:end", { ...base, aborted });
              }
            };
            if (spillStream) spillStream.end(done);
            else done();
          };

          res.on("end", () => finalize({}));
          res.on("error", (err) =>
            finalize({ aborted: entry.aborted, error: err }),
          );
          // Safety net: an abort (req.destroy) or socket teardown closes the
          // response without an "end"; finalize is idempotent so a "close" after
          // a normal "end" is a no-op.
          res.on("close", () => finalize({ aborted: true }));

          // Resolve the http:execute promise NOW with a streaming marker so the
          // renderer switches to live mode; the body keeps flowing over the push
          // channels above.
          resolve({
            status: code,
            statusText: phrase,
            headers: flatHeaders(res.headers),
            cookies: extractCookies(res.headers),
            body: "",
            elapsed: Date.now() - startTime,
            size: 0,
            consoleLog,
            encoding: "utf8",
            streaming: true,
            streamId,
            sse,
            contentType: streamContentType,
          });
          return;
        }

        // ── Buffered-NDJSON hint (Feature 33) ────────────────────────────────
        // We chose not to stream (the global streamNdjson setting is off) but the
        // body is application/x-ndjson, so it buffers — a never-ending feed would
        // just spin. Signal the renderer now, at headers-time, so it can show a
        // "streaming is off" hint while the request runs; that hint is dropped the
        // moment the buffered response (or an error) lands.
        if (
          streamCtx &&
          !streamCtx.streamNdjson &&
          isNdjson(streamContentType)
        ) {
          sendTo(streamCtx.sender, "http:stream:hint", {
            streamId: streamCtx.id,
          });
        }

        // ── Normal response ──────────────────────────────────────────────────
        // Buffer in memory until the body crosses RESPONSE_SPILL_THRESHOLD; from
        // there it streams to a temp file so a multi-hundred-MB payload never
        // lands whole in renderer memory.
        const previewChunks = []; // bounded to RESPONSE_PREVIEW_BYTES
        let previewLen = 0;
        let memChunks = []; // full body, until/unless we spill
        let total = 0;
        let spillStream = null; // fs.WriteStream once the threshold is crossed
        let spillPath = null;
        let spillError = null;

        const appendPreview = (chunk) => {
          if (previewLen >= RESPONSE_PREVIEW_BYTES) return;
          const remaining = RESPONSE_PREVIEW_BYTES - previewLen;
          const slice =
            chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
          previewChunks.push(slice);
          previewLen += slice.length;
        };

        res.on("data", (chunk) => {
          total += chunk.length;
          appendPreview(chunk);

          if (spillStream) {
            // Pause the socket when the write buffer fills, resume on drain —
            // keeps memory bounded regardless of how fast the peer sends.
            if (!spillStream.write(chunk)) {
              res.pause();
              spillStream.once("drain", () => res.resume());
            }
            return;
          }

          memChunks.push(chunk);
          if (total > RESPONSE_SPILL_THRESHOLD) {
            try {
              const cacheDir = getStores().paths().responseCacheDir();
              io.ensureDir(cacheDir);
              spillPath = io.newTempPath(cacheDir, "response");
              spillStream = fs.createWriteStream(spillPath);
              spillStream.on("error", (err) => {
                spillError = err;
              });
              for (const c of memChunks) spillStream.write(c);
            } catch (err) {
              spillError = err;
            }
            memChunks = []; // release the buffered body
          }
        });

        res.on("end", () => {
          t.end = Date.now();
          const elapsed = Date.now() - startTime;

          consoleLog.push(`< ${httpVersion} ${code} ${phrase}`);
          Object.entries(res.headers).forEach(([k, v]) => {
            const vals = Array.isArray(v) ? v : [v];
            vals.forEach((vi) => consoleLog.push(`< ${k}: ${vi}`));
          });
          consoleLog.push("<");
          consoleLog.push("");
          consoleLog.push(`* Received ${total} B total`);
          consoleLog.push(
            `* Connection to host ${parsed.hostname} left intact`,
          );

          // Per-phase timing waterfall (DNS/TCP/TLS/TTFB/download) appended to
          // the verbose Console log; absent phases (plain HTTP, reused sockets)
          // are skipped. Persisted with consoleLog, so it replays from history.
          for (const line of formatTiming(computeTiming(t, { isHttps }))) {
            consoleLog.push(line);
          }

          captureCookies(useCookieJar, collectionId, rawUrl, res.headers);

          const base = {
            status: code,
            statusText: phrase,
            headers: flatHeaders(res.headers),
            cookies: extractCookies(res.headers),
            elapsed,
            consoleLog,
          };

          const respContentType = res.headers["content-type"] || "";

          if (!spillStream) {
            // Small response — fully in memory. Text crosses IPC as UTF-8; binary
            // is carried as base64 so non-text bytes survive intact.
            const rawBody = Buffer.concat(memChunks);
            const binary =
              isBinaryContentType(respContentType) ||
              (!respContentType && looksBinary(rawBody));
            resolve({
              ...base,
              body: binary
                ? rawBody.toString("base64")
                : rawBody.toString("utf8"),
              encoding: binary ? "base64" : "utf8",
              size: total,
            });
            return;
          }

          // Spilled response — finish the temp file, then hand back a preview
          // plus a ref the renderer can redeem for the full body on demand. The
          // temp file holds the raw bytes; for binary, the preview is base64 so
          // the renderer's hex/image view receives intact bytes.
          const previewBuf = Buffer.concat(previewChunks);
          const binary =
            isBinaryContentType(respContentType) ||
            (!respContentType && looksBinary(previewBuf));
          const previewBody = binary
            ? previewBuf.toString("base64")
            : previewBuf.toString("utf8");
          const previewEncoding = binary ? "base64" : "utf8";
          spillStream.end(() => {
            if (spillError) {
              io.remove(spillPath);
              consoleLog.push(
                `* Failed to buffer full response to disk: ${spillError.message}`,
              );
              resolve({
                ...base,
                body: previewBody,
                encoding: previewEncoding,
                size: total,
                truncated: true,
                fullSize: total,
                error: { name: "SpillError", message: spillError.message },
              });
              return;
            }
            const bodyRef = registerSpilledBody({
              path: spillPath,
              size: total,
              contentType: respContentType,
              isBinary: binary,
            });
            consoleLog.push(
              `* Response exceeded ${RESPONSE_SPILL_THRESHOLD} B — buffered to disk; previewing first ${previewLen} B`,
            );
            resolve({
              ...base,
              body: previewBody,
              encoding: previewEncoding,
              size: total,
              truncated: true,
              bodyRef,
              fullSize: total,
            });
          });
        });

        res.on("error", (err) => {
          const elapsed = Date.now() - startTime;
          consoleLog.push(`* Stream error: ${err.message}`);
          if (spillStream) {
            try {
              spillStream.destroy();
            } catch {
              // best-effort
            }
            io.remove(spillPath);
          }
          resolve({
            status: code,
            statusText: phrase,
            headers: {},
            cookies: [],
            body: "",
            elapsed,
            size: 0,
            consoleLog,
            error: { name: "StreamError", message: err.message },
          });
        });
      });

      req.on("socket", (socket) => {
        t.socket = Date.now();
        // ── DNS resolution ──────────────────────────────────────────────────
        socket.on("lookup", (err, address, _family, hostname) => {
          t.lookup = Date.now();
          if (err) {
            consoleLog.push(
              `* Could not resolve host '${hostname}': ${err.message}`,
            );
          } else {
            consoleLog.push(`* Resolved '${hostname}' → ${address}`);
            consoleLog.push(`* Trying ${address}:${port}...`);
          }
        });

        // ── TCP connection established ───────────────────────────────────────
        socket.on("connect", () => {
          t.connect = Date.now();
          const remoteAddr = socket.remoteAddress;
          const remotePort = socket.remotePort;
          consoleLog.push(
            `* Connected to ${parsed.hostname} (${remoteAddr}) port ${remotePort}`,
          );
          if (isHttps) {
            consoleLog.push(
              `* Performing TLS handshake with '${parsed.hostname}'...`,
            );
          }
        });

        // ── TLS handshake complete (HTTPS only) ─────────────────────────────
        if (isHttps) {
          socket.on("secureConnect", () => {
            t.secure = Date.now();
            const protocol = socket.getProtocol();
            const cipher = socket.getCipher();
            consoleLog.push(
              `* SSL connection using ${protocol} / ${cipher.standardName || cipher.name}`,
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
        // Tag with a code so the retry layer can tell a timeout apart from a
        // plain connection error (result.error.code carries err.code; .name is
        // kept as the renderer-facing label).
        req.destroy(
          Object.assign(new Error(`Request timed out after ${timeout}ms`), {
            code: "ETIMEDOUT",
          }),
        );
      });

      req.on("error", (err) => {
        const elapsed = Date.now() - startTime;
        consoleLog.push(`* ${err.message}`);
        resolve({
          status: 0,
          statusText: "",
          headers: {},
          cookies: [],
          body: "",
          elapsed,
          size: 0,
          consoleLog,
          error: {
            // `.name` is the renderer-facing label; `.code` is the canonical
            // discriminator the retry layer classifies on (see net/retry.js).
            name: err.code || err.name || "NetworkError",
            code: err.code || err.name || "NetworkError",
            message: err.message,
          },
        });
      });

      if (multipartStream) {
        // pipe() ends the request when the stream finishes; a read error on a
        // file part aborts the request, surfacing through req's "error" handler.
        multipartStream.on("error", (e) => {
          consoleLog.push(`* Multipart stream error: ${e.message}`);
          req.destroy(e);
        });
        multipartStream.pipe(req);
      } else {
        if (bodyBuffer) req.write(bodyBuffer);
        req.end();
      }
    });
  }

  /** Promise-based delay used between retry attempts. */
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Run a request under the configured retry policy. doRequest already follows
   * one whole redirect/auth chain per call, so a retry re-runs that entire chain
   * from scratch. Retries fire on connection errors, timeouts, and opted-in
   * status codes with exponential backoff; every attempt and wait is surfaced in
   * the Console. With no policy this is a single attempt, identical to before.
   *
   * @param {object}   descriptor
   * @param {string[]} consoleLog
   * @param {number}   startTime
   */
  async function executeWithRetries(descriptor, consoleLog, startTime) {
    const policy = normalizeRetry(descriptor.retry);
    const maxAttempts = policy ? policy.maxAttempts : 1;

    let attempt = 0;
    let result;
    while (attempt < maxAttempts) {
      attempt++;
      if (attempt > 1) {
        consoleLog.push(`* Attempt ${attempt} of ${maxAttempts}`);
      }
      result = await doRequest(descriptor, consoleLog, startTime, 0);

      if (!policy || attempt >= maxAttempts) break;
      const reason = retryReason(result, policy);
      if (!reason) break;

      const delay = backoffDelay(policy, attempt);
      consoleLog.push(
        `* Request failed (${reason}); retrying in ${delay}ms ` +
          `(attempt ${attempt + 1}/${maxAttempts})`,
      );
      await sleep(delay);
    }

    if (attempt > 1) {
      consoleLog.push(`* Finished after ${attempt} attempt(s)`);
      result.attempts = attempt;
    }
    return result;
  }

  /** Flatten Node's multi-value header object into a plain key→string map. */
  function flatHeaders(hdrs) {
    const out = {};
    Object.entries(hdrs).forEach(([k, v]) => {
      out[k] = Array.isArray(v) ? v.join(", ") : v;
    });
    return out;
  }

  /**
   * Collect every value for header `name` (case-insensitive) from Node's
   * `res.rawHeaders` flat [name, value, name, value, …] array. Unlike the
   * joined `res.headers` map, this keeps duplicate WWW-Authenticate challenges
   * separate, so a Digest challenge that itself contains commas is not
   * corrupted by header folding.
   *
   * @param {string[]} rawHeaders  res.rawHeaders
   * @param {string} name          header name to match
   * @returns {string[]}
   */
  function rawHeaderValues(rawHeaders, name) {
    const out = [];
    if (!Array.isArray(rawHeaders)) return out;
    const target = name.toLowerCase();
    for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
      if (String(rawHeaders[i]).toLowerCase() === target) {
        out.push(rawHeaders[i + 1]);
      }
    }
    return out;
  }

  /** Extract Set-Cookie header values as a string array. */
  function extractCookies(hdrs) {
    const sc = hdrs["set-cookie"];
    return Array.isArray(sc) ? sc : sc ? [sc] : [];
  }

  /**
   * Persist any Set-Cookie headers from a response into the collection's jar.
   * No-op when the jar is bypassed, no collection is in scope, or there are no
   * cookies. Called for both terminal and intermediate (redirect) responses so
   * login→redirect flows capture their session cookie. Storage lives entirely
   * in the main process; cross-domain cookies are rejected by cookie-jar.js.
   *
   * @param {boolean} useCookieJar   per-request jar toggle
   * @param {string|null} collectionId
   * @param {string} url             the URL this response came from
   * @param {object} resHeaders      Node response headers
   */
  function captureCookies(useCookieJar, collectionId, url, resHeaders) {
    if (!useCookieJar || !collectionId) return;
    const lines = extractCookies(resHeaders);
    if (lines.length === 0) return;
    safeCall("cookie capture", () => {
      getStores().cookieStore().captureSetCookies(collectionId, url, lines);
    });
  }

  // ── IPC handler ─────────────────────────────────────────────────────────────
  ipcMain.handle("http:execute", async (event, descriptor) => {
    const consoleLog = [];
    const startTime = Date.now();
    const _timeout = descriptor.timeout || 30000;
    consoleLog.push(`* Preparing request to ${descriptor.url}`);
    consoleLog.push(`* Current time is ${new Date().toISOString()}`);
    consoleLog.push(`* Enable automatic URL encoding`);
    consoleLog.push(`* Using default HTTP version`);
    consoleLog.push(`* Enable timeout of ${_timeout}ms`);
    consoleLog.push(
      descriptor.verifySsl === false
        ? `* Disable SSL validation`
        : `* Enable SSL validation`,
    );
    console.log("[http:execute] →", descriptor.method, descriptor.url);
    // Resolve per-host TLS material once (mTLS client certs, custom CA, verify
    // overrides). Threaded onto the descriptor so every redirect/auth leg reuses
    // it; null when nothing is configured, leaving default behaviour unchanged.
    descriptor._tls = loadTlsConfig(consoleLog);
    // Streaming context (Feature 33): only interactive sends set streamCapable,
    // so folder runs and dependency prefetches never switch to live streaming.
    // text/event-stream always auto-streams; application/x-ndjson streams only
    // when streamNdjson (the global "Stream NDJSON responses live" setting) is on.
    if (descriptor.streamCapable === true) {
      descriptor._stream = {
        id: descriptor.streamId || io.newUUID(),
        streamNdjson: descriptor.streamNdjson === true,
        sender: event.sender,
      };
    }
    try {
      const result = await executeWithRetries(
        descriptor,
        consoleLog,
        startTime,
      );
      console.log(
        "[http:execute] ←",
        result.status,
        result.statusText,
        `${result.elapsed}ms`,
      );
      return result;
    } catch (err) {
      console.error("[http:execute] unexpected error:", err);
      consoleLog.push(`* Unexpected error: ${err.message}`);
      return {
        status: 0,
        statusText: "",
        headers: {},
        cookies: [],
        body: "",
        elapsed: Date.now() - startTime,
        size: 0,
        consoleLog,
        error: { name: err.name || "Error", message: err.message },
      };
    }
  });

  // Redeem a spill ref for the full response body (user-initiated "View full").
  ipcMain.handle("http:body:get", async (_event, ref) => {
    const entry = spilledBodies.get(ref);
    if (!entry) {
      return {
        error: {
          name: "NotFound",
          message: "The full response is no longer cached.",
        },
      };
    }
    try {
      const buf = await fs.promises.readFile(entry.path);
      return {
        body: entry.isBinary ? buf.toString("base64") : buf.toString("utf8"),
        encoding: entry.isBinary ? "base64" : "utf8",
        size: entry.size,
        contentType: entry.contentType,
      };
    } catch (err) {
      return { error: { name: "ReadError", message: err.message } };
    }
  });

  // Copy a spilled response body straight to a user-chosen file — the full
  // payload never travels back through the renderer.
  ipcMain.handle("http:body:save", async (_event, { ref, filename } = {}) => {
    const entry = spilledBodies.get(ref);
    if (!entry) return { ok: false, reason: "not-found" };
    const result = await dialog.showSaveDialog(_mainWin ?? undefined, {
      defaultPath: filename || "response.bin",
    });
    if (result.canceled || !result.filePath) {
      return { ok: false, reason: "canceled" };
    }
    try {
      await fs.promises.copyFile(entry.path, result.filePath);
      return { ok: true, path: result.filePath };
    } catch (err) {
      return { ok: false, reason: "error", message: err.message };
    }
  });

  // ── Live-stream control (Feature 33) ───────────────────────────────────────

  // Stop a live stream — destroys the underlying request, which finalizes the
  // stream (an http:stream:end with aborted:true is pushed to the renderer).
  ipcMain.handle("http:stream:abort", (_event, { streamId } = {}) => {
    const entry = activeStreams.get(streamId);
    if (!entry) return { ok: false, reason: "not-found" };
    entry.aborted = true;
    try {
      entry.req.destroy();
    } catch {
      // already torn down — finalize will still run via the close/error handler
    }
    return { ok: true };
  });

  // Save the bytes received so far on a STILL-RUNNING stream. Once a stream
  // ends it registers a spill bodyRef, after which the renderer saves via the
  // existing http:body:save instead.
  ipcMain.handle(
    "http:stream:save",
    async (_event, { streamId, filename } = {}) => {
      const entry = activeStreams.get(streamId);
      if (!entry || !entry.spillPath) return { ok: false, reason: "not-found" };
      const result = await dialog.showSaveDialog(_mainWin ?? undefined, {
        defaultPath: filename || "stream.txt",
      });
      if (result.canceled || !result.filePath) {
        return { ok: false, reason: "canceled" };
      }
      try {
        await fs.promises.copyFile(entry.spillPath, result.filePath);
        return { ok: true, path: result.filePath };
      } catch (err) {
        return { ok: false, reason: "error", message: err.message };
      }
    },
  );

  // ── Lifecycle cleanup — never leak a live stream past its renderer ─────────
  // A reload (did-navigate) or a destroyed/crashed webContents aborts every
  // stream that renderer owned; finalize unlinks the spill file.
  app.on("web-contents-created", (_e, contents) => {
    const drop = () => {
      for (const entry of activeStreams.values()) {
        if (entry.senderId === contents.id) {
          entry.aborted = true;
          try {
            entry.req.destroy();
          } catch {
            // best-effort
          }
        }
      }
    };
    contents.on("did-navigate", drop);
    contents.on("render-process-gone", drop);
    contents.on("destroyed", drop);
  });
})();

// ─── WebSocket IPC (Feature 32) ──────────────────────────────────────────────
// Owns every live ws://wss:// connection in the main process — the sandboxed
// renderer can't open raw sockets. Connections are driven by the request/reply
// channels ws:open / ws:send / ws:close / ws:ping and stream their lifecycle +
// inbound frames back over the ws:status / ws:message push channels. Proxy and
// TLS settings are honored exactly as on the HTTP path (see net/websocket.js).
(function initWebSocketIPC() {
  const hub = new WebSocketHub();

  /** Push to a renderer only while its webContents is still alive. */
  function sendTo(sender, channel, payload) {
    if (sender && !sender.isDestroyed()) {
      sender.send(channel, payload);
    }
  }

  // Open a connection. Returns an opaque id the renderer uses for subsequent
  // send/close/ping calls and to demultiplex the ws:status / ws:message pushes.
  ipcMain.handle("ws:open", (event, opts = {}) => {
    const id = io.newUUID();
    const sender = event.sender;
    console.log("[ws:open] →", opts.url);
    hub.open(
      id,
      { ...opts, senderId: sender.id },
      {
        onStatus: (status) => sendTo(sender, "ws:status", { id, ...status }),
        onMessage: (frame) => sendTo(sender, "ws:message", { id, ...frame }),
      },
    );
    return { id };
  });

  ipcMain.handle("ws:send", (_event, { id, data } = {}) => hub.send(id, data));

  ipcMain.handle("ws:close", (_event, { id, code, reason } = {}) =>
    hub.close(id, code, reason),
  );

  ipcMain.handle("ws:ping", (_event, { id } = {}) => hub.ping(id));

  // ── Lifecycle cleanup — never leak a socket past its renderer ──────────────
  // A reload (did-navigate) or a destroyed/crashed webContents drops every
  // connection that renderer owned; quitting drops them all.
  app.on("web-contents-created", (_e, contents) => {
    const drop = () => hub.closeForSender(contents.id);
    contents.on("did-navigate", drop); // full reload (incl. dev hot-reload)
    contents.on("render-process-gone", drop);
    contents.on("destroyed", drop);
  });
  app.on("before-quit", () => hub.closeAll());
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
      const nav = new URL(navUrl);
      const redirect = new URL(redirectUri);
      // urn: schemes (urn:ietf:wg:oauth:2.0:oob) cannot be matched via URL navigation
      if (redirect.protocol === "urn:") return false;
      const sameOrigin =
        nav.protocol.toLowerCase() === redirect.protocol.toLowerCase() &&
        nav.hostname.toLowerCase() === redirect.hostname.toLowerCase() &&
        nav.port === redirect.port;
      const samePath =
        nav.pathname === redirect.pathname ||
        (redirect.pathname === "/" &&
          (nav.pathname === "" || nav.pathname === "/"));
      return sameOrigin && samePath;
    } catch {
      // Fallback for unusual URI schemes
      return navUrl.startsWith(redirectUri);
    }
  }

  ipcMain.handle(
    "oauth:open-popup",
    (_event, { authUrl, redirectUri, title }) => {
      return new Promise((resolve) => {
        const popup = new BrowserWindow({
          width: 860,
          height: 720,
          title:
            title || activeLabels()("dialog.oauthTitle", "OAuth Authorization"),
          parent: _mainWin || undefined,
          modal: false,
          show: false,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
          },
          autoHideMenuBar: true,
        });

        // Only reveal the window once the page is actually painted — if the auth
        // server immediately redirects (e.g. SSO session already active) the flow
        // resolves before this fires and the window is never shown.
        popup.once("ready-to-show", () => {
          if (!_resolved) popup.show();
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
          } catch {
            /* already destroyed */
          }
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
        popup.webContents.on("did-navigate", (_e, url) => {
          if (_matchesRedirect(url, redirectUri))
            _finish({ url, cancelled: false });
        });
        popup.webContents.on("did-navigate-in-page", (_e, url) => {
          if (_matchesRedirect(url, redirectUri))
            _finish({ url, cancelled: false });
        });

        // ── Catch failed loads — e.g. http://localhost redirect with no listener ─
        // The browser will fail to connect to the localhost redirect, but the URL
        // still contains the authorization code we need.
        popup.webContents.on(
          "did-fail-load",
          (_e, _code, _desc, validatedUrl) => {
            if (_matchesRedirect(validatedUrl, redirectUri)) {
              _finish({ url: validatedUrl, cancelled: false });
            }
          },
        );

        // ── User closed the window before completing login ─────────────────────
        popup.on("closed", () => _finish({ url: null, cancelled: true }));

        // ── Load the authorization URL ─────────────────────────────────────────
        popup.loadURL(authUrl).catch((err) => {
          console.error("[oauth:popup] loadURL error:", err.message);
          _finish({ url: null, cancelled: true });
        });
      });
    },
  );

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

// ─── Native context menu IPC ──────────────────────────────────────────────────
// Pops a real OS context menu at (x, y) within the calling window and resolves
// with the id of the clicked item — or null if the menu was dismissed.
//
// Items shape: [{ id, label, type?: "separator", enabled?: boolean }]
(function initContextMenuIPC() {
  ipcMain.handle("ui:context-menu:show", (event, { items, x, y } = {}) => {
    return new Promise((resolve) => {
      let resultId = null;

      const template = (items ?? []).map((item) => {
        if (item?.type === "separator") return { type: "separator" };
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
        return entry;
      });

      const menu = Menu.buildFromTemplate(template);
      const win =
        BrowserWindow.fromWebContents(event.sender) ?? _mainWin ?? undefined;

      const popupOpts = { window: win, callback: () => resolve(resultId) };
      if (Number.isFinite(x) && Number.isFinite(y)) {
        popupOpts.x = Math.round(x);
        popupOpts.y = Math.round(y);
      }
      menu.popup(popupOpts);
    });
  });
})();

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
          const { name } = args;
          const val = process.env[name];
          return { result: val !== undefined ? String(val) : "" };
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
const APP_ICON_PATH = path.join(__dirname, "..", "web", "wurl-logo.png");
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
    title: "wurl",
    icon: appIcon,
    backgroundColor: "#1e1e2e",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, // Renderer cannot access Node APIs directly
      nodeIntegration: false, // Keep Node out of the renderer
      sandbox: true, // Extra process isolation
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

  // Track the main window globally so the HTML preview IPC can reference it.
  _mainWin = win;
  win.on("closed", () => {
    _mainWin = null;
    _htmlPreviewView = null;
    _htmlPreviewAdded = false;
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
        extensions: ["json", "yaml", "yml"],
      },
    ],
    properties: ["openFile"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const content = await fs.promises.readFile(result.filePaths[0], "utf-8");
  return { filename: path.basename(result.filePaths[0]), content };
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
    defaultPath: `wurl-backup-${_backupDateStamp()}.json`,
    filters: [
      {
        name: m("dialog.wurlBackupFilter", "wurl Backup"),
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
        name: m("dialog.wurlBackupFilter", "wurl Backup"),
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
    if (!envelope || envelope.kind !== "wurl-backup") {
      return {
        ok: false,
        error: m(
          "dialog.invalidBackup",
          "The selected file is not a valid wurl backup.",
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
              "The selected file is not a valid wurl backup.",
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

// ─── About dialog ─────────────────────────────────────────────────────────────
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

function showAboutDialog() {
  // Bring existing window to front rather than opening a second one
  if (_aboutWin) {
    _aboutWin.focus();
    return;
  }

  const rev = readRevisionInfo();

  // Read the current theme so the about window matches the app's colour scheme
  let theme = "mocha";
  try {
    const manifest = getStores().collectionStore().getManifest();
    theme = manifest?.settings?.theme ?? "mocha";
  } catch {
    /* fall back to default theme */
  }

  // Build query params carrying dynamic data into the static HTML page
  const query = { theme };
  if (rev) {
    if (rev.VERSION) query.version = rev.VERSION;
    if (rev.BRANCH) query.branch = rev.BRANCH;
    if (rev.COMMIT) query.commit = rev.COMMIT;
  }

  _aboutWin = new BrowserWindow({
    width: 360,
    height: 480,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    title: activeLabels()("menu.about", "About wurl"),
    icon: appIcon,
    backgroundColor: "#1e1e2e",
    parent: _mainWin ?? undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  _aboutWin.loadFile(path.join(__dirname, "..", "web", "about.html"), {
    query,
  });

  _aboutWin.once("closed", () => {
    _aboutWin = null;
  });
}

// ─── Theme editor ─────────────────────────────────────────────────────────────
function showThemeEditor() {
  if (_themeEditorWin) {
    _themeEditorWin.focus();
    return;
  }
  let theme = "mocha";
  try {
    const manifest = getStores().collectionStore().getManifest();
    theme = manifest?.settings?.theme ?? "mocha";
  } catch {}
  _themeEditorWin = new BrowserWindow({
    width: 900,
    height: 640,
    minWidth: 700,
    minHeight: 480,
    resizable: true,
    autoHideMenuBar: true,
    title: activeLabels()("themeEditor.windowTitle", "Theme Editor — wurl"),
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
  let theme = "mocha";
  try {
    theme =
      getStores().collectionStore().getManifest()?.settings?.theme ?? "mocha";
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
    title: activeLabels()("menu.userGuide", "wurl User Guide"),
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
        defaultPath: `${safe}.wurl-theme.json`,
        filters: [
          {
            name: m("dialog.wurlThemeFilter", "wurl Theme"),
            extensions: ["json"],
          },
        ],
      },
    );
    if (canceled || !filePath) return false;
    fs.writeFileSync(
      filePath,
      JSON.stringify({ "wurl-theme": "1", ...themeData }, null, 2),
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
            name: m("dialog.wurlThemeFilter", "wurl Theme"),
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
  };
}

/** Open the log directory in the OS file manager (creating it if needed). */
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
    defaultPath: `wurl-diagnostics-${_backupDateStamp()}.txt`,
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
        title: m("dialog.fatalErrorTitle", "wurl encountered a problem"),
        message: m(
          "dialog.fatalErrorMsg",
          "An unexpected error occurred and wurl needs to close.",
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
  try {
    const m = activeLabels();
    dialog.showMessageBox(
      _mainWin && !_mainWin.isDestroyed() ? _mainWin : undefined,
      {
        type: "warning",
        icon: appIcon,
        buttons: [m("common.ok", "OK")],
        title: m("dialog.unhandledRejectionTitle", "Unexpected error"),
        message: m(
          "dialog.unhandledRejectionMsg",
          "An unexpected error occurred. wurl will keep running.",
        ),
        detail: err.message,
      },
    );
  } catch {
    /* best-effort notice */
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

// ─── Application menu ─────────────────────────────────────────────────────────
function buildMenu() {
  const m = activeLabels();
  const template = [
    {
      label: "wurl", // app name — proper noun, shown verbatim in every locale
      // keep wurl app menu first on macOS
      submenu: [
        { label: m("menu.about", "About wurl"), click: showAboutDialog },
        {
          label: m("menu.themeEditor", "Theme Editor…"),
          click: showThemeEditor,
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
          label: m("menu.importCollection", "Import Collection…"),
          accelerator: "CmdOrCtrl+Shift+I",
          click: () => {
            if (_mainWin && !_mainWin.isDestroyed())
              _mainWin.webContents.send("menu:import");
          },
        },
        {
          label: m("menu.exportAll", "Export All Collections…"),
          click: () => {
            if (_mainWin && !_mainWin.isDestroyed())
              _mainWin.webContents.send("menu:export-all");
          },
        },
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
        // Custom font-size zoom — delegates to the renderer's zoom handler so
        // the settings fontSize is adjusted (and persisted) instead of performing
        // a Chromium visual zoom that bypasses the app theming system.
        {
          label: m("menu.fontIncrease", "Increase Font Size"),
          click: () => {
            if (_mainWin && !_mainWin.isDestroyed())
              _mainWin.webContents.send("wurl:ui-font-change", "in");
          },
        },
        {
          label: m("menu.fontDecrease", "Decrease Font Size"),
          click: () => {
            if (_mainWin && !_mainWin.isDestroyed())
              _mainWin.webContents.send("wurl:ui-font-change", "out");
          },
        },
        {
          label: m("menu.fontReset", "Reset Font Size"),
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
      label: m("menu.window", "Window"),
      submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }],
    },
    {
      label: m("menu.help", "Help"),
      // role: "help" lets macOS group this as the standard Help menu.
      role: "help",
      submenu: [
        {
          label: m("menu.userGuide", "wurl User Guide"),
          accelerator: "CmdOrCtrl+/",
          click: showDocsWindow,
        },
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
    `wurl ${app.getVersion()} ready (${process.platform})`,
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

  // macOS: re-open a window when the dock icon is clicked with no open windows.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0)
      createWindow(loadWindowState());
  });
});
