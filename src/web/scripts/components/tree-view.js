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
 * tree-view.js — Navigation / Collections tree-view component
 *
 * Renders a hierarchical list of request collections and individual requests.
 * Collections may be nested to any depth (folders within folders).
 *
 * Public API:
 *   setItems(items)   — replace the full tree data and re-render
 *   getItems()        — return the current items array (deep copy)
 *
 * Events dispatched on window (payload shapes are documented in the canonical
 * `hippo:*` registry at the top of initEventBus() in app.js):
 *   hippo:request-selected    node               — user clicked a request
 *   hippo:request-open        { collectionId, requestId } — open from a menu action
 *   hippo:request-execute     node               — run a request from the tree
 *   hippo:favorite-toggle     { node, favorited }
 *   hippo:requests-deleted    { ids }            — one or more requests removed
 *   hippo:request-cleared     —                  — last request deleted; editor should reset
 *   hippo:collections-changed items[]            — tree was mutated (add/remove/move) → persist
 *   hippo:export-collection   { collection }
 *   hippo:folder-vars-open    { nodeId, folderName, variables } — user opened folder vars
 *   hippo:run-folder          { folderId }       — run every request in a folder
 *   hippo:cancel-request      { requestId }      — stop a running request from the tree
 *   hippo:timeline-clear      { requestId }      — clear a request's run history
 */

"use strict";

import { PopupManager } from "../popup-manager.js";
import { Notifications } from "../notifications.js";
import { icon } from "../icons.js";
import { t } from "../i18n.js";
import { electronAccelerator } from "../keymap.js";
import { escapeHtml } from "../utils/html.js";
import { deepClone } from "../utils/clone.js";
import {
  buildFolderChain,
  collectTemplateVariables,
} from "./variable-resolver.js";
import { varsArrayToMap } from "./variable-shape.js";
import { computeDropPos } from "./drag-drop.js";
import {
  findParentId,
  insertChild,
  removeNode,
  findNode,
  cloneWithNewIds,
  insertNodeAfter,
  canDrop,
  moveNode,
  updateNodeName,
  patchNodeFields,
  getFlatRequests,
  collectRequestIds,
} from "./tree-model.js";
import { NO_BODY_METHODS } from "./request-payload.js";
import { buildRequestModel, generateCode } from "./code-gen/index.js";
import { CodeGenModal } from "./code-gen-modal.js";

// SVG folder icons (Feather-style, stroke-based)
const ICON_FOLDER_CLOSED = icon("folderClosed", {
  size: 14,
  className: "tree-folder-icon",
});
const ICON_FOLDER_OPEN = icon("folderOpen", {
  size: 14,
  className: "tree-folder-icon",
});

export class TreeView {
  /** @type {HTMLElement} */
  #el;

  /** @type {object[]} — live copy of the full tree data */
  #items = [];

  /**
   * ID of the collection most recently interacted with.
   * "New Request" targets this collection; falls back to the first collection.
   * @type {string|null}
   */
  #activeCollectionId = null;

  /** @type {string|null} — id of the currently selected request node */
  #selectedId = null;

  /** @type {HTMLButtonElement} — kept to toggle disabled state */
  #btnNewRequest = null;

  /** @type {string|null} — id of the node currently being dragged */
  #dragId = null;

  /** @type {boolean} — true while the node being dragged is a folder/collection */
  #draggedIsCollection = false;

  /** @type {object} — active collection variables used for variable resolution in cURL generation */
  #collectionVariables = {};

  /** @type {Array} — active collection default headers, merged into cURL / code-gen */
  #collectionHeaders = [];

  /** @type {boolean} — true while the drag cursor is inside the treeview */
  #dragInsideTreeView = false;

  /** @type {boolean} — true after a successful in-tree drop */
  #dropHandled = false;

  /** @type {HTMLLIElement} — the grey placeholder shown while dragging */
  #dragPhantomEl = null;

  /** @type {Function|null} — document-level dragover handler, cleaned up on dragend */
  #docDragOverHandler = null;

  /** @type {Set<string>} — IDs of folders that are currently collapsed */
  #collapsedIds = new Set();

  /** @type {string|null} — localStorage key for persisting collapsed state, namespaced by env */
  #storageKey = null;

  /** @type {boolean} — when true, double-clicking a request loads and executes it */
  #doubleClickExecute = false;

  /** @type {string} — current filter query (lowercased) */
  #filterText = "";

  /** @type {HTMLElement|null} — inline filter bar, revealed via Cmd/Ctrl+F */
  #filterBarEl = null;

  /** @type {HTMLInputElement|null} — the filter text input inside #filterBarEl */
  #filterInput = null;

  /** @type {object[]} — favorited requests across all collections (enriched entries) */
  #favorites = [];

  /** @type {object[]} — recently-used requests across all collections (newest-first) */
  #recents = [];

  /** @type {Set<string>} — requestIds of favorites, for O(1) star/menu lookups */
  #favoriteIds = new Set();

  /** @type {boolean} — whether the Recents tab is enabled (appearance setting) */
  #showRecents = false;

  /** @type {"requests"|"favorites"|"recents"} — which sidebar surface is shown */
  #activeTab = "requests";

  /** @type {HTMLElement|null} — the [Requests | Favorites | Recents] tab bar */
  #tabBarEl = null;

  /** @type {HTMLButtonElement|null} */
  #tabReqBtn = null;

  /** @type {HTMLButtonElement|null} */
  #tabFavBtn = null;

  /** @type {HTMLButtonElement|null} */
  #tabRecBtn = null;

  /** @type {Set<string>} — ids of requests currently in flight (requests run concurrently) */
  #loadingIds = new Set();

  /** @type {Set<string>} — ids of requests with a live background WebSocket connection */
  #wsLiveIds = new Set();

  /**
   * @type {Map<string, {running:boolean, passed:number, total:number, failed:number, completed:number, count:number}>}
   * Per-folder "Run All Requests" tallies, keyed by folder id. Drives the
   * pass/total badge on the folder row (set live by app.js's folder runner via
   * setFolderRunState). In-memory only — a session artifact, never persisted.
   */
  #folderRunResults = new Map();

  /** @type {HTMLElement|null} — the one row carrying tabindex="0" (the tab stop) */
  #rovingRow = null;

  /** @type {string} — accumulated type-ahead buffer, reset after a short pause */
  #typeaheadStr = "";

  /** @type {ReturnType<typeof setTimeout>|null} — clears the type-ahead buffer */
  #typeaheadTimer = null;

  /**
   * @param {object}   [opts]
   * @param {object[]} [opts.items]  - Initial tree data
   */
  constructor({ items = [] } = {}) {
    this.#el = document.createElement("div");
    this.#el.className = "tree-view";
    this.#el.setAttribute("role", "tree");
    // Focusable so a click anywhere in the main area (not just on a row) gives
    // the tree focus — that focus is what gates the Cmd/Ctrl+F filter shortcut.
    // tabindex="-1" keeps it out of the Tab order (the roving row owns that).
    this.#el.setAttribute("tabindex", "-1");

    // Create the phantom drop-target placeholder (shared, moved around the DOM)
    this.#dragPhantomEl = document.createElement("li");
    this.#dragPhantomEl.className = "tree-drop-phantom";
    this.#dragPhantomEl.setAttribute("aria-hidden", "true");

    this.#renderToolbar();
    this.#renderTabBar();
    this.#renderFilterBar();
    this.#items = items;
    this.#rerender();

    // Container-level: allow drop anywhere inside the treeview
    this.#el.addEventListener("dragover", (e) => {
      if (this.#dragId) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }
    });

    // Per-node in-flight spinner: requests run concurrently, so each node
    // tracks its own loading state from the requestId carried by the
    // lifecycle events. The TreeView is an app-lifetime singleton, so these
    // window listeners are intentionally never removed.
    window.addEventListener("hippo:request-loading", (e) =>
      this.#setNodeLoading(e.detail?.requestId, true),
    );
    const settleNode = (e) => this.#setNodeLoading(e.detail?.requestId, false);
    window.addEventListener("hippo:response-received", settleNode);
    window.addEventListener("hippo:request-error", settleNode);

