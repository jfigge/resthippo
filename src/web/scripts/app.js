/**
 * app.js — Application entry point
 *
 * Wires together:
 *   - The three top-level panels (nav / request / response) from the HTML
 *   - Mounts the TreeView, RequestEditor, and ResponseViewer components
 *   - Sets up the two CSS-grid splitters with drag-to-resize
 *   - Routes events between components
 *   - Handles layout-mode changes so splitter cursors stay correct
 */

"use strict";

import { LayoutPicker } from "./components/layout-picker.js";
import { TreeView } from "./components/tree-view.js";
import { RequestEditor } from "./components/request-editor.js";
import { applyCaptures } from "./components/captures.js";
import {
  buildRequestPayload,
  applyPathParams,
  resolvePathParamValues,
} from "./components/request-payload.js";
import { ResponseViewer } from "./components/response-viewer.js";
import { WsConsole } from "./components/ws-console.js";
import { SettingsPopup } from "./components/settings-popup.js";
import { CollectionsPopup } from "./components/collections-popup.js";
import { VariablesPopup } from "./components/variables-popup.js";
import { EnvironmentsPopup } from "./components/environments-popup.js";
import { EnvPicker } from "./components/env-picker.js";
import {
  loadAll,
  saveCollections,
  updateRequest,
  setActiveItems,
  saveSettings,
  saveManifest,
  loadCollectionData,
  saveCollectionData,
  setActiveCollection,
  saveCollectionVariables,
  deleteRequest,
  deleteCollection,
  listHistory,
  addHistory,
  getHistoryResponse,
  deleteHistory,
  clearHistory,
  trimHistory,
  saveEnvironments,
  setWriteErrorHandler,
} from "./data-store.js";
import { Notifications } from "./notifications.js";
import {
  buildFolderChain,
  resolveStringAsync,
} from "./components/variable-resolver.js";
import { setPickerDebounceMs } from "./components/variable-pill-editor.js";
import {
  normalizeVariables,
  varsArrayToMap,
  varsArrayToSecureSet,
} from "./components/variable-shape.js";
import {
  makeEntry,
  addRecent,
  addFavorite,
  removeIds,
  removeCollection,
  reconcile,
} from "./quick-access.js";
import {
  parseImport,
  parseCurl,
  collectFormFilePaths,
  warnMissingFormFiles,
} from "./import/index.js";
import { exportToPostman } from "./export/postman.js";
import { exportToInsomnia } from "./export/insomnia.js";
import { exportToOpenApi } from "./export/openapi.js";
import { exportToHar } from "./export/har.js";
import { ExportModal } from "./components/export-modal.js";
import { installMenuHandlers } from "./event-bus/menu-handlers.js";
import { installSettingsHandlers } from "./event-bus/settings-handlers.js";
import { installWsHandlers } from "./event-bus/ws-handlers.js";
import { installTimelineHandlers } from "./event-bus/timeline-handlers.js";
import { PopupManager } from "./popup-manager.js";
import * as i18n from "./i18n.js";
import { t } from "./i18n.js";

// ─── Renderer crash mirroring ───────────────────────────────────────────────────
// Forward uncaught renderer errors and unhandled promise rejections to the main
// process so they land in the persistent log alongside main-process diagnostics
// (see preload.js → wurl.diagnostics). Registered at module load so the earliest
// failures are caught. Best-effort and silent: a reporting failure must never mask
// the original error, and there is no UI side effect here.
(function installRendererDiagnostics() {
  const report = (info) => {
    try {
      window.wurl?.diagnostics?.reportError?.(info);
    } catch {
      /* logging is best-effort */
    }
  };
  window.addEventListener("error", (e) => {
    report({
      source: "window.onerror",
      message: e.message || String(e.error || "error"),
      stack: e.error && e.error.stack ? e.error.stack : undefined,
    });
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason;
    report({
      source: "unhandledrejection",
      message: reason && reason.message ? reason.message : String(reason),
      stack: reason && reason.stack ? reason.stack : undefined,
    });
  });
})();

// ─── History state ────────────────────────────────────────────────────────────
// Per-request in-memory execution history. Keyed by request node ID.
// Each entry: { id, requestNode, requestUrl, response, timestamp }
const _requestHistory = new Map();
// Tracks which request IDs have been fully loaded from persistent storage.
const _historyLoaded = new Set();
let _maxHistory = 5; // updated from settings at startup and on change
let _skipNextHistory = false; // set true when replaying a history entry

// Live streaming runs (Feature 33) don't surface a whole response body, so they
// are recorded only once the stream ends. The streaming marker carries the
// request/status/headers; the stream-end push carries duration, counts, and the
// last events. We bridge the two here, keyed by streamId.
// streamId → { node, requestUrl, status, statusText, headers, cookies, consoleLog, sse }
const _pendingStreams = new Map();

// ─── Request / selection state ──────────────────────────────────────────────
// Shared across the event-bus handler groups (some now in scripts/event-bus/*),
// so it lives at module scope rather than inside initEventBus(). The extracted
// modules read/write it through the bus context (buildBusContext); the in-file
// core groups reference these bindings directly.
//
// In-flight executions, one record per running request. Requests run
// concurrently, so each carries its own cancel flag, request snapshot, and
// (in Go-dev mode) AbortController. Record: { requestId, snapshot, abortController, cancelled }
const _inFlightExecs = new Set();
// Currently selected tree node (request or folder), for context functions.
let _selectedNode = null;
// Response caches keyed by request name — fed into variable context for function pills.
let _responseCache = {};
let _responseHeaders = {};
let _responseStatus = {};
// Debounced granular request-edit persistence (see _scheduleRequestSave).
let _requestSaveTimer = null;
const _pendingRequestPatches = new Map(); // id → merged partial patch

/**
 * Serialize a request node into the history snapshot format.
 * Params/headers/body-form rows are stored as bulk-edit strings so the data
 * is human-readable and round-trips cleanly through the bulk editors.
 * @param {object} node
 * @returns {object} snapshot
 */
function _buildSnapshot(node) {
  const params = Array.isArray(node.params) ? node.params : [];
  const headers = Array.isArray(node.headers) ? node.headers : [];

  const paramsBulk = params
    .map((p) => `${p.enabled ? "" : "# "}${p.name}=${p.value}`)
    .join("\n");
  const headersBulk = headers
    .map((h) => `${h.enabled ? "" : "# "}${h.name}: ${h.value}`)
    .join("\n");

  const authEnabled = node.authEnabled ?? true;
  // A disabled auth is never applied to the request, so don't track it in the
  // timeline snapshot — record it as "none", the same as an unselected auth.
  const authType = authEnabled ? (node.authType ?? "none") : "none";
  let authBulk = "";
  if (authType === "basic") {
    const b = node.authBasic ?? {};
    authBulk = `username: ${b.username ?? ""}\npassword: ${b.password ?? ""}`;
  } else if (authType === "bearer") {
    authBulk = `token: ${node.authBearer?.token ?? ""}`;
  } else if (authType === "oauth2") {
    const o = node.authOAuth2 ?? {};
    const lines = [];
    if (o.grantType) lines.push(`grantType: ${o.grantType}`);
    if (o.clientType) lines.push(`clientType: ${o.clientType}`);
    if (o.clientId) lines.push(`clientId: ${o.clientId}`);
    if (o.clientSecret) lines.push(`clientSecret: ${o.clientSecret}`);
    if (o.accessTokenUrl) lines.push(`accessTokenUrl: ${o.accessTokenUrl}`);
    if (o.authUrl) lines.push(`authUrl: ${o.authUrl}`);
    if (o.username) lines.push(`username: ${o.username}`);
    if (o.password) lines.push(`password: ${o.password}`);
    if (o.scope) lines.push(`scope: ${o.scope}`);
    if (o.responseType) lines.push(`responseType: ${o.responseType}`);
    if (o.redirectUri) lines.push(`redirectUri: ${o.redirectUri}`);
    if (o.state) lines.push(`state: ${o.state}`);
    if (o.credentials) lines.push(`credentials: ${o.credentials}`);
    if (o.audience) lines.push(`audience: ${o.audience}`);
    if (o.resource) lines.push(`resource: ${o.resource}`);
    if (o.origin) lines.push(`origin: ${o.origin}`);
    if (o.headerPrefix) lines.push(`headerPrefix: ${o.headerPrefix}`);
    authBulk = lines.join("\n");
  } else if (authType === "aws-iam") {
    const a = node.authAwsIam ?? {};
    const lines = [];
    if (a.accessKeyId) lines.push(`accessKeyId: ${a.accessKeyId}`);
    if (a.secretAccessKey) lines.push(`secretAccessKey: ${a.secretAccessKey}`);
    if (a.region) lines.push(`region: ${a.region}`);
    if (a.service) lines.push(`service: ${a.service}`);
    if (a.sessionToken) lines.push(`sessionToken: ${a.sessionToken}`);
    authBulk = lines.join("\n");
  } else if (authType === "oauth1") {
    const o = node.authOAuth1 ?? {};
    const lines = [];
    if (o.consumerKey) lines.push(`consumerKey: ${o.consumerKey}`);
    if (o.consumerSecret) lines.push(`consumerSecret: ${o.consumerSecret}`);
    if (o.token) lines.push(`token: ${o.token}`);
    if (o.tokenSecret) lines.push(`tokenSecret: ${o.tokenSecret}`);
    if (o.signatureMethod) lines.push(`signatureMethod: ${o.signatureMethod}`);
    if (o.realm) lines.push(`realm: ${o.realm}`);
    authBulk = lines.join("\n");
  }

  const bodyType = node.bodyType ?? "no-body";
  let bodyContent = "";
  // GraphQL keeps its query + variables structured (like pathParams below); the
  // bulk `body` string holds the query for readability.
  let bodyGraphql = null;
  if (bodyType === "form-data" || bodyType === "form-urlencoded") {
    const rows = Array.isArray(node.bodyFormRows) ? node.bodyFormRows : [];
    bodyContent = rows
      .map((r) => `${r.enabled ? "" : "# "}${r.name}=${r.value}`)
      .join("\n");
  } else if (bodyType === "file") {
    bodyContent = node.bodyFilePath ?? "";
  } else if (bodyType === "graphql") {
    bodyGraphql = {
      query: node.bodyGraphql?.query ?? "",
      variables: node.bodyGraphql?.variables ?? "",
    };
    bodyContent = bodyGraphql.query;
  } else {
    bodyContent = node.bodyText ?? "";
  }

  return {
    id: node.id,
    method: node.method ?? "GET",
    url: node.url ?? "",
    params: paramsBulk,
    // Path-param values are kept structured (they're URL-derived, not bulk text).
    pathParams: Array.isArray(node.pathParams) ? node.pathParams : [],
    headers: headersBulk,
    authType,
    authEnabled,
    auth: authBulk,
    bodyType,
    body: bodyContent,
    ...(bodyGraphql ? { bodyGraphql } : {}),
    notes: node.notes ?? "",
  };
}

/**
 * Load persisted history for one request from storage and populate
 * _requestHistory.  Respects _maxHistory so only the most recent entries
 * are kept in memory.  Silently produces an empty array on failure.
 *
 * @param {string} requestId
 */
async function _loadRequestHistory(requestId) {
  try {
    const { items } = await listHistory(requestId, { limit: _maxHistory });
    const entries = await Promise.all(
      items.map(async (meta) => {
        const payload = await getHistoryResponse(requestId, meta.id).catch(
          () => null,
        );
        return {
          id: meta.id,
          requestNode: meta.requestNode,
          requestUrl: meta.requestUrl ?? "",
          response: {
            request: payload?.request ?? {},
            error: payload?.error ?? null,
            status: meta.status ?? 0,
            statusText: meta.statusText ?? "",
            elapsed: meta.elapsed ?? 0,
            size: meta.size ?? 0,
            headers: payload?.headers ?? {},
            cookies: payload?.cookies ?? [],
            body: payload?.body ?? "",
            consoleLog: payload?.consoleLog ?? [],
            encoding: payload?.encoding ?? "utf8",
            // Restore the truncation flags so a reloaded large response still
            // renders its "response was truncated" banner. The session-scoped
            // bodyRef is intentionally never persisted, so the banner shows its
            // "full response is no longer cached" note rather than fetch buttons.
            truncated: payload?.truncated ?? false,
            fullSize: payload?.fullSize ?? meta.size ?? 0,
            // Streaming-run record (Feature 33): a compact summary stands in for
            // the (never-buffered) body. Present only on streamed runs.
            streamSummary: payload?.streamSummary ?? null,
          },
          timestamp: meta.timestamp ?? Date.now(),
        };
      }),
    );
    _requestHistory.set(requestId, entries);
  } catch (err) {
    console.warn(
      `[app] _loadRequestHistory(${requestId}) failed:`,
      err.message,
    );
    _requestHistory.set(requestId, []);
  }
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  // Resolve the active locale and load its catalog BEFORE any component renders,
  // so every t() call below (and in the components mounted by initComponents)
  // resolves against the right catalog. Also sets <html lang>. See i18n.js.
  await i18n.init();
  localizeChrome();

  // Suppress the browser's native context menu everywhere. For editable text
  // fields, show a Cut/Copy/Paste/Select All menu via the main process instead.
  document.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const t = e.target;
    const isEditable =
      (t.tagName === "INPUT" &&
        ![
          "checkbox",
          "radio",
          "range",
          "color",
          "file",
          "button",
          "submit",
          "reset",
          "image",
        ].includes(t.type)) ||
      t.tagName === "TEXTAREA" ||
      t.isContentEditable;
    if (isEditable) {
      window.wurl.ui.contextMenu.edit(e.clientX, e.clientY);
    }
  });

  // Undo / Redo routed from the app Edit menu (main → preload → wurl:edit-action).
  // A focused multi-line code editor (.pce-doc) runs its own snapshot undo/redo
  // and handles this itself; for plain inputs / textareas / other editables, fall
  // back to the browser's native editing command.
  window.addEventListener("wurl:edit-action", (e) => {
    const action = e.detail?.action;
    if (action !== "undo" && action !== "redo") return;
    const el = document.activeElement;
    if (el?.closest?.(".pce-doc")) return; // PillCodeEditor handles its own
    if (
      el &&
      (el.tagName === "INPUT" ||
        el.tagName === "TEXTAREA" ||
        el.isContentEditable)
    ) {
      document.execCommand(action);
    }
  });

  // Set --font-ui to the OS-native context-menu typeface so custom menus
  // feel native. Each major OS uses a distinct system font for its menus.
  const PLATFORM_UI_FONTS = {
    darwin: '-apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif',
    win32: '"Segoe UI Variable", "Segoe UI", sans-serif',
    linux: 'system-ui, "Ubuntu", "Cantarell", sans-serif',
  };
  const platform = window.wurl?.platform ?? "linux";
  const uiFont = PLATFORM_UI_FONTS[platform] ?? PLATFORM_UI_FONTS.linux;
  document.documentElement.style.setProperty("--font-ui", uiFont);

  // Route every persistence write failure (save / delete) to a visible error
  // toast. data-store detects the failure (a thrown IPC channel or a main-process
  // error envelope) and calls back here; without this sink such failures would be
  // log-only — silent data loss. Reads keep degrading quietly (see data-store.js).
  setWriteErrorHandler(({ label, message }) => {
    Notifications.error(
      message
        ? t("notifications.actionFailedDetail", { label, message })
        : t("notifications.actionFailed", { label }),
      { title: t("notifications.storageErrorTitle") },
    );
  });

  initPanels();
  initComponents();
  initSplitters();
  initEventBus();
  initHeader();
  await initCollections();
  installZoomHandlers();
});

// ─── Static chrome localization ────────────────────────────────────────────────
/**
 * Localize the static chrome declared in index.html — the header toolbar, the
 * landmark regions, panel titles, and the splitters. These elements exist before
 * any component mounts, so their text / title / aria-label literals are replaced
 * from the active catalog once, right after i18n.init(). Components own their own
 * dynamic strings via t(); this only covers the hand-authored HTML shell.
 */
function localizeChrome() {
  const setText = (sel, key) => {
    const el = document.querySelector(sel);
    if (el) el.textContent = t(key);
  };
  const setAttrAll = (sel, attr, key) =>
    document
      .querySelectorAll(sel)
      .forEach((el) => el.setAttribute(attr, t(key)));

  // Header + landmark regions
  setAttrAll("#app-header", "aria-label", "header.appHeaderAria");
  setText(".app-subtitle", "header.subtitle");
  setAttrAll(".header-icon-panel", "aria-label", "header.actionsAria");
  setAttrAll("#app-main", "aria-label", "header.mainAria");

  // Collections nav + its open buttons
  setAttrAll("#panel-nav", "aria-label", "header.collections");
  setText("#panel-nav .panel-title", "header.collections");
  setAttrAll(
    "#btn-collection, #btn-collection-nav",
    "title",
    "header.collections",
  );
  setAttrAll(
    "#btn-collection, #btn-collection-nav",
    "aria-label",
    "header.collectionsAria",
  );

  // Toolbar triggers (header bar + nav-settings bar share these classes)
  setAttrAll(".env-picker-trigger", "title", "header.environmentTitle");
  setAttrAll(".env-picker-trigger", "aria-label", "header.environmentAria");
  setAttrAll(".layout-picker-trigger", "title", "header.layoutAria");
  setAttrAll(".layout-picker-trigger", "aria-label", "header.layoutAria");
  setAttrAll(
    "#btn-settings, #btn-settings-nav",
    "title",
    "header.settingsTitle",
  );
  setAttrAll(
    "#btn-settings, #btn-settings-nav",
    "aria-label",
    "header.settingsAria",
  );

  // Request / response panels + splitters
  setAttrAll("#panel-request", "aria-label", "header.requestPanelAria");
  setAttrAll("#panel-response", "aria-label", "header.responsePanelAria");
  setText("#panel-request .panel-title", "header.requestPanelTitle");
  setText("#panel-response .panel-title", "header.responsePanelTitle");
  setAttrAll(".splitter", "title", "header.resizeTitle");
}

