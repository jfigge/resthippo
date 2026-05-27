/**
 * collections-popup.js — collections selector + inline variable editor
 *
 * Two-section popup:
 *   Top:    Collection selector (active one marked with a checkmark;
 *           add / clone / rename / delete actions)
 *   Bottom: Inline key/value editor with bulk-textarea / KV-row toggle
 *
 * Clicking a collection row both activates it (for tree-view data) and
 * loads its variables into the inline editor.
 *
 * Events dispatched on window:
 *   wurl:coll-select  { id }                    — switch active collection
 *   wurl:coll-add     { name }                  — create new empty collection
 *   wurl:coll-clone   { sourceId, name }        — clone a collection
 *   wurl:coll-rename  { id, name }              — rename a collection
 *   wurl:coll-delete  { id }                    — delete a collection
 *   wurl:vars-save    { envId, variables }       — debounced 500ms auto-save
 *   wurl:vars-bulk-editor-changed { bulkEditor } — toggle changed
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

  /** @type {{id: string, name: string, variables?: object}[]} */
  #collections = [];

  /** @type {string|null} */
  #activeId = null;

  /** ID currently shown in the variable editor */
  #selectedId = null;

  // ── Name-input form state ──────────────────────────────────────────────────
  /**
   * null | "add" | { type: "clone", sourceId: string, sourceName: string }
   *       | { type: "rename", id: string, currentName: string }
   */
  #pendingAction = null;
  /** @type {number|null} */
  #nameErrorTimer = null;

  // ── Variable-editor state ──────────────────────────────────────────────────
  #isBulkMode = true;
  /** @type {{ id:string, name:string, value:string }[]} */
  #rows = [];
  /** @type {number|null} */
  #saveTimer = null;
  /** vars snapshot per collection when first loaded — used by Reset */
  #initialCollectionVars = new Map();
  /** @type {Function|null} */
  #resetCleanup = null;

  static #SAVE_MS = 500;

  /** @type {boolean} */
  #removeHeaders = false;

  constructor() {
    this.#el = this.#build();
    this.#initResize(this.#el);
  }

  /** Root DOM element — required by PopupManager. */
  get element() {
    return this.#el;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * @param {{ removeHeaders?: boolean }} settings
   */
  applySettings(settings) {
    if (settings.removeHeaders !== undefined) {
      this.#removeHeaders = settings.removeHeaders;
      this.#applyRemoveHeaders();
    }
  }

  /**
   * Open the popup and immediately begin renaming the specified collection.
   * @param {{ collections: object[], activeCollectionId: string, bulkEditor?: boolean }} state
   * @param {string} collectionId
   */
  openWithRename(
    { collections, activeCollectionId, bulkEditor },
    collectionId = activeCollectionId,
  ) {
    this.open({ collections, activeCollectionId, bulkEditor });
    const coll = this.#collections.find((e) => e.id === collectionId);
    if (coll) this.#startRename(coll);
  }

  /**
   * Open the popup seeded with the current app state.
   * @param {{ collections: object[], activeCollectionId: string, bulkEditor?: boolean }} state
   */
  open({ collections, activeCollectionId, bulkEditor = true }) {
    this.#collections = collections.map((e) => ({ ...e }));
    this.#activeId = activeCollectionId;
    this.#selectedId = activeCollectionId;
    this.#pendingAction = null;
    this.#isBulkMode = bulkEditor;
    this.#el.querySelector(".coll-bulk-toggle").checked = bulkEditor;

    clearTimeout(this.#saveTimer);
    this.#cancelResetConfirm();
    this.#initialCollectionVars.clear();

    this.#setNameInputVisible(false);
    this.#renderList();
    this.#loadEditorForSelected();
    PopupManager.open(this);
    this.#applyRemoveHeaders();
  }

  /**
   * Refresh the list without closing the popup.
   * Called by app.js after any collection mutation.
   * @param {{ collections: object[], activeCollectionId: string, bulkEditor?: boolean }} state
   */
  update({ collections, activeCollectionId }) {
    const activeChanged = activeCollectionId !== this.#activeId;
    this.#collections = collections.map((e) => ({ ...e }));
    this.#activeId = activeCollectionId;
    this.#pendingAction = null;
    this.#setNameInputVisible(false);
    this.#renderList();

    // If the selected collection was deleted, fall back to active
    const selectedExists = this.#collections.some(
      (c) => c.id === this.#selectedId,
    );
    if (!selectedExists) {
      this.#selectedId = activeCollectionId;
      this.#loadEditorForSelected();
      return;
    }

    // After a collection switch, reload with freshly-loaded variables
    if (activeChanged && this.#selectedId === activeCollectionId) {
      this.#loadEditorForSelected();
    }
  }

  /** Called by PopupManager when the user clicks the overlay mask. */
  onMaskClick() {
    this.#doClose();
  }

  #applyRemoveHeaders() {
    const hdr = this.#el.querySelector(".coll-kv-header");
    if (hdr) hdr.style.display = this.#removeHeaders ? "none" : "";
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
        <div class="coll-selector-wrap">
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
        <div class="coll-vars-section">
          <div class="coll-vars-toolbar">
            <span class="coll-active-label">Variables</span>
            <label class="params-toolbar-toggle-label coll-bulk-label"
                   title="Toggle between bulk text editor and key/value row editor">
              <input type="checkbox" class="params-toolbar-toggle coll-bulk-toggle" checked>
              Bulk editor
            </label>
            <button class="icon-btn coll-add-btn" title="Add variable" aria-label="Add variable" style="display:none">+</button>
            <span class="coll-vars-hint">One  name=value  per line</span>
          </div>
          <textarea
            class="body-text-editor coll-textarea"
            spellcheck="false"
            autocomplete="off"
            placeholder="name=value&#10;baseUrl=https://example.com&#10;apiKey=abc123"
            aria-label="Variables editor"
          ></textarea>
          <div class="coll-kv-wrap" style="display:none">
            <div class="coll-kv-header params-header-row">
              <span>Name</span><span class="params-col-value">Value</span><span></span>
            </div>
            <div class="coll-kv-list params-list" aria-label="Variables"></div>
          </div>
        </div>
      </div>
      <div class="popup-footer coll-popup-footer">
        <button class="popup-btn popup-btn--secondary coll-new-btn">+ New Collection</button>
        <button class="popup-btn popup-btn--secondary coll-reset-btn"
                title="Reset variables to the values they had when this dialog was opened">Reset</button>
        <button class="popup-btn popup-btn--primary js-close">Close</button>
      </div>
    `;

    // Header / footer close
    el.querySelector(".popup-close").addEventListener("click", () =>
      this.#doClose(),
    );
    el.querySelector(".js-close").addEventListener("click", () =>
      this.#doClose(),
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

    // Variable editor controls
    el.querySelector(".coll-bulk-toggle").addEventListener("change", () =>
      this.#handleBulkToggle(),
    );
    el.querySelector(".coll-textarea").addEventListener("input", () =>
      this.#scheduleSave(),
    );
    el.querySelector(".coll-add-btn").addEventListener("click", () =>
      this.#addRow(),
    );
    el.querySelector(".coll-reset-btn").addEventListener("click", () =>
      this.#handleReset(),
    );

    el.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.#resetCleanup) {
        e.stopPropagation();
        this.#doClose();
      }
    });

    return el;
  }

  // ── List rendering ─────────────────────────────────────────────────────────

  #renderList() {
    const ul = this.#el.querySelector(".coll-list");
    ul.innerHTML = "";
    const count = this.#collections.length;

    this.#collections.forEach((collection) => {
      const isActive = collection.id === this.#activeId;
      const isSelected = collection.id === this.#selectedId;

      const li = document.createElement("li");
      li.className =
        "coll-list-item" +
        (isActive ? " coll-list-item--active" : "") +
        (isSelected && !isActive ? " coll-list-item--selected" : "");
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(isActive));

      const check = document.createElement("span");
      check.className = "coll-list-item__check";
      check.innerHTML = isActive ? ICON_CHECK : "";

      const nameBtn = document.createElement("button");
      nameBtn.className = "coll-list-item__name";
      nameBtn.textContent = collection.name;
      nameBtn.setAttribute("aria-label", `Select ${collection.name}`);
      nameBtn.addEventListener("click", () => this.#selectColl(collection.id));

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

    if (action?.type === "rename" && name === action.currentName) {
      this.#setNameInputVisible(false);
      return;
    }

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
      this.#flushEditorSave();
      window.dispatchEvent(
        new CustomEvent("wurl:coll-add", { detail: { name }, bubbles: true }),
      );
    } else if (action?.type === "clone") {
      this.#flushEditorSave();
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

  // ── Collection selection & deletion ───────────────────────────────────────

  #selectColl(id) {
    if (id === this.#selectedId) return;
    this.#flushEditorSave();
    this.#selectedId = id;
    this.#renderList();
    this.#loadEditorForSelected();
    if (id !== this.#activeId) {
      window.dispatchEvent(
        new CustomEvent("wurl:coll-select", { detail: { id }, bubbles: true }),
      );
    }
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

  // ── Variable editor ────────────────────────────────────────────────────────

  #loadEditorForSelected() {
    const vars = this.#getSelectedVars();

    // Save initial snapshot for Reset (only on first load per collection)
    if (!this.#initialCollectionVars.has(this.#selectedId)) {
      this.#initialCollectionVars.set(this.#selectedId, { ...vars });
    }

    const label = this.#el.querySelector(".coll-active-label");
    if (label) {
      const coll = this.#collections.find((c) => c.id === this.#selectedId);
      label.textContent = coll ? `${coll.name} Variables` : "Variables";
    }

    clearTimeout(this.#saveTimer);
    this.#cancelResetConfirm();

    if (this.#isBulkMode) {
      this.#el.querySelector(".coll-textarea").value = this.#varsToText(vars);
    } else {
      this.#rows = this.#varsToRows(vars);
      this.#renderRows();
    }
    this.#applyMode();
  }

  #getSelectedVars() {
    return (
      this.#collections.find((c) => c.id === this.#selectedId)?.variables ?? {}
    );
  }

  // ── Mode switching ─────────────────────────────────────────────────────────

  #applyMode() {
    const bulk = this.#isBulkMode;
    const textarea = this.#el.querySelector(".coll-textarea");
    const kvWrap = this.#el.querySelector(".coll-kv-wrap");
    const hintEl = this.#el.querySelector(".coll-vars-hint");
    const addBtn = this.#el.querySelector(".coll-add-btn");
    textarea.style.display = bulk ? "" : "none";
    kvWrap.style.display = bulk ? "none" : "";
    if (hintEl) hintEl.style.display = bulk ? "" : "none";
    if (addBtn) addBtn.style.display = bulk ? "none" : "";
  }

  #handleBulkToggle() {
    const nowBulk = this.#el.querySelector(".coll-bulk-toggle").checked;
    if (nowBulk && !this.#isBulkMode) {
      this.#el.querySelector(".coll-textarea").value = this.#varsToText(
        this.#rowsToObject(),
      );
    } else if (!nowBulk && this.#isBulkMode) {
      this.#rows = this.#varsToRows(
        this.#textToVars(this.#el.querySelector(".coll-textarea").value),
      );
    }
    this.#isBulkMode = nowBulk;
    this.#applyMode();
    if (nowBulk) {
      requestAnimationFrame(() =>
        this.#el.querySelector(".coll-textarea").focus(),
      );
    } else {
      this.#renderRows();
      this.#saveFromRows();
    }
    window.dispatchEvent(
      new CustomEvent("wurl:vars-bulk-editor-changed", {
        detail: { bulkEditor: nowBulk },
        bubbles: true,
      }),
    );
  }

  // ── Conversion helpers ─────────────────────────────────────────────────────

  #varsToText(vars) {
    return Object.entries(vars)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
  }

  #textToVars(text) {
    const out = {};
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1);
      if (key) out[key] = val;
    }
    return out;
  }

  #varsToRows(vars) {
    return Object.entries(vars).map(([name, value]) => ({
      id: crypto.randomUUID(),
      name,
      value: typeof value === "string" ? value : JSON.stringify(value),
    }));
  }

  #rowsToObject() {
    const out = {};
    for (const r of this.#rows) {
      if (r.name.trim()) out[r.name] = r.value;
    }
    return out;
  }

  // ── KV row rendering ───────────────────────────────────────────────────────

  #renderRows() {
    const kvList = this.#el.querySelector(".coll-kv-list");
    kvList.innerHTML = "";
    if (this.#rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "params-empty";
      empty.textContent = "No variables — click  +  to add one.";
      kvList.appendChild(empty);
      return;
    }
    this.#rows.forEach((row) => kvList.appendChild(this.#buildRow(row)));
  }

  #buildRow(row) {
    const el = document.createElement("div");
    el.className = "coll-kv-row params-row";
    el.dataset.id = row.id;

    const nameIn = document.createElement("input");
    nameIn.type = "text";
    nameIn.className = "params-input params-name";
    nameIn.placeholder = "Name";
    nameIn.value = row.name;
    nameIn.setAttribute("aria-label", "Variable name");
    nameIn.setAttribute("autocomplete", "off");
    nameIn.addEventListener("input", () => {
      row.name = nameIn.value;
      this.#saveFromRows();
    });
    nameIn.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.#addRow();
      }
    });

    const valIn = document.createElement("input");
    valIn.type = "text";
    valIn.className = "params-input params-value";
    valIn.placeholder = "Value";
    valIn.value = row.value;
    valIn.setAttribute("aria-label", "Variable value");
    valIn.addEventListener("input", () => {
      row.value = valIn.value;
      this.#saveFromRows();
    });
    valIn.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.#addRow();
      }
    });

    const del = document.createElement("button");
    del.className = "icon-btn params-delete-btn";
    del.title = "Delete variable";
    del.setAttribute("aria-label", "Delete variable");
    del.innerHTML = `<svg width="10" height="10" viewBox="0 0 12 12" fill="none"
        stroke="currentColor" stroke-width="2" stroke-linecap="round">
      <line x1="1" y1="1" x2="11" y2="11"/><line x1="11" y1="1" x2="1" y2="11"/>
    </svg>`;
    del.addEventListener("click", () => {
      this.#rows = this.#rows.filter((r) => r.id !== row.id);
      this.#renderRows();
      this.#saveFromRows();
    });

    el.appendChild(nameIn);
    el.appendChild(valIn);
    el.appendChild(del);
    return el;
  }

  #addRow() {
    const row = { id: crypto.randomUUID(), name: "", value: "" };
    this.#rows.push(row);
    this.#renderRows();
    const rows = this.#el
      .querySelector(".coll-kv-list")
      .querySelectorAll(".coll-kv-row");
    if (rows.length)
      rows[rows.length - 1].querySelector(".params-name")?.focus();
  }

  // ── Save ───────────────────────────────────────────────────────────────────

  #scheduleSave() {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(
      () => this.#saveFromBulk(),
      CollectionsPopup.#SAVE_MS,
    );
  }

  #saveFromBulk() {
    this.#dispatchVarsSave(
      this.#textToVars(this.#el.querySelector(".coll-textarea").value),
    );
  }

  #saveFromRows() {
    this.#dispatchVarsSave(this.#rowsToObject());
  }

  #flushEditorSave() {
    clearTimeout(this.#saveTimer);
    if (this.#isBulkMode) this.#saveFromBulk();
    else this.#saveFromRows();
  }

  #dispatchVarsSave(variables) {
    if (!this.#selectedId) return;
    // Update in-memory collection state
    this.#collections = this.#collections.map((c) =>
      c.id === this.#selectedId ? { ...c, variables } : c,
    );
    window.dispatchEvent(
      new CustomEvent("wurl:vars-save", {
        detail: { envId: this.#selectedId, variables },
        bubbles: true,
      }),
    );
  }

  // ── Reset ──────────────────────────────────────────────────────────────────

  #handleReset() {
    if (this.#resetCleanup) {
      this.#cancelResetConfirm();
      const initVars = this.#getInitialVars();
      if (this.#isBulkMode) {
        this.#el.querySelector(".coll-textarea").value =
          this.#varsToText(initVars);
        this.#saveFromBulk();
      } else {
        this.#rows = this.#varsToRows(initVars);
        this.#renderRows();
        this.#saveFromRows();
      }
      return;
    }

    const resetBtn = this.#el.querySelector(".coll-reset-btn");
    resetBtn.textContent = "Confirm?";
    resetBtn.classList.replace("popup-btn--secondary", "popup-btn--warning");

    const restore = () => {
      resetBtn.textContent = "Reset";
      resetBtn.classList.replace("popup-btn--warning", "popup-btn--secondary");
      document.removeEventListener("keydown", onEsc, true);
      document.removeEventListener("mousedown", onOutside, true);
      this.#resetCleanup = null;
    };
    const onEsc = (e) => {
      if (e.key === "Escape") restore();
    };
    const onOutside = (e) => {
      if (!resetBtn.contains(e.target)) restore();
    };

    document.addEventListener("keydown", onEsc, true);
    document.addEventListener("mousedown", onOutside, true);
    this.#resetCleanup = restore;
  }

  #getInitialVars() {
    return this.#initialCollectionVars.get(this.#selectedId) ?? {};
  }

  #cancelResetConfirm() {
    if (this.#resetCleanup) this.#resetCleanup();
  }

  // ── Close ──────────────────────────────────────────────────────────────────

  #doClose() {
    this.#flushEditorSave();
    this.#cancelResetConfirm();
    PopupManager.close();
  }

  // ── Resize ─────────────────────────────────────────────────────────────────

  #initResize(el) {
    const handle = document.createElement("div");
    handle.className = "popup-resize-handle";
    handle.setAttribute("aria-hidden", "true");
    handle.innerHTML = `<svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
      <circle cx="9" cy="9" r="1.4"/><circle cx="5" cy="9" r="1.4"/><circle cx="9" cy="5" r="1.4"/>
    </svg>`;
    el.appendChild(handle);

    handle.addEventListener("mousedown", (startEvt) => {
      startEvt.preventDefault();
      startEvt.stopPropagation();
      const rect = el.getBoundingClientRect();
      const minW = rect.width;
      const minH = rect.height;
      // Center stays fixed at 50vw/50vh — width = 2 × (mouseX − centerX)
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      el.style.maxWidth = "none";
      el.style.maxHeight = "none";
      const onMove = (e) => {
        el.style.width = `${Math.max(minW, 2 * (e.clientX - centerX))}px`;
        el.style.height = `${Math.max(minH, 2 * (e.clientY - centerY))}px`;
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
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
