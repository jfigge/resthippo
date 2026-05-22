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
import { EnvironmentPopup } from "./components/environment-popup.js";
import { VariablesPopup } from "./components/variables-popup.js";
import {
  loadAll, saveCollections, saveSettings, saveManifest,
  loadEnvCollections, saveEnvCollections, setActiveEnvironment,
  saveEnvVariables, deleteRequest,
  listHistory, addHistory, getHistoryResponse, deleteHistory,
} from "./data-store.js";
import { buildFolderChain } from "./components/variable-resolver.js";
import { setPickerDebounceMs } from "./components/variable-pill-editor.js";

// ─── History state ────────────────────────────────────────────────────────────
// Per-request in-memory execution history. Keyed by request node ID.
// Each entry: { id, requestNode, requestUrl, response, timestamp }
const _requestHistory = new Map();
// Tracks which request IDs have been fully loaded from persistent storage.
const _historyLoaded  = new Set();
let _maxHistory = 5;        // updated from settings at startup and on change
let _skipNextHistory = false; // set true when replaying a history entry

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
    const entries = await Promise.all(items.map(async (meta) => {
      const payload = await getHistoryResponse(requestId, meta.id).catch(() => null);
      return {
        id:          meta.id,
        requestNode: meta.requestNode,
        requestUrl:  meta.requestUrl ?? "",
        response: {
          request:    payload?.request    ?? {},
          error:      payload?.error      ?? null,
          status:     meta.status     ?? 0,
          statusText: meta.statusText ?? "",
          elapsed:    meta.elapsed    ?? 0,
          size:       meta.size       ?? 0,
          headers:    payload?.headers    ?? {},
          cookies:    payload?.cookies    ?? [],
          body:       payload?.body       ?? "",
          consoleLog: payload?.consoleLog ?? [],
        },
        timestamp: meta.timestamp ?? Date.now(),
      };
    }));
    _requestHistory.set(requestId, entries);
  } catch (err) {
    console.warn(`[app] _loadRequestHistory(${requestId}) failed:`, err.message);
    _requestHistory.set(requestId, []);
  }
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  // Suppress the browser's native context menu everywhere — the app provides
  // its own custom context menus on tree nodes.
  document.addEventListener("contextmenu", (e) => e.preventDefault());

  // Set --font-ui to the OS-native context-menu typeface so custom menus
  // feel native. Each major OS uses a distinct system font for its menus.
  const PLATFORM_UI_FONTS = {
    "darwin": '-apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif',
    "win32":  '"Segoe UI Variable", "Segoe UI", sans-serif',
    "linux":  'system-ui, "Ubuntu", "Cantarell", sans-serif',
  };
  const platform  = window.wurl?.platform ?? "linux";
  const uiFont    = PLATFORM_UI_FONTS[platform] ?? PLATFORM_UI_FONTS.linux;
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
const SPLITTER_MIN_NAV    = 100;
const SPLITTER_MIN_RES    = 100;
const SPLITTER_MIN_ROWRES = 120;

let splitterSizes = {
  nav:    300,
  res:    500,
  rowRes: 320,
};

/** Push current splitter sizes into the CSS grid on #app-main. */
function applyGridVars() {
  const appMain = getAppMain();
  appMain.style.setProperty("--col-nav",  `${splitterSizes.nav}px`);
  appMain.style.setProperty("--col-res",  `${splitterSizes.res}px`);
  appMain.style.setProperty("--row-res",  `${splitterSizes.rowRes}px`);
}

