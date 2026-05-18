/**
 * variables-popup.js — Key/Value variable editor popup
 *
 * A resizable dialog for editing a flat set of key/value variables.
 *
 * Features:
 *   • "Bulk editor" toggle (remembered in settings):
 *       - ON  → textarea where each line is a  name=value  pair
 *       - OFF → key/value row list (same appearance as request params)
 *   • Auto-save (debounced) on every keystroke / row change.
 *   • Reset button with inline confirm pattern (first click → "Confirm?",
 *     second click → restore the values loaded when the popup opened).
 *   • User-resizable via CSS `resize: both`.
 *
 * Events dispatched on window:
 *   wurl:vars-save                { envId, variables }
 *   wurl:vars-bulk-editor-changed { bulkEditor: bool }
 */

"use strict";

import { PopupManager } from "../popup-manager.js";

export class VariablesPopup {
  /** @type {HTMLElement} */       #el;
  /** @type {HTMLElement} */       #titleEl;
  /** @type {HTMLInputElement} */  #bulkToggleEl;
  /** @type {HTMLTextAreaElement} */ #textareaEl;
  /** @type {HTMLElement} */       #kvWrapEl;
  /** @type {HTMLElement} */       #kvListEl;
  /** @type {HTMLButtonElement} */ #resetBtn;
  /** @type {HTMLButtonElement} */ #closeHeaderBtn;

  /** @type {string|null} */ #envId = null;

  /** name=value text captured at open() — used by Reset. */
  #initialText = "";

  /** true = textarea (bulk); false = KV rows */
  #isBulkMode = true;

  /** @type {{ id:string, name:string, value:string }[]} */
  #rows = [];

  // drag state
  #dragSrcId   = null;
  #dragHandled = false;
  /** @type {HTMLElement} */ #phantom;

  /** @type {number|null} */   #saveTimer    = null;
  /** @type {Function|null} */ #resetCleanup = null;

  /** Whether the "Remove headers" setting is active. */
  #removeHeaders = false;

  static #SAVE_MS = 500;

  constructor() {
    this.#el      = this.#build();
    this.#phantom = this.#buildPhantom();
  }