// ─── Panels ───────────────────────────────────────────────────────────────────
/**
 * The three top-level panels already exist as static DOM elements in index.html.
 * We wrap them in Panel instances so they can host sub-divisions later.
 */
let panelNav, panelRequest, panelResponse;

function initPanels() {
  // Wrap existing DOM elements — the Panel class handles body/header structure.
  // Here we adapt to the pre-existing static HTML structure generated in index.html.
  panelNav = adaptExistingPanel("panel-nav");
  panelRequest = adaptExistingPanel("panel-request");
  panelResponse = adaptExistingPanel("panel-response");
}

/**
 * Adapt a static HTML panel element so it exposes the Panel API surface.
 * Returns a lightweight proxy object; full Panel construction is for runtime-
 * created sub-panels (see Panel.divide()).
 */
function adaptExistingPanel(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Panel element #${id} not found`);
  const body = el.querySelector(".panel-body");
  return {
    id,
    element: el,
    body,
    /** Mount a component or plain HTMLElement into this panel's body. */
    mount(content) {
      const node = content instanceof HTMLElement ? content : content.element;
      body.appendChild(node);
      return this;
    },
  };
}

// ─── Components ───────────────────────────────────────────────────────────────
let treeView, requestEditor, responseViewer;
// wsConsole is a mutable pointer to whichever WsConsole instance is currently
// visible in the response pane. Starts as the idle placeholder; swaps to a
// per-connection instance when a connection is opened or resumed.
let wsConsole;

function initComponents() {
  treeView = new TreeView();
  requestEditor = new RequestEditor();
  responseViewer = new ResponseViewer();
  // Idle-state placeholder console — shown when a WS request is selected but
  // not yet connected. Per-connection consoles are created in wurl:ws-connect
  // and swapped in via _setResponsePane.
  wsConsole = new WsConsole();

  panelNav.mount(treeView);
  panelRequest.mount(requestEditor);
  panelResponse.mount(responseViewer);
  panelResponse.mount(wsConsole);
  wsConsole.element.style.display = "none";

  // Stream WebSocket status + frames pushed from the main process into the
  // console (and, for lifecycle states, the editor's Connect button).
  if (window.wurl?.ws) {
    window.wurl.ws.onStatus(_onWsStatus);
    window.wurl.ws.onMessage(_onWsMessage);
  }

  // Bridge live HTTP streaming pushes (Feature 33) to global wurl:stream-*
  // events so the ResponseViewer (and any future listener) can consume them
  // the same way as the rest of the request lifecycle. The bridge listens for
  // the app's whole lifetime, so no stream frame is missed before the viewer
  // has switched into live mode.
  if (window.wurl?.http?.stream) {
    window.wurl.http.stream.onData((p) =>
      window.dispatchEvent(new CustomEvent("wurl:stream-data", { detail: p })),
    );
    window.wurl.http.stream.onEnd((p) =>
      window.dispatchEvent(new CustomEvent("wurl:stream-end", { detail: p })),
    );
    window.wurl.http.stream.onError((p) =>
      window.dispatchEvent(new CustomEvent("wurl:stream-error", { detail: p })),
    );
    window.wurl.http.stream.onHint((p) =>
      window.dispatchEvent(new CustomEvent("wurl:stream-hint", { detail: p })),
    );
  }

  requestEditor.setGetItems(() => getAllRequests(treeView?.getItems() ?? []));
}

// ─── WebSocket connection orchestration (Feature 32) ──────────────────────────
// Multiple connections can be live simultaneously (one per request). Each entry
// in _wsConns owns its own WsConsole instance so the frame log survives
// navigation. wsConsole points to whichever console is currently visible.
// The socket infrastructure lives in the main process; the renderer only routes
// pushes and manages the per-connection state here.

/** @type {Map<string, { id: string, requestId: string|null, state: string, console: WsConsole }>} */
const _wsConns = new Map(); // keyed by socket id

// Terminal statuses (error/closed) that arrived before the renderer could
// register the connection. An immediate failure (bad URL, unsupported scheme,
// socket-construction throw) is pushed synchronously in main, before ws.open's
// {id} response lets us add the _wsConns entry — so without this the status is
// dropped and a pulsing live-dot is stranded for a socket that already died.
const _wsPendingTerminal = new Map(); // socket id → terminal status

/** Return the live entry for a given request id, or null. */
function _connForRequest(requestId) {
  for (const entry of _wsConns.values()) {
    if (entry.requestId === requestId) return entry;
  }
  return null;
}

/** Return a Set of request ids that currently have live connections. */
function _getLiveRequestIds() {
  return new Set(Array.from(_wsConns.values()).map((e) => e.requestId));
}

/** Return the human name of a request by id, falling back to the raw id. */
function _getRequestLabel(requestId) {
  const all = getAllRequests(treeView?.getItems() ?? []);
  return all.find((r) => r.id === requestId)?.name ?? requestId ?? "Unknown";
}

/**
 * Show the WebSocket console (true) or the normal Response viewer (false).
 * When showWs is true, optionally swap in a specific console instance.
 */
function _setResponsePane(showWs, consoleInstance) {
  if (!responseViewer) return;
  responseViewer.element.style.display = showWs ? "none" : "";
  if (!showWs) {
    if (wsConsole) wsConsole.element.style.display = "none";
    return;
  }
  const target = consoleInstance ?? wsConsole;
  if (target && target !== wsConsole) {
    if (wsConsole) wsConsole.element.style.display = "none";
    wsConsole = target;
    if (!wsConsole.element.parentNode) {
      panelResponse.body.appendChild(wsConsole.element);
    }
  }
  if (wsConsole) wsConsole.element.style.display = "";
}

/** Route a status push to the correct connection's console. */
function _onWsStatus(status) {
  const entry = _wsConns.get(status.id);
  if (!entry) {
    // The connection may not be registered yet: an immediate failure is pushed
    // synchronously in main, before ws.open's response. Remember a terminal
    // status so the connect handler can surface it instead of registering a
    // live-dot for a socket that already died.
    if (status.state === "error" || status.state === "closed") {
      _wsPendingTerminal.set(status.id, status);
    }
    return;
  }
  entry.console.applyStatus(status);
  const s = status.state;
  if (["connecting", "open", "closing", "closed", "error"].includes(s)) {
    entry.state = s;
  }
  const isForeground = entry.requestId === _selectedNode?.id;
  if (isForeground) {
    window.dispatchEvent(
      new CustomEvent("wurl:ws-state", { detail: { state: s } }),
    );
  }
  if (s === "closed" || s === "error") {
    _wsConns.delete(entry.id);
    if (!isForeground) {
      const label = _getRequestLabel(entry.requestId);
      if (s === "error") {
        Notifications.warning(`WebSocket "${label}" disconnected with error.`);
      } else {
        Notifications.info(`WebSocket "${label}" closed.`);
      }
      entry.console.element.remove();
    }
    treeView?.setWsLiveIds(_getLiveRequestIds());
  }
}

/** Route an inbound frame push to the correct connection's console. */
function _onWsMessage(frame) {
  const entry = _wsConns.get(frame.id);
  if (!entry) return;
  entry.console.addFrame({
    direction: "received",
    data: frame.data,
    binary: frame.binary,
    ts: frame.ts,
  });
}

/** Close the connection for a specific request (best-effort). */
async function _closeWsConn(requestId) {
  const entry = _connForRequest(requestId);
  if (!entry) return;
  _wsConns.delete(entry.id);
  treeView?.setWsLiveIds(_getLiveRequestIds());
  try {
    await window.wurl?.ws?.close({
      id: entry.id,
      code: 1000,
      reason: "switch",
    });
  } catch {
    /* socket already gone */
  }
}

/**
 * Show a modal asking whether to keep a live WS connection in the background.
 * Resolves true = keep open, false = disconnect.
 */
