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

import { getLayoutMode } from "./panel.js";
import { TreeView } from "./components/tree-view.js";
import { RequestEditor } from "./components/request-editor.js";
import { ResponseViewer } from "./components/response-viewer.js";
import { SettingsPopup } from "./components/settings-popup.js";
import { loadAll, saveCollections, saveSettings } from "./data-store.js";

// ─── Bootstrap ────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  initPanels();
  initComponents();
  initSplitters();
  initEventBus();
  initHeader();
  await initCollections();
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
const SPLITTER_MIN_NAV    = 160;
const SPLITTER_MIN_RES    = 160;
const SPLITTER_MIN_ROWRES = 120;

let splitterSizes = {
  nav:    240,
  res:    340,
  rowRes: 320,
};

/** Push current splitter sizes into the CSS grid on #app-main. */
function applyGridVars() {
  const appMain = document.getElementById("app-main");
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
function getAppMain() {
  return document.getElementById("app-main");
}

function initSplitters() {
  const spl1El = document.getElementById("splitter-1");
  const spl2El = document.getElementById("splitter-2");

  applyGridVars();

  // Splitter 1 — always resizes the nav panel (--col-nav).
  // Flow: horizontal in landscape/between, vertical in portrait (nav height).
  // Dragging right/down grows nav → delta is positive → no inversion needed.
  const splitter1 = makeSplitter(spl1El, {
    getFlow: () => (getLayoutMode() === "portrait" ? "column" : "row"),
    getSize: () => splitterSizes.nav,
    setSize: (v) => {
      const appMain = getAppMain();
      const max = getLayoutMode() === "portrait"
        ? appMain.clientHeight * 0.5
        : appMain.clientWidth  * 0.5;
      splitterSizes.nav = Math.min(max, Math.max(SPLITTER_MIN_NAV, v));
      applyGridVars();
    },
    onDragEnd: saveSplitterPositions,
    invert: false,
  });

  // Splitter 2 — resizes the response panel.
  // landscape  → changes --col-res   (horizontal drag)
  // between    → changes --row-res   (vertical drag)
  // portrait   → changes --row-res   (vertical drag)
  //
  // Inversion: the response panel is to the RIGHT of / BELOW the splitter.
  // Dragging the splitter right/down moves away from the response panel, so
  // the panel should SHRINK → negate the delta.
  const splitter2 = makeSplitter(spl2El, {
    getFlow: () => (getLayoutMode() === "landscape" ? "row" : "column"),
    getSize: () =>
      getLayoutMode() === "landscape" ? splitterSizes.res : splitterSizes.rowRes,
    setSize: (v) => {
      const appMain = getAppMain();
      if (getLayoutMode() === "landscape") {
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

  // Sync splitter class (--h / --v) whenever layout mode changes.
  const observer = new ResizeObserver(() => {
    const mode = getLayoutMode();
    splitter1.setFlow(mode === "portrait" ? "column" : "row");
    splitter2.setFlow(mode === "landscape" ? "row" : "column");
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
 * Each button opens a dedicated popup instance via the PopupManager.
 * currentSettings is kept in sync here so the popup always opens with the
 * latest values.
 */
const settingsPopup = new SettingsPopup();
let currentSettings = {};

function initHeader() {
  document.getElementById("btn-settings").addEventListener("click", () => {
    settingsPopup.open(currentSettings);
  });

  // Secondary settings button inside the nav panel — shown when app-header is hidden
  document.getElementById("btn-settings-nav").addEventListener("click", () => {
    settingsPopup.open(currentSettings);
  });
}

// ─── Event bus ────────────────────────────────────────────────────────────────
function initEventBus() {
  // When a request is selected in the tree, load it into the editor
  window.addEventListener("wurl:request-selected", (e) => {
    requestEditor.load(e.detail);
    // Persist the selected node ID so it can be restored on reload
    const id = e.detail?.id;
    if (id) {
      currentSettings = { ...currentSettings, selectedRequestId: id };
      saveSettings(currentSettings);
    }
  });

  // Auto-save whenever the tree is mutated (add / remove collection or request)
  window.addEventListener("wurl:collections-changed", (e) => {
    saveCollections(e.detail);
  });

  // Persist settings immediately whenever any control in the popup changes
  window.addEventListener("wurl:settings-changed", (e) => {
    currentSettings = e.detail;
    applySettings(currentSettings);
    saveSettings(currentSettings);
  });

  // When the request editor fires a preference change (e.g. List Headers toggle),
  // merge into currentSettings and persist.
  window.addEventListener("wurl:editor-setting-changed", (e) => {
    currentSettings = { ...currentSettings, ...e.detail };
    saveSettings(currentSettings);
  });

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

  // When the editor fires a send, execute the request
  window.addEventListener("wurl:send-request", async (e) => {
    const descriptor = e.detail;
    window.dispatchEvent(new CustomEvent("wurl:request-loading"));

    try {
      const start = performance.now();
      const response = await fetch(descriptor.url, {
        method: descriptor.method,
        headers: descriptor.headers,
        body: descriptor.body ?? undefined,
      });
      const elapsed = Math.round(performance.now() - start);
      const body = await response.text();

      // Collect response headers into a plain object
      const headers = {};
      response.headers.forEach((v, k) => {
        headers[k] = v;
      });

      window.dispatchEvent(
        new CustomEvent("wurl:response-received", {
          detail: {
            status: response.status,
            statusText: response.statusText,
            headers,
            body,
            elapsed,
            size: new TextEncoder().encode(body).length,
          },
        }),
      );
    } catch (err) {
      window.dispatchEvent(
        new CustomEvent("wurl:request-error", {
          detail: { message: err.message },
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
 *
 * Hands collections to the TreeView and seeds the SettingsPopup with the
 * stored settings values so they are correct when the popup is first opened.
 */
async function initCollections() {
  const { collections, settings } = await loadAll();
  treeView.setItems(collections);
  currentSettings = settings;
  settingsPopup.load(settings);
  applySettings(settings);

  // Restore the previously selected request (if any)
  if (settings.selectedRequestId) {
    treeView.selectById(settings.selectedRequestId);
  }
}

/**
 * Apply a settings object to the live UI.
 * Extend this function whenever a new setting needs to affect the DOM.
 * @param {object} settings
 */
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
  // Splitter positions — restore saved pixel values into the grid variables
  if (settings.splitterNav    != null) splitterSizes.nav    = settings.splitterNav;
  if (settings.splitterRes    != null) splitterSizes.res    = settings.splitterRes;
  if (settings.splitterRowRes != null) splitterSizes.rowRes = settings.splitterRowRes;
  applyGridVars();

  // Editor preferences
  if (requestEditor) requestEditor.applySettings(settings);

  // Remove headers — hide/show all .panel-header elements, app-header, and nav settings bar
  if (settings.removeHeaders !== undefined) {
    const remove = settings.removeHeaders;

    // Panel title bars
    document.querySelectorAll(".panel-header").forEach((header) => {
      header.style.display = remove ? "none" : "";
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
