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

import { TreeView } from "./components/tree-view.js";
import { RequestEditor } from "./components/request-editor.js";
import { applyCaptures } from "./components/captures.js";
import { extractScriptRunNames } from "./components/script-run-refs.js";
import {
  flattenRequests,
  resolveRequestRef,
  migrateRequestNodeRefs,
} from "./components/request-refs.js";
import { assertionLabel } from "./components/editors/tests-editor.js";
import {
  buildRequestPayload,
  applyPathParams,
  resolvePathParamValues,
  encodeBaseUrl,
} from "./components/request-payload.js";
import { ResponseViewer } from "./components/response-viewer.js";
import { WsConsole } from "./components/ws-console.js";
import { SettingsPopup } from "./components/settings-popup.js";
import { CollectionsPopup } from "./components/collections-popup.js";
import { VarsEditor } from "./components/vars-editor.js";
import { EnvPicker } from "./components/env-picker.js";
import { CollPicker } from "./components/coll-picker.js";
import {
  loadAll,
  saveCollections,
  saveTreeStructure,
  updateRequest,
  setActiveItems,
  setActiveHeaders,
  saveSettings,
  saveManifest,
  loadCollectionData,
  saveCollectionData,
  setActiveCollection,
  saveCollectionHeaders,
  deleteRequest,
  deleteCollection,
  listHistory,
  addHistory,
  getHistoryResponse,
  deleteHistory,
  clearHistory,
  trimHistory,
  loadEnvironments,
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
  effectiveProfileVars,
  resolvedProfileVars,
  applyProfileEdit,
  removeProfileFromFolder,
  MAX_NAMED_PROFILES,
} from "./components/folder-profiles.js";
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
  inspectImport,
  parseCurl,
  collectFormFilePaths,
  warnMissingFormFiles,
} from "./import/index.js";
import { exportToPostman } from "./export/postman.js";
import { exportToInsomnia } from "./export/insomnia.js";
import { exportToOpenApi } from "./export/openapi.js";
import { exportToHar } from "./export/har.js";
import { buildRestHippoArchive } from "./export/resthippo.js";
import {
  detectRestHippo,
  mergeArchiveIntoTree,
  mergeEnvironments,
  mergeVariableList,
  mergeHeaderList,
  mergeProfileList,
} from "./import/resthippo.js";
import { ExportModal } from "./components/export-modal.js";
import { SwaggerImportModal } from "./components/swagger-import-modal.js";
import { PasswordPrompt } from "./components/password-prompt.js";
import { buildCustomThemeCss } from "./utils/theme-css.js";
import { installMenuHandlers } from "./event-bus/menu-handlers.js";
import { installSettingsHandlers } from "./event-bus/settings-handlers.js";
import { installWsHandlers } from "./event-bus/ws-handlers.js";
import { installTimelineHandlers } from "./event-bus/timeline-handlers.js";
import { installZoomHandlers } from "./event-bus/zoom-handlers.js";
import { installUpdaterHandlers } from "./event-bus/updater-handlers.js";
import { installRunFolderHandler } from "./event-bus/run-folder-handlers.js";
import { PopupManager } from "./popup-manager.js";
import { installKeymap, profileShortcutSlot } from "./keymap.js";
import { KeyboardShortcuts } from "./components/keyboard-shortcuts.js";
import { AboutDialog } from "./components/about-dialog.js";
import * as i18n from "./i18n.js";
import { t } from "./i18n.js";

