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
import { ResponseViewer } from "./components/response-viewer.js";
import { SettingsPopup } from "./components/settings-popup.js";
import { CollectionsPopup } from "./components/collections-popup.js";
import { VariablesPopup } from "./components/variables-popup.js";
import { EnvironmentsPopup } from "./components/environments-popup.js";
import { EnvPicker } from "./components/env-picker.js";
import {
  loadAll,
  saveCollections,
  saveSettings,
  saveManifest,
  loadCollectionData,
  saveCollectionData,
  setActiveCollection,
  saveCollectionVariables,
  deleteRequest,
  listHistory,
  addHistory,
  getHistoryResponse,
  deleteHistory,
  trimHistory,
} from "./data-store.js";
import { buildFolderChain } from "./components/variable-resolver.js";
import { setPickerDebounceMs } from "./components/variable-pill-editor.js";
import { parseImport } from "./import/index.js";
import { exportToPostman } from "./export/postman.js";
import { PopupManager } from "./popup-manager.js";

// ─── History state ────────────────────────────────────────────────────────────
// Per-request in-memory execution history. Keyed by request node ID.
// Each entry: { id, requestNode, requestUrl, response, timestamp }
const _requestHistory = new Map();
// Tracks which request IDs have been fully loaded from persistent storage.
const _historyLoaded = new Set();
let _maxHistory = 5; // updated from settings at startup and on change
let _skipNextHistory = false; // set true when replaying a history entry

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

  const authType = node.authType ?? "none";
  const authEnabled = node.authEnabled ?? true;
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
  }

  const bodyType = node.bodyType ?? "no-body";
  let bodyContent = "";
  if (bodyType === "form-data" || bodyType === "form-urlencoded") {
    const rows = Array.isArray(node.bodyFormRows) ? node.bodyFormRows : [];
    bodyContent = rows
      .map((r) => `${r.enabled ? "" : "# "}${r.name}=${r.value}`)
      .join("\n");
  } else if (bodyType === "file") {
    bodyContent = node.bodyFilePath ?? "";
  } else {
    bodyContent = node.bodyText ?? "";
  }

  return {
    id: node.id,
    method: node.method ?? "GET",
    url: node.url ?? "",
    params: paramsBulk,
    headers: headersBulk,
    authType,
    authEnabled,
    auth: authBulk,
    bodyType,
    body: bodyContent,
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
      window.wurl.ui.editContextMenu(e.clientX, e.clientY);
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

  initPanels();
  initComponents();
  initSplitters();
  initEventBus();
  initHeader();
  await initCollections();
  installZoomHandlers();
});

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

function initComponents() {
  treeView = new TreeView();
  requestEditor = new RequestEditor();
  responseViewer = new ResponseViewer();

  panelNav.mount(treeView);
  panelRequest.mount(requestEditor);
  panelResponse.mount(responseViewer);

  requestEditor.setGetItems(() => getAllRequests(treeView?.getItems() ?? []));
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
  currentSettings = {
    ...currentSettings,
    splitterNav: splitterSizes.nav,
    splitterRes: splitterSizes.res,
    splitterRowRes: splitterSizes.rowRes,
  };
  saveSettings(currentSettings);
}

/** Returns the #app-main element (cached after first call). */
let _appMain = null;
function getAppMain() {
  return (_appMain ??= document.getElementById("app-main"));
}

// ─── Manual layout ────────────────────────────────────────────────────────────

/** Current pinned layout (1–4). Always set; default matches DEFAULT_SETTINGS. */
let _currentLayout = 1;

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
}

