/**
 * environments-popup.js — Global and named environment variable sets
 *
 * Settings-style two-pane layout (mirrors collections-popup.js):
 *   Left pane:  a sidebar listing every environment. A toolbar at the top holds
 *               an add ([+]) button. Global is always first and cannot be
 *               renamed, deleted, or reordered; named environments can be
 *               dragged to reorder and edited inline (Enter confirms, Escape
 *               cancels). The active environment is marked with a checkmark.
 *   Right pane: a tabbed panel for the selected environment:
 *               • Variables — the inline key/value editor (bulk-textarea /
 *                 KV-row toggle) plus a reset button.
 *
 * Clicking a row both activates the environment (for variable resolution) and
 * loads its variables into the editor.
 *
 * Constructor callbacks (this is a parent-owned popup that reports back to its
 * creator, so it uses callbacks rather than global wurl:* events — see the
 * "Component ↔ app communication" rule in CLAUDE.md):
 *   onChange({ data })                 — add / rename / delete / reorder
 *   onActivate({ id })                 — row selected (null = Global)
 *   onVarsSave({ id, variables })      — debounced 500ms auto-save
 *   onBulkEditorChange({ bulkEditor }) — bulk-textarea / KV-row toggle changed
 *                                        (currently unwired by app.js, matching
 *                                        the prior no-listener behavior)
 */

"use strict";

import { PopupManager } from "../popup-manager.js";
import { icon } from "../icons.js";
import { deepClone } from "../utils/clone.js";
import { wireDeleteConfirm } from "../delete-confirm.js";
import { normalizeVariables } from "./variable-shape.js";

// ── SVG icons ─────────────────────────────────────────────────────────────────

const ICON_CHECK = icon("check", { size: 13 });
const ICON_RENAME = icon("rename", { size: 13 });
const ICON_ADD = icon("add", { size: 15 });

// ── EnvironmentsPopup ─────────────────────────────────────────────────────────

export class EnvironmentsPopup {
  /** @type {HTMLElement} */
  #el;

