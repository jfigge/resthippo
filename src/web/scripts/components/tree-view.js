/**
 * tree-view.js — Navigation / Collections tree-view component
 *
 * Renders a hierarchical list of request collections and individual requests.
 * Selecting an item emits a 'wurl:request-selected' CustomEvent on the window.
 *
 * Future expansion:
 *  - Drag-and-drop reordering
 *  - Inline rename / delete
 *  - Collection import / export
 *  - Search / filter
 */

"use strict";

// SVG folder icons (Feather-style, stroke-based)
const ICON_FOLDER_CLOSED = `<svg class="tree-folder-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
const ICON_FOLDER_OPEN   = `<svg class="tree-folder-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><polyline points="2 10 12 10 17 15 22 10"/></svg>`;

export class TreeView {
  /** @type {HTMLElement} */
  #el;

  /**
   * @param {object}   [opts]
   * @param {object[]} [opts.items]  - Initial tree data (see TreeNode schema)
   */
  constructor({ items = [] } = {}) {
    this.#el = document.createElement("div");
    this.#el.className = "tree-view";
    this.#el.setAttribute("role", "tree");

    this.#renderToolbar();
    this.#renderTree(items);
  }

  /** Root DOM element — pass to Panel.mount(). */
  get element() {
    return this.#el;
  }

  // ── Toolbar ─────────────────────────────────────────────────────────────
  #renderToolbar() {
    const bar = document.createElement("div");
    bar.className = "tree-toolbar";
    bar.innerHTML = `
      <button class="icon-btn" title="New Collection" aria-label="New Collection">
        <span class="icon">📁</span>
      </button>
      <button class="icon-btn" title="New Request" aria-label="New Request">
        <span class="icon">＋</span>
      </button>
      <input
        class="tree-search"
        type="search"
        placeholder="Filter…"
        aria-label="Filter requests"
      />
    `;
    this.#el.appendChild(bar);
  }

  // ── Tree ────────────────────────────────────────────────────────────────
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
      items.forEach((item) => listEl.appendChild(this.#createNode(item)));
    }

    this.#el.appendChild(listEl);
  }

  // ── Tree node ───────────────────────────────────────────────────────────
  #createNode(node) {
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

      // Toggle collapse / expand — swap folder icon
      const row = li.querySelector(".tree-node__row");
      row.addEventListener("click", () => {
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
        childList.appendChild(this.#createNode(child));
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
      row.addEventListener("click", () => this.#selectRequest(node, li));
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") this.#selectRequest(node, li);
      });
    }

    return li;
  }

  #selectRequest(node, li) {
    // Deselect previous
    this.#el.querySelectorAll(".tree-node--active").forEach((el) => {
      el.classList.remove("tree-node--active");
    });
    li.classList.add("tree-node--active");

    // Notify the rest of the app
    window.dispatchEvent(
      new CustomEvent("wurl:request-selected", {
        detail: node,
        bubbles: true,
      }),
    );
  }

  /** Load or replace tree data. */
  setItems(items) {
    const listEl = this.#el.querySelector(".tree-list");
    if (listEl) listEl.remove();
    this.#renderTree(items);
  }

  #escape(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
}
