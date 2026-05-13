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

import {
  Panel,
  Splitter,
  getLayoutMode,
  BREAKPOINT_LANDSCAPE,
  BREAKPOINT_PORTRAIT,
} from "./panel.js";
import { TreeView } from "./components/tree-view.js";
import { RequestEditor } from "./components/request-editor.js";
import { ResponseViewer } from "./components/response-viewer.js";
import { SettingsPopup } from "./components/settings-popup.js";
import { loadCollections, saveCollections } from "./data-store.js";

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
 * The two splitter <div>s exist in index.html (id="splitter-1" / "splitter-2").
 * We drive them with Splitter instances that know about the panels on either side.
 *
 * Because the CSS grid repositions the splitters at each breakpoint, we also
 * update the Splitter flow direction on resize so drag behaviour stays correct.
 */

function initSplitters() {
  const spl1El = document.getElementById("splitter-1");
  const spl2El = document.getElementById("splitter-2");

  // We manage the splitters manually here rather than through PanelGroup,
  // because the top-level layout is a CSS grid, not a flexbox PanelGroup.
  const splitter1 = makeSplitter(spl1El, panelNav, panelRequest);
  const splitter2 = makeSplitter(spl2El, panelRequest, panelResponse);

  // Update splitter flow direction whenever the window width crosses a breakpoint.
  const observer = new ResizeObserver(() => {
    const mode = getLayoutMode();
    // spl-1: always separates nav/request horizontally (col) in landscape+between,
    //        vertically   (row)  in portrait.
    const spl1Flow = mode === "portrait" ? "column" : "row";
    // spl-2: between⟹row=response is below⟹vertical drag; others⟹horizontal
    const spl2Flow =
      mode === "between" ? "column" : mode === "portrait" ? "column" : "row";

    splitter1.setFlow(spl1Flow);
    splitter2.setFlow(spl2Flow);
  });
  observer.observe(document.getElementById("app-main"));
}

/**
 * Attach Splitter drag logic to an existing DOM element.
 * Returns a Splitter-like object exposing setFlow().
 */
function makeSplitter(el, beforePanel, afterPanel) {
  let flow = getLayoutMode() === "portrait" ? "column" : "row";
  let dragging = false;
  let startPos = 0;
  let startSize = 0;

  function clientPos(e) {
    const src = e.touches ? e.touches[0] : e;
    return flow === "row" ? src.clientX : src.clientY;
  }

  function currentSize() {
    const rect = beforePanel.element.getBoundingClientRect();
    return flow === "row" ? rect.width : rect.height;
  }

  function onStart(e) {
    e.preventDefault();
    dragging = true;
    startPos = clientPos(e);
    startSize = currentSize();
    el.classList.add("splitter--dragging");
    document.body.style.cursor = flow === "row" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  }

  function onMove(e) {
    if (!dragging) return;
    if (e.cancelable) e.preventDefault();
    const delta = clientPos(e) - startPos;
    const newSize = Math.max(80, startSize + delta);
    beforePanel.element.style.flex = `0 0 ${newSize}px`;
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
      flow = newFlow;
      el.className = `splitter splitter--${newFlow === "row" ? "h" : "v"}`;
    },
  };
}

// ─── Header ───────────────────────────────────────────────────────────────────
/**
 * Wire up header icon buttons.
 * Each button opens a dedicated popup instance via the PopupManager.
 */
const settingsPopup = new SettingsPopup();

function initHeader() {
  document.getElementById("btn-settings").addEventListener("click", () => {
    settingsPopup.open();
  });
}

// ─── Event bus ────────────────────────────────────────────────────────────────
function initEventBus() {
  // When a request is selected in the tree, load it into the editor
  window.addEventListener("wurl:request-selected", (e) => {
    requestEditor.load(e.detail);
  });

  // Auto-save whenever the tree is mutated (add / remove collection or request)
  window.addEventListener("wurl:collections-changed", (e) => {
    saveCollections(e.detail);
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

// ─── Collections ──────────────────────────────────────────────────────────────
/**
 * Load persisted collections on startup and hand them to the TreeView.
 * In Go dev mode  → fetches from /api/collections (reads data/collections.json)
 * In Electron     → reads via ipcMain from the platform userData directory
 */
async function initCollections() {
  const items = await loadCollections();
  treeView.setItems(items);
}