  get element() { return this.#el; }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Receive global settings. Currently responds to `removeHeaders`.
   * Safe to call at any time — applies immediately if the popup is open.
   * @param {{ removeHeaders?: boolean }} settings
   */
  applySettings(settings) {
    if (settings.removeHeaders !== undefined) {
      this.#removeHeaders = settings.removeHeaders;
      this.#applyRemoveHeaders();
    }
  }

  /**
   * @param {{ envId:string, envName:string, variables:object, bulkEditor?:boolean }} opts
   */
  open({ envId, envName, variables, bulkEditor = true }) {
    this.#envId = envId;
    this.#titleEl.textContent = `Variables — ${envName}`;
    this.#el.setAttribute("aria-label", `Variables — ${envName}`);

    const vars = (variables && typeof variables === "object" && !Array.isArray(variables))
      ? variables : {};

    // Snapshot for Reset
    this.#initialText = this.#varsToText(vars);

    this.#cancelResetConfirm();
    clearTimeout(this.#saveTimer);

    this.#isBulkMode = bulkEditor;
    this.#bulkToggleEl.checked = this.#isBulkMode;

    if (this.#isBulkMode) {
      this.#textareaEl.value = this.#initialText;
      this.#applyMode();
    } else {
      this.#rows = this.#varsToRows(vars);
      this.#applyMode();
      this.#renderRows();
    }

    PopupManager.open(this);
    this.#applyRemoveHeaders();
    requestAnimationFrame(() => {
      if (this.#isBulkMode) this.#textareaEl.focus();
    });
  }

  onMaskClick() { this.#doClose(); }

  // ── Build ───────────────────────────────────────────────────────────────────

  /**
   * Apply (or clear) the "Remove headers" style to the popup's header bar and
   * the KV-mode column-label row.  Idempotent — safe to call any number of times.
   */
  #applyRemoveHeaders() {
    const display = this.#removeHeaders ? "none" : "";
    // Popup title-bar (contains the "Variables — Env" label + close button)
    // KV-mode column labels ("Name" / "Value")
    const kvHeader = this.#el.querySelector(".vars-kv-header");
    if (kvHeader) kvHeader.style.display = display;
  }

  #build() {
    const el = document.createElement("div");
    el.className = "popup vars-popup";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", "Variable Editor");

    el.innerHTML = `
      <div class="popup-header">
        <span class="popup-title vars-popup-title">Variables</span>
        <button class="popup-close" aria-label="Close" title="Close">✕</button>
      </div>
      <div class="popup-body vars-popup-body">
        <div class="vars-toolbar">
          <button class="icon-btn vars-add-btn" title="Add variable" aria-label="Add variable" style="display:none">+</button>
          <label class="params-toolbar-toggle-label vars-bulk-label"
                 title="Toggle between bulk text editor and key/value row editor">
            <input type="checkbox" class="params-toolbar-toggle vars-bulk-toggle" checked>
            Bulk editor
          </label>
          <span class="vars-hint">One  name=value  per line</span>
        </div>
        <textarea
          class="body-text-editor vars-textarea"
          spellcheck="false"
          autocomplete="off"
          placeholder="name=value&#10;apiKey=abc123&#10;baseUrl=https://example.com"
          aria-label="Variables editor"
        ></textarea>
        <div class="vars-kv-wrap" style="display:none">
          <div class="vars-kv-header params-header-row">
            <span></span><span>Name</span><span class="params-col-value">Value</span><span></span>
          </div>
          <div class="vars-kv-list params-list" aria-label="Variables"></div>
        </div>
      </div>
      <div class="popup-footer vars-popup-footer">
        <button class="popup-btn popup-btn--secondary vars-reset-btn"
                title="Reset variables to the values they had when this dialog was opened">Reset</button>
      </div>
    `;

    this.#titleEl        = el.querySelector(".vars-popup-title");
    this.#bulkToggleEl   = el.querySelector(".vars-bulk-toggle");
    this.#textareaEl     = el.querySelector(".vars-textarea");
    this.#kvWrapEl       = el.querySelector(".vars-kv-wrap");
    this.#kvListEl       = el.querySelector(".vars-kv-list");
    this.#resetBtn       = el.querySelector(".vars-reset-btn");
    this.#closeHeaderBtn = el.querySelector(".popup-close");

    this.#closeHeaderBtn.addEventListener("click", () => this.#doClose());
    this.#bulkToggleEl.addEventListener("change", () => this.#handleBulkToggle());
    this.#textareaEl.addEventListener("input", () => this.#scheduleSave());
    el.querySelector(".vars-add-btn").addEventListener("click", () => this.#addRow());
    this.#resetBtn.addEventListener("click", () => this.#handleReset());

    // Escape closes the popup (unless the Reset confirm state is active,
    // in which case the document-level Escape handler in #handleReset takes
    // priority and cancels the confirm instead).
    el.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.#resetCleanup) {
        e.stopPropagation();
        this.#doClose();
      }
    });

    // List-level drag events (fires even when cursor is over the phantom)
    this.#kvListEl.addEventListener("dragover", (e) => {
      if (!this.#dragSrcId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (!this.#kvListEl.contains(this.#phantom)) {
        this.#kvListEl.appendChild(this.#phantom);
      }
    });

    this.#kvListEl.addEventListener("drop", (e) => {
      e.preventDefault();
      if (!this.#dragSrcId) return;
      this.#dragHandled = true;
      const children = [...this.#kvListEl.children];
      const phIdx    = children.indexOf(this.#phantom);
      if (phIdx === -1) { this.#finalizeDrag(); return; }
      const rowEls   = children.filter(c => c.classList.contains("vars-kv-row"));
      const insertAt = rowEls.filter((_r, i) => children.indexOf(rowEls[i]) < phIdx).length;
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

  // ── Mode switching ──────────────────────────────────────────────────────────

  #applyMode() {
    const bulk = this.#isBulkMode;
    this.#textareaEl.style.display = bulk ? "" : "none";
    this.#kvWrapEl.style.display   = bulk ? "none" : "";
    const hint = this.#el.querySelector(".vars-hint");
    if (hint) hint.style.display   = bulk ? "" : "none";
    const addBtn = this.#el.querySelector(".vars-add-btn");
    if (addBtn) addBtn.style.display = bulk ? "none" : "";
  }

  #handleBulkToggle() {
    const nowBulk = this.#bulkToggleEl.checked;

    if (nowBulk && !this.#isBulkMode) {
      // Table → Bulk: serialise rows to text
      this.#textareaEl.value = this.#varsToText(this.#rowsToObject());
    } else if (!nowBulk && this.#isBulkMode) {
      // Bulk → Table: parse text to rows
      this.#rows = this.#varsToRows(this.#textToVars(this.#textareaEl.value));
    }

    this.#isBulkMode = nowBulk;
    this.#applyMode();

    if (nowBulk) {
      requestAnimationFrame(() => this.#textareaEl.focus());
    } else {
      this.#renderRows();
      this.#saveFromRows();
    }

    window.dispatchEvent(new CustomEvent("wurl:vars-bulk-editor-changed", {
      detail: { bulkEditor: nowBulk }, bubbles: true,
    }));
  }

  // ── Conversion helpers ──────────────────────────────────────────────────────

  /**
   * Convert a variables object to multi-line  name=value  text.
   * @param {object} vars
   * @returns {string}
   */
  #varsToText(vars) {
    return Object.entries(vars)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
  }

  /**
   * Parse multi-line  name=value  text into a plain object.
   * Lines without '=' are silently ignored.
   * @param {string} text
   * @returns {object}
   */
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

  /** Convert a variables object to a rows array. */
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

  // ── KV row rendering ────────────────────────────────────────────────────────

  #renderRows() {
    if (!this.#kvListEl) return;
    this.#kvListEl.innerHTML = "";
    if (this.#rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "params-empty";
      empty.textContent = "No variables — click  +  to add one.";
      this.#kvListEl.appendChild(empty);
      return;
    }
    this.#rows.forEach(row => this.#kvListEl.appendChild(this.#buildRow(row)));
  }

  #buildRow(row) {
    const el = document.createElement("div");
    el.className = "vars-kv-row params-row";
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
      this.#dragSrcId   = row.id;
      this.#dragHandled = false;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", row.id);
      requestAnimationFrame(() => {
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
    const rows = this.#kvListEl.querySelectorAll(".vars-kv-row");
    if (rows.length) rows[rows.length - 1].querySelector(".params-name")?.focus();
  }

  // ── Save ────────────────────────────────────────────────────────────────────

  #scheduleSave() {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => this.#saveFromBulk(), VariablesPopup.#SAVE_MS);
  }

  #saveFromBulk() {
    if (!this.#envId) return;
    this.#dispatchSave(this.#textToVars(this.#textareaEl.value));
  }

  #saveFromRows() {
    if (!this.#envId) return;
    this.#dispatchSave(this.#rowsToObject());
  }

  #dispatchSave(variables) {
    window.dispatchEvent(new CustomEvent("wurl:vars-save", {
      detail: { envId: this.#envId, variables }, bubbles: true,
    }));
  }

  // ── Reset ───────────────────────────────────────────────────────────────────

  #handleReset() {
    if (this.#resetCleanup) {
      this.#cancelResetConfirm();
      if (this.#isBulkMode) {
        this.#textareaEl.value = this.#initialText;
        this.#saveFromBulk();
      } else {
        this.#rows = this.#varsToRows(this.#textToVars(this.#initialText));
        this.#renderRows();
        this.#saveFromRows();
      }
      return;
    }

    this.#resetBtn.textContent = "Confirm?";
    this.#resetBtn.classList.replace("popup-btn--secondary", "popup-btn--warning");

    const restore = () => {
      this.#resetBtn.textContent = "Reset";
      this.#resetBtn.classList.replace("popup-btn--warning", "popup-btn--secondary");
      document.removeEventListener("keydown",   onEsc,     true);
      document.removeEventListener("mousedown", onOutside, true);
      this.#resetCleanup = null;
    };
    const onEsc     = (e) => { if (e.key === "Escape") restore(); };
    const onOutside = (e) => { if (!this.#resetBtn.contains(e.target)) restore(); };

    document.addEventListener("keydown",   onEsc,     true);
    document.addEventListener("mousedown", onOutside, true);
    this.#resetCleanup = restore;
  }

  #cancelResetConfirm() { if (this.#resetCleanup) this.#resetCleanup(); }

  // ── Close ───────────────────────────────────────────────────────────────────

  #doClose() {
    clearTimeout(this.#saveTimer);
    this.#cancelResetConfirm();
    if (this.#isBulkMode) this.#saveFromBulk(); else this.#saveFromRows();
    PopupManager.close();
  }
}