function _askKeepWsAlive(label) {
  return new Promise((resolve) => {
    PopupManager.confirm({
      title: t("app.wsOpen"),
      message: t("app.wsCloseMessage", { label }),
      confirmLabel: t("app.wsKeepOpen"),
      confirmClass: "btn--primary",
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}

// ─── Splitters ────────────────────────────────────────────────────────────────
/**
 * Live splitter sizes — JS source of truth for the three CSS grid variables.
 * Initialised from defaults; overwritten by loadAll() settings on startup.
 *
 *   --col-nav   : width of the nav panel  (also used as height in portrait)
 *   --col-res   : width of the response panel in landscape
 *   --row-res   : height of the response panel in between / portrait
 *
 * Panel minimum sizes (pixels):
 *   nav    ≥ 160     request ≥ 200 (1fr, unconstrained here)
 *   res    ≥ 160     rowRes  ≥ 120
 */
const SPLITTER_MIN_NAV = 100;
const SPLITTER_MIN_RES = 100;
const SPLITTER_MIN_ROWRES = 120;
// Minimum panel width that keeps the ctrl group (Env, Layout, Settings) fully
// visible when "Remove headers" is active. The Collections button is no longer
// part of this group — it lives in the tree-toolbar — so the group is narrower.
const SPLITTER_MIN_CTRL = 200;

let splitterSizes = {
  nav: 300,
  res: 500,
  rowRes: 320,
};

/** Push current splitter sizes into the CSS grid on #app-main. */
function applyGridVars() {
  const appMain = getAppMain();
  appMain.style.setProperty("--col-nav", `${splitterSizes.nav}px`);
  appMain.style.setProperty("--col-res", `${splitterSizes.res}px`);
  appMain.style.setProperty("--row-res", `${splitterSizes.rowRes}px`);
}

/** Persist current splitter positions into the settings document. */
function saveSplitterPositions() {
  updateSettings({
    splitterNav: splitterSizes.nav,
    splitterRes: splitterSizes.res,
    splitterRowRes: splitterSizes.rowRes,
  });
}

/** Returns the #app-main element (cached after first call). */
let _appMain = null;
function getAppMain() {
  return (_appMain ??= document.getElementById("app-main"));
}

// ─── Manual layout ────────────────────────────────────────────────────────────

/** Current pinned layout (1–4). Always set; default matches DEFAULT_SETTINGS. */
let _currentLayout = 2;

/** The floating env/layout/settings control group injected by placeCtrlGroup(). */
let _ctrlGroup = null;

/**
 * Map the manual layout number to the splitter-mode string used throughout
 * initSplitters. Layout 1 = landscape (all columns), layout 4 = portrait
 * (all rows), layouts 2 & 3 = between (mixed).
 */
function getEffectiveSplitterMode() {
  if (_currentLayout === 1) return "landscape";
  if (_currentLayout === 4) return "portrait";
  return "between";
}

/** Splitter instances — promoted to module scope so applyLayout can call setFlow. */
let _splitter1 = null;
let _splitter2 = null;

/**
 * Apply a panel layout: sets data-layout on #app-main, re-applies grid
 * variables, and updates splitter direction classes.
 * @param {number} layout  1–4
 */
function applyLayout(layout) {
  _currentLayout = layout;
  getAppMain().dataset.layout = String(layout);
  applyGridVars();
  const mode = getEffectiveSplitterMode();
  _splitter1?.setFlow(mode === "portrait" ? "column" : "row");
  _splitter2?.setFlow(mode === "landscape" ? "row" : "column");
  placeCtrlGroup(layout, currentSettings.removeHeaders ?? false);
  placeCollectionsButton(currentSettings.removeHeaders ?? false);
  // Broadcast so panels that adapt their own internal splits to the layout can
  // react (e.g. RequestEditor flips the GraphQL Query/Variables split).
  window.dispatchEvent(
    new CustomEvent("wurl:layout-changed", { detail: { layout } }),
  );
}

/** Build the detached env/layout/settings control group element. */
function buildCtrlGroup() {
  const group = document.createElement("div");
  group.className = "header-ctrl-group";
  group.innerHTML = `
    <span class="ctrl-divider" aria-hidden="true"></span>
    <button class="env-picker-trigger" id="btn-env-picker-ctrl"
        title="${t("header.environmentTitle")}" aria-label="${t("header.environmentAria")}"
        aria-haspopup="dialog"></button>
    <button class="layout-picker-trigger" id="btn-layout-ctrl"
        aria-haspopup="listbox" aria-label="${t("header.layoutAria")}" title="${t("header.layoutAria")}"></button>
    <button class="icon-btn header-icon-btn" id="btn-settings-ctrl"
        title="${t("header.settingsTitle")}" aria-label="${t("header.settingsAria")}">
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
           fill="none" stroke="currentColor" stroke-width="2"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="3"/>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06
                 a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09
                 A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83
                 l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09
                 A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83
                 l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09
                 a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83
                 l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09
                 a1.65 1.65 0 0 0-1.51 1z"/>
      </svg>
    </button>
  `;
  return group;
}

/**
 * Move the ctrl-group into the correct container based on layout and removeHeaders.
 * Layout 1 → res-status-bar (far right, with divider between meta and controls).
 * Layout 2/3 → req-tab-strip (far right via margin-left:auto).
 * Layout 4 → tree-toolbar (after tree-search, with divider).
 */
function placeCtrlGroup(layout, removeHeaders) {
  if (!_ctrlGroup) return;
  _ctrlGroup.remove();
  if (!removeHeaders) return;
  let target;
  if (layout === 1) {
    target = document.querySelector(".res-status-bar");
  } else if (layout === 2 || layout === 3) {
    target = document.querySelector(".req-tab-strip");
  } else {
    target = document.querySelector(".tree-toolbar");
  }
  target?.appendChild(_ctrlGroup);
}

/**
 * Pin the Collections button to one of two homes (it never follows the layout,
 * unlike the ctrl-group):
 *   removeHeaders off → the nav panel-header's action area (its default spot).
 *   removeHeaders on  → the tree-toolbar, trailing the filter input.
 * Must run after placeCtrlGroup: in the "all stacked" (portrait) layout the
 * ctrl-group also parks in the tree-toolbar, and Collections must sit to its
 * left — right of the filter input, left of the environment selector. In every
 * other layout the ctrl-group lives elsewhere, so the button is simply last.
 */
function placeCollectionsButton(removeHeaders) {
  const btn = document.getElementById("btn-collection");
  if (!btn) return;
  if (!removeHeaders) {
    document
      .querySelector("#panel-nav .panel-header .panel-actions")
      ?.appendChild(btn);
    return;
  }
  const toolbar = document.querySelector(".tree-toolbar");
  if (!toolbar) return;
  const ctrlGroup = toolbar.querySelector(".header-ctrl-group");
  if (ctrlGroup) toolbar.insertBefore(btn, ctrlGroup);
  else toolbar.appendChild(btn);
}

function initSplitters() {
  const spl1El = document.getElementById("splitter-1");
  const spl2El = document.getElementById("splitter-2");

  applyGridVars();

  // Splitter 1 — always resizes the nav panel (--col-nav).
  // Flow: horizontal when nav is a column (layouts 1–3), vertical when stacked (layout 4).
  _splitter1 = makeSplitter(spl1El, {
    getFlow: () =>
      getEffectiveSplitterMode() === "portrait" ? "column" : "row",
    getSize: () => splitterSizes.nav,
    setSize: (v) => {
      const appMain = getAppMain();
      const portrait = getEffectiveSplitterMode() === "portrait";
      let max = portrait
        ? appMain.clientHeight * 0.5
        : appMain.clientWidth * 0.5;
      if (
        !portrait &&
        currentSettings.removeHeaders &&
        (_currentLayout === 2 || _currentLayout === 3)
      ) {
        max = Math.min(max, appMain.clientWidth - SPLITTER_MIN_CTRL);
      }
      splitterSizes.nav = Math.min(max, Math.max(SPLITTER_MIN_NAV, v));
      applyGridVars();
    },
    onDragEnd: saveSplitterPositions,
    invert: false,
  });

  // Splitter 2 — resizes the response panel.
  // layout 1 (landscape) → horizontal drag → changes --col-res
  // layouts 2/3/4        → vertical drag   → changes --row-res
  _splitter2 = makeSplitter(spl2El, {
    getFlow: () =>
      getEffectiveSplitterMode() === "landscape" ? "row" : "column",
    getSize: () =>
      getEffectiveSplitterMode() === "landscape"
        ? splitterSizes.res
        : splitterSizes.rowRes,
    setSize: (v) => {
      const appMain = getAppMain();
      if (getEffectiveSplitterMode() === "landscape") {
        const max = appMain.clientWidth * 0.5;
        const min =
          currentSettings.removeHeaders && _currentLayout === 1
            ? Math.max(SPLITTER_MIN_RES, SPLITTER_MIN_CTRL)
            : SPLITTER_MIN_RES;
        splitterSizes.res = Math.min(max, Math.max(min, v));
      } else {
        const max = appMain.clientHeight * 0.75;
        splitterSizes.rowRes = Math.min(max, Math.max(SPLITTER_MIN_ROWRES, v));
      }
      applyGridVars();
    },
    onDragEnd: saveSplitterPositions,
    invert: true,
  });

  // Sync splitter direction classes on window resize. When a manual layout is
  // pinned getEffectiveSplitterMode() ignores the viewport, so the flows stay
  // stable; when the window is very small the CSS can still flex but the JS
  // splitter direction is always authoritative.
  const observer = new ResizeObserver(() => {
    const mode = getEffectiveSplitterMode();
    _splitter1.setFlow(mode === "portrait" ? "column" : "row");
    _splitter2.setFlow(mode === "landscape" ? "row" : "column");
  });
  observer.observe(document.getElementById("app-main"));
}

/**
 * Attach drag-to-resize logic to an existing splitter DOM element.
 *
 * @param {HTMLElement} el
 * @param {{ getFlow, getSize, setSize, onDragEnd, invert }} opts
 *   invert: when true the delta is negated so dragging away from the panel
 *           shrinks it (needed for panels that trail the splitter in the grid).
 * @returns {{ setFlow(flow: string): void }}
 */
function makeSplitter(
  el,
  { getFlow, getSize, setSize, onDragEnd, invert = false },
) {
  let dragging = false;
  let startPos = 0;
  let startSize = 0;
  let dragFlow = "row";

  function clientPos(e) {
    const src = e.touches ? e.touches[0] : e;
    return dragFlow === "row" ? src.clientX : src.clientY;
  }

  function onStart(e) {
    e.preventDefault();
    dragFlow = getFlow();
    dragging = true;
    startPos = clientPos(e);
    startSize = getSize();
    el.classList.add("splitter--dragging");
    document.body.style.cursor =
      dragFlow === "row" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  }

  function onMove(e) {
    if (!dragging) return;
    if (e.cancelable) e.preventDefault();
    const rawDelta = clientPos(e) - startPos;
    const delta = invert ? -rawDelta : rawDelta;
    setSize(startSize + delta);
  }

  function onEnd() {
    if (!dragging) return;
    dragging = false;
    el.classList.remove("splitter--dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onEnd);
    window.removeEventListener("touchmove", onMove);
    window.removeEventListener("touchend", onEnd);
    if (onDragEnd) onDragEnd();
  }

  el.addEventListener("mousedown", (e) => {
    onStart(e);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onEnd);
  });

  el.addEventListener(
    "touchstart",
    (e) => {
      onStart(e);
      window.addEventListener("touchmove", onMove, { passive: false });
      window.addEventListener("touchend", onEnd);
    },
    { passive: false },
  );

  return {
    setFlow(newFlow) {
      el.className = `splitter splitter--${newFlow === "row" ? "h" : "v"}`;
    },
  };
}

// ─── Header ───────────────────────────────────────────────────────────────────
/**
 * Wire up header icon buttons.
 * currentSettings is kept in sync here so the popup always opens with the
 * latest values.
 */
const settingsPopup = new SettingsPopup();
// CollectionsPopup / VariablesPopup / EnvironmentsPopup are parent-owned popups
// that report back to app.js via constructor callbacks (see the "Component ↔ app
// communication" rule in CLAUDE.md). Their callbacks close over collection /
// environment handlers defined inside initEventBus(), so they are constructed
// there — declared here only so initHeader() and applySettings() can reach them.
let collPopup, varsPopup, environmentsPopup;
const envPicker = new EnvPicker({
  onManage: () =>
    environmentsPopup.open(currentEnvironments, {
      bulkEditor: currentSettings.varsBulkEditor ?? true,
    }),
});
const layoutPicker = new LayoutPicker({
  onSelect: (layout) => {
    applyLayout(layout);
    updateSettings({ layout });
  },
});
let currentSettings = {};

/**
 * Merge `delta` into the settings document and persist in one step, so a
 * settings change can never be applied without being saved (the prior footgun
 * was a bare `currentSettings = {...}` with a forgotten saveSettings()). Reads
 * stay as direct `currentSettings` access and UI refresh stays explicit at the
 * call site; only hydration from disk (loadAll) assigns `currentSettings`
 * directly, since it must not persist back.
 * @param {object} delta
 * @returns {*} whatever saveSettings returns
 */
function updateSettings(delta) {
  currentSettings = { ...currentSettings, ...delta };
  return saveSettings(currentSettings);
}

/** Live collection state — kept in sync with data-store. */
let currentColls = {
  collections: [],
  activeCollectionId: null,
};

/** Live environment state — kept in sync with data-store. */
let currentEnvironments = {
  version: 1,
  globalVariables: [],
  activeEnvironmentId: null,
  environments: [],
};

/** Map currentColls to the shape CollectionsPopup expects. */
const collPopupState = () => ({
  collections: currentColls.collections,
  activeCollectionId: currentColls.activeCollectionId,
  bulkEditor: currentSettings.varsBulkEditor ?? true,
});

/**
 * Native context menu for the collection title / collection buttons: rename the
 * active collection, or edit its variables. Reuses the CollectionsPopup (rename)
 * and VariablesPopup (variables) that the rest of the header wiring already drives.
 */
async function _showCollContextMenu(x, y) {
  const actions = {
    rename: () => collPopup.openWithRename(collPopupState()),
    variables: () => {
      const activeColl = currentColls.collections.find(
        (c) => c.id === currentColls.activeCollectionId,
      );
      if (!activeColl) return;
      varsPopup.open({
        scopeId: activeColl.id,
        scopeName: activeColl.name,
        variables: activeColl.variables ?? [],
        bulkEditor: currentSettings.varsBulkEditor ?? true,
      });
    },
  };

  const clickedId = await window.wurl.ui.contextMenu.show({
    items: [
      { id: "rename", label: t("tree.menu.rename") },
      { type: "separator" },
      { id: "variables", label: t("tree.menu.variables") },
    ],
    x,
    y,
  });

  if (clickedId) actions[clickedId]?.();
}

function initHeader() {
  document.getElementById("btn-settings").addEventListener("click", () => {
    settingsPopup.open(currentSettings);
  });

  // Secondary settings button inside the nav panel — shown when app-header is hidden
  document.getElementById("btn-settings-nav").addEventListener("click", () => {
    settingsPopup.open(currentSettings);
  });

  // Layout picker — header bar + remove-headers bar
  layoutPicker.bindTrigger(document.getElementById("btn-layout"));
  layoutPicker.bindTrigger(document.getElementById("btn-layout-nav"));

  // Collection buttons (panel header + bottom bar)
  document.getElementById("btn-collection").addEventListener("click", () => {
    collPopup.open(collPopupState());
  });
  document
    .getElementById("btn-collection-nav")
    .addEventListener("click", () => {
      collPopup.open(collPopupState());
    });

  // Environment picker — app header (hidden with it when removeHeaders is on)
  envPicker.bindTrigger(document.getElementById("btn-env-picker-header"));
  envPicker.bindTrigger(document.getElementById("btn-env-picker-nav"));

  // Right-click on the collection label or either collection icon → OS context menu
  const _openCollCtxMenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    _showCollContextMenu(e.clientX, e.clientY);
  };

  document
    .querySelector("#panel-nav .panel-title")
    .addEventListener("contextmenu", _openCollCtxMenu);
  document
    .getElementById("btn-collection")
    .addEventListener("contextmenu", _openCollCtxMenu);
  document
    .getElementById("btn-collection-nav")
    .addEventListener("contextmenu", _openCollCtxMenu);

  // Floating ctrl-group — injected into the layout-appropriate container when
  // "Remove headers" is active, replacing the fixed nav-settings-bar.
  _ctrlGroup = buildCtrlGroup();
  layoutPicker.bindTrigger(_ctrlGroup.querySelector("#btn-layout-ctrl"));
  envPicker.bindTrigger(_ctrlGroup.querySelector("#btn-env-picker-ctrl"));
  _ctrlGroup
    .querySelector("#btn-settings-ctrl")
    .addEventListener("click", () => settingsPopup.open(currentSettings));
}

// ─── Event bus ────────────────────────────────────────────────────────────────

// Classify a common network failure into a human-readable hint. Shared by the
// request-error (installResponseHandlers) and send-request
// (installRequestEditSendHandlers) groups, so it lives at module scope.
function _buildHint(errName, msg) {
  if (errName === "AbortError") return "The request was aborted.";
  if (/cors/i.test(msg))
    return "CORS policy blocked the request — the server may need to send Access-Control-Allow-Origin headers.";
  if (
    /failed to fetch|load failed|networkerror|network request failed/i.test(msg)
  )
    return "Could not reach the server. Check the URL, network connectivity, and whether the server is running.";
  if (/ssl|certificate|cert/i.test(msg))
    return "TLS/SSL certificate error — the server certificate may be self-signed or invalid.";
  if (/timeout/i.test(msg))
    return "The request timed out before the server responded.";
  if (/too many redirects/i.test(msg))
    return "The server sent too many redirects. Check for redirect loops.";
  return "";
}

// Load a past run's response into the body/headers/cookies/console tabs without
// recording a new history entry (sets _skipNextHistory so the resulting
// response/error event is not re-persisted). Shared by the timeline-select
// (view-only) handler in event-bus/timeline-handlers.js and the in-file
// timeline-restore handler (view + replay into the editor).
function _viewTimelineResponse(requestUrl, response) {
  _skipNextHistory = true;
  if (response?.error) {
    window.dispatchEvent(
      new CustomEvent("wurl:request-error", {
        detail: {
          request: response.request ?? { url: requestUrl },
          name: response.error.name ?? "Error",
          message: response.error.message ?? "",
          hint: response.error.hint ?? "",
          elapsed: response.elapsed ?? 0,
          consoleLog: response.consoleLog ?? [],
        },
      }),
    );
  } else {
    window.dispatchEvent(
      new CustomEvent("wurl:response-received", {
        detail: { ...response, request: { url: requestUrl } },
      }),
    );
  }
}

/**
 * Build the dependency context handed to the extracted event-bus handler
 * modules (scripts/event-bus/*). Module-level state that is *reassigned* is
 * exposed via get/set accessors so a module in another file sees live values;
 * Maps/Sets (mutated in place) and stable function references are passed
 * directly. The in-file core groups reference the same module-level bindings
 * without going through this object. Built once inside initEventBus(), after
 * the components and popups exist.
 */
function buildBusContext() {
  return {
    // Reassigned state → accessors.
    getSelectedNode: () => _selectedNode,
    getSettings: () => currentSettings,
    getMaxHistory: () => _maxHistory,
    setMaxHistory: (n) => {
      _maxHistory = n;
    },
    // Components: treeView/wsConsole are reassigned at runtime, so read live.
    getTreeView: () => treeView,
    getWsConsole: () => wsConsole,
    settingsPopup,
    // Maps / Sets — mutated via methods, safe to share by reference.
    requestHistory: _requestHistory,
    historyLoaded: _historyLoaded,
    wsConns: _wsConns,
    wsPendingTerminal: _wsPendingTerminal,
    // Stable helper references.
    updateSettings,
    applySettings,
    applyCustomThemeVars: _applyCustomThemeVars,
    dispatchTimelineUpdate: _dispatchTimelineUpdate,
    proxyDescriptorFields: _proxyDescriptorFields,
    closeWsConn: _closeWsConn,
    setResponsePane: _setResponsePane,
    connForRequest: _connForRequest,
    getLiveRequestIds: _getLiveRequestIds,
    viewTimelineResponse: _viewTimelineResponse,
    deleteHistory,
    clearHistory,
    trimHistory,
    // App-level command handlers (import / export).
    handleImport,
    handleCurlImport,
    handleExport,
    runWorkspaceExport,
  };
}

function initEventBus() {
  // ── wurl:* global event registry ───────────────────────────────────────────
  // The renderer's app-wide channel. Only state changes / notifications with
  // MULTIPLE or open-ended listeners live here; parent-owned widgets (pickers,
  // modals, the editor popups) report to their creator via constructor callbacks
  // instead — see "Component ↔ App Communication" in CLAUDE.md. Keep this current.
  //
  // Tree / collections          (TreeView → app.js)
  //   request-selected      node                          row selected in tree
  //   request-open          { collectionId, requestId }   open from favorites/recents
  //   request-execute       node                          run a request from the tree
  //   favorite-toggle       { node, favorited }
  //   requests-deleted      { ids: string[] }
  //   request-cleared       —                             last request removed
  //   collections-changed   items[]                       tree mutated → persist
  //   export-collection     { collection }
  //   folder-vars-open      { nodeId, folderName, variables }
  //
  // Request lifecycle           (RequestEditor / app.js ↔ panels)
  //   send-request          { requestId, method, url, headers, … }
  //   cancel-request        { requestId, streamId? }      stop that request's run (streamId → abort a live stream)
  //   request-loading       { requestId, streamId }        in-flight; show spinner
  //   request-updated       { id, …partial }              editor mutated a field
  //   curl-pasted           { id, text }                  cURL pasted into the URL bar → rewrite the request
  //   request-error         { requestId, requestNode, request, name, message, hint, elapsed, consoleLog }
  //   response-received     { …response, requestId, requestNode, request, streaming?, streamId?, sse?, contentType? }
  //
  // Live HTTP streaming (Feature 33)  (preload http:stream:* → app.js → ResponseViewer)
  //   stream-data           { streamId, kind, index, ts, event?|data?, totalBytes, count }
  //   stream-end            { streamId, ts, totalBytes, eventCount, elapsed, status, bodyRef, aborted, lastEvents }
  //   stream-error          { streamId, ts, totalBytes, eventCount, elapsed, status, bodyRef, name, message, lastEvents }
  //   stream-hint           { streamId }   headers-time: buffered NDJSON, streaming off — show the in-flight hint
  //   stream-end/-error also drive the one Timeline record written per stream run.
  //   Requests run concurrently: requestId routes each lifecycle event to its
  //   originating request (null on history replays, which always target the
  //   selected request); requestNode is the tree-node snapshot taken at send
  //   time so results route correctly even after the selection moves on.
  //   editor-setting-changed { <settingKey>: value }      e.g. listHeaders
  //
  // WebSocket
  //   ws-connect            { url, headers, subprotocols, … }
  //   ws-send               { data }
  //   ws-disconnect         —
  //   ws-state              { state }                     app.js → RequestEditor
  //
  // Timeline / history
  //   timeline-select       { requestUrl, response }              view a past run (non-destructive)
  //   timeline-restore      { requestNode, requestUrl, response } replay snapshot into the editor
  //   timeline-delete-entry { requestId, historyId }
  //   timeline-clear        { requestId }
  //   timeline-update       { requestId, entries, isRequestSwitch }  app.js → ResponseViewer
  //
  // Settings / theme
  //   settings-changed      { <settingKeys> }             consumed by several panels
  //   layout-changed        { layout }                    panels adapt internal splits
  //   history-trim          { historyCount }
  //   theme-preview         vars | null                   (from preload)
  //   theme-apply           themeName                     (from preload)
  //   custom-themes-changed customThemes                  (from preload)
  //   ui-font-change        fontStack                     (from preload/main)
  //
  // Menu / backup               (preload → app.js)
  //   import-requested  ·  import-curl-requested  ·  export-all-requested  ·
  //   backup-export-requested  ·  backup-import-requested
  //                                  — all payload-less menu triggers
  //
  // UI coordination             (broadcast; PopupManager / pickers)
  //   popup-opened          —
  //   popup-closed          —
  // ────────────────────────────────────────────────────────────────────────────

  // Construct the parent-owned editor popups, wiring each to the handlers below.
  // These are `function` declarations (hoisted), so referencing them here is
  // fine. handleVarsSave / handleVarsBulkEditorChange are shared by the variables
  // and collections popups, which edit the same flat variable shape.
  collPopup = new CollectionsPopup({
    onSelect: handleCollSelect,
    onAdd: handleCollAdd,
    onRename: handleCollRename,
    onDelete: handleCollDelete,
    onSendCookiesChange: handleCollSendCookies,
    onVarsSave: handleVarsSave,
    onBulkEditorChange: handleVarsBulkEditorChange,
  });
  varsPopup = new VariablesPopup({
    onSave: handleVarsSave,
    onBulkEditorChange: handleVarsBulkEditorChange,
  });
  environmentsPopup = new EnvironmentsPopup({
    onChange: handleEnvironmentsChanged,
    onActivate: handleEnvActivate,
    onVarsSave: handleEnvVarsSave,
    // onBulkEditorChange is intentionally left unwired: the prior
    // wurl:env-bulk-editor-changed event had no listener, so the environments
    // bulk toggle was never persisted. Preserve that behavior.
  });

  // Self-contained handler groups live in their own modules and receive the
  // shared dependency context; the deeply state-coupled core groups stay in
  // this file (below) and reference the module-level bindings directly.
  const ctx = buildBusContext();
  installMenuHandlers(ctx);
  installSettingsHandlers(ctx);
  installWsHandlers(ctx);
  installTimelineHandlers(ctx);

  // Core handler groups: these read/write the module-level state directly, so
  // they stay in this file, but are split into focused install functions rather
  // than one monolithic body.
  installSelectionHandlers();
  installResponseHandlers();
  installStreamHandlers();
  installTreeQuickAccessHandlers();
  installFolderVarsHandler();
  installRequestEditSendHandlers();
}

// When a request is selected in the tree, load it into the editor.
function installSelectionHandlers() {
  window.addEventListener("wurl:request-selected", async (e) => {
    const node = e.detail;
    const prevNodeId = _selectedNode?.id;
    _selectedNode = node;
    // Set variable context BEFORE load() so pill editors render with correct validation
    _refreshEditorVariableContext(node.id);
    requestEditor.load(node);

    // WebSocket: swap the response pane to the frame log for a WS request.
    // If navigating away from a live connection, prompt the user to keep it
    // open in the background or disconnect. Returning to a background connection
    // restores its console and state without resetting the log.
    const isWs = node?.protocol === "websocket";
    const prevConn = _connForRequest(prevNodeId);
    if (prevConn && node?.id !== prevNodeId) {
      const active =
        prevConn.state === "open" || prevConn.state === "connecting";
      if (active) {
        const keep = await _askKeepWsAlive(_getRequestLabel(prevNodeId));
        if (!keep) {
          await _closeWsConn(prevNodeId);
          if (isWs) wsConsole.reset();
        }
        // If keep=true, entry stays in _wsConns with its console intact.
      }
    }
    const resumeConn = _connForRequest(node?.id);
    if (isWs && resumeConn) {
      // Resume: swap the background connection's console into the pane.
      _setResponsePane(true, resumeConn.console);
      window.dispatchEvent(
        new CustomEvent("wurl:ws-state", {
          detail: { state: resumeConn.state ?? "idle" },
        }),
      );
    } else {
      _setResponsePane(isWs);
      if (isWs) {
        wsConsole.reset();
        window.dispatchEvent(
          new CustomEvent("wurl:ws-state", { detail: { state: "idle" } }),
        );
      }
    }

    // Persist the selected node ID per-collection so it can be restored on reload
    const id = node?.id;
    if (id) {
      const selectedRequestIds = {
        ...(currentSettings.selectedRequestIds ?? {}),
        [currentColls.activeCollectionId]: id,
      };
      // Opening a request bumps it to the top of the recents list.
      const recents = addRecent(
        currentSettings.recents ?? [],
        makeEntry(node, currentColls.activeCollectionId),
      );
      updateSettings({ selectedRequestIds, recents });
      if (treeView) treeView.setRecents(recents);
    }
    // Update the timeline pane with this request's history.
    // If history has not yet been loaded from storage, load it first.
    if (!id) {
      _dispatchTimelineUpdate(null, true);
      return;
    }
    if (_historyLoaded.has(id)) {
      _dispatchTimelineUpdate(id, true);
    } else {
      // Clear the display immediately, then populate after loading from storage.
      _dispatchTimelineUpdate(null, true);
      await _loadRequestHistory(id);
      _historyLoaded.add(id);
      // Populate response cache from the latest timeline entry now that history is loaded.
      const loadedEntries = _requestHistory.get(id) ?? [];
      const loadedLatest = loadedEntries[0];
      const selName = node?.name;
      if (selName) {
        _responseCache[selName] = loadedLatest?.response?.body ?? "";
        _responseHeaders[selName] = loadedLatest?.response?.headers ?? {};
        _responseStatus[selName] = loadedLatest?.response?.status ?? 0;
      }
      // Guard against a second selection arriving while we were loading.
      if (_selectedNode?.id === id) {
        _refreshEditorVariableContext(id);
        _dispatchTimelineUpdate(id, true);
      }
    }
  });

  // Double-click-to-execute: load the request then click the send button
  window.addEventListener("wurl:request-execute", (e) => {
    if (!requestEditor) return;
    const node = e.detail;
    _selectedNode = node;
    _refreshEditorVariableContext(node.id);
    requestEditor.load(node);
    requestEditor.element.querySelector(".req-send-btn")?.click();
  });
}

// Cache response data so function pills like response() / responseHeader() can
// resolve; record real (non-replay) runs and failures into per-request history.
function installResponseHandlers() {
  window.addEventListener("wurl:response-received", async (e) => {
    // Capture and reset the skip flag immediately so it is never left stale.
    const skipHistory = _skipNextHistory;
    _skipNextHistory = false;

    // Route to the request that was sent, not the current selection — with
    // concurrent requests the user may have moved on while this one ran.
    const node = e.detail.requestNode ?? _selectedNode;
    const name = node?.name;
    if (!name) return;

    // Live streaming responses (Feature 33): the body never lands whole in the
    // renderer, so there is no static response to persist here. Instead we stash
    // the marker's request/status/headers keyed by streamId and write a single
    // Timeline record when the stream ends (see wurl:stream-end/-error below).
    if (e.detail.streaming === true) {
      const sid = e.detail.streamId;
      if (sid && !skipHistory && _maxHistory > 0 && node?.id) {
        _pendingStreams.set(sid, {
          node,
          requestUrl: e.detail.request?.url ?? "",
          method: e.detail.request?.method ?? "",
          status: e.detail.status ?? 0,
          statusText: e.detail.statusText ?? "",
          headers: e.detail.headers ?? {},
          cookies: e.detail.cookies ?? [],
          consoleLog: e.detail.consoleLog ?? [],
          sse: e.detail.sse === true,
        });
      }
      return;
    }

    // Record in per-request history only for real (non-replay) executions.
    // When replaying a historical entry, do NOT push to history and do NOT
    // re-render the timeline (which would clear the user's current selection).
    if (!skipHistory && _maxHistory > 0 && node?.id) {
      const histId = crypto.randomUUID();
      const nowMs = Date.now();
      const reqUrl = e.detail.request?.url ?? "";
      const reqNode = _buildSnapshot(node);
      const resp = {
        request: e.detail.request ?? {},
        status: e.detail.status ?? 0,
        statusText: e.detail.statusText ?? "",
        headers: e.detail.headers ?? {},
        cookies: e.detail.cookies ?? [],
        body: e.detail.body ?? "",
        elapsed: e.detail.elapsed ?? 0,
        size: e.detail.size ?? 0,
        consoleLog: e.detail.consoleLog ?? [],
        encoding: e.detail.encoding ?? "utf8",
        // Streaming metadata for spilled (large) responses. bodyRef is a
        // session-scoped handle to the full body cached in the main process; it
        // is deliberately NOT persisted (see addHistory below) because that
        // cache is reaped on restart. truncated/fullSize ARE persisted so a
        // reloaded entry still shows the "response was truncated" banner.
        truncated: e.detail.truncated ?? false,
        fullSize: e.detail.fullSize ?? e.detail.size ?? 0,
        bodyRef: e.detail.bodyRef ?? null,
      };

      // Ensure history is loaded from storage before prepending the new entry,
      // so the in-memory list is complete and purging works correctly.
      if (!_historyLoaded.has(node.id)) {
        await _loadRequestHistory(node.id);
        _historyLoaded.add(node.id);
      }

      const entries = _requestHistory.get(node.id) ?? [];
      entries.unshift({
        id: histId,
        requestNode: reqNode,
        requestUrl: reqUrl,
        response: resp,
        timestamp: nowMs,
      });

      // Persist to storage (fire-and-forget).
      addHistory(
        node.id,
        {
          id: histId,
          timestamp: nowMs,
          status: resp.status,
          statusText: resp.statusText,
          elapsed: resp.elapsed,
          size: resp.size,
          requestUrl: reqUrl,
          requestNode: reqNode,
        },
        {
          headers: resp.headers,
          cookies: resp.cookies,
          body: resp.body,
          consoleLog: resp.consoleLog,
          encoding: resp.encoding,
          // Persist truncation flags (but not the session-scoped bodyRef) so a
          // reloaded large response is correctly flagged as a stored preview.
          truncated: resp.truncated,
          fullSize: resp.fullSize,
        },
      );

      // Purge entries beyond the limit from both memory and storage.
      while (entries.length > _maxHistory) {
        const old = entries.pop();
        if (old?.id) deleteHistory(node.id, old.id);
      }

      _requestHistory.set(node.id, entries);
      const latest = entries[0];
      _responseCache[name] = latest?.response?.body ?? "";
      _responseHeaders[name] = latest?.response?.headers ?? {};
      _responseStatus[name] = latest?.response?.status ?? 0;
      // Refresh pill context for whichever request is loaded in the editor —
      // a background response may make its response() pills resolvable.
      _refreshEditorVariableContext(_selectedNode?.id);
      // Only repaint the timeline pane when it is showing this request.
      if (node.id === _selectedNode?.id) _dispatchTimelineUpdate(node.id);
    }

    // Post-response captures (Feature 03). Run on genuine sends only (never on a
    // history replay), independent of whether history recording is enabled. The
    // 2xx gate and empty-rules short-circuit live inside _applyCapturesForNode.
    if (!skipHistory && node?.captures?.length) {
      await _applyCapturesForNode(node, e.detail);
    }
  });

  // Record network-level failures (ENOTFOUND, ETIMEDOUT, etc.) in the timeline.
  // Cancellations and "no URL" guards are excluded — only genuine request attempts
  // that reached the network layer are recorded.
  window.addEventListener("wurl:request-error", async (e) => {
    const skipHistory = _skipNextHistory;
    _skipNextHistory = false;

    if (skipHistory) return;
    if (e.detail?.name === "AbortError") return;
    // Pre-send failures that never reached the network (e.g. the no-URL
    // guard) carry an empty request URL and are not recorded.
    if (!e.detail?.request?.url) return;

    const node = e.detail.requestNode ?? _selectedNode;
    if (!node?.id || _maxHistory <= 0) return;

    const histId = crypto.randomUUID();
    const nowMs = Date.now();
    const reqUrl = e.detail.request?.url ?? "";
    // Store the snapshot (bulk-string) format, matching the success path. The
    // timeline-restore handler replays it via loadSnapshot() and the timeline
    // detail panel reads params/headers as bulk text, both of which need strings.
    const reqNode = _buildSnapshot(node);
    const resp = {
      request: e.detail.request ?? {},
      error: {
        name: e.detail.name ?? "Error",
        message: e.detail.message ?? "",
        hint: e.detail.hint ?? "",
      },
      status: 0,
      statusText: e.detail.name ?? "Error",
      headers: {},
      cookies: [],
      body: "",
      elapsed: e.detail.elapsed ?? 0,
      size: 0,
      consoleLog: e.detail.consoleLog ?? [],
    };

    if (!_historyLoaded.has(node.id)) {
      await _loadRequestHistory(node.id);
      _historyLoaded.add(node.id);
    }

    const entries = _requestHistory.get(node.id) ?? [];
    entries.unshift({
      id: histId,
      requestNode: reqNode,
      requestUrl: reqUrl,
      response: resp,
      timestamp: nowMs,
    });

    addHistory(
      node.id,
      {
        id: histId,
        timestamp: nowMs,
        status: 0,
        statusText: resp.statusText,
        elapsed: resp.elapsed,
        size: 0,
        requestUrl: reqUrl,
        requestNode: reqNode,
      },
      {
        request: resp.request,
        error: resp.error,
        headers: {},
        cookies: [],
        body: "",
        consoleLog: resp.consoleLog,
      },
    );

    while (entries.length > _maxHistory) {
      const old = entries.pop();
      if (old?.id) deleteHistory(node.id, old.id);
    }

    _requestHistory.set(node.id, entries);
    const errLatest = entries[0];
    const errName = node?.name;
    if (errName) {
      _responseCache[errName] = errLatest?.response?.body ?? "";
      _responseHeaders[errName] = errLatest?.response?.headers ?? {};
      _responseStatus[errName] = errLatest?.response?.status ?? 0;
    }
    if (node.id === _selectedNode?.id) _dispatchTimelineUpdate(node.id);
  });
}

// Live streaming runs (Feature 33): record exactly one Timeline entry per stream
// when it ends. _recordStreamRun is private to this group (only the stream-end /
// stream-error listeners below call it).
function installStreamHandlers() {
  // Write exactly one Timeline record when a stream ends — cleanly, stopped, or
  // errored. The streaming marker stashed the request / status / headers under
  // _pendingStreams (keyed by streamId); the end/error push adds the duration,
  // counts, and last events. Unlike a buffered response there is no body to
  // persist, so a compact summary stands in for it.
  async function _recordStreamRun(d, { errored = false } = {}) {
    const sid = d?.streamId;
    if (!sid) return;
    const pending = _pendingStreams.get(sid);
    if (!pending) return; // not ours (history was off when the stream started)
    _pendingStreams.delete(sid);

    const node = pending.node;
    if (!node?.id || _maxHistory <= 0) return;

    const elapsed = d.elapsed ?? 0;
    const bytes = d.totalBytes ?? 0;
    // "Time sent" = the request start, derived from the end stamp minus the
    // measured duration so it stays consistent with `elapsed`.
    const sentAt =
      typeof d.ts === "number" ? d.ts - elapsed : Date.now() - elapsed;

    const summary = {
      sentAt,
      elapsed,
      eventCount: d.eventCount ?? 0,
      bytes,
      aborted: d.aborted === true,
      errored,
      errorMessage: errored ? (d.message ?? d.name ?? "") : "",
      sse: pending.sse === true,
      events: Array.isArray(d.lastEvents) ? d.lastEvents : [],
    };

    const histId = crypto.randomUUID();
    const reqNode = _buildSnapshot(node);
    const resp = {
      request: { url: pending.requestUrl, method: pending.method ?? "" },
      status: pending.status ?? 0,
      statusText: pending.statusText ?? "",
      headers: pending.headers ?? {},
      cookies: pending.cookies ?? [],
      body: "",
      elapsed,
      size: bytes,
      consoleLog: pending.consoleLog ?? [],
      encoding: "utf8",
      streamSummary: summary,
    };

    if (!_historyLoaded.has(node.id)) {
      await _loadRequestHistory(node.id);
      _historyLoaded.add(node.id);
    }
    const entries = _requestHistory.get(node.id) ?? [];
    entries.unshift({
      id: histId,
      requestNode: reqNode,
      requestUrl: pending.requestUrl,
      response: resp,
      timestamp: sentAt,
    });

    addHistory(
      node.id,
      {
        id: histId,
        timestamp: sentAt,
        status: resp.status,
        statusText: resp.statusText,
        elapsed,
        size: bytes,
        requestUrl: pending.requestUrl,
        requestNode: reqNode,
      },
      {
        headers: resp.headers,
        cookies: resp.cookies,
        body: "",
        consoleLog: resp.consoleLog,
        streamSummary: summary,
      },
    );

    while (entries.length > _maxHistory) {
      const old = entries.pop();
      if (old?.id) deleteHistory(node.id, old.id);
    }
    _requestHistory.set(node.id, entries);
    // Repaint the timeline only when it is showing this request (a background
    // stream must not steal the pane from whatever the user is now viewing).
    if (node.id === _selectedNode?.id) _dispatchTimelineUpdate(node.id);
  }

  window.addEventListener("wurl:stream-end", (e) =>
    _recordStreamRun(e.detail, { errored: false }),
  );
  window.addEventListener("wurl:stream-error", (e) =>
    _recordStreamRun(e.detail, { errored: true }),
  );
}

// Tree mutations, request deletion, favorites/recents, opening a request from
// the quick-access lists, the cleared-editor reset, and timeline restore.
function installTreeQuickAccessHandlers() {
  // Auto-save whenever the tree is mutated (add / remove collection or request)
  window.addEventListener("wurl:collections-changed", (e) => {
    saveCollections(e.detail);
    // Keep favorites / recents for the active collection in sync with renames,
    // method changes, and any deletions reflected in the new tree.
    reconcileQuickAccess(e.detail);
  });

  // Delete the backing request file(s) when a node is removed from the tree.
  // Fired by tree-view after #deleteNode; ids contains every request under the
  // deleted node (a single request, or all requests in a deleted folder/collection).
  window.addEventListener("wurl:requests-deleted", (e) => {
    for (const id of e.detail.ids) {
      deleteRequest(id);
      _requestHistory.delete(id);
      _historyLoaded.delete(id);
    }
    // Drop the deleted requests from favorites / recents so they don't dangle.
    pruneQuickAccess(new Set(e.detail.ids));
  });

  // Toggle a request's favorite state (from the tree context menu or the
  // Favorites list). Favorites span every collection, so the entry records the
  // collection it belongs to.
  window.addEventListener("wurl:favorite-toggle", (e) => {
    const { node, favorited } = e.detail ?? {};
    if (!node?.id) return;
    const current = currentSettings.favorites ?? [];
    const favorites = favorited
      ? addFavorite(current, makeEntry(node, currentColls.activeCollectionId))
      : removeIds(current, new Set([node.id]));
    if (favorites === current) return; // no-op (already in desired state)
    updateSettings({ favorites });
    if (treeView) treeView.setFavorites(favorites);
  });

  // Open a request from the Favorites / Recents lists. Switches to the owning
  // collection first when it differs from the active one, then focuses the row.
  window.addEventListener("wurl:request-open", async (e) => {
    const { collectionId, requestId } = e.detail ?? {};
    if (!requestId) return;
    if (collectionId && collectionId !== currentColls.activeCollectionId) {
      const exists = currentColls.collections.some(
        (c) => c.id === collectionId,
      );
      if (exists) await activateCollection(collectionId);
    }
    if (treeView) treeView.focusRequest(requestId);
  });

  // Reset the editor when the last request is deleted and there is nothing left to select.
  window.addEventListener("wurl:request-cleared", () => {
    _selectedNode = null;
    _clearRequestEditor();
  });

  // Restoring (the right-click action) replays the snapshot back into the editor
  // — the one destructive timeline action — then shows its response.
  window.addEventListener("wurl:timeline-restore", (e) => {
    const { requestNode, requestUrl = "", response } = e.detail;
    const restoredNode = requestEditor.loadSnapshot(requestNode);
    if (restoredNode?.id) {
      const { id, ...nodeFields } = restoredNode;
      treeView.updateNode(id, nodeFields, { silent: true });
      _selectedNode = { ..._selectedNode, id, ...nodeFields };
      _scheduleRequestSave(id, nodeFields);
    }
    _viewTimelineResponse(requestUrl, response);
  });
}

// ── Collection / variable / capture helpers ─────────────────────────────────
// Module-level so they are shared by the editor-popup callbacks (wired in
// initEventBus) and by the handler groups above/below.

/**
 * Switch the active collection: persist the current tree, load the target
 * collection's items + variables, and refresh the dependent UI. Does NOT
 * restore a selected request — callers decide what to focus afterwards.
 * @param {string} id
 */
async function activateCollection(id) {
  // Persist the current collection's items before switching
  if (treeView)
    await saveCollectionData(
      currentColls.activeCollectionId,
      treeView.getItems(),
    );

  setActiveCollection(id);
  currentColls = { ...currentColls, activeCollectionId: id };

  await saveManifest({
    collections: currentColls.collections,
    activeCollectionId: id,
  });

  const { items, variables } = await loadCollectionData(id);
  treeView.setStorageKey(id);
  treeView.setItems(items);

  // Attach variables to the collection entry in memory
  currentColls = {
    ...currentColls,
    collections: currentColls.collections.map((coll) =>
      coll.id === id ? { ...coll, variables: variables ?? [] } : coll,
    ),
  };

  setNavPanelTitle(_collName(currentColls.collections, id));
  collPopup.update(collPopupState());
  _refreshEditorVariableContext();
}

/** Switch the active collection: save current items, load new ones. */
async function handleCollSelect({ id }) {
  if (id === currentColls.activeCollectionId) return;

  await activateCollection(id);

  // Restore previously selected request for this collection, or clear if none
  const savedId = currentSettings.selectedRequestIds?.[id];
  if (!savedId || !treeView.selectById(savedId)) {
    _selectedNode = null;
    _clearRequestEditor();
  }
}

/** Add a new (empty) collection and switch to it. */
async function handleCollAdd({ name }) {
  const newColl = { id: crypto.randomUUID(), name, sendCookies: true };
  const collections = [...currentColls.collections, newColl];

  // Save empty items for the new collection
  await saveCollectionData(newColl.id, []);

  // Switch to the new collection
  if (treeView)
    await saveCollectionData(
      currentColls.activeCollectionId,
      treeView.getItems(),
    );
  setActiveCollection(newColl.id);
  currentColls = { collections, activeCollectionId: newColl.id };

  await saveManifest({ collections, activeCollectionId: newColl.id });

  treeView.setStorageKey(newColl.id);
  treeView.setItems([]);
  _selectedNode = null;
  _clearRequestEditor();
  setNavPanelTitle(newColl.name);
  collPopup.update(collPopupState());
}

/** Rename a collection — updates its display name everywhere without touching its items. */
async function handleCollRename({ id, name }) {
  const collections = currentColls.collections.map((coll) =>
    coll.id === id ? { ...coll, name } : coll,
  );
  currentColls = { ...currentColls, collections };

  // Persist the manifest with the new name
  await saveManifest({
    collections,
    activeCollectionId: currentColls.activeCollectionId,
  });

  // If the renamed collection is active, update the nav panel title
  if (id === currentColls.activeCollectionId) setNavPanelTitle(name);

  collPopup.update(collPopupState());
}

/** Delete a collection (must always leave at least 1). */
async function handleCollDelete({ id }) {
  if (currentColls.collections.length <= 1) return; // guard

  let collections = currentColls.collections.filter((coll) => coll.id !== id);
  let activeId = currentColls.activeCollectionId;

  // If we're deleting the active collection, switch to the first remaining one
  if (id === activeId) {
    activeId = collections[0].id;
    const { items, variables } = await loadCollectionData(activeId);
    setActiveCollection(activeId);
    treeView.setStorageKey(activeId);
    treeView.setItems(items);
    const savedId = currentSettings.selectedRequestIds?.[activeId];
    if (!savedId || !treeView.selectById(savedId)) {
      _selectedNode = null;
      _clearRequestEditor();
    }
    setNavPanelTitle(_collName(collections, activeId));
    // Attach variables in memory
    collections = collections.map((coll) =>
      coll.id === activeId ? { ...coll, variables: variables ?? [] } : coll,
    );
  } else {
    setActiveCollection(activeId);
  }

  currentColls = { collections, activeCollectionId: activeId };
  await saveManifest({ collections, activeCollectionId: activeId });
  // Reclaim the collection's on-disk directory now that the manifest no longer
  // references it (requests, history, responses, cookies, metadata).
  await deleteCollection(id);
  // Drop favorites / recents that pointed into the deleted collection.
  const favorites = removeCollection(currentSettings.favorites ?? [], id);
  const recents = removeCollection(currentSettings.recents ?? [], id);
  if (
    favorites !== currentSettings.favorites ||
    recents !== currentSettings.recents
  ) {
    updateSettings({ favorites, recents });
    if (treeView) {
      treeView.setFavorites(favorites);
      treeView.setRecents(recents);
    }
  }
  collPopup.update(collPopupState());
}

// ── Variable handlers ───────────────────────────────────────────────────────

/** Open the variables popup for a folder node (the one listener in this group). */
function installFolderVarsHandler() {
  window.addEventListener("wurl:folder-vars-open", (e) => {
    const { nodeId, folderName, variables } = e.detail;
    varsPopup.open({
      scopeId: nodeId,
      scopeName: folderName,
      variables: variables ?? [],
      bulkEditor: currentSettings.varsBulkEditor ?? true,
    });
  });
}

/**
 * Persist variables and keep in-memory state in sync.
 * The `scopeId` field doubles as a folder-node ID when it doesn't match any
 * collection — in that case the variables are stored on the tree node.
 */
async function handleVarsSave({ scopeId, variables }) {
  const isColl = currentColls.collections.some((coll) => coll.id === scopeId);

  if (isColl) {
    // Update in-memory collection state
    currentColls = {
      ...currentColls,
      collections: currentColls.collections.map((coll) =>
        coll.id === scopeId ? { ...coll, variables } : coll,
      ),
    };
    saveCollectionVariables(scopeId, variables);
  } else {
    // It's a folder node — patch the tree and persist collections
    if (treeView) {
      treeView.updateNode(scopeId, { variables }, { silent: true });
      await saveCollections(treeView.getItems());
    }
  }

  // Revalidate pill editors in the request panel for the updated context
  _refreshEditorVariableContext(
    currentSettings.selectedRequestIds?.[currentColls.activeCollectionId],
  );
}

/**
 * Persist a collection's "send cookies" flag (whether its cookie jar is
 * attached to outgoing requests). Stored in the manifest alongside id/name.
 */
async function handleCollSendCookies({ id, sendCookies }) {
  const collections = currentColls.collections.map((coll) =>
    coll.id === id ? { ...coll, sendCookies } : coll,
  );
  currentColls = { ...currentColls, collections };
  await saveManifest({
    collections,
    activeCollectionId: currentColls.activeCollectionId,
  });
  collPopup.update(collPopupState());
}

/** Persist the Bulk Editor toggle preference into settings. */
function handleVarsBulkEditorChange({ bulkEditor }) {
  updateSettings({ varsBulkEditor: bulkEditor });
}

// ── Environment handlers ─────────────────────────────────────────────────

async function handleEnvironmentsChanged({ data }) {
  currentEnvironments = data;
  await saveEnvironments(currentEnvironments);
  environmentsPopup.update(currentEnvironments);
  _refreshEditorVariableContext();
  envPicker.load(currentEnvironments);
}

async function handleEnvActivate({ id }) {
  currentEnvironments = {
    ...currentEnvironments,
    activeEnvironmentId: id,
  };
  await saveEnvironments(currentEnvironments);
  environmentsPopup.update(currentEnvironments);
  _refreshEditorVariableContext();
  envPicker.load(currentEnvironments);
}

async function handleEnvVarsSave({ id, variables }) {
  if (id === null) {
    currentEnvironments = {
      ...currentEnvironments,
      globalVariables: variables,
    };
  } else {
    currentEnvironments = {
      ...currentEnvironments,
      environments: currentEnvironments.environments.map((env) =>
        env.id === id ? { ...env, variables } : env,
      ),
    };
  }
  await saveEnvironments(currentEnvironments);
  _refreshEditorVariableContext();
}

// ── Variable context helper ──────────────────────────────────────────────

/**
 * Compute the current variable resolution context and push it to the
 * request editor so its pill editors can validate {{variables}}.
 *
 * @param {string|null} [nodeId]  — the selected request/folder node ID;
 *   defaults to the active collection's selectedRequestId.
 */
function _refreshEditorVariableContext(nodeId) {
  if (!requestEditor) return;
  const id =
    nodeId ??
    currentSettings.selectedRequestIds?.[currentColls.activeCollectionId] ??
    null;
  // Variables are stored canonically as arrays; the resolver consumes maps,
  // so flatten each scope (and every folder-chain node) here at the boundary.
  const folderChain = (
    treeView && id ? buildFolderChain(treeView.getItems(), id) : []
  ).map((folder) => ({
    ...folder,
    variables: varsArrayToMap(folder.variables),
    // Parallel set of secret names — the map above drops the secure flag.
    secureVariables: varsArrayToSecureSet(folder.variables),
  }));
  const activeColl = currentColls.collections.find(
    (coll) => coll.id === currentColls.activeCollectionId,
  );
  const collectionVariables = varsArrayToMap(activeColl?.variables);
  const secureCollectionVariables = varsArrayToSecureSet(activeColl?.variables);
  const node =
    _selectedNode ??
    (id && treeView ? _findNodeById(treeView.getItems(), id) : null);

  const activeEnvId = currentEnvironments.activeEnvironmentId;
  const activeEnv = currentEnvironments.environments.find(
    (e) => e.id === activeEnvId,
  );
  const environmentVariables = varsArrayToMap(activeEnv?.variables);
  const secureEnvironmentVariables = varsArrayToSecureSet(activeEnv?.variables);
  const globalVariables = varsArrayToMap(currentEnvironments.globalVariables);
  const secureGlobalVariables = varsArrayToSecureSet(
    currentEnvironments.globalVariables,
  );

  requestEditor.setVariableContext({
    collectionVariables,
    secureCollectionVariables,
    environmentVariables,
    secureEnvironmentVariables,
    globalVariables,
    secureGlobalVariables,
    folderChain,
    collectionName: activeColl?.name ?? "",
    activeEnvironmentName: activeEnv?.name ?? "",
    requestName: node?.name ?? "",
    responseCache: _responseCache,
    responseHeaders: _responseHeaders,
    responseStatus: _responseStatus,
  });
  // Feed merged variables to the tree-view so "Generate cURL" resolves correctly.
  // Collection-level wins over environment which wins over global.
  if (treeView) {
    treeView.setEnvVariables({
      ...globalVariables,
      ...environmentVariables,
      ...collectionVariables,
    });
  }
}

// ── Post-response captures (Feature 03) ──────────────────────────────────

/**
 * Run a request's capture rules against a freshly received response and write
 * the extracted values into their target variable scopes.
 *
 * Gated on a 2xx response (a failed login must not clobber a good token).
 * Persistence reuses the existing env / collection variable handlers — which
 * encrypt `secure` values, refresh the variables UI, and route write failures
 * into the Notifications.error sink — so this adds no new write path. Never
 * surfaces a captured value (secure or not): toasts and the response marker
 * carry variable names + scopes only.
 *
 * Also called by the future collection runner (Feature 02) between requests.
 *
 * @param {object} node    selected request node (carries `captures`)
 * @param {object} detail  wurl:response-received detail (status/headers/body)
 */
async function _applyCapturesForNode(node, detail) {
  const rules = node?.captures;
  if (!Array.isArray(rules) || rules.length === 0) return;
  const status = detail?.status ?? 0;
  if (status < 200 || status >= 300) return; // 2xx-only

  const { writes, warnings } = applyCaptures(
    { status, headers: detail?.headers ?? {}, body: detail?.body ?? "" },
    rules,
  );

  // Group writes by scope so each scope is persisted once.
  const byScope = { environment: [], collection: [], global: [] };
  for (const w of writes) {
    if (byScope[w.scope]) byScope[w.scope].push(w);
  }

  const applied = []; // { scope, name } — drives the success summary
  let envTouched = false;

  // Global variables
  if (byScope.global.length) {
    const variables = _mergeCaptureWrites(
      currentEnvironments.globalVariables,
      byScope.global,
    );
    await handleEnvVarsSave({ id: null, variables });
    byScope.global.forEach((w) =>
      applied.push({ scope: "global", name: w.name }),
    );
    envTouched = true;
  }

  // Active environment
  if (byScope.environment.length) {
    const activeId = currentEnvironments.activeEnvironmentId;
    const activeEnv = currentEnvironments.environments.find(
      (e) => e.id === activeId,
    );
    if (!activeId || !activeEnv) {
      Notifications.warning(
        `No active environment — skipped capturing ${_captureNameList(
          byScope.environment,
        )}.`,
        { title: t("app.captureSkipped") },
      );
    } else {
      const variables = _mergeCaptureWrites(
        activeEnv.variables,
        byScope.environment,
      );
      await handleEnvVarsSave({ id: activeId, variables });
      byScope.environment.forEach((w) =>
        applied.push({ scope: "env", name: w.name }),
      );
      envTouched = true;
    }
  }

  // Active collection
  if (byScope.collection.length) {
    const activeCollId = currentColls.activeCollectionId;
    const activeColl = currentColls.collections.find(
      (c) => c.id === activeCollId,
    );
    if (!activeCollId || !activeColl) {
      Notifications.warning(
        `No active collection — skipped capturing ${_captureNameList(
          byScope.collection,
        )}.`,
        { title: t("app.captureSkipped") },
      );
    } else {
      const variables = _mergeCaptureWrites(
        activeColl.variables,
        byScope.collection,
      );
      await handleVarsSave({ scopeId: activeCollId, variables });
      byScope.collection.forEach((w) =>
        applied.push({ scope: "coll", name: w.name }),
      );
    }
  }

  // Reflect new env/global values in any open popup + the picker.
  if (envTouched) {
    environmentsPopup.update(currentEnvironments);
    envPicker.load(currentEnvironments);
  }

  // Surface outcomes — names + scopes only, never values.
  if (applied.length) {
    const summary = applied.map((a) => `${a.scope}.${a.name}`).join(", ");
    Notifications.info(
      `Captured ${applied.length} variable${
        applied.length === 1 ? "" : "s"
      } → ${summary}`,
    );
    window.dispatchEvent(
      new CustomEvent("wurl:captures-applied", {
        detail: { count: applied.length },
      }),
    );
  }
  if (warnings.length) {
    Notifications.warning(
      `${warnings.length} capture${
        warnings.length === 1 ? "" : "s"
      } found no value: ${_captureNameList(warnings)}`,
    );
  }
}

/** Comma-join capture entry names for a message (names only — never values). */
function _captureNameList(entries) {
  return entries.map((e) => e.name).join(", ");
}

/**
 * Upsert capture writes (matched by name) into a canonical variable array,
 * carrying each write's `secure` flag. Returns a fresh array; the input is not
 * mutated.
 */
function _mergeCaptureWrites(existing, writes) {
  const list = normalizeVariables(existing);
  for (const w of writes) {
    const entry = { name: w.name, value: w.value, secure: !!w.secure };
    const i = list.findIndex((v) => v.name === w.name);
    if (i >= 0) list[i] = entry;
    else list.push(entry);
  }
  return list;
}

// When the request editor mutates a field (method, url, params, body, auth, …),
// immediately sync the in-memory tree and update the visible tree-view node
// (e.g. the method badge), then schedule a debounced storage write so that
// rapid typing does not flood the persistence layer with individual saves.
// Accumulate the partial patch (the changed fields) per request across the
// debounce window, then write each request granularly — only that request's
// file is re-encrypted, not the whole collection. Partial (not full-node)
// patches are required so the main-side clobber guard can preserve an auth
// block that the edit didn't touch (see data-store.updateRequest).
function _scheduleRequestSave(id, fields) {
  if (id) {
    _pendingRequestPatches.set(id, {
      ...(_pendingRequestPatches.get(id) ?? {}),
      ...fields,
    });
  }
  clearTimeout(_requestSaveTimer);
  _requestSaveTimer = setTimeout(() => {
    const patches = [..._pendingRequestPatches];
    _pendingRequestPatches.clear();
    void _persistRequestEdits(patches);
  }, 400);
}

async function _persistRequestEdits(patches) {
  if (!treeView) return;
  // Keep the data-store items mirror in step with the tree so a later
  // saveCollectionVariables() (full write) can't clobber these edits.
  setActiveItems(treeView.getItems());
  for (const [id, patch] of patches) {
    const ok = await updateRequest(id, patch);
    if (!ok) {
      // Brand-new request not yet on disk, a write failure, or the dev-server:
      // fall back to a full save, which creates the file and reports failures.
      await saveCollections(treeView.getItems());
      return;
    }
  }
}

// Request-editor field mutations (debounced per-request persistence), cURL
// paste rewrite, request cancel, and the send pipeline. handleCurlPaste and
// applyCurlToRequest are private to this group (only the curl-pasted listener
// uses them).
function installRequestEditSendHandlers() {
  window.addEventListener("wurl:request-updated", (e) => {
    const { id, ...fields } = e.detail;
    if (id && treeView) {
      // silent=true → in-memory patch + DOM update, no immediate #emitChange
      treeView.updateNode(id, fields, { silent: true });
      // Debounced granular write so keystrokes batch into a single per-request save
      _scheduleRequestSave(id, fields);
      // Mirror the patch onto _selectedNode so history captures the latest
      // editor state. updateNode() creates a new object in the tree, so
      // _selectedNode would otherwise remain stale until the next selection.
      if (_selectedNode?.id === id) {
        _selectedNode = { ..._selectedNode, ...fields };
      }
    }
  });

  // A cURL command pasted into the URL bar rewrites the selected request to
  // match it (see RequestEditor#maybeHandleCurlPaste).
  window.addEventListener("wurl:curl-pasted", (e) =>
    handleCurlPaste(e.detail?.id, e.detail?.text),
  );

  // Rewrite the request loaded in the editor to match a pasted cURL command —
  // the in-place equivalent of a cURL import. A blank/new request is rewritten
  // straight away; any other request prompts for confirmation first, since the
  // paste overwrites its method, URL, params, headers, body and auth.
  async function handleCurlPaste(id, text) {
    if (!id || !treeView || !requestEditor) return;
    let parsed;
    try {
      parsed = parseCurl(text);
    } catch (err) {
      Notifications.error(
        t("request.curlPaste.failed", { message: String(err.message ?? err) }),
        { title: t("request.curlPaste.title") },
      );
      return;
    }
    const req = parsed.collection.children?.[0];
    const node = _findNodeById(treeView.getItems(), id);
    if (!req || !node || node.type !== "request") return;

    if (_isBlankRequestNode(node)) {
      await applyCurlToRequest(node, req, parsed);
    } else {
      PopupManager.confirm({
        title: t("request.curlPaste.title"),
        message: t("request.curlPaste.confirm"),
        confirmLabel: t("request.curlPaste.replace"),
        confirmClass: "btn--danger",
        onConfirm: () => {
          void applyCurlToRequest(node, req, parsed);
        },
      });
    }
  }

  // Apply a parsed cURL request onto an existing request node: refresh the editor
  // UI, persist the replaced fields, and surface any warnings (missing -F files,
  // unsupported flags). Keeps the node's identity and non-HTTP bits (name, notes,
  // captures); everything the cURL defines is overwritten.
  async function applyCurlToRequest(node, req, parsed) {
    const fields = _curlRequestFields(req);
    requestEditor.load({ ...node, ...fields });
    // updateNode merges the delta, so the stored node becomes the overlaid node
    // (old method/url/params/headers/body/auth replaced).
    treeView.updateNode(node.id, fields, { silent: true });
    if (_selectedNode?.id === node.id) {
      _selectedNode = { ..._selectedNode, ...fields };
    }
    _scheduleRequestSave(node.id, fields);

    // -F file fields reference local paths; warn only about ones not on disk.
    const filePaths = collectFormFilePaths(parsed.collection);
    if (filePaths.length) {
      let missing = filePaths;
      try {
        missing =
          (await window.wurl?.import?.file?.checkMissing?.(filePaths)) ??
          filePaths;
      } catch {
        missing = filePaths;
      }
      warnMissingFormFiles(parsed, missing);
    }

    if (parsed.warnings?.length) {
      Notifications.warning(
        `${t("request.curlPaste.applied")} ${parsed.warnings.join(" ")}`,
        { title: t("request.curlPaste.title"), duration: 0 },
      );
    } else {
      Notifications.success(t("request.curlPaste.applied"));
    }
  }

  // Lazy-load response caches when a request is executed that references another request
  requestEditor?.setEnsureResponseCaches(async (refs, ctx) => {
    const allRequests = getAllRequests(treeView?.getItems() ?? []);
    await Promise.all(
      refs.map(async ({ name, mode }) => {
        const req = allRequests.find((r) => r.name === name);
        if (!req) return;
        if (mode === "run-immediately") {
          const node = _findNodeById(treeView?.getItems() ?? [], req.id);
          if (!node) return;
          const result = await _executeRequestNode(node, ctx);
          _responseCache[name] = result.body;
          _responseHeaders[name] = result.headers;
          _responseStatus[name] = result.status;
        } else {
          if (!_historyLoaded.has(req.id)) {
            await _loadRequestHistory(req.id);
            _historyLoaded.add(req.id);
          }
          const histEntries = _requestHistory.get(req.id) ?? [];
          const latest = histEntries[0];
          if (latest) {
            _responseCache[name] = latest.response?.body ?? "";
            _responseHeaders[name] = latest.response?.headers ?? {};
            _responseStatus[name] = latest.response?.status ?? 0;
          }
        }
      }),
    );
  });

  window.addEventListener("wurl:cancel-request", (e) => {
    const requestId = e.detail?.requestId ?? null;
    // A live stream (Feature 33) is aborted in the main process; its stream-end
    // (aborted:true) push updates the viewer and settles the editor's Send/Stop
    // button, so we do NOT fall through to the abortController + request-error
    // path below (the execute() promise already resolved with the marker).
    if (e.detail?.streamId) {
      window.wurl?.http?.stream?.abort?.(e.detail.streamId)?.catch?.(() => {});
      return;
    }
    // Cancel the execution(s) belonging to this request; with no requestId
    // (legacy callers) cancel everything in flight.
    let snapshot = null;
    for (const exec of _inFlightExecs) {
      if (requestId !== null && exec.requestId !== requestId) continue;
      exec.cancelled = true;
      exec.abortController?.abort();
      exec.abortController = null;
      snapshot = exec.snapshot;
      _inFlightExecs.delete(exec);
    }
    // Give instant feedback: treat cancel as an error. Dispatched even when no
    // execution matched — an OAuth-phase cancel happens before the execution
    // is registered, and the editor/panels still need the state reset.
    window.dispatchEvent(
      new CustomEvent("wurl:request-error", {
        detail: {
          requestId,
          request: snapshot ?? {
            method: "GET",
            url: "",
            headers: {},
            body: null,
          },
          name: "AbortError",
          message: t("app.requestCancelled"),
          hint: t("app.requestCancelledHint"),
          elapsed: 0,
          consoleLog: ["* Request cancelled by user"],
        },
      }),
    );
  });

  // When the request editor fires a send, execute the request via the
  // native layer (Electron IPC or the Go dev-server proxy endpoint).
  window.addEventListener("wurl:send-request", async (e) => {
    const descriptor = e.detail;
    const requestId = descriptor?.requestId ?? _selectedNode?.id ?? null;

    // ── Guard: URL must be a non-empty string ────────────────────────────────
    const rawUrl = descriptor?.url;
    if (!rawUrl || typeof rawUrl !== "string" || !rawUrl.trim()) {
      window.dispatchEvent(
        new CustomEvent("wurl:request-error", {
          detail: {
            requestId,
            request: {
              method: descriptor?.method ?? "GET",
              url: rawUrl ?? "",
              headers: {},
              body: null,
            },
            name: "TypeError",
            message: t("app.noUrl"),
            hint: t("app.noUrlHint"),
            elapsed: 0,
            consoleLog: ["* Error: No URL specified."],
          },
        }),
      );
      return;
    }

    // A send bumps the current request to the top of recents. Skip when it is
    // already at the front to avoid redundant settings writes on repeat sends.
    if (
      _selectedNode?.id &&
      currentSettings.recents?.[0]?.requestId !== _selectedNode.id
    ) {
      const recents = addRecent(
        currentSettings.recents ?? [],
        makeEntry(_selectedNode, currentColls.activeCollectionId),
      );
      updateSettings({ recents });
      if (treeView) treeView.setRecents(recents);
    }

    // Snapshot the originating tree node now: requests run concurrently, so
    // by the time the response arrives the selection may point elsewhere. The
    // snapshot routes history/captures back to the request actually sent.
    const requestNode =
      _selectedNode?.id === requestId
        ? _selectedNode
        : _findNodeById(treeView?.getItems() ?? [], requestId);

    const requestSnapshot = {
      method: descriptor.method,
      url: descriptor.url,
      headers: descriptor.headers ?? {},
      body: typeof descriptor.body === "string" ? descriptor.body : null,
    };

    // Register this execution so wurl:cancel-request can abort it individually.
    const exec = {
      requestId,
      snapshot: requestSnapshot,
      abortController: null,
      cancelled: false,
    };
    _inFlightExecs.add(exec);

    // Streaming (Feature 33): mint a stream id now and carry it on the loading
    // event so the ResponseViewer can pre-arm and never miss an early frame.
    // Only interactive sends are streamCapable; text/event-stream always
    // auto-streams, and application/x-ndjson auto-streams when the global
    // streamNdjson setting is on (Settings → Request).
    const streamId = crypto.randomUUID();
    window.dispatchEvent(
      new CustomEvent("wurl:request-loading", {
        detail: { requestId, streamId },
      }),
    );

    // ── Build the descriptor for the native layer ────────────────────────────
    const nativeDesc = {
      method: descriptor.method,
      url: descriptor.url,
      headers: descriptor.headers ?? {},
      body: typeof descriptor.body === "string" ? descriptor.body : null,
      bodyFilePath: descriptor.bodyFilePath ?? null,
      multipart: descriptor.multipart ?? null,
      timeout: currentSettings.timeout ?? 30000,
      followRedirects: currentSettings.followRedirects ?? true,
      verifySsl: currentSettings.verifySsl ?? true,
      awsIam: descriptor.awsIam ?? null,
      authDigest: descriptor.authDigest ?? null,
      authNtlm: descriptor.authNtlm ?? null,
      oauth1: descriptor.oauth1 ?? null,
      ..._proxyDescriptorFields(currentSettings),
      retry: _retryDescriptor(currentSettings),
      // Cookie jar (Feature 09): the main process captures Set-Cookie into the
      // active collection's jar and attaches matching cookies on send. Governed
      // per-collection by the "Send cookies" checkbox in the Collections editor.
      collectionId: currentColls.activeCollectionId ?? null,
      useCookieJar: _collSendCookies(currentColls.activeCollectionId),
      // Live streaming opt-in (only on this interactive path). text/event-stream
      // always streams; application/x-ndjson streams when the user enabled the
      // global "Stream NDJSON responses live" setting (Settings → Request).
      streamCapable: true,
      streamId,
      streamNdjson: currentSettings.streamNdjson === true,
    };

    // ── Choose execution path ────────────────────────────────────────────────
    // window.wurl.isElectron is set to true by Electron's preload.js.
    // It is never present when the page is served by the Go dev server in a
    // plain browser context.  We check this explicit sentinel rather than
    // testing for a function reference so detection cannot silently regress
    // if the preload is out of sync.
    const inElectron = window.wurl?.isElectron === true;

    try {
      let result;

      if (inElectron) {
        // ── Electron path: all HTTP via Node.js IPC (no Chromium/CORS) ───────
        // The main process uses Node's built-in http/https modules, so CORS,
        // certificate policies, and same-origin restrictions don't apply.
        if (typeof window.wurl?.http?.execute !== "function") {
          // Preload is out of date — this is a developer error, not a user
          // error.  Surface it clearly rather than silently falling back.
          throw new Error(
            "window.wurl.http.execute is not available. " +
              "Ensure the Electron app was rebuilt with the latest preload.js.",
          );
        }
        result = await window.wurl.http.execute(nativeDesc);
      } else {
        // ── Go dev-server path: POST to /api/execute proxy endpoint ──────────
        // The Go server makes the outgoing request server-side so CORS is
        // never a factor.  AbortController gives us cancellation support.
        const controller = new AbortController();
        exec.abortController = controller;

        const res = await fetch("/api/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(nativeDesc),
          signal: controller.signal,
        });
        exec.abortController = null;

        if (!res.ok) throw new Error(`Execute API returned HTTP ${res.status}`);
        result = await res.json();
      }

      // Discard the result if the user already cancelled this execution
      if (exec.cancelled) return;

      // ── Dispatch result ──────────────────────────────────────────────────
      if (result.error && result.status === 0) {
        // Network-level failure — no HTTP response received
        window.dispatchEvent(
          new CustomEvent("wurl:request-error", {
            detail: {
              requestId,
              requestNode,
              request: requestSnapshot,
              name: result.error.name,
              message: result.error.message,
              hint: _buildHint(result.error.name, result.error.message),
              elapsed: result.elapsed ?? 0,
              consoleLog: result.consoleLog ?? [],
            },
          }),
        );
      } else {
        // We got an HTTP response (any status code, including 4xx / 5xx)
        window.dispatchEvent(
          new CustomEvent("wurl:response-received", {
            detail: {
              requestId,
              requestNode,
              request: requestSnapshot,
              status: result.status,
              statusText: result.statusText,
              headers: result.headers ?? {},
              cookies: result.cookies ?? [],
              body: result.body ?? "",
              elapsed: result.elapsed ?? 0,
              size: result.size ?? 0,
              consoleLog: result.consoleLog ?? [],
              // "base64" marks a binary body (image / PDF / arbitrary bytes);
              // the viewer decodes it back to raw bytes before rendering.
              encoding: result.encoding ?? "utf8",
              // Streaming metadata for spilled (large) responses.
              truncated: result.truncated ?? false,
              bodyRef: result.bodyRef ?? null,
              fullSize: result.fullSize ?? result.size ?? 0,
              // Live streaming (Feature 33): the body is empty and flows over
              // the wurl:stream-* events keyed by streamId; the viewer switches
              // to its live-append mode instead of rendering a static body.
              streaming: result.streaming === true,
              streamId: result.streamId ?? null,
              sse: result.sse ?? false,
              contentType: result.contentType ?? "",
            },
          }),
        );
      }
    } catch (err) {
      if (exec.cancelled) return;

      const errName = (err instanceof Error ? err.name : "Error") || "Error";
      const msg = (err instanceof Error ? err.message : String(err)) || "";

      window.dispatchEvent(
        new CustomEvent("wurl:request-error", {
          detail: {
            requestId,
            requestNode,
            request: requestSnapshot,
            name: errName,
            message: msg,
            hint: _buildHint(errName, msg),
            elapsed: 0,
            consoleLog: [`* ${errName}: ${msg}`],
          },
        }),
      );
    } finally {
      _inFlightExecs.delete(exec);
    }
  });
}

// ─── Collections & Settings ───────────────────────────────────────────────────
/**
 * Load persisted data on startup.
 * In Go dev mode  → fetches from /api/collections (reads data/collections.json)
 * In Electron     → reads via ipcMain from the platform userData directory
 */
async function initCollections() {
  const [
    { items, settings, collections, activeCollectionId, variables },
    environmentsData,
  ] = await Promise.all([loadAll(), window.wurl.store.environments.get()]);

  if (environmentsData) currentEnvironments = environmentsData;

  treeView.setStorageKey(activeCollectionId);
  treeView.setItems(items);
  currentSettings = settings;
  _maxHistory = settings.historyCount ?? 5;
  settingsPopup.load(settings);
  applySettings(settings);

  // Seed collection state — attach loaded variables to the active collection object
  const collsWithVars = collections.map((coll) =>
    coll.id === activeCollectionId
      ? { ...coll, variables: variables ?? [] }
      : coll,
  );
  currentColls = { collections: collsWithVars, activeCollectionId };
  setNavPanelTitle(_collName(collections, activeCollectionId));
  envPicker.load(currentEnvironments);

  // Restore the previously selected request for this collection (or clear if none)
  const savedId = settings.selectedRequestIds?.[activeCollectionId];
  if (!savedId || !treeView.selectById(savedId)) {
    _clearRequestEditor();
  }
}

/** Return the name of a collection by id, falling back to a default. */
function _collName(collections, id) {
  return collections.find((c) => c.id === id)?.name ?? "Collections";
}

/**
 * Remove a set of request ids from favorites and recents, then persist and push
 * the result into the tree. Called when requests are deleted.
 * @param {Set<string>} idSet
 */
function pruneQuickAccess(idSet) {
  if (!idSet?.size) return;
  const favorites = removeIds(currentSettings.favorites ?? [], idSet);
  const recents = removeIds(currentSettings.recents ?? [], idSet);
  if (
    favorites === currentSettings.favorites &&
    recents === currentSettings.recents
  )
    return;
  updateSettings({ favorites, recents });
  if (treeView) {
    treeView.setFavorites(favorites);
    treeView.setRecents(recents);
  }
}

/**
 * Refresh favorites/recents metadata (name, method) for the active collection
 * against its current tree, dropping entries whose request no longer exists.
 * Entries in other collections are untouched (their trees aren't loaded).
 * @param {object[]} items  — the active collection's tree
 */
function reconcileQuickAccess(items) {
  const active = currentColls.activeCollectionId;
  if (!active) return;
  const liveMap = new Map();
  const walk = (nodes) => {
    for (const n of nodes ?? []) {
      if (n.type === "request") {
        liveMap.set(n.id, { name: n.name ?? "", method: n.method ?? "GET" });
      } else {
        walk(n.children);
      }
    }
  };
  walk(items);

  const favorites = reconcile(currentSettings.favorites ?? [], active, liveMap);
  const recents = reconcile(currentSettings.recents ?? [], active, liveMap);
  if (
    favorites === currentSettings.favorites &&
    recents === currentSettings.recents
  )
    return;
  updateSettings({ favorites, recents });
  if (treeView) {
    treeView.setFavorites(favorites);
    treeView.setRecents(recents);
  }
}

/**
 * Whether the given collection should attach its cookie jar to requests.
 * Defaults to true when unset or when no collection is active.
 */
function _collSendCookies(id) {
  const coll = currentColls.collections.find((c) => c.id === id);
  return coll ? coll.sendCookies !== false : true;
}

/**
 * Build the proxy-related descriptor fields from global settings. The main
 * process resolves the agent type from the URL scheme (HTTP/HTTPS/SOCKS), merges
 * the separate credentials in, and honours the NO_PROXY-style bypass list. All
 * fields are null/empty when the proxy is disabled, so requests are unaffected.
 * Credentials are sent only when proxyAuthEnabled is on (otherwise blanked, even
 * if a username/password is still stored).
 *
 * @param {object} settings  currentSettings
 */
function _proxyDescriptorFields(settings) {
  if (!settings.proxyEnabled || !settings.proxyUrl) {
    return {
      proxy: null,
      proxyUsername: "",
      proxyPassword: "",
      proxyBypass: "",
    };
  }
  const authOn = settings.proxyAuthEnabled ?? false;
  return {
    proxy: settings.proxyUrl,
    proxyUsername: authOn ? (settings.proxyUsername ?? "") : "",
    proxyPassword: authOn ? (settings.proxyPassword ?? "") : "",
    proxyBypass: settings.proxyBypass ?? "",
  };
}

/**
 * Build the retry-policy descriptor from global settings (null when disabled).
 * The main process clamps/validates and applies the exponential backoff; this
 * only carries the user's choices across IPC. Designed to be overridden per
 * request by Feature 42.
 *
 * @param {object} settings  currentSettings
 */
function _retryDescriptor(settings) {
  if (!settings.retryEnabled) return null;
  return {
    enabled: true,
    maxAttempts: settings.retryMaxAttempts ?? 3,
    backoffMs: settings.retryBackoffMs ?? 500,
    multiplier: settings.retryBackoffMultiplier ?? 2,
    maxDelayMs: settings.retryMaxDelayMs ?? 10000,
    onConnectionError: settings.retryOnConnectionError === true,
    onTimeout: settings.retryOnTimeout === true,
    statusCodes: settings.retryStatusCodes ?? "",
  };
}

/** Update the nav panel's title text. */
function setNavPanelTitle(name) {
  const titleEl = document.querySelector("#panel-nav .panel-title");
  if (titleEl) titleEl.textContent = name;
}

// ─── Zoom → Font-size handler ─────────────────────────────────────────────────
/**
 * Intercept every browser/OS zoom gesture and translate it into a font-size
 * step instead, so the entire UI scales through the settings system.
 *
 * Covered inputs:
 *   • Ctrl/Cmd + wheel scroll  (both Electron and browser dev mode)
 *   • Pinch gesture            (macOS trackpad — delivered as ctrlKey+wheel in Chromium)
 *   • Ctrl/Cmd + '+' / '='    keyboard zoom in
 *   • Ctrl/Cmd + '-'           keyboard zoom out
 *   • Ctrl/Cmd + '0'           keyboard reset to default
 *   • "Increase/Decrease/Reset Font Size" menu items (Electron only, via IPC)
 *
 * The font size is stepped through the exact ordered set defined in the
 * settings-popup <select> so the popup always reflects the current value.
 */
function installZoomHandlers() {
  // These values must stay in sync with the <option> elements in settings-popup.js.
  const FONT_SIZES = [9, 11, 12, 13, 14, 16, 18, 20];
  const DEFAULT_FONT = 13; // matches DEFAULT_SETTINGS.fontSize in data-store.js

  /**
   * Advance the font size by `direction` steps (+1 = larger, -1 = smaller).
   * If the current value is not in the list, the nearest entry is used as the
   * starting point.  Silently no-ops when already at the boundary.
   */
  function changeFontByStep(direction) {
    const current = currentSettings.fontSize ?? DEFAULT_FONT;

    // Locate current value in the allowed list; snap to nearest if not found.
    let idx = FONT_SIZES.indexOf(current);
    if (idx === -1) {
      const nearest = FONT_SIZES.reduce((prev, cur) =>
        Math.abs(cur - current) < Math.abs(prev - current) ? cur : prev,
      );
      idx = FONT_SIZES.indexOf(nearest);
    }

    const nextIdx = Math.max(
      0,
      Math.min(FONT_SIZES.length - 1, idx + direction),
    );
    const newSize = FONT_SIZES[nextIdx];
    if (newSize === current) return; // already at min/max limit

    updateSettings({ fontSize: newSize });
    applySettings(currentSettings);
  }

  /** Reset to the default font size. */
  function resetFont() {
    if ((currentSettings.fontSize ?? DEFAULT_FONT) === DEFAULT_FONT) return;
    updateSettings({ fontSize: DEFAULT_FONT });
    applySettings(currentSettings);
  }

  // ── Wheel / Pinch ────────────────────────────────────────────────────────────
  // Must be registered as non-passive so preventDefault() stops the browser
  // from performing its native visual zoom.  On macOS, two-finger pinch is
  // delivered to Chromium as a wheel event with ctrlKey=true.
  window.addEventListener(
    "wheel",
    (e) => {
      if (!(e.ctrlKey || e.metaKey)) return; // only intercept zoom-modifier combos

      e.preventDefault();
      e.stopPropagation();

      // Negative deltaY = scroll/pinch toward "zoom in"; positive = "zoom out".
      changeFontByStep(e.deltaY < 0 ? +1 : -1);
    },
    { passive: false, capture: true },
  );

  // ── Keyboard shortcuts ───────────────────────────────────────────────────────
  // Intercept Ctrl/Cmd + '+' / '-' / '0' before Chromium or the OS menu picks
  // them up.  Registered in the capture phase so they fire before editor widgets.
  window.addEventListener(
    "keydown",
    (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;

      // Allow normal key combos inside editable inputs/textareas.
      const tag = e.target?.tagName ?? "";
      if (["INPUT", "TEXTAREA"].includes(tag) || e.target?.isContentEditable)
        return;

      // Both '+' (shift+= US layout) and '=' map to zoom-in; '-' maps to zoom-out.
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        e.stopPropagation();
        changeFontByStep(+1);
      } else if (e.key === "-") {
        e.preventDefault();
        e.stopPropagation();
        changeFontByStep(-1);
      } else if (e.key === "0") {
        e.preventDefault();
        e.stopPropagation();
        resetFont();
      }
    },
    { capture: true },
  );

  // ── Cmd/Ctrl+Enter — send the active request ─────────────────────────────────
  window.addEventListener(
    "keydown",
    (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.key !== "Enter") return;
      e.preventDefault();
      e.stopPropagation();
      requestEditor?.element?.querySelector(".req-send-btn")?.click();
    },
    { capture: true },
  );

  // ── Electron menu items (main → preload → renderer) ──────────────────────────
  // The Electron main process replaced the native zoomIn/zoomOut/resetZoom menu
  // roles with custom items that send "wurl:ui-font-change" via webContents.send().
  // preload.js re-dispatches these as window CustomEvents so we can handle them here.
  window.addEventListener("wurl:ui-font-change", (e) => {
    const direction = e.detail;
    if (direction === "in") changeFontByStep(+1);
    else if (direction === "out") changeFontByStep(-1);
    else if (direction === "reset") resetFont();
  });
}