/** Build the detached env/layout/settings control group element. */
function buildCtrlGroup() {
  const group = document.createElement("div");
  group.className = "header-ctrl-group";
  group.innerHTML = `
    <span class="ctrl-divider" aria-hidden="true"></span>
    <button class="header-icon-btn" id="btn-collection-ctrl"
        title="Collections" aria-label="Open Collections">
      <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24"
           fill="none" stroke="currentColor" stroke-width="2"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polygon points="12 2 2 7 12 12 22 7 12 2"/>
        <polyline points="2 17 12 22 22 17"/>
        <polyline points="2 12 12 17 22 12"/>
      </svg>
    </button>
    <button class="env-picker__trigger" id="btn-env-picker-ctrl"
        title="Environment" aria-label="Select environment"
        aria-haspopup="listbox"></button>
    <button class="layout-picker__trigger" id="btn-layout-ctrl"
        aria-haspopup="listbox" aria-label="Change layout" title="Change layout"></button>
    <button class="header-icon-btn" id="btn-settings-ctrl"
        title="Settings" aria-label="Open settings">
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
      const max =
        getEffectiveSplitterMode() === "portrait"
          ? appMain.clientHeight * 0.5
          : appMain.clientWidth * 0.5;
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
        splitterSizes.res = Math.min(max, Math.max(SPLITTER_MIN_RES, v));
      } else {
        const max = appMain.clientHeight * 0.5;
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
const envPopup = new CollectionsPopup();
const varsPopup = new VariablesPopup();
const environmentsPopup = new EnvironmentsPopup();
const envPicker = new EnvPicker({
  onManage: () =>
    environmentsPopup.open(currentEnvironments, {
      bulkEditor: currentSettings.varsBulkEditor ?? true,
    }),
});
const layoutPicker = new LayoutPicker({
  onSelect: (layout) => {
    applyLayout(layout);
    currentSettings = { ...currentSettings, layout };
    saveSettings(currentSettings);
  },
});
let currentSettings = {};

/** Live collection state — kept in sync with data-store. */
let currentColls = {
  collections: [],
  activeCollectionId: null,
};

/** Live environment state — kept in sync with data-store. */
let currentEnvironments = {
  version: 1,
  globalVariables: {},
  activeEnvironmentId: null,
  environments: [],
};

/** Map currentColls to the shape CollectionsPopup expects. */
const envPopupState = () => ({
  collections: currentColls.collections,
  activeCollectionId: currentColls.activeCollectionId,
});

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
    envPopup.open(envPopupState());
  });
  document
    .getElementById("btn-collection-nav")
    .addEventListener("click", () => {
      envPopup.open(envPopupState());
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
  _ctrlGroup
    .querySelector("#btn-collection-ctrl")
    .addEventListener("click", () => envPopup.open(envPopupState()));
  envPicker.bindTrigger(_ctrlGroup.querySelector("#btn-env-picker-ctrl"));
  _ctrlGroup
    .querySelector("#btn-settings-ctrl")
    .addEventListener("click", () => settingsPopup.open(currentSettings));
  _ctrlGroup
    .querySelector("#btn-collection-ctrl")
    .addEventListener("contextmenu", _openCollCtxMenu);
}

/** Open the native OS context menu for the active collection. */
async function _showCollContextMenu(x, y) {
  const actions = {
    rename: () => envPopup.openWithRename(envPopupState()),
    variables: () => {
      const activeColl = currentColls.collections.find(
        (c) => c.id === currentColls.activeCollectionId,
      );
      if (!activeColl) return;
      varsPopup.open({
        envId: activeColl.id,
        envName: activeColl.name,
        variables: activeColl.variables ?? {},
        bulkEditor: currentSettings.varsBulkEditor ?? true,
      });
    },
  };

  const clickedId = await window.wurl.ui.contextMenu({
    items: [
      { id: "rename", label: "Rename" },
      { type: "separator" },
      { id: "variables", label: "Variables" },
    ],
    x,
    y,
  });

  if (clickedId) actions[clickedId]?.();
}

// ─── Event bus ────────────────────────────────────────────────────────────────
function initEventBus() {
  // When a request is selected in the tree, load it into the editor
  window.addEventListener("wurl:request-selected", async (e) => {
    const node = e.detail;
    _selectedNode = node;
    // Set variable context BEFORE load() so pill editors render with correct validation
    _refreshEditorVariableContext(node.id);
    requestEditor.load(node);
    // Persist the selected node ID per-collection so it can be restored on reload
    const id = node?.id;
    if (id) {
      const selectedRequestIds = {
        ...(currentSettings.selectedRequestIds ?? {}),
        [currentColls.activeCollectionId]: id,
      };
      currentSettings = { ...currentSettings, selectedRequestIds };
      saveSettings(currentSettings);
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

  // Cache response data so function pills like response() / responseHeader() can resolve
  window.addEventListener("wurl:response-received", async (e) => {
    // Capture and reset the skip flag immediately so it is never left stale.
    const skipHistory = _skipNextHistory;
    _skipNextHistory = false;

    const node = _selectedNode;
    const name = node?.name;
    if (!name) return;

    // Record in per-request history only for real (non-replay) executions.
    // When replaying a historical entry, do NOT push to history and do NOT
    // re-render the timeline (which would clear the user's current selection).
    if (!skipHistory && _maxHistory > 0 && node?.id) {
      const histId = crypto.randomUUID();
      const nowMs = Date.now();
      const reqUrl = _lastRequestSnapshot?.url ?? "";
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
      _refreshEditorVariableContext(node.id);
      _dispatchTimelineUpdate(node.id);
    }
  });

  // Record network-level failures (ENOTFOUND, ETIMEDOUT, etc.) in the timeline.
  // Cancellations and "no URL" guards are excluded — only genuine request attempts
  // that reached the network layer are recorded.
  window.addEventListener("wurl:request-error", async (e) => {
    const skipHistory = _skipNextHistory;
    _skipNextHistory = false;

    if (skipHistory) return;
    if (_cancelCurrentRequest) return;
    if (e.detail?.name === "AbortError") return;
    if (!_lastRequestSnapshot) return;

    const node = _selectedNode;
    if (!node?.id || _maxHistory <= 0) return;

    const histId = crypto.randomUUID();
    const nowMs = Date.now();
    const reqUrl = _lastRequestSnapshot.url ?? "";
    const reqNode = JSON.parse(JSON.stringify(node));
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
    _dispatchTimelineUpdate(node.id);
  });

  // Auto-save whenever the tree is mutated (add / remove collection or request)
  window.addEventListener("wurl:collections-changed", (e) => {
    saveCollections(e.detail);
  });

  // Import a collection from an external file (Postman / Insomnia / OpenAPI).
  // Triggered by the toolbar button in tree-view or the File > Import menu item.
  window.addEventListener("wurl:import-requested", () => handleImport());

  // Export a collection to a Postman v2.1 JSON file.
  // Triggered by "Export Collection…" in the collection context menu.
  window.addEventListener("wurl:export-collection", (e) =>
    handleExport(e.detail.collection),
  );

  // Delete the backing request file(s) when a node is removed from the tree.
  // Fired by tree-view after #deleteNode; ids contains every request under the
  // deleted node (a single request, or all requests in a deleted folder/collection).
  window.addEventListener("wurl:requests-deleted", (e) => {
    for (const id of e.detail.ids) {
      deleteRequest(id);
      _requestHistory.delete(id);
      _historyLoaded.delete(id);
    }
  });

  // Persist settings immediately whenever any control in the popup changes.
  // Merge into currentSettings so fields not emitted by the popup (splitters,
  // selectedRequestIds, historyCount) are not silently dropped on each save.
  window.addEventListener("wurl:settings-changed", (e) => {
    currentSettings = { ...currentSettings, ...e.detail };
    applySettings(currentSettings);
    saveSettings(currentSettings);
    if (e.detail.historyCount !== undefined) {
      _maxHistory = e.detail.historyCount;
    }
  });

  // Trim all per-request histories to the new max (fired only on settings Close click)
  window.addEventListener("wurl:history-trim", (e) => {
    _maxHistory = Math.max(
      0,
      Math.min(10, e.detail?.historyCount ?? _maxHistory),
    );
    for (const [id, entries] of _requestHistory.entries()) {
      while (entries.length > _maxHistory) {
        const old = entries.pop();
        if (old?.id) deleteHistory(id, old.id);
      }
      if (_maxHistory === 0) _requestHistory.delete(id);
    }
    // Sweep on-disk history for requests not yet loaded into _requestHistory.
    trimHistory(_maxHistory).catch(console.error);
    _dispatchTimelineUpdate(_selectedNode?.id);
  });

  // Replay a historical entry: restore the request editor state and display the
  // saved response without actually re-running the request.
  window.addEventListener("wurl:timeline-select", (e) => {
    const { requestNode, requestUrl = "", response } = e.detail;
    const restoredNode = requestEditor.loadSnapshot(requestNode);
    if (restoredNode?.id) {
      const { id, ...nodeFields } = restoredNode;
      treeView.updateNode(id, nodeFields, { silent: true });
      _selectedNode = { ..._selectedNode, id, ...nodeFields };
      _scheduleRequestSave();
    }
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
  });

  // When the request editor fires a preference change (e.g. List Headers toggle),
  // merge into currentSettings and persist.
  window.addEventListener("wurl:editor-setting-changed", (e) => {
    currentSettings = { ...currentSettings, ...e.detail };
    saveSettings(currentSettings);
  });

  // ── Collection events ────────────────────────────────────────────────────

  /** Switch the active collection: save current items, load new ones. */
  window.addEventListener("wurl:coll-select", async (e) => {
    const { id } = e.detail;
    if (id === currentColls.activeCollectionId) return;

    // Persist the current collection's items before switching
    if (treeView)
      await saveCollectionData(
        currentColls.activeCollectionId,
        treeView.getItems(),
      );

    // Update in-memory active collection
    setActiveCollection(id);
    currentColls = { ...currentColls, activeCollectionId: id };

    // Persist manifest
    await saveManifest({
      collections: currentColls.collections,
      activeCollectionId: id,
    });

    // Load new collection's items
    const { items, variables } = await loadCollectionData(id);
    treeView.setStorageKey(id);
    treeView.setItems(items);

    // Restore previously selected request for this collection, or clear if none
    const savedId = currentSettings.selectedRequestIds?.[id];
    if (!savedId || !treeView.selectById(savedId)) {
      _selectedNode = null;
      _clearRequestEditor();
    }

    // Attach variables to the collection entry in memory
    currentColls = {
      ...currentColls,
      collections: currentColls.collections.map((coll) =>
        coll.id === id ? { ...coll, variables: variables ?? {} } : coll,
      ),
    };

    // Update UI
    setNavPanelTitle(_collName(currentColls.collections, id));
    envPopup.update(envPopupState());
    // Refresh pill editor variable context for the new collection
    _refreshEditorVariableContext();
  });

  /** Add a new (empty) collection and switch to it. */
  window.addEventListener("wurl:coll-add", async (e) => {
    const { name } = e.detail;
    const newColl = { id: crypto.randomUUID(), name };
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
    envPopup.update(envPopupState());
  });

  /** Clone a collection: deep-copy its items with new UUIDs, then switch. */
  window.addEventListener("wurl:coll-clone", async (e) => {
    const { sourceId, name } = e.detail;
    const newColl = { id: crypto.randomUUID(), name };

    // Load source items (if source is currently active, use the live tree)
    let sourceItems;
    let sourceVariables;
    if (sourceId === currentColls.activeCollectionId) {
      sourceItems = treeView ? treeView.getItems() : [];
      sourceVariables =
        currentColls.collections.find((c) => c.id === sourceId)?.variables ??
        {};
    } else {
      const loaded = await loadCollectionData(sourceId);
      sourceItems = loaded.items;
      sourceVariables = loaded.variables ?? {};
    }

    // Deep-clone items with new UUIDs; copy variables directly
    const cloned = sourceItems.map(_deepCloneWithNewIds);
    const clonedVariables = { ...sourceVariables };

    // Save cloned items + variables and switch to the new collection
    await saveCollectionData(newColl.id, cloned, clonedVariables);
    if (treeView)
      await saveCollectionData(
        currentColls.activeCollectionId,
        treeView.getItems(),
      );

    const collections = [
      ...currentColls.collections,
      { ...newColl, variables: clonedVariables },
    ];
    setActiveCollection(newColl.id);
    currentColls = { collections, activeCollectionId: newColl.id };

    await saveManifest({ collections, activeCollectionId: newColl.id });

    treeView.setStorageKey(newColl.id);
    treeView.setItems(cloned);
    _selectedNode = null;
    _clearRequestEditor();
    setNavPanelTitle(newColl.name);
    envPopup.update(envPopupState());
  });

  /** Rename a collection — updates its display name everywhere without touching its items. */
  window.addEventListener("wurl:coll-rename", async (e) => {
    const { id, name } = e.detail;
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

    envPopup.update(envPopupState());
  });

  /** Delete a collection (must always leave at least 1). */
  window.addEventListener("wurl:coll-delete", async (e) => {
    const { id } = e.detail;
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
        coll.id === activeId ? { ...coll, variables: variables ?? {} } : coll,
      );
    } else {
      setActiveCollection(activeId);
    }

    currentColls = { collections, activeCollectionId: activeId };
    await saveManifest({ collections, activeCollectionId: activeId });
    envPopup.update(envPopupState());
  });

  // ── Variable events ──────────────────────────────────────────────────────

  /** Open the variables popup for a folder node. */
  window.addEventListener("wurl:folder-vars-open", (e) => {
    const { nodeId, folderName, variables } = e.detail;
    varsPopup.open({
      envId: nodeId,
      envName: folderName,
      variables: variables ?? {},
      bulkEditor: currentSettings.varsBulkEditor ?? true,
    });
  });

  /**
   * Persist variables and keep in-memory state in sync.
   * The `envId` field doubles as a folder-node ID when it doesn't match any
   * collection — in that case the variables are stored on the tree node.
   */
  window.addEventListener("wurl:vars-save", async (e) => {
    const { envId, variables } = e.detail;

    const isColl = currentColls.collections.some((coll) => coll.id === envId);

    if (isColl) {
      // Update in-memory collection state
      currentColls = {
        ...currentColls,
        collections: currentColls.collections.map((coll) =>
          coll.id === envId ? { ...coll, variables } : coll,
        ),
      };
      saveCollectionVariables(envId, variables);
    } else {
      // It's a folder node — patch the tree and persist collections
      if (treeView) {
        treeView.updateNode(envId, { variables }, { silent: true });
        await saveCollections(treeView.getItems());
      }
    }

    // Revalidate pill editors in the request panel for the updated context
    _refreshEditorVariableContext(
      currentSettings.selectedRequestIds?.[currentColls.activeCollectionId],
    );
  });

  /** Persist the Bulk Editor toggle preference into settings. */
  window.addEventListener("wurl:vars-bulk-editor-changed", (e) => {
    currentSettings = {
      ...currentSettings,
      varsBulkEditor: e.detail.bulkEditor,
    };
    saveSettings(currentSettings);
  });

  // ── Environment event handlers ───────────────────────────────────────────

  window.addEventListener("wurl:environments-changed", async (e) => {
    currentEnvironments = e.detail.data;
    await window.wurl.store.environments.save(currentEnvironments);
    environmentsPopup.update(currentEnvironments);
    _refreshEditorVariableContext();
    envPicker.load(currentEnvironments);
  });

  window.addEventListener("wurl:env-activate", async (e) => {
    currentEnvironments = {
      ...currentEnvironments,
      activeEnvironmentId: e.detail.id,
    };
    await window.wurl.store.environments.save(currentEnvironments);
    environmentsPopup.update(currentEnvironments);
    _refreshEditorVariableContext();
    envPicker.load(currentEnvironments);
  });

  window.addEventListener("wurl:env-vars-save", async (e) => {
    const { id, variables } = e.detail;
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
    await window.wurl.store.environments.save(currentEnvironments);
    _refreshEditorVariableContext();
  });

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
    const folderChain =
      treeView && id ? buildFolderChain(treeView.getItems(), id) : [];
    const activeColl = currentColls.collections.find(
      (coll) => coll.id === currentColls.activeCollectionId,
    );
    const envVariables = activeColl?.variables ?? {};
    const node =
      _selectedNode ??
      (id && treeView ? _findNodeById(treeView.getItems(), id) : null);

    const activeEnvId = currentEnvironments.activeEnvironmentId;
    const activeEnv = currentEnvironments.environments.find(
      (e) => e.id === activeEnvId,
    );
    const environmentVariables = activeEnv?.variables ?? {};
    const globalVariables = currentEnvironments.globalVariables ?? {};

    requestEditor.setVariableContext({
      envVariables,
      environmentVariables,
      globalVariables,
      folderChain,
      envName: activeColl?.name ?? "",
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
        ...envVariables,
      });
    }
  }

  // When the request editor mutates a field (method, url, params, body, auth, …),
  // immediately sync the in-memory tree and update the visible tree-view node
  // (e.g. the method badge), then schedule a debounced storage write so that
  // rapid typing does not flood the persistence layer with individual saves.
  let _requestSaveTimer = null;
  function _scheduleRequestSave() {
    clearTimeout(_requestSaveTimer);
    _requestSaveTimer = setTimeout(() => {
      if (treeView) saveCollections(treeView.getItems());
    }, 400);
  }

  window.addEventListener("wurl:request-updated", (e) => {
    const { id, ...fields } = e.detail;
    if (id && treeView) {
      // silent=true → in-memory patch + DOM update, no immediate #emitChange
      treeView.updateNode(id, fields, { silent: true });
      // Debounced write so keystrokes batch into a single save
      _scheduleRequestSave();
      // Mirror the patch onto _selectedNode so history captures the latest
      // editor state. updateNode() creates a new object in the tree, so
      // _selectedNode would otherwise remain stale until the next selection.
      if (_selectedNode?.id === id) {
        _selectedNode = { ..._selectedNode, ...fields };
      }
    }
  });

  // Active AbortController for the current in-flight Go-dev-mode request
  let _activeAbortController = null;
  // Flag set when the user cancels; prevents stale results from being displayed
  let _cancelCurrentRequest = false;
  // Snapshot of the most-recently-started request (used in cancel error detail)
  let _lastRequestSnapshot = null;
  // Currently selected tree node (request or folder), for context functions
  let _selectedNode = null;
  // Response caches keyed by request name — fed into variable context for function pills
  let _responseCache = {};
  let _responseHeaders = {};
  let _responseStatus = {};

  // Lazy-load response caches when a request is executed that references another request
  requestEditor?.setEnsureResponseCaches(async (names) => {
    const allRequests = getAllRequests(treeView?.getItems() ?? []);
    await Promise.all(
      names.map(async (name) => {
        const req = allRequests.find((r) => r.name === name);
        if (!req) return;
        if (!_historyLoaded.has(req.id)) {
          await _loadRequestHistory(req.id);
          _historyLoaded.add(req.id);
        }
        const entries = _requestHistory.get(req.id) ?? [];
        const latest = entries[0];
        if (latest) {
          _responseCache[name] = latest.response?.body ?? "";
          _responseHeaders[name] = latest.response?.headers ?? {};
          _responseStatus[name] = latest.response?.status ?? 0;
        }
      }),
    );
  });

  window.addEventListener("wurl:cancel-request", () => {
    _cancelCurrentRequest = true;
    if (_activeAbortController) {
      _activeAbortController.abort();
      _activeAbortController = null;
    }
    // Give instant feedback: treat cancel as an error
    window.dispatchEvent(
      new CustomEvent("wurl:request-error", {
        detail: {
          request: _lastRequestSnapshot ?? {
            method: "GET",
            url: "",
            headers: {},
            body: null,
          },
          name: "AbortError",
          message: "Request cancelled.",
          hint: "The request was cancelled by the user.",
          elapsed: 0,
          consoleLog: ["* Request cancelled by user"],
        },
      }),
    );
  });

  // ── classify common network failures for a human-readable hint ──────────────
  function _buildHint(errName, msg) {
    if (errName === "AbortError") return "The request was aborted.";
    if (/cors/i.test(msg))
      return "CORS policy blocked the request — the server may need to send Access-Control-Allow-Origin headers.";
    if (
      /failed to fetch|load failed|networkerror|network request failed/i.test(
        msg,
      )
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

  // When the request editor fires a send, execute the request via the
  // native layer (Electron IPC or the Go dev-server proxy endpoint).
  window.addEventListener("wurl:send-request", async (e) => {
    const descriptor = e.detail;

    // ── Guard: URL must be a non-empty string ────────────────────────────────
    const rawUrl = descriptor?.url;
    if (!rawUrl || typeof rawUrl !== "string" || !rawUrl.trim()) {
      window.dispatchEvent(
        new CustomEvent("wurl:request-error", {
          detail: {
            request: {
              method: descriptor?.method ?? "GET",
              url: rawUrl ?? "",
              headers: {},
              body: null,
            },
            name: "TypeError",
            message: "No URL specified.",
            hint: "Enter a URL in the request bar before sending.",
            elapsed: 0,
            consoleLog: ["* Error: No URL specified."],
          },
        }),
      );
      return;
    }

    window.dispatchEvent(new CustomEvent("wurl:request-loading"));

    _cancelCurrentRequest = false;
    _lastRequestSnapshot = {
      method: descriptor.method,
      url: descriptor.url,
      headers: descriptor.headers ?? {},
      body: typeof descriptor.body === "string" ? descriptor.body : null,
    };

    // ── Build the descriptor for the native layer ────────────────────────────
    const nativeDesc = {
      method: descriptor.method,
      url: descriptor.url,
      headers: descriptor.headers ?? {},
      body: typeof descriptor.body === "string" ? descriptor.body : null,
      bodyFilePath: descriptor.bodyFilePath ?? null,
      timeout: currentSettings.timeout ?? 30000,
      followRedirects: currentSettings.followRedirects ?? true,
      verifySsl: currentSettings.verifySsl ?? true,
      awsIam: descriptor.awsIam ?? null,
      proxy:
        currentSettings.proxyEnabled && currentSettings.proxyUrl
          ? currentSettings.proxyUrl
          : null,
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
        _activeAbortController = controller;

        const res = await fetch("/api/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(nativeDesc),
          signal: controller.signal,
        });
        _activeAbortController = null;

        if (!res.ok) throw new Error(`Execute API returned HTTP ${res.status}`);
        result = await res.json();
      }

      // Discard the result if the user already cancelled
      if (_cancelCurrentRequest) return;

      // ── Dispatch result ──────────────────────────────────────────────────
      if (result.error && result.status === 0) {
        // Network-level failure — no HTTP response received
        window.dispatchEvent(
          new CustomEvent("wurl:request-error", {
            detail: {
              request: _lastRequestSnapshot,
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
              request: _lastRequestSnapshot,
              status: result.status,
              statusText: result.statusText,
              headers: result.headers ?? {},
              cookies: result.cookies ?? [],
              body: result.body ?? "",
              elapsed: result.elapsed ?? 0,
              size: result.size ?? 0,
              consoleLog: result.consoleLog ?? [],
            },
          }),
        );
      }
    } catch (err) {
      if (_cancelCurrentRequest) return;
      _activeAbortController = null;

      const errName = (err instanceof Error ? err.name : "Error") || "Error";
      const msg = (err instanceof Error ? err.message : String(err)) || "";

      window.dispatchEvent(
        new CustomEvent("wurl:request-error", {
          detail: {
            request: _lastRequestSnapshot,
            name: errName,
            message: msg,
            hint: _buildHint(errName, msg),
            elapsed: 0,
            consoleLog: [`* ${errName}: ${msg}`],
          },
        }),
      );
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
      ? { ...coll, variables: variables ?? {} }
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

    currentSettings = { ...currentSettings, fontSize: newSize };
    applySettings(currentSettings);
    saveSettings(currentSettings);
  }

  /** Reset to the default font size. */
  function resetFont() {
    if ((currentSettings.fontSize ?? DEFAULT_FONT) === DEFAULT_FONT) return;
    currentSettings = { ...currentSettings, fontSize: DEFAULT_FONT };
    applySettings(currentSettings);
    saveSettings(currentSettings);
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
      detail: { entries: [...entries], isRequestSwitch },
    }),
  );
}

/** Deep-clone a tree node, assigning fresh UUIDs throughout. */
function _deepCloneWithNewIds(node) {
  const clone = { ...node, id: crypto.randomUUID() };
  if (Array.isArray(node.children)) {
    clone.children = node.children.map(_deepCloneWithNewIds);
  }
  // Regenerate IDs for request-level row arrays
  if (Array.isArray(node.bodyFormRows)) {
    clone.bodyFormRows = node.bodyFormRows.map((r) => ({
      ...r,
      id: crypto.randomUUID(),
    }));
  }
  if (Array.isArray(node.params)) {
    clone.params = node.params.map((r) => ({ ...r, id: crypto.randomUUID() }));
  }
  if (Array.isArray(node.headers)) {
    clone.headers = node.headers.map((r) => ({
      ...r,
      id: crypto.randomUUID(),
    }));
  }
  return clone;
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

function applySettings(settings) {
  // Theme — stored as a data attribute so CSS [data-theme="latte"] etc. applies
  if (settings.theme) {
    document.documentElement.dataset.theme = settings.theme;
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
  if (treeView)
    treeView.setDoubleClickExecute(settings.doubleClickExecute ?? false);
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

/** Count all request nodes recursively in a collection tree. */
function _countRequests(node) {
  if (node.type === "request") return 1;
  return (node.children ?? []).reduce(
    (sum, child) => sum + _countRequests(child),
    0,
  );
}

/**
 * Export a collection to a Postman v2.1 JSON file via the native save dialog.
 * @param {object} collection  Wurl collection node
 */
async function handleExport(collection) {
  if (!window.wurl?.export?.saveFile) {
    PopupManager.notify({
      title: "Export",
      message: "Export is only available in the desktop app.",
    });
    return;
  }

  let variables = {};
  try {
    const data = await loadCollectionData(currentColls.activeCollectionId);
    variables = data.variables ?? {};
  } catch {
    /* non-fatal — export without collection variables */
  }

  const content = exportToPostman(collection, variables);
  const safeName = (collection.name ?? "collection").replace(
    /[^a-z0-9_-]/gi,
    "_",
  );

  try {
    const saved = await window.wurl.export.saveFile(
      `${safeName}.json`,
      content,
    );
    if (saved) {
      PopupManager.notify({
        title: "Export Successful",
        message: `"${collection.name}" exported as Postman v2.1.`,
      });
    }
  } catch (err) {
    PopupManager.notify({
      title: "Export Failed",
      message: String(err.message ?? err),
    });
  }
}

async function handleImport() {
  if (!window.wurl?.import?.openFile) {
    PopupManager.notify({
      title: "Import",
      message: "Import is only available in the desktop app.",
    });
    return;
  }

  let file;
  try {
    file = await window.wurl.import.openFile();
  } catch (err) {
    PopupManager.notify({
      title: "Import Failed",
      message: String(err.message ?? err),
    });
    return;
  }
  if (!file) return; // user cancelled the file dialog

  let parsed;
  try {
    parsed = parseImport(file.content);
  } catch (err) {
    PopupManager.notify({
      title: "Import Failed",
      message: String(err.message ?? err),
    });
    return;
  }

  const { collection, variables } = parsed;
  const activeId = currentColls.activeCollectionId;
  const newItems = [...(treeView?.getItems() ?? []), collection];

  if (treeView) treeView.setItems(newItems);

  try {
    if (variables && Object.keys(variables).length > 0) {
      // Merge import variables with existing ones — existing values take precedence.
      const { variables: current } = await loadCollectionData(activeId);
      const merged = { ...variables, ...current };
      await saveCollectionData(activeId, newItems, merged);
      if (treeView) treeView.setEnvVariables(merged);
    } else {
      await saveCollectionData(activeId, newItems);
    }
  } catch (err) {
    PopupManager.notify({
      title: "Import Warning",
      message: `Collection imported but could not be saved: ${err.message}`,
    });
    return;
  }

  const count = _countRequests(collection);
  PopupManager.notify({
    title: "Import Successful",
    message: `"${collection.name}" imported with ${count} request${count !== 1 ? "s" : ""}.`,
  });
}
