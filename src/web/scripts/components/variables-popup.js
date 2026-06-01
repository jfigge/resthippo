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
  /** @type {HTMLElement} */ #el;
  /** @type {HTMLElement} */ #titleEl;
  /** @type {HTMLInputElement} */ #bulkToggleEl;
  /** @type {HTMLTextAreaElement} */ #textareaEl;
  /** @type {HTMLElement} */ #kvWrapEl;
  /** @type {HTMLElement} */ #kvListEl;
  /** @type {HTMLButtonElement} */ #closeHeaderBtn;
  /** @type {HTMLButtonElement} */ #closeFooterBtn;
  /** @type {HTMLElement} */ #hintEl;
  /** @type {HTMLButtonElement} */ #addBtnEl;

  /** @type {string|null} */ #envId = null;

  /** true = textarea (bulk); false = KV rows */
  #isBulkMode = true;

  /** @type {{ id:string, name:string, value:string }[]} */
  #rows = [];

  /** @type {number|null} */ #saveTimer = null;

  /** Whether the "Remove headers" setting is active. */
  #removeHeaders = false;

  static #SAVE_MS = 500;

  constructor() {
    this.#el = this.#build();
  }

  get element() {
    return this.#el;
  }

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

    const vars =
      variables && typeof variables === "object" && !Array.isArray(variables)
        ? variables
        : {};

    clearTimeout(this.#saveTimer);

    this.#isBulkMode = bulkEditor;
    this.#bulkToggleEl.checked = this.#isBulkMode;

    if (this.#isBulkMode) {
      this.#textareaEl.value = this.#varsToText(vars);
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

  onMaskClick() {
    this.#doClose();
  }

  // ── Build ───────────────────────────────────────────────────────────────────

  /**
   * Apply (or clear) the "Remove headers" style to the KV-mode column-label
   * row ("Name" / "Value"). Idempotent — safe to call any number of times.
   */
  #applyRemoveHeaders() {
    const display = this.#removeHeaders ? "none" : "";
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
        <button class="popup-close" aria-label="Close" title="Close"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button>
      </div>
      <div class="popup-body vars-popup-body">
        <div class="vars-toolbar">
          <label class="params-toolbar-toggle-label vars-bulk-label"
                 title="Toggle between bulk text editor and key/value row editor">
            <input type="checkbox" class="params-toolbar-toggle vars-bulk-toggle" checked>
            Bulk editor
          </label>
          <button class="icon-btn params-toolbar-btn vars-add-btn" title="Add variable" aria-label="Add variable" style="display:none"><span class="icon">＋</span></button>
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
            <span>Name</span><span class="params-col-value">Value</span><span></span>
          </div>
          <div class="vars-kv-list params-list" aria-label="Variables"></div>
        </div>
      </div>
      <div class="popup-footer vars-popup-footer">
        <button class="popup-btn popup-btn--primary vars-close-btn"
                title="Save and close">Close</button>
      </div>
    `;

    this.#titleEl = el.querySelector(".vars-popup-title");
    this.#bulkToggleEl = el.querySelector(".vars-bulk-toggle");
    this.#textareaEl = el.querySelector(".vars-textarea");
    this.#kvWrapEl = el.querySelector(".vars-kv-wrap");
    this.#kvListEl = el.querySelector(".vars-kv-list");
    this.#closeHeaderBtn = el.querySelector(".popup-close");
    this.#closeFooterBtn = el.querySelector(".vars-close-btn");
    this.#hintEl = el.querySelector(".vars-hint");
    this.#addBtnEl = el.querySelector(".vars-add-btn");

    this.#closeHeaderBtn.addEventListener("click", () => this.#doClose());
    this.#closeFooterBtn.addEventListener("click", () => this.#doClose());
    this.#bulkToggleEl.addEventListener("change", () =>
      this.#handleBulkToggle(),
    );
    this.#textareaEl.addEventListener("input", () => this.#scheduleSave());
    el.querySelector(".vars-add-btn").addEventListener("click", () =>
      this.#addRow(),
    );

    // Escape closes the popup.
    el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        this.#doClose();
      }
    });

    return el;
  }

  // ── Mode switching ──────────────────────────────────────────────────────────

  #applyMode() {
    const bulk = this.#isBulkMode;
    this.#textareaEl.style.display = bulk ? "" : "none";
    this.#kvWrapEl.style.display = bulk ? "none" : "";
    if (this.#hintEl) this.#hintEl.style.display = bulk ? "" : "none";
    if (this.#addBtnEl) this.#addBtnEl.style.display = bulk ? "none" : "";
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

    window.dispatchEvent(
      new CustomEvent("wurl:vars-bulk-editor-changed", {
        detail: { bulkEditor: nowBulk },
        bubbles: true,
      }),
    );
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

  // ── KV row rendering ────────────────────────────────────────────────────────

  #renderRows() {
    this.#kvListEl.innerHTML = "";
    if (this.#rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "params-empty";
      empty.textContent = "No variables — click  +  to add one.";
      this.#kvListEl.appendChild(empty);
      return;
    }
    this.#rows.forEach((row) =>
      this.#kvListEl.appendChild(this.#buildRow(row)),
    );
  }

  #buildRow(row) {
    const el = document.createElement("div");
    el.className = "vars-kv-row params-row";
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
    del.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>
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
    const rows = this.#kvListEl.querySelectorAll(".vars-kv-row");
    if (rows.length)
      rows[rows.length - 1].querySelector(".params-name")?.focus();
  }

  // ── Save ────────────────────────────────────────────────────────────────────

  #scheduleSave() {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(
      () => this.#saveFromBulk(),
      VariablesPopup.#SAVE_MS,
    );
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
    window.dispatchEvent(
      new CustomEvent("wurl:vars-save", {
        detail: { envId: this.#envId, variables },
        bubbles: true,
      }),
    );
  }

  // ── Close ───────────────────────────────────────────────────────────────────

  #doClose() {
    clearTimeout(this.#saveTimer);
    if (this.#isBulkMode) this.#saveFromBulk();
    else this.#saveFromRows();
    PopupManager.close();
  }
}
