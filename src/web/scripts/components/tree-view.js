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
 */

"use strict";

// SVG folder icons (Feather-style, stroke-based)
const ICON_FOLDER_CLOSED = `<svg class="tree-folder-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
const ICON_FOLDER_OPEN   = `<svg class="tree-folder-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><polyline points="2 10 12 10 17 15 22 10"/></svg>`;

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

  /** @type {HTMLButtonElement} — kept to toggle disabled state */
  #btnNewRequest = null;

  /**
   * @param {object}   [opts]
   * @param {object[]} [opts.items]  - Initial tree data
   */
  constructor({ items = [] } = {}) {
    this.#el = document.createElement("div");
    this.#el.className = "tree-view";
    this.#el.setAttribute("role", "tree");

    this.#renderToolbar();
    this.#items = items;
    this.#renderTree(this.#items);
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
    this.#syncButtonState();
    this.#rerender();
  }

  /**
   * Return a deep clone of the current items array.
   * @returns {object[]}
   */
  getItems() {
    return JSON.parse(JSON.stringify(this.#items));
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
    btnNewCollection.innerHTML = `<span class="icon">📁</span>`;
    btnNewCollection.addEventListener("click", () => this.#addCollection());

    // New Request button — disabled until at least one collection exists
    this.#btnNewRequest = document.createElement("button");
    this.#btnNewRequest.className = "icon-btn";
    this.#btnNewRequest.title = "New Request";
    this.#btnNewRequest.setAttribute("aria-label", "New Request");
    this.#btnNewRequest.innerHTML = `<span class="icon">＋</span>`;
    this.#btnNewRequest.disabled = true;
    this.#btnNewRequest.addEventListener("click", () => this.#addRequest());

    // Search / filter input
    const search = document.createElement("input");
    search.className = "tree-search";
    search.type = "search";
    search.placeholder = "Filter…";
    search.setAttribute("aria-label", "Filter requests");

    bar.appendChild(btnNewCollection);
    bar.appendChild(this.#btnNewRequest);
    bar.appendChild(search);
    this.#el.appendChild(bar);
  }

  // ── Mutations ───────────────────────────────────────────────────────────

  /** Add a new top-level collection and persist. */
  #addCollection() {
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

  /**
   * Add a new request under the active collection (or the first collection).
   * If no collection exists the button is disabled, so this is a no-op guard.
   */
  #addRequest() {
    const targetId =
      this.#activeCollectionId ?? this.#items.find((n) => n.type === "collection")?.id;
    if (!targetId) return;

    const request = {
      id: crypto.randomUUID(),
      type: "request",
      name: "New Request",
      method: "GET",
      url: "",
    };

    this.#items = this.#insertChild(this.#items, targetId, request);
    this.#rerender();
    this.#emitChange();
  }

  /**
   * Recursively insert `child` under the node with `parentId`.
   * Supports arbitrary nesting (folders within folders).
   * @param {object[]} nodes
   * @param {string}   parentId
   * @param {object}   child
   * @returns {object[]} new nodes array
   */
  #insertChild(nodes, parentId, child) {
    return nodes.map((node) => {
      if (node.id === parentId) {
        return { ...node, children: [...(node.children ?? []), child] };
      }
      if (Array.isArray(node.children) && node.children.length > 0) {
        return { ...node, children: this.#insertChild(node.children, parentId, child) };
      }
      return node;
    });
  }

  /**
   * Recursively remove the node with `targetId` from the tree.
   * Works at any nesting depth.
   * @param {object[]} nodes
   * @param {string}   targetId
   * @returns {object[]}
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

  // ── Rendering ───────────────────────────────────────────────────────────

  #rerender() {
    const existing = this.#el.querySelector(".tree-list");
    if (existing) existing.remove();
    this.#renderTree(this.#items);
  }

  #renderTree(items) {
    const listEl = document.createElement("ul");
    listEl.className = "tree-list";
    listEl.setAttribute("role", "group");

    if (items.length === 0) {
      const empty = document.createElement("li");
      empty.className = "tree-empty";
      empty.innerHTML =
        '<span class="placeholder-icon">📭</span>' +
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
      li.classList.add("tree-node--collection");
      li.setAttribute("aria-expanded", "true");
      li.innerHTML = `
        <div class="tree-node__row" tabindex="0">
          <span class="tree-node__icon">${ICON_FOLDER_OPEN}</span>
          <span class="tree-node__label">${this.#escape(node.name)}</span>
        </div>
      `;

      // Toggle collapse / expand — swap folder icon; also track active collection
      const row = li.querySelector(".tree-node__row");
      row.addEventListener("click", () => {
        this.#activeCollectionId = node.id;
        const expanded = li.getAttribute("aria-expanded") === "true";
        li.setAttribute("aria-expanded", String(!expanded));
        const iconEl = li.querySelector(".tree-node__icon");
        if (iconEl) iconEl.innerHTML = expanded ? ICON_FOLDER_CLOSED : ICON_FOLDER_OPEN;
        childList.style.display = expanded ? "none" : "";
      });

      const childList = document.createElement("ul");
      childList.className = "tree-list tree-list--nested";
      childList.setAttribute("role", "group");
      (node.children ?? []).forEach((child) => {
        childList.appendChild(this.#createNode(child, node.id));
      });
      li.appendChild(childList);
    } else {
      // Request item
      li.classList.add("tree-node--request");
      const methodClass = `method--${(node.method ?? "GET").toLowerCase()}`;
      li.innerHTML = `
        <div class="tree-node__row" tabindex="0">
          <span class="tree-node__method ${methodClass}">${node.method ?? "GET"}</span>
          <span class="tree-node__label">${this.#escape(node.name)}</span>
        </div>
      `;

      const row = li.querySelector(".tree-node__row");
      row.addEventListener("click", () => {
        // Track the parent so "New Request" adds to the same collection
        if (parentCollectionId) this.#activeCollectionId = parentCollectionId;
        this.#selectRequest(node, li);
      });
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          if (parentCollectionId) this.#activeCollectionId = parentCollectionId;
          this.#selectRequest(node, li);
        }
      });
    }

    return li;
  }

  #selectRequest(node, li) {
    this.#el.querySelectorAll(".tree-node--active").forEach((el) => {
      el.classList.remove("tree-node--active");
    });
    li.classList.add("tree-node--active");

    window.dispatchEvent(
      new CustomEvent("wurl:request-selected", {
        detail: node,
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

  #escape(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
}