/** Persist current splitter positions into the settings document. */
function saveSplitterPositions() {
  currentSettings = {
    ...currentSettings,
    splitterNav:    splitterSizes.nav,
    splitterRes:    splitterSizes.res,
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
}

function initSplitters() {
  const spl1El = document.getElementById("splitter-1");
  const spl2El = document.getElementById("splitter-2");

  applyGridVars();

  // Splitter 1 — always resizes the nav panel (--col-nav).
  // Flow: horizontal when nav is a column (layouts 1–3), vertical when stacked (layout 4).
  _splitter1 = makeSplitter(spl1El, {
    getFlow: () => (getEffectiveSplitterMode() === "portrait" ? "column" : "row"),
    getSize: () => splitterSizes.nav,
    setSize: (v) => {
      const appMain = getAppMain();
      const max = getEffectiveSplitterMode() === "portrait"
        ? appMain.clientHeight * 0.5
        : appMain.clientWidth  * 0.5;
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
    getFlow: () => (getEffectiveSplitterMode() === "landscape" ? "row" : "column"),
    getSize: () =>
      getEffectiveSplitterMode() === "landscape" ? splitterSizes.res : splitterSizes.rowRes,
    setSize: (v) => {
      const appMain = getAppMain();
      if (getEffectiveSplitterMode() === "landscape") {
        const max = appMain.clientWidth * 0.5;
        splitterSizes.res    = Math.min(max, Math.max(SPLITTER_MIN_RES,    v));
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
function makeSplitter(el, { getFlow, getSize, setSize, onDragEnd, invert = false }) {
  let dragging  = false;
  let startPos  = 0;
  let startSize = 0;
  let dragFlow  = "row";

  function clientPos(e) {
    const src = e.touches ? e.touches[0] : e;
    return dragFlow === "row" ? src.clientX : src.clientY;
  }

  function onStart(e) {
    e.preventDefault();
    dragFlow  = getFlow();
    dragging  = true;
    startPos  = clientPos(e);
    startSize = getSize();
    el.classList.add("splitter--dragging");
    document.body.style.cursor     = dragFlow === "row" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  }

  function onMove(e) {
    if (!dragging) return;
    if (e.cancelable) e.preventDefault();
    const rawDelta = clientPos(e) - startPos;
    const delta    = invert ? -rawDelta : rawDelta;
    setSize(startSize + delta);
  }

  function onEnd() {
    if (!dragging) return;
    dragging = false;
    el.classList.remove("splitter--dragging");
    document.body.style.cursor     = "";
    document.body.style.userSelect = "";
    window.removeEventListener("mousemove",  onMove);
    window.removeEventListener("mouseup",    onEnd);
    window.removeEventListener("touchmove",  onMove);
    window.removeEventListener("touchend",   onEnd);
    if (onDragEnd) onDragEnd();
  }

  el.addEventListener("mousedown", (e) => {
    onStart(e);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup",   onEnd);
  });

  el.addEventListener(
    "touchstart",
    (e) => {
      onStart(e);
      window.addEventListener("touchmove", onMove, { passive: false });
      window.addEventListener("touchend",  onEnd);
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
const envPopup      = new EnvironmentPopup();
const varsPopup     = new VariablesPopup();
const layoutPicker  = new LayoutPicker({
  onSelect: (layout) => {
    applyLayout(layout);
    currentSettings = { ...currentSettings, layout };
    saveSettings(currentSettings);
  },
});
let currentSettings = {};

/** Live environment state — kept in sync with data-store. */
let currentEnvs = {
  environments:        [],
  activeEnvironmentId: null,
};

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

  // Environment buttons (panel header + bottom bar)
  document.getElementById("btn-environment").addEventListener("click", () => {
    envPopup.open(currentEnvs);
  });
  document.getElementById("btn-environment-nav").addEventListener("click", () => {
    envPopup.open(currentEnvs);
  });

  // Right-click on the environment label or either environment icon → OS context menu
  const _openEnvCtxMenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    _showEnvContextMenu(e.clientX, e.clientY);
  };

  document.querySelector("#panel-nav .panel-title").addEventListener("contextmenu", _openEnvCtxMenu);
  document.getElementById("btn-environment").addEventListener("contextmenu", _openEnvCtxMenu);
  document.getElementById("btn-environment-nav").addEventListener("contextmenu", _openEnvCtxMenu);
}

/** Open the native OS context menu for the active environment. */
async function _showEnvContextMenu(x, y) {
  const actions = {
    "rename":    () => envPopup.openWithRename(currentEnvs),
    "variables": () => {
      const activeEnv = currentEnvs.environments.find(
        e => e.id === currentEnvs.activeEnvironmentId,
      );
      if (!activeEnv) return;
      varsPopup.open({
        envId:      activeEnv.id,
        envName:    activeEnv.name,
        variables:  activeEnv.variables ?? {},
        bulkEditor: currentSettings.varsBulkEditor ?? true,
      });
    },
  };

  const clickedId = await window.wurl.ui.contextMenu({
    items: [
      { id: "rename",    label: "Rename"    },
      { type: "separator" },
      { id: "variables", label: "Variables" },
    ],
    x, y,
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
    // Persist the selected node ID so it can be restored on reload
    const id = node?.id;
    if (id) {
      currentSettings = { ...currentSettings, selectedRequestId: id };
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
      // Guard against a second selection arriving while we were loading.
      if (_selectedNode?.id === id) _dispatchTimelineUpdate(id, true);
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
    const { body = "", headers = {}, status = 0 } = e.detail;
    _responseCache[name]   = body;
    _responseHeaders[name] = headers;
    _responseStatus[name]  = status;
    _refreshEditorVariableContext(node.id);

    // Record in per-request history only for real (non-replay) executions.
    // When replaying a historical entry, do NOT push to history and do NOT
    // re-render the timeline (which would clear the user's current selection).
    if (!skipHistory && _maxHistory > 0 && node?.id) {
      const histId  = crypto.randomUUID();
      const nowMs   = Date.now();
      const reqUrl  = _lastRequestSnapshot?.url ?? "";
      const reqNode = JSON.parse(JSON.stringify(node));
      const resp    = {
        request:    e.detail.request    ?? {},
        status:     e.detail.status     ?? 0,
        statusText: e.detail.statusText ?? "",
        headers:    e.detail.headers    ?? {},
        cookies:    e.detail.cookies    ?? [],
        body:       e.detail.body       ?? "",
        elapsed:    e.detail.elapsed    ?? 0,
        size:       e.detail.size       ?? 0,
        consoleLog: e.detail.consoleLog ?? [],
      };

      // Ensure history is loaded from storage before prepending the new entry,
      // so the in-memory list is complete and purging works correctly.
      if (!_historyLoaded.has(node.id)) {
        await _loadRequestHistory(node.id);
        _historyLoaded.add(node.id);
      }

      const entries = _requestHistory.get(node.id) ?? [];
      entries.unshift({ id: histId, requestNode: reqNode, requestUrl: reqUrl, response: resp, timestamp: nowMs });

      // Persist to storage (fire-and-forget).
      addHistory(node.id,
        { id: histId, timestamp: nowMs, status: resp.status, statusText: resp.statusText,
          elapsed: resp.elapsed, size: resp.size, requestUrl: reqUrl, requestNode: reqNode },
        { headers: resp.headers, cookies: resp.cookies, body: resp.body, consoleLog: resp.consoleLog },
      );

      // Purge entries beyond the limit from both memory and storage.
      while (entries.length > _maxHistory) {
        const old = entries.pop();
        if (old?.id) deleteHistory(node.id, old.id);
      }

      _requestHistory.set(node.id, entries);
      _dispatchTimelineUpdate(node.id);
    }
  });

  // Record network-level failures (ENOTFOUND, ETIMEDOUT, etc.) in the timeline.
  // Cancellations and "no URL" guards are excluded — only genuine request attempts
  // that reached the network layer are recorded.
  window.addEventListener("wurl:request-error", async (e) => {
    const skipHistory = _skipNextHistory;
    _skipNextHistory  = false;

    if (skipHistory) return;
    if (_cancelCurrentRequest) return;
    if (e.detail?.name === "AbortError") return;
    if (!_lastRequestSnapshot) return;

    const node = _selectedNode;
    if (!node?.id || _maxHistory <= 0) return;

    const histId  = crypto.randomUUID();
    const nowMs   = Date.now();
    const reqUrl  = _lastRequestSnapshot.url ?? "";
    const reqNode = JSON.parse(JSON.stringify(node));
    const resp    = {
      request:    e.detail.request    ?? {},
      error: {
        name:    e.detail.name    ?? "Error",
        message: e.detail.message ?? "",
        hint:    e.detail.hint    ?? "",
      },
      status:     0,
      statusText: e.detail.name    ?? "Error",
      headers:    {},
      cookies:    [],
      body:       "",
      elapsed:    e.detail.elapsed    ?? 0,
      size:       0,
      consoleLog: e.detail.consoleLog ?? [],
    };

    if (!_historyLoaded.has(node.id)) {
      await _loadRequestHistory(node.id);
      _historyLoaded.add(node.id);
    }

    const entries = _requestHistory.get(node.id) ?? [];
    entries.unshift({ id: histId, requestNode: reqNode, requestUrl: reqUrl, response: resp, timestamp: nowMs });

    addHistory(node.id,
      { id: histId, timestamp: nowMs, status: 0, statusText: resp.statusText,
        elapsed: resp.elapsed, size: 0, requestUrl: reqUrl, requestNode: reqNode },
      { request: resp.request, error: resp.error, headers: {}, cookies: [], body: "", consoleLog: resp.consoleLog },
    );

    while (entries.length > _maxHistory) {
      const old = entries.pop();
      if (old?.id) deleteHistory(node.id, old.id);
    }

    _requestHistory.set(node.id, entries);
    _dispatchTimelineUpdate(node.id);
  });

  // Auto-save whenever the tree is mutated (add / remove collection or request)
  window.addEventListener("wurl:collections-changed", (e) => {
    saveCollections(e.detail);
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
  });

  // Persist settings immediately whenever any control in the popup changes.
  // Merge into currentSettings so fields not emitted by the popup (splitters,
  // selectedRequestId, historyCount) are not silently dropped on each save.
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
    _maxHistory = Math.max(0, Math.min(10, e.detail?.historyCount ?? _maxHistory));
    for (const [id, entries] of _requestHistory.entries()) {
      while (entries.length > _maxHistory) {
        const old = entries.pop();
        if (old?.id) deleteHistory(id, old.id);
      }
      if (_maxHistory === 0) _requestHistory.delete(id);
    }
    _dispatchTimelineUpdate(_selectedNode?.id);
  });

  // Replay a historical entry: restore the request editor state and display the
  // saved response without actually re-running the request.
  window.addEventListener("wurl:timeline-select", (e) => {
    const { requestNode, requestUrl = "", response } = e.detail;
    requestEditor.load(requestNode);
    _skipNextHistory = true;
    if (response?.error) {
      window.dispatchEvent(new CustomEvent("wurl:request-error", {
        detail: {
          request:    response.request    ?? { url: requestUrl },
          name:       response.error.name    ?? "Error",
          message:    response.error.message ?? "",
          hint:       response.error.hint    ?? "",
          elapsed:    response.elapsed    ?? 0,
          consoleLog: response.consoleLog ?? [],
        },
      }));
    } else {
      window.dispatchEvent(new CustomEvent("wurl:response-received", {
        detail: { ...response, request: { url: requestUrl } },
      }));
    }
  });

  // When the request editor fires a preference change (e.g. List Headers toggle),
  // merge into currentSettings and persist.
  window.addEventListener("wurl:editor-setting-changed", (e) => {
    currentSettings = { ...currentSettings, ...e.detail };
    saveSettings(currentSettings);
  });

  // ── Environment events ───────────────────────────────────────────────────

  /** Switch the active environment: save current collections, load new ones. */
  window.addEventListener("wurl:env-select", async (e) => {
    const { id } = e.detail;
    if (id === currentEnvs.activeEnvironmentId) return;

    // Persist the current env's collections before switching
    if (treeView) await saveEnvCollections(currentEnvs.activeEnvironmentId, treeView.getItems());

    // Update in-memory active env
    setActiveEnvironment(id);
    currentEnvs = { ...currentEnvs, activeEnvironmentId: id };

    // Persist manifest
    await saveManifest({ environments: currentEnvs.environments, activeEnvironmentId: id });

    // Clear selected request (it belongs to the previous env)
    _selectedNode = null;
    currentSettings = { ...currentSettings, selectedRequestId: null };
    saveSettings(currentSettings);

    // Load new env's collections
    const { collections, variables } = await loadEnvCollections(id);
    treeView.setStorageKey(id);
    treeView.setItems(collections);

    // Attach variables to the env entry in memory
    currentEnvs = {
      ...currentEnvs,
      environments: currentEnvs.environments.map(env =>
        env.id === id ? { ...env, variables: variables ?? {} } : env,
      ),
    };

    // Update UI
    setNavPanelTitle(_envName(currentEnvs.environments, id));
    envPopup.update(currentEnvs);
    // Refresh pill editor variable context for the new environment
    _refreshEditorVariableContext();
  });

  /** Add a new (empty) environment and switch to it. */
  window.addEventListener("wurl:env-add", async (e) => {
    const { name } = e.detail;
    const newEnv   = { id: crypto.randomUUID(), name };
    const environments = [...currentEnvs.environments, newEnv];

    // Save empty collections for the new env
    await saveEnvCollections(newEnv.id, []);

    // Switch to the new env
    if (treeView) await saveEnvCollections(currentEnvs.activeEnvironmentId, treeView.getItems());
    setActiveEnvironment(newEnv.id);
    currentEnvs = { environments, activeEnvironmentId: newEnv.id };

    await saveManifest({ environments, activeEnvironmentId: newEnv.id });

    currentSettings = { ...currentSettings, selectedRequestId: null };
    saveSettings(currentSettings);

    treeView.setStorageKey(newEnv.id);
    treeView.setItems([]);
    setNavPanelTitle(newEnv.name);
    envPopup.update(currentEnvs);
  });

  /** Clone an environment: deep-copy its collections with new UUIDs, then switch. */
  window.addEventListener("wurl:env-clone", async (e) => {
    const { sourceId, name } = e.detail;
    const newEnv = { id: crypto.randomUUID(), name };

    // Load source collections (if source is currently active, use the live tree)
    let sourceCollections;
    let sourceVariables;
    if (sourceId === currentEnvs.activeEnvironmentId) {
      sourceCollections = treeView ? treeView.getItems() : [];
      sourceVariables   = currentEnvs.environments.find(e => e.id === sourceId)?.variables ?? {};
    } else {
      const loaded      = await loadEnvCollections(sourceId);
      sourceCollections = loaded.collections;
      sourceVariables   = loaded.variables ?? {};
    }

    // Deep-clone collections with new UUIDs; copy variables directly
    const cloned         = sourceCollections.map(_deepCloneWithNewIds);
    const clonedVariables = { ...sourceVariables };

    // Save cloned collections + variables and switch to the new env
    await saveEnvCollections(newEnv.id, cloned, clonedVariables);
    if (treeView) await saveEnvCollections(currentEnvs.activeEnvironmentId, treeView.getItems());

    const environments = [...currentEnvs.environments, { ...newEnv, variables: clonedVariables }];
    setActiveEnvironment(newEnv.id);
    currentEnvs = { environments, activeEnvironmentId: newEnv.id };

    await saveManifest({ environments, activeEnvironmentId: newEnv.id });

    currentSettings = { ...currentSettings, selectedRequestId: null };
    saveSettings(currentSettings);

    treeView.setStorageKey(newEnv.id);
    treeView.setItems(cloned);
    setNavPanelTitle(newEnv.name);
    envPopup.update(currentEnvs);
  });

  /** Rename an environment — updates its display name everywhere without touching its collections. */
  window.addEventListener("wurl:env-rename", async (e) => {
    const { id, name } = e.detail;
    const environments = currentEnvs.environments.map(env =>
      env.id === id ? { ...env, name } : env,
    );
    currentEnvs = { ...currentEnvs, environments };

    // Persist the manifest with the new name
    await saveManifest({ environments, activeEnvironmentId: currentEnvs.activeEnvironmentId });

    // If the renamed env is active, update the nav panel title
    if (id === currentEnvs.activeEnvironmentId) setNavPanelTitle(name);

    envPopup.update(currentEnvs);
  });

  /** Delete an environment (must always leave at least 1). */
  window.addEventListener("wurl:env-delete", async (e) => {
    const { id } = e.detail;
    if (currentEnvs.environments.length <= 1) return; // guard

    let environments = currentEnvs.environments.filter(env => env.id !== id);
    let activeId = currentEnvs.activeEnvironmentId;

    // If we're deleting the active env, switch to the first remaining one
    if (id === activeId) {
      activeId = environments[0].id;
      const { collections, variables } = await loadEnvCollections(activeId);
      setActiveEnvironment(activeId);
      currentSettings = { ...currentSettings, selectedRequestId: null };
      saveSettings(currentSettings);
      treeView.setStorageKey(activeId);
      treeView.setItems(collections);
      setNavPanelTitle(_envName(environments, activeId));
      // Attach variables in memory
      environments = environments.map(env =>
        env.id === activeId ? { ...env, variables: variables ?? {} } : env,
      );
    } else {
      setActiveEnvironment(activeId);
    }

    currentEnvs = { environments, activeEnvironmentId: activeId };
    await saveManifest({ environments, activeEnvironmentId: activeId });
    envPopup.update(currentEnvs);
  });

  // ── Variable events ──────────────────────────────────────────────────────

  /** Open the variables popup for a folder node. */
  window.addEventListener("wurl:folder-vars-open", (e) => {
    const { nodeId, folderName, variables } = e.detail;
    varsPopup.open({
      envId:      nodeId,
      envName:    folderName,
      variables:  variables ?? {},
      bulkEditor: currentSettings.varsBulkEditor ?? true,
    });
  });

  /**
   * Persist variables and keep in-memory state in sync.
   * The `envId` field doubles as a folder-node ID when it doesn't match any
   * environment — in that case the variables are stored on the tree node.
   */
  window.addEventListener("wurl:vars-save", async (e) => {
    const { envId, variables } = e.detail;

    const isEnv = currentEnvs.environments.some(env => env.id === envId);

    if (isEnv) {
      // Update in-memory environment state
      currentEnvs = {
        ...currentEnvs,
        environments: currentEnvs.environments.map(env =>
          env.id === envId ? { ...env, variables } : env,
        ),
      };
      saveEnvVariables(envId, variables);
    } else {
      // It's a folder node — patch the tree and persist collections
      if (treeView) {
        treeView.updateNode(envId, { variables }, { silent: true });
        await saveCollections(treeView.getItems());
      }
    }

    // Revalidate pill editors in the request panel for the updated context
    _refreshEditorVariableContext(currentSettings.selectedRequestId);
  });

  /** Persist the Bulk Editor toggle preference into settings. */
  window.addEventListener("wurl:vars-bulk-editor-changed", (e) => {
    currentSettings = { ...currentSettings, varsBulkEditor: e.detail.bulkEditor };
    saveSettings(currentSettings);
  });

  // ── Variable context helper ──────────────────────────────────────────────

  /**
   * Compute the current variable resolution context and push it to the
   * request editor so its pill editors can validate {{variables}}.
   *
   * @param {string|null} [nodeId]  — the selected request/folder node ID;
   *   defaults to currentSettings.selectedRequestId.
   */
  function _refreshEditorVariableContext(nodeId) {
    if (!requestEditor) return;
    const id = nodeId ?? currentSettings.selectedRequestId ?? null;
    const folderChain = (treeView && id)
      ? buildFolderChain(treeView.getItems(), id)
      : [];
    const activeEnv = currentEnvs.environments.find(
      env => env.id === currentEnvs.activeEnvironmentId,
    );
    const envVariables = activeEnv?.variables ?? {};
    const node = _selectedNode ?? (id && treeView ? _findNodeById(treeView.getItems(), id) : null);
    requestEditor.setVariableContext({
      envVariables,
      folderChain,
      envName:         activeEnv?.name     ?? "",
      requestName:     node?.name          ?? "",
      responseCache:   _responseCache,
      responseHeaders: _responseHeaders,
      responseStatus:  _responseStatus,
    });
    // Also feed the active environment variables to the tree-view so that
    // "Generate cURL" resolves variables the same way the Send button does.
    if (treeView) treeView.setEnvVariables(envVariables);
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
    }
  });

  // Active AbortController for the current in-flight Go-dev-mode request
  let _activeAbortController = null;
  // Flag set when the user cancels; prevents stale results from being displayed
  let _cancelCurrentRequest  = false;
  // Snapshot of the most-recently-started request (used in cancel error detail)
  let _lastRequestSnapshot   = null;
  // Currently selected tree node (request or folder), for context functions
  let _selectedNode          = null;
  // Response caches keyed by request name — fed into variable context for function pills
  let _responseCache   = {};
  let _responseHeaders = {};
  let _responseStatus  = {};

  window.addEventListener("wurl:cancel-request", () => {
    _cancelCurrentRequest = true;
    if (_activeAbortController) {
      _activeAbortController.abort();
      _activeAbortController = null;
    }
    // Give instant feedback: treat cancel as an error
    window.dispatchEvent(new CustomEvent("wurl:request-error", {
      detail: {
        request:    _lastRequestSnapshot ?? { method: "GET", url: "", headers: {}, body: null },
        name:       "AbortError",
        message:    "Request cancelled.",
        hint:       "The request was cancelled by the user.",
        elapsed:    0,
        consoleLog: ["* Request cancelled by user"],
      },
    }));
  });

  // ── classify common network failures for a human-readable hint ──────────────
  function _buildHint(errName, msg) {
    if (errName === "AbortError")
      return "The request was aborted.";
    if (/cors/i.test(msg))
      return "CORS policy blocked the request — the server may need to send Access-Control-Allow-Origin headers.";
    if (/failed to fetch|load failed|networkerror|network request failed/i.test(msg))
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
      window.dispatchEvent(new CustomEvent("wurl:request-error", {
        detail: {
          request:    { method: descriptor?.method ?? "GET", url: rawUrl ?? "", headers: {}, body: null },
          name:       "TypeError",
          message:    "No URL specified.",
          hint:       "Enter a URL in the request bar before sending.",
          elapsed:    0,
          consoleLog: ["* Error: No URL specified."],
        },
      }));
      return;
    }

    window.dispatchEvent(new CustomEvent("wurl:request-loading"));

    _cancelCurrentRequest  = false;
    _lastRequestSnapshot   = {
      method:  descriptor.method,
      url:     descriptor.url,
      headers: descriptor.headers ?? {},
      body:    typeof descriptor.body === "string" ? descriptor.body : null,
    };

    // ── Build the descriptor for the native layer ────────────────────────────
    const nativeDesc = {
      method:          descriptor.method,
      url:             descriptor.url,
      headers:         descriptor.headers ?? {},
      body:            typeof descriptor.body === "string" ? descriptor.body : null,
      bodyFilePath:    descriptor.bodyFilePath ?? null,
      timeout:         currentSettings.timeout         ?? 30000,
      followRedirects: currentSettings.followRedirects ?? true,
      verifySsl:       currentSettings.verifySsl       ?? true,
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
            "Ensure the Electron app was rebuilt with the latest preload.js."
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
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify(nativeDesc),
          signal:  controller.signal,
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
        window.dispatchEvent(new CustomEvent("wurl:request-error", {
          detail: {
            request:    _lastRequestSnapshot,
            name:       result.error.name,
            message:    result.error.message,
            hint:       _buildHint(result.error.name, result.error.message),
            elapsed:    result.elapsed ?? 0,
            consoleLog: result.consoleLog ?? [],
          },
        }));
      } else {
        // We got an HTTP response (any status code, including 4xx / 5xx)
        window.dispatchEvent(new CustomEvent("wurl:response-received", {
          detail: {
            request:    _lastRequestSnapshot,
            status:     result.status,
            statusText: result.statusText,
            headers:    result.headers  ?? {},
            cookies:    result.cookies  ?? [],
            body:       result.body     ?? "",
            elapsed:    result.elapsed  ?? 0,
            size:       result.size     ?? 0,
            consoleLog: result.consoleLog ?? [],
          },
        }));
      }

    } catch (err) {
      if (_cancelCurrentRequest) return;
      _activeAbortController = null;

      const errName = (err instanceof Error ? err.name    : "Error")   || "Error";
      const msg     = (err instanceof Error ? err.message : String(err)) || "";

      window.dispatchEvent(new CustomEvent("wurl:request-error", {
        detail: {
          request:    _lastRequestSnapshot,
          name:       errName,
          message:    msg,
          hint:       _buildHint(errName, msg),
          elapsed:    0,
          consoleLog: [`* ${errName}: ${msg}`],
        },
      }));
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
  const { collections, settings, environments, activeEnvironmentId, variables } = await loadAll();

  treeView.setStorageKey(activeEnvironmentId);
  treeView.setItems(collections);
  currentSettings = settings;
  _maxHistory = settings.historyCount ?? 5;
  settingsPopup.load(settings);
  applySettings(settings);

  // Seed environment state — attach loaded variables to the active env object
  const envsWithVars = environments.map(env =>
    env.id === activeEnvironmentId ? { ...env, variables: variables ?? {} } : env,
  );
  currentEnvs = { environments: envsWithVars, activeEnvironmentId };
  setNavPanelTitle(_envName(environments, activeEnvironmentId));

  // Restore the previously selected request (if any)
  if (settings.selectedRequestId) {
    treeView.selectById(settings.selectedRequestId);
  }
}

/** Return the name of an environment by id, falling back to a default. */
function _envName(environments, id) {
  return environments.find(e => e.id === id)?.name ?? "Collections";
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
  const FONT_SIZES     = [9, 11, 12, 13, 14, 16, 18,20];
  const DEFAULT_FONT   = 13; // matches DEFAULT_SETTINGS.fontSize in data-store.js

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
        Math.abs(cur - current) < Math.abs(prev - current) ? cur : prev
      );
      idx = FONT_SIZES.indexOf(nearest);
    }

    const nextIdx = Math.max(0, Math.min(FONT_SIZES.length - 1, idx + direction));
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
  window.addEventListener("wheel", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return; // only intercept zoom-modifier combos

    e.preventDefault();
    e.stopPropagation();

    // Negative deltaY = scroll/pinch toward "zoom in"; positive = "zoom out".
    changeFontByStep(e.deltaY < 0 ? +1 : -1);
  }, { passive: false, capture: true });

  // ── Keyboard shortcuts ───────────────────────────────────────────────────────
  // Intercept Ctrl/Cmd + '+' / '-' / '0' before Chromium or the OS menu picks
  // them up.  Registered in the capture phase so they fire before editor widgets.
  window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;

    // Allow normal key combos inside editable inputs/textareas.
    const tag = e.target?.tagName ?? "";
    if (["INPUT", "TEXTAREA"].includes(tag) || e.target?.isContentEditable) return;

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
  }, { capture: true });

  // ── Electron menu items (main → preload → renderer) ──────────────────────────
  // The Electron main process replaced the native zoomIn/zoomOut/resetZoom menu
  // roles with custom items that send "wurl:ui-font-change" via webContents.send().
  // preload.js re-dispatches these as window CustomEvents so we can handle them here.
  window.addEventListener("wurl:ui-font-change", (e) => {
    const direction = e.detail;
    if (direction === "in")    changeFontByStep(+1);
    else if (direction === "out")   changeFontByStep(-1);
    else if (direction === "reset") resetFont();
  });
}