/**
 * Dispatch wurl:timeline-update with the history entries for the given request ID.
 * @param {string|null}  requestId
 * @param {boolean}      [isRequestSwitch] – true when triggered by a request selection;
 *                                           the response-viewer uses this to update the body tab.
 */
function _clearRequestEditor() {
  // Tear down any live WebSocket and restore the normal Response viewer.
  _closeWsConn();
  wsConsole?.reset();
  _setResponsePane(false);
  if (requestEditor) {
    requestEditor.load({
      id: null,
      method: "GET",
      url: "",
      params: [],
      headers: [],
      bodyType: "no-body",
      name: "",
    });
  }
  _dispatchTimelineUpdate(null, true);
}

function _dispatchTimelineUpdate(requestId, isRequestSwitch = false) {
  const entries = requestId ? (_requestHistory.get(requestId) ?? []) : [];
  window.dispatchEvent(
    new CustomEvent("wurl:timeline-update", {
      detail: {
        requestId: requestId ?? null,
        entries: [...entries],
        isRequestSwitch,
      },
    }),
  );
}

/**
 * Apply a settings object to the live UI.
 * Extend this function whenever a new setting needs to affect the DOM.
 * @param {object} settings
 */
// Font stacks keyed by the fontFamily setting value.
const FONT_STACKS = {
  inter: '"Inter", "Segoe UI", system-ui, -apple-system, sans-serif',
  system:
    'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  "sf-pro": '-apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif',
  segoe: '"Segoe UI", system-ui, sans-serif',
  ubuntu: '"Ubuntu", "Cantarell", system-ui, sans-serif',
  roboto: '"Roboto", "Helvetica Neue", system-ui, sans-serif',
};

