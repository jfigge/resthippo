/**
 * environments-popup.js — Global and named environment variable sets
 *
 * Two-section popup:
 *   Top:    Environment selector (Global always first; named envs below with
 *           rename/delete; + New Environment button)
 *   Bottom: Inline key/value editor with bulk-textarea / KV-row toggle
 *
 * Clicking a row both activates the environment (for variable resolution) and
 * loads its variables into the editor.
 *
 * Events dispatched on window:
 *   wurl:environments-changed { data }          — add / rename / delete
 *   wurl:env-activate         { id }            — row selected (null = Global)
 *   wurl:env-vars-save        { id, variables } — debounced 500ms auto-save
 *   wurl:env-bulk-editor-changed { bulkEditor } — toggle changed
 */

"use strict";

import { PopupManager } from "../popup-manager.js";

// ── SVG icons ─────────────────────────────────────────────────────────────────

const ICON_CHECK = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
  aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`;

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

// ── EnvironmentsPopup ─────────────────────────────────────────────────────────

export class EnvironmentsPopup {
  /** @type {HTMLElement} */
  #el;

  /** Full environments data — kept in sync with app.js via events */
  #data = { version: 1, globalVariables: {}, activeEnvironmentId: null, environments: [] };

  /** Snapshot at open() for the Reset button */
  #initialData = null;

  /** ID currently shown in the variable editor (null = Global) */
  #selectedId = null;

  // ── Name-input form state ──────────────────────────────────────────────────
  /** null | "add" | { type: "rename", id: string, currentName: string } */
  #pendingAction  = null;
  /** @type {number|null} */
  #nameErrorTimer = null;

  // ── Variable-editor state ──────────────────────────────────────────────────
  #isBulkMode   = true;
  /** @type {{ id:string, name:string, value:string }[]} */
  #rows         = [];
  /** @type {HTMLElement} */
  #phantom;
  #dragSrcId    = null;
  #dragHandled  = false;
  /** @type {number|null} */
  #saveTimer    = null;
  /** @type {Function|null} */
  #resetCleanup = null;

  static #SAVE_MS = 500;

  constructor() {
    this.#el      = this.#build();
    this.#phantom = this.#buildPhantom();
  }

  get element() { return this.#el; }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Open the popup seeded with the current environments data.
   * @param {object} data
   * @param {{ bulkEditor?: boolean }} [opts]
   */
  open(data, { bulkEditor = true } = {}) {
    this.#data        = this.#clone(data);
    this.#initialData = this.#clone(data);
    this.#selectedId  = data.activeEnvironmentId ?? null;
    this.#pendingAction = null;
    this.#isBulkMode    = bulkEditor;
    this.#el.querySelector(".env-bulk-toggle").checked = bulkEditor;

    clearTimeout(this.#saveTimer);
    this.#cancelResetConfirm();

    this.#setNameInputVisible(false);
    this.#renderList();
    this.#loadEditorForSelected();
    PopupManager.open(this);
  }

  /**
   * Refresh the list after a structural change (add/rename/delete).
   * Does NOT reload the variable editor — preserves in-progress edits.
   * @param {object} data
   */
  update(data) {
    const stillExists = this.#selectedId === null ||
      data.environments.some(e => e.id === this.#selectedId);
    if (!stillExists) {
      this.#selectedId = null;
      this.#loadEditorForSelected();
    }
    this.#data = this.#clone(data);
    this.#pendingAction = null;
    this.#setNameInputVisible(false);
    this.#renderList();
  }

  /** Required by PopupManager. */
  onMaskClick() { this.#doClose(); }

  // ── Build ──────────────────────────────────────────────────────────────────

  #build() {
    const el = document.createElement("div");
    el.className = "popup environments-popup";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", "Environments");

    el.innerHTML = `
      <div class="popup-header">
        <span class="popup-title">Environments</span>
        <button class="popup-close" aria-label="Close environments" title="Close">✕</button>
      </div>
      <div class="popup-body env-popup-body">
        <div class="env-selector-wrap">
          <div class="env-name-input-row">
            <input
              class="env-name-input"
              type="text"
              placeholder="Environment name…"
              autocomplete="off"
              spellcheck="false"
            />
            <button class="popup-btn popup-btn--primary env-name-ok" disabled>Add</button>
            <button class="popup-btn popup-btn--secondary env-name-cancel">Cancel</button>
          </div>
          <ul class="env-list" role="listbox" aria-label="Environments"></ul>
        </div>
        <div class="env-vars-section">
          <div class="env-vars-toolbar">
            <span class="env-active-label">Global Variables</span>
            <label class="params-toolbar-toggle-label env-bulk-label"
                   title="Toggle between bulk text editor and key/value row editor">
              <input type="checkbox" class="params-toolbar-toggle env-bulk-toggle" checked>
              Bulk editor
            </label>
            <button class="icon-btn env-add-btn" title="Add variable" aria-label="Add variable" style="display:none">+</button>
            <span class="env-vars-hint">One  name=value  per line</span>
          </div>
          <textarea
            class="body-text-editor env-textarea"
            spellcheck="false"
            autocomplete="off"
            placeholder="name=value&#10;baseUrl=https://example.com&#10;apiKey=abc123"
            aria-label="Variables editor"
          ></textarea>
          <div class="env-kv-wrap" style="display:none">
            <div class="env-kv-header params-header-row">
              <span></span><span>Name</span><span class="params-col-value">Value</span><span></span>
            </div>
            <div class="env-kv-list params-list" aria-label="Variables"></div>
          </div>
        </div>
      </div>
      <div class="popup-footer env-popup-footer">
        <button class="popup-btn popup-btn--secondary env-new-btn">+ New Environment</button>
        <button class="popup-btn popup-btn--secondary env-reset-btn"
                title="Reset variables to the values they had when this dialog was opened">Reset</button>
        <button class="popup-btn popup-btn--primary js-close">Close</button>
      </div>
    `;

    el.querySelector(".popup-close").addEventListener("click", () => this.#doClose());
    el.querySelector(".js-close").addEventListener("click",    () => this.#doClose());
    el.querySelector(".env-new-btn").addEventListener("click", () => this.#startAdd());

    const nameInput = el.querySelector(".env-name-input");
    const nameOkBtn = el.querySelector(".env-name-ok");
    const cancelBtn = el.querySelector(".env-name-cancel");

    nameInput.addEventListener("input",   () => { nameOkBtn.disabled = !nameInput.value.trim(); });
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter"  && !nameOkBtn.disabled) nameOkBtn.click();
      if (e.key === "Escape")                        cancelBtn.click();
    });
    nameOkBtn.addEventListener("click",  () => this.#commitName());
    cancelBtn.addEventListener("click",  () => this.#setNameInputVisible(false));

    el.querySelector(".env-bulk-toggle").addEventListener("change", () => this.#handleBulkToggle());
    el.querySelector(".env-textarea").addEventListener("input",     () => this.#scheduleSave());
    el.querySelector(".env-add-btn").addEventListener("click",      () => this.#addRow());
    el.querySelector(".env-reset-btn").addEventListener("click",    () => this.#handleReset());

    el.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.#resetCleanup) {
        e.stopPropagation();
        this.#doClose();
      }
    });

    const kvList = el.querySelector(".env-kv-list");
    kvList.addEventListener("dragover", (e) => {
      if (!this.#dragSrcId) { this.#phantom?.remove(); return; }
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (!kvList.contains(this.#phantom)) kvList.appendChild(this.#phantom);
    });
    kvList.addEventListener("drop", (e) => {
      e.preventDefault();
      if (!this.#dragSrcId) return;
      this.#dragHandled = true;
      const children = [...kvList.children];
      const phIdx    = children.indexOf(this.#phantom);
      if (phIdx === -1) { this.#finalizeDrag(); return; }
      const rowEls   = children.filter(c => c.classList.contains("env-kv-row"));
      const insertAt = rowEls.filter(r => children.indexOf(r) < phIdx).length;
      const srcIdx   = this.#rows.findIndex(r => r.id === this.#dragSrcId);
      if (srcIdx !== -1) {
        const [moved] = this.#rows.splice(srcIdx, 1);
        this.#rows.splice(insertAt > srcIdx ? insertAt - 1 : insertAt, 0, moved);
        this.#renderRows();
        this.#saveFromRows();
      }
      this.#finalizeDrag();
    });

    return el;
  }

  #buildPhantom() {
    const ph = document.createElement("div");
    ph.className = "params-drop-phantom";
    return ph;
  }

  // ── Environment list ───────────────────────────────────────────────────────

  #renderList() {
    const ul = this.#el.querySelector(".env-list");
    ul.innerHTML = "";

    // Global row — always first, never has rename/delete
    ul.appendChild(this.#buildEnvRow({
      id:       null,
      name:     "Global",
      isActive:   this.#data.activeEnvironmentId === null,
      isSelected: this.#selectedId === null,
      isGlobal:   true,
    }));

    for (const env of this.#data.environments) {
      ul.appendChild(this.#buildEnvRow({
        id:         env.id,
        name:       env.name,
        isActive:   env.id === this.#data.activeEnvironmentId,
        isSelected: env.id === this.#selectedId,
        isGlobal:   false,
      }));
    }
  }

  #buildEnvRow({ id, name, isActive, isSelected, isGlobal }) {
    const li = document.createElement("li");
    li.className = "env-list-item" +
      (isActive   ? " env-list-item--active"   : "") +
      (isSelected ? " env-list-item--selected" : "");
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", String(isActive));

    const check = document.createElement("span");
    check.className = "env-list-item__check";
    check.innerHTML = isActive ? ICON_CHECK : "";

    const nameBtn = document.createElement("button");
    nameBtn.className   = "env-list-item__name";
    nameBtn.textContent = name;
    nameBtn.setAttribute("aria-label", isGlobal ? "Select Global variables" : `Select ${name}`);
    nameBtn.addEventListener("click", () => this.#selectEnv(id));

    li.appendChild(check);
    li.appendChild(nameBtn);

    if (!isGlobal) {
      const actions = document.createElement("div");
      actions.className = "env-list-item__actions";

      const renameBtn = document.createElement("button");
      renameBtn.className = "coll-action-btn";
      renameBtn.title     = "Rename environment";
      renameBtn.innerHTML = ICON_RENAME;
      renameBtn.setAttribute("aria-label", `Rename ${name}`);
      renameBtn.addEventListener("click", (e) => { e.stopPropagation(); this.#startRename({ id, name }); });

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "coll-action-btn coll-action-btn--danger";
      deleteBtn.title     = "Delete environment";
      deleteBtn.innerHTML = ICON_DELETE;
      deleteBtn.setAttribute("aria-label", `Delete ${name}`);
      deleteBtn.addEventListener("click", (e) => { e.stopPropagation(); this.#confirmDelete({ id, name }); });

      actions.appendChild(renameBtn);
      actions.appendChild(deleteBtn);
      li.appendChild(actions);
    }

    return li;
  }

  // ── Name-input form ────────────────────────────────────────────────────────

  #setNameInputVisible(visible, { placeholder = "Environment name…", defaultValue = "", okLabel = "Add" } = {}) {
    const row    = this.#el.querySelector(".env-name-input-row");
    const input  = this.#el.querySelector(".env-name-input");
    const okBtn  = this.#el.querySelector(".env-name-ok");
    const newBtn = this.#el.querySelector(".env-new-btn");

    if (visible) {
      input.placeholder = placeholder;
      input.value       = defaultValue;
      okBtn.textContent = okLabel;
      okBtn.disabled    = !defaultValue.trim();
      input.classList.remove("env-name-input--error");
      row.classList.add("env-name-input-row--visible");
      newBtn.disabled = true;
      requestAnimationFrame(() => { input.focus(); input.select(); });
    } else {
      clearTimeout(this.#nameErrorTimer);
      this.#nameErrorTimer = null;
      row.classList.remove("env-name-input-row--visible");
      input.value       = "";
      okBtn.textContent = "Add";
      newBtn.disabled   = false;
      this.#pendingAction = null;
    }
  }

  #startAdd() {
    this.#pendingAction = "add";
    this.#setNameInputVisible(true, { placeholder: "New environment name…" });
  }

  #startRename(env) {
    this.#pendingAction = { type: "rename", id: env.id, currentName: env.name };
    this.#setNameInputVisible(true, {
      placeholder:  "Environment name…",
      defaultValue: env.name,
      okLabel:      "Rename",
    });
  }

  #commitName() {
    const input  = this.#el.querySelector(".env-name-input");
    const name   = input.value.trim();
    if (!name) return;

    const action = this.#pendingAction;

    if (action?.type === "rename" && name === action.currentName) {
      this.#setNameInputVisible(false);
      return;
    }

    const isDuplicate = this.#data.environments.some(e => {
      if (action?.type === "rename" && e.id === action.id) return false;
      return e.name.toLowerCase() === name.toLowerCase();
    });
    if (isDuplicate) {
      input.classList.add("env-name-input--error");
      input.title = "An environment with this name already exists.";
      clearTimeout(this.#nameErrorTimer);
      this.#nameErrorTimer = setTimeout(() => {
        input.classList.remove("env-name-input--error");
        input.title = "";
        this.#nameErrorTimer = null;
      }, 1500);
      return;
    }

    this.#setNameInputVisible(false);

    if (action === "add") {
      const id     = crypto.randomUUID();
      const newEnv = { id, name, variables: {} };
      const newData = {
        ...this.#data,
        environments:        [...this.#data.environments, newEnv],
        activeEnvironmentId: id,
      };
      this.#data       = newData;
      this.#selectedId = id;
      this.#renderList();
      this.#loadEditorForSelected();
      window.dispatchEvent(new CustomEvent("wurl:environments-changed", {
        detail: { data: this.#clone(newData) }, bubbles: true,
      }));
    } else if (action?.type === "rename") {
      const newData = {
        ...this.#data,
        environments: this.#data.environments.map(e =>
          e.id === action.id ? { ...e, name } : e,
        ),
      };
      this.#data = newData;
      this.#renderList();
      window.dispatchEvent(new CustomEvent("wurl:environments-changed", {
        detail: { data: this.#clone(newData) }, bubbles: true,
      }));
    }
  }

  // ── Environment selection & deletion ───────────────────────────────────────

  #selectEnv(id) {
    if (id === this.#selectedId) return;
    this.#flushEditorSave();
    this.#selectedId = id;
    this.#data = { ...this.#data, activeEnvironmentId: id };
    this.#renderList();
    this.#loadEditorForSelected();
    window.dispatchEvent(new CustomEvent("wurl:env-activate", {
      detail: { id }, bubbles: true,
    }));
  }

  #confirmDelete(env) {
    PopupManager.confirm({
      title:        "Delete Environment?",
      message:      `Delete "<strong>${this.#escape(env.name)}</strong>" and all its variables? This cannot be undone.`,
      confirmLabel: "Delete",
      confirmClass: "popup-btn--danger",
      onConfirm:    () => {
        const wasSelected = this.#selectedId === env.id;
        const wasActive   = this.#data.activeEnvironmentId === env.id;
        const newData = {
          ...this.#data,
          environments:        this.#data.environments.filter(e => e.id !== env.id),
          activeEnvironmentId: wasActive ? null : this.#data.activeEnvironmentId,
        };
        this.#data = newData;
        if (wasSelected) {
          this.#selectedId = null;
          this.#loadEditorForSelected();
        }
        this.#renderList();
        window.dispatchEvent(new CustomEvent("wurl:environments-changed", {
          detail: { data: this.#clone(newData) }, bubbles: true,
        }));
      },
    });
  }

  // ── Variable editor ────────────────────────────────────────────────────────

  #loadEditorForSelected() {
    const vars  = this.#getSelectedVars();
    const label = this.#el.querySelector(".env-active-label");
    if (label) {
      const envName = this.#selectedId === null
        ? null
        : this.#data.environments.find(e => e.id === this.#selectedId)?.name;
      label.textContent = envName ? `${envName} Variables` : "Global Variables";
    }

    clearTimeout(this.#saveTimer);
    this.#cancelResetConfirm();

    if (this.#isBulkMode) {
      this.#el.querySelector(".env-textarea").value = this.#varsToText(vars);
    } else {
      this.#rows = this.#varsToRows(vars);
      this.#renderRows();
    }
    this.#applyMode();
  }

  #getSelectedVars() {
    if (this.#selectedId === null) return this.#data.globalVariables ?? {};
    return this.#data.environments.find(e => e.id === this.#selectedId)?.variables ?? {};
  }

  // ── Mode switching ─────────────────────────────────────────────────────────

  #applyMode() {
    const bulk     = this.#isBulkMode;
    const textarea = this.#el.querySelector(".env-textarea");
    const kvWrap   = this.#el.querySelector(".env-kv-wrap");
    const hintEl   = this.#el.querySelector(".env-vars-hint");
    const addBtn   = this.#el.querySelector(".env-add-btn");
    textarea.style.display = bulk ? "" : "none";
    kvWrap.style.display   = bulk ? "none" : "";
    if (hintEl) hintEl.style.display = bulk ? "" : "none";
    if (addBtn) addBtn.style.display = bulk ? "none" : "";
  }

  #handleBulkToggle() {
    const nowBulk = this.#el.querySelector(".env-bulk-toggle").checked;
    if (nowBulk && !this.#isBulkMode) {
      this.#el.querySelector(".env-textarea").value = this.#varsToText(this.#rowsToObject());
    } else if (!nowBulk && this.#isBulkMode) {
      this.#rows = this.#varsToRows(this.#textToVars(this.#el.querySelector(".env-textarea").value));
    }
    this.#isBulkMode = nowBulk;
    this.#applyMode();
    if (nowBulk) {
      requestAnimationFrame(() => this.#el.querySelector(".env-textarea").focus());
    } else {
      this.#renderRows();
      this.#saveFromRows();
    }
    window.dispatchEvent(new CustomEvent("wurl:env-bulk-editor-changed", {
      detail: { bulkEditor: nowBulk }, bubbles: true,
    }));
  }

  // ── Conversion helpers ─────────────────────────────────────────────────────

  #varsToText(vars) {
    return Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n");
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
      id: crypto.randomUUID(), name,
      value: typeof value === "string" ? value : JSON.stringify(value),
    }));
  }

  #rowsToObject() {
    const out = {};
    for (const r of this.#rows) { if (r.name.trim()) out[r.name] = r.value; }
    return out;
  }

  // ── KV row rendering ───────────────────────────────────────────────────────

  #renderRows() {
    const kvList = this.#el.querySelector(".env-kv-list");
    kvList.innerHTML = "";
    if (this.#rows.length === 0) {
      const empty = document.createElement("div");
      empty.className   = "params-empty";
      empty.textContent = "No variables — click  +  to add one.";
      kvList.appendChild(empty);
      return;
    }
    this.#rows.forEach(row => kvList.appendChild(this.#buildRow(row)));
  }

  #buildRow(row) {
    const el = document.createElement("div");
    el.className  = "env-kv-row params-row";
    el.dataset.id = row.id;
    el.draggable  = true;

    const handle = document.createElement("span");
    handle.className = "params-drag-handle";
    handle.setAttribute("aria-hidden", "true");
    handle.title = "Drag to reorder";
    handle.innerHTML = `<svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor">
      <circle cx="3" cy="3"  r="1.4"/><circle cx="7" cy="3"  r="1.4"/>
      <circle cx="3" cy="8"  r="1.4"/><circle cx="7" cy="8"  r="1.4"/>
      <circle cx="3" cy="13" r="1.4"/><circle cx="7" cy="13" r="1.4"/>
    </svg>`;

    const nameIn = document.createElement("input");
    nameIn.type = "text"; nameIn.className = "params-input params-name";
    nameIn.placeholder = "Name"; nameIn.value = row.name;
    nameIn.setAttribute("aria-label", "Variable name");
    nameIn.setAttribute("autocomplete", "off");
    nameIn.addEventListener("input",   () => { row.name = nameIn.value; this.#saveFromRows(); });
    nameIn.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); this.#addRow(); } });

    const valIn = document.createElement("input");
    valIn.type = "text"; valIn.className = "params-input params-value";
    valIn.placeholder = "Value"; valIn.value = row.value;
    valIn.setAttribute("aria-label", "Variable value");
    valIn.addEventListener("input",   () => { row.value = valIn.value; this.#saveFromRows(); });
    valIn.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); this.#addRow(); } });

    const del = document.createElement("button");
    del.className = "icon-btn params-delete-btn";
    del.title = "Delete variable";
    del.setAttribute("aria-label", "Delete variable");
    del.innerHTML = `<svg width="10" height="10" viewBox="0 0 12 12" fill="none"
        stroke="currentColor" stroke-width="2" stroke-linecap="round">
      <line x1="1" y1="1" x2="11" y2="11"/><line x1="11" y1="1" x2="1" y2="11"/>
    </svg>`;
    del.addEventListener("click", () => {
      this.#rows = this.#rows.filter(r => r.id !== row.id);
      this.#renderRows();
      this.#saveFromRows();
    });

    el.addEventListener("dragstart", (e) => {
      this.#dragSrcId = row.id; this.#dragHandled = false;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", row.id);
      requestAnimationFrame(() => {
        if (!this.#dragSrcId) return;
        el.parentElement?.insertBefore(this.#phantom, el);
        el.style.display = "none";
      });
    });
    el.addEventListener("dragover", (e) => {
      if (!this.#dragSrcId || this.#dragSrcId === row.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const rect  = el.getBoundingClientRect();
      const after = (e.clientY - rect.top) / rect.height >= 0.5;
      el.parentElement?.insertBefore(this.#phantom, after ? el.nextSibling : el);
    });
    el.addEventListener("dragend", () => {
      if (!this.#dragHandled) { el.style.display = ""; this.#phantom.remove(); }
      this.#finalizeDrag();
    });

    el.appendChild(handle);
    el.appendChild(nameIn);
    el.appendChild(valIn);
    el.appendChild(del);
    return el;
  }

  #finalizeDrag() {
    this.#dragSrcId = null; this.#dragHandled = false; this.#phantom.remove();
  }

  #addRow() {
    const row = { id: crypto.randomUUID(), name: "", value: "" };
    this.#rows.push(row);
    this.#renderRows();
    const rows = this.#el.querySelector(".env-kv-list").querySelectorAll(".env-kv-row");
    if (rows.length) rows[rows.length - 1].querySelector(".params-name")?.focus();
  }

  // ── Save ───────────────────────────────────────────────────────────────────

  #scheduleSave() {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => this.#saveFromBulk(), EnvironmentsPopup.#SAVE_MS);
  }

  #saveFromBulk() {
    this.#dispatchVarsSave(this.#textToVars(this.#el.querySelector(".env-textarea").value));
  }

  #saveFromRows() { this.#dispatchVarsSave(this.#rowsToObject()); }

  #flushEditorSave() {
    clearTimeout(this.#saveTimer);
    if (this.#isBulkMode) this.#saveFromBulk(); else this.#saveFromRows();
  }

  #dispatchVarsSave(variables) {
    if (this.#selectedId === null) {
      this.#data = { ...this.#data, globalVariables: variables };
    } else {
      this.#data = {
        ...this.#data,
        environments: this.#data.environments.map(e =>
          e.id === this.#selectedId ? { ...e, variables } : e,
        ),
      };
    }
    window.dispatchEvent(new CustomEvent("wurl:env-vars-save", {
      detail: { id: this.#selectedId, variables }, bubbles: true,
    }));
  }

  // ── Reset ──────────────────────────────────────────────────────────────────

  #handleReset() {
    if (this.#resetCleanup) {
      this.#cancelResetConfirm();
      const initVars = this.#getInitialVars();
      if (this.#isBulkMode) {
        this.#el.querySelector(".env-textarea").value = this.#varsToText(initVars);
        this.#saveFromBulk();
      } else {
        this.#rows = this.#varsToRows(initVars);
        this.#renderRows();
        this.#saveFromRows();
      }
      return;
    }

    const resetBtn = this.#el.querySelector(".env-reset-btn");
    resetBtn.textContent = "Confirm?";
    resetBtn.classList.replace("popup-btn--secondary", "popup-btn--warning");

    const restore = () => {
      resetBtn.textContent = "Reset";
      resetBtn.classList.replace("popup-btn--warning", "popup-btn--secondary");
      document.removeEventListener("keydown",   onEsc,     true);
      document.removeEventListener("mousedown", onOutside, true);
      this.#resetCleanup = null;
    };
    const onEsc     = (e) => { if (e.key === "Escape") restore(); };
    const onOutside = (e) => { if (!resetBtn.contains(e.target)) restore(); };

    document.addEventListener("keydown",   onEsc,     true);
    document.addEventListener("mousedown", onOutside, true);
    this.#resetCleanup = restore;
  }

  #getInitialVars() {
    if (!this.#initialData) return {};
    if (this.#selectedId === null) return this.#initialData.globalVariables ?? {};
    return this.#initialData.environments?.find(e => e.id === this.#selectedId)?.variables ?? {};
  }

  #cancelResetConfirm() { if (this.#resetCleanup) this.#resetCleanup(); }

  // ── Close ──────────────────────────────────────────────────────────────────

  #doClose() {
    this.#flushEditorSave();
    this.#cancelResetConfirm();
    PopupManager.close();
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  #escape(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  #clone(obj) { return JSON.parse(JSON.stringify(obj)); }
}