    // Container-level: handle the actual drop (phantom target stores where to drop)
    this.#el.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!this.#dragId) return;
      const targetId = this.#dragPhantomEl.dataset.targetId;
      const pos = this.#dragPhantomEl.dataset.targetPos;
      if (targetId && pos) {
        this.#dropHandled = true;
        this.#moveNode(this.#dragId, targetId, pos);
        // #moveNode → #rerender() rebuilds the DOM cleanly
      } else {
        this.#cancelDrag();
      }
    });

    // ── Keyboard navigation (roving tabindex composite) ─────────────────────
    // The tree is a single tab stop: exactly one row carries tabindex="0" (see
    // #initRovingTabindex); from there Arrow/Home/End/type-ahead move focus
    // between rows. Per-row Enter/Space handlers still own activation, so this
    // delegated handler deliberately ignores those keys. The rename input stops
    // propagation, so this never fires while editing a label.
    this.#el.addEventListener("keydown", (e) => {
      // Cmd+F (macOS) / Ctrl+F reveals the inline filter bar. This listener lives
      // on #el, so it only fires while focus is inside the tree — i.e. after the
      // user has clicked the treeview main area (or a row).
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        e.key.toLowerCase() === "f"
      ) {
        e.preventDefault();
        this.#showFilter();
        return;
      }
      // Escape hides the filter bar (and clears the query) whenever it is open,
      // whether focus is still in the input or back on a row.
      if (
        e.key === "Escape" &&
        this.#filterBarEl &&
        !this.#filterBarEl.hidden
      ) {
        e.preventDefault();
        this.#hideFilter();
        return;
      }
      // Cmd/Ctrl+D duplicates the focused row — only when it is a request (folders
      // are skipped, matching the requested scope). No-op when focus is elsewhere
      // in the tree (toolbar / filter input / a folder row).
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === "d"
      ) {
        const reqLi = e.target
          .closest?.(".tree-node-row")
          ?.closest(".tree-node--request");
        if (reqLi) {
          e.preventDefault();
          this.#duplicateNode(reqLi.dataset.id);
        }
        return;
      }
      // F2 begins an inline rename of the focused row (request or folder).
      if (e.key === "F2") {
        const li = e.target.closest?.(".tree-node-row")?.closest(".tree-node");
        if (li?.dataset.id) {
          e.preventDefault();
          this.#renameNode(li.dataset.id);
        }
        return;
      }
      // Delete / Backspace on a focused row (request or folder) opens the context
      // menu already armed to the "Confirm?" state for delete, so a single
      // confirming click removes it (or dismiss to cancel). Backspace is included
      // because it is the de-facto delete key on macOS laptops. No-op (and no
      // preventDefault) when focus is not on a node row — e.g. the filter input,
      // where Backspace must keep editing text.
      if (e.key === "Delete" || e.key === "Backspace") {
        const row = e.target.closest?.(".tree-node-row");
        const li = row?.closest(".tree-node");
        const node = li?.dataset.id
          ? findNode(this.#items, li.dataset.id)
          : null;
        if (node) {
          e.preventDefault();
          const r = (row ?? li).getBoundingClientRect();
          this.#setActiveRow(li);
          this.#showContextMenu(
            node,
            findParentId(this.#items, node.id) ?? null,
            Math.round(r.left + 8),
            Math.round(r.bottom),
            "delete",
          );
        }
        return;
      }
      const row = e.target.closest?.(".tree-node-row");
      if (row) this.#handleTreeKeydown(e, row);
    });
    // Whatever gains focus inside the tree becomes the tab stop, so a Tab
    // out-and-back returns to where the user was (click, arrow, or programmatic).
    this.#el.addEventListener("focusin", (e) => {
      const row = e.target.closest?.(".tree-node-row");
      if (row && this.#isRowVisible(row)) this.#setRovingTabindex(row);
    });
  }

  /** Root DOM element — pass to Panel.mount(). */
  get element() {
    return this.#el;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Replace the full tree data and re-render.
   * Does NOT fire hippo:collections-changed (caller already owns the source of truth).
   * @param {object[]} items
   */
  setItems(items) {
    this.#items = Array.isArray(items) ? items : [];
    // Loading a collection's tree always shows the Requests surface.
    this.#activeTab = "requests";
    this.#syncButtonState();
    this.#rerender();
  }

  /**
   * Return a deep clone of the current items array.
   * @returns {object[]}
   */
  getItems() {
    return deepClone(this.#items);
  }

  /**
   * Update the active collection variables used when generating cURL commands.
   * Call this whenever the active collection or its variables change.
   *
   * @param {object} vars  — plain { name: value } map of resolved env variables
   */
  setEnvVariables(vars) {
    this.#collectionVariables = vars && typeof vars === "object" ? vars : {};
  }

  /**
   * Set the active collection's default headers, merged into generated cURL /
   * code snippets (a same-named request header overrides them). Call whenever the
   * active collection or its headers change.
   * @param {Array} headers  [{ enabled, name, value }]
   */
  setCollectionHeaders(headers) {
    this.#collectionHeaders = Array.isArray(headers) ? headers : [];
  }

  /**
   * Set the localStorage namespace key for persisting folder collapsed state.
   * Call this before setItems() whenever the active collection changes.
   * @param {string|null} key
   */
  setStorageKey(key) {
    this.#storageKey = key ?? null;
    this.#collapsedIds = new Set(this.#loadCollapsedState());
  }

  /**
   * Enable or disable the double-click-to-execute behaviour for request rows.
   * @param {boolean} enabled
   */
  setDoubleClickExecute(enabled) {
    this.#doubleClickExecute = !!enabled;
  }

  // ── Quick access (favorites / recents) ──────────────────────────────────

  /**
   * Replace the favorites list (enriched entries spanning all collections) and
   * refresh the star indicators, tab bar, and — when visible — the list itself.
   * @param {object[]} list  — [{ collectionId, requestId, name, method }]
   */
  setFavorites(list) {
    this.#favorites = Array.isArray(list) ? list : [];
    this.#favoriteIds = new Set(this.#favorites.map((e) => e.requestId));
    if (this.#activeTab === "requests") {
      this.#updateTabBar();
      this.#syncStars();
    } else {
      // Favorites/recents surfaces both render stars, so rebuild them.
      this.#rerender();
    }
  }

  /**
   * Replace the recents list (newest-first). Only rebuilds the surface when the
   * Recents tab is currently showing — keeps the open-request hot path cheap.
   * @param {object[]} list  — [{ collectionId, requestId, name, method }]
   */
  setRecents(list) {
    this.#recents = Array.isArray(list) ? list : [];
    if (this.#activeTab === "recents") this.#rerender();
  }

  /**
   * Enable/disable the Recents tab. Hiding it while it is active falls back to
   * the Requests surface.
   * @param {boolean} enabled
   */
  setShowRecents(enabled) {
    this.#showRecents = !!enabled;
    if (this.#activeTab === "recents") this.#rerender();
    else this.#updateTabBar();
  }

  /**
   * Switch to the Requests surface, select the request by id (firing
   * hippo:request-selected), and scroll it into view. Used when opening a
   * request from the Favorites/Recents lists.
   * @param {string} id
   * @returns {boolean} true if the request was found and selected
   */
  focusRequest(id) {
    this.#activeTab = "requests";
    this.#rerender();
    const ok = this.selectById(id);
    const li = this.#el.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (li) li.scrollIntoView({ block: "nearest" });
    return ok;
  }

  // ── Public keyboard-shortcut entry points ────────────────────────────────

  /**
   * Create a new request, mirroring the toolbar [+] button. No-op when no
   * collection exists yet (the toolbar button is disabled in that state).
   * Driven by the ⌘/Ctrl+N shortcut / File-menu item.
   */
  newRequest() {
    if (this.#btnNewRequest?.disabled) return;
    this.#addRequest();
  }

  /**
   * Create a new WebSocket request, mirroring the toolbar [+] secondary menu.
   * No-op when no collection exists yet. Driven by ⌥⌘N / Ctrl+Alt+N.
   */
  newWebSocketRequest() {
    if (this.#btnNewRequest?.disabled) return;
    this.#addRequest({ protocol: "websocket" });
  }

  /**
   * Create a new collection — or a nested folder when a node is selected —
   * mirroring the toolbar's New Collection button. Driven by ⌘/Ctrl+Shift+N.
   */
  newCollection() {
    this.#addCollection();
  }

  /**
   * Activate one of the surface tabs by name, driven by the ⌘/Ctrl+1‒3
   * shortcuts. Silently ignores a tab that is not currently available (no
   * favorites yet, or Recents disabled in settings).
   * @param {"requests"|"favorites"|"recents"} tab
   */
  activateTab(tab) {
    if (tab === "favorites" && this.#favorites.length === 0) return;
    if (tab === "recents" && !this.#showRecents) return;
    this.#switchTab(tab);
  }

  /**
   * Move the selection to the next (dir>0) or previous (dir<0) visible request
   * row and open it, as if the user clicked it. Clamps at the ends (no wrap).
   * No-op when there are no visible requests. Driven by ⌥⌘↓ / ⌥⌘↑.
   * @param {1|-1} dir
   */
  selectAdjacent(dir) {
    const rows = [...this.#el.querySelectorAll(".tree-node--request")].filter(
      (li) => {
        const row = li.querySelector(":scope > .tree-node-row");
        return row && this.#isRowVisible(row);
      },
    );
    if (!rows.length) return;
    const cur = rows.findIndex((li) => li.dataset.id === this.#selectedId);
    const next =
      cur === -1
        ? dir > 0
          ? 0
          : rows.length - 1
        : Math.max(0, Math.min(rows.length - 1, cur + dir));
    const li = rows[next];
    if (!li) return;
    if (li.dataset.id !== this.#selectedId) this.selectById(li.dataset.id);
    li.scrollIntoView({ block: "nearest" });
  }

  /**
   * Open the folder-scope variable editor for the current selection — the same
   * popup the context menu's "Variables" item opens. The scope resolves to: the
   * selected node when it is a container (collection / folder), otherwise its
   * parent container, otherwise the active collection. No-op when none exists.
   * Driven by ⇧⌘/Ctrl+E.
   */
  openSelectedVariables() {
    let id = this.#selectedId;
    let node = id ? findNode(this.#items, id) : null;
    if (node && node.type !== "collection") {
      // A request (leaf) is selected — edit its containing folder instead.
      id = findParentId(this.#items, node.id);
      node = id ? findNode(this.#items, id) : null;
    }
    if (!node && this.#activeCollectionId)
      node = findNode(this.#items, this.#activeCollectionId);
    if (node) this.#openNodeVariables(node);
  }

  /**
   * Fire the folder-vars-open event for a container node (collection / folder),
   * which app.js routes to the variables popup. The single source of the event
   * shape, shared by the "Variables" context-menu item and openSelectedVariables.
   * @param {{ id:string, name:string, variables?:object[] }} node
   */
  #openNodeVariables(node) {
    window.dispatchEvent(
      new CustomEvent("hippo:folder-vars-open", {
        detail: {
          nodeId: node.id,
          folderName: node.name,
          variables: node.variables ?? [],
        },
        bubbles: true,
      }),
    );
  }

  // ── Toolbar ─────────────────────────────────────────────────────────────

  #renderToolbar() {
    const bar = document.createElement("div");
    bar.className = "tree-toolbar";

    // New Collection button
    const btnNewCollection = document.createElement("button");
    btnNewCollection.className = "icon-btn";
    btnNewCollection.title = t("tree.newCollection");
    btnNewCollection.setAttribute("aria-label", t("tree.newCollection"));
    btnNewCollection.innerHTML = `<span class="icon">${icon("folderClosed", { size: 16 })}</span>`;
    btnNewCollection.addEventListener("click", () => this.#addCollection());

    // New Request button — disabled until at least one collection exists
    this.#btnNewRequest = document.createElement("button");
    this.#btnNewRequest.className = "icon-btn";
    this.#btnNewRequest.title = t("tree.newRequest");
    this.#btnNewRequest.setAttribute("aria-label", t("tree.newRequest"));
    this.#btnNewRequest.innerHTML = `<span class="icon">${icon("add", { size: 16 })}</span>`;
    this.#btnNewRequest.disabled = true;
    this.#btnNewRequest.addEventListener("click", () => this.#addRequest());
    // Secondary (right) click offers a choice of request protocol so a
    // WebSocket request can be created from the toolbar, not just a folder's
    // context menu. The chosen request still lands where a left-click would.
    this.#btnNewRequest.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (this.#btnNewRequest.disabled) return;
      this.#showNewRequestMenu(e.clientX, e.clientY);
    });

    bar.appendChild(btnNewCollection);
    bar.appendChild(this.#btnNewRequest);
    this.#el.appendChild(bar);
  }

  // ── Filter bar (inline, Cmd/Ctrl+F) ──────────────────────────────────────

  /**
   * Build the inline filter bar. It sits between the tab bar and the list and
   * stays hidden until the user presses Cmd/Ctrl+F with focus inside the tree;
   * Escape hides it again and clears the query. Built once and reused — the
   * #rerender() path only ever rebuilds the .tree-list, never this bar.
   */
  #renderFilterBar() {
    const bar = document.createElement("div");
    bar.className = "tree-filter-bar";
    bar.hidden = true;

    const label = document.createElement("label");
    label.className = "tree-filter-label";
    label.htmlFor = "tree-filter-input";
    label.textContent = t("tree.filterLabel");

    const search = document.createElement("input");
    search.id = "tree-filter-input";
    search.className = "tree-search";
    search.type = "text";
    search.placeholder = t("tree.filterPlaceholder");
    // The visible label provides context for sighted users; the richer
    // aria-label stays the accessible name for assistive tech.
    search.setAttribute("aria-label", t("tree.filterAria"));
    search.addEventListener("input", () => {
      this.#filterText = search.value.trim().toLowerCase();
      this.#applyFilter();
    });

    // Close (✕) button — the input's flex:1 pushes it to the far right. Clicking
    // it cancels the filter, identical to pressing Escape in the input.
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "tree-filter-close";
    closeBtn.title = t("tree.filterCloseTitle");
    closeBtn.setAttribute("aria-label", t("tree.filterCloseAria"));
    closeBtn.innerHTML = icon("close", { size: 12 });
    closeBtn.addEventListener("click", () => this.#hideFilter());

    bar.appendChild(label);
    bar.appendChild(search);
    bar.appendChild(closeBtn);
    this.#filterBarEl = bar;
    this.#filterInput = search;
    this.#el.appendChild(bar);
  }

  /** Reveal the inline filter bar and focus its input (selecting any text). */
  #showFilter() {
    if (!this.#filterBarEl) return;
    this.#filterBarEl.hidden = false;
    this.#filterInput.focus();
    this.#filterInput.select();
  }

  /**
   * Hide the inline filter bar, clear the query, restore the unfiltered tree,
   * and return focus to the tree so keyboard navigation keeps working.
   */
  #hideFilter() {
    if (!this.#filterBarEl || this.#filterBarEl.hidden) return;
    this.#filterBarEl.hidden = true;
    this.#filterInput.value = "";
    this.#filterText = "";
    this.#applyFilter();
    this.#rovingRow?.focus();
  }

  // ── Tab bar (Requests / Favorites / Recents) ────────────────────────────

  /**
   * Build the surface tab bar. It sits between the toolbar and the list and is
   * hidden until at least one favorite exists or the Recents tab is enabled.
   */
  #renderTabBar() {
    const bar = document.createElement("div");
    bar.className = "tree-tabs";
    bar.setAttribute("role", "tablist");
    bar.hidden = true;

    const mkTab = (tab, label) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tree-tab";
      btn.textContent = label;
      btn.setAttribute("role", "tab");
      btn.addEventListener("click", () => this.#switchTab(tab));
      bar.appendChild(btn);
      return btn;
    };

    this.#tabReqBtn = mkTab("requests", t("tree.tabRequests"));
    this.#tabFavBtn = mkTab("favorites", t("tree.tabFavorites"));
    this.#tabRecBtn = mkTab("recents", t("tree.tabRecent"));

    this.#tabBarEl = bar;
    this.#el.appendChild(bar);
  }

  /** Activate a tab and re-render the matching surface. */
  #switchTab(tab) {
    if (this.#activeTab === tab) return;
    this.#activeTab = tab;
    this.#rerender();
  }

  /**
   * Refresh tab-bar visibility and the active highlight. The bar shows when any
   * favorite exists or Recents is enabled; an active tab that becomes
   * unavailable falls back to Requests.
   */
  #updateTabBar() {
    if (!this.#tabBarEl) return;
    const favVisible = this.#favorites.length > 0;
    const recVisible = this.#showRecents;
    const barVisible = favVisible || recVisible;

    if (
      (this.#activeTab === "favorites" && !favVisible) ||
      (this.#activeTab === "recents" && !recVisible)
    ) {
      this.#activeTab = "requests";
    }

    this.#tabBarEl.hidden = !barVisible;
    this.#tabFavBtn.hidden = !favVisible;
    this.#tabRecBtn.hidden = !recVisible;
    this.#tabReqBtn.classList.toggle(
      "tree-tab--active",
      this.#activeTab === "requests",
    );
    this.#tabFavBtn.classList.toggle(
      "tree-tab--active",
      this.#activeTab === "favorites",
    );
    this.#tabRecBtn.classList.toggle(
      "tree-tab--active",
      this.#activeTab === "recents",
    );
  }

  /**
   * Surgically add/remove the favorite star on the visible request rows so the
   * tree never needs a full rebuild when a favorite is toggled.
   */
  #syncStars() {
    this.#el.querySelectorAll(".tree-node--request").forEach((li) => {
      const id = li.dataset.id;
      if (!id) return; // skip quick-list rows (they use data-qa-id)
      const fav = this.#favoriteIds.has(id);
      li.classList.toggle("tree-node--favorite", fav);
      const row = li.querySelector(":scope > .tree-node-row");
      const hot = row?.querySelector(":scope > .tree-node-star");
      if (hot) this.#updateHotspot(hot, fav);
      // Keep the visually-hidden "Favorited" label in step with the star so a
      // screen reader doesn't announce stale state after a surgical toggle.
      if (row) {
        const sr = row.querySelector(":scope > .tree-node-fav-sr");
        if (fav && !sr) row.appendChild(this.#makeSrText(t("tree.favorited")));
        else if (!fav && sr) sr.remove();
      }
    });
  }

  /**
   * Build the favorite hotspot for a request row — an always-present, invisible
   * target in the left gutter. Double-clicking it toggles the request's
   * favorite state (favoriting an empty spot, unfavoriting a starred one); the
   * star glyph is shown inside it while favorited. Single clicks are swallowed
   * so the gesture never also selects or executes the row.
   * @param {string} requestId
   */
  #makeFavHotspot(requestId) {
    const hot = document.createElement("span");
    hot.className = "tree-node-star";
    hot.setAttribute("aria-hidden", "true");
    this.#updateHotspot(hot, this.#favoriteIds.has(requestId));
    hot.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
    });
    hot.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      e.preventDefault();
      window.dispatchEvent(
        new CustomEvent("hippo:favorite-toggle", {
          detail: {
            node: findNode(this.#items, requestId) ?? { id: requestId },
            favorited: !this.#favoriteIds.has(requestId),
          },
          bubbles: true,
        }),
      );
    });
    return hot;
  }

  /**
   * A visually-hidden span that adds `text` to a row's screen-reader name —
   * the favorite star is otherwise a purely visual (aria-hidden) indicator, so
   * this is how the "favorited" state reaches assistive tech.
   */
  #makeSrText(text) {
    const span = document.createElement("span");
    // tree-node-fav-sr lets #syncStars find + remove this label surgically.
    span.className = "sr-only tree-node-fav-sr";
    span.textContent = text;
    return span;
  }

  /** Reflect favorite state in a hotspot: show the star glyph and its tooltip. */
  #updateHotspot(hot, favorited) {
    hot.textContent = favorited ? "★" : "";
    hot.title = favorited ? t("tree.unfavoriteHint") : t("tree.favoriteHint");
  }

  // ── Quick-access list rendering (favorites / recents) ───────────────────

  /**
   * Render a flat list of favorited or recent requests spanning all
   * collections. Each row opens/focuses its request via hippo:request-open.
   * @param {"favorites"|"recents"} kind
   */
  #renderQuickList(kind) {
    const entries = kind === "favorites" ? this.#favorites : this.#recents;
    const listEl = document.createElement("ul");
    listEl.className = "tree-list";
    listEl.setAttribute("role", "group");

    if (entries.length === 0) {
      const empty = document.createElement("li");
      empty.className = "tree-empty";
      empty.innerHTML = `<span>${
        kind === "favorites" ? t("tree.emptyFavorites") : t("tree.emptyRecent")
      }</span>`;
      listEl.appendChild(empty);
    } else {
      entries.forEach((entry) =>
        listEl.appendChild(this.#createQuickRow(entry, kind)),
      );
    }

    this.#el.appendChild(listEl);
  }

  /**
   * Build a quick-access row for one favorites/recents entry. Mirrors a request
   * row (method badge + label, optional star) but carries data-qa-id instead of
   * data-id so tree lookups never collide with it, and dispatches
   * hippo:request-open on activation.
   * @param {object} entry  — { collectionId, requestId, name, method }
   * @param {"favorites"|"recents"} kind
   */
  #createQuickRow(entry, kind) {
    const li = document.createElement("li");
    li.className = "tree-node tree-node--request";
    li.setAttribute("role", "treeitem");
    li.dataset.qaId = entry.requestId;
    li.dataset.url = "";

    // The Favorites tab is all favorites, so the star is redundant there; only
    // flag a Recents row when it is also favorited.
    const isFav = kind === "recents" && this.#favoriteIds.has(entry.requestId);
    if (isFav) li.classList.add("tree-node--favorite");

    li.innerHTML = `
      <div class="tree-node-row" tabindex="-1">
        ${this.#methodBadgeHtml(entry.protocol, entry.method)}
        <span class="tree-node-label">${escapeHtml(entry.name || t("tree.unnamed"))}</span>
      </div>
    `;

    const row = li.querySelector(".tree-node-row");
    if (isFav) {
      row.insertBefore(this.#makeFavHotspot(entry.requestId), row.firstChild);
      row.appendChild(this.#makeSrText(t("tree.favorited")));
    }
    const open = () =>
      window.dispatchEvent(
        new CustomEvent("hippo:request-open", {
          detail: {
            collectionId: entry.collectionId,
            requestId: entry.requestId,
          },
          bubbles: true,
        }),
      );

    row.addEventListener("click", open);
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    });

    // Favorites rows offer a quick "Unfavorite"; recents are not editable.
    if (kind === "favorites") {
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.#showQuickContextMenu(entry, e.clientX, e.clientY);
      });
    }

    return li;
  }

  /** Minimal context menu for a favorites row: unfavorite. */
  async #showQuickContextMenu(entry, x, y) {
    const clickedId = await window.hippo.ui.contextMenu.show({
      items: [{ id: "unfavorite", label: t("tree.menu.unfavorite") }],
      x,
      y,
    });
    if (clickedId !== "unfavorite") return;
    window.dispatchEvent(
      new CustomEvent("hippo:favorite-toggle", {
        detail: {
          node: {
            id: entry.requestId,
            name: entry.name,
            method: entry.method,
          },
          favorited: false,
        },
        bubbles: true,
      }),
    );
  }

  // ── Context menu ────────────────────────────────────────────────────────

  /**
   * Populate and open a native OS context menu for a node.
   *
   * Danger items use a two-click confirm: the first click closes the menu and
   * re-pops it with the danger entry relabeled "Confirm?"; a second click on
   * that entry runs the action. Any other choice, dismissal, or Escape
   * cancels and restores the original labels on the next open.
   *
   * @param {object}      node
   * @param {string|null} parentCollectionId
   * @param {number}      x  clientX of the contextmenu event
   * @param {number}      y  clientY of the contextmenu event
   * @param {string|null} initialConfirmId  id pre-armed to its "Confirm?" state
   *                       (e.g. "delete" when opened via the Del key), so the
   *                       menu opens one click away from running that action.
   */
  async #showContextMenu(
    node,
    parentCollectionId,
    x,
    y,
    initialConfirmId = null,
  ) {
    // Action map keyed by id — callbacks can't be sent across IPC, so the
    // native menu returns an id and the dispatch happens here.
    const actions =
      node.type === "collection"
        ? {
            "add-request": () => this.#addRequestTo(node.id),
            "add-ws-request": () =>
              this.#addRequestTo(node.id, { protocol: "websocket" }),
            "add-folder": () => this.#addFolderTo(node.id),
            "run-folder": () => {
              const liveNode = findNode(this.#items, node.id) ?? node;
              window.dispatchEvent(
                new CustomEvent("hippo:run-folder", {
                  detail: { folderId: liveNode.id },
                }),
              );
            },
            "clear-run": () => this.#clearFolderRunCounts(node.id),
            rename: () => this.#renameNode(node.id),
            duplicate: () => this.#duplicateNode(node.id),
            variables: () =>
              this.#openNodeVariables(findNode(this.#items, node.id) ?? node),
            "export-collection": () => {
              const liveNode = findNode(this.#items, node.id) ?? node;
              window.dispatchEvent(
                new CustomEvent("hippo:export-collection", {
                  detail: { collection: liveNode },
                }),
              );
            },
            delete: () => this.#deleteNode(node.id),
          }
        : {
            "add-request": () => this.#addRequestAfter(node.id),
            "add-ws-request": () =>
              this.#addRequestAfter(node.id, { protocol: "websocket" }),
            "add-folder": () => this.#addFolderAfter(node.id),
            rename: () => this.#renameNode(node.id),
            favorite: () => {
              const liveNode = findNode(this.#items, node.id) ?? node;
              window.dispatchEvent(
                new CustomEvent("hippo:favorite-toggle", {
                  detail: {
                    node: liveNode,
                    favorited: !this.#favoriteIds.has(liveNode.id),
                  },
                  bubbles: true,
                }),
              );
            },
            duplicate: () => this.#duplicateNode(node.id),
            "generate-code": () => this.#generateCode(node),
            "copy-as-curl": () => this.#copyAsCurl(node),
            "clear-history": () =>
              window.dispatchEvent(
                new CustomEvent("hippo:timeline-clear", {
                  detail: { requestId: node.id },
                }),
              ),
            delete: () => this.#deleteNode(node.id),
          };

    const baseItems =
      node.type === "collection"
        ? [
            {
              id: "add-folder",
              label: t("tree.menu.addFolder"),
              accelerator: electronAccelerator("newCollection"),
            },
            {
              id: "add-request",
              label: t("tree.menu.addRequest"),
              accelerator: electronAccelerator("newRequest"),
            },
            {
              id: "add-ws-request",
              label: t("tree.menu.addWsRequest"),
              accelerator: electronAccelerator("newWsRequest"),
            },
            { type: "separator" },
            // Disabled when the folder holds no runnable (HTTP) requests — the
            // app.js handler would otherwise just toast "nothing to run".
            {
              id: "run-folder",
              label: t("tree.menu.runFolder"),
              enabled: this.#folderHasRunnable(
                findNode(this.#items, node.id) ?? node,
              ),
            },
            // Only offered once a run has left a tally badge on this folder;
            // clears this folder's counts and every sub-folder's counts.
            ...(this.#folderRunResults.has(node.id)
              ? [{ id: "clear-run", label: t("tree.menu.clearRunCounts") }]
              : []),
            { type: "separator" },
            {
              id: "rename",
              label: t("tree.menu.rename"),
              accelerator: electronAccelerator("rename"),
            },
            { type: "separator" },
            {
              id: "variables",
              label: t("tree.menu.variables"),
              accelerator: electronAccelerator("folderVariables"),
            },
            { type: "separator" },
            {
              id: "duplicate",
              label: t("tree.menu.duplicate"),
              accelerator: electronAccelerator("duplicate"),
            },
            { id: "export-collection", label: t("tree.menu.export") },
            { type: "separator" },
            {
              id: "delete",
              label: t("tree.menu.delete"),
              danger: true,
              accelerator: electronAccelerator("delete"),
            },
          ]
        : [
            {
              id: "add-folder",
              label: t("tree.menu.addFolder"),
              accelerator: electronAccelerator("newCollection"),
            },
            {
              id: "add-request",
              label: t("tree.menu.addRequest"),
              accelerator: electronAccelerator("newRequest"),
            },
            {
              id: "add-ws-request",
              label: t("tree.menu.addWsRequest"),
              accelerator: electronAccelerator("newWsRequest"),
            },
            { type: "separator" },
            {
              id: "rename",
              label: t("tree.menu.rename"),
              accelerator: electronAccelerator("rename"),
            },
            {
              id: "favorite",
              label: this.#favoriteIds.has(node.id)
                ? t("tree.menu.unfavorite")
                : t("tree.menu.favorite"),
            },
            { type: "separator" },
            {
              id: "duplicate",
              label: t("tree.menu.duplicate"),
              accelerator: electronAccelerator("duplicate"),
            },
            // Code generation has no WebSocket equivalent, so omit it for ws.
            ...(node.protocol !== "websocket"
              ? [
                  { id: "generate-code", label: t("tree.menu.generateCode") },
                  { id: "copy-as-curl", label: t("tree.menu.copyAsCurl") },
                ]
              : []),
            // Requests carry run history; offer to clear it. danger:true wires
            // the two-click "Confirm?" safety net automatically.
            ...(node.type === "request"
              ? [
                  {
                    id: "clear-history",
                    label: t("tree.menu.clearHistory"),
                    danger: true,
                  },
                ]
              : []),
            { type: "separator" },
            {
              id: "delete",
              label: t("tree.menu.delete"),
              danger: true,
              accelerator: electronAccelerator("delete"),
            },
          ];

    // Loop so a danger click can re-open the menu with the entry relabeled to
    // "Confirm?". A second click on that entry confirms; any other choice
    // runs the chosen action; dismiss cancels. The menu may open already armed
    // (initialConfirmId) — e.g. the Del key arms "delete" up front.
    let confirmingId = initialConfirmId;
    while (true) {
      const items = baseItems.map((it) =>
        it.id === confirmingId
          ? // Drop the key hint on the armed "Confirm?" entry — it only makes
            // sense next to the resting "Delete" label.
            {
              ...it,
              label: t("tree.menu.confirm"),
              danger: false,
              accelerator: undefined,
            }
          : it,
      );

      const clickedId = await window.hippo.ui.contextMenu.show({
        items: items.map(({ id, label, type, enabled, accelerator }) => ({
          id,
          label,
          type,
          enabled,
          accelerator,
        })),
        x,
        y,
      });

      if (!clickedId) return; // dismissed

      if (clickedId === confirmingId) {
        // The relabeled item was confirmed — run the original danger action.
        actions[clickedId]?.();
        return;
      }

      const isDanger = baseItems.find((it) => it.id === clickedId)?.danger;
      if (isDanger) {
        confirmingId = clickedId;
        continue;
      }

      actions[clickedId]?.();
      return;
    }
  }

  /**
   * HTML for a request row's leading badge. WebSocket requests (protocol
   * "websocket") show a "WS" badge; everything else shows the HTTP method.
   * @param {string|undefined} protocol
   * @param {string|undefined} method
   * @returns {string}
   */
  #methodBadgeHtml(protocol, method) {
    if (protocol === "websocket") {
      return `<span class="tree-node-method tree-node-method--ws" title="${t("request.ws.label")}">${t("request.ws.badge")}</span>`;
    }
    const m = method ?? "GET";
    const title = document.documentElement.classList.contains(
      "show-method-icons",
    )
      ? ` title="${escapeHtml(m)}"`
      : "";
    return `<span class="tree-node-method method--${escapeHtml(m.toLowerCase())}"${title}>${escapeHtml(m)}</span>`;
  }

  // ── Mutations — toolbar ─────────────────────────────────────────────────

  /** Add a new collection or folder and persist.
   *  - Request selected → new folder inserted as first child of that request's parent folder.
   *  - Folder selected  → new folder inserted as first child of that folder.
   *  - No selection     → new top-level collection appended to the root.
   */
  #addCollection() {
    const parentId = this.#selectedId
      ? findParentId(this.#items, this.#selectedId)
      : (this.#activeCollectionId ?? null);

    if (parentId) {
      const folder = {
        id: crypto.randomUUID(),
        type: "collection",
        name: "New Folder",
        children: [],
      };
      this.#collapsedIds.delete(parentId);
      this.#saveCollapsedState();
      this.#items = insertChild(this.#items, parentId, folder);
      this.#activeCollectionId = folder.id;
      this.#syncButtonState();
      this.#rerender();
      this.#emitChange();
      const li = this.#el.querySelector(`[data-id="${CSS.escape(folder.id)}"]`);
      if (li) this.#setActiveRow(li);
    } else {
      const collection = {
        id: crypto.randomUUID(),
        type: "collection",
        name: t("tree.newCollection"),
        children: [],
      };
      this.#items = [...this.#items, collection];
      this.#activeCollectionId = collection.id;
      this.#syncButtonState();
      this.#rerender();
      this.#emitChange();
    }
  }

  /**
   * Add a new request under the active collection (or the first collection).
   * If no collection exists the button is disabled, so this is a no-op guard.
   * Pass `{ protocol: "websocket" }` to create a WebSocket request instead of
   * HTTP — the target location is identical either way.
   */
  #addRequest({ protocol } = {}) {
    // Prefer the parent folder of the currently selected request so the new
    // request lands as a sibling. Fall back to the last-active collection.
    const targetId =
      (this.#selectedId
        ? findParentId(this.#items, this.#selectedId)
        : undefined) ??
      this.#activeCollectionId ??
      this.#items.find((n) => n.type === "collection")?.id;
    if (!targetId) return;
    this.#addRequestTo(targetId, { protocol });
  }

  /**
   * Native context menu for the toolbar [+] button (opened on secondary click).
   * Lets the user pick the protocol; the chosen request is then created in the
   * same place a plain [+] click would have created one.
   */
  async #showNewRequestMenu(x, y) {
    const clickedId = await window.hippo.ui.contextMenu.show({
      items: [
        { id: "add-request", label: t("tree.menu.addRequest") },
        { id: "add-ws-request", label: t("tree.menu.addWsRequest") },
      ],
      x,
      y,
    });
    if (clickedId === "add-request") this.#addRequest();
    else if (clickedId === "add-ws-request")
      this.#addRequest({ protocol: "websocket" });
  }

  // ── Mutations — context menu actions ────────────────────────────────────

  /**
   * Build a fresh request node. A WebSocket request carries `protocol` and no
   * HTTP method; a plain request defaults to GET.
   * @param {string} [protocol] "websocket" to create a WebSocket request
   */
  #newRequestNode(protocol) {
    const isWs = protocol === "websocket";
    return {
      id: crypto.randomUUID(),
      type: "request",
      name: isWs ? t("tree.newWebSocket") : t("tree.newRequest"),
      url: "",
      ...(isWs ? { protocol: "websocket" } : { method: "GET" }),
    };
  }

  /**
   * Add a new request directly inside the collection identified by `collectionId`.
   * Pass `{ protocol: "websocket" }` to create a WebSocket request instead of HTTP.
   */
  #addRequestTo(collectionId, { protocol } = {}) {
    const request = this.#newRequestNode(protocol);
    this.#collapsedIds.delete(collectionId);
    this.#saveCollapsedState();
    this.#items = insertChild(this.#items, collectionId, request);
    this.#rerender();
    this.#emitChange();
    const li = this.#el.querySelector(`[data-id="${CSS.escape(request.id)}"]`);
    if (li) this.#selectRequest(request, li);
  }

  /** Add a nested folder (collection) inside the collection identified by `collectionId`. */
  #addFolderTo(collectionId) {
    const folder = {
      id: crypto.randomUUID(),
      type: "collection",
      name: "New Folder",
      children: [],
    };
    this.#collapsedIds.delete(collectionId);
    this.#saveCollapsedState();
    this.#items = insertChild(this.#items, collectionId, folder);
    this.#rerender();
    this.#emitChange();
    const li = this.#el.querySelector(`[data-id="${CSS.escape(folder.id)}"]`);
    if (li) {
      this.#activeCollectionId = folder.id;
      this.#setActiveRow(li);
    }
  }

  /**
   * Insert a new request as a sibling immediately after the node with `nodeId`.
   * Pass `{ protocol: "websocket" }` to create a WebSocket request instead of HTTP.
   */
  #addRequestAfter(nodeId, { protocol } = {}) {
    const request = this.#newRequestNode(protocol);
    this.#items = insertNodeAfter(this.#items, nodeId, request);
    this.#rerender();
    this.#emitChange();
    const li = this.#el.querySelector(`[data-id="${CSS.escape(request.id)}"]`);
    if (li) this.#selectRequest(request, li);
  }

  /** Insert a new folder as a sibling immediately after the node with `nodeId`. */
  #addFolderAfter(nodeId) {
    const folder = {
      id: crypto.randomUUID(),
      type: "collection",
      name: "New Folder",
      children: [],
    };
    this.#items = insertNodeAfter(this.#items, nodeId, folder);
    this.#rerender();
    this.#emitChange();
    const li = this.#el.querySelector(`[data-id="${CSS.escape(folder.id)}"]`);
    if (li) {
      this.#activeCollectionId = folder.id;
      this.#setActiveRow(li);
    }
  }

  /**
   * Begin inline rename for the node whose `data-id` matches `nodeId`.
   * Replaces the label span with a text input; commits on Enter or blur,
   * cancels on Escape.
   */
  #renameNode(nodeId) {
    const li = this.#el.querySelector(`[data-id="${CSS.escape(nodeId)}"]`);
    if (!li) return;
    const labelEl = li.querySelector(".tree-node-label");
    if (!labelEl) return;

    const originalName = labelEl.textContent;

    const input = document.createElement("input");
    input.type = "text";
    input.value = originalName;
    input.className = "tree-node-rename-input";
    input.setAttribute("aria-label", t("tree.menu.rename"));
    labelEl.replaceWith(input);
    input.select();
    input.focus();

    const commit = () => {
      const newName = input.value.trim() || originalName;
      this.#items = updateNodeName(this.#items, nodeId, newName);
      this.#rerender();
      if (newName !== originalName) this.#emitChange();
    };

    input.addEventListener("blur", commit, { once: true });
    input.addEventListener("keydown", (e) => {
      // Stop propagation so row-level keydown handlers (which preventDefault on
      // Space and Enter) don't interfere with typing inside the rename input.
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur(); // triggers blur → commit
      } else if (e.key === "Escape") {
        // Cancel: restore original without saving
        input.removeEventListener("blur", commit);
        const span = document.createElement("span");
        span.className = "tree-node-label";
        span.textContent = originalName;
        input.replaceWith(span);
      }
    });
  }

  /**
   * Deep-clone the node with `nodeId` (assigning new UUIDs throughout),
   * name it "<original> (copy)", and insert it right after the original.
   */
  #duplicateNode(nodeId) {
    const original = findNode(this.#items, nodeId);
    if (!original) return;

    const clone = cloneWithNewIds(original);
    clone.name = `${clone.name} (copy)`;
    this.#items = insertNodeAfter(this.#items, nodeId, clone);
    this.#rerender();
    this.#emitChange();

    if (clone.type === "request") {
      const li = this.#el.querySelector(`[data-id="${CSS.escape(clone.id)}"]`);
      if (li) this.#selectRequest(clone, li);
    }
  }

  /** Remove the node with `nodeId` from the tree at any nesting depth. */
  #deleteNode(nodeId) {
    // Collect all request IDs that live under the deleted node so the
    // caller (app.js) can remove the backing files from the backend.
    const deleted = findNode(this.#items, nodeId);
    const requestIds = deleted ? collectRequestIds(deleted) : [];
    const deletedIdSet = new Set(requestIds);

    // If the currently selected request is being deleted, find the next
    // closest request in depth-first order so we can auto-select it.
    let nextToSelect = null;
    const selectedWillBeDeleted =
      this.#selectedId != null && deletedIdSet.has(this.#selectedId);
    if (selectedWillBeDeleted) {
      const allRequests = getFlatRequests(this.#items);
      const deletedIndices = allRequests.reduce((acc, r, i) => {
        if (deletedIdSet.has(r.id)) acc.push(i);
        return acc;
      }, []);
      if (deletedIndices.length > 0) {
        const last = deletedIndices[deletedIndices.length - 1];
        const first = deletedIndices[0];
        nextToSelect =
          allRequests.slice(last + 1).find((r) => !deletedIdSet.has(r.id)) ??
          allRequests
            .slice(0, first)
            .reverse()
            .find((r) => !deletedIdSet.has(r.id)) ??
          null;
      }
    }

    this.#items = removeNode(this.#items, nodeId);
    if (this.#activeCollectionId === nodeId) this.#activeCollectionId = null;
    if (selectedWillBeDeleted) this.#selectedId = null;
    this.#syncButtonState();
    this.#rerender();
    this.#emitChange();

    if (selectedWillBeDeleted) {
      if (nextToSelect) {
        const li = this.#el.querySelector(
          `[data-id="${CSS.escape(nextToSelect.id)}"]`,
        );
        if (li) this.#selectRequest(nextToSelect, li);
      } else {
        window.dispatchEvent(
          new CustomEvent("hippo:request-cleared", { bubbles: true }),
        );
      }
    }

    if (requestIds.length > 0) {
      window.dispatchEvent(
        new CustomEvent("hippo:requests-deleted", {
          detail: { ids: requestIds },
          bubbles: true,
        }),
      );
    }
  }

  /**
   * Resolve the live node + variable-resolver context for code generation, or
   * null when the node is not a request. The closure-captured `node` may be
   * stale: updateNode() replaces the node object in #items immutably, so any
   * field changes (bodyType, bodyFormRows, headers, params, …) made after the
   * DOM row was rendered are invisible through the old reference — always look
   * up the live version first.
   * @param {object} node
   * @returns {{ liveNode: object, context: object } | null}
   */
  #codeGenInputs(node) {
    const liveNode = findNode(this.#items, node.id) ?? node;
    if (liveNode.type !== "request") return null;
    return {
      liveNode,
      context: {
        collectionVariables: this.#collectionVariables,
        collectionHeaders: this.#collectionHeaders,
        folderChain: this.#resolverFolderChain(liveNode.id),
      },
    };
  }

  /**
   * Run the unresolved-variable pre-flight for a code-gen request. Returns true
   * when it warned — the caller should bail and let the dialog's action button
   * re-invoke with force=true.
   * @param {object} liveNode
   * @param {object} context
   * @param {() => void} onAction  re-run the generation, skipping the check
   * @returns {boolean}
   */
  #warnIfUnresolved(liveNode, context, onAction) {
    const allVars = collectTemplateVariables(
      this.#gatherNodeTemplates(liveNode),
      context,
    );
    if (allVars.some((v) => !v.found)) {
      PopupManager.warnVariables({ variables: allVars, onAction });
      return true;
    }
    return false;
  }

  /**
   * Context-menu "Generate code…" — open the multi-target preview dialog for a
   * request, after the unresolved-variable pre-flight.
   * @param {object} node
   * @param {boolean} [force=false]  skip the variable pre-flight check
   */
  #generateCode(node, force = false) {
    const inputs = this.#codeGenInputs(node);
    if (!inputs) return;
    const { liveNode, context } = inputs;
    if (
      !force &&
      this.#warnIfUnresolved(liveNode, context, () =>
        this.#generateCode(node, true),
      )
    )
      return;
    CodeGenModal.open(buildRequestModel(liveNode, context));
  }

  /**
   * Context-menu "Copy as cURL" — build the cURL snippet and write it straight
   * to the clipboard (the fast path that skips the preview dialog).
   * @param {object} node
   * @param {boolean} [force=false]  skip the variable pre-flight check
   */
  #copyAsCurl(node, force = false) {
    const inputs = this.#codeGenInputs(node);
    if (!inputs) return;
    const { liveNode, context } = inputs;
    if (
      !force &&
      this.#warnIfUnresolved(liveNode, context, () =>
        this.#copyAsCurl(node, true),
      )
    )
      return;

    const code = generateCode("curl", buildRequestModel(liveNode, context));
    navigator.clipboard
      .writeText(code)
      .then(() => {
        Notifications.success(t("tree.curlCopied"));
      })
      .catch(() => {
        Notifications.error(t("tree.copyFailedBody"), {
          title: t("tree.copyFailed"),
        });
      });
  }

  /**
   * Collect all template strings from a request node so every {{varName}}
   * token can be checked before cURL generation.
   * @param {object} node  a request-type tree node
   * @returns {string[]}
   */
  #gatherNodeTemplates(node) {
    const t = [node.url ?? ""];
    for (const p of node.params ?? []) {
      if (p.enabled) {
        t.push(p.name ?? "", p.value ?? "");
      }
    }
    if (Array.isArray(node.headers)) {
      for (const h of node.headers) {
        if (h.enabled) {
          t.push(h.name ?? "", h.value ?? "");
        }
      }
    }
    const authEnabled = node.authEnabled ?? true;
    const authType = node.authType ?? "none";
    if (authEnabled && authType !== "none") {
      t.push(node.authBasic?.username ?? "", node.authBasic?.password ?? "");
      t.push(node.authBearer?.token ?? "");
      t.push(node.authOAuth2?.token ?? "");
    }
    // Only scan fields that will actually be sent — avoids false-positive
    // warnings for inactive body data retained while switching body types.
    const method = node.method ?? "GET";
    const bodyType = node.bodyType ?? "no-body";
    if (!NO_BODY_METHODS.has(method)) {
      switch (bodyType) {
        case "json":
        case "yaml":
        case "xml":
        case "text":
          t.push(node.bodyText ?? "");
          break;
        case "form-data":
        case "form-urlencoded":
          for (const r of node.bodyFormRows ?? []) {
            if (r.enabled) {
              t.push(r.name ?? "", r.value ?? "");
            }
          }
          break;
        default:
          break; // "no-body" / "file" — nothing to scan
      }
    }
    return t.filter(Boolean);
  }

  // ── Tree mutation helpers ───────────────────────────────────────────────

  /**
   * Build the folder chain for variable resolution, converting each node's
   * canonical array `.variables` into the { name: value } map the resolver
   * consumes. The resolver context is the boundary where arrays flatten to maps.
   * @param {string} nodeId
   * @returns {object[]}  folder-chain nodes with map-shaped `.variables`
   */
  #resolverFolderChain(nodeId) {
    return buildFolderChain(this.#items, nodeId).map((folder) => ({
      ...folder,
      variables: varsArrayToMap(folder.variables),
    }));
  }

  // ── Rendering ───────────────────────────────────────────────────────────

  #rerender() {
    const existing = this.#el.querySelector(".tree-list");
    if (existing) existing.remove();
    // Refresh the tab bar first — it may redirect an unavailable active tab
    // (e.g. the Favorites tab after the last favorite was removed) to Requests.
    this.#updateTabBar();
    if (this.#activeTab === "requests") {
      this.#renderTree(this.#items);
    } else {
      this.#renderQuickList(this.#activeTab);
    }
    if (this.#filterText) this.#applyFilter();
    // The DOM was just rebuilt — re-establish the single keyboard tab stop.
    this.#initRovingTabindex();
  }

  #renderTree(items) {
    const listEl = document.createElement("ul");
    listEl.className = "tree-list";
    listEl.setAttribute("role", "group");

    if (items.length === 0) {
      const empty = document.createElement("li");
      empty.className = "tree-empty";
      empty.innerHTML =
        `<span class="placeholder-icon">${icon("folderOpen", { size: 24 })}</span>` +
        `<span>${t("tree.empty")}</span>`;
      listEl.appendChild(empty);
    } else {
      items.forEach((item) => listEl.appendChild(this.#createNode(item, null)));
    }

    this.#el.appendChild(listEl);
  }

  /**
   * Build a <li> element for a tree node.
   * @param {object}      node
   * @param {string|null} parentCollectionId  — id of the enclosing collection, or null for roots
   */
  #createNode(node, parentCollectionId) {
    const li = document.createElement("li");
    li.className = "tree-node";
    li.setAttribute("role", "treeitem");
    li.dataset.id = node.id ?? "";

    if (node.type === "collection") {
      const isExpanded = !this.#collapsedIds.has(node.id);
      li.classList.add("tree-node--collection");
      li.setAttribute("aria-expanded", String(isExpanded));
      li.innerHTML = `
        <div class="tree-node-row" tabindex="-1">
          <span class="tree-node-icon" aria-hidden="true">${isExpanded ? ICON_FOLDER_OPEN : ICON_FOLDER_CLOSED}</span>
          <span class="tree-node-label">${escapeHtml(node.name)}</span>
        </div>
      `;

      const row = li.querySelector(".tree-node-row");
      const iconEl = row.querySelector(".tree-node-icon");
      const labelEl = row.querySelector(".tree-node-label");

      // Re-apply a live/last "Run All Requests" tally badge across re-renders.
      if (this.#folderRunResults.has(node.id))
        this.#applyFolderBadge(row, node.id);

      /** Toggle this folder's expanded / collapsed state. */
      const toggleExpand = () => {
        const expanded = li.getAttribute("aria-expanded") === "true";
        this.#setNodeExpanded(li, !expanded);
      };

      // Single click anywhere on the row → select / highlight the row only (no toggle).
      row.addEventListener("click", () => {
        this.#activeCollectionId = node.id;
        this.#selectedId = null;
        this.#setActiveRow(li);
      });

      // Single (or double) click on the folder icon → also toggle expand/collapse.
      // Event bubbles to row, so selection is handled there automatically.
      iconEl.addEventListener("click", () => {
        toggleExpand();
      });

      // Double-click on the label text → toggle expand/collapse.
      // (The two preceding single-click events already selected the row.)
      labelEl.addEventListener("dblclick", () => {
        toggleExpand();
      });

      // Keyboard: Enter → toggle; Space → select only.
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.#activeCollectionId = node.id;
          this.#setActiveRow(li);
          toggleExpand();
        } else if (e.key === " ") {
          e.preventDefault();
          this.#activeCollectionId = node.id;
          this.#setActiveRow(li);
        }
      });

      // Right-click: select the row then show context menu
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.#activeCollectionId = node.id;
        this.#setActiveRow(li);
        this.#showContextMenu(node, parentCollectionId, e.clientX, e.clientY);
      });

      // Drag-to-reorder
      this.#attachDragListeners(node, row, li);

      const childList = document.createElement("ul");
      childList.className = "tree-list tree-list--nested";
      childList.setAttribute("role", "group");
      if (!isExpanded) childList.style.display = "none";
      (node.children ?? []).forEach((child) => {
        childList.appendChild(this.#createNode(child, node.id));
      });
      li.appendChild(childList);
    } else {
      // Request item
      li.classList.add("tree-node--request");
      li.dataset.url = (node.url ?? "").toLowerCase();
      // Every request row gets a favorite hotspot in the left gutter. It is
      // overlaid (no layout space), so the indent alignment is unchanged, and
      // double-clicking it toggles the favorite — even on an empty (non-starred)
      // spot.
      const isFav = this.#favoriteIds.has(node.id);
      if (isFav) li.classList.add("tree-node--favorite");
      // Restore the in-flight spinner across re-renders (drag, rename, …).
      if (this.#loadingIds.has(node.id)) li.classList.add("tree-node--loading");
      if (this.#wsLiveIds.has(node.id)) li.classList.add("tree-node--ws-live");
      li.innerHTML = `
        <div class="tree-node-row" tabindex="-1">
          ${this.#methodBadgeHtml(node.protocol, node.method)}
          <span class="tree-node-label">${escapeHtml(node.name)}</span>
        </div>
      `;

      const row = li.querySelector(".tree-node-row");
      row.insertBefore(this.#makeFavHotspot(node.id), row.firstChild);
      // The star is aria-hidden; surface the favorite state to screen readers.
      if (isFav) row.appendChild(this.#makeSrText(t("tree.favorited")));
      // Restore the stop/spinner control when re-rendering mid-flight (the
      // class alone was re-applied above; the control is a real element).
      if (this.#loadingIds.has(node.id)) {
        row.appendChild(this.#makeStopBtn(node.id));
      }
      if (this.#wsLiveIds.has(node.id)) {
        row.appendChild(this.#makeWsLiveDot());
      }

      // Left-click: select request
      row.addEventListener("click", () => {
        if (parentCollectionId) this.#activeCollectionId = parentCollectionId;
        this.#selectRequest(node, li);
      });
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          if (parentCollectionId) this.#activeCollectionId = parentCollectionId;
          this.#selectRequest(node, li);
        }
      });

      // Double-click: execute the request if the setting is enabled.
      // The preceding click already selected/loaded it, so just fire the execute event.
      row.addEventListener("dblclick", () => {
        if (!this.#doubleClickExecute) return;
        window.dispatchEvent(
          new CustomEvent("hippo:request-execute", {
            detail: findNode(this.#items, node.id) ?? node,
            bubbles: true,
          }),
        );
      });

      // Right-click: select the request then show context menu
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (parentCollectionId) this.#activeCollectionId = parentCollectionId;
        this.#selectRequest(node, li);
        this.#showContextMenu(node, parentCollectionId, e.clientX, e.clientY);
      });

      // Drag-to-reorder
      this.#attachDragListeners(node, row, li);
    }

    return li;
  }

  #applyFilter() {
    const q = this.#filterText;

    // Strip any existing <mark> highlights from all labels
    this.#el.querySelectorAll(".tree-node-label").forEach((el) => {
      el.textContent = el.textContent;
    });

    if (!q) {
      this.#el.querySelectorAll(".tree-node").forEach((li) => {
        li.style.display = "";
      });
      this.#el.querySelectorAll(".tree-node--collection").forEach((li) => {
        const childList = li.querySelector(":scope > .tree-list--nested");
        if (childList) {
          childList.style.display = this.#collapsedIds.has(li.dataset.id)
            ? "none"
            : "";
        }
      });
      return;
    }

    const applyNode = (li) => {
      const labelEl = li.querySelector(
        ":scope > .tree-node-row > .tree-node-label",
      );
      const name = labelEl?.textContent ?? "";
      const matches = name.toLowerCase().includes(q);

      if (li.classList.contains("tree-node--collection")) {
        const childList = li.querySelector(":scope > .tree-list--nested");
        let anyChildMatch = false;
        childList?.querySelectorAll(":scope > .tree-node").forEach((child) => {
          if (applyNode(child)) anyChildMatch = true;
        });

        if (matches || anyChildMatch) {
          li.style.display = "";
          if (matches && labelEl)
            labelEl.innerHTML = this.#highlightMatch(name, q);
          if (childList && anyChildMatch) childList.style.display = "";
          return true;
        }
        li.style.display = "none";
        return false;
      }

      // Request node — also match on URL
      const urlMatches = (li.dataset.url ?? "").includes(q);
      if (matches || urlMatches) {
        li.style.display = "";
        if (labelEl) labelEl.innerHTML = this.#highlightMatch(name, q);
        return true;
      }
      li.style.display = "none";
      return false;
    };

    this.#el
      .querySelectorAll(".tree-list:not(.tree-list--nested) > .tree-node")
      .forEach((li) => {
        applyNode(li);
      });
  }

  #highlightMatch(text, query) {
    const idx = text.toLowerCase().indexOf(query);
    if (idx === -1) return escapeHtml(text);
    const before = escapeHtml(text.slice(0, idx));
    const match = escapeHtml(text.slice(idx, idx + query.length));
    const after = escapeHtml(text.slice(idx + query.length));
    return `${before}<mark class="tree-highlight">${match}</mark>${after}`;
  }

  #setActiveRow(li) {
    this.#el.querySelectorAll(".tree-node--active").forEach((el) => {
      el.classList.remove("tree-node--active");
    });
    li.classList.add("tree-node--active");
  }

  /**
   * Expand or collapse a collection node in place (no full re-render), keeping
   * aria-expanded, the folder icon, the nested list's visibility, and the
   * persisted collapsed-state set in sync. Shared by the click/double-click
   * toggles and the ArrowLeft/ArrowRight keyboard handlers.
   * @param {HTMLElement} li        the .tree-node--collection element
   * @param {boolean}     expanded  desired state
   */
  #setNodeExpanded(li, expanded) {
    if (!li?.classList.contains("tree-node--collection")) return;
    const id = li.dataset.id;
    li.setAttribute("aria-expanded", String(expanded));
    const iconEl = li.querySelector(
      ":scope > .tree-node-row > .tree-node-icon",
    );
    if (iconEl) {
      iconEl.innerHTML = expanded ? ICON_FOLDER_OPEN : ICON_FOLDER_CLOSED;
    }
    const childList = li.querySelector(":scope > .tree-list--nested");
    if (childList) childList.style.display = expanded ? "" : "none";
    if (expanded) this.#collapsedIds.delete(id);
    else this.#collapsedIds.add(id);
    this.#saveCollapsedState();
  }

  // ── Keyboard navigation (roving tabindex) ─────────────────────────────────

  /**
   * Re-establish the single tab stop after a (re-)render. Exactly one row gets
   * tabindex="0"; every other row gets -1. Prefer the selected request's row
   * (so Tab re-enters where the user was), falling back to the first visible
   * row. Called at the end of #rerender, once the DOM has been rebuilt and the
   * previous #rovingRow is detached.
   */
  #initRovingTabindex() {
    const rows = [...this.#el.querySelectorAll(".tree-node-row")];
    rows.forEach((r) => r.setAttribute("tabindex", "-1"));
    this.#rovingRow = null;
    if (rows.length === 0) return;

    let target = null;
    if (this.#selectedId != null) {
      const li = this.#el.querySelector(
        `[data-id="${CSS.escape(this.#selectedId)}"]`,
      );
      const r = li?.querySelector(":scope > .tree-node-row");
      if (r && this.#isRowVisible(r)) target = r;
    }
    if (!target) target = rows.find((r) => this.#isRowVisible(r)) ?? rows[0];

    target.setAttribute("tabindex", "0");
    this.#rovingRow = target;
  }

  /**
   * Move the tab stop to `row` (the only one left tabbable). Pure tabindex
   * bookkeeping — does not move focus; #focusRow does that.
   */
  #setRovingTabindex(row) {
    if (this.#rovingRow === row) return;
    if (this.#rovingRow?.isConnected) {
      this.#rovingRow.setAttribute("tabindex", "-1");
    }
    this.#rovingRow = row;
    row?.setAttribute("tabindex", "0");
  }

  /** Move focus (and the tab stop) to `row`, scrolling it into view. */
  #focusRow(row) {
    if (!row) return;
    this.#setRovingTabindex(row);
    row.focus();
    row.scrollIntoView?.({ block: "nearest" });
  }

  /**
   * Is `row` currently visible? A row is hidden when any ancestor up to the
   * tree root carries inline display:none — exactly how collapsed folders
   * (childList.style.display) and filtered-out nodes (li.style.display) hide
   * themselves. Reads inline styles only, so it needs no layout (works headless).
   */
  #isRowVisible(row) {
    let el = row;
    while (el && el !== this.#el) {
      if (el.style?.display === "none") return false;
      el = el.parentElement;
    }
    return true;
  }

  /** All focusable rows in visual (DOM) order, skipping hidden ones. */
  #visibleRows() {
    return [...this.#el.querySelectorAll(".tree-node-row")].filter((r) =>
      this.#isRowVisible(r),
    );
  }

  /**
   * Route a keydown on a focused tree row to the matching navigation action.
   * Enter/Space are intentionally left to the per-row activation handlers.
   * @param {KeyboardEvent} e
   * @param {HTMLElement}   row  the focused .tree-node-row
   */
  #handleTreeKeydown(e, row) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        this.#focusSibling(row, 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        this.#focusSibling(row, -1);
        break;
      case "Home": {
        e.preventDefault();
        const rows = this.#visibleRows();
        this.#focusRow(rows[0]);
        break;
      }
      case "End": {
        e.preventDefault();
        const rows = this.#visibleRows();
        this.#focusRow(rows[rows.length - 1]);
        break;
      }
      case "ArrowRight":
        e.preventDefault();
        this.#expandOrEnter(row);
        break;
      case "ArrowLeft":
        e.preventDefault();
        this.#collapseOrLeave(row);
        break;
      // Space is owned by the per-row activation handler (select-only); keep it
      // out of type-ahead so it doesn't pollute the search buffer.
      case " ":
        break;
      default:
        // A single printable character (no modifier) drives type-ahead.
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          this.#typeahead(e.key, row);
        }
    }
  }

  /** Move focus to the visible row `dir` steps away (clamped at the ends). */
  #focusSibling(row, dir) {
    const rows = this.#visibleRows();
    const i = rows.indexOf(row);
    if (i === -1) return;
    this.#focusRow(rows[i + dir]);
  }

  /**
   * ArrowRight: on a collapsed collection, expand it; on an expanded one, dive
   * to its first visible child; on a request (leaf) do nothing.
   */
  #expandOrEnter(row) {
    const li = row.closest(".tree-node");
    if (!li?.classList.contains("tree-node--collection")) return;
    if (li.getAttribute("aria-expanded") !== "true") {
      this.#setNodeExpanded(li, true);
      return;
    }
    const childRow = li.querySelector(
      ":scope > .tree-list--nested > .tree-node > .tree-node-row",
    );
    if (childRow && this.#isRowVisible(childRow)) this.#focusRow(childRow);
  }

  /**
   * ArrowLeft: on an expanded collection, collapse it; otherwise (a request, or
   * an already-collapsed collection) move focus up to the parent collection row.
   */
  #collapseOrLeave(row) {
    const li = row.closest(".tree-node");
    if (
      li?.classList.contains("tree-node--collection") &&
      li.getAttribute("aria-expanded") === "true"
    ) {
      this.#setNodeExpanded(li, false);
      return;
    }
    const parentLi = li?.parentElement?.closest(".tree-node--collection");
    const parentRow = parentLi?.querySelector(":scope > .tree-node-row");
    if (parentRow) this.#focusRow(parentRow);
  }

  /**
   * Type-ahead: focus the next visible row whose label starts with the keys
   * typed in quick succession. A lone repeated key cycles through matches;
   * extending the buffer refines from the current row. The buffer clears after
   * a short idle pause.
   */
  #typeahead(char, fromRow) {
    clearTimeout(this.#typeaheadTimer);
    this.#typeaheadTimer = setTimeout(() => {
      this.#typeaheadStr = "";
    }, 600);
    this.#typeaheadStr += char.toLowerCase();

    const rows = this.#visibleRows();
    if (rows.length === 0) return;
    const str = this.#typeaheadStr;
    const start = Math.max(0, rows.indexOf(fromRow));
    // A single char advances past the current row (so repeats cycle); a longer
    // buffer re-checks the current row first (so refining keeps the match).
    const offset = str.length === 1 ? 1 : 0;
    for (let k = 0; k < rows.length; k++) {
      const r = rows[(start + offset + k) % rows.length];
      const label = (
        r.querySelector(".tree-node-label")?.textContent ?? ""
      ).toLowerCase();
      if (label.startsWith(str)) {
        this.#focusRow(r);
        return;
      }
    }
  }

  /**
   * Toggle the in-flight spinner on a request node. Any number of nodes can
   * be loading at once. #loadingIds is the source of truth so #createNode can
   * re-apply the state across re-renders while a request is still running.
   */
  #setNodeLoading(requestId, loading) {
    if (!requestId) return;
    if (loading) {
      this.#loadingIds.add(requestId);
    } else {
      this.#loadingIds.delete(requestId);
    }
    const li = this.#el.querySelector(`[data-id="${CSS.escape(requestId)}"]`);
    if (!li) return;
    li.classList.toggle("tree-node--loading", loading);
    const row = li.querySelector(":scope > .tree-node-row");
    const existing = row?.querySelector(".tree-node-stop");
    if (loading && row && !existing) {
      row.appendChild(this.#makeStopBtn(requestId));
    } else if (!loading && existing) {
      existing.remove();
    }
  }

  /**
   * Update which request nodes show a live-WebSocket indicator dot.
   * Called by app.js whenever the set of background connections changes.
   * @param {Set<string>} ids - requestIds with an open connection
   */
  setWsLiveIds(ids) {
    const prev = this.#wsLiveIds;
    this.#wsLiveIds = ids instanceof Set ? ids : new Set(ids);
    const changed = new Set([...prev, ...this.#wsLiveIds]);
    for (const id of changed) {
      const li = this.#el.querySelector(`[data-id="${CSS.escape(id)}"]`);
      if (!li) continue;
      const isLive = this.#wsLiveIds.has(id);
      li.classList.toggle("tree-node--ws-live", isLive);
      const row = li.querySelector(":scope > .tree-node-row");
      const existing = row?.querySelector(".tree-node-ws-dot");
      if (isLive && row && !existing) {
        row.appendChild(this.#makeWsLiveDot());
      } else if (!isLive && existing) {
        existing.remove();
      }
    }
  }

  #makeWsLiveDot() {
    const dot = document.createElement("span");
    dot.className = "tree-node-ws-dot";
    dot.setAttribute("aria-hidden", "true");
    dot.title = t("tree.wsConnectionOpen");
    return dot;
  }

  /** True if a folder (recursively) contains at least one runnable HTTP request. */
  #folderHasRunnable(node) {
    for (const child of node.children ?? []) {
      if (child.type === "request" && child.protocol !== "websocket")
        return true;
      if (child.type === "collection" && this.#folderHasRunnable(child))
        return true;
    }
    return false;
  }

  /**
   * Set (or clear) the "Run All Requests" tally for a folder and patch its row
   * badge in place. Called by app.js's folder runner: once at start with
   * `{ running: true }`, after each request to advance the counts, and once at
   * the end with `{ running: false }`. Pass `null` to remove the badge.
   * @param {string} folderId
   * @param {object|null} state  { running, passed, total, failed, completed, count }
   */
  setFolderRunState(folderId, state) {
    if (!folderId) return;
    if (state == null) this.#folderRunResults.delete(folderId);
    else this.#folderRunResults.set(folderId, state);
    const li = this.#el.querySelector(`[data-id="${CSS.escape(folderId)}"]`);
    const row = li?.querySelector(":scope > .tree-node-row");
    this.#applyFolderBadge(row, folderId);
  }

  /**
   * Clear the "Run All Requests" tally badge from a folder and every collection
   * nested beneath it (the run subtree). Purely a display reset — the per-request
   * run history recorded in each request's Timeline is left untouched.
   * @param {string} folderId
   */
  #clearFolderRunCounts(folderId) {
    const folder = findNode(this.#items, folderId);
    if (!folder) return;
    const clear = (node) => {
      if (node.type === "collection") this.setFolderRunState(node.id, null);
      for (const child of node.children ?? []) clear(child);
    };
    clear(folder);
  }

  /**
   * Create / update / remove the pass-count badge on a folder row from the
   * stored tally. The badge text is the running `passed/total` test ratio; its
   * colour reflects the outcome once the run settles.
   * @param {HTMLElement|null} row  the folder's `.tree-node-row`
   * @param {string} folderId
   */
  #applyFolderBadge(row, folderId) {
    if (!row) return;
    const state = this.#folderRunResults.get(folderId);
    let badge = row.querySelector(":scope > .tree-node-test-count");
    if (!state) {
      badge?.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "tree-node-test-count";
      row.appendChild(badge);
    }
    const {
      running = false,
      passed = 0,
      total = 0,
      failed = 0,
      completed = 0,
      count = 0,
    } = state;
    badge.textContent = `${passed}/${total}`;
    // Outcome colour only once the run has settled.
    const ok = !running && failed === 0 && total > 0 && passed === total;
    const bad = !running && (failed > 0 || passed < total);
    badge.classList.toggle("tree-node-test-count--running", running);
    badge.classList.toggle("tree-node-test-count--pass", ok);
    badge.classList.toggle("tree-node-test-count--fail", bad);
    // Tooltip: live progress while running; tests + any failed requests when done.
    if (running) {
      badge.title = t("tree.folderRun.running", { completed, count });
    } else {
      const parts = [
        t("tree.folderRun.tests", { passed, total, count: total }),
      ];
      if (failed > 0)
        parts.push(t("tree.folderRun.failedReqs", { failed, count: failed }));
      badge.title = parts.join(" · ");
    }
  }

  /**
   * The per-node stop control: shows the in-flight spinner ring and cancels
   * the request on click — the only way to stop a run that is not the one
   * loaded in the editor (whose URL-bar button reads Stop).
   */
  #makeStopBtn(requestId) {
    const btn = document.createElement("button");
    btn.className = "tree-node-stop";
    btn.setAttribute("aria-label", t("request.stopAria"));
    btn.title = t("request.stopAria");
    btn.addEventListener("click", (e) => {
      // Cancel only — do not select the row.
      e.stopPropagation();
      window.dispatchEvent(
        new CustomEvent("hippo:cancel-request", { detail: { requestId } }),
      );
    });
    // Keep rapid clicks from bubbling into the row's double-click-to-execute.
    btn.addEventListener("dblclick", (e) => e.stopPropagation());
    return btn;
  }

  #selectRequest(node, li) {
    // Skip re-loading the request (and its history/timeline) when the row is
    // already active — clicking or right-clicking the current selection
    // should not trigger another hippo:request-selected dispatch.
    const alreadyActive = li.classList.contains("tree-node--active");
    this.#selectedId = node.id;
    this.#setActiveRow(li);
    if (alreadyActive) return;

    // Always read the live node from #items so we get the latest field values.
    // The click-handler closure captures the node object at render time; if
    // updateNode() has since patched #items (creating a new object), the
    // closure reference would be stale and load outdated method/url/etc.
    const currentNode = findNode(this.#items, node.id) ?? node;

    window.dispatchEvent(
      new CustomEvent("hippo:request-selected", {
        detail: currentNode,
        bubbles: true,
      }),
    );
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  /** Enable / disable "New Request" based on whether any collection exists. */
  #syncButtonState() {
    if (!this.#btnNewRequest) return;
    const hasCollection = this.#items.some((n) => n.type === "collection");
    this.#btnNewRequest.disabled = !hasCollection;
  }

  /** Dispatch the canonical change event so app.js can auto-save. */
  #emitChange() {
    window.dispatchEvent(
      new CustomEvent("hippo:collections-changed", {
        detail: this.getItems(), // deep clone — callers must not mutate
        bubbles: true,
      }),
    );
  }

  #saveCollapsedState() {
    if (!this.#storageKey) return;
    try {
      localStorage.setItem(
        `hippo:collapsed:${this.#storageKey}`,
        JSON.stringify([...this.#collapsedIds]),
      );
    } catch {
      /* quota exceeded or private browsing — ignore */
    }
  }

  #loadCollapsedState() {
    if (!this.#storageKey) return [];
    try {
      const raw = localStorage.getItem(`hippo:collapsed:${this.#storageKey}`);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  // ── Drag-to-reorder ─────────────────────────────────────────────────────

  /**
   * Attach HTML5 drag-and-drop listeners to a row.
   * Called once per node in #createNode for both collections and requests.
   *
   * Behaviour:
   *  • dragstart  — hides the dragged <li> and inserts the phantom placeholder
   *                 where the item was.
   *  • dragover   — moves the phantom to show where the item would land.
   *  • dragend    — if not a successful in-tree drop, restores the original state.
   *  • Leaving the treeview temporarily restores the item; re-entering resumes.
   *  • Releasing outside the treeview cancels and restores original state.
   */
  #attachDragListeners(node, row, li) {
    row.draggable = true;

    // ── dragstart ──────────────────────────────────────────────────────────
    row.addEventListener("dragstart", (e) => {
      this.#dragId = node.id;
      this.#draggedIsCollection = node.type === "collection";
      this.#dropHandled = false;
      e.dataTransfer.effectAllowed = "move";
      // Required by Firefox to start the drag
      e.dataTransfer.setData("text/plain", node.id);

      const capturedDragId = node.id;
      requestAnimationFrame(() => {
        if (this.#dragId !== capturedDragId || !li.parentElement) return;
        this.#dragInsideTreeView = true;
        // Reset phantom metadata
        this.#dragPhantomEl.dataset.targetId = "";
        this.#dragPhantomEl.dataset.targetPos = "";
        this.#dragPhantomEl.dataset.posKey = "";
        // Insert phantom where the item was, then hide the actual item
        li.parentElement.insertBefore(this.#dragPhantomEl, li);
        li.style.display = "none";
      });

      // Defensive: drop any handler left over from a prior drag whose `dragend`
      // was never delivered (can happen when a drag ends outside the window), so
      // the document `dragover` listener can't accumulate across drags.
      if (this.#docDragOverHandler) {
        document.removeEventListener("dragover", this.#docDragOverHandler);
      }
      // Monitor the drag position relative to the treeview via document dragover
      this.#docDragOverHandler = (ev) => {
        if (!this.#dragId) return;
        const inside = this.#el.contains(ev.target);
        if (!inside && this.#dragInsideTreeView) {
          // Cursor left the treeview — remove phantom and restore the dragged item
          this.#dragInsideTreeView = false;
          this.#dragPhantomEl.remove();
          const draggedLi = this.#el.querySelector(
            `[data-id="${CSS.escape(this.#dragId)}"]`,
          );
          if (draggedLi) draggedLi.style.display = "";
        } else if (inside && !this.#dragInsideTreeView) {
          // Cursor re-entered the treeview — phantom will be placed on next row dragover
          this.#dragInsideTreeView = true;
        }
      };
      document.addEventListener("dragover", this.#docDragOverHandler);
    });

    // ── dragover ───────────────────────────────────────────────────────────
    row.addEventListener("dragover", (e) => {
      if (!this.#isDragAllowed(node)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";

      const rect = row.getBoundingClientRect();
      const ratio = (e.clientY - rect.top) / rect.height;

      const pos = computeDropPos(
        ratio,
        node.type,
        !this.#collapsedIds.has(node.id),
        this.#draggedIsCollection,
      );

      // Only move the phantom when the position actually changes (perf)
      const posKey = `${node.id}:${pos}`;
      if (this.#dragPhantomEl.dataset.posKey !== posKey) {
        this.#dragPhantomEl.dataset.posKey = posKey;
        this.#dragPhantomEl.dataset.targetId = node.id;
        this.#dragPhantomEl.dataset.targetPos = pos;
        this.#moveDragPhantom(li, pos, node);
      }
    });

    // ── dragend ────────────────────────────────────────────────────────────
    row.addEventListener("dragend", () => {
      if (!this.#dropHandled) {
        // Drag was cancelled (Escape) or released outside the treeview
        this.#cancelDrag();
      }
      // If drop was handled, #moveNode already re-rendered; just clean up state
      this.#finalizeDrag();
    });
  }

  /**
   * Move the phantom placeholder to the position indicated by `pos` relative
   * to `targetLi`.  Also ensures the dragged item's <li> is hidden (handles
   * re-entry into the treeview after briefly leaving).
   */
  #moveDragPhantom(targetLi, pos, targetNode) {
    // Ensure the dragged item stays hidden (e.g. after re-entering treeview)
    const draggedLi = this.#el.querySelector(
      `[data-id="${CSS.escape(this.#dragId)}"]`,
    );
    if (draggedLi && draggedLi.style.display !== "none") {
      draggedLi.style.display = "none";
    }

    if (pos === "before") {
      targetLi.parentElement.insertBefore(this.#dragPhantomEl, targetLi);
    } else if (pos === "after") {
      targetLi.parentElement.insertBefore(
        this.#dragPhantomEl,
        targetLi.nextSibling,
      );
    } else if (pos === "inside" && targetNode.type === "collection") {
      const childList = targetLi.querySelector(".tree-list--nested");
      if (childList && childList.style.display !== "none") {
        childList.insertBefore(this.#dragPhantomEl, childList.firstChild);
      } else {
        // Collapsed collection — treat as after
        targetLi.parentElement.insertBefore(
          this.#dragPhantomEl,
          targetLi.nextSibling,
        );
      }
    }
  }

  /**
   * Cancel an in-progress drag: remove the phantom and re-render from the
   * unchanged #items, which naturally restores the original tree state.
   */
  #cancelDrag() {
    this.#dragPhantomEl.remove();
    this.#rerender();
  }

  /**
   * Clean up all drag state variables and remove the document-level listener.
   * Must be called after #cancelDrag() or after a successful #moveNode().
   */
  #finalizeDrag() {
    if (this.#docDragOverHandler) {
      document.removeEventListener("dragover", this.#docDragOverHandler);
      this.#docDragOverHandler = null;
    }
    this.#dragId = null;
    this.#draggedIsCollection = false;
    this.#dragInsideTreeView = false;
    this.#dropHandled = false;
    this.#dragPhantomEl.dataset.targetId = "";
    this.#dragPhantomEl.dataset.targetPos = "";
    this.#dragPhantomEl.dataset.posKey = "";
  }

  /**
   * Return true when it is valid to drop the current drag onto `targetNode`.
   * Disallows dropping a node onto itself or into any of its own descendants.
   */
  #isDragAllowed(targetNode) {
    if (!this.#dragId) return false;
    return canDrop(this.#items, this.#dragId, targetNode.id);
  }

  /**
   * Move the node `draggedId` to a position relative to `targetId`.
   * @param {string} draggedId
   * @param {string} targetId
   * @param {'before'|'after'|'inside'} position
   */
  #moveNode(draggedId, targetId, position) {
    if (draggedId === targetId) return;
    if (!findNode(this.#items, draggedId)) return;

    // Pure move (children travel with the node) — see tree-model.moveNode.
    this.#items = moveNode(this.#items, draggedId, targetId, position);
    this.#syncButtonState();
    this.#rerender();
    this.#emitChange();
  }

  // ── Public update API ────────────────────────────────────────────────────

  /**
   * Merge `fields` into the in-memory node identified by `id`, patch the live
   * DOM element when it is visible.
   *
   * Supports any field stored on request nodes (method, url, params, …).
   * @param {string} id
   * @param {object} fields
   * @param {{ silent?: boolean }} [opts]
   *   silent – when true, skips the #emitChange() call so the caller can
   *            batch / debounce the resulting storage write themselves.
   */
  updateNode(id, fields, { silent = false } = {}) {
    // 1. Patch in-memory tree
    this.#items = patchNodeFields(this.#items, id, fields);

    // 2. Attempt surgical DOM update
    const li = this.#el.querySelector(`[data-id="${CSS.escape(id)}"]`);

    if (li) {
      if (fields.name != null) {
        // textContent is XSS-safe; request rows render the name in .tree-node-label.
        const labelEl = li.querySelector(".tree-node-label");
        if (labelEl) labelEl.textContent = fields.name;
      }
      if (fields.method != null) {
        const badge = li.querySelector(".tree-node-method");
        if (badge) {
          badge.textContent = fields.method;
          badge.className = `tree-node-method method--${fields.method.toLowerCase()}`;
          if (
            document.documentElement.classList.contains("show-method-icons")
          ) {
            badge.title = fields.method;
          } else {
            badge.removeAttribute("title");
          }
        }
      }
      if (fields.url != null) {
        // Keep the searchable data-url attribute in step. Request rows show a
        // method badge + label (no .tree-node-url element), so there is no URL
        // text node to update here.
        li.dataset.url = fields.url.toLowerCase();
      }
    } else {
      // Node not visible (e.g. inside a collapsed collection) — full re-render.
      this.#rerender();
    }

    // 3. Persist (unless the caller has opted out to handle saving themselves)
    if (!silent) this.#emitChange();
  }

  /**
   * Programmatically select a request node by ID, as if the user clicked it.
   * Used to restore the last-selected request on page/app reload.
   * Note: if the request lives inside a collapsed folder it will not be visible,
   * but its <li> is still in the DOM and can be selected.
   *
   * @param {string} id
   * @returns {boolean} true if the node was found and selected
   */
  selectById(id) {
    if (!id) return false;
    const node = findNode(this.#items, id);
    if (!node || node.type !== "request") return false;

    const li = this.#el.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!li) return false;

    this.#selectRequest(node, li);
    return true;
  }
}
