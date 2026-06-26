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
 * collections-popup.js — collections manager (settings-style two-pane layout)
 *
 * Left pane:  a sidebar listing every collection. A toolbar at the top holds an
 *             add ([+]) button and an export-all button (the same workspace
 *             export as the File ▸ "Export All Collections…" menu item). Each row
 *             shows the collection name plus rename / delete actions, and the
 *             active collection is marked with a checkmark. Rename and add both
 *             edit the name inline (Enter confirms, Escape cancels).
 *
 * Right pane: a tabbed panel for the selected collection:
 *             • Variables — the inline key/value editor (bulk-textarea / KV-row
 *               toggle), functioning exactly as before.
 *             • Headers    — default headers merged into every request in the
 *               collection (the exact request Headers editor, via HeadersEditor),
 *               overridable per-request by a same-named header.
 *             • Cookies    — the per-collection cookie-jar viewer/editor. Reads
 *               come straight from `window.hippo.store.cookies.*`; writes route
 *               through data-store so a save failure surfaces an error toast.
 *
 * Clicking a collection row both activates it (for tree-view data) and loads its
 * variables / headers / cookies into the right pane.
 *
 * Constructor callbacks (this is a parent-owned popup that reports back to its
 * creator, so it uses callbacks rather than global hippo:* events — see the
 * "Component ↔ app communication" rule in CLAUDE.md):
 *   onSelect({ id })                   — switch active collection
 *   onAdd({ name })                    — create new empty collection
 *   onRename({ id, name })             — rename a collection
 *   onDelete({ id })                   — delete a collection
 *   onSendCookiesChange({ id, sendCookies }) — toggle the cookie-jar attach flag
 *   onVarsSave({ scopeId, variables })   — debounced 500ms auto-save
 *   onHeadersSave({ scopeId, headers })  — debounced 500ms default-header save
 *   onBulkEditorChange({ bulkEditor }) — bulk-textarea / KV-row toggle changed
 *   onExportAll()                      — export every collection to one file
 *
 * The cookie jar is owned by the main process, so no cookie callbacks fire for
 * jar reads/writes — the Cookies tab re-reads from IPC whenever it opens or
 * mutates.
 */

"use strict";

import { PopupManager } from "../popup-manager.js";
import { icon } from "../icons.js";
import { escapeHtml } from "../utils/html.js";
import { t, formatDate } from "../i18n.js";
import { wireDeleteConfirm } from "../delete-confirm.js";
import { normalizeVariables } from "./variable-shape.js";
import {
  variablesToText,
  textToVariables,
  variablesToRows,
  rowsToVariables,
  buildVariableRow,
} from "./variable-editor-shared.js";
import { HeadersEditor } from "./headers-editor.js";
import { upsertCookie, deleteCookie, clearCookies } from "../data-store.js";

// ── SVG icons ─────────────────────────────────────────────────────────────────

const ICON_CHECK = icon("check", { size: 13 });
const ICON_RENAME = icon("rename", { size: 13 });
const ICON_ADD = icon("add", { size: 15 });
const ICON_EXPORT = icon("download", { size: 15 });
// Cookie edit reuses the rename pencil so the two managers stay visually consistent.
const ICON_EDIT = ICON_RENAME;

const SAME_SITE_OPTIONS = ["", "Strict", "Lax", "None"];

// ── CollectionsPopup class ────────────────────────────────────────────────────

export class CollectionsPopup {
  /** @type {HTMLElement} */
  #el;

  /** @type {{id: string, name: string, variables?: {name:string,value:string,secure:boolean}[], headers?: {id:string,name:string,value:string,enabled:boolean}[]}[]} */
  #collections = [];

  /** @type {string|null} */
  #activeId = null;

  /** ID currently shown in the right pane */
  #selectedId = null;

  /** Which right-pane tab is showing: "vars" | "headers" | "cookies" */
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
  /** @type {number|null} */
  #saveTimer = null;

  static #SAVE_MS = 500;

  /** Auto re-mask a revealed secure value after this many ms. */
  static #REVEAL_MS = 30000;

  /** @type {boolean} */
  #removeHeaders = false;

  // ── Headers-tab state (collection-level default HTTP headers) ──────────────
  // NB: distinct from #removeHeaders above (the "show column headers" appearance
  // toggle) — these hold the embedded request-style Headers editor + its saves.
  /** @type {HeadersEditor|null} */
  #httpHeadersEditor = null;
  /** Variable context handed to the header value pills for {{var}} validation. */
  #headerContext = null;
  /** @type {number|null} Debounce handle for persisting edited headers. */
  #headersSaveTimer = null;
  /** Captured (scopeId, headers) awaiting the debounced persist. */
  #pendingHeaders = null;
  #pendingHeadersScope = null;