/**
 * Dispatch wurl:timeline-update with the history entries for the given request ID.
 * @param {string|null}  requestId
 * @param {boolean}      [isRequestSwitch] – true when triggered by a request selection;
 *                                           the response-viewer uses this to update the body tab.
 */
function _dispatchTimelineUpdate(requestId, isRequestSwitch = false) {
  const entries = requestId ? (_requestHistory.get(requestId) ?? []) : [];
  window.dispatchEvent(new CustomEvent("wurl:timeline-update", {
    detail: { entries: [...entries], isRequestSwitch },
  }));
}

/** Deep-clone a tree node, assigning fresh UUIDs throughout. */
function _deepCloneWithNewIds(node) {  const clone = { ...node, id: crypto.randomUUID() };
  if (Array.isArray(node.children)) {
    clone.children = node.children.map(_deepCloneWithNewIds);
  }
  // Regenerate IDs for request-level row arrays
  if (Array.isArray(node.bodyFormRows)) {
    clone.bodyFormRows = node.bodyFormRows.map((r) => ({ ...r, id: crypto.randomUUID() }));
  }
  if (Array.isArray(node.params)) {
    clone.params = node.params.map((r) => ({ ...r, id: crypto.randomUUID() }));
  }
  if (Array.isArray(node.headers)) {
    clone.headers = node.headers.map((r) => ({ ...r, id: crypto.randomUUID() }));
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
  "inter":   '"Inter", "Segoe UI", system-ui, -apple-system, sans-serif',
  "system":  'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  "sf-pro":  '-apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif',
  "segoe":   '"Segoe UI", system-ui, sans-serif',
  "ubuntu":  '"Ubuntu", "Cantarell", system-ui, sans-serif',
  "roboto":  '"Roboto", "Helvetica Neue", system-ui, sans-serif',
};

function applySettings(settings) {
  // Theme — stored as a data attribute so CSS [data-theme="latte"] etc. applies
  if (settings.theme) {
    document.documentElement.dataset.theme = settings.theme;
  }
  // Font size — sets --font-size-base; all other sizes (xs, sm, md, lg, xl)
  // are defined as calc(base ± Npx) in theme.css so the whole UI scales.
  if (settings.fontSize) {
    document.documentElement.style.setProperty("--font-size-base", `${settings.fontSize}px`);
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
  if (settings.splitterNav    != null) splitterSizes.nav    = settings.splitterNav;
  if (settings.splitterRes    != null) splitterSizes.res    = settings.splitterRes;
  if (settings.splitterRowRes != null) splitterSizes.rowRes = settings.splitterRowRes;
  applyGridVars();

  // Editor preferences
  if (requestEditor) requestEditor.applySettings(settings);
  if (responseViewer) responseViewer.applySettings(settings);
  if (varsPopup) varsPopup.applySettings(settings);
  if (treeView) treeView.setDoubleClickExecute(settings.doubleClickExecute ?? false);
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

    // Fallback settings bar at the bottom of the nav panel
    const navBar = document.getElementById("nav-settings-bar");
    if (navBar) {
      navBar.classList.toggle("is-visible", remove);
      navBar.setAttribute("aria-hidden", String(!remove));
    }
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