  /** Full environments data — kept in sync with app.js via events */
  #data = {
    version: 1,
    globalVariables: [],
    activeEnvironmentId: null,
    environments: [],
  };

  /** ID currently shown in the variable editor (null = Global) */
  #selectedId = null;

  /** Which right-pane tab is showing: "vars" */
  #activeTab = "vars";

  // ── Inline name-edit state ─────────────────────────────────────────────────
  /**
   * null | { mode: "add" }
   *      | { mode: "rename", id: string, currentName: string }
   */
  #editState = null;
  /** @type {number|null} */
  #nameErrorTimer = null;
  /** Guards the inline input's blur-cancel while a commit is re-rendering. */
  #committing = false;

  // ── Variable-editor state ──────────────────────────────────────────────────
  #isBulkMode = true;
  /** @type {{ id:string, name:string, value:string, secure:boolean }[]} */
  #rows = [];

  // ── Environment-list drag state ────────────────────────────────────────────
  #envDragId = null;
  /** @type {HTMLElement} */
  #envPhantom;
  /** @type {number|null} */
  #saveTimer = null;

  static #SAVE_MS = 500;

  /** Auto re-mask a revealed secure value after this many ms. */
  static #REVEAL_MS = 30000;

  /** @type {boolean} */
  #removeHeaders = false;

  // ── Callbacks to the creator (app.js) ──────────────────────────────────────
  #onChange;
  #onActivate;
  #onVarsSave;
  #onBulkEditorChange;

  /**
   * @param {{
   *   onChange?: (payload: { data: object }) => void,
   *   onActivate?: (payload: { id: string | null }) => void,
   *   onVarsSave?: (payload: { id: string | null, variables: Array }) => void,
   *   onBulkEditorChange?: (payload: { bulkEditor: boolean }) => void,
   * }} [opts]
   */
  constructor({ onChange, onActivate, onVarsSave, onBulkEditorChange } = {}) {
    this.#onChange = onChange;
    this.#onActivate = onActivate;
    this.#onVarsSave = onVarsSave;
    this.#onBulkEditorChange = onBulkEditorChange;
    this.#el = this.#build();
    this.#envPhantom = this.#buildEnvPhantom();
    this.#initResize(this.#el);
  }

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
   * Open the popup seeded with the current environments data.
   * @param {object} data
   * @param {{ bulkEditor?: boolean }} [opts]
   */
  open(data, { bulkEditor = true } = {}) {
    this.#data = deepClone(data);
    this.#selectedId = data.activeEnvironmentId ?? null;
    this.#editState = null;
    this.#isBulkMode = bulkEditor;
    this.#el.querySelector(".env-bulk-toggle").checked = bulkEditor;

    clearTimeout(this.#saveTimer);

    this.#showPanel("vars");
    this.#renderList();
    this.#loadEditorForSelected();
    PopupManager.open(this);
    this.#applyRemoveHeaders();
  }

  /**
   * Refresh the list after a structural change (add/rename/delete).
   * Does NOT reload the variable editor — preserves in-progress edits.
   * @param {object} data
   */
  update(data) {
    const stillExists =
      this.#selectedId === null ||
      data.environments.some((e) => e.id === this.#selectedId);
    if (!stillExists) {
      this.#selectedId = null;
      this.#loadEditorForSelected();
    }
    this.#data = deepClone(data);
    this.#editState = null;
    this.#renderList();
  }

  /** Required by PopupManager. */
  onMaskClick() {
    this.#doClose();
  }

  #applyRemoveHeaders() {
    const hdr = this.#el.querySelector(".env-kv-header");
    if (hdr) hdr.style.display = this.#removeHeaders ? "none" : "";
  }

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
        <button class="popup-close" aria-label="Close environments" title="Close">${icon("close", { size: 13 })}</button>
      </div>
      <div class="popup-body env-popup-body">
        <div class="env-sidebar">
          <div class="env-sidebar-toolbar">
            <button class="icon-btn env-new-btn" title="Add environment" aria-label="Add environment">${ICON_ADD}</button>
          </div>
          <ul class="env-list" role="listbox" aria-label="Environments"></ul>
        </div>
        <div class="env-main">
          <div class="env-tabs" role="tablist" aria-label="Environment editor">
            <button class="env-tab is-active" role="tab" aria-selected="true"
                    data-panel="vars" type="button">Variables</button>
          </div>
          <div class="env-panels">
            <section class="env-panel env-panel--vars is-active"
                     data-panel="vars" role="tabpanel" aria-label="Variables">
              <div class="env-vars-toolbar">
                <label class="params-toolbar-toggle-label env-bulk-label"
                       title="Toggle between bulk text editor and key/value row editor">
                  <input type="checkbox" class="params-toolbar-toggle env-bulk-toggle" checked>
                  Bulk editor
                </label>
                <button class="icon-btn params-toolbar-btn env-add-btn" title="Add variable" aria-label="Add variable" style="display:none"><span class="icon">${icon("add", { size: 15 })}</span></button>
                <span class="env-vars-hint">One  name=value  per line · prefix  $  for secure</span>
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
                  <span>Name</span><span class="params-col-value">Value</span><span></span><span></span>
                </div>
                <div class="env-kv-list params-list" aria-label="Variables"></div>
              </div>
            </section>
          </div>
        </div>
      </div>
      <div class="popup-footer env-popup-footer">
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

    // Sidebar toolbar
    el.querySelector(".env-new-btn").addEventListener("click", () =>
      this.#startAdd(),
    );

    // Tabs
    el.querySelectorAll(".env-tab").forEach((tab) =>
      tab.addEventListener("click", () => this.#showPanel(tab.dataset.panel)),
    );

    // Variable editor controls
    el.querySelector(".env-bulk-toggle").addEventListener("change", () =>
      this.#handleBulkToggle(),
    );
    el.querySelector(".env-textarea").addEventListener("input", () =>
      this.#scheduleSave(),
    );
    el.querySelector(".env-add-btn").addEventListener("click", () =>
      this.#addRow(),
    );

    el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        this.#doClose();
      }
    });

    const envList = el.querySelector(".env-list");
    envList.addEventListener("dragover", (e) => {
      if (!this.#envDragId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const afterEl = this.#envDragTargetAfter(envList, e.clientY);
      if (afterEl == null) {
        envList.appendChild(this.#envPhantom);
      } else {
        envList.insertBefore(this.#envPhantom, afterEl);
      }
    });
    envList.addEventListener("drop", (e) => {
      e.preventDefault();
      if (!this.#envDragId) return;
      const children = [...envList.children];
      const phIdx = children.indexOf(this.#envPhantom);
      this.#envPhantom.remove();
      if (phIdx === -1) {
        this.#envDragId = null;
        return;
      }
      const envItems = children.filter((c) =>
        c.classList.contains("env-list-item"),
      );
      // Phantom position among env items (excluding Global which is always first)
      // envItems[0] is Global (non-draggable), named envs start at index 1
      const namedBefore = envItems
        .slice(1)
        .filter((r) => children.indexOf(r) < phIdx).length;
      const srcIdx = this.#data.environments.findIndex(
        (e) => e.id === this.#envDragId,
      );
      this.#envDragId = null;
      if (srcIdx === -1) return;
      const [moved] = this.#data.environments.splice(srcIdx, 1);
      this.#data.environments.splice(
        namedBefore > srcIdx ? namedBefore - 1 : namedBefore,
        0,
        moved,
      );
      this.#renderList();
      this.#onChange?.({ data: deepClone(this.#data) });
    });
    envList.addEventListener("dragleave", (e) => {
      if (!envList.contains(e.relatedTarget)) {
        this.#envPhantom.remove();
      }
    });

    return el;
  }

  // ── Tab switching ──────────────────────────────────────────────────────────

  #showPanel(name) {
    this.#activeTab = name;
    this.#el.querySelectorAll(".env-tab").forEach((tab) => {
      const active = tab.dataset.panel === name;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    this.#el.querySelectorAll(".env-panel").forEach((panel) => {
      const active = panel.dataset.panel === name;
      panel.classList.toggle("is-active", active);
      panel.hidden = !active;
    });
  }

  #envDragTargetAfter(envList, y) {
    const draggableItems = [
      ...envList.querySelectorAll(".env-list-item[draggable='true']"),
    ];
    return draggableItems.reduce(
      (closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) {
          return { offset, element: child };
        }
        return closest;
      },
      { offset: Number.NEGATIVE_INFINITY, element: null },
    ).element;
  }

  #buildEnvPhantom() {
    const ph = document.createElement("li");
    ph.className = "params-drop-phantom";
    return ph;
  }

  // ── Environment list ───────────────────────────────────────────────────────

  #renderList() {
    const ul = this.#el.querySelector(".env-list");
    ul.innerHTML = "";

    // Global row — always first, never has rename/delete/reorder
    ul.appendChild(
      this.#buildEnvRow({
        id: null,
        name: "GLOBAL",
        isActive: this.#data.activeEnvironmentId === null,
        isSelected: this.#selectedId === null,
        isGlobal: true,
      }),
    );

    const state = this.#editState;
    for (const env of this.#data.environments) {
      if (state?.mode === "rename" && state.id === env.id) {
        ul.appendChild(
          this.#buildEditingItem({
            placeholder: "Environment name…",
            defaultValue: env.name,
            active: env.id === this.#data.activeEnvironmentId,
          }),
        );
        continue;
      }
      ul.appendChild(
        this.#buildEnvRow({
          id: env.id,
          name: env.name,
          isActive: env.id === this.#data.activeEnvironmentId,
          isSelected: env.id === this.#selectedId,
          isGlobal: false,
        }),
      );
    }

    // Add appends a fresh inline-edited entry at the bottom, where the new
    // environment will naturally land. Escape removes it.
    if (state?.mode === "add") {
      const item = this.#buildEditingItem({
        placeholder: "New environment name…",
      });
      ul.appendChild(item);
      requestAnimationFrame(() => item.scrollIntoView({ block: "nearest" }));
    }
  }

  #buildEnvRow({ id, name, isActive, isSelected, isGlobal }) {
    const li = document.createElement("li");
    li.className =
      "env-list-item" +
      (isActive ? " env-list-item--active" : "") +
      (isSelected ? " env-list-item--selected" : "");
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", String(isActive));

    const check = document.createElement("span");
    check.className = "env-list-item__check";
    check.innerHTML = isActive ? ICON_CHECK : "";

    const nameBtn = document.createElement("button");
    nameBtn.className = "env-list-item__name";
    nameBtn.textContent = name;
    nameBtn.setAttribute(
      "aria-label",
      isGlobal ? "Select Global variables" : `Select ${name}`,
    );
    nameBtn.addEventListener("click", () => this.#selectEnv(id));

    if (!isGlobal) {
      li.draggable = true;

      const handle = document.createElement("span");
      handle.className = "params-drag-handle env-list-item__drag";
      handle.setAttribute("aria-hidden", "true");
      handle.title = "Drag to reorder";
      handle.innerHTML = icon("drag", { width: 10, height: 16 });
      li.appendChild(handle);

      li.addEventListener("dragstart", (e) => {
        this.#envDragId = id;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", id);
        requestAnimationFrame(() =>
          li.classList.add("env-list-item--dragging"),
        );
      });
      li.addEventListener("dragend", () => {
        li.classList.remove("env-list-item--dragging");
        this.#envPhantom.remove();
        this.#envDragId = null;
      });
    }

    li.appendChild(check);
    li.appendChild(nameBtn);

    if (!isGlobal) {
      const actions = document.createElement("div");
      actions.className = "env-list-item__actions";

      const renameBtn = document.createElement("button");
      renameBtn.className = "coll-action-btn";
      renameBtn.title = "Rename environment";
      renameBtn.innerHTML = ICON_RENAME;
      renameBtn.setAttribute("aria-label", `Rename ${name}`);
      renameBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.#startRename({ id, name });
      });

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "coll-action-btn coll-action-btn--danger";
      deleteBtn.title = "Delete environment";
      deleteBtn.innerHTML = icon("trash", { size: 13 });
      deleteBtn.setAttribute("aria-label", `Delete ${name}`);
      deleteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.#confirmDelete({ id, name });
      });

      actions.appendChild(renameBtn);
      actions.appendChild(deleteBtn);
      li.appendChild(actions);
    }

    return li;
  }

  // ── Inline name editing ──────────────────────────────────────────────────────

  #buildEditingItem({ placeholder, defaultValue = "", active = false }) {
    const li = document.createElement("li");
    li.className =
      "env-list-item env-list-item--editing" +
      (active ? " env-list-item--active" : "");

    const check = document.createElement("span");
    check.className = "env-list-item__check";
    check.innerHTML = active ? ICON_CHECK : "";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "env-name-input env-inline-input";
    input.placeholder = placeholder;
    input.value = defaultValue;
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("aria-label", "Environment name");

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.#commitInline(input);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.#cancelInlineEdit();
      }
    });
    input.addEventListener("blur", () => {
      // Defer so a successful Enter commit (which re-renders) wins the race.
      setTimeout(() => {
        if (this.#editState && !this.#committing) this.#cancelInlineEdit();
      }, 120);
    });

    li.appendChild(check);
    li.appendChild(input);

    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });

    return li;
  }

  #startAdd() {
    this.#editState = { mode: "add" };
    this.#renderList();
  }

  #startRename(env) {
    this.#editState = {
      mode: "rename",
      id: env.id,
      currentName: env.name,
    };
    this.#renderList();
  }

  #cancelInlineEdit() {
    clearTimeout(this.#nameErrorTimer);
    this.#nameErrorTimer = null;
    this.#editState = null;
    this.#renderList();
  }

  #flagNameError(input) {
    input.classList.add("env-name-input--error");
    input.title = "An environment with this name already exists.";
    clearTimeout(this.#nameErrorTimer);
    this.#nameErrorTimer = setTimeout(() => {
      input.classList.remove("env-name-input--error");
      input.title = "";
      this.#nameErrorTimer = null;
    }, 1500);
  }

  #commitInline(input) {
    const name = input.value.trim().toUpperCase();
    const action = this.#editState;
    if (!action) return;

    if (!name) {
      this.#cancelInlineEdit();
      return;
    }

    if (action.mode === "rename" && name === action.currentName) {
      this.#cancelInlineEdit();
      return;
    }

    const isDuplicate = this.#data.environments.some((e) => {
      if (action.mode === "rename" && e.id === action.id) return false;
      return e.name.toLowerCase() === name.toLowerCase();
    });
    if (isDuplicate) {
      this.#flagNameError(input);
      return;
    }

    // Re-render is about to remove the input; suppress the blur-cancel it fires.
    this.#committing = true;
    this.#editState = null;
    clearTimeout(this.#nameErrorTimer);
    this.#nameErrorTimer = null;

    if (action.mode === "add") {
      const id = crypto.randomUUID();
      const newEnv = { id, name, variables: [] };
      const newData = {
        ...this.#data,
        environments: [...this.#data.environments, newEnv],
        activeEnvironmentId: id,
      };
      this.#data = newData;
      this.#selectedId = id;
      this.#renderList();
      this.#loadEditorForSelected();
      this.#onChange?.({ data: deepClone(newData) });
    } else if (action.mode === "rename") {
      const newData = {
        ...this.#data,
        environments: this.#data.environments.map((e) =>
          e.id === action.id ? { ...e, name } : e,
        ),
      };
      this.#data = newData;
      this.#renderList();
      this.#loadEditorForSelected();
      this.#onChange?.({ data: deepClone(newData) });
    }

    this.#committing = false;
  }

  // ── Environment selection & deletion ───────────────────────────────────────

  #selectEnv(id) {
    if (id === this.#selectedId) return;
    this.#flushEditorSave();
    this.#editState = null;
    this.#selectedId = id;
    this.#data = { ...this.#data, activeEnvironmentId: id };
    this.#renderList();
    this.#loadEditorForSelected();
    this.#onActivate?.({ id });
  }

  #confirmDelete(env) {
    PopupManager.confirmDelete({
      title: "Delete Environment?",
      message: `Delete the environment "${env.name}" and all its variables?`,
      onConfirm: () => this.#deleteEnvironment(env),
    });
  }

  #deleteEnvironment(env) {
    const wasSelected = this.#selectedId === env.id;
    const wasActive = this.#data.activeEnvironmentId === env.id;
    const newData = {
      ...this.#data,
      environments: this.#data.environments.filter((e) => e.id !== env.id),
      activeEnvironmentId: wasActive ? null : this.#data.activeEnvironmentId,
    };
    this.#data = newData;
    if (wasSelected) {
      this.#selectedId = null;
      this.#loadEditorForSelected();
    }
    this.#renderList();
    this.#onChange?.({ data: deepClone(newData) });
  }

  // ── Variable editor ────────────────────────────────────────────────────────

  #loadEditorForSelected() {
    const vars = normalizeVariables(this.#getSelectedVars());

    clearTimeout(this.#saveTimer);

    if (this.#isBulkMode) {
      this.#el.querySelector(".env-textarea").value = this.#varsToText(vars);
    } else {
      this.#rows = this.#varsToRows(vars);
      this.#renderRows();
    }
    this.#applyMode();
  }

  #getSelectedVars() {
    if (this.#selectedId === null) return this.#data.globalVariables ?? [];
    return (
      this.#data.environments.find((e) => e.id === this.#selectedId)
        ?.variables ?? []
    );
  }

  // ── Mode switching ─────────────────────────────────────────────────────────

  #applyMode() {
    const bulk = this.#isBulkMode;
    const textarea = this.#el.querySelector(".env-textarea");
    const kvWrap = this.#el.querySelector(".env-kv-wrap");
    const hintEl = this.#el.querySelector(".env-vars-hint");
    const addBtn = this.#el.querySelector(".env-add-btn");
    textarea.style.display = bulk ? "" : "none";
    kvWrap.style.display = bulk ? "none" : "";
    if (hintEl) hintEl.style.display = bulk ? "" : "none";
    if (addBtn) addBtn.style.display = bulk ? "none" : "";
  }

  #handleBulkToggle() {
    const nowBulk = this.#el.querySelector(".env-bulk-toggle").checked;
    if (nowBulk && !this.#isBulkMode) {
      this.#el.querySelector(".env-textarea").value = this.#varsToText(
        this.#rowsToArray(),
      );
    } else if (!nowBulk && this.#isBulkMode) {
      this.#rows = this.#varsToRows(
        this.#textToVars(this.#el.querySelector(".env-textarea").value),
      );
    }
    this.#isBulkMode = nowBulk;
    this.#applyMode();
    if (nowBulk) {
      requestAnimationFrame(() =>
        this.#el.querySelector(".env-textarea").focus(),
      );
    } else {
      this.#renderRows();
      this.#saveFromRows();
    }
    this.#onBulkEditorChange?.({ bulkEditor: nowBulk });
  }

  // ── Conversion helpers ─────────────────────────────────────────────────────

  // Secure variables round-trip through the bulk editor as a "$ "
  // (dollar + space) line prefix.
  #varsToText(vars) {
    return vars
      .map((v) => `${v.secure ? "$ " : ""}${v.name}=${v.value}`)
      .join("\n");
  }

  #textToVars(text) {
    const out = [];
    for (const line of text.split("\n")) {
      let trimmed = line.trim();
      if (!trimmed) continue;
      let secure = false;
      if (trimmed.startsWith("$ ")) {
        secure = true;
        trimmed = trimmed.slice(1).trim();
      }
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1);
      if (key) out.push({ name: key, value: val, secure });
    }
    return out;
  }

  #varsToRows(vars) {
    return vars.map((v) => ({
      id: crypto.randomUUID(),
      name: v.name,
      value: v.value,
      secure: !!v.secure,
    }));
  }

  #rowsToArray() {
    const out = [];
    for (const r of this.#rows) {
      if (r.name.trim()) {
        out.push({ name: r.name, value: r.value, secure: !!r.secure });
      }
    }
    return out;
  }

  // ── KV row rendering ───────────────────────────────────────────────────────

  #renderRows() {
    const kvList = this.#el.querySelector(".env-kv-list");
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
    el.className = "env-kv-row params-row";
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

    const valWrap = document.createElement("div");
    valWrap.className = "params-value-wrap";

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

    // Inline reveal (eye) toggle — only shown for secure rows.
    const reveal = document.createElement("button");
    reveal.type = "button";
    reveal.className = "icon-btn params-reveal-btn";
    reveal.setAttribute("tabindex", "-1");

    let revealed = false;
    let revealTimer = null;
    const applyMask = () => {
      const masked = !!row.secure && !revealed;
      valIn.classList.toggle("params-value--masked", masked);
      reveal.style.display = row.secure ? "" : "none";
      reveal.innerHTML = icon(revealed ? "eyeOff" : "eye", { size: 14 });
      const action = revealed ? "Hide value" : "Reveal value";
      reveal.title = action;
      reveal.setAttribute("aria-label", action);
      reveal.setAttribute("aria-pressed", String(revealed));
    };
    reveal.addEventListener("click", () => {
      revealed = !revealed;
      clearTimeout(revealTimer);
      if (revealed) {
        revealTimer = setTimeout(() => {
          revealed = false;
          applyMask();
        }, EnvironmentsPopup.#REVEAL_MS);
      }
      applyMask();
    });

    valWrap.appendChild(valIn);
    valWrap.appendChild(reveal);

    // Per-row secure (lock) toggle — encrypts the value at rest.
    const secure = document.createElement("button");
    secure.type = "button";
    secure.className = "icon-btn params-secure-btn";
    const applySecure = () => {
      secure.classList.toggle("is-active", !!row.secure);
      secure.innerHTML = icon(row.secure ? "lock" : "lockOpen", { size: 14 });
      const label = row.secure
        ? "Secure (encrypted at rest)"
        : "Mark variable secure";
      secure.title = label;
      secure.setAttribute("aria-label", label);
      secure.setAttribute("aria-pressed", String(!!row.secure));
    };
    secure.addEventListener("click", () => {
      row.secure = !row.secure;
      if (!row.secure) {
        revealed = false;
        clearTimeout(revealTimer);
      }
      applySecure();
      applyMask();
      this.#saveFromRows();
    });

    const del = document.createElement("button");
    del.className = "icon-btn params-delete-btn";
    del.title = "Delete variable";
    del.setAttribute("aria-label", "Delete variable");
    wireDeleteConfirm(del, () => {
      this.#rows = this.#rows.filter((r) => r.id !== row.id);
      this.#renderRows();
      this.#saveFromRows();
    });

    el.appendChild(nameIn);
    el.appendChild(valWrap);
    el.appendChild(secure);
    el.appendChild(del);

    applySecure();
    applyMask();
    return el;
  }

  #addRow() {
    const row = { id: crypto.randomUUID(), name: "", value: "", secure: false };
    this.#rows.push(row);
    this.#renderRows();
    const rows = this.#el
      .querySelector(".env-kv-list")
      .querySelectorAll(".env-kv-row");
    if (rows.length)
      rows[rows.length - 1].querySelector(".params-name")?.focus();
  }

  // ── Save ───────────────────────────────────────────────────────────────────

  #scheduleSave() {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(
      () => this.#saveFromBulk(),
      EnvironmentsPopup.#SAVE_MS,
    );
  }

  #saveFromBulk() {
    this.#dispatchVarsSave(
      this.#textToVars(this.#el.querySelector(".env-textarea").value),
    );
  }

  #saveFromRows() {
    this.#dispatchVarsSave(this.#rowsToArray());
  }

  #flushEditorSave() {
    clearTimeout(this.#saveTimer);
    if (this.#isBulkMode) this.#saveFromBulk();
    else this.#saveFromRows();
  }

  #dispatchVarsSave(variables) {
    if (this.#selectedId === null) {
      this.#data = { ...this.#data, globalVariables: variables };
    } else {
      this.#data = {
        ...this.#data,
        environments: this.#data.environments.map((e) =>
          e.id === this.#selectedId ? { ...e, variables } : e,
        ),
      };
    }
    this.#onVarsSave?.({ id: this.#selectedId, variables });
  }

  // ── Close ──────────────────────────────────────────────────────────────────

  #doClose() {
    this.#flushEditorSave();
    PopupManager.close();
  }

  // ── Resize ─────────────────────────────────────────────────────────────────

  #initResize(el) {
    const handle = document.createElement("div");
    handle.className = "popup-resize-handle";
    handle.setAttribute("aria-hidden", "true");
    handle.innerHTML = icon("resizeGrip", { size: 14 });
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
}