  // ── Cookie-tab state ───────────────────────────────────────────────────────
  /** @type {object[]} Live jar entries last loaded from the main process. */
  #cookies = [];
  /**
   * Identity of the cookie row in edit mode, or null. Stored as the original
   * {name, domain, path} so a save that changes identity can remove the old key.
   * @type {{name:string,domain:string,path:string}|null}
   */
  #editingCookieIdent = null;
  /** True while a blank "new cookie" editor row is shown at the top of the list. */
  #addingCookie = false;

  // ── Callbacks to the creator (app.js) ──────────────────────────────────────
  #onSelect;
  #onAdd;
  #onRename;
  #onDelete;
  #onSendCookiesChange;
  #onVarsSave;
  #onHeadersSave;
  #onBulkEditorChange;
  #onExportAll;

  /**
   * @param {{
   *   onSelect?: (payload: { id: string }) => void,
   *   onAdd?: (payload: { name: string }) => void,
   *   onRename?: (payload: { id: string, name: string }) => void,
   *   onDelete?: (payload: { id: string }) => void,
   *   onSendCookiesChange?: (payload: { id: string, sendCookies: boolean }) => void,
   *   onVarsSave?: (payload: { scopeId: string, variables: Array }) => void,
   *   onHeadersSave?: (payload: { scopeId: string, headers: Array }) => void,
   *   onBulkEditorChange?: (payload: { bulkEditor: boolean }) => void,
   *   onExportAll?: () => void,
   * }} [opts]
   */
  constructor({
    onSelect,
    onAdd,
    onRename,
    onDelete,
    onSendCookiesChange,
    onVarsSave,
    onHeadersSave,
    onBulkEditorChange,
    onExportAll,
  } = {}) {
    this.#onSelect = onSelect;
    this.#onAdd = onAdd;
    this.#onRename = onRename;
    this.#onDelete = onDelete;
    this.#onSendCookiesChange = onSendCookiesChange;
    this.#onVarsSave = onVarsSave;
    this.#onHeadersSave = onHeadersSave;
    this.#onBulkEditorChange = onBulkEditorChange;
    this.#onExportAll = onExportAll;
    this.#el = this.#build();
    // Mount the embedded request-style Headers editor into its tab panel.
    this.#httpHeadersEditor = new HeadersEditor({
      getContext: () => this.#headerContext,
      onChange: (rows) => this.#dispatchHeadersSave(rows),
    });
    this.#el
      .querySelector(".coll-headers-mount")
      .appendChild(this.#httpHeadersEditor.element);
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
      this.#httpHeadersEditor?.applySettings({
        removeHeaders: this.#removeHeaders,
      });
    }
  }

  /**
   * Open the popup seeded with the current app state.
   * @param {{ collections: object[], activeCollectionId: string, bulkEditor?: boolean, variableContext?: object }} state
   */
  open({
    collections,
    activeCollectionId,
    bulkEditor = true,
    variableContext,
  }) {
    this.#collections = collections.map((e) => ({ ...e }));
    this.#activeId = activeCollectionId;
    this.#selectedId = activeCollectionId;
    this.#editState = null;
    this.#isBulkMode = bulkEditor;
    this.#el.querySelector(".coll-bulk-toggle").checked = bulkEditor;

    clearTimeout(this.#saveTimer);

    this.#editingCookieIdent = null;
    this.#addingCookie = false;
    this.#cookies = [];

    this.setVariableContext(variableContext);
    this.#renderList();
    this.#loadEditorForSelected();
    this.#showPanel("vars");
    PopupManager.open(this);
    this.#applyRemoveHeaders();
  }

  /**
   * Refresh the list without closing the popup.
   * Called by app.js after any collection mutation.
   * @param {{ collections: object[], activeCollectionId: string, bulkEditor?: boolean, variableContext?: object }} state
   */
  update({ collections, activeCollectionId, variableContext }) {
    const activeChanged = activeCollectionId !== this.#activeId;
    if (variableContext !== undefined) this.setVariableContext(variableContext);
    this.#collections = collections.map((e) => ({ ...e }));
    this.#activeId = activeCollectionId;
    this.#editState = null;
    this.#renderList();

    // If the selected collection was deleted, fall back to active
    const selectedExists = this.#collections.some(
      (c) => c.id === this.#selectedId,
    );
    if (!selectedExists) {
      this.#selectedId = activeCollectionId;
      this.#editingCookieIdent = null;
      this.#addingCookie = false;
      this.#loadEditorForSelected();
      if (this.#activeTab === "cookies") this.#reloadCookies();
      return;
    }

    // After a collection switch, reload with freshly-loaded variables
    if (activeChanged && this.#selectedId === activeCollectionId) {
      this.#loadEditorForSelected();
      if (this.#activeTab === "cookies") this.#reloadCookies();
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
    el.setAttribute("aria-label", t("collections.title"));

    el.innerHTML = `
      <div class="popup-header">
        <span class="popup-title">${t("collections.title")}</span>
        <button class="popup-close" aria-label="${t("collections.closeAria")}" title="${t("common.close")}">${icon("close", { size: 13 })}</button>
      </div>
      <div class="popup-body coll-popup-body">
        <div class="coll-sidebar">
          <div class="coll-sidebar-toolbar">
            <button class="icon-btn coll-new-btn" title="${t("collections.addCollection")}" aria-label="${t("collections.addCollection")}">${ICON_ADD}</button>
            <button class="icon-btn coll-export-all-btn" title="${t("collections.exportAll")}" aria-label="${t("collections.exportAll")}">${ICON_EXPORT}</button>
          </div>
          <ul class="coll-list" role="listbox" aria-label="${t("collections.title")}"></ul>
        </div>
        <div class="coll-main">
          <div class="coll-tabs" role="tablist" aria-label="${t("collections.editorAria")}">
            <button class="coll-tab coll-tab--active" role="tab" aria-selected="true"
                    data-panel="vars" type="button">${t("common.variables")}</button>
            <button class="coll-tab" role="tab" aria-selected="false"
                    data-panel="headers" type="button"
                    title="${t("collections.headersTooltip")}">${t("common.headers")}</button>
            <button class="coll-tab" role="tab" aria-selected="false"
                    data-panel="cookies" type="button">${t("collections.tabCookies")}</button>
          </div>
          <div class="coll-panels">
            <section class="coll-panel coll-panel--vars"
                     data-panel="vars" role="tabpanel" aria-label="${t("common.variables")}">
              <div class="coll-vars-toolbar">
                <label class="params-toolbar-toggle-label coll-bulk-label"
                       title="${t("kv.bulkEditorTitle")}">
                  <input type="checkbox" class="params-toolbar-toggle coll-bulk-toggle" checked>
                  ${t("kv.bulkEditor")}
                </label>
                <button class="icon-btn params-toolbar-btn coll-add-btn" title="${t("vars.add")}" aria-label="${t("vars.add")}" style="display:none"><span class="icon">${icon("add", { size: 15 })}</span></button>
                <span class="coll-vars-hint">${t("kv.varsHint")}</span>
              </div>
              <textarea
                class="body-text-editor coll-textarea"
                spellcheck="false"
                autocomplete="off"
                wrap="off"
                placeholder="${t("vars.bulkPlaceholder")}"
                aria-label="${t("vars.editorAria")}"
              ></textarea>
              <div class="coll-kv-wrap" style="display:none">
                <div class="coll-kv-header params-header-row">
                  <span>${t("kv.name")}</span><span class="params-col-value">${t("kv.value")}</span><span></span><span></span>
                </div>
                <div class="coll-kv-list params-list" aria-label="${t("common.variables")}"></div>
              </div>
            </section>
            <section class="coll-panel coll-panel--headers"
                     data-panel="headers" role="tabpanel" aria-label="${t("common.headers")}" hidden>
              <div class="coll-headers-mount"></div>
            </section>
            <section class="coll-panel coll-panel--cookies"
                     data-panel="cookies" role="tabpanel" aria-label="${t("collections.tabCookies")}" hidden>
              <div class="coll-cookies-toolbar">
                <label class="params-toolbar-toggle-label cookies-send-label"
                       title="${t("collections.cookie.attach")}">
                  <input type="checkbox" class="params-toolbar-toggle cookies-send-toggle">
                  ${t("collections.cookie.send")}
                </label>
                <button class="icon-btn cookies-add-btn" title="${t("collections.cookie.add")}" aria-label="${t("collections.cookie.add")}">${ICON_ADD}</button>
                <button class="cookies-clear-btn"
                        title="${t("collections.cookie.clearTitle")}"
                        aria-label="${t("collections.cookie.clearAria")}" type="button">${t("kv.deleteAll")}</button>
              </div>
              <ul class="cookies-list" aria-label="${t("collections.cookie.stored")}"></ul>
            </section>
          </div>
        </div>
      </div>
      <div class="popup-footer coll-popup-footer">
        <button class="btn popup-btn btn--primary js-close">${t("common.close")}</button>
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
    el.querySelector(".coll-new-btn").addEventListener("click", () =>
      this.#startAdd(),
    );
    // Export-all hands off to the creator, which routes it to the same workspace
    // export flow as the File ▸ "Export All Collections…" menu item.
    el.querySelector(".coll-export-all-btn").addEventListener("click", () =>
      this.#onExportAll?.(),
    );

    // Tabs
    el.querySelectorAll(".coll-tab").forEach((tab) =>
      tab.addEventListener("click", () => this.#showPanel(tab.dataset.panel)),
    );

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

    // Cookies controls
    el.querySelector(".cookies-add-btn").addEventListener("click", () =>
      this.#startAddCookie(),
    );
    el.querySelector(".cookies-clear-btn").addEventListener("click", () =>
      this.#confirmClearCookies(),
    );
    el.querySelector(".cookies-send-toggle").addEventListener("change", (e) =>
      this.#handleSendCookiesToggle(e.target.checked),
    );

    // Arrow-key navigation between the option buttons in the role="listbox"
    // collection list. Additive on top of native Tab; see #handleListNav.
    el.querySelector(".coll-list")?.addEventListener("keydown", (e) =>
      this.#handleListNav(e, [...el.querySelectorAll(".coll-list-item-name")]),
    );

    el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        this.#doClose();
      }
    });

    return el;
  }

  /**
   * Move focus between listbox option buttons with Up/Down/Home/End. No-ops
   * unless focus is on an option button, so arrow keys inside an inline rename/
   * add input keep their native text-cursor behaviour.
   * @param {KeyboardEvent}       e
   * @param {HTMLButtonElement[]} items  the option buttons, in display order
   */
  #handleListNav(e, items) {
    const i = items.indexOf(e.target);
    if (i === -1) return;
    let next;
    switch (e.key) {
      case "ArrowDown":
        next = items[i + 1] ?? items[i];
        break;
      case "ArrowUp":
        next = items[i - 1] ?? items[i];
        break;
      case "Home":
        next = items[0];
        break;
      case "End":
        next = items[items.length - 1];
        break;
      default:
        return;
    }
    e.preventDefault();
    next?.focus();
  }

  // ── Tab switching ──────────────────────────────────────────────────────────

  #showPanel(name) {
    this.#activeTab = name;
    this.#el.querySelectorAll(".coll-tab").forEach((tab) => {
      const active = tab.dataset.panel === name;
      tab.classList.toggle("coll-tab--active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    this.#el.querySelectorAll(".coll-panel").forEach((panel) => {
      const active = panel.dataset.panel === name;
      panel.hidden = !active;
    });
    if (name === "cookies") this.#reloadCookies();
  }

  // ── List rendering ─────────────────────────────────────────────────────────

  #renderList() {
    const ul = this.#el.querySelector(".coll-list");
    ul.innerHTML = "";
    const count = this.#collections.length;
    const state = this.#editState;

    this.#collections.forEach((collection) => {
      if (state?.mode === "rename" && state.id === collection.id) {
        ul.appendChild(
          this.#buildEditingItem({
            placeholder: t("collections.namePlaceholder"),
            defaultValue: collection.name,
            active: collection.id === this.#activeId,
          }),
        );
        return;
      }
      ul.appendChild(this.#buildListItem(collection, count));
    });

    // Add appends a new inline-edited entry at the bottom of the list, where the
    // created collection will naturally land. Escape removes it.
    if (state?.mode === "add") {
      const item = this.#buildEditingItem({
        placeholder: t("collections.renamePlaceholder"),
      });
      ul.appendChild(item);
      // Bring the freshly-added row into view when the list overflows.
      requestAnimationFrame(() => item.scrollIntoView({ block: "nearest" }));
    }
  }

  #buildListItem(collection, count) {
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
    check.className = "coll-list-item-check";
    check.innerHTML = isActive ? ICON_CHECK : "";

    const nameBtn = document.createElement("button");
    nameBtn.className = "coll-list-item-name";
    nameBtn.textContent = collection.name;
    nameBtn.setAttribute(
      "aria-label",
      t("common.selectItem", { name: collection.name }),
    );
    nameBtn.addEventListener("click", () => this.#selectColl(collection.id));

    const actions = document.createElement("div");
    actions.className = "coll-list-item-actions";

    const renameBtn = document.createElement("button");
    renameBtn.className = "coll-action-btn";
    renameBtn.title = t("collections.rename");
    renameBtn.innerHTML = ICON_RENAME;
    renameBtn.setAttribute(
      "aria-label",
      t("common.renameItem", { name: collection.name }),
    );
    renameBtn.addEventListener("click", () => this.#startRename(collection));

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "coll-action-btn coll-action-btn--danger";
    deleteBtn.title =
      count <= 1
        ? t("collections.cannotDeleteOnly")
        : t("collections.deleteCollection");
    deleteBtn.disabled = count <= 1;
    deleteBtn.innerHTML = icon("trash", { size: 13 });
    deleteBtn.setAttribute(
      "aria-label",
      t("common.deleteItem", { name: collection.name }),
    );
    deleteBtn.addEventListener("click", () => this.#confirmDelete(collection));

    actions.appendChild(renameBtn);
    actions.appendChild(deleteBtn);

    li.appendChild(check);
    li.appendChild(nameBtn);
    li.appendChild(actions);
    return li;
  }

  // ── Inline name editing ──────────────────────────────────────────────────────

  #buildEditingItem({ placeholder, defaultValue = "", active = false }) {
    const li = document.createElement("li");
    li.className =
      "coll-list-item coll-list-item--editing" +
      (active ? " coll-list-item--active" : "");

    const check = document.createElement("span");
    check.className = "coll-list-item-check";
    check.innerHTML = active ? ICON_CHECK : "";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "coll-name-input coll-inline-input";
    input.placeholder = placeholder;
    input.value = defaultValue;
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("aria-label", t("collections.nameAria"));

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

  #startRename(coll) {
    this.#editState = {
      mode: "rename",
      id: coll.id,
      currentName: coll.name,
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
    input.classList.add("coll-name-input--error");
    input.title = t("collections.nameExists");
    clearTimeout(this.#nameErrorTimer);
    this.#nameErrorTimer = setTimeout(() => {
      input.classList.remove("coll-name-input--error");
      input.title = "";
      this.#nameErrorTimer = null;
    }, 1500);
  }

  #commitInline(input) {
    const name = input.value.trim();
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

    const isDuplicate = this.#collections.some((e) => {
      if (action.mode === "rename" && e.id === action.id) return false;
      return e.name.toLowerCase() === name.toLowerCase();
    });
    if (isDuplicate) {
      this.#flagNameError(input);
      return;
    }

    // Re-render about to remove the input; suppress the blur-cancel it triggers.
    this.#committing = true;
    this.#editState = null;
    clearTimeout(this.#nameErrorTimer);
    this.#nameErrorTimer = null;

    if (action.mode === "add") {
      this.#flushEditorSave();
      this.#onAdd?.({ name });
    } else if (action.mode === "rename") {
      this.#onRename?.({ id: action.id, name });
    }

    this.#renderList();
    this.#committing = false;
  }

  // ── Collection selection & deletion ───────────────────────────────────────

  #selectColl(id) {
    if (id === this.#selectedId) return;
    this.#flushEditorSave();
    this.#editState = null;
    this.#selectedId = id;
    this.#editingCookieIdent = null;
    this.#addingCookie = false;
    this.#renderList();
    this.#loadEditorForSelected();
    if (this.#activeTab === "cookies") this.#reloadCookies();
    if (id !== this.#activeId) {
      this.#onSelect?.({ id });
    }
  }

  #confirmDelete(coll) {
    PopupManager.confirmDelete({
      title: t("collections.delete.title"),
      message: t("collections.delete.message", { name: coll.name }),
      onConfirm: () => this.#deleteCollection(coll),
    });
  }

  #deleteCollection(coll) {
    this.#onDelete?.({ id: coll.id });
  }

  // ── Variable editor ────────────────────────────────────────────────────────

  #loadEditorForSelected() {
    const vars = normalizeVariables(this.#getSelectedVars());

    clearTimeout(this.#saveTimer);

    if (this.#isBulkMode) {
      this.#el.querySelector(".coll-textarea").value = variablesToText(vars);
    } else {
      this.#rows = variablesToRows(vars);
      this.#renderRows();
    }
    this.#applyMode();

    // Load the selected collection's default headers (does not fire onChange).
    this.#httpHeadersEditor?.setHeaders(this.#getSelectedHeaders());
  }

  #getSelectedVars() {
    return (
      this.#collections.find((c) => c.id === this.#selectedId)?.variables ?? []
    );
  }

  #getSelectedHeaders() {
    return (
      this.#collections.find((c) => c.id === this.#selectedId)?.headers ?? []
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
      this.#el.querySelector(".coll-textarea").value = variablesToText(
        rowsToVariables(this.#rows),
      );
    } else if (!nowBulk && this.#isBulkMode) {
      this.#rows = variablesToRows(
        textToVariables(this.#el.querySelector(".coll-textarea").value),
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
    this.#onBulkEditorChange?.({ bulkEditor: nowBulk });
  }

  // ── KV row rendering ───────────────────────────────────────────────────────

  #renderRows() {
    const kvList = this.#el.querySelector(".coll-kv-list");
    kvList.innerHTML = "";
    if (this.#rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "params-empty";
      empty.textContent = t("collections.variablesEmpty");
      kvList.appendChild(empty);
      return;
    }
    this.#rows.forEach((row) =>
      kvList.appendChild(
        buildVariableRow({
          row,
          rowClass: "coll-kv-row params-row",
          revealMs: CollectionsPopup.#REVEAL_MS,
          onChange: () => this.#saveFromRows(),
          onEnter: () => this.#addRow(),
          onDelete: () => {
            this.#rows = this.#rows.filter((r) => r.id !== row.id);
            this.#renderRows();
            this.#saveFromRows();
          },
        }),
      ),
    );
  }

  #addRow() {
    const row = { id: crypto.randomUUID(), name: "", value: "", secure: false };
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
      textToVariables(this.#el.querySelector(".coll-textarea").value),
    );
  }

  #saveFromRows() {
    this.#dispatchVarsSave(rowsToVariables(this.#rows));
  }

  #flushEditorSave() {
    clearTimeout(this.#saveTimer);
    if (this.#isBulkMode) this.#saveFromBulk();
    else this.#saveFromRows();
    this.#flushHeadersSave();
  }

  #dispatchVarsSave(variables) {
    if (!this.#selectedId) return;
    // Update in-memory collection state
    this.#collections = this.#collections.map((c) =>
      c.id === this.#selectedId ? { ...c, variables } : c,
    );
    this.#onVarsSave?.({ scopeId: this.#selectedId, variables });
  }

  // ── Headers tab (collection default HTTP headers) ─────────────────────────────

  /**
   * The HeadersEditor reports a change on every edit; update in-memory state
   * immediately (so a collection switch sees the latest) and debounce the persist
   * — captured against the collection that was selected when the edit landed, so
   * a late timer can never write the wrong collection.
   */
  #dispatchHeadersSave(headers) {
    if (!this.#selectedId) return;
    this.#collections = this.#collections.map((c) =>
      c.id === this.#selectedId ? { ...c, headers } : c,
    );
    this.#pendingHeaders = headers;
    this.#pendingHeadersScope = this.#selectedId;
    clearTimeout(this.#headersSaveTimer);
    this.#headersSaveTimer = setTimeout(
      () => this.#flushHeadersSave(),
      CollectionsPopup.#SAVE_MS,
    );
  }

  #flushHeadersSave() {
    clearTimeout(this.#headersSaveTimer);
    this.#headersSaveTimer = null;
    if (this.#pendingHeaders && this.#pendingHeadersScope) {
      this.#onHeadersSave?.({
        scopeId: this.#pendingHeadersScope,
        headers: this.#pendingHeaders,
      });
      this.#pendingHeaders = null;
      this.#pendingHeadersScope = null;
    }
  }

  /**
   * Provide the variable context the header value pills validate `{{var}}`
   * tokens against. Forwarded live to the embedded editor.
   */
  setVariableContext(ctx) {
    this.#headerContext = ctx ?? null;
    this.#httpHeadersEditor?.setVariableContext();
  }

  // ── Cookies tab ──────────────────────────────────────────────────────────────

  /**
   * Toggle whether the selected collection attaches its cookie jar to requests.
   * Updates in-memory state and asks app.js to persist it in the manifest.
   */
  #handleSendCookiesToggle(checked) {
    if (!this.#selectedId) return;
    this.#collections = this.#collections.map((c) =>
      c.id === this.#selectedId ? { ...c, sendCookies: checked } : c,
    );
    this.#onSendCookiesChange?.({ id: this.#selectedId, sendCookies: checked });
  }

  async #reloadCookies() {
    const id = this.#selectedId;
    if (!id) {
      this.#cookies = [];
      this.#renderCookies();
      return;
    }
    let list;
    try {
      list = await window.hippo.store.cookies.list(id);
    } catch {
      list = [];
    }
    // The selection may have changed during the await — don't render one
    // collection's cookies under another.
    if (this.#selectedId !== id) return;
    this.#cookies = Array.isArray(list) ? list : [];
    this.#renderCookies();
  }

  #renderCookies() {
    const list = this.#el.querySelector(".cookies-list");
    const clearBtn = this.#el.querySelector(".cookies-clear-btn");
    const sendToggle = this.#el.querySelector(".cookies-send-toggle");
    list.innerHTML = "";

    // Reflect the selected collection's "send cookies" flag (default on).
    const selected = this.#collections.find((c) => c.id === this.#selectedId);
    sendToggle.checked = selected ? selected.sendCookies !== false : true;
    sendToggle.disabled = !this.#selectedId;

    const addBtn = this.#el.querySelector(".cookies-add-btn");
    if (!this.#selectedId) {
      list.innerHTML = `<li class="cookies-empty">${escapeHtml(t("cookies.selectCollection"))}</li>`;
      clearBtn.disabled = true;
      if (addBtn) addBtn.disabled = true;
      return;
    }
    if (addBtn) addBtn.disabled = false;
    clearBtn.disabled = this.#cookies.length === 0;

    // A pending "add" shows a blank editor row at the top of the jar.
    if (this.#addingCookie) {
      list.appendChild(this.#buildCookieEditRow(this.#blankCookie(), true));
    }

    if (this.#cookies.length === 0 && !this.#addingCookie) {
      list.innerHTML = `<li class="cookies-empty">${escapeHtml(t("cookies.empty"))}</li>`;
      return;
    }

    for (const cookie of this.#cookies) {
      list.appendChild(
        this.#isEditingCookie(cookie)
          ? this.#buildCookieEditRow(cookie)
          : this.#buildCookieViewRow(cookie),
      );
    }
  }

  /** Starts an inline add: a blank editor row at the top of the list. */
  #startAddCookie() {
    if (!this.#selectedId) return;
    this.#editingCookieIdent = null;
    this.#addingCookie = true;
    this.#renderCookies();
    this.#el.querySelector(".cookies-row--editing .cookies-in-name")?.focus();
  }

  /** A fresh, persistent (non-session) cookie scoped to nothing yet. */
  #blankCookie() {
    return {
      name: "",
      value: "",
      domain: "",
      path: "/",
      secure: false,
      httpOnly: false,
      sameSite: null,
      expires: null,
    };
  }

  #buildCookieViewRow(cookie) {
    const li = document.createElement("li");
    li.className = "cookies-row";

    // ── name=value row + edit/delete actions ──────────────────────────────
    const main = document.createElement("div");
    main.className = "cookies-row-main";

    const nv = document.createElement("span");
    nv.className = "cookies-nv";
    const nameEl = document.createElement("span");
    nameEl.className = "cookies-name";
    nameEl.textContent = cookie.name;
    const valueEl = document.createElement("span");
    valueEl.className = "cookies-value";
    valueEl.textContent = cookie.value;
    nv.append(nameEl, document.createTextNode("="), valueEl);

    const actions = document.createElement("div");
    actions.className = "cookies-row-actions";

    const editBtn = document.createElement("button");
    editBtn.className = "icon-btn cookies-edit";
    editBtn.title = t("collections.cookie.edit");
    editBtn.setAttribute("aria-label", t("collections.cookie.edit"));
    editBtn.innerHTML = ICON_EDIT; // static developer markup (SVG)
    editBtn.addEventListener("click", () => {
      this.#editingCookieIdent = this.#identOf(cookie);
      this.#renderCookies();
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "icon-btn params-delete-btn cookies-delete";
    deleteBtn.title = t("collections.cookie.delete");
    deleteBtn.setAttribute("aria-label", t("collections.cookie.delete"));
    wireDeleteConfirm(deleteBtn, () => this.#deleteCookie(cookie));

    actions.append(editBtn, deleteBtn);
    main.append(nv, actions);

    // ── scope / expiry / flags meta row ───────────────────────────────────
    const meta = document.createElement("div");
    meta.className = "cookies-row-meta";

    const scope = document.createElement("span");
    scope.className = "cookies-scope";
    scope.textContent = `${cookie.domain}${cookie.path}`;

    const expiry = document.createElement("span");
    expiry.className = "cookies-expiry";
    expiry.textContent = this.#formatExpiry(cookie.expires);

    meta.append(scope, expiry);

    const flags = [];
    if (cookie.secure) flags.push("Secure");
    if (cookie.httpOnly) flags.push("HttpOnly");
    if (cookie.sameSite) flags.push(`SameSite=${cookie.sameSite}`);
    if (flags.length) {
      const flagsEl = document.createElement("span");
      flagsEl.className = "cookies-flags";
      for (const f of flags) {
        const flag = document.createElement("span");
        flag.className = "cookies-flag";
        flag.textContent = f;
        flagsEl.appendChild(flag);
      }
      meta.appendChild(flagsEl);
    }

    li.append(main, meta);
    return li;
  }

  #buildCookieEditRow(cookie, isNew = false) {
    const li = document.createElement("li");
    li.className = "cookies-row cookies-row--editing";

    const sameSiteOpts = SAME_SITE_OPTIONS.map((opt) => {
      const sel = (cookie.sameSite || "") === opt ? " selected" : "";
      const label = opt || "(none)";
      return `<option value="${escapeHtml(opt)}"${sel}>${escapeHtml(label)}</option>`;
    }).join("");

    li.innerHTML = `
      <div class="cookies-edit-grid">
        <label class="cookies-field">
          <span>${t("kv.name")}</span>
          <input type="text" class="cookies-in-name" autocomplete="off" spellcheck="false" value="${escapeHtml(cookie.name)}">
        </label>
        <label class="cookies-field">
          <span>${t("kv.value")}</span>
          <input type="text" class="cookies-in-value" autocomplete="off" spellcheck="false" value="${escapeHtml(cookie.value)}">
        </label>
        <label class="cookies-field">
          <span>${t("collections.cookie.domain")}</span>
          <input type="text" class="cookies-in-domain" autocomplete="off" spellcheck="false" value="${escapeHtml(cookie.domain)}">
        </label>
        <label class="cookies-field">
          <span>${t("collections.cookie.path")}</span>
          <input type="text" class="cookies-in-path" autocomplete="off" spellcheck="false" value="${escapeHtml(cookie.path)}">
        </label>
        <label class="cookies-field">
          <span>${t("collections.cookie.expires")}</span>
          <input type="datetime-local" class="cookies-in-expires" value="${escapeHtml(this.#toDatetimeLocal(cookie.expires))}">
        </label>
        <label class="cookies-field">
          <span>${t("collections.cookie.sameSite")}</span>
          <select class="cookies-in-samesite">${sameSiteOpts}</select>
        </label>
        <label class="cookies-checkbox">
          <input type="checkbox" class="cookies-in-secure"${cookie.secure ? " checked" : ""}> Secure
        </label>
        <label class="cookies-checkbox">
          <input type="checkbox" class="cookies-in-httponly"${cookie.httpOnly ? " checked" : ""}> HttpOnly
        </label>
      </div>
      <div class="cookies-edit-actions">
        <button class="btn popup-btn btn--secondary cookies-edit-cancel">${t("common.cancel")}</button>
        <button class="btn popup-btn btn--primary cookies-edit-save">${t("common.save")}</button>
      </div>
    `;

    li.querySelector(".cookies-edit-cancel").addEventListener("click", () => {
      if (isNew) this.#addingCookie = false;
      else this.#editingCookieIdent = null;
      this.#renderCookies();
    });
    li.querySelector(".cookies-edit-save").addEventListener("click", () =>
      this.#saveCookieEdit(cookie, li, isNew),
    );

    return li;
  }

  async #saveCookieEdit(original, li, isNew = false) {
    const name = li.querySelector(".cookies-in-name").value.trim();
    const domain = li
      .querySelector(".cookies-in-domain")
      .value.trim()
      .toLowerCase()
      .replace(/^\./, "");
    let path = li.querySelector(".cookies-in-path").value.trim();
    if (!path.startsWith("/")) path = "/";

    if (!name || !domain) {
      // Name and domain are the cookie's identity — refuse an empty key.
      li.querySelector(".cookies-in-name").focus();
      return;
    }

    const expires = this.#fromDatetimeLocal(
      li.querySelector(".cookies-in-expires").value,
    );

    const updated = {
      ...original,
      name,
      value: li.querySelector(".cookies-in-value").value,
      domain,
      path,
      secure: li.querySelector(".cookies-in-secure").checked,
      httpOnly: li.querySelector(".cookies-in-httponly").checked,
      sameSite: li.querySelector(".cookies-in-samesite").value || null,
      expires,
    };

    const oldIdent = this.#identOf(original);
    const identityChanged =
      oldIdent.name !== updated.name ||
      oldIdent.domain !== updated.domain ||
      oldIdent.path !== updated.path;

    // A changed identity is a different jar key, so remove the old entry first
    // rather than leaving a stale duplicate behind. New cookies have no prior key.
    // Each write surfaces its own error toast on failure; bail (leaving the editor
    // open so the user can retry) rather than reloading as if it had succeeded.
    if (!isNew && identityChanged) {
      if (!(await deleteCookie(this.#selectedId, oldIdent))) return;
    }
    if (!(await upsertCookie(this.#selectedId, updated))) return;

    if (isNew) this.#addingCookie = false;
    else this.#editingCookieIdent = null;
    await this.#reloadCookies();
  }

  async #deleteCookie(cookie) {
    // Failure surfaces a toast inside deleteCookie(); bail without reloading.
    if (!(await deleteCookie(this.#selectedId, this.#identOf(cookie)))) return;
    if (this.#isEditingCookie(cookie)) this.#editingCookieIdent = null;
    await this.#reloadCookies();
  }

  #confirmClearCookies() {
    PopupManager.confirm({
      title: t("cookies.clearTitle"),
      message: t("cookies.clearMessage"),
      confirmLabel: t("cookies.clearConfirm"),
      confirmClass: "btn--danger",
      onConfirm: async () => {
        // Failure surfaces a toast inside clearCookies(); bail without reloading.
        if (!(await clearCookies(this.#selectedId))) return;
        this.#editingCookieIdent = null;
        await this.#reloadCookies();
      },
    });
  }

  #identOf(cookie) {
    return { name: cookie.name, domain: cookie.domain, path: cookie.path };
  }

  #isEditingCookie(cookie) {
    const e = this.#editingCookieIdent;
    return (
      !!e &&
      e.name === cookie.name &&
      e.domain === cookie.domain &&
      e.path === cookie.path
    );
  }

  /** Human-readable expiry, or "Session" for session cookies. */
  #formatExpiry(expires) {
    if (expires == null) return t("cookies.session");
    const d = new Date(expires);
    if (Number.isNaN(d.getTime())) return t("cookies.session");
    return formatDate(d);
  }

  /** Epoch ms → value for a <input type="datetime-local"> (local time). */
  #toDatetimeLocal(expires) {
    if (expires == null) return "";
    const d = new Date(expires);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return (
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
      `T${pad(d.getHours())}:${pad(d.getMinutes())}`
    );
  }

  /** datetime-local value → epoch ms, or null when blank (session cookie). */
  #fromDatetimeLocal(value) {
    if (!value) return null;
    const ms = new Date(value).getTime();
    return Number.isNaN(ms) ? null : ms;
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

    // True lower bounds — keep the sidebar, tabs, and panels usable.
    const MIN_W = 620;
    const MIN_H = 420;

    handle.addEventListener("mousedown", (startEvt) => {
      startEvt.preventDefault();
      startEvt.stopPropagation();
      const rect = el.getBoundingClientRect();
      // Center stays fixed at 50vw/50vh — width = 2 × (mouseX − centerX)
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      el.style.maxWidth = "none";
      el.style.maxHeight = "none";
      // Drop the CSS floor so inline width/height can shrink below it.
      el.style.minWidth = `${MIN_W}px`;
      el.style.minHeight = `${MIN_H}px`;
      const onMove = (e) => {
        el.style.width = `${Math.max(MIN_W, 2 * (e.clientX - centerX))}px`;
        el.style.height = `${Math.max(MIN_H, 2 * (e.clientY - centerY))}px`;
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