function _applyCustomThemeVars(theme) {
  document.documentElement.dataset.theme = "custom";
  let styleEl = document.getElementById("wurl-custom-theme");
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = "wurl-custom-theme";
    document.head.appendChild(styleEl);
  }
  const vars = Object.entries(theme.vars)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");
  styleEl.textContent = `:root[data-theme="custom"] {\n  color-scheme: ${theme.colorScheme};\n${vars}\n}`;
}

function applySettings(settings) {
  // Theme — stored as a data attribute so CSS [data-theme="latte"] etc. applies
  const BUILT_IN_THEMES = new Set([
    "mocha",
    "grey-dark",
    "latte",
    "grey-light",
  ]);
  const themeId = settings.theme ?? "mocha";
  if (BUILT_IN_THEMES.has(themeId)) {
    document.documentElement.dataset.theme = themeId;
    document.getElementById("wurl-custom-theme")?.remove();
  } else {
    const custom = (settings.customThemes ?? []).find((t) => t.id === themeId);
    if (custom) {
      _applyCustomThemeVars(custom);
    } else {
      document.documentElement.dataset.theme = "mocha";
      document.getElementById("wurl-custom-theme")?.remove();
    }
  }
  // Font size — sets --font-size-base; all other sizes (xs, sm, md, lg, xl)
  // are defined as calc(base ± Npx) in theme.css so the whole UI scales.
  if (settings.fontSize) {
    document.documentElement.style.setProperty(
      "--font-size-base",
      `${settings.fontSize}px`,
    );
  }
  // UI font — sets --font-sans so the whole app uses the chosen typeface.
  if (settings.fontFamily) {
    const stack = FONT_STACKS[settings.fontFamily] ?? FONT_STACKS.inter;
    document.documentElement.style.setProperty("--font-sans", stack);
  }
  // Keep the settings-popup select in sync so it reflects the current value
  // even when fontSize was changed by a zoom gesture rather than the popup.
  if (settings.fontSize !== undefined && settingsPopup) {
    settingsPopup.load({ fontSize: settings.fontSize });
  }
  // Panel layout — apply the pinned layout and sync the picker button state
  if (settings.layout != null) {
    applyLayout(settings.layout);
    layoutPicker.load(settings.layout);
  }
  // Splitter positions — restore saved pixel values into the grid variables
  if (settings.splitterNav != null) splitterSizes.nav = settings.splitterNav;
  if (settings.splitterRes != null) splitterSizes.res = settings.splitterRes;
  if (settings.splitterRowRes != null)
    splitterSizes.rowRes = settings.splitterRowRes;
  applyGridVars();

  // Editor preferences
  if (requestEditor) requestEditor.applySettings(settings);
  if (responseViewer) responseViewer.applySettings(settings);
  if (varsPopup) varsPopup.applySettings(settings);
  if (collPopup) collPopup.applySettings(settings);
  if (environmentsPopup) environmentsPopup.applySettings(settings);
  if (treeView) {
    treeView.setDoubleClickExecute(settings.doubleClickExecute ?? false);
    // Quick-access surfaces (favorites / recents). showRecents only gates the
    // tab; the recents list is tracked regardless.
    treeView.setShowRecents(settings.showRecents !== false);
    treeView.setFavorites(settings.favorites ?? []);
    treeView.setRecents(settings.recents ?? []);
  }
  setPickerDebounceMs(settings.pickerDebounceMs ?? 200);

  // Remove headers — hide/show all .panel-header elements, app-header, and nav settings bar
  if (settings.removeHeaders !== undefined) {
    const remove = settings.removeHeaders;

    // Panel title bars
    document.querySelectorAll(".panel-header").forEach((header) => {
      header.style.display = remove ? "none" : "";
    });

    // Params / headers column-label rows
    document.querySelectorAll(".params-header-row").forEach((row) => {
      row.style.display = remove ? "none" : "";
    });

    // App-level header (contains the logo, subtitle and primary settings button)
    const appHeader = document.getElementById("app-header");
    if (appHeader) appHeader.style.display = remove ? "none" : "";

    // Place ctrl-group in the layout-appropriate container (replaces nav-settings-bar)
    placeCtrlGroup(_currentLayout, remove);
    // Pin the Collections button: tree-toolbar when headers are removed,
    // back to the nav panel-header otherwise. Stays put across all layouts.
    placeCollectionsButton(remove);
  }

  // Method icons — replace textual HTTP method names with iconography app-wide.
  // CSS keys off html.show-method-icons; each method keeps its own colour.
  if (settings.methodIcons !== undefined) {
    const iconsOn = !!settings.methodIcons;
    document.documentElement.classList.toggle("show-method-icons", iconsOn);
    // Sync tooltips on already-rendered method glyphs (tree badges + the URL-bar
    // method button). Tooltips only apply in icon mode; clear them otherwise.
    document.querySelectorAll(".tree-node-method").forEach((el) => {
      if (iconsOn) el.title = el.textContent;
      else el.removeAttribute("title");
    });
    document.querySelectorAll(".req-method-select").forEach((el) => {
      const label = el.querySelector(".req-method-select-label");
      if (iconsOn && label) el.title = label.textContent;
      else el.removeAttribute("title");
    });
  }
}

