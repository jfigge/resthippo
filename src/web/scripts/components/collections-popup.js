/**
 * collections-popup.js — collections selector popup
 *
 * Allows the user to:
 *   • View all collections (the active one is marked with a checkmark)
 *   • Select a collection (switches the active tree-view data)
 *   • Add a new collection (empty collections)
 *   • Clone a collection (deep-copies all collections under a new name)
 *   • Delete a collection (disabled when only 1 remains)
 *
 * The popup stays open across operations so the user can make multiple
 * changes.  Each action dispatches a custom event on window; app.js
 * handles the state mutation and calls popup.update() to refresh the list.
 *
 * Events dispatched:
 *   wurl:coll-select  { id }                    — switch active collection
 *   wurl:coll-add     { name }                  — create new empty collection
 *   wurl:coll-clone   { sourceId, name }        — clone a collection
 *   wurl:coll-rename  { id, name }              — rename a collection
 *   wurl:coll-delete  { id }                    — delete a collection
 */

"use strict";

import { PopupManager } from "../popup-manager.js";

// ── SVG icons ─────────────────────────────────────────────────────────────────

const ICON_CHECK = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
  aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`;

const ICON_CLONE = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
  aria-hidden="true">
  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
</svg>`;

const ICON_RENAME = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
  aria-hidden="true">
  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
</svg>`;

const ICON_DELETE = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
  aria-hidden="true">
  <polyline points="3 6 5 6 21 6"/>
  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
  <path d="M10 11v6"/><path d="M14 11v6"/>
  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
</svg>`;

// ── CollectionsPopup class ────────────────────────────────────────────────────

export class CollectionsPopup {
  /** @type {HTMLElement} */
  #el;

  /** @type {{id: string, name: string}[]} */
  #collections = [];

  /** @type {string|null} */
  #activeId = null;

  /**
   * Tracks which action the name-input row is performing.
   * null | "add" | { type: "clone", sourceId: string, sourceName: string }
   */
  #pendingAction = null;

  /** @type {number|null} — handle returned by setTimeout for the error-class removal */
  #nameErrorTimer = null;

  constructor() {
    this.#el = this.#build();
  }