// ─── Renderer crash mirroring ───────────────────────────────────────────────────
// Forward uncaught renderer errors and unhandled promise rejections to the main
// process so they land in the persistent log alongside main-process diagnostics
// (see preload.js → hippo.diagnostics). Registered at module load so the earliest
// failures are caught. Best-effort and silent: a reporting failure must never mask
// the original error, and there is no UI side effect here.
(function installRendererDiagnostics() {
  const report = (info) => {
    try {
      window.hippo?.diagnostics?.reportError?.(info);
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
// Response caches fed into variable context for function pills. Keyed by BOTH
// the request's id (the canonical reference new pills store) and its name (so
// legacy name-based tokens and the name-keyed hippo.run() script API still hit).
// See _cacheResponse() and request-refs.js.
let _responseCache = {};
let _responseHeaders = {};
let _responseStatus = {};

/**
 * Seed the response caches for a request under both its id and its name, so a
 * reference stored either way resolves. `ref` is anything carrying `{id, name}`
 * (a tree node or a resolveRequestRef() result).
 */
function _cacheResponse(ref, body, headers, status) {
  for (const key of [ref?.id, ref?.name]) {
    if (!key) continue;
    _responseCache[key] = body;
    _responseHeaders[key] = headers;
    _responseStatus[key] = status;
  }
}
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
    // Post-response / test configuration — captured so a Timeline restore
    // reinstates the request's tests, scripts, and captures exactly as they
    // were for this run. Without these the snapshot would carry no test
    // definition, so restoring it blanks the editor's Tests/Scripts/Captures
    // tabs (the stored request keeps them, which is why re-selecting the
    // request brings them back). Stored structured — load() consumes them as-is.
    assertions: Array.isArray(node.assertions) ? node.assertions : [],
    captures: Array.isArray(node.captures) ? node.captures : [],
    preRequestScript: node.preRequestScript ?? "",
    afterResponseScript: node.afterResponseScript ?? "",
    preRequestScriptEnabled: node.preRequestScriptEnabled !== false,
    afterResponseScriptEnabled: node.afterResponseScriptEnabled !== false,
    ...(node.scriptSplit != null ? { scriptSplit: node.scriptSplit } : {}),
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
            // Test assertions (Feature 29) — restored so a replayed run shows
            // its Tests tab. Pre-feature entries lack the field → empty.
            testResults: payload?.testResults ?? [],
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

/**
 * Record one history entry for a request. Ensures the request's history is
 * loaded, prepends the in-memory `memEntry`, persists the lightweight `meta` +
 * heavyweight `payload` to storage (fire-and-forget), then purges anything
 * beyond `_maxHistory` from both memory and storage. Returns the in-memory
 * entries list (newest first) so callers can read the new latest entry.
 *
 * Shared by the success / error / stream / direct-execute recording paths so the
 * load → prepend → persist → purge sequence lives in exactly one place.
 *
 * @param {string} nodeId   request node id
 * @param {object} memEntry full in-memory entry ({ id, requestNode, requestUrl, response, timestamp })
 * @param {object} meta     lightweight metadata persisted to the history index
 * @param {object} payload  heavyweight payload persisted to the history blob
 * @returns {Promise<Array>} the in-memory entries list (newest first)
 */
async function _recordHistoryEntry(nodeId, memEntry, meta, payload) {
  // Ensure history is loaded from storage before prepending the new entry, so
  // the in-memory list is complete and purging works correctly.
  if (!_historyLoaded.has(nodeId)) {
    await _loadRequestHistory(nodeId);
    _historyLoaded.add(nodeId);
  }
  const entries = _requestHistory.get(nodeId) ?? [];
  entries.unshift(memEntry);
  // Persist to storage (fire-and-forget).
  addHistory(nodeId, meta, payload);
  // Purge entries beyond the limit from both memory and storage.
  while (entries.length > _maxHistory) {
    const old = entries.pop();
    if (old?.id) deleteHistory(nodeId, old.id);
  }
  _requestHistory.set(nodeId, entries);
  return entries;
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
      window.hippo.ui.contextMenu.edit(e.clientX, e.clientY);
    }
  });

  // Undo / Redo routed from the app Edit menu (main → preload → hippo:edit-action).
  // A focused multi-line code editor (.pce-doc) runs its own snapshot undo/redo
  // and handles this itself; for plain inputs / textareas / other editables, fall
  // back to the browser's native editing command.
  window.addEventListener("hippo:edit-action", (e) => {
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
  const platform = window.hippo?.platform ?? "linux";
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
  installZoomHandlers(buildBusContext());
  installKeyboardShortcuts();
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
  setAttrAll("#btn-about", "title", "header.aboutTitle");
  setAttrAll("#btn-about", "aria-label", "header.aboutTitle");
  setText(".app-subtitle", "header.subtitle");
  setAttrAll(".header-icon-panel", "aria-label", "header.actionsAria");
  setAttrAll("#app-main", "aria-label", "header.mainAria");

  // Collections nav + its selector triggers. The trigger's title (tooltip) is
  // owned by CollPicker#syncTrigger — it shows the active collection name — so
  // only the action aria-label is set here.
  setAttrAll("#panel-nav", "aria-label", "header.collections");
  setText("#panel-nav .panel-title", "header.collectionPanelTitle");
  setAttrAll(
    "#btn-collection, #btn-collection-nav",
    "aria-label",
    "header.collectionsAria",
  );

  // Toolbar triggers (header bar + nav-settings bar share these classes)
  setAttrAll(".env-picker-trigger", "title", "header.environmentTitle");
  setAttrAll(".env-picker-trigger", "aria-label", "header.environmentAria");
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
// Inline variable editor shown in the request panel when a container (collection
// or folder) is selected in the tree; toggled against requestEditor.
let varsEditor;
// The request panel's header title element + its default text, captured at
// startup so it can be restored when switching back from the variable editor.
let _requestPanelTitleEl = null;
let _requestPanelDefaultTitle = "";
// wsConsole is a mutable pointer to whichever WsConsole instance is currently
// visible in the response pane. Starts as the idle placeholder; swaps to a
// per-connection instance when a connection is opened or resumed.
let wsConsole;

function initComponents() {
  treeView = new TreeView();
  requestEditor = new RequestEditor();
  responseViewer = new ResponseViewer();
  // Idle-state placeholder console — shown when a WS request is selected but
  // not yet connected. Per-connection consoles are created in hippo:ws-connect
  // and swapped in via _setResponsePane.
  wsConsole = new WsConsole();

  panelNav.mount(treeView);
  panelRequest.mount(requestEditor);
  panelResponse.mount(responseViewer);
  panelResponse.mount(wsConsole);
  wsConsole.element.style.display = "none";

  // The inline variable editor shares the request panel with the request
  // editor; only one is visible at a time (toggled by tree selection). Its
  // persistence callbacks are the same handlers the collections popup uses.
  varsEditor = new VarsEditor({
    onSave: handleVarsSave,
    onBulkEditorChange: handleVarsBulkEditorChange,
    onProfileAdd: handleProfileAdd,
    onProfileRename: handleProfileRename,
    onProfileSelect: handleProfileSelect,
    onProfileDelete: handleProfileDelete,
  });
  panelRequest.mount(varsEditor);
  varsEditor.element.style.display = "none";
  _requestPanelTitleEl = panelRequest.element.querySelector(".panel-title");
  _requestPanelDefaultTitle = _requestPanelTitleEl?.textContent ?? "";

  // Stream WebSocket status + frames pushed from the main process into the
  // console (and, for lifecycle states, the editor's Connect button).
  if (window.hippo?.ws) {
    window.hippo.ws.onStatus(_onWsStatus);
    window.hippo.ws.onMessage(_onWsMessage);
  }

  // Bridge live HTTP streaming pushes (Feature 33) to global hippo:stream-*
  // events so the ResponseViewer (and any future listener) can consume them
  // the same way as the rest of the request lifecycle. The bridge listens for
  // the app's whole lifetime, so no stream frame is missed before the viewer
  // has switched into live mode.
  if (window.hippo?.http?.stream) {
    window.hippo.http.stream.onData((p) =>
      window.dispatchEvent(new CustomEvent("hippo:stream-data", { detail: p })),
    );
    window.hippo.http.stream.onEnd((p) =>
      window.dispatchEvent(new CustomEvent("hippo:stream-end", { detail: p })),
    );
    window.hippo.http.stream.onError((p) =>
      window.dispatchEvent(
        new CustomEvent("hippo:stream-error", { detail: p }),
      ),
    );
    window.hippo.http.stream.onHint((p) =>
      window.dispatchEvent(new CustomEvent("hippo:stream-hint", { detail: p })),
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
      new CustomEvent("hippo:ws-state", { detail: { state: s } }),
    );
  }
  if (s === "closed" || s === "error") {
    _wsConns.delete(entry.id);
    if (!isForeground) {
      const label = _getRequestLabel(entry.requestId);
      if (s === "error") {
        Notifications.warning(t("app.wsDisconnectedError", { label }));
      } else {
        Notifications.info(t("app.wsClosed", { label }));
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
    await window.hippo?.ws?.close({
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
 *   nav    ≥ 200     request ≥ 200 (1fr, unconstrained here)
 *   res    ≥ 160     rowRes  ≥ 120
 */
const SPLITTER_MIN_NAV = 200;
const SPLITTER_MIN_RES = 100;
const SPLITTER_MIN_ROWRES = 120;
// Minimum panel width that keeps the layout+settings ctrl group fully visible
// when "Remove headers" is active. Neither the Collections button nor the
// environment selector is part of this group — both live in the tree-toolbar —
// so the group is just the layout + settings buttons.
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

/** The floating settings control group, relocated by placeRemoveHeaderControls(). */
let _ctrlGroup = null;

/** The standalone environment selector, relocated by placeRemoveHeaderControls(). */
let _envCtrl = null;

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
  const changed = layout !== _currentLayout;
  _currentLayout = layout;
  getAppMain().dataset.layout = String(layout);
  applyGridVars();
  const mode = getEffectiveSplitterMode();
  _splitter1?.setFlow(mode === "portrait" ? "column" : "row");
  _splitter2?.setFlow(mode === "landscape" ? "row" : "column");
  placeRemoveHeaderControls(layout, currentSettings.removeHeaders ?? false);
  // Broadcast so panels that adapt their own internal splits to the layout can
  // react (e.g. RequestEditor flips the GraphQL Query/Variables split). Only
  // when the layout number actually changed: applySettings calls applyLayout on
  // every invocation (each font-zoom step, every theme preview), and
  // re-broadcasting an unchanged layout needlessly re-runs those listeners. The
  // only listener (GraphQL editor) reads the layout directly on mount, so a
  // skipped startup broadcast (default layout == the initial _currentLayout) is
  // harmless.
  if (changed) {
    window.dispatchEvent(
      new CustomEvent("hippo:layout-changed", { detail: { layout } }),
    );
  }
}

/**
 * Build the detached settings control group element. The environment selector
 * is intentionally NOT part of this group: in "Remove headers" mode it is
 * placed independently in the tree-toolbar for every layout (see buildEnvCtrl /
 * placeRemoveHeaderControls), while this group follows the layout into the
 * response status bar / request tab strip / tree-toolbar.
 */
function buildCtrlGroup() {
  const group = document.createElement("div");
  group.className = "header-ctrl-group";
  group.innerHTML = `
    <span class="ctrl-divider" aria-hidden="true"></span>
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
 * Build the standalone environment selector. It is the primary env trigger and
 * is positioned by placeRemoveHeaderControls into the tree-toolbar's trailing
 * cluster. Unlike the settings ctrl-group it is never bundled with it.
 */
function buildEnvCtrl() {
  const btn = document.createElement("button");
  btn.className = "env-picker-trigger";
  btn.id = "btn-env-picker-ctrl";
  btn.title = t("header.environmentTitle");
  btn.setAttribute("aria-label", t("header.environmentAria"));
  btn.setAttribute("aria-haspopup", "menu");
  return btn;
}

/**
 * Arrange the relocatable chrome (environment selector, Collections selector,
 * and settings ctrl-group) for the active layout and the "Remove headers"
 * setting.
 *
 * The collection + environment selectors always live in the tree-toolbar's
 * right-aligned trailing cluster: [Collections] [Environment]. The Collections
 * button carries the margin-left:auto that pushes the whole cluster to the
 * trailing edge (see layout.css), and the leading [+ collection] [+ request]
 * buttons stay at the left. (The nav panel-header is left empty and hidden — see
 * panels.css.)
 *
 * The settings ctrl-group only relocates in Remove-headers mode, where the
 * static app-header that normally holds it is hidden; it then follows the
 * layout:
 *   Side by side          (1) → response status bar
 *   Left/Top + stacked  (2,3) → request URL bar, at the far right after the Send
 *                               group, with its leading divider acting as a
 *                               separator between Send and the settings icon.
 *   All stacked           (4) → the tree-toolbar, right after the env selector,
 *                               extending the cluster to
 *                               [Collections][Environment][settings].
 * The ctrl-group's own divider shows in the status bar (1) and URL bar (2,3) but
 * stays hidden inside the tree-toolbar (4), so All stacked reads as one cluster.
 */
function placeRemoveHeaderControls(layout, removeHeaders) {
  const collBtn = document.getElementById("btn-collection");
  const toolbar = document.querySelector(".tree-toolbar");

  // Detach everything we own so each call rebuilds the arrangement cleanly.
  _ctrlGroup?.remove();
  _envCtrl?.remove();

  // Trailing cluster (left → right): Collections, Environment. The Collections
  // button's margin-left:auto pushes the cluster to the trailing edge.
  if (toolbar) {
    if (collBtn) toolbar.appendChild(collBtn);
    if (_envCtrl) toolbar.appendChild(_envCtrl);
  }

  // The settings ctrl-group only moves when the app-header is hidden;
  // otherwise it stays put in the static app-header.
  if (!removeHeaders) return;

  // The settings ctrl-group follows the active layout.
  let groupTarget;
  if (layout === 1) groupTarget = document.querySelector(".res-status-bar");
  else if (layout === 2 || layout === 3)
    groupTarget = document.querySelector(".req-url-bar");
  else groupTarget = toolbar; // All stacked → after the env selector
  groupTarget?.appendChild(_ctrlGroup);
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
// CollectionsPopup is a parent-owned popup that reports back to app.js via
// constructor callbacks (see the "Component ↔ app communication" rule in
// CLAUDE.md). Its callbacks close over collection / environment handlers defined
// inside initEventBus(), so it is constructed there — declared here only so
// initHeader() and applySettings() can reach it.
let collPopup;
const envPicker = new EnvPicker({
  // Selecting an entry in the picker menu activates it (id null = Global).
  // (The "Manage…" item was removed; ⌘/Ctrl+E still opens the editor.)
  onActivate: (id) => handleEnvActivate({ id }),
});
// Open the collections editor — collPopup / collPopupState are defined further
// down but only read when this fires. Shared by the collection picker's
// "Manage…" action and the keyboard shortcuts. `tab` selects which right-pane
// tab to focus ("env" | "headers" | "cookies").
function openCollectionsEditor(tab = "env") {
  collPopup.open({ ...collPopupState(), tab });
}
// Collection selector — the mirror of envPicker.
const collPicker = new CollPicker({
  onManage: openCollectionsEditor,
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
  // The active collection's environments (Global + named) for the Environment tab.
  environments: currentEnvironments,
  bulkEditor: currentSettings.varsBulkEditor ?? true,
  // Context for the Headers tab's value pills to validate {{var}} tokens.
  variableContext: _buildVariableContextForNode(null),
});

function initHeader() {
  // Brand mark (top-left) opens the in-app About dialog. (When another popup is
  // up the click-capturing mask covers the header, so no gate is needed here; the
  // Help ▸ About menu path is gated in installKeyboardShortcuts.)
  document
    .getElementById("btn-about")
    ?.addEventListener("click", () => AboutDialog.open());

  document.getElementById("btn-settings").addEventListener("click", () => {
    settingsPopup.open(currentSettings);
  });

  // Secondary settings button inside the nav panel — shown when app-header is hidden
  document.getElementById("btn-settings-nav").addEventListener("click", () => {
    settingsPopup.open(currentSettings);
  });

  // Collection selector triggers (panel header + nav-settings bar) — bound to
  // collPicker, which renders the icon + active collection name and routes
  // clicks to onManage (open CollectionsPopup).
  collPicker.bindTrigger(document.getElementById("btn-collection"));
  collPicker.bindTrigger(document.getElementById("btn-collection-nav"));

  // Environment picker — the standalone selector (_envCtrl, bound below) is the
  // primary one; placeRemoveHeaderControls puts it in the tree-toolbar's
  // trailing cluster. The legacy nav-settings-bar copy is never shown but stays
  // bound for safety.
  envPicker.bindTrigger(document.getElementById("btn-env-picker-nav"));

  // Floating settings ctrl-group — injected into the layout-appropriate
  // container when "Remove headers" is active, replacing the fixed nav-settings-bar.
  _ctrlGroup = buildCtrlGroup();
  _ctrlGroup
    .querySelector("#btn-settings-ctrl")
    .addEventListener("click", () => settingsPopup.open(currentSettings));

  // The environment selector is placed independently of the ctrl-group (it
  // always lives in the tree-toolbar's trailing cluster — see
  // placeRemoveHeaderControls).
  _envCtrl = buildEnvCtrl();
  envPicker.bindTrigger(_envCtrl);
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
  if (/invalid character|not allowed in an http header/i.test(msg))
    return "A header value contains a character HTTP doesn't allow (a line break, a control character, or a smart-quote / em-dash / emoji). Edit the named header's value.";
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
      new CustomEvent("hippo:request-error", {
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
      new CustomEvent("hippo:response-received", {
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
    getRequestEditor: () => requestEditor,
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
    runFolder: _runFolder,
    getLiveRequestIds: _getLiveRequestIds,
    viewTimelineResponse: _viewTimelineResponse,
    deleteHistory,
    clearHistory,
    trimHistory,
    // App-level command handlers (import / export).
    handleImportBrowse,
    handleFilePathImport,
    handleCurlImport,
    handleUrlImport,
    handleExport,
    runWorkspaceExport,
  };
}

function initEventBus() {
  // ── hippo:* global event registry ───────────────────────────────────────────
  // The renderer's app-wide channel. Only state changes / notifications with
  // MULTIPLE or open-ended listeners live here; parent-owned widgets (pickers,
  // modals, the editor popups) report to their creator via constructor callbacks
  // instead — see "Component ↔ App Communication" in CLAUDE.md. Keep this current.
  //
  // Tree / collections          (TreeView → app.js)
  //   request-selected      node                          row selected in tree
  //   container-selected    { nodeId, name, variables }   collection/folder selected → show its variable editor
  //   request-open          { collectionId, requestId }   open from favorites/recents
  //   request-execute       node                          run a request from the tree
  //   favorite-toggle       { node, favorited }
  //   requests-deleted      { ids: string[] }
  //   request-cleared       —                             last request removed
  //   collections-changed   items[]                       tree mutated → persist
  //   export-collection     { collection }
  //   run-folder            { folderId }                   run every request in a folder, tally tests
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
  // Request scripting (Feature 25)
  //   script-result         { phase, writes, error, logs }   pre-script outcome (RequestEditor → app.js): persist writes + surface error
  //   script-console        { requestId, lines }             after-response script console output (app.js → ResponseViewer): append to the Console pane
  //
  // Test assertions (Feature 29)
  //   test-results          { requestId, results, summary }  after-response assertions (app.js → ResponseViewer): fill the Tests tab + status badge
  //
  // Response captures
  //   captures-applied      { count, requestId }             app.js → ResponseViewer: response-capture rules wrote N variables → refresh
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
  //   profile-select        { profileId }                 RequestEditor profile switcher → app.js: activate that profile (null = Default)
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
  // Menu / backup / import / export        (payload-less triggers)
  //   backup-export-requested · backup-import-requested   (File menu → preload → app.js)
  //   import-curl-requested                               (tree [+] menu → renderer)
  //   import-url-requested · export-all-requested         (Collections dialog buttons → renderer)
  //
  // Keyboard shortcuts / menu commands  (preload → app.js; Feature 47)
  //   new-request  ·  new-collection  ·  new-ws-request  ·  open-settings  ·
  //   keyboard-shortcuts  ·  cycle-layout  ·  show-about
  //                                  — payload-less; menu accelerator or click
  //   edit-action           { action: "undo" | "redo" }     Edit-menu undo/redo → focused editable
  //
  // UI coordination             (broadcast; PopupManager / pickers)
  //   popup-opened          —
  //   popup-closed          —
  //
  // Auto-update (Feature 36)    (main updater → preload → app.js / Settings)
  //   updater-checking      { manual }
  //   updater-available     { version, manual }            found → downloading in background
  //   updater-not-available { manual, reason? }            only toasted on a manual check
  //   updater-downloaded    { version }                    ready → "Restart to install"
  //   updater-error         { message, manual }            only toasted on a manual check
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
    // The Environment tab edits the active collection's environments; these route
    // to the same handlers that own currentEnvironments + per-collection persist.
    onEnvActivate: handleEnvActivate,
    onEnvironmentsChanged: handleEnvironmentsChanged,
    onEnvVarsSave: handleEnvVarsSave,
    onHeadersSave: handleCollHeadersSave,
    onBulkEditorChange: handleVarsBulkEditorChange,
    // Export-all routes through the same hippo:export-all-requested handler the
    // File ▸ "Export All Collections…" menu item fires, so the popup button and
    // the menu share one implementation (ExportModal → runWorkspaceExport).
    onExportAll: () =>
      window.dispatchEvent(new CustomEvent("hippo:export-all-requested")),
    // Import routes through the same hippo:import-url-requested handler the
    // File ▸ "Import from URL…" menu item fires, so the popup button and the
    // menu share one implementation (the URL-or-file import modal).
    onImport: () =>
      window.dispatchEvent(new CustomEvent("hippo:import-url-requested")),
    // Per-collection export: activate the target collection first (the export
    // engine reads the *active* collection's variables / headers / environments
    // and live tree), then open the same ExportModal the tree-view collection
    // menu uses. Switching to the collection matches the popup's model, where
    // picking a row already makes it active.
    onExportCollection: async ({ id }) => {
      if (id !== currentColls.activeCollectionId) {
        await handleCollSelect({ id });
      }
      const coll = currentColls.collections.find((c) => c.id === id);
      handleExport({
        id,
        type: "collection",
        name: coll?.name ?? "",
        variables: {},
        children: treeView?.getItems() ?? [],
      });
    },
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
  installContainerSelectionHandler();
  installResponseHandlers();
  installStreamHandlers();
  installTreeQuickAccessHandlers();
  installRequestEditSendHandlers();
  installProfileSelectHandler();

  // Self-contained groups extracted to their own modules (ctx-driven).
  installRunFolderHandler(ctx);
  installUpdaterHandlers();
}

// A profile chosen in the request editor's switcher activates it — the same path
// as the vars-editor selector and the ⌥⌘0–9 shortcuts (all funnel through
// handleProfileSelect, which persists + re-resolves live).
function installProfileSelectHandler() {
  window.addEventListener("hippo:profile-select", (e) => {
    handleProfileSelect({ profileId: e.detail?.profileId ?? null });
  });
}

// When a request is selected in the tree, load it into the editor.
function installSelectionHandlers() {
  window.addEventListener("hippo:request-selected", async (e) => {
    const node = e.detail;
    const prevNodeId = _selectedNode?.id;
    _selectedNode = node;
    // A request takes over the center panel from the container variable editor.
    _showRequestEditor();
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
        new CustomEvent("hippo:ws-state", {
          detail: { state: resumeConn.state ?? "idle" },
        }),
      );
    } else {
      _setResponsePane(isWs);
      if (isWs) {
        wsConsole.reset();
        window.dispatchEvent(
          new CustomEvent("hippo:ws-state", { detail: { state: "idle" } }),
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
      // Guard against a second selection arriving while we were loading: only
      // the request we actually settled on should populate the (name-keyed)
      // response cache — otherwise a slow load for the previously-selected
      // request overwrites the cache for the one now showing (a desync when two
      // requests share a name).
      const loadedEntries = _requestHistory.get(id) ?? [];
      const loadedLatest = loadedEntries[0];
      if (_selectedNode?.id === id) {
        _cacheResponse(
          node,
          loadedLatest?.response?.body ?? "",
          loadedLatest?.response?.headers ?? {},
          loadedLatest?.response?.status ?? 0,
        );
        _refreshEditorVariableContext(id);
        _dispatchTimelineUpdate(id, true);
      }
    }
  });

  // Double-click-to-execute: load the request then click the send button
  window.addEventListener("hippo:request-execute", (e) => {
    if (!requestEditor) return;
    const node = e.detail;
    _selectedNode = node;
    _showRequestEditor();
    _refreshEditorVariableContext(node.id);
    requestEditor.load(node);
    requestEditor.element.querySelector(".req-send-btn")?.click();
  });
}

/**
 * Swap the center request panel to the inline variable editor for a selected
 * container (collection / folder), and set the panel title to its scope. A
 * top-level collection edits its Global environment (the collection-wide tier —
 * collection-level variables were removed); a nested folder edits its own
 * variables on the tree node. handleVarsSave routes the save by scope.
 */
function installContainerSelectionHandler() {
  window.addEventListener("hippo:container-selected", (e) => {
    const { nodeId, name } = e.detail;
    const isColl = currentColls.collections.some((c) => c.id === nodeId);
    if (isColl) {
      // Top-level collection → edits its Global environment. No profiles here
      // (the Environment picker is the collection-level value switcher).
      _varsScope = null;
      varsEditor.load({
        scopeId: nodeId,
        scopeName: name,
        variables: currentEnvironments.globalVariables ?? [],
        bulkEditor: currentSettings.varsBulkEditor ?? true,
        profilesEnabled: false,
      });
    } else {
      // Nested folder → profile-aware editor. Remember the scope so profile
      // add/select/delete can reload the same folder.
      _varsScope = { nodeId, name };
      _loadFolderVars(nodeId, name);
    }
    _showVarsEditor(name);
  });
}

// ── Folder-variable profiles ────────────────────────────────────────────────
// Profiles are collection-wide named alternates for FOLDER variables. Their
// names + the active selection live on the collection metadata; each folder's
// per-profile value overrides live on its tree node (`node.profileValues`). See
// components/folder-profiles.js for the (pure) model. `_varsScope` tracks the
// folder currently shown in the vars editor so the profile controls can reload
// it after a profile change.

/** The folder node currently shown in the vars editor, or null. */
let _varsScope = null;

/** The active collection's metadata entry (holds its profile list + selection). */
function _activeCollEntry() {
  return (
    currentColls.collections.find(
      (c) => c.id === currentColls.activeCollectionId,
    ) ?? null
  );
}

/** Named profiles [{id,name}] for the active collection (Default is implicit). */
function _activeProfiles() {
  return _activeCollEntry()?.variableProfiles ?? [];
}

/** The active profile id for the collection, or null (= Default). */
function _activeProfileId() {
  return _activeCollEntry()?.activeVariableProfileId ?? null;
}

/**
 * Push the active collection's profile list + selection to the request editor so
 * its profile switcher (the "swap" menu by the URL preview / Send button) shows
 * the right entries, checks the active one, and hides when no named profiles exist.
 */
function _pushProfilesToEditor() {
  requestEditor?.setProfiles({
    profiles: _activeProfiles(),
    activeProfileId: _activeProfileId(),
  });
}

/** Show a folder in the vars editor under the collection's active profile. */
function _loadFolderVars(nodeId, name) {
  const node = _findNodeById(treeView?.getItems() ?? [], nodeId);
  const activeProfileId = _activeProfileId();
  varsEditor.load({
    scopeId: nodeId,
    scopeName: name,
    variables: effectiveProfileVars(
      node?.variables ?? [],
      node?.profileValues,
      activeProfileId,
    ),
    bulkEditor: currentSettings.varsBulkEditor ?? true,
    profilesEnabled: true,
    profiles: _activeProfiles(),
    activeProfileId,
  });
}

/** Patch the active collection's profile metadata and persist the manifest. */
async function _updateActiveCollProfiles(patch) {
  const id = currentColls.activeCollectionId;
  const collections = currentColls.collections.map((c) =>
    c.id === id ? { ...c, ...patch } : c,
  );
  currentColls = { ...currentColls, collections };
  await saveManifest({ collections, activeCollectionId: id });
}

/** Remove a deleted profile's overrides from every folder in a tree (recursive). */
function _pruneProfileFromTree(items, profileId) {
  return (items ?? []).map((n) => {
    if (n?.type !== "collection") return n;
    const next = { ...n };
    if (n.profileValues) {
      next.profileValues = removeProfileFromFolder(n.profileValues, profileId);
    }
    if (Array.isArray(n.children)) {
      next.children = _pruneProfileFromTree(n.children, profileId);
    }
    return next;
  });
}

/**
 * [+] popup committed a new profile name. The new profile is created and made
 * ACTIVE: it clones the Default's variable names with cleared values (an unset
 * profile value renders blank — see effectiveProfileVars), so the editor shows
 * the Default's names ready for the user to fill in this profile's values.
 */
async function handleProfileAdd({ name }) {
  const trimmed = (name ?? "").trim();
  if (!trimmed || !_activeCollEntry()) return;
  const profiles = _activeProfiles();
  // Cap named profiles at MAX_NAMED_PROFILES so the set maps onto ⌥⌘1–9. The
  // editor's [+] is already disabled at the limit; this guards other paths.
  if (profiles.length >= MAX_NAMED_PROFILES) {
    Notifications.warning(t("profiles.limit", { max: MAX_NAMED_PROFILES }));
    return;
  }
  if (profiles.some((p) => p.name.toLowerCase() === trimmed.toLowerCase())) {
    Notifications.warning(t("profiles.duplicate", { name: trimmed }));
    return;
  }
  const id = crypto.randomUUID();
  const variableProfiles = [...profiles, { id, name: trimmed }];
  await _updateActiveCollProfiles({
    variableProfiles,
    activeVariableProfileId: id,
  });
  if (_varsScope) _loadFolderVars(_varsScope.nodeId, _varsScope.name);
  _refreshEditorVariableContext(
    currentSettings.selectedRequestIds?.[currentColls.activeCollectionId],
  );
}

/**
 * Rename an existing named profile. Names span the whole collection and are keyed
 * to the profile id (folder `profileValues` are id-keyed, so a rename touches only
 * the collection's profile list). The Default profile has no id and can't be
 * renamed; a blank or duplicate name is rejected.
 */
async function handleProfileRename({ profileId, name }) {
  const trimmed = (name ?? "").trim();
  if (!profileId || !trimmed || !_activeCollEntry()) return;
  const profiles = _activeProfiles();
  const current = profiles.find((p) => p.id === profileId);
  if (!current || current.name === trimmed) return;
  if (
    profiles.some(
      (p) =>
        p.id !== profileId && p.name.toLowerCase() === trimmed.toLowerCase(),
    )
  ) {
    Notifications.warning(t("profiles.duplicate", { name: trimmed }));
    return;
  }
  const variableProfiles = profiles.map((p) =>
    p.id === profileId ? { ...p, name: trimmed } : p,
  );
  await _updateActiveCollProfiles({ variableProfiles });
  if (_varsScope) _loadFolderVars(_varsScope.nodeId, _varsScope.name);
  // A rename doesn't change values (so no variable-context refresh), but the
  // request editor's profile menu shows the name — refresh its list.
  _pushProfilesToEditor();
}

/** Profile selector changed (null = Default). Live at send time → re-resolve. */
async function handleProfileSelect({ profileId }) {
  if (!_activeCollEntry()) return;
  await _updateActiveCollProfiles({
    activeVariableProfileId: profileId || null,
  });
  if (_varsScope) _loadFolderVars(_varsScope.nodeId, _varsScope.name);
  _refreshEditorVariableContext(
    currentSettings.selectedRequestIds?.[currentColls.activeCollectionId],
  );
}

/**
 * Switch the active collection's variable profile by keyboard SLOT (⌥⌘0–9):
 * slot 0 = the Default profile, 1–9 = the Nth named profile. Two cases are silent
 * no-ops: a slot with no matching profile (e.g. ⌥⌘7 with only three profiles), and
 * a target that is ALREADY active. Only a real switch persists and shows a toast —
 * the shortcut may fire with no folder open in the vars editor, so the change is
 * otherwise invisible.
 */
function selectProfileBySlot(slot) {
  if (!_activeCollEntry()) return;
  let target = null; // null = Default
  if (slot > 0) {
    target = _activeProfiles()[slot - 1];
    if (!target) return; // no profile in that slot
  }
  const targetId = target?.id ?? null;
  if (_activeProfileId() === targetId) return; // already active — do nothing
  handleProfileSelect({ profileId: targetId });
  Notifications.info(
    t("profiles.switched", {
      name: target ? target.name : t("profiles.default"),
    }),
  );
}

/** Delete the active named profile: drop it collection-wide + prune folders. */
async function handleProfileDelete({ profileId }) {
  const entry = _activeCollEntry();
  if (!entry || !profileId) return;
  const variableProfiles = _activeProfiles().filter((p) => p.id !== profileId);
  const activeVariableProfileId =
    entry.activeVariableProfileId === profileId
      ? null
      : (entry.activeVariableProfileId ?? null);
  await _updateActiveCollProfiles({
    variableProfiles,
    activeVariableProfileId,
  });
  if (treeView) {
    const items = _pruneProfileFromTree(treeView.getItems(), profileId);
    treeView.setItems(items);
    await saveCollections(items);
  }
  if (_varsScope) _loadFolderVars(_varsScope.nodeId, _varsScope.name);
  _refreshEditorVariableContext(
    currentSettings.selectedRequestIds?.[currentColls.activeCollectionId],
  );
}

/** Show the inline variable editor (hide the request editor); set panel title. */
function _showVarsEditor(scopeName) {
  if (requestEditor) requestEditor.element.style.display = "none";
  varsEditor.element.style.display = "";
  if (_requestPanelTitleEl)
    _requestPanelTitleEl.textContent = t("variables.titleScope", {
      scope: scopeName,
    });
}

/**
 * Show the request editor (hide + flush the variable editor); restore the panel
 * title. Idempotent — safe to call when the request editor is already showing.
 */
function _showRequestEditor() {
  if (!varsEditor) return;
  varsEditor.flush();
  varsEditor.element.style.display = "none";
  if (requestEditor) requestEditor.element.style.display = "";
  if (_requestPanelTitleEl)
    _requestPanelTitleEl.textContent = _requestPanelDefaultTitle;
}

/** Compact { total, passed, failed } from a test-result array, or null if empty. */
function _testSummary(testResults) {
  return testResults?.length
    ? {
        total: testResults.length,
        passed: testResults.filter((t) => t.passed).length,
        failed: testResults.filter((t) => !t.passed).length,
      }
    : null;
}

/**
 * Record a successful HTTP run into a request's per-request history, exactly as
 * an interactive send does: it persists the full response (incl. test results),
 * a compact metadata entry (with a test summary for the Timeline badge), updates
 * the response cache so response()/responseHeader() pills resolve, refreshes the
 * editor's pill context, and repaints the Timeline when this request is selected.
 * Shared by the interactive response handler and the folder runner so the two
 * can't drift. No-op when history is disabled. Returns the new entry list.
 *
 * @param {object} node          tree node the run belongs to
 * @param {object} detail        response detail (request/status/headers/body/…)
 * @param {Array}  testResults   [{name,passed,message}] from the after-response sandbox
 */
async function _recordRunHistory(node, detail, testResults = []) {
  if (_maxHistory <= 0 || !node?.id) return null;
  const histId = crypto.randomUUID();
  const nowMs = Date.now();
  const reqUrl = detail.request?.url ?? "";
  const reqNode = _buildSnapshot(node);
  const testSummary = _testSummary(testResults);
  const resp = {
    request: detail.request ?? {},
    status: detail.status ?? 0,
    statusText: detail.statusText ?? "",
    headers: detail.headers ?? {},
    cookies: detail.cookies ?? [],
    body: detail.body ?? "",
    elapsed: detail.elapsed ?? 0,
    size: detail.size ?? 0,
    consoleLog: detail.consoleLog ?? [],
    encoding: detail.encoding ?? "utf8",
    // bodyRef is a session-scoped handle to the full body cached in main; it is
    // deliberately NOT persisted. truncated/fullSize ARE, so a reloaded entry
    // still shows the "response was truncated" banner.
    truncated: detail.truncated ?? false,
    fullSize: detail.fullSize ?? detail.size ?? 0,
    bodyRef: detail.bodyRef ?? null,
    // Kept on the in-memory entry so a Timeline replay re-renders the Tests tab.
    testResults,
  };
  const entries = await _recordHistoryEntry(
    node.id,
    {
      id: histId,
      requestNode: reqNode,
      requestUrl: reqUrl,
      response: resp,
      timestamp: nowMs,
    },
    {
      id: histId,
      timestamp: nowMs,
      status: resp.status,
      statusText: resp.statusText,
      elapsed: resp.elapsed,
      size: resp.size,
      requestUrl: reqUrl,
      requestNode: reqNode,
      testSummary,
    },
    {
      headers: resp.headers,
      cookies: resp.cookies,
      body: resp.body,
      consoleLog: resp.consoleLog,
      encoding: resp.encoding,
      truncated: resp.truncated,
      fullSize: resp.fullSize,
      testResults: resp.testResults,
    },
  );
  const latest = entries[0];
  _cacheResponse(
    node,
    latest?.response?.body ?? "",
    latest?.response?.headers ?? {},
    latest?.response?.status ?? 0,
  );
  // Refresh pill context for whichever request is loaded in the editor — a
  // background response may make its response() pills resolvable.
  _refreshEditorVariableContext(_selectedNode?.id);
  // Only repaint the timeline pane when it is showing this request.
  if (node.id === _selectedNode?.id) _dispatchTimelineUpdate(node.id);
  return entries;
}

/**
 * Record a network-level failure (ENOTFOUND, ETIMEDOUT, refused, …) into a
 * request's history — the failure counterpart to _recordRunHistory, matching the
 * interactive request-error path. No-op when history is disabled.
 *
 * @param {object} node    tree node the run belongs to
 * @param {object} detail  error detail { request, name, message, hint, elapsed, consoleLog }
 */
async function _recordRunError(node, detail) {
  if (_maxHistory <= 0 || !node?.id) return null;
  const histId = crypto.randomUUID();
  const nowMs = Date.now();
  const reqUrl = detail.request?.url ?? "";
  const reqNode = _buildSnapshot(node);
  const resp = {
    request: detail.request ?? {},
    error: {
      name: detail.name ?? "Error",
      message: detail.message ?? "",
      hint: detail.hint ?? "",
    },
    status: 0,
    statusText: detail.name ?? "Error",
    headers: {},
    cookies: [],
    body: "",
    elapsed: detail.elapsed ?? 0,
    size: 0,
    consoleLog: detail.consoleLog ?? [],
  };
  const entries = await _recordHistoryEntry(
    node.id,
    {
      id: histId,
      requestNode: reqNode,
      requestUrl: reqUrl,
      response: resp,
      timestamp: nowMs,
    },
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
  const latest = entries[0];
  _cacheResponse(
    node,
    latest?.response?.body ?? "",
    latest?.response?.headers ?? {},
    latest?.response?.status ?? 0,
  );
  if (node.id === _selectedNode?.id) _dispatchTimelineUpdate(node.id);
  return entries;
}

// Cache response data so function pills like response() / responseHeader() can
// resolve; record real (non-replay) runs and failures into per-request history.
function installResponseHandlers() {
  window.addEventListener("hippo:response-received", async (e) => {
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
    // Timeline record when the stream ends (see hippo:stream-end/-error below).
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

    // Test assertions (Feature 29). Run the after-response sandbox — scripted
    // hippo.test() AND the no-code grid, a SINGLE execution path — on genuine
    // sends only, BEFORE building the history entry so the results persist with
    // the run. All gating (Scripts/Tests settings, per-pane enable, empty rows)
    // lives inside the helper, which returns `{name, passed, message}[]`.
    let testResults = [];
    if (!skipHistory) {
      testResults = await _runAfterResponseScript(node, e.detail);
    }
    const testSummary = _testSummary(testResults);
    // Push the results to the response viewer (Tests tab + status badge). The
    // viewer rendered the response off the same hippo:response-received event a
    // moment ago with no tests; this fills them in once the sandbox returns.
    if (testResults.length && node?.id) {
      window.dispatchEvent(
        new CustomEvent("hippo:test-results", {
          detail: {
            requestId: node.id,
            results: testResults,
            summary: testSummary,
          },
        }),
      );
    }

    // Record in per-request history only for real (non-replay) executions.
    // When replaying a historical entry, do NOT push to history and do NOT
    // re-render the timeline (which would clear the user's current selection).
    // The shared helper also updates the response cache + editor pill context
    // and repaints the Timeline when this request is selected.
    if (!skipHistory) {
      await _recordRunHistory(node, e.detail, testResults);
    }

    // Post-response captures (Feature 03). Run on genuine sends only (never on a
    // history replay), independent of whether history recording is enabled. The
    // per-rule status gate and empty-rules short-circuit live inside
    // _applyCapturesForNode / applyCaptures.
    if (
      !skipHistory &&
      node?.captures?.length &&
      currentSettings.showCapturesTab
    ) {
      await _applyCapturesForNode(node, e.detail);
    }
  });

  // Pre-request script result (Feature 25). The editor runs the pre-request
  // script during send (it owns variable resolution), then dispatches the
  // outcome here so its variable writes persist through the same shared path as
  // captures / the after-response script, and any error surfaces centrally.
  window.addEventListener("hippo:script-result", async (e) => {
    surfaceScriptResult(e.detail);
    const writes = e.detail?.writes;
    if (Array.isArray(writes) && writes.length)
      await persistVariableWrites(writes);
  });

  // Record network-level failures (ENOTFOUND, ETIMEDOUT, etc.) in the timeline.
  // Cancellations and "no URL" guards are excluded — only genuine request attempts
  // that reached the network layer are recorded.
  window.addEventListener("hippo:request-error", async (e) => {
    const skipHistory = _skipNextHistory;
    _skipNextHistory = false;

    if (skipHistory) return;
    if (e.detail?.name === "AbortError") return;
    // Pre-send failures that never reached the network (e.g. the no-URL
    // guard) carry an empty request URL and are not recorded.
    if (!e.detail?.request?.url) return;

    const node = e.detail.requestNode ?? _selectedNode;
    if (!node?.id || _maxHistory <= 0) return;

    // Store the snapshot (bulk-string) format, matching the success path. The
    // timeline-restore handler replays it via loadSnapshot() and the timeline
    // detail panel reads params/headers as bulk text, both of which need strings.
    await _recordRunError(node, e.detail);
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

    await _recordHistoryEntry(
      node.id,
      {
        id: histId,
        requestNode: reqNode,
        requestUrl: pending.requestUrl,
        response: resp,
        timestamp: sentAt,
      },
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
    // Repaint the timeline only when it is showing this request (a background
    // stream must not steal the pane from whatever the user is now viewing).
    if (node.id === _selectedNode?.id) _dispatchTimelineUpdate(node.id);
  }

  window.addEventListener("hippo:stream-end", (e) =>
    _recordStreamRun(e.detail, { errored: false }),
  );
  window.addEventListener("hippo:stream-error", (e) =>
    _recordStreamRun(e.detail, { errored: true }),
  );
}

// Tree mutations, request deletion, favorites/recents, opening a request from
// the quick-access lists, the cleared-editor reset, and timeline restore.
function installTreeQuickAccessHandlers() {
  // Auto-save whenever the tree is mutated (add / remove collection or request)
  window.addEventListener("hippo:collections-changed", (e) => {
    saveCollections(e.detail);
    // Keep favorites / recents for the active collection in sync with renames,
    // method changes, and any deletions reflected in the new tree.
    reconcileQuickAccess(e.detail);
  });

  // Delete the backing request file(s) when a node is removed from the tree.
  // Fired by tree-view after #deleteNode; ids contains every request under the
  // deleted node (a single request, or all requests in a deleted folder/collection).
  window.addEventListener("hippo:requests-deleted", (e) => {
    for (const id of e.detail.ids) {
      deleteRequest(id);
      _requestHistory.delete(id);
      _historyLoaded.delete(id);
      // Drop any debounced edit for this request — the timer reads the map at
      // fire time, so a stale patch would otherwise trigger a doomed
      // updateRequest() and a spurious full-save fallback after the delete.
      _pendingRequestPatches.delete(id);
    }
    // Drop the deleted requests from favorites / recents so they don't dangle.
    pruneQuickAccess(new Set(e.detail.ids));
  });

  // Toggle a request's favorite state (from the tree context menu or the
  // Favorites list). Favorites span every collection, so the entry records the
  // collection it belongs to.
  window.addEventListener("hippo:favorite-toggle", (e) => {
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
  window.addEventListener("hippo:request-open", async (e) => {
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
  window.addEventListener("hippo:request-cleared", () => {
    _selectedNode = null;
    _clearRequestEditor();
  });

  // Restoring (the right-click action) replays the snapshot back into the editor
  // — the one destructive timeline action — then shows its response.
  window.addEventListener("hippo:timeline-restore", (e) => {
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
  // Drain any debounced per-request edits while the current collection is still
  // active, so they land in the right collection and no stale timer fires after
  // the switch (see _flushRequestEdits).
  await _flushRequestEdits();

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

  const { items, variables, headers } = await loadCollectionData(id);
  treeView.setStorageKey(id);
  treeView.setItems(items);

  // Attach variables + default headers to the collection entry in memory
  currentColls = {
    ...currentColls,
    collections: currentColls.collections.map((coll) =>
      coll.id === id
        ? { ...coll, variables: variables ?? [], headers: headers ?? [] }
        : coll,
    ),
  };

  // Environments are per collection — swap to the target collection's set so the
  // picker, active environment and Global vars all follow the active collection.
  currentEnvironments = await loadEnvironments(id);
  envPicker.load(currentEnvironments);

  collPicker.load(currentColls);
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

  // New collections start with an empty environments set (their own Global, no
  // named environments, no active selection). Persisting the file now also stops
  // the one-time migration from ever re-seeding this collection from a lingering
  // legacy workspace file.
  const newEnvironments = {
    version: 1,
    globalVariables: [],
    activeEnvironmentId: null,
    environments: [],
  };
  await saveEnvironments(newColl.id, newEnvironments);

  // Drain debounced edits before switching away (see _flushRequestEdits).
  await _flushRequestEdits();

  // Switch to the new collection
  if (treeView)
    await saveCollectionData(
      currentColls.activeCollectionId,
      treeView.getItems(),
    );
  setActiveCollection(newColl.id);
  currentColls = { collections, activeCollectionId: newColl.id };
  currentEnvironments = newEnvironments;

  await saveManifest({ collections, activeCollectionId: newColl.id });

  treeView.setStorageKey(newColl.id);
  treeView.setItems([]);
  _selectedNode = null;
  _clearRequestEditor();
  collPicker.load(currentColls);
  collPopup.update(collPopupState());
  envPicker.load(currentEnvironments);
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

  // Refresh the selector — a no-op label change unless the renamed collection
  // is the active one.
  collPicker.load(currentColls);

  collPopup.update(collPopupState());
}

/** Delete a collection (must always leave at least 1). */
async function handleCollDelete({ id }) {
  if (currentColls.collections.length <= 1) return; // guard

  let collections = currentColls.collections.filter((coll) => coll.id !== id);
  let activeId = currentColls.activeCollectionId;

  // If we're deleting the active collection, switch to the first remaining one
  if (id === activeId) {
    // The pending edits belong to the collection being deleted — discard them
    // so a stale timer can't fire against the collection we switch to.
    _discardRequestEdits();
    activeId = collections[0].id;
    const { items, variables, headers } = await loadCollectionData(activeId);
    setActiveCollection(activeId);
    treeView.setStorageKey(activeId);
    treeView.setItems(items);
    const savedId = currentSettings.selectedRequestIds?.[activeId];
    if (!savedId || !treeView.selectById(savedId)) {
      _selectedNode = null;
      _clearRequestEditor();
    }
    // Attach variables + default headers in memory
    collections = collections.map((coll) =>
      coll.id === activeId
        ? { ...coll, variables: variables ?? [], headers: headers ?? [] }
        : coll,
    );
    // Environments are per collection — load the one we switched to.
    currentEnvironments = await loadEnvironments(activeId);
    envPicker.load(currentEnvironments);
  } else {
    setActiveCollection(activeId);
  }

  currentColls = { collections, activeCollectionId: activeId };
  collPicker.load(currentColls);
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

// Coalesced background persist of the active collection's FOLDER-VARIABLE /
// profile edits. It goes through the GRANULAR tree save (saveTreeStructure),
// which writes only the navigation tree — no request bodies serialized across
// IPC, no request files rewritten. A burst of edits must never stack: at most one
// save runs at a time, and any edit that arrives while one is in flight just
// marks the tree dirty; when the current save finishes, one final save runs with
// the latest tree (getItems() is read at save time). Fire-and-forget.
let _collSaveInFlight = false;
let _collSaveDirty = false;
function _queueSaveTree() {
  _collSaveDirty = true;
  if (_collSaveInFlight) return;
  _collSaveInFlight = true;
  (async () => {
    try {
      while (_collSaveDirty) {
        _collSaveDirty = false;
        await saveTreeStructure(treeView.getItems());
      }
    } finally {
      _collSaveInFlight = false;
    }
  })();
}

/**
 * Persist variables and keep in-memory state in sync.
 * The `scopeId` field doubles as a folder-node ID when it doesn't match any
 * collection — in that case the variables are stored on the tree node. For a
 * folder, `profileId` selects which profile the edit belongs to (null = Default);
 * applyProfileEdit reconciles the Default name set + the profile's overrides.
 */
async function handleVarsSave({
  scopeId,
  profileId = null,
  variables,
  overrides = null,
}) {
  const isColl = currentColls.collections.some((coll) => coll.id === scopeId);

  if (isColl) {
    // A top-level collection's variables now live in its Global environment
    // (collection-level variables were removed). Route the save there. The
    // tree only shows the active collection, so scopeId is the active one.
    await handleEnvVarsSave({ id: null, variables });
    collPopup.update(collPopupState());
    envPicker.load(currentEnvironments);
    return;
  }

  // It's a folder node — reconcile the edit against the active profile and patch
  // the LIVE node (getNode: no whole-tree clone), then queue a coalesced
  // background persist. Every save serializes the whole collection across IPC, so
  // this stays off the hot path: no await here, and overlapping saves collapse to
  // one (see _queueSaveTree).
  if (!treeView) return;
  const node = treeView.getNode(scopeId);
  const { variables: defaultVars, profileValues } = applyProfileEdit(
    { variables: node?.variables, profileValues: node?.profileValues },
    profileId,
    variables,
    _activeProfiles().map((p) => p.id),
    overrides,
  );
  treeView.updateNode(
    scopeId,
    { variables: defaultVars, profileValues },
    { silent: true },
  );
  _queueSaveTree();

  // NB: intentionally NOT refreshing the request-editor variable context here.
  // The request editor is hidden while its folder's variables are being edited,
  // and rebuilding the context re-validates every pill (the bulk of the old
  // per-keystroke lag). Selecting a request rebuilds the context for it (see the
  // hippo:request-selected handler), which is the only time it's visible.
}

/**
 * Persist a collection's default headers (merged into every request in the
 * collection at send / cURL / code-gen time). Mirrors handleVarsSave: update the
 * in-memory collection, write the per-collection metadata blob, then refresh the
 * editor context so the new defaults flow into the active request's send/curl.
 */
async function handleCollHeadersSave({ scopeId, headers }) {
  currentColls = {
    ...currentColls,
    collections: currentColls.collections.map((coll) =>
      coll.id === scopeId ? { ...coll, headers } : coll,
    ),
  };
  await saveCollectionHeaders(scopeId, headers);
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
  await saveEnvironments(currentColls.activeCollectionId, currentEnvironments);
  collPopup.update(collPopupState());
  _refreshEditorVariableContext();
  envPicker.load(currentEnvironments);
}

async function handleEnvActivate({ id }) {
  currentEnvironments = {
    ...currentEnvironments,
    activeEnvironmentId: id,
  };
  await saveEnvironments(currentColls.activeCollectionId, currentEnvironments);
  collPopup.update(collPopupState());
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
  await saveEnvironments(currentColls.activeCollectionId, currentEnvironments);
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
/**
 * Build the full variable-resolution context for a node at `nodeId` from the
 * current global / environment / collection / folder-chain state — the shape
 * `resolveStringAsync` consumes. Shared by the editor's live context refresh
 * and the folder runner (so a folder run resolves {{vars}} exactly as an
 * interactive send would, picking up its position-specific folder chain).
 *
 * @param {string|null} nodeId
 * @param {object|null} [node]  the node itself, for requestName (optional)
 */
function _buildVariableContextForNode(nodeId, node = null) {
  // Variables are stored canonically as arrays; the resolver consumes maps,
  // so flatten each scope (and every folder-chain node) here at the boundary.
  // Each folder resolves under the collection's ACTIVE profile: its Default
  // variables with the active profile's overrides applied (Default names + secure
  // flags unchanged). By presence, a variable the profile overrides uses its
  // stored value (empty included) and one it doesn't inherits the Default —
  // resolvedProfileVars, not effectiveProfileVars (which blanks inheriting values
  // for the editor). The active profile is live at send time.
  const activeProfileId = _activeProfileId();
  const folderChain = (
    treeView && nodeId ? buildFolderChain(treeView.getItems(), nodeId) : []
  ).map((folder) => ({
    ...folder,
    variables: varsArrayToMap(
      resolvedProfileVars(
        folder.variables,
        folder.profileValues,
        activeProfileId,
      ),
    ),
    // Parallel set of secret names — the map above drops the secure flag.
    secureVariables: varsArrayToSecureSet(folder.variables),
  }));
  const activeColl = currentColls.collections.find(
    (coll) => coll.id === currentColls.activeCollectionId,
  );
  const activeEnv = currentEnvironments.environments.find(
    (e) => e.id === currentEnvironments.activeEnvironmentId,
  );
  const environmentVariables = varsArrayToMap(activeEnv?.variables);
  const globalVariables = varsArrayToMap(currentEnvironments.globalVariables);

  return {
    // Collection-level default headers (merged into each request before send /
    // cURL / code-gen, overridable by a same-named request header). The
    // collection variable scope was removed — Global is the collection-wide tier.
    collectionHeaders: activeColl?.headers ?? [],
    environmentVariables,
    secureEnvironmentVariables: varsArrayToSecureSet(activeEnv?.variables),
    globalVariables,
    secureGlobalVariables: varsArrayToSecureSet(
      currentEnvironments.globalVariables,
    ),
    folderChain,
    collectionName: activeColl?.name ?? "",
    activeEnvironmentName: activeEnv?.name ?? "",
    requestName: node?.name ?? "",
    responseCache: _responseCache,
    responseHeaders: _responseHeaders,
    responseStatus: _responseStatus,
  };
}

function _refreshEditorVariableContext(nodeId) {
  if (!requestEditor) return;
  const id =
    nodeId ??
    currentSettings.selectedRequestIds?.[currentColls.activeCollectionId] ??
    null;
  const node =
    _selectedNode ??
    (id && treeView ? _findNodeById(treeView.getItems(), id) : null);

  const ctx = _buildVariableContextForNode(id, node);
  requestEditor.setVariableContext(ctx);
  _pushProfilesToEditor();

  // Feed merged variables to the tree-view so "Generate cURL" resolves correctly.
  // Environment wins over global.
  if (treeView) {
    treeView.setEnvVariables({
      ...ctx.globalVariables,
      ...ctx.environmentVariables,
    });
    // Active profile, so tree-view cURL / code-gen resolve folder variables under
    // it (not always the Default) — matching a send under the same profile.
    treeView.setActiveProfileId(_activeProfileId());
    // Collection default headers, so tree-view cURL / code-gen merge them too.
    treeView.setCollectionHeaders(ctx.collectionHeaders);
  }
}

// ── Variable write-back (shared by captures + scripts) ───────────────────

/**
 * Persist a batch of variable writes (`{ scope, name, value, secure? }`) into
 * the global / environment scopes, reusing the env save handler (which encrypts
 * `secure` values, refreshes the variables UI and routes failures to the error
 * sink). One write path for post-response captures (Feature 03) and the pre-/
 * after-request scripts (Feature 25).
 *
 * The collection variable scope was removed — a legacy `scope:"collection"` write
 * (from an old capture rule or script) is folded into the Global set. Folder-scope
 * writes are not persisted — folder variables are read-only to both mechanisms.
 * Returns the applied list (for a caller-built summary) plus any scope skipped
 * because its target (active env) was inactive, so the caller can phrase its own
 * warning.
 *
 * @param {Array<{scope:string,name:string,value:string,secure?:boolean}>} writes
 * @returns {Promise<{applied:Array<{scope,name}>, skipped:Array<{scope,names}>}>}
 */
async function persistVariableWrites(writes) {
  const applied = [];
  const skipped = [];
  if (!Array.isArray(writes) || writes.length === 0)
    return { applied, skipped };

  // Group writes by scope so each scope is persisted once. A legacy "collection"
  // target folds into Global (the collection-wide tier now).
  const byScope = { environment: [], global: [] };
  for (const w of writes) {
    const scope = w.scope === "collection" ? "global" : w.scope;
    if (byScope[scope]) byScope[scope].push(w);
  }
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
      skipped.push({
        scope: "environment",
        names: _captureNameList(byScope.environment),
      });
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

  // Reflect new env/global values in any open popup + the picker.
  if (envTouched) {
    collPopup.update(collPopupState());
    envPicker.load(currentEnvironments);
  }
  return { applied, skipped };
}

// ── Post-response captures (Feature 03) ──────────────────────────────────

/**
 * Run a request's capture rules against a freshly received response and write
 * the extracted values into their target variable scopes.
 *
 * Status gating is now PER RULE (each rule carries a response-code selector,
 * defaulting to 2xx), so this runs for any response and lets `applyCaptures`
 * decide which rules apply — e.g. capture a token on 2xx but an error body on
 * 4xx, into different variables.
 * Persistence reuses the existing env / collection variable handlers — which
 * encrypt `secure` values, refresh the variables UI, and route write failures
 * into the Notifications.error sink — so this adds no new write path. Never
 * surfaces a captured value (secure or not): toasts and the response marker
 * carry variable names + scopes only.
 *
 * Also called by the future collection runner (Feature 02) between requests.
 *
 * @param {object} node    selected request node (carries `captures`)
 * @param {object} detail  hippo:response-received detail (status/headers/body)
 */
async function _applyCapturesForNode(node, detail) {
  const rules = node?.captures;
  if (!Array.isArray(rules) || rules.length === 0) return;
  const status = detail?.status ?? 0;

  const { writes, warnings } = applyCaptures(
    { status, headers: detail?.headers ?? {}, body: detail?.body ?? "" },
    rules,
  );

  // Persist via the shared write-back path (the same one the after-response
  // script uses). It groups by scope, encrypts secure values and refreshes UI.
  const { applied, skipped } = await persistVariableWrites(writes);

  // Surface any scope skipped because its target (active env / collection) was
  // inactive — capture-specific copy, names only (never values).
  for (const s of skipped) {
    Notifications.warning(
      t(
        s.scope === "environment"
          ? "app.captureSkippedEnv"
          : "app.captureSkippedColl",
        { names: s.names },
      ),
      { title: t("app.captureSkipped") },
    );
  }

  // Surface outcomes — names + scopes only, never values.
  if (applied.length) {
    const summary = applied.map((a) => `${a.scope}.${a.name}`).join(", ");
    Notifications.info(
      t("app.captureApplied", { count: applied.length, summary }),
    );
    window.dispatchEvent(
      new CustomEvent("hippo:captures-applied", {
        // requestId lets the viewer route the badge like every other lifecycle
        // event — a background request's captures must not bleed onto whatever
        // request is currently selected.
        detail: { count: applied.length, requestId: node?.id ?? null },
      }),
    );
  }
  if (warnings.length) {
    Notifications.warning(
      t("app.captureNoValue", {
        count: warnings.length,
        names: _captureNameList(warnings),
      }),
    );
  }
}

/** Comma-join capture entry names for a message (names only — never values). */
function _captureNameList(entries) {
  return entries.map((e) => e.name).join(", ");
}

// ── Request scripting (Feature 25) ───────────────────────────────────────

/**
 * Build the flat variable snapshot ({ global, environment, folder } maps + env
 * name) for a request node, mirroring the resolver scopes — the read-side
 * context handed to a script's `hippo.variables.get` / `environment`. Folder vars
 * are flattened nearest-wins (the same precedence the resolver uses).
 * @param {string} nodeId
 */
function _variableSnapshotForNode(nodeId) {
  const activeEnv = currentEnvironments.environments.find(
    (e) => e.id === currentEnvironments.activeEnvironmentId,
  );
  const folder = {};
  if (treeView && nodeId) {
    // buildFolderChain is nearest-first; assign farthest → nearest so the
    // nearest folder wins on a name clash.
    const chain = buildFolderChain(treeView.getItems(), nodeId);
    for (let i = chain.length - 1; i >= 0; i--) {
      Object.assign(folder, varsArrayToMap(chain[i].variables));
    }
  }
  return {
    global: varsArrayToMap(currentEnvironments.globalVariables),
    environment: varsArrayToMap(activeEnv?.variables),
    folder,
    envName: activeEnv?.name ?? "",
  };
}

/**
 * Run a request's after-response sandbox: the scripted after-response code AND
 * the no-code assertions grid (Feature 29) in a SINGLE sandbox call. Hands the
 * sandbox the response (incl. elapsed time), assertions and variable snapshot,
 * surfaces any error/logs, persists variable writes through the shared write-back
 * path, and returns the collected test results.
 *
 * Each source is gated by its own Settings toggle + per-pane enable: the script
 * runs only when Scripts is on and the after-response pane is enabled; assertions
 * run only when the Tests tab is on. When neither contributes, the sandbox is not
 * invoked and an empty result set is returned.
 *
 * @param {object} node    request node (carries `afterResponseScript`/`assertions`)
 * @param {object} detail  hippo:response-received detail (status/headers/body/elapsed)
 * @returns {Promise<Array<{name:string,passed:boolean,message:string}>>}
 */
async function _runAfterResponseScript(node, detail) {
  const code =
    currentSettings.showScriptsTab &&
    node?.afterResponseScriptEnabled !== false &&
    (node?.afterResponseScript ?? "").trim()
      ? node.afterResponseScript
      : "";
  // Attach a localized display label to each row here (the sandbox stays
  // language-agnostic); the sandbox skips disabled rows itself.
  const assertions =
    currentSettings.showTestsTab && Array.isArray(node?.assertions)
      ? node.assertions.map((a) => ({ ...a, label: assertionLabel(a) }))
      : [];
  if (!code && assertions.length === 0) return [];

  const snap = _variableSnapshotForNode(node.id);
  // Pre-execute any requests the script drives via hippo.run("…") so the sandbox
  // can resolve them synchronously (it has no network of its own).
  const runNames = extractScriptRunNames(code);
  const runResults = runNames.length
    ? await _runNamedRequests(
        runNames,
        _buildVariableContextForNode(node.id, node),
      )
    : {};
  const res = await window.hippo.script.runPost({
    code,
    request: detail?.request ?? {},
    response: {
      status: detail?.status ?? 0,
      time: detail?.elapsed ?? 0,
      headers: detail?.headers ?? {},
      body: detail?.body ?? "",
    },
    environment: { name: snap.envName, variables: snap.environment },
    variables: {
      global: snap.global,
      environment: snap.environment,
      folder: snap.folder,
    },
    assertions,
    runResults,
  });
  surfaceScriptResult(res);
  if (res?.logs?.length) {
    window.dispatchEvent(
      new CustomEvent("hippo:script-console", {
        detail: { requestId: node.id, lines: _formatScriptLogs(res.logs) },
      }),
    );
  }
  if (res?.varWrites?.length) await persistVariableWrites(res.varWrites);
  return Array.isArray(res?.tests) ? res.tests : [];
}

/**
 * Format sandbox console entries ({ level, text }) into response-Console lines,
 * using the pane's prefix convention (`* ` info, `[error] ` error).
 * @param {Array<{level:string,text:string}>} logs
 * @returns {string[]}
 */
function _formatScriptLogs(logs) {
  return (logs ?? []).map((l) =>
    l?.level === "error"
      ? `[error] [script] ${l.text ?? ""}`
      : `* [script] ${l?.text ?? ""}`,
  );
}

/**
 * Surface a script run's outcome to the user. Errors become an error toast
 * (never silently dropped — acceptance criterion). Console output display is
 * wired into the response Console pane in a later step; for now logs ride along
 * unshown. Returns nothing.
 * @param {{error?:{message:string,line?:number}, logs?:Array}|null} res
 */
function surfaceScriptResult(res) {
  if (!res || !res.error) return;
  const { message, line } = res.error;
  Notifications.error(
    line ? t("script.errorWithLine", { message, line }) : message,
    { title: t("script.errorTitle") },
  );
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
  // Lazy-migrate cross-request references (name→id) in each patch as it is
  // saved, so tokens become rename-safe and unambiguous over time. Apply the
  // rewrite to the in-memory tree and _selectedNode too, so the persisted file,
  // the tree, and the data-store mirror below all agree.
  const requests = getAllRequests(treeView.getItems());
  const migrated = patches.map(([id, patch]) => {
    const { node: migPatch, changed } = migrateRequestNodeRefs(patch, requests);
    if (changed) {
      treeView.updateNode(id, migPatch, { silent: true });
      if (_selectedNode?.id === id) {
        _selectedNode = { ..._selectedNode, ...migPatch };
      }
    }
    return [id, changed ? migPatch : patch];
  });
  // Keep the data-store items mirror in step with the tree so a later
  // saveCollectionHeaders() (full write) can't clobber these edits.
  setActiveItems(treeView.getItems());
  for (const [id, patch] of migrated) {
    const ok = await updateRequest(id, patch);
    if (!ok) {
      // Brand-new request not yet on disk, a write failure, or the dev-server:
      // fall back to a full save, which creates the file and reports failures.
      await saveCollections(treeView.getItems());
      return;
    }
  }
}

/**
 * Synchronously drain any debounced request edits NOW, cancelling the pending
 * timer. Call this before anything that changes which collection/tree is active
 * (a collection switch) so the edits persist against the collection they were
 * made in — otherwise the timer fires after the switch, when treeView.getItems()
 * and the active collection have already moved on, and the saveCollections()
 * fallback in _persistRequestEdits() would target the wrong collection.
 *
 * @returns {Promise<void>}
 */
async function _flushRequestEdits() {
  clearTimeout(_requestSaveTimer);
  _requestSaveTimer = null;
  if (_pendingRequestPatches.size === 0) return;
  const patches = [..._pendingRequestPatches];
  _pendingRequestPatches.clear();
  await _persistRequestEdits(patches);
}

/**
 * Drop any debounced request edits WITHOUT persisting them, cancelling the timer.
 * Used when the collection they belong to is being deleted: the edits' request
 * files are about to be reclaimed, so flushing them would be wasted work and a
 * stale timer would otherwise fire against the next active collection.
 */
function _discardRequestEdits() {
  clearTimeout(_requestSaveTimer);
  _requestSaveTimer = null;
  _pendingRequestPatches.clear();
}

// Request-editor field mutations (debounced per-request persistence), cURL
// paste rewrite, request cancel, and the send pipeline. handleCurlPaste and
// applyCurlToRequest are private to this group (only the curl-pasted listener
// uses them).
function installRequestEditSendHandlers() {
  window.addEventListener("hippo:request-updated", (e) => {
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
  window.addEventListener("hippo:curl-pasted", (e) =>
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
        t("request.curlPaste.failed", { message: _importErrorText(err) }),
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
          (await window.hippo?.import?.file?.checkMissing?.(filePaths)) ??
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

  // Lazy-load response caches when a request is executed that references another
  // request. Each ref is either a { name, mode } object (the send pipeline) or a
  // bare reference string (the pill-editor live preview); the reference itself is
  // an id (new pills) or a name (legacy tokens), resolved by resolveRequestRef.
  requestEditor?.setEnsureResponseCaches(async (refs, ctx) => {
    const requests = getAllRequests(treeView?.getItems() ?? []);
    await Promise.all(
      (refs ?? []).map(async (raw) => {
        const ref = typeof raw === "string" ? raw : raw?.name;
        const mode =
          typeof raw === "string"
            ? "use-last-result"
            : (raw?.mode ?? "use-last-result");
        const resolved = resolveRequestRef(requests, ref);
        if (!resolved.found) return;
        if (mode === "run-immediately" && ctx) {
          const node = _findNodeById(treeView?.getItems() ?? [], resolved.id);
          if (!node) return;
          const result = await _executeRequestNode(node, ctx);
          _cacheResponse(resolved, result.body, result.headers, result.status);
        } else {
          if (!_historyLoaded.has(resolved.id)) {
            await _loadRequestHistory(resolved.id);
            _historyLoaded.add(resolved.id);
          }
          const latest = (_requestHistory.get(resolved.id) ?? [])[0];
          if (latest) {
            _cacheResponse(
              resolved,
              latest.response?.body ?? "",
              latest.response?.headers ?? {},
              latest.response?.status ?? 0,
            );
          }
        }
      }),
    );
  });

  // hippo.run("Name") in a pre-request script: the editor hands us the request
  // names the script references; we execute each and return its response so the
  // sandbox can resolve hippo.run() synchronously. Mirrors the prefetch above but
  // returns the results directly (the sandbox owns its own runResults map) rather
  // than seeding the {{run()}} response cache.
  requestEditor?.setRunRequestsByName((names, ctx) =>
    _runNamedRequests(names, ctx),
  );

  window.addEventListener("hippo:cancel-request", (e) => {
    const requestId = e.detail?.requestId ?? null;
    // A live stream (Feature 33) is aborted in the main process; its stream-end
    // (aborted:true) push updates the viewer and settles the editor's Send/Stop
    // button, so we do NOT fall through to the abortController + request-error
    // path below (the execute() promise already resolved with the marker).
    if (e.detail?.streamId) {
      window.hippo?.http?.stream?.abort?.(e.detail.streamId)?.catch?.(() => {});
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
      // Electron: destroy the in-flight socket in the main process so the
      // request stops server-side too (the Go dev path uses the AbortController
      // above). No-op in dev mode, where http.abort isn't exposed; harmless if
      // the request already settled (main returns { ok: false, not-found }).
      if (exec.streamId) {
        window.hippo?.http?.abort?.(exec.streamId)?.catch?.(() => {});
      }
      snapshot = exec.snapshot;
      _inFlightExecs.delete(exec);
    }
    // Give instant feedback: treat cancel as an error. Dispatched even when no
    // execution matched — an OAuth-phase cancel happens before the execution
    // is registered, and the editor/panels still need the state reset.
    window.dispatchEvent(
      new CustomEvent("hippo:request-error", {
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
  window.addEventListener("hippo:send-request", async (e) => {
    const descriptor = e.detail;
    const requestId = descriptor?.requestId ?? _selectedNode?.id ?? null;

    // ── Guard: URL must be a non-empty string ────────────────────────────────
    const rawUrl = descriptor?.url;
    if (!rawUrl || typeof rawUrl !== "string" || !rawUrl.trim()) {
      window.dispatchEvent(
        new CustomEvent("hippo:request-error", {
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

    // One id per send. It is the stream id (Feature 33) AND the abort handle for
    // the main-process request: a Stop on a not-yet-streaming Electron request
    // sends it to http:abort so the socket is destroyed server-side, not merely
    // discarded in the renderer. Only interactive sends are streamCapable;
    // text/event-stream always auto-streams, and application/x-ndjson
    // auto-streams when the global streamNdjson setting is on (Settings →
    // Request). Carried on the loading event so the ResponseViewer can pre-arm
    // and never miss an early frame.
    const streamId = crypto.randomUUID();

    // Register this execution so hippo:cancel-request can abort it individually.
    const exec = {
      requestId,
      snapshot: requestSnapshot,
      abortController: null,
      cancelled: false,
      streamId,
    };
    _inFlightExecs.add(exec);

    window.dispatchEvent(
      new CustomEvent("hippo:request-loading", {
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
    // window.hippo.isElectron is set to true by Electron's preload.js.
    // It is never present when the page is served by the Go dev server in a
    // plain browser context.  We check this explicit sentinel rather than
    // testing for a function reference so detection cannot silently regress
    // if the preload is out of sync.
    const inElectron = window.hippo?.isElectron === true;

    try {
      let result;

      if (inElectron) {
        // ── Electron path: all HTTP via Node.js IPC (no Chromium/CORS) ───────
        // The main process uses Node's built-in http/https modules, so CORS,
        // certificate policies, and same-origin restrictions don't apply.
        if (typeof window.hippo?.http?.execute !== "function") {
          // Preload is out of date — this is a developer error, not a user
          // error.  Surface it clearly rather than silently falling back.
          throw new Error(
            "window.hippo.http.execute is not available. " +
              "Ensure the Electron app was rebuilt with the latest preload.js.",
          );
        }
        result = await window.hippo.http.execute(nativeDesc);
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
          new CustomEvent("hippo:request-error", {
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
          new CustomEvent("hippo:response-received", {
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
              // the hippo:stream-* events keyed by streamId; the viewer switches
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
        new CustomEvent("hippo:request-error", {
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
  const {
    items,
    settings,
    collections,
    activeCollectionId,
    variables,
    headers,
  } = await loadAll();

  // Environments are now scoped per collection, so they can only be loaded once
  // we know which collection is active (hence sequenced after loadAll, not in
  // parallel). First run / no active collection → keep the empty default.
  if (activeCollectionId) {
    currentEnvironments = await loadEnvironments(activeCollectionId);
  }

  treeView.setStorageKey(activeCollectionId);
  treeView.setItems(items);
  currentSettings = settings;
  _maxHistory = settings.historyCount ?? 5;
  settingsPopup.load(settings);
  applySettings(settings);

  // Seed collection state — attach loaded variables + default headers to the
  // active collection object
  const collsWithVars = collections.map((coll) =>
    coll.id === activeCollectionId
      ? { ...coll, variables: variables ?? [], headers: headers ?? [] }
      : coll,
  );
  currentColls = { collections: collsWithVars, activeCollectionId };
  collPicker.load(currentColls);
  envPicker.load(currentEnvironments);

  // Restore the previously selected request for this collection (or clear if none)
  const savedId = settings.selectedRequestIds?.[activeCollectionId];
  if (!savedId || !treeView.selectById(savedId)) {
    _clearRequestEditor();
  }
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
 * The active collection's default headers, merged into a request before send /
 * cURL / code-gen (a same-named request header overrides them). Empty when no
 * collection is active.
 */
function _activeCollHeaders() {
  const coll = currentColls.collections.find(
    (c) => c.id === currentColls.activeCollectionId,
  );
  return coll?.headers ?? [];
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
    retryNonIdempotent: settings.retryNonIdempotent === true,
    statusCodes: settings.retryStatusCodes ?? "",
  };
}

// ─── Zoom → Font-size handler ─────────────────────────────────────────────────
// installZoomHandlers (Ctrl/Cmd + wheel/pinch and +/-/0, the hippo:ui-font-change
// menu events, plus Cmd/Ctrl+Enter to send) now lives in
// ./event-bus/zoom-handlers.js (imported above), wired in DOMContentLoaded via the
// bus context.

// ─── Keyboard shortcuts (Feature 47) ──────────────────────────────────────────
/**
 * Wire the application keyboard shortcuts. The keymap (keymap.js) is the single
 * source of truth — here we bind it to app commands two ways:
 *   • Renderer-owned shortcuts (focus URL, next/prev request, switch sidebar
 *     tab) via installKeymap's capture-phase keydown listener.
 *   • Menu-owned commands (save / new request / new collection / settings /
 *     keyboard shortcuts / cycle layout) whose real menu accelerators and clicks
 *     both arrive as hippo:* events from the application menu (see main.js /
 *     preload.js). Each command is defined once and shared by both paths.
 *
 * Send (⌘/Ctrl+Enter) and font zoom keep their dedicated handlers in
 * installZoomHandlers — Send must fire from inside the URL editor, and font zoom
 * also owns wheel/pinch. The cheat-sheet lists those for discoverability.
 */
function installKeyboardShortcuts() {
  // Track whether a popup/menu is up so the renderer-owned navigation shortcuts
  // and the tree mutations don't act behind a modal. The mask coalesces nested
  // opens into a single opened/closed pair, so a boolean is sufficient.
  let popupVisible = false;
  window.addEventListener("hippo:popup-opened", () => {
    popupVisible = true;
  });
  window.addEventListener("hippo:popup-closed", () => {
    popupVisible = false;
  });

  const switchTab = (tab) => treeView?.activateTab(tab);
  const selectAdjacent = (dir) => treeView?.selectAdjacent(dir);

  // Menu-owned commands — shared by the keystroke (real accelerator → preload
  // event) and a menu click (same channel).
  const newRequest = () => {
    if (!popupVisible) treeView?.newRequest();
  };
  const newCollection = () => {
    if (!popupVisible) treeView?.newCollection();
  };
  const newWsRequest = () => {
    if (!popupVisible) treeView?.newWebSocketRequest();
  };
  // Popup-openers are gated while another modal is up: their accelerators fire
  // natively regardless of app state, and PopupManager.open() would otherwise
  // detach the live popup without running its cleanup.
  const openSettings = () => {
    if (!popupVisible) settingsPopup.open(currentSettings);
  };
  const openShortcuts = () => {
    if (!popupVisible) KeyboardShortcuts.open();
  };
  const openAbout = () => {
    if (!popupVisible) AboutDialog.open();
  };
  const cycleLayout = () => {
    if (popupVisible) return;
    const next = (_currentLayout % 4) + 1; // 1→2→3→4→1
    updateSettings({ layout: next });
    applySettings(currentSettings);
  };

  // Renderer-owned shortcuts (capture-phase keydown), gated while a popup is up.
  installKeymap(
    {
      focusUrl: () => requestEditor?.focusUrl(),
      prevRequest: () => selectAdjacent(-1),
      nextRequest: () => selectAdjacent(1),
      tabRequests: () => switchTab("requests"),
      tabFavorites: () => switchTab("favorites"),
      tabRecents: () => switchTab("recents"),
      // ⌘/Ctrl+E opens the collections editor focused on the Environment tab.
      editEnvironment: () => openCollectionsEditor("env"),
    },
    { isBlocked: () => popupVisible },
  );

  // Variable-profile switch (⌥⌘0–9): the digit is a runtime slot into the active
  // collection's profiles, so this range can't be a static installKeymap entry —
  // handle it here in the capture phase. Allowed while typing (a collection-wide
  // state change, like the tab-switch shortcuts), gated behind popups.
  window.addEventListener(
    "keydown",
    (e) => {
      if (popupVisible) return;
      const slot = profileShortcutSlot(e);
      if (slot < 0) return;
      e.preventDefault();
      e.stopPropagation();
      selectProfileBySlot(slot);
    },
    { capture: true },
  );

  window.addEventListener("hippo:new-request", newRequest);
  window.addEventListener("hippo:new-collection", newCollection);
  window.addEventListener("hippo:new-ws-request", newWsRequest);
  window.addEventListener("hippo:open-settings", openSettings);
  window.addEventListener("hippo:keyboard-shortcuts", openShortcuts);
  window.addEventListener("hippo:show-about", openAbout);
  window.addEventListener("hippo:cycle-layout", cycleLayout);
}

/** Reset the request editor to an empty request and clear the response/timeline. */
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

/**
 * Dispatch hippo:timeline-update with the history entries for the given request ID.
 * @param {string|null}  requestId
 * @param {boolean}      [isRequestSwitch] – true when triggered by a request selection;
 *                                           the response-viewer uses this to update the body tab.
 */
function _dispatchTimelineUpdate(requestId, isRequestSwitch = false) {
  const entries = requestId ? (_requestHistory.get(requestId) ?? []) : [];
  window.dispatchEvent(
    new CustomEvent("hippo:timeline-update", {
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
  let styleEl = document.getElementById("resthippo-custom-theme");
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = "resthippo-custom-theme";
    document.head.appendChild(styleEl);
  }
  // Build the rule through a validating helper — a custom theme can arrive from
  // an imported backup, and a raw value containing `}` would otherwise break out
  // of the rule and inject arbitrary CSS app-wide. buildCustomThemeCss() drops
  // any key/value that could escape and constrains color-scheme to light|dark.
  styleEl.textContent = buildCustomThemeCss(theme);
}

function applySettings(settings) {
  // Theme — stored as a data attribute so CSS [data-theme="latte"] etc. applies
  const BUILT_IN_THEMES = new Set([
    "mocha",
    "grey-dark",
    "latte",
    "grey-light",
  ]);
  const themeId = settings.theme ?? "grey-dark";
  if (BUILT_IN_THEMES.has(themeId)) {
    document.documentElement.dataset.theme = themeId;
    document.getElementById("resthippo-custom-theme")?.remove();
  } else {
    const custom = (settings.customThemes ?? []).find((t) => t.id === themeId);
    if (custom) {
      _applyCustomThemeVars(custom);
    } else {
      document.documentElement.dataset.theme = "grey-dark";
      document.getElementById("resthippo-custom-theme")?.remove();
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
  // Panel layout — apply the pinned layout. The picker now lives in the
  // settings popup, which keeps itself in sync via its own load()/open().
  if (settings.layout != null) {
    applyLayout(settings.layout);
  }
  // Splitter positions — restore saved pixel values into the grid variables,
  // clamping the nav width up to its minimum so older saved positions below the
  // current floor don't reopen narrower than allowed.
  if (settings.splitterNav != null)
    splitterSizes.nav = Math.max(SPLITTER_MIN_NAV, settings.splitterNav);
  if (settings.splitterRes != null) splitterSizes.res = settings.splitterRes;
  if (settings.splitterRowRes != null)
    splitterSizes.rowRes = settings.splitterRowRes;
  applyGridVars();

  // Editor preferences
  if (requestEditor) requestEditor.applySettings(settings);
  if (responseViewer) responseViewer.applySettings(settings);
  if (varsEditor) varsEditor.applySettings(settings);
  if (collPopup) collPopup.applySettings(settings);
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

    // Relocate the env selector, Collections button, ctrl-group, and tree-toolbar
    // separator for the active layout (replaces the static nav-settings-bar).
    placeRemoveHeaderControls(_currentLayout, remove);
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

/**
 * Walk the item tree and collect all request nodes as { id, name, path } — the
 * `path` (ancestor collection/folder names) lets the request-picker disambiguate
 * duplicate names. See request-refs.js.
 */
function getAllRequests(items) {
  return flattenRequests(items);
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
      collectionHeaders: _activeCollHeaders(),
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
    if (window.hippo?.isElectron === true) {
      result = await window.hippo.http.execute(nativeDesc);
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

      await _recordHistoryEntry(
        node.id,
        {
          id: histId,
          requestNode: reqNode,
          requestUrl: finalUrl,
          response: resp,
          timestamp: nowMs,
        },
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
    }

    if (result.error && result.status === 0) {
      return { body: "", headers: {}, status: 0, time: 0 };
    }
    return {
      body: result.body ?? "",
      headers: result.headers ?? {},
      status: result.status ?? 0,
      time: result.elapsed ?? 0,
    };
  } catch {
    return { body: "", headers: {}, status: 0, time: 0 };
  }
}

/**
 * Execute a set of saved requests by name and return a `{ name -> response }`
 * map for the scripting `hippo.run("…")` API. Each request is resolved + fired
 * exactly like the `{{run()}}` prefetch (same `_executeRequestNode` path — so the
 * executed request runs with its own saved config but does NOT itself run pre/
 * after-response scripts, bounding any chaining). Unknown names are simply
 * omitted; the sandbox's `hippo.run` throws for a name with no result.
 *
 * @param {string[]} names  request names referenced by hippo.run("…")
 * @param {object} ctx      variable-resolution context for {{var}} substitution
 * @returns {Promise<Object<string,{status:number,time:number,headers:object,body:string}>>}
 */
async function _runNamedRequests(names, ctx) {
  const out = {};
  const items = treeView?.getItems() ?? [];
  const requests = getAllRequests(items);
  await Promise.all(
    (names ?? []).map(async (name) => {
      // hippo.run() is name-keyed by nature (a script names a string literal);
      // resolve by name and warn if the name is ambiguous (the picker stores ids
      // instead, but a script can't).
      const resolved = resolveRequestRef(requests, name);
      if (!resolved.found) return;
      if (resolved.ambiguous) {
        Notifications.warning(t("script.ambiguousRequest", { name }), {
          title: t("script.errorTitle"),
        });
      }
      const node = _findNodeById(items, resolved.id);
      if (!node) return;
      const result = await _executeRequestNode(node, ctx);
      out[name] = {
        status: result.status,
        time: result.time ?? 0,
        headers: result.headers,
        body: result.body,
      };
    }),
  );
  return out;
}

// ── Folder run (run every request in a folder, tally tests) ──────────────────

/** Folder ids with a run currently in flight — guards against re-entrant runs. */
const _runningFolders = new Set();

/**
 * Collect runnable request nodes under a folder, in tree order, recursively.
 * WebSocket requests are skipped — they open a persistent connection rather
 * than executing a one-shot HTTP round-trip the runner can score.
 */
function _collectRunnableRequests(folder) {
  const out = [];
  const walk = (node) => {
    for (const child of node.children ?? []) {
      if (child.type === "collection") walk(child);
      else if (child.type === "request" && child.protocol !== "websocket")
        out.push(child);
    }
  };
  walk(folder ?? {});
  return out;
}

/**
 * Apply a node's capture rules to a response and persist the writes WITHOUT the
 * per-request toasts `_applyCapturesForNode` shows — a folder run executes many
 * requests, so silent write-back keeps chained flows (login → capture token →
 * later requests use it) working without flooding the user with notifications.
 * Captured values land in the in-memory scope state, so the next request's
 * freshly-built context resolves them.
 */
async function _applyCapturesQuiet(node, detail) {
  const rules = node?.captures;
  if (!Array.isArray(rules) || rules.length === 0) return;
  const { writes } = applyCaptures(
    {
      status: detail?.status ?? 0,
      headers: detail?.headers ?? {},
      body: detail?.body ?? "",
    },
    rules,
  );
  if (writes.length) await persistVariableWrites(writes);
}

/**
 * Execute a single request node for a folder run and return either a
 * response detail (the shape `_runAfterResponseScript` / `_applyCapturesQuiet`
 * consume) or a network-level error. Mirrors the interactive send's payload
 * assembly (URL percent-encoded, query/auth/body via buildRequestPayload) but
 * runs quietly — no editor/viewer/loading events. OAuth2 is unsupported here
 * (its token acquisition is interactive), matching the dependency prefetcher.
 *
 * @param {object} node
 * @param {object} ctx  variable-resolution context for this node
 * @returns {Promise<{ok:boolean, detail?:object, error?:object}>}
 */
async function _executeForFolderRun(node, ctx) {
  const rv = (s) => resolveStringAsync(s, ctx);
  const method = node.method ?? "GET";
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
      urlBase: encodeBaseUrl(
        applyPathParams(
          await rv(node.url ?? ""),
          await resolvePathParamValues(node.pathParams, rv),
        ),
      ),
      params: node.params,
      headers: node.headers,
      collectionHeaders: _activeCollHeaders(),
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
      // A saved request stores the file body as a path string (bodyFilePath),
      // not a File object; hand buildRequestPayload the { path } shape it reads.
      bodyFile: node.bodyFilePath ? { path: node.bodyFilePath } : null,
      bodyGraphql: node.bodyGraphql,
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
    ..._proxyDescriptorFields(currentSettings),
    retry: _retryDescriptor(currentSettings),
    collectionId: currentColls.activeCollectionId ?? null,
    useCookieJar: _collSendCookies(currentColls.activeCollectionId),
  };

  const request = {
    method,
    url: finalUrl,
    headers,
    body: typeof body === "string" ? body : null,
  };

  let result;
  try {
    if (window.hippo?.isElectron === true) {
      result = await window.hippo.http.execute(nativeDesc);
    } else {
      const res = await fetch("/api/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nativeDesc),
      });
      if (!res.ok) throw new Error(`Execute API returned HTTP ${res.status}`);
      result = await res.json();
    }
  } catch (err) {
    // A thrown transport error (preload missing, dev-server down) is the same
    // class of failure as a network error — record it as one rather than
    // letting it escape the runner uncounted.
    const name = (err instanceof Error ? err.name : "Error") || "Error";
    const message = (err instanceof Error ? err.message : String(err)) || "";
    return {
      ok: false,
      errorDetail: {
        request,
        name,
        message,
        hint: _buildHint(name, message),
        elapsed: 0,
        consoleLog: [`* ${name}: ${message}`],
      },
    };
  }

  // Network-level failure (status 0): no HTTP response was received.
  if (result.error && result.status === 0) {
    return {
      ok: false,
      errorDetail: {
        request,
        name: result.error.name,
        message: result.error.message,
        hint: _buildHint(result.error.name, result.error.message),
        elapsed: result.elapsed ?? 0,
        consoleLog: result.consoleLog ?? [],
      },
    };
  }

  // Genuine HTTP response (any status). Carry the full detail the history /
  // captures / tests paths consume — the same shape as the interactive
  // hippo:response-received event.
  return {
    ok: true,
    detail: {
      request,
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
    },
  };
}

/**
 * Run every request in a folder sequentially, tally each request's after-response
 * tests (Feature 29 assertions + script), and stream a running pass/total count
 * to the tree badge of EVERY folder in the run subtree — each nested folder shows
 * the tally for its own requests, and the clicked (root) folder rolls up its
 * immediate requests plus all descendants. Sequential by design: requests share
 * the cookie jar and may depend on variables an earlier request captured;
 * captures and script variable-writes ARE applied between requests (quietly) so
 * those chains work.
 */
async function _runFolder(folderId) {
  if (!folderId) return;
  const items = treeView ? treeView.getItems() : [];
  const folder = _findNodeById(items, folderId);
  if (!folder) return;

  const requests = _collectRunnableRequests(folder);
  if (requests.length === 0) {
    Notifications.info(t("app.runFolder.empty"), {
      title: t("app.runFolder.title"),
    });
    return;
  }

  // Credit each request to every ancestor folder from its parent up to (and
  // including) the run-root folder, so a result rolls up through the nesting.
  // tally[folderId] holds that folder's own running totals; its `count` is the
  // number of runnable requests in its subtree (pre-computed below for the
  // "{completed} of {count}" tooltip).
  const newTally = () => ({
    running: true,
    passed: 0,
    total: 0,
    failed: 0,
    completed: 0,
    count: 0,
  });
  const tally = new Map();
  const creditChains = new Map(); // requestId → [folderId, … up to the run root]
  for (const node of requests) {
    const chain = buildFolderChain(items, node.id); // nearest-first ancestors
    const rootIdx = chain.findIndex((f) => f.id === folderId);
    const credited = (
      rootIdx >= 0 ? chain.slice(0, rootIdx + 1) : [folder]
    ).map((f) => f.id);
    creditChains.set(node.id, credited);
    for (const fid of credited) {
      if (!tally.has(fid)) tally.set(fid, newTally());
      tally.get(fid).count += 1;
    }
  }

  // Re-entrancy guard across the whole subtree: block a run that overlaps one
  // already in flight (an ancestor's run already locked this folder, or this
  // run would lock a folder a descendant run is using).
  const lockIds = [...tally.keys()];
  if (lockIds.some((id) => _runningFolders.has(id))) return;
  for (const id of lockIds) _runningFolders.add(id);

  const push = (fid) => treeView?.setFolderRunState(fid, { ...tally.get(fid) });
  const settle = () => {
    for (const [fid, t] of tally) {
      t.running = false;
      treeView?.setFolderRunState(fid, { ...t });
    }
  };
  for (const fid of lockIds) push(fid);

  try {
    for (const node of requests) {
      // Per-request fault isolation: any throw (payload build, execute, capture
      // write-back, or the test sandbox) counts this request as failed and the
      // run continues to the next — one bad request never aborts the whole run.
      const inc = { passed: 0, total: 0, failed: 0 };
      try {
        const ctx = _buildVariableContextForNode(node.id, node);
        const outcome = await _executeForFolderRun(node, ctx);
        if (outcome.ok) {
          // Score this request's after-response tests (for the tally), then
          // mirror an interactive send so the request's stored state matches a
          // direct run: push results to the Tests tab (if it's the open
          // request), record the run in its Timeline, and apply captures so a
          // value captured here is visible to the next request's context.
          const tests = await _runAfterResponseScript(node, outcome.detail);
          for (const tr of tests) {
            inc.total += 1;
            if (tr.passed) inc.passed += 1;
          }
          if (tests.length) {
            window.dispatchEvent(
              new CustomEvent("hippo:test-results", {
                detail: {
                  requestId: node.id,
                  results: tests,
                  summary: _testSummary(tests),
                },
              }),
            );
          }
          await _recordRunHistory(node, outcome.detail, tests);
          await _applyCapturesQuiet(node, outcome.detail);
        } else {
          inc.failed += 1;
          await _recordRunError(node, outcome.errorDetail);
        }
      } catch {
        inc.failed += 1;
      }
      // Roll this request's result up through every folder that owns it.
      for (const fid of creditChains.get(node.id)) {
        const t = tally.get(fid);
        t.passed += inc.passed;
        t.total += inc.total;
        t.failed += inc.failed;
        t.completed += 1;
        push(fid);
      }
    }
  } finally {
    settle();
    for (const id of lockIds) _runningFolders.delete(id);
  }

  // One summary toast for the whole run, keyed off the run-root totals.
  const root = tally.get(folderId);
  if (root.total === 0 && root.failed === 0) {
    Notifications.info(
      t("app.runFolder.noTests", {
        count: root.count,
        name: folder.name ?? "",
      }),
      { title: t("app.runFolder.title") },
    );
    return;
  }
  const parts = [
    t("tree.folderRun.tests", {
      passed: root.passed,
      total: root.total,
      count: root.total,
    }),
  ];
  if (root.failed > 0)
    parts.push(
      t("tree.folderRun.failedReqs", {
        failed: root.failed,
        count: root.failed,
      }),
    );
  const message = parts.join(" · ");
  if (root.failed === 0 && root.passed === root.total) {
    Notifications.success(message, { title: t("app.runFolder.title") });
  } else {
    Notifications.warning(message, { title: t("app.runFolder.title") });
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
  resthippo: { suffix: ".resthippo.json", label: "Rest Hippo v1" },
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

/**
 * Resolve a parser-thrown import error to display text. The lossy import
 * sub-parsers (`import/*`) stay free of `t()` by convention, so they attach a
 * stable `i18nKey` to the Error; resolve it here, falling back to the English
 * `.message` for native/un-keyed errors.
 */
function _importErrorText(err) {
  return err?.i18nKey ? t(err.i18nKey) : String(err?.message ?? err);
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
    const saved = await window.hippo.export.file.save(
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
 * @param {object} collection  Rest Hippo collection node
 */
function handleExport(collection) {
  if (!window.hippo?.export?.file?.save) {
    Notifications.info(t("app.exportDesktopOnly"));
    return;
  }
  ExportModal.openCollection(collection, (format) =>
    runCollectionExport(collection, format),
  );
}

/** Serialize a single collection to the chosen format and save it. */
async function runCollectionExport(collection, format) {
  if (!window.hippo?.export?.file?.save) return;

  if (format === "resthippo") {
    await runRestHippoCollectionExport(collection);
    return;
  }

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
  let successMsg = t("app.exportedAs", {
    name: collection.name,
    format: meta.label,
  });
  if (format === "har") {
    const history = await _gatherHistory(collection);
    content = exportToHar(collection, history);
    if (history.size === 0) {
      successMsg = t("app.exportedAsHarEmpty", { name: collection.name });
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
  if (!window.hippo?.export?.file?.save) return;

  if (format === "resthippo") {
    await runRestHippoWorkspaceExport();
    return;
  }

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
    name: "Rest Hippo Workspace",
    variables: {},
    children,
  };

  const meta = EXPORT_FORMATS[format] ?? EXPORT_FORMATS.postman;
  const filename = `resthippo-workspace${meta.suffix}`;
  const count = children.length;

  let content;
  let successMsg = t("app.workspaceExportedAs", { count, format: meta.label });
  if (format === "har") {
    const history = await _gatherHistory(root);
    content = exportToHar(root, history);
    if (history.size === 0) {
      successMsg = t("app.workspaceExportedAsHarEmpty");
    }
  } else {
    content = _serializeCollection(root, mergedVars, format);
  }

  await _saveExport(filename, content, format, successMsg);
}

// ── Rest Hippo v1 (native, lossless) export/import ────────────────────────────

/**
 * Export one collection as a native Rest Hippo v1 archive: the folder/request
 * subtree verbatim, the collection's own variables, and every environment filtered
 * to the variables the collection references. Built from the live tree (current,
 * full-fidelity). Secrets trigger a password prompt (see saveRestHippoArchive).
 */
async function runRestHippoCollectionExport(collection) {
  let collectionVariables = [];
  let collectionHeaders = [];
  try {
    const data = await loadCollectionData(currentColls.activeCollectionId);
    collectionVariables = normalizeVariables(data.variables);
    collectionHeaders = Array.isArray(data.headers) ? data.headers : [];
  } catch {
    /* non-fatal — export without collection variables / headers */
  }
  const archive = buildRestHippoArchive({
    items: [collection],
    collectionVariables,
    collectionHeaders,
    // Both export paths (per-collection button, tree collection menu) run against
    // the active collection, so its profile list is the right one to travel.
    collectionProfiles: _activeProfiles(),
    environments: currentEnvironments,
    exportedAt: new Date().toISOString(),
  });
  const filename = `${_safeFileBase(collection.name)}.resthippo.json`;
  await saveRestHippoArchive(
    archive,
    filename,
    t("app.resthippoExported", { name: collection.name }),
  );
}

/**
 * Export the whole workspace as one Rest Hippo v1 archive — every collection's
 * top-level nodes, collection variables merged by name (first wins), and the
 * referenced environments.
 */
async function runRestHippoWorkspaceExport() {
  const items = [];
  const collectionVariables = [];
  const seenVar = new Set();
  // Default headers from every collection, deduped by name (case-insensitive) +
  // value so identical rows collapse but distinct ones survive the flatten.
  const collectionHeaders = [];
  const seenHeader = new Set();
  // Profile names across every collection, deduped by name (the whole workspace
  // merges into the active collection on import, so profiles pool together).
  const collectionProfiles = [];
  const seenProfile = new Set();
  let count = 0;

  for (const coll of currentColls.collections ?? []) {
    let data;
    try {
      data = await loadCollectionData(coll.id);
    } catch {
      continue;
    }
    const collItems =
      coll.id === currentColls.activeCollectionId
        ? (treeView?.getItems() ?? data.items ?? [])
        : (data.items ?? []);
    items.push(...collItems);
    count += 1;
    for (const p of coll.variableProfiles ?? []) {
      if (!p || p.id == null) continue;
      const key = String(p.name ?? "").toLowerCase();
      if (seenProfile.has(key)) continue;
      seenProfile.add(key);
      collectionProfiles.push({ id: String(p.id), name: String(p.name ?? "") });
    }
    for (const v of normalizeVariables(data.variables)) {
      if (seenVar.has(v.name)) continue;
      seenVar.add(v.name);
      collectionVariables.push(v);
    }
    for (const h of data.headers ?? []) {
      if (!h || !h.name) continue;
      const key = `${String(h.name).toLowerCase()}\u0000${h.value ?? ""}`;
      if (seenHeader.has(key)) continue;
      seenHeader.add(key);
      collectionHeaders.push(h);
    }
  }

  const archive = buildRestHippoArchive({
    items,
    collectionVariables,
    collectionHeaders,
    collectionProfiles,
    environments: currentEnvironments,
    exportedAt: new Date().toISOString(),
  });
  await saveRestHippoArchive(
    archive,
    "resthippo-workspace.resthippo.json",
    t("app.resthippoWorkspaceExported", { count }),
  );
}

/**
 * Drive the save of a Rest Hippo v1 archive. The main process reports
 * `needsPassword` when the archive carries secrets; we then prompt (set + confirm)
 * and re-save encrypted. No secrets → saved as plain JSON with no prompt.
 */
async function saveRestHippoArchive(archive, filename, plainMsg) {
  const successMsg = (secure) =>
    secure ? `${plainMsg} ${t("app.resthippoSecuredSuffix")}` : plainMsg;
  const fail = (message) =>
    Notifications.error(
      t("app.exportFailed", { message: String(message ?? "") }),
      {
        title: t("app.exportTitle"),
      },
    );

  let res;
  try {
    res = await window.hippo.collectionArchive.save({ archive, filename });
  } catch (err) {
    fail(err.message ?? err);
    return;
  }

  if (res?.needsPassword) {
    // The format picker (ExportModal) closes itself the moment this flow's
    // onChoose resolves, and PopupManager only tracks one popup at a time — so
    // opening the password prompt synchronously here would let that close() tear
    // it straight back down. Defer to a macrotask so the prompt mounts AFTER the
    // picker has closed.
    setTimeout(() => {
      PasswordPrompt.open({
        variant: "create",
        onSubmit: async (password) => {
          let res2;
          try {
            res2 = await window.hippo.collectionArchive.save({
              archive,
              filename,
              password,
            });
          } catch (err) {
            fail(err.message ?? err);
            return { ok: true }; // close the prompt; failure already surfaced
          }
          if (res2?.ok) Notifications.success(successMsg(true));
          else if (!res2?.canceled) fail(res2?.error);
          return { ok: true };
        },
      });
    }, 0);
    return;
  }

  if (res?.ok)
    Notifications.success(successMsg(res.secretsMode === "password"));
  else if (!res?.canceled) fail(res?.error);
}

/**
 * Import a Rest Hippo v1 archive. Password-protected archives are decrypted in the
 * main process behind a prompt (re-prompting on a wrong password); plaintext ones
 * merge straight away.
 */
// Returns true when the archive was merged inline (the caller may close any open
// import modal), or false when a password-protected archive handed off to the
// PasswordPrompt — which takes over the single popup slot and owns the lifecycle
// from there, so the caller must NOT also close it.
async function applyRestHippoImport(archive) {
  if (archive.secretsMode === "password") {
    PasswordPrompt.open({
      variant: "enter",
      onSubmit: async (password) => {
        let res;
        try {
          res = await window.hippo.collectionArchive.decrypt({
            archive,
            password,
          });
        } catch (err) {
          Notifications.error(
            t("app.importFailed", { message: String(err.message ?? err) }),
            { title: t("app.importTitle") },
          );
          return { ok: true };
        }
        if (res?.reason === "bad-password") return { ok: false }; // re-prompt
        if (!res?.ok) {
          Notifications.error(
            t("app.importFailed", { message: res?.error ?? "" }),
            { title: t("app.importTitle") },
          );
          return { ok: true };
        }
        await mergeRestHippoArchive(res.archive);
        return { ok: true };
      },
    });
    return false; // handed off to the password prompt; it owns the popup now
  }
  await mergeRestHippoArchive(archive);
  return true;
}

/**
 * Merge a decrypted Rest Hippo v1 archive into the active collection + the
 * workspace environments, then persist. Folders/requests match by id→name;
 * environments and variables likewise (see import/resthippo.js for the rules).
 */
async function mergeRestHippoArchive(archive) {
  const activeId = currentColls.activeCollectionId;

  // 1. Tree merge into the active collection (live tree is authoritative).
  const treeMerge = mergeArchiveIntoTree(
    treeView?.getItems() ?? [],
    archive.items ?? [],
  );

  // 2. Default headers: add any the archive carries that are missing (existing
  //    values are never overwritten). Collection-level variables were removed —
  //    they're folded into Global in step 3.
  let collHeaders;
  try {
    const data = await loadCollectionData(activeId);
    collHeaders = mergeHeaderList(data.headers, archive.collectionHeaders).list;
  } catch {
    collHeaders = mergeHeaderList([], archive.collectionHeaders).list;
  }

  if (treeView) treeView.setItems(treeMerge.items);
  // Sync the cached default headers BEFORE the write so saveCollectionData's
  // single blob carries the restored headers (it reads them from the cache).
  setActiveHeaders(collHeaders);
  const saved = await saveCollectionData(activeId, treeMerge.items);
  if (!saved) return false; // write-error sink already surfaced the failure

  // 3. Environments merge (global + named) into the active collection. An older
  //    archive's collection-level variables fold into Global (existing wins).
  const envMerge = mergeEnvironments(currentEnvironments, archive.environments);
  let mergedEnv = envMerge.environments;
  if (
    Array.isArray(archive.collectionVariables) &&
    archive.collectionVariables.length
  ) {
    mergedEnv = {
      ...mergedEnv,
      globalVariables: mergeVariableList(
        mergedEnv.globalVariables,
        archive.collectionVariables,
      ).list,
    };
  }
  currentEnvironments = mergedEnv;
  await saveEnvironments(activeId, currentEnvironments);

  // 4. Merge the archive's folder-variable profile list into the active
  //    collection (add-if-missing by id→name; folder overrides on the nodes keep
  //    their archive profile ids). Persist the manifest when the list grows.
  const activeEntry = currentColls.collections.find((c) => c.id === activeId);
  const profileMerge = mergeProfileList(
    activeEntry?.variableProfiles,
    archive.collectionProfiles,
  );

  // 5. Reflect the merged default headers + profiles in memory (variables live in
  //    currentEnvironments now, refreshed below via the env picker / context).
  currentColls = {
    ...currentColls,
    collections: currentColls.collections.map((coll) =>
      coll.id === activeId
        ? { ...coll, headers: collHeaders, variableProfiles: profileMerge.list }
        : coll,
    ),
  };
  if (profileMerge.added > 0) {
    await saveManifest({
      collections: currentColls.collections,
      activeCollectionId: activeId,
    });
  }

  // Refresh every surface that mirrors this state so the restore is visible now.
  collPopup.update(collPopupState());
  envPicker.load(currentEnvironments);
  // Rebuilds the live variable context and feeds the tree-view its merged
  // variables from currentColls + the tree + currentEnvironments.
  _refreshEditorVariableContext();

  Notifications.success(
    t("app.resthippoImported", {
      created: treeMerge.created,
      replaced: treeMerge.replaced,
      environments: envMerge.createdEnvs,
    }),
  );
  return true;
}

// Open the native file picker and import the chosen interchange file. The import
// modal's Browse… button routes here. Returns true when a collection was applied
// (so the modal closes), false on cancel / failure / password-prompt handoff (so
// the modal stays open). The renderer sandbox can't read a path, so this native
// picker is the only import route that works under the Mac App Store sandbox.
async function handleImportBrowse() {
  if (!window.hippo?.import?.file?.open) {
    Notifications.info(t("app.importDesktopOnly"));
    return false;
  }

  let file;
  try {
    file = await window.hippo.import.file.open();
  } catch (err) {
    Notifications.error(
      t("app.importFailed", { message: String(err.message ?? err) }),
      { title: t("app.importTitle") },
    );
    return false;
  }
  if (!file) return false; // user cancelled the file dialog

  return _importFromContent(file.content);
}

// Read a typed absolute file path (new import:file:read IPC) and import it. The
// smart-field import modal routes here when the user types a local path instead
// of a URL. A read failure (a bad path, or a sandboxed MAS build that returns
// null) resolves to `{ error }` so the import modal renders urlImport.errPath
// INLINE — beside the field the user just typed — and stays open for a
// correction or the Browse… fallback. (A file that reads but doesn't parse is a
// different class of failure: _importFromContent surfaces it as a toast.)
async function handleFilePathImport(path) {
  if (!window.hippo?.import?.file?.read) {
    Notifications.info(t("app.importDesktopOnly"));
    return false;
  }

  let file;
  try {
    file = await window.hippo.import.file.read(path);
  } catch {
    file = null;
  }
  if (!file) return { error: t("urlImport.errPath") };

  return _importFromContent(file.content);
}

// Shared import tail for raw file `content` (from the native picker or a typed
// path). Native Rest Hippo v1 archives (JSON) take the identity-aware merge path;
// try to recognize one before handing off to the lossy interchange parsers.
// Returns true when a collection was applied (or an archive merged inline), false
// on cancel / parse error / password-prompt handoff — the boolean the import
// modal uses to decide whether to close.
async function _importFromContent(content) {
  let maybeArchive = null;
  try {
    maybeArchive = JSON.parse(content);
  } catch {
    maybeArchive = null;
  }
  if (detectRestHippo(maybeArchive)) {
    return applyRestHippoImport(maybeArchive);
  }

  return _importInspectedContent(content, inspectImport(content));
}

// Shared tail of the file-import (`handleImportBrowse` / `handleFilePathImport`)
// and URL-import (`handleUrlImport`) flows. Given raw interchange `content` and its pre-peeked
// `info` (from inspectImport): OpenAPI/Swagger specs are relative paths, so it
// prompts for a base-URL variable (name + value, pre-filled from the spec's
// server URL) so every imported request can reference {{name}} instead of a
// dangling/embedded host; other formats skip the prompt and parse as before.
// Returns true when a collection was applied, false on user cancel or a parse
// error (the error is surfaced via a notification).
async function _importInspectedContent(
  content,
  info,
  baseUrlDefault = info.openApiBaseUrl ?? "",
) {
  let importOptions;
  if (info.format === "openapi") {
    const choice = await SwaggerImportModal.open({
      defaultName: "baseUrl",
      defaultValue: baseUrlDefault,
    });
    if (!choice) return false; // user cancelled the import
    importOptions = {
      baseUrlVarName: choice.name,
      baseUrlValue: choice.value,
    };
  }

  let parsed;
  try {
    parsed = parseImport(content, importOptions);
  } catch (err) {
    Notifications.error(
      t("app.importFailed", { message: _importErrorText(err) }),
      { title: t("app.importTitle") },
    );
    return false;
  }

  return applyImportedCollection(parsed);
}

// Fetch an OpenAPI/Swagger spec from a live URL and import it. The fetch runs in
// the main process via the request engine (no browser CORS), then the body runs
// through the same inspect → base-URL prompt → parse → apply path as a file
// import. Restricted to OpenAPI/Swagger — any other recognized format is
// rejected so this entry stays a spec importer. Returns true once the spec is
// fetched and recognized (the URL modal closes and the base-URL prompt opens),
// false on any failure (the modal stays open; the error is surfaced via a
// notification). `header` is an optional auth header: a bare value is sent as
// Authorization, a "Name: Value" line as a custom header.
async function handleUrlImport(url, header) {
  // Desktop-only: the fetch needs the main-process request engine.
  if (typeof window.hippo?.http?.execute !== "function") {
    Notifications.info(t("app.importDesktopOnly"));
    return false;
  }

  const headers = {
    Accept: "application/json, application/yaml, text/yaml, */*",
  };
  if (header) {
    // "Name: Value" → a custom header, but only when the part before the colon
    // looks like a header name (no whitespace) — otherwise a bare token that
    // happens to contain a colon is sent whole as Authorization.
    const sep = header.indexOf(":");
    const name = sep > 0 ? header.slice(0, sep).trim() : "";
    if (name && !/\s/.test(name)) headers[name] = header.slice(sep + 1).trim();
    else headers.Authorization = header;
  }

  let result;
  try {
    result = await window.hippo.http.execute({
      method: "GET", // never mutate a server when fetching a spec
      url,
      headers,
      timeout: 30000,
      followRedirects: true,
      // Honor the user's SSL-verification setting so a self-signed host they can
      // already send to can also be imported from.
      verifySsl: currentSettings.verifySsl ?? true,
    });
  } catch (err) {
    Notifications.error(
      t("urlImport.errNetwork", { message: String(err?.message ?? err) }),
      { title: t("app.importTitle") },
    );
    return false;
  }

  // Network-level failure — no HTTP response was received (engine reports 0).
  if (result?.error && (result.status ?? 0) === 0) {
    Notifications.error(
      t("urlImport.errNetwork", {
        message: result.error.message || String(result.error),
      }),
      { title: t("app.importTitle") },
    );
    return false;
  }
  if (result.status < 200 || result.status >= 300) {
    Notifications.error(t("urlImport.errHttp", { status: result.status }), {
      title: t("app.importTitle"),
    });
    return false;
  }

  // Redeem a spilled (very large) body so the whole spec is parsed, not a preview.
  let content = typeof result.body === "string" ? result.body : "";
  if (result.truncated && result.bodyRef) {
    try {
      const full = await window.hippo.http.body.get(result.bodyRef);
      if (full?.body) content = full.body;
    } catch {
      // Fall through with the preview; parsing flags a truncated spec loudly.
    }
  }

  // Detect the format from the fetched body — any supported interchange type is
  // accepted, exactly like a file import. OpenAPI/Swagger additionally prompts
  // for a base-URL variable; every other format imports straight through.
  const info = inspectImport(content);

  if (info.format === "openapi") {
    // Default the base-URL variable to the host the spec was fetched from. A
    // relative `servers` path (e.g. "/api/v3") is anchored to that host so the
    // default is a complete, usable URL — the import domain — rather than a bare
    // path; an absolute server URL already declared in the spec is left as-is.
    let baseUrlDefault = info.openApiBaseUrl ?? "";
    if (!/^https?:\/\//i.test(baseUrlDefault)) {
      try {
        const fetched = new URL(url);
        const resolved = baseUrlDefault
          ? new URL(baseUrlDefault, fetched).href
          : fetched.origin;
        baseUrlDefault = resolved.endsWith("/")
          ? resolved.slice(0, -1)
          : resolved;
      } catch {
        // url was scheme-checked in the modal; keep the spec value on a parse error.
      }
    }

    // Close the URL modal first, then run the base-URL prompt + import —
    // PopupManager holds a single popup, so the prompt can't open over the
    // still-open URL modal. The modal's own close on a `true` return is then a
    // no-op (this flow already finished and closed it).
    PopupManager.close();
    await _importInspectedContent(content, info, baseUrlDefault);
    return true;
  }

  // Any other supported format (or an unrecognized body): no variable prompt.
  // Parse + apply with the URL modal still open so a failure (unparseable or
  // unsupported document) keeps it open and surfaces the error — the modal
  // closes only on success.
  return _importInspectedContent(content, info);
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
      t("app.importFailed", { message: _importErrorText(err) }),
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
        (await window.hippo?.import?.file?.checkMissing?.(filePaths)) ??
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
// (`_importFromContent`) and cURL paste (`handleCurlImport`). Returns true when
// the write succeeded, false otherwise.
async function applyImportedCollection(parsed) {
  const { collection, variables } = parsed;
  const activeId = currentColls.activeCollectionId;
  const newItems = [...(treeView?.getItems() ?? []), collection];

  if (treeView) treeView.setItems(newItems);

  // Persist the tree. saveCollectionData no longer throws on a write failure — it
  // routes the error to the write-error sink (a toast) and returns false — so
  // branch on the result and bail without claiming success rather than catching.
  const saved = await saveCollectionData(activeId, newItems);
  // The write-error sink already surfaced the failure; don't report success.
  if (!saved) return false;

  // Imported collection-level variables now land in the active collection's
  // Global environment (collection-level variables were removed). Existing
  // Global values win a name clash. Importers return the canonical array shape.
  const incoming = variables ?? [];
  if (incoming.length > 0) {
    const byName = new Map();
    for (const entry of incoming) byName.set(entry.name, entry);
    for (const entry of normalizeVariables(currentEnvironments.globalVariables))
      byName.set(entry.name, entry);
    const merged = [...byName.values()];
    await handleEnvVarsSave({ id: null, variables: merged });
    collPopup.update(collPopupState());
    envPicker.load(currentEnvironments);
  }

  const count = _countRequests(collection);
  const base = t("app.importedRequests", { count, name: collection.name });
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
