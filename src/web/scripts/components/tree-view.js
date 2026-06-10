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
 * Events dispatched on window:
 *   wurl:request-selected    { detail: node }   — user clicked a request
 *   wurl:collections-changed { detail: items }  — tree was mutated (add/remove)
 *   wurl:folder-vars-open    { nodeId, folderName, variables } — user opened folder vars
 *   wurl:request-cleared     (no detail)        — last request deleted; editor should reset
 */

"use strict";

import { PopupManager } from "../popup-manager.js";
import { Notifications } from "../notifications.js";
import { icon } from "../icons.js";
import { escapeHtml } from "../utils/html.js";
import { deepClone } from "../utils/clone.js";
import {
  resolveString,
  buildFolderChain,
  collectTemplateVariables,
} from "./variable-resolver.js";
import { varsArrayToMap } from "./variable-shape.js";
import {
  BODY_CONTENT_TYPES,
  NO_BODY_METHODS,
  encodeBaseUrl,
  applyPathParams,
} from "./request-payload.js";
import { extractOperationName } from "./graphql-schema.js";

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
  #envVariables = {};

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
   * @param {object}   [opts]
   * @param {object[]} [opts.items]  - Initial tree data
   */
  constructor({ items = [] } = {}) {
    this.#el = document.createElement("div");
    this.#el.className = "tree-view";
    this.#el.setAttribute("role", "tree");

    // Create the phantom drop-target placeholder (shared, moved around the DOM)
    this.#dragPhantomEl = document.createElement("li");
    this.#dragPhantomEl.className = "tree-drop-phantom";
    this.#dragPhantomEl.setAttribute("aria-hidden", "true");

    this.#renderToolbar();
    this.#renderTabBar();
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
    window.addEventListener("wurl:request-loading", (e) =>
      this.#setNodeLoading(e.detail?.requestId, true),
    );
    const settleNode = (e) => this.#setNodeLoading(e.detail?.requestId, false);
    window.addEventListener("wurl:response-received", settleNode);
    window.addEventListener("wurl:request-error", settleNode);

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
  }

  /** Root DOM element — pass to Panel.mount(). */
  get element() {
    return this.#el;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Replace the full tree data and re-render.
   * Does NOT fire wurl:collections-changed (caller already owns the source of truth).
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
    this.#envVariables = vars && typeof vars === "object" ? vars : {};
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
   * wurl:request-selected), and scroll it into view. Used when opening a
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

  // ── Toolbar ─────────────────────────────────────────────────────────────

  #renderToolbar() {
    const bar = document.createElement("div");
    bar.className = "tree-toolbar";

    // New Collection button
    const btnNewCollection = document.createElement("button");
    btnNewCollection.className = "icon-btn";
    btnNewCollection.title = "New Collection";
    btnNewCollection.setAttribute("aria-label", "New Collection");
    btnNewCollection.innerHTML = `<span class="icon">${icon("folderClosed", { size: 16 })}</span>`;
    btnNewCollection.addEventListener("click", () => this.#addCollection());

    // New Request button — disabled until at least one collection exists
    this.#btnNewRequest = document.createElement("button");
    this.#btnNewRequest.className = "icon-btn";
    this.#btnNewRequest.title = "New Request";
    this.#btnNewRequest.setAttribute("aria-label", "New Request");
    this.#btnNewRequest.innerHTML = `<span class="icon">${icon("add", { size: 16 })}</span>`;
    this.#btnNewRequest.disabled = true;
    this.#btnNewRequest.addEventListener("click", () => this.#addRequest());

    // Search / filter input
    const search = document.createElement("input");
    search.className = "tree-search";
    search.type = "search";
    search.placeholder = "Filter…";
    search.setAttribute("aria-label", "Filter requests");

    search.addEventListener("input", () => {
      this.#filterText = search.value.trim().toLowerCase();
      this.#applyFilter();
    });

    bar.appendChild(btnNewCollection);
    bar.appendChild(this.#btnNewRequest);
    bar.appendChild(search);
    this.#el.appendChild(bar);
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

    this.#tabReqBtn = mkTab("requests", "Requests");
    this.#tabFavBtn = mkTab("favorites", "Favorites");
    this.#tabRecBtn = mkTab("recents", "Recents");

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
      const hot = li.querySelector(":scope > .tree-node-row > .tree-node-star");
      if (hot) this.#updateHotspot(hot, fav);
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
        new CustomEvent("wurl:favorite-toggle", {
          detail: {
            node: this.#findNode(this.#items, requestId) ?? { id: requestId },
            favorited: !this.#favoriteIds.has(requestId),
          },
          bubbles: true,
        }),
      );
    });
    return hot;
  }

  /** Reflect favorite state in a hotspot: show the star glyph and its tooltip. */
  #updateHotspot(hot, favorited) {
    hot.textContent = favorited ? "★" : "";
    hot.title = favorited
      ? "Double-click to unfavorite"
      : "Double-click to favorite";
  }

  // ── Quick-access list rendering (favorites / recents) ───────────────────

  /**
   * Render a flat list of favorited or recent requests spanning all
   * collections. Each row opens/focuses its request via wurl:request-open.
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
        kind === "favorites" ? "No favorites yet" : "No recent requests"
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
   * wurl:request-open on activation.
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
      <div class="tree-node-row" tabindex="0">
        ${this.#methodBadgeHtml(entry.protocol, entry.method)}
        <span class="tree-node-label">${escapeHtml(entry.name || "(unnamed)")}</span>
      </div>
    `;

    const row = li.querySelector(".tree-node-row");
    if (isFav)
      row.insertBefore(this.#makeFavHotspot(entry.requestId), row.firstChild);
    const open = () =>
      window.dispatchEvent(
        new CustomEvent("wurl:request-open", {
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
    const clickedId = await window.wurl.ui.contextMenu.show({
      items: [{ id: "unfavorite", label: "Unfavorite" }],
      x,
      y,
    });
    if (clickedId !== "unfavorite") return;
    window.dispatchEvent(
      new CustomEvent("wurl:favorite-toggle", {
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
   */
  async #showContextMenu(node, parentCollectionId, x, y) {
    // Action map keyed by id — callbacks can't be sent across IPC, so the
    // native menu returns an id and the dispatch happens here.
    const actions =
      node.type === "collection"
        ? {
            "add-request": () => this.#addRequestTo(node.id),
            "add-ws-request": () =>
              this.#addRequestTo(node.id, { protocol: "websocket" }),
            "add-folder": () => this.#addFolderTo(node.id),
            rename: () => this.#renameNode(node.id),
            duplicate: () => this.#duplicateNode(node.id),
            variables: () => {
              const liveNode = this.#findNode(this.#items, node.id) ?? node;
              window.dispatchEvent(
                new CustomEvent("wurl:folder-vars-open", {
                  detail: {
                    nodeId: liveNode.id,
                    folderName: liveNode.name,
                    variables: liveNode.variables ?? [],
                  },
                  bubbles: true,
                }),
              );
            },
            "export-collection": () => {
              const liveNode = this.#findNode(this.#items, node.id) ?? node;
              window.dispatchEvent(
                new CustomEvent("wurl:export-collection", {
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
              const liveNode = this.#findNode(this.#items, node.id) ?? node;
              window.dispatchEvent(
                new CustomEvent("wurl:favorite-toggle", {
                  detail: {
                    node: liveNode,
                    favorited: !this.#favoriteIds.has(liveNode.id),
                  },
                  bubbles: true,
                }),
              );
            },
            duplicate: () => this.#duplicateNode(node.id),
            "generate-curl": () => this.#generateCurl(node),
            "clear-history": () =>
              window.dispatchEvent(
                new CustomEvent("wurl:timeline-clear", {
                  detail: { requestId: node.id },
                }),
              ),
            delete: () => this.#deleteNode(node.id),
          };

    const baseItems =
      node.type === "collection"
        ? [
            { id: "add-request", label: "Add Request" },
            { id: "add-ws-request", label: "Add WebSocket Request" },
            { id: "add-folder", label: "Add Folder" },
            { type: "separator" },
            { id: "rename", label: "Rename" },
            { type: "separator" },
            { id: "duplicate", label: "Duplicate" },
            { id: "export-collection", label: "Export…" },
            { type: "separator" },
            { id: "variables", label: "Variables" },
            { type: "separator" },
            { id: "delete", label: "Delete", danger: true },
          ]
        : [
            { id: "add-request", label: "Add Request" },
            { id: "add-ws-request", label: "Add WebSocket Request" },
            { id: "add-folder", label: "Add Folder" },
            { type: "separator" },
            { id: "rename", label: "Rename" },
            {
              id: "favorite",
              label: this.#favoriteIds.has(node.id) ? "Unfavorite" : "Favorite",
            },
            { type: "separator" },
            { id: "duplicate", label: "Duplicate" },
            // cURL has no WebSocket equivalent, so omit it for ws requests.
            ...(node.protocol !== "websocket"
              ? [{ id: "generate-curl", label: "Generate cURL" }]
              : []),
            // Requests carry run history; offer to clear it. danger:true wires
            // the two-click "Confirm?" safety net automatically.
            ...(node.type === "request"
              ? [
                  {
                    id: "clear-history",
                    label: "Clear Run History",
                    danger: true,
                  },
                ]
              : []),
            { type: "separator" },
            { id: "delete", label: "Delete", danger: true },
          ];

    // Loop so a danger click can re-open the menu with the entry relabeled to
    // "Confirm?". A second click on that entry confirms; any other choice
    // runs the chosen action; dismiss cancels.
    let confirmingId = null;
    while (true) {
      const items = baseItems.map((it) =>
        it.id === confirmingId
          ? { ...it, label: "Confirm?", danger: false }
          : it,
      );

      const clickedId = await window.wurl.ui.contextMenu.show({
        items: items.map(({ id, label, type, enabled }) => ({
          id,
          label,
          type,
          enabled,
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
      return `<span class="tree-node-method tree-node-method--ws" title="WebSocket">WS</span>`;
    }
    const m = method ?? "GET";
    const title = document.documentElement.classList.contains(
      "show-method-icons",
    )
      ? ` title="${escapeHtml(m)}"`
      : "";
    return `<span class="tree-node-method method--${m.toLowerCase()}"${title}>${escapeHtml(m)}</span>`;
  }

  // ── Mutations — toolbar ─────────────────────────────────────────────────

  /** Add a new collection or folder and persist.
   *  - Request selected → new folder inserted as first child of that request's parent folder.
   *  - Folder selected  → new folder inserted as first child of that folder.
   *  - No selection     → new top-level collection appended to the root.
   */
  #addCollection() {
    const parentId = this.#selectedId
      ? this.#findParentId(this.#items, this.#selectedId)
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
      this.#items = this.#insertChild(this.#items, parentId, folder);
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
        name: "New Collection",
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
   */
  #addRequest() {
    // Prefer the parent folder of the currently selected request so the new
    // request lands as a sibling. Fall back to the last-active collection.
    const targetId =
      (this.#selectedId
        ? this.#findParentId(this.#items, this.#selectedId)
        : undefined) ??
      this.#activeCollectionId ??
      this.#items.find((n) => n.type === "collection")?.id;
    if (!targetId) return;
    this.#addRequestTo(targetId);
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
      name: isWs ? "New WebSocket" : "New Request",
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
    this.#items = this.#insertChild(this.#items, collectionId, request);
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
    this.#items = this.#insertChild(this.#items, collectionId, folder);
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
    this.#items = this.#insertNodeAfter(this.#items, nodeId, request);
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
    this.#items = this.#insertNodeAfter(this.#items, nodeId, folder);
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
    input.setAttribute("aria-label", "Rename");
    labelEl.replaceWith(input);
    input.select();
    input.focus();

    const commit = () => {
      const newName = input.value.trim() || originalName;
      this.#items = this.#updateNodeName(this.#items, nodeId, newName);
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
    const original = this.#findNode(this.#items, nodeId);
    if (!original) return;

    const clone = this.#cloneWithNewIds(original);
    clone.name = `${clone.name} (copy)`;
    this.#items = this.#insertNodeAfter(this.#items, nodeId, clone);
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
    const deleted = this.#findNode(this.#items, nodeId);
    const requestIds = deleted ? this.#collectRequestIds(deleted) : [];
    const deletedIdSet = new Set(requestIds);

    // If the currently selected request is being deleted, find the next
    // closest request in depth-first order so we can auto-select it.
    let nextToSelect = null;
    const selectedWillBeDeleted =
      this.#selectedId != null && deletedIdSet.has(this.#selectedId);
    if (selectedWillBeDeleted) {
      const allRequests = this.#getFlatRequests();
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

    this.#items = this.#removeNode(this.#items, nodeId);
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
          new CustomEvent("wurl:request-cleared", { bubbles: true }),
        );
      }
    }

    if (requestIds.length > 0) {
      window.dispatchEvent(
        new CustomEvent("wurl:requests-deleted", {
          detail: { ids: requestIds },
          bubbles: true,
        }),
      );
    }
  }

  /**
   * Recursively collect all request IDs under `node` (inclusive if it is
   * itself a request, or all descendant requests if it is a folder/collection).
   * @param {object} node
   * @returns {string[]}
   */
  #collectRequestIds(node) {
    if (node.type === "request") return [node.id];
    const ids = [];
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        ids.push(...this.#collectRequestIds(child));
      }
    }
    return ids;
  }

  /**
   * Build a cURL command for a request, or for every request in a collection,
   * write it to the clipboard, then show a confirmation dialog.
   * @param {object} node
   * @param {boolean} [force=false]  skip variable pre-flight check
   */
  #generateCurl(node, force = false) {
    // The closure-captured `node` may be stale: updateNode() replaces the node
    // object in #items immutably, so any field changes (bodyType, bodyFormRows,
    // headers, params, etc.) made after the DOM row was rendered are invisible
    // through the old reference.  Always look up the live version first.
    const liveNode = this.#findNode(this.#items, node.id) ?? node;

    // ── Variable pre-flight check (single requests only) ─────────────────
    // For collection nodes the variables vary per-child request, so the check
    // is skipped to avoid an overwhelming list.
    let prebuiltContext = null;
    if (!force && liveNode.type === "request") {
      prebuiltContext = {
        envVariables: this.#envVariables,
        folderChain: this.#resolverFolderChain(liveNode.id),
      };
      const allVars = collectTemplateVariables(
        this.#gatherNodeTemplates(liveNode),
        prebuiltContext,
      );
      const badCount = allVars.filter((v) => !v.found).length;
      if (badCount > 0) {
        PopupManager.warnVariables({
          variables: allVars,
          actionLabel: "Copy Anyway",
          onAction: () => this.#generateCurl(node, true),
        });
        return;
      }
    }

    const curl = this.#buildCurl(liveNode, prebuiltContext);
    if (!curl) return;

    navigator.clipboard
      .writeText(curl)
      .then(() => {
        Notifications.success(
          "The cURL command has been copied to your clipboard.",
        );
      })
      .catch(() => {
        Notifications.error(
          "Unable to write to the clipboard. Please try again.",
          { title: "Copy failed" },
        );
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
   * Recursively insert `child` under the node with `parentId`.
   * Supports arbitrary nesting (folders within folders).
   */
  /** Return the id of the direct parent of `targetId`, or null if at the root level. */
  #findParentId(nodes, targetId, parentId = null) {
    for (const node of nodes) {
      if (node.id === targetId) return parentId;
      if (Array.isArray(node.children)) {
        const found = this.#findParentId(node.children, targetId, node.id);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  }

  #insertChild(nodes, parentId, child) {
    return nodes.map((node) => {
      if (node.id === parentId) {
        return { ...node, children: [child, ...(node.children ?? [])] };
      }
      if (Array.isArray(node.children) && node.children.length > 0) {
        return {
          ...node,
          children: this.#insertChild(node.children, parentId, child),
        };
      }
      return node;
    });
  }

  /**
   * Recursively remove the node with `targetId` from the tree.
   * Works at any nesting depth.
   */
  #removeNode(nodes, targetId) {
    return nodes
      .filter((n) => n.id !== targetId)
      .map((n) => {
        if (Array.isArray(n.children) && n.children.length > 0) {
          return { ...n, children: this.#removeNode(n.children, targetId) };
        }
        return n;
      });
  }

  /** Find a node by id at any depth. Returns the node or null. */
  #findNode(nodes, targetId) {
    for (const node of nodes) {
      if (node.id === targetId) return node;
      if (Array.isArray(node.children)) {
        const found = this.#findNode(node.children, targetId);
        if (found) return found;
      }
    }
    return null;
  }

  /** Deep-clone a node, replacing every `id` with a new UUID. */
  #cloneWithNewIds(node) {
    const clone = { ...node, id: crypto.randomUUID() };
    // Recurse into tree children (sub-folders / sub-requests)
    if (Array.isArray(node.children)) {
      clone.children = node.children.map((c) => this.#cloneWithNewIds(c));
    }
    // Regenerate IDs for request-level row arrays so duplicated requests
    // never share row IDs with the original.
    if (Array.isArray(node.bodyFormRows)) {
      clone.bodyFormRows = node.bodyFormRows.map((r) => ({
        ...r,
        id: crypto.randomUUID(),
      }));
    }
    if (Array.isArray(node.params)) {
      clone.params = node.params.map((r) => ({
        ...r,
        id: crypto.randomUUID(),
      }));
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
   * Insert `newNode` immediately after the node with `afterId`.
   * Searches recursively; handles nested collections correctly.
   */
  #insertNodeAfter(nodes, afterId, newNode) {
    const result = [];
    for (const node of nodes) {
      let current = node;
      let insertedInChildren = false;

      if (Array.isArray(node.children) && node.children.length > 0) {
        const newChildren = this.#insertNodeAfter(
          node.children,
          afterId,
          newNode,
        );
        // Use both a length check (item inserted at this level) AND a reference
        // check (item inserted at a deeper level — immediate count unchanged but
        // one of the child objects is a new spread copy).
        insertedInChildren =
          newChildren.length > node.children.length ||
          newChildren.some((c, i) => c !== node.children[i]);
        if (insertedInChildren) current = { ...node, children: newChildren };
      }

      result.push(current);

      if (!insertedInChildren && node.id === afterId) {
        result.push(newNode);
      }
    }
    return result;
  }

  /** Return a new tree with the name of `targetId` replaced. */
  #updateNodeName(nodes, targetId, newName) {
    return nodes.map((node) => {
      if (node.id === targetId) return { ...node, name: newName };
      if (Array.isArray(node.children) && node.children.length > 0) {
        return {
          ...node,
          children: this.#updateNodeName(node.children, targetId, newName),
        };
      }
      return node;
    });
  }

  /**
   * Build a cURL command string for a request node, respecting all editor
   * settings: enabled/disabled params, headers, body type, and auth.
   * For a collection, concatenates the cURL of every contained request.
   *
   * Mirrors the assembly logic in RequestEditor.#sendRequest() so the
   * generated command matches what the Send button actually transmits.
   */
  #buildCurl(node, prebuiltContext = null) {
    if (node.type === "request") {
      const method = node.method ?? "GET";

      // ── Variable resolver for this node ─────────────────────────────────
      // Reuse a pre-built context from #generateCurl when available so the
      // folder-chain tree traversal is not repeated for the same node.
      const nodeContext = prebuiltContext ?? {
        envVariables: this.#envVariables,
        folderChain: this.#resolverFolderChain(node.id),
      };
      const rv = (s) => resolveString(s ?? "", nodeContext);

      // Substitute path params (resolved + encoded) before percent-encoding the
      // base, mirroring the send path so the cURL URL matches what's sent.
      const pathMap = new Map();
      for (const pp of node.pathParams ?? []) {
        const name = (pp.name ?? "").trim();
        if (name) pathMap.set(name, encodeURIComponent(rv(pp.value ?? "")));
      }
      const baseUrl = encodeBaseUrl(
        applyPathParams(rv(node.url || "<url>"), pathMap),
      );

      // ── 1. URL — append enabled, non-blank query parameters ──────────────
      const params = Array.isArray(node.params) ? node.params : [];
      const enabledParams = params.filter((p) => p.enabled && p.name.trim());
      let finalUrl = baseUrl;
      if (enabledParams.length) {
        const qs = enabledParams
          .map(
            (p) =>
              `${encodeURIComponent(rv(p.name))}=${encodeURIComponent(rv(p.value))}`,
          )
          .join("&");
        finalUrl += (baseUrl.includes("?") ? "&" : "?") + qs;
      }

      // ── 2. Headers — enabled array rows (new format) or legacy object ─────
      const headers = {};
      if (Array.isArray(node.headers)) {
        node.headers
          .filter((h) => h.enabled && h.name.trim())
          .forEach((h) => {
            headers[rv(h.name).trim()] = rv(h.value);
          });
      } else if (node.headers && typeof node.headers === "object") {
        // Legacy: plain key→value object (no enabled flag) — resolve each value
        Object.entries(node.headers).forEach(([k, v]) => {
          headers[rv(k)] = rv(v);
        });
      }

      // ── 3. Auth — inject Authorization header when enabled ────────────────
      const authEnabled = node.authEnabled ?? true;
      const authType = node.authType ?? "none";
      if (authEnabled && authType !== "none") {
        switch (authType) {
          case "basic": {
            const username = rv(node.authBasic?.username ?? "");
            const password = rv(node.authBasic?.password ?? "");
            if (username || password) {
              headers["Authorization"] =
                `Basic ${btoa(`${username}:${password}`)}`;
            }
            break;
          }
          case "bearer":
            if (node.authBearer?.token)
              headers["Authorization"] = `Bearer ${rv(node.authBearer.token)}`;
            break;
          case "oauth2":
            if (node.authOAuth2?.token)
              headers["Authorization"] = `Bearer ${rv(node.authOAuth2.token)}`;
            break;
          // aws-iam: Signature v4 requires request-time signing — not representable as static curl
        }
      }

      // ── 4. Body — match RequestEditor body assembly by type ───────────────
      const bodyType = node.bodyType ?? "no-body";
      let body = null; // string payload for --data (text bodies)
      let bodyFilePath = null; // file path for --data-binary @path
      // For form fields: array of already-encoded "name=value" strings (urlencoded)
      // or {name, value} objects (multipart).  formStyle tells the assembler which.
      let formPairs = null; // string[] — urlencoded, already percent-encoded
      let formEntries = null; // {name,value}[] — multipart/form-data

      if (!NO_BODY_METHODS.has(method)) {
        switch (bodyType) {
          case "form-data": {
            // Use --form flags (curl sets Content-Type + boundary automatically).
            // A file field becomes `name=path` (the leading `@` is intentionally
            // omitted; curl's file-read marker is not emitted here).
            const rows = (node.bodyFormRows ?? []).filter(
              (r) => r.enabled && r.name.trim(),
            );
            if (rows.length > 0)
              formEntries = rows.map((r) =>
                r.kind === "file"
                  ? {
                      kind: "file",
                      name: rv(r.name),
                      file: r.filePath ?? "",
                      contentType: r.contentType || "",
                      filename: r.fileName || "",
                    }
                  : { kind: "text", name: rv(r.name), value: rv(r.value) },
              );
            break;
          }
          case "form-urlencoded": {
            // Use one --data flag per field; URLSearchParams gives correct encoding.
            const rows = (node.bodyFormRows ?? []).filter(
              (r) => r.enabled && r.name.trim(),
            );
            if (rows.length > 0) {
              const sp = new URLSearchParams();
              rows.forEach((r) => sp.append(rv(r.name), rv(r.value)));
              // Split "a=1&b=2" → ["a=1", "b=2"] — each token is already percent-encoded
              formPairs = sp.toString().split("&").filter(Boolean);
              if (!headers["Content-Type"])
                headers["Content-Type"] = "application/x-www-form-urlencoded";
            }
            break;
          }
          case "json":
          case "yaml":
          case "xml":
          case "text":
            if (node.bodyText?.trim()) {
              body = rv(node.bodyText);
              if (!headers["Content-Type"])
                headers["Content-Type"] = BODY_CONTENT_TYPES[bodyType];
            }
            break;
          case "graphql": {
            // Mirror the send path (request-payload.js): a standard GraphQL POST
            // with a JSON { query, variables, operationName } body. {{var}} tokens
            // resolve in both the query and the variables JSON before assembly.
            const query = rv(node.bodyGraphql?.query ?? "");
            const varsText = rv(node.bodyGraphql?.variables ?? "").trim();
            if (query.trim() || varsText) {
              const payload = { query };
              if (varsText) {
                try {
                  payload.variables = JSON.parse(varsText);
                } catch {
                  // Invalid variables JSON — omit rather than emit a malformed
                  // `variables` field; the editor flags it inline.
                }
              }
              const operationName = extractOperationName(query);
              if (operationName) payload.operationName = operationName;
              body = JSON.stringify(payload);
              if (!headers["Content-Type"])
                headers["Content-Type"] = "application/json";
            }
            break;
          }
          case "file":
            if (node.bodyFilePath) bodyFilePath = node.bodyFilePath;
            break;
          default:
            break; // "no-body" — leave everything null
        }
      }

      // ── 5. Assemble the curl command ──────────────────────────────────────
      // Use long-form flags (--request, --url, --header, --data / --form) so
      // the output matches common style guides and is easy to read and paste.
      // Helper: single-quote a shell token, escaping embedded single quotes.
      const sq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

      let cmd = `curl --request ${method}`;

      // URL — single-quoted; placed right after the method
      cmd += ` \\\n  --url ${sq(finalUrl)}`;

      // Headers — one --header flag per entry
      Object.entries(headers).forEach(([k, v]) => {
        cmd += ` \\\n  --header ${sq(`${k}: ${v}`)}`;
      });

      // Body
      if (formEntries !== null) {
        // multipart/form-data: one --form flag per field; curl sets Content-Type.
        formEntries.forEach((e) => {
          if (e.kind === "file") {
            let spec = `${e.name}=${e.file}`;
            if (e.contentType) spec += `;type=${e.contentType}`;
            if (e.filename) spec += `;filename=${e.filename}`;
            cmd += ` \\\n  --form ${sq(spec)}`;
          } else {
            cmd += ` \\\n  --form ${sq(`${e.name}=${e.value}`)}`;
          }
        });
      } else if (formPairs !== null) {
        // application/x-www-form-urlencoded: one --data flag per encoded pair.
        // The pairs from URLSearchParams are already percent-encoded and shell-safe
        // (no spaces, single quotes, or glob chars), so no extra quoting needed.
        formPairs.forEach((pair) => {
          cmd += ` \\\n  --data ${pair}`;
        });
      } else if (bodyFilePath !== null) {
        cmd += ` \\\n  --data-binary '@${bodyFilePath.replace(/'/g, "'\\''")}'`;
      } else if (body !== null) {
        cmd += ` \\\n  --data ${sq(body)}`;
      }

      return cmd;
    }

    if (node.type === "collection") {
      const requests = this.#collectRequests(node.children ?? []);
      return requests
        .map((r) => this.#buildCurl(r))
        .filter(Boolean)
        .join("\n\n");
    }
    return "";
  }

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

  /** Recursively collect all request nodes within a subtree. */
  #collectRequests(nodes) {
    const requests = [];
    for (const node of nodes) {
      if (node.type === "request") {
        requests.push(node);
      } else if (Array.isArray(node.children)) {
        requests.push(...this.#collectRequests(node.children));
      }
    }
    return requests;
  }

  /** Return all request nodes in depth-first (visual) order across the whole tree. */
  #getFlatRequests(nodes = this.#items) {
    const result = [];
    for (const node of nodes) {
      if (node.type === "request") {
        result.push(node);
      } else if (Array.isArray(node.children)) {
        result.push(...this.#getFlatRequests(node.children));
      }
    }
    return result;
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
        "<span>No collections yet</span>";
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
        <div class="tree-node-row" tabindex="0">
          <span class="tree-node-icon">${isExpanded ? ICON_FOLDER_OPEN : ICON_FOLDER_CLOSED}</span>
          <span class="tree-node-label">${escapeHtml(node.name)}</span>
        </div>
      `;

      const row = li.querySelector(".tree-node-row");
      const iconEl = row.querySelector(".tree-node-icon");
      const labelEl = row.querySelector(".tree-node-label");

      /** Toggle this folder's expanded / collapsed state. */
      const toggleExpand = () => {
        const expanded = li.getAttribute("aria-expanded") === "true";
        li.setAttribute("aria-expanded", String(!expanded));
        iconEl.innerHTML = expanded ? ICON_FOLDER_CLOSED : ICON_FOLDER_OPEN;
        childList.style.display = expanded ? "none" : "";
        if (expanded) {
          this.#collapsedIds.add(node.id);
        } else {
          this.#collapsedIds.delete(node.id);
        }
        this.#saveCollapsedState();
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
        <div class="tree-node-row" tabindex="0">
          ${this.#methodBadgeHtml(node.protocol, node.method)}
          <span class="tree-node-label">${escapeHtml(node.name)}</span>
        </div>
      `;

      const row = li.querySelector(".tree-node-row");
      row.insertBefore(this.#makeFavHotspot(node.id), row.firstChild);
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
          new CustomEvent("wurl:request-execute", {
            detail: this.#findNode(this.#items, node.id) ?? node,
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
    dot.title = "WebSocket connection open";
    return dot;
  }

  /**
   * The per-node stop control: shows the in-flight spinner ring and cancels
   * the request on click — the only way to stop a run that is not the one
   * loaded in the editor (whose URL-bar button reads Stop).
   */
  #makeStopBtn(requestId) {
    const btn = document.createElement("button");
    btn.className = "tree-node-stop";
    btn.setAttribute("aria-label", "Stop request");
    btn.title = "Stop request";
    btn.addEventListener("click", (e) => {
      // Cancel only — do not select the row.
      e.stopPropagation();
      window.dispatchEvent(
        new CustomEvent("wurl:cancel-request", { detail: { requestId } }),
      );
    });
    // Keep rapid clicks from bubbling into the row's double-click-to-execute.
    btn.addEventListener("dblclick", (e) => e.stopPropagation());
    return btn;
  }

  #selectRequest(node, li) {
    // Skip re-loading the request (and its history/timeline) when the row is
    // already active — clicking or right-clicking the current selection
    // should not trigger another wurl:request-selected dispatch.
    const alreadyActive = li.classList.contains("tree-node--active");
    this.#selectedId = node.id;
    this.#setActiveRow(li);
    if (alreadyActive) return;

    // Always read the live node from #items so we get the latest field values.
    // The click-handler closure captures the node object at render time; if
    // updateNode() has since patched #items (creating a new object), the
    // closure reference would be stale and load outdated method/url/etc.
    const currentNode = this.#findNode(this.#items, node.id) ?? node;

    window.dispatchEvent(
      new CustomEvent("wurl:request-selected", {
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
      new CustomEvent("wurl:collections-changed", {
        detail: this.getItems(), // deep clone — callers must not mutate
        bubbles: true,
      }),
    );
  }

  #saveCollapsedState() {
    if (!this.#storageKey) return;
    try {
      localStorage.setItem(
        `wurl:collapsed:${this.#storageKey}`,
        JSON.stringify([...this.#collapsedIds]),
      );
    } catch {
      /* quota exceeded or private browsing — ignore */
    }
  }

  #loadCollapsedState() {
    if (!this.#storageKey) return [];
    try {
      const raw = localStorage.getItem(`wurl:collapsed:${this.#storageKey}`);
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

      let pos;
      if (node.type === "collection") {
        if (this.#draggedIsCollection) {
          // Dragging a folder onto another folder: the target's open/closed
          // state — not the cursor depth — decides whether we nest or stay at
          // the same level.
          //   • open target   → drop *inside* it (as the first child)
          //   • closed target → drop *after* it, a sibling at the same level
          // A thin top zone still allows dropping *before* the target folder.
          const open = !this.#collapsedIds.has(node.id);
          if (open) {
            pos = ratio < 0.25 ? "before" : "inside";
          } else {
            pos = ratio < 0.5 ? "before" : "after";
          }
        } else if (ratio < 0.25) {
          pos = "before";
        } else if (ratio > 0.75) {
          pos = "after";
        } else {
          pos = "inside";
        }
      } else {
        pos = ratio < 0.5 ? "before" : "after";
      }

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
    if (this.#dragId === targetNode.id) return false;
    // Prevent dragging a collection into one of its own descendants
    const dragged = this.#findNode(this.#items, this.#dragId);
    if (dragged?.type === "collection") {
      if (this.#findNode(dragged.children ?? [], targetNode.id)) return false;
    }
    return true;
  }

  /**
   * Move the node `draggedId` to a position relative to `targetId`.
   * @param {string} draggedId
   * @param {string} targetId
   * @param {'before'|'after'|'inside'} position
   */
  #moveNode(draggedId, targetId, position) {
    if (draggedId === targetId) return;

    const node = this.#findNode(this.#items, draggedId);
    if (!node) return;

    // Remove the node from its current position (children travel with it)
    let newItems = this.#removeNode(this.#items, draggedId);

    // Insert at the requested position
    if (position === "before") {
      newItems = this.#insertBefore(newItems, targetId, node);
    } else if (position === "after") {
      newItems = this.#insertNodeAfter(newItems, targetId, node);
    } else if (position === "inside") {
      newItems = this.#insertChild(newItems, targetId, node);
    }

    this.#items = newItems;
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
    this.#items = this.#patchNodeFields(this.#items, id, fields);

    // 2. Attempt surgical DOM update
    const li = this.#el.querySelector(`[data-id="${CSS.escape(id)}"]`);

    if (li) {
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
        li.dataset.url = fields.url.toLowerCase();
        const urlEl = li.querySelector(".tree-node-url");
        if (urlEl) urlEl.textContent = fields.url;
      }
    } else {
      // Node not visible (e.g. inside a collapsed collection) — full re-render.
      this.#rerender();
    }

    // 3. Persist (unless the caller has opted out to handle saving themselves)
    if (!silent) this.#emitChange();
  }

  /** Recursively return a new tree with the fields of `targetId` merged. */
  #patchNodeFields(nodes, targetId, fields) {
    return nodes.map((node) => {
      if (node.id === targetId) return { ...node, ...fields };
      if (Array.isArray(node.children) && node.children.length > 0) {
        return {
          ...node,
          children: this.#patchNodeFields(node.children, targetId, fields),
        };
      }
      return node;
    });
  }

  /**
   * Insert `newNode` immediately before the node with `beforeId`.
   * Searches recursively through the tree.
   */
  #insertBefore(nodes, beforeId, newNode) {
    const result = [];
    for (const node of nodes) {
      if (node.id === beforeId) {
        result.push(newNode, node);
        continue;
      }
      if (Array.isArray(node.children) && node.children.length > 0) {
        const newChildren = this.#insertBefore(
          node.children,
          beforeId,
          newNode,
        );
        // Use both a length check AND a reference check (deep insertion changes
        // a child object reference even if the count stays the same).
        if (
          newChildren.length > node.children.length ||
          newChildren.some((c, i) => c !== node.children[i])
        ) {
          result.push({ ...node, children: newChildren });
          continue;
        }
      }
      result.push(node);
    }
    return result;
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
    const node = this.#findNode(this.#items, id);
    if (!node || node.type !== "request") return false;

    const li = this.#el.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!li) return false;

    this.#selectRequest(node, li);
    return true;
  }
}