  /** Root DOM element — required by PopupManager. */
  get element() {
    return this.#el;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Open the popup and immediately begin renaming the specified collection.
   * Used by external callers (e.g. the nav-panel context menu).
   * @param {{ collections: object[], activeCollectionId: string }} state
   * @param {string} collectionId  — the collection to rename (defaults to active)
   */
  openWithRename(
    { collections, activeCollectionId },
    collectionId = activeCollectionId,
  ) {
    this.open({ collections, activeCollectionId });
    const coll = this.#collections.find((e) => e.id === collectionId);
    if (coll) this.#startRename(coll);
  }

  /**
   * Open the popup, seeded with the current app state.
   * @param {{ collections: object[], activeCollectionId: string }} state
   */
  open({ collections, activeCollectionId }) {
    this.#collections = collections.map((e) => ({ ...e }));
    this.#activeId = activeCollectionId;
    this.#pendingAction = null;
    this.#renderList();
    this.#setNameInputVisible(false);
    PopupManager.open(this);
  }

  /**
   * Refresh the list without closing the popup.
   * Called by app.js after any collection mutation.
   * @param {{ collections: object[], activeCollectionId: string }} state
   */
  update({ collections, activeCollectionId }) {
    this.#collections = collections.map((e) => ({ ...e }));
    this.#activeId = activeCollectionId;
    this.#pendingAction = null;
    this.#renderList();
    this.#setNameInputVisible(false);
  }

  /** Called by PopupManager when the user clicks the overlay mask. */
  onMaskClick() {
    PopupManager.close();
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  #build() {
    const el = document.createElement("div");
    el.className = "popup coll-popup";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", "Collections");

    el.innerHTML = `
      <div class="popup-header">
        <span class="popup-title">Collections</span>
        <button class="popup-close" aria-label="Close collections" title="Close">✕</button>
      </div>
      <div class="popup-body coll-popup-body">
        <div class="coll-name-input-row">
          <input
            class="coll-name-input"
            type="text"
            placeholder="Collection name…"
            autocomplete="off"
            spellcheck="false"
          />
          <button class="popup-btn popup-btn--primary coll-name-ok" disabled>Add</button>
          <button class="popup-btn popup-btn--secondary coll-name-cancel">Cancel</button>
        </div>
        <ul class="coll-list" role="listbox" aria-label="Collections"></ul>
      </div>
      <div class="popup-footer">
        <button class="popup-btn popup-btn--secondary coll-new-btn">+ New Collection</button>
        <button class="popup-btn popup-btn--primary js-close">Close</button>
      </div>
    `;

    // Header close
    el.querySelector(".popup-close").addEventListener("click", () =>
      PopupManager.close(),
    );
    // Footer close
    el.querySelector(".js-close").addEventListener("click", () =>
      PopupManager.close(),
    );
    // New collection
    el.querySelector(".coll-new-btn").addEventListener("click", () =>
      this.#startAdd(),
    );

    // Name-input controls
    const nameInput = el.querySelector(".coll-name-input");
    const nameOkBtn = el.querySelector(".coll-name-ok");
    const cancelBtn = el.querySelector(".coll-name-cancel");

    nameInput.addEventListener("input", () => {
      nameOkBtn.disabled = !nameInput.value.trim();
    });
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !nameOkBtn.disabled) nameOkBtn.click();
      if (e.key === "Escape") cancelBtn.click();
    });
    nameOkBtn.addEventListener("click", () => this.#commitName());
    cancelBtn.addEventListener("click", () => this.#setNameInputVisible(false));

    return el;
  }

  // ── List rendering ─────────────────────────────────────────────────────────

  #renderList() {
    const ul = this.#el.querySelector(".coll-list");
    ul.innerHTML = "";
    const count = this.#collections.length;

    this.#collections.forEach((collection) => {
      const isActive = collection.id === this.#activeId;

      const li = document.createElement("li");
      li.className =
        "coll-list-item" + (isActive ? " coll-list-item--active" : "");
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(isActive));

      // Checkmark column
      const check = document.createElement("span");
      check.className = "coll-list-item__check";
      check.innerHTML = isActive ? ICON_CHECK : "";

      // Name button (clicking selects the collection)
      const nameBtn = document.createElement("button");
      nameBtn.className = "coll-list-item__name";
      nameBtn.textContent = collection.name;
      nameBtn.setAttribute("aria-label", `Select ${collection.name}`);
      nameBtn.addEventListener("click", () => this.#selectColl(collection.id));

      // Action buttons
      const actions = document.createElement("div");
      actions.className = "coll-list-item__actions";

      const cloneBtn = document.createElement("button");
      cloneBtn.className = "coll-action-btn";
      cloneBtn.title = "Clone collection";
      cloneBtn.innerHTML = ICON_CLONE;
      cloneBtn.setAttribute("aria-label", `Clone ${collection.name}`);
      cloneBtn.addEventListener("click", () => this.#startClone(collection));

      const renameBtn = document.createElement("button");
      renameBtn.className = "coll-action-btn";
      renameBtn.title = "Rename collection";
      renameBtn.innerHTML = ICON_RENAME;
      renameBtn.setAttribute("aria-label", `Rename ${collection.name}`);
      renameBtn.addEventListener("click", () => this.#startRename(collection));

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "coll-action-btn coll-action-btn--danger";
      deleteBtn.title =
        count <= 1 ? "Cannot delete the only collection" : "Delete collection";
      deleteBtn.disabled = count <= 1;
      deleteBtn.innerHTML = ICON_DELETE;
      deleteBtn.setAttribute("aria-label", `Delete ${collection.name}`);
      deleteBtn.addEventListener("click", () =>
        this.#confirmDelete(collection),
      );

      actions.appendChild(cloneBtn);
      actions.appendChild(renameBtn);
      actions.appendChild(deleteBtn);

      li.appendChild(check);
      li.appendChild(nameBtn);
      li.appendChild(actions);
      ul.appendChild(li);
    });
  }

  // ── Name input form ────────────────────────────────────────────────────────

  #setNameInputVisible(
    visible,
    {
      placeholder = "Collection name…",
      defaultValue = "",
      okLabel = "Add",
    } = {},
  ) {
    const row = this.#el.querySelector(".coll-name-input-row");
    const input = this.#el.querySelector(".coll-name-input");
    const okBtn = this.#el.querySelector(".coll-name-ok");
    const newBtn = this.#el.querySelector(".coll-new-btn");

    if (visible) {
      input.placeholder = placeholder;
      input.value = defaultValue;
      okBtn.textContent = okLabel;
      okBtn.disabled = !defaultValue.trim();
      input.classList.remove("coll-name-input--error");
      row.classList.add("coll-name-input-row--visible");
      newBtn.disabled = true;
      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
    } else {
      clearTimeout(this.#nameErrorTimer);
      this.#nameErrorTimer = null;
      row.classList.remove("coll-name-input-row--visible");
      input.value = "";
      okBtn.textContent = "Add";
      newBtn.disabled = false;
      this.#pendingAction = null;
    }
  }

  #startAdd() {
    this.#pendingAction = "add";
    this.#setNameInputVisible(true, {
      placeholder: "New Collection name…",
      defaultValue: "",
    });
  }

  #startClone(coll) {
    this.#pendingAction = {
      type: "clone",
      sourceId: coll.id,
      sourceName: coll.name,
    };
    this.#setNameInputVisible(true, {
      placeholder: "New collection name…",
      defaultValue: `${coll.name} (copy)`,
    });
  }

  #startRename(coll) {
    this.#pendingAction = {
      type: "rename",
      id: coll.id,
      currentName: coll.name,
    };
    this.#setNameInputVisible(true, {
      placeholder: "Collection name…",
      defaultValue: coll.name,
      okLabel: "Rename",
    });
  }

  #commitName() {
    const input = this.#el.querySelector(".coll-name-input");
    const name = input.value.trim();
    if (!name) return;

    const action = this.#pendingAction;

    // For rename: if the name hasn't changed just close silently
    if (action?.type === "rename" && name === action.currentName) {
      this.#setNameInputVisible(false);
      return;
    }

    // Uniqueness check (case-insensitive); for rename, exclude the collection being renamed
    const isDuplicate = this.#collections.some((e) => {
      if (action?.type === "rename" && e.id === action.id) return false;
      return e.name.toLowerCase() === name.toLowerCase();
    });
    if (isDuplicate) {
      input.classList.add("coll-name-input--error");
      input.title = "A collection with this name already exists.";
      clearTimeout(this.#nameErrorTimer);
      this.#nameErrorTimer = setTimeout(() => {
        input.classList.remove("coll-name-input--error");
        input.title = "";
        this.#nameErrorTimer = null;
      }, 1500);
      return;
    }

    this.#setNameInputVisible(false);

    if (action === "add") {
      window.dispatchEvent(
        new CustomEvent("wurl:coll-add", { detail: { name }, bubbles: true }),
      );
    } else if (action?.type === "clone") {
      window.dispatchEvent(
        new CustomEvent("wurl:coll-clone", {
          detail: { sourceId: action.sourceId, name },
          bubbles: true,
        }),
      );
    } else if (action?.type === "rename") {
      window.dispatchEvent(
        new CustomEvent("wurl:coll-rename", {
          detail: { id: action.id, name },
          bubbles: true,
        }),
      );
    }
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  #selectColl(id) {
    if (id === this.#activeId) return;
    window.dispatchEvent(
      new CustomEvent("wurl:coll-select", { detail: { id }, bubbles: true }),
    );
  }

  #confirmDelete(coll) {
    PopupManager.confirm({
      title: "Delete Collection?",
      message: `Delete "<strong>${this.#escape(coll.name)}</strong>" and all its requests? This cannot be undone.`,
      confirmLabel: "Delete",
      confirmClass: "popup-btn--danger",
      onConfirm: () => {
        window.dispatchEvent(
          new CustomEvent("wurl:coll-delete", {
            detail: { id: coll.id },
            bubbles: true,
          }),
        );
      },
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  #escape(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
}