/** Walk the item tree and collect all request nodes as { id, name } pairs. */
function getAllRequests(items) {
  const result = [];
  function walk(nodes) {
    for (const node of nodes) {
      if (node.type === "request") {
        result.push({ id: node.id, name: node.name ?? "" });
      }
      if (Array.isArray(node.children)) walk(node.children);
    }
  }
  walk(items);
  return result;
}

/** Find a node by id anywhere in the tree (returns null if not found). */
function _findNodeById(items, id) {
  for (const node of items) {
    if (node.id === id) return node;
    if (Array.isArray(node.children)) {
      const found = _findNodeById(node.children, id);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Is a request node "blank/new" — i.e. has no HTTP definition a user would mind
 * losing? Used to decide whether pasting a cURL command into the URL bar can
 * rewrite the request silently or must confirm first. Method is ignored (a fresh
 * request defaults to GET); name/notes/captures are preserved by the rewrite so
 * they don't count.
 */
function _isBlankRequestNode(node) {
  if (!node) return true;
  const has = (s) => String(s ?? "").trim() !== "";
  if (has(node.url)) return false;
  if ((node.params ?? []).some((p) => has(p.name) || has(p.value)))
    return false;
  if ((node.headers ?? []).some((h) => has(h.name) || has(h.value)))
    return false;
  if (node.bodyType && node.bodyType !== "no-body") {
    if (has(node.bodyText)) return false;
    if ((node.bodyFormRows ?? []).length > 0) return false;
    if (has(node.bodyFilePath)) return false;
    if (has(node.bodyGraphql?.query)) return false;
  }
  if (node.authEnabled && node.authType && node.authType !== "none")
    return false;
  return true;
}

/**
 * Build the field set that replaces a request's HTTP definition from a parsed
 * cURL request node. Sets the active fields and clears the inactive body/auth
 * ones so no stale configuration lingers ("delete existing first"). Identity and
 * non-HTTP fields (name, notes, captures) are not touched here — the caller keeps
 * them by overlaying this onto the existing node.
 */
function _curlRequestFields(req) {
  return {
    protocol: "http",
    method: req.method ?? "GET",
    url: req.url ?? "",
    params: req.params ?? [],
    pathParams: [],
    headers: req.headers ?? [],
    bodyType: req.bodyType ?? "no-body",
    bodyText: req.bodyText ?? "",
    bodyFormRows: req.bodyFormRows ?? [],
    bodyFilePath: req.bodyFilePath ?? "",
    bodyGraphql: req.bodyGraphql ?? { query: "", variables: "" },
    authEnabled: req.authEnabled ?? false,
    authType: req.authType ?? "none",
    authBasic: req.authBasic ?? { username: "", password: "" },
    authBearer: req.authBearer ?? { token: "" },
  };
}

/**
 * Resolve and execute a request tree node using the given variable context.
 * Used by the "Run immediately before" refresh mode on request-output functions.
 * Returns { body, headers, status }. On failure returns empty values rather than throwing.
 */
async function _executeRequestNode(node, ctx) {
  const rv = (s) => resolveStringAsync(s, ctx);
  const method = node.method ?? "GET";

  // Resolve URL/params, headers, auth (basic/bearer/apikey/digest/ntlm/aws-iam)
  // and body via the same builder the interactive editor uses. Two prefetch-
  // specific policies differ from the editor and are encoded in the spec below:
  //   • the base URL is NOT percent-encoded (urlBase is the raw resolved value);
  //   • there is no file body (bodyFile: null) — prefetch never uploads a file.
  // OAuth2 stays unsupported here (the builder has no oauth2 transform, and its
  // token acquisition is interactive), matching the previous behaviour.
  const {
    finalUrl,
    headers,
    body,
    bodyFilePath,
    multipart,
    awsIam,
    authDigest,
    authNtlm,
    oauth1,
  } = await buildRequestPayload(
    {
      method,
      // Substitute path params before the (intentionally un-encoded) base URL.
      urlBase: applyPathParams(
        await rv(node.url ?? ""),
        await resolvePathParamValues(node.pathParams, rv),
      ),
      params: node.params,
      headers: node.headers,
      authEnabled: node.authEnabled !== false,
      authType: node.authType,
      authBasic: node.authBasic,
      authBearer: node.authBearer,
      authApiKey: node.authApiKey,
      authDigest: node.authDigest,
      authNtlm: node.authNtlm,
      authAwsIam: node.authAwsIam,
      authOAuth1: node.authOAuth1,
      bodyType: node.bodyType,
      bodyText: node.bodyText,
      bodyFormRows: node.bodyFormRows,
      bodyFile: null,
    },
    rv,
  );

  const nativeDesc = {
    method,
    url: finalUrl,
    headers,
    body,
    bodyFilePath,
    multipart,
    timeout: currentSettings.timeout ?? 30000,
    followRedirects: currentSettings.followRedirects ?? true,
    verifySsl: currentSettings.verifySsl ?? true,
    awsIam,
    authDigest,
    authNtlm,
    oauth1,
    collectionId: currentColls.activeCollectionId ?? null,
    useCookieJar: _collSendCookies(currentColls.activeCollectionId),
    ..._proxyDescriptorFields(currentSettings),
    retry: _retryDescriptor(currentSettings),
  };

  try {
    let result;
    if (window.wurl?.isElectron === true) {
      result = await window.wurl.http.execute(nativeDesc);
    } else {
      const res = await fetch("/api/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nativeDesc),
      });
      if (!res.ok) throw new Error(`Execute API returned HTTP ${res.status}`);
      result = await res.json();
    }

    // Record a timeline entry for genuine HTTP responses (status > 0).
    // Network-level failures (status === 0) are not recorded.
    if (
      result &&
      !(result.error && result.status === 0) &&
      node.id &&
      _maxHistory > 0
    ) {
      const histId = crypto.randomUUID();
      const nowMs = Date.now();
      const reqSnapshot = { method, url: finalUrl, headers, body };
      const resp = {
        request: reqSnapshot,
        status: result.status ?? 0,
        statusText: result.statusText ?? "",
        headers: result.headers ?? {},
        cookies: result.cookies ?? [],
        body: result.body ?? "",
        elapsed: result.elapsed ?? 0,
        size: result.size ?? 0,
        consoleLog: result.consoleLog ?? [],
        encoding: result.encoding ?? "utf8",
        truncated: result.truncated ?? false,
        fullSize: result.fullSize ?? result.size ?? 0,
        bodyRef: result.bodyRef ?? null,
      };
      const reqNode = _buildSnapshot(node);

      if (!_historyLoaded.has(node.id)) {
        await _loadRequestHistory(node.id);
        _historyLoaded.add(node.id);
      }
      const entries = _requestHistory.get(node.id) ?? [];
      entries.unshift({
        id: histId,
        requestNode: reqNode,
        requestUrl: finalUrl,
        response: resp,
        timestamp: nowMs,
      });
      addHistory(
        node.id,
        {
          id: histId,
          timestamp: nowMs,
          status: resp.status,
          statusText: resp.statusText,
          elapsed: resp.elapsed,
          size: resp.size,
          requestUrl: finalUrl,
          requestNode: reqNode,
        },
        {
          headers: resp.headers,
          cookies: resp.cookies,
          body: resp.body,
          consoleLog: resp.consoleLog,
          encoding: resp.encoding,
          truncated: resp.truncated,
          fullSize: resp.fullSize,
        },
      );
      while (entries.length > _maxHistory) {
        const old = entries.pop();
        if (old?.id) deleteHistory(node.id, old.id);
      }
      _requestHistory.set(node.id, entries);
    }

    if (result.error && result.status === 0) {
      return { body: "", headers: {}, status: 0 };
    }
    return {
      body: result.body ?? "",
      headers: result.headers ?? {},
      status: result.status ?? 0,
    };
  } catch {
    return { body: "", headers: {}, status: 0 };
  }
}

/** Count all request nodes recursively in a collection tree. */
function _countRequests(node) {
  if (node.type === "request") return 1;
  return (node.children ?? []).reduce(
    (sum, child) => sum + _countRequests(child),
    0,
  );
}

// Per-format export descriptors: file-name suffix and human label. The Postman
// suffix is the conventional ".postman_collection.json" Postman itself uses.
const EXPORT_FORMATS = {
  postman: { suffix: ".postman_collection.json", label: "Postman v2.1" },
  insomnia: { suffix: ".insomnia.json", label: "Insomnia v4" },
  openapi: { suffix: ".openapi.json", label: "OpenAPI 3" },
  har: { suffix: ".har", label: "HAR 1.2" },
};

/** Save-dialog file-type filters for a format. */
function _exportFilters(format) {
  return format === "har"
    ? [{ name: "HAR", extensions: ["har"] }]
    : [{ name: "JSON", extensions: ["json"] }];
}

/** Filesystem-safe base name from a collection/workspace name. */
function _safeFileBase(name) {
  return (name ?? "collection").replace(/[^a-z0-9_-]/gi, "_");
}

/** Serialize a collection node to the chosen non-HAR interchange format. */
function _serializeCollection(collection, variables, format) {
  switch (format) {
    case "insomnia":
      return exportToInsomnia(collection, variables);
    case "openapi":
      return exportToOpenApi(collection, variables);
    case "postman":
    default:
      return exportToPostman(collection, variables);
  }
}

/**
 * Build a Map of requestId → most-recent run-history entry for every request
 * under `rootNode`. Loads any history not yet in memory. Requests with no run
 * are simply absent from the map (HAR skips them).
 */
async function _gatherHistory(rootNode) {
  const ids = [];
  const collect = (node) => {
    for (const child of node.children ?? []) {
      if (child.type === "collection") collect(child);
      else if (child.type === "request" && child.id) ids.push(child.id);
    }
  };
  collect(rootNode ?? {});

  const map = new Map();
  for (const id of ids) {
    if (!_historyLoaded.has(id)) {
      await _loadRequestHistory(id);
      _historyLoaded.add(id);
    }
    const entries = _requestHistory.get(id);
    if (entries && entries.length) {
      // Pick the newest by timestamp rather than trusting list order.
      const newest = entries.reduce((a, b) =>
        (b.timestamp ?? 0) > (a.timestamp ?? 0) ? b : a,
      );
      map.set(id, newest);
    }
  }
  return map;
}

/** Run the native save dialog for an already-serialized export and notify. */
async function _saveExport(filename, content, format, successMsg) {
  try {
    const saved = await window.wurl.export.file.save(
      filename,
      content,
      _exportFilters(format),
    );
    if (saved) Notifications.success(successMsg);
    return saved;
  } catch (err) {
    Notifications.error(
      t("app.exportFailed", { message: String(err.message ?? err) }),
      { title: t("app.exportTitle") },
    );
    return false;
  }
}

/**
 * Open the format picker for a single collection. The modal calls back into
 * runCollectionExport with the chosen format.
 * @param {object} collection  Wurl collection node
 */
function handleExport(collection) {
  if (!window.wurl?.export?.file?.save) {
    Notifications.info(t("app.exportDesktopOnly"));
    return;
  }
  ExportModal.openCollection(collection, (format) =>
    runCollectionExport(collection, format),
  );
}

/** Serialize a single collection to the chosen format and save it. */
async function runCollectionExport(collection, format) {
  if (!window.wurl?.export?.file?.save) return;

  let variables = [];
  try {
    const data = await loadCollectionData(currentColls.activeCollectionId);
    // Pass the canonical array through so the exporter sees the `secure` flag
    // and can redact secret values rather than emitting them.
    variables = normalizeVariables(data.variables);
  } catch {
    /* non-fatal — export without collection variables */
  }

  const meta = EXPORT_FORMATS[format] ?? EXPORT_FORMATS.postman;
  const filename = `${_safeFileBase(collection.name)}${meta.suffix}`;

  let content;
  let successMsg = `"${collection.name}" exported as ${meta.label}.`;
  if (format === "har") {
    const history = await _gatherHistory(collection);
    content = exportToHar(collection, history);
    if (history.size === 0) {
      successMsg = `"${collection.name}" exported as HAR — no run history yet, so the archive is empty.`;
    }
  } else {
    content = _serializeCollection(collection, variables, format);
  }

  await _saveExport(filename, content, format, successMsg);
}

/**
 * Export every collection in the workspace to one interchange file. Each
 * collection becomes a folder under one synthetic root, so the single-collection
 * exporters handle the workspace unchanged. Collection-level variables are
 * merged by name (first collection wins on a clash).
 */
async function runWorkspaceExport(format) {
  if (!window.wurl?.export?.file?.save) return;

  const children = [];
  const mergedVars = [];
  const seenVar = new Set();

  for (const coll of currentColls.collections ?? []) {
    let data;
    try {
      data = await loadCollectionData(coll.id);
    } catch {
      continue; // skip a collection that fails to load
    }
    // The active collection may hold unsaved edits in the live tree; prefer it.
    const items =
      coll.id === currentColls.activeCollectionId
        ? (treeView?.getItems() ?? data.items ?? [])
        : (data.items ?? []);
    children.push({
      id: coll.id,
      type: "collection",
      name: coll.name ?? "Collection",
      variables: {},
      children: items,
    });
    for (const v of normalizeVariables(data.variables)) {
      if (seenVar.has(v.name)) continue;
      seenVar.add(v.name);
      mergedVars.push(v);
    }
  }

  const root = {
    id: crypto.randomUUID(),
    type: "collection",
    name: "wurl Workspace",
    variables: {},
    children,
  };

  const meta = EXPORT_FORMATS[format] ?? EXPORT_FORMATS.postman;
  const filename = `wurl-workspace${meta.suffix}`;
  const count = children.length;
  const plural = count !== 1 ? "s" : "";

  let content;
  let successMsg = `${count} collection${plural} exported as ${meta.label}.`;
  if (format === "har") {
    const history = await _gatherHistory(root);
    content = exportToHar(root, history);
    if (history.size === 0) {
      successMsg =
        "Workspace exported as HAR — no run history yet, so the archive is empty.";
    }
  } else {
    content = _serializeCollection(root, mergedVars, format);
  }

  await _saveExport(filename, content, format, successMsg);
}

async function handleImport() {
  if (!window.wurl?.import?.file?.open) {
    Notifications.info(t("app.importDesktopOnly"));
    return;
  }

  let file;
  try {
    file = await window.wurl.import.file.open();
  } catch (err) {
    Notifications.error(
      t("app.importFailed", { message: String(err.message ?? err) }),
      { title: t("app.importTitle") },
    );
    return;
  }
  if (!file) return; // user cancelled the file dialog

  let parsed;
  try {
    parsed = parseImport(file.content);
  } catch (err) {
    Notifications.error(
      t("app.importFailed", { message: String(err.message ?? err) }),
      { title: t("app.importTitle") },
    );
    return;
  }

  await applyImportedCollection(parsed);
}

// Import a single request from a pasted cURL command. Parses the text and, on
// success, appends it as a new collection via the same persistence path as a
// file import. Returns true when the import was saved (so CurlImportModal
// closes) and false when it failed (the modal stays open). Malformed input is
// reported via a notification rather than being silently dropped.
async function handleCurlImport(text) {
  let parsed;
  try {
    parsed = parseCurl(text);
  } catch (err) {
    Notifications.error(
      t("app.importFailed", { message: String(err.message ?? err) }),
      { title: t("app.importTitle") },
    );
    return false;
  }

  // A cURL `-F` field references a local file path. Warn only about paths that
  // aren't on disk — an existing file is read at send time, so there's nothing
  // to re-attach. The existence check lives in the main process (the renderer is
  // sandboxed), so it happens here rather than in the synchronous parser.
  const filePaths = collectFormFilePaths(parsed.collection);
  if (filePaths.length) {
    let missing = filePaths;
    try {
      missing =
        (await window.wurl?.import?.file?.checkMissing?.(filePaths)) ??
        filePaths;
    } catch {
      missing = filePaths; // can't verify → warn about all, as before
    }
    warnMissingFormFiles(parsed, missing);
  }

  return applyImportedCollection(parsed);
}

// Append a parsed import — `{ collection, variables, warnings }` from any
// importer — to the active workspace and persist it. Shared by file import
// (`handleImport`) and cURL paste (`handleCurlImport`). Returns true when the
// write succeeded, false otherwise.
async function applyImportedCollection(parsed) {
  const { collection, variables } = parsed;
  const activeId = currentColls.activeCollectionId;
  const newItems = [...(treeView?.getItems() ?? []), collection];

  if (treeView) treeView.setItems(newItems);

  // Persist. saveCollectionData no longer throws on a write failure — it routes
  // the error to the write-error sink (a toast) and returns false — so branch on
  // the result and bail without claiming success rather than catching.
  let saved;
  // Importers return variables already in the canonical array shape, so no
  // conversion is needed here — just guard against a missing list.
  const incoming = variables ?? [];
  if (incoming.length > 0) {
    // Merge import variables with existing ones — existing values take
    // precedence. Both are kept in the canonical array shape; conflicts are
    // resolved by name with the current entry winning. currentRaw comes from
    // disk and may still be a legacy map, so it is normalized before merging.
    const { variables: currentRaw } = await loadCollectionData(activeId);
    const byName = new Map();
    for (const entry of incoming) byName.set(entry.name, entry);
    for (const entry of normalizeVariables(currentRaw))
      byName.set(entry.name, entry);
    const merged = [...byName.values()];
    saved = await saveCollectionData(activeId, newItems, merged);
    if (saved && treeView) treeView.setEnvVariables(varsArrayToMap(merged));
  } else {
    saved = await saveCollectionData(activeId, newItems);
  }
  // The write-error sink already surfaced the failure; don't report success.
  if (!saved) return false;

  const count = _countRequests(collection);
  const base = `"${collection.name}" imported with ${count} request${count !== 1 ? "s" : ""}.`;
  // Importers may report non-fatal issues (e.g. remote $refs that could not be
  // resolved without network access). When present, surface them as a persistent
  // warning the user must dismiss — not buried in a success toast that auto-hides.
  if (parsed.warnings?.length) {
    Notifications.warning(`${base} ${parsed.warnings.join(" ")}`, {
      title: t("app.importedWithWarnings"),
      duration: 0,
    });
  } else {
    Notifications.success(base);
  }
  return true;
}
