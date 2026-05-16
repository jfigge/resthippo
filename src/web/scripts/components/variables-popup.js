/**
 * variables-popup.js — Key/Value variable editor popup
 *
 * A resizable dialog that lets the user edit a set of variables stored as a
 * flat JSON key/value object.  The same popup is reused for any variable scope
 * (global, environment, folder, request) — only the `title` and `variables`
 * payload differ.
 *
 * Features:
 *   • "Bulk editor" toggle (remembered in settings):
 *       - ON  → textarea with live JSON validation badge (same as request body)
 *       - OFF → key/value row list identical in appearance to request params
 *   • Live JSON validation (bulk mode only) — disables Close while invalid.
 *   • Auto-save (debounced) whenever content changes and is valid.
 *   • Reset button with inline confirm pattern (first click → "Confirm?",
 *     second click → restore the JSON that was loaded when the popup opened).
 *   • Close button — flushes any pending valid save then closes.
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
  /** @type {HTMLElement} */ #badgeEl;
  /** @type {HTMLElement} */ #hintEl;
  /** @type {HTMLTextAreaElement} */ #textareaEl;
  /** @type {HTMLElement} */ #kvWrapEl;
  /** @type {HTMLElement} */ #kvListEl;
  /** @type {HTMLButtonElement} */ #resetBtn;
  /** @type {HTMLButtonElement} */ #closeHeaderBtn;

  /** @type {string|null} */   #envId = null;
  /** JSON loaded at open() — used by Reset. */
  #initialJson = "{}";
  /** true = textarea (bulk); false = KV rows */
  #isBulkMode = true;
  /** @type {{ id:string, name:string, value:string }[]} */
  #rows = [];

  // drag state
  #dragSrcId   = null;
  #dragHandled = false;
  /** @type {HTMLElement} */ #phantom;

  /** @type {number|null} */ #validateTimer = null;
  /** @type {number|null} */ #saveTimer     = null;
  /** @type {Function|null} */ #resetCleanup = null;

  static #VALIDATE_MS = 300;
  static #SAVE_MS     = 600;

  constructor() {
    this.#el      = this.#build();
    this.#phantom = this.#buildPhantom();
  }

  get element() { return this.#el; }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * @param {{ envId:string, envName:string, variables:object, bulkEditor?:boolean }} opts
   */
  open({ envId, envName, variables, bulkEditor = true }) {
    this.#envId = envId;
    this.#titleEl.textContent = `Variables — ${envName}`;
    this.#el.setAttribute("aria-label", `Variables — ${envName}`);

    const vars = (variables && typeof variables === "object" && !Array.isArray(variables))
      ? variables : {};

    this.#initialJson = Object.keys(vars).length > 0
      ? JSON.stringify(vars, null, 2)
      : "{}";

    this.#cancelResetConfirm();
    clearTimeout(this.#validateTimer);
    clearTimeout(this.#saveTimer);

    this.#isBulkMode = bulkEditor;
    this.#bulkToggleEl.checked = this.#isBulkMode;

    if (this.#isBulkMode) {
      this.#textareaEl.value = this.#initialJson;
      this.#applyMode();
      this.#validateNow();
    } else {
      this.#rows = this.#jsonToRows(vars);
      this.#applyMode();
      this.#renderRows();
    }

    PopupManager.open(this);
    requestAnimationFrame(() => {
      if (this.#isBulkMode) this.#textareaEl.focus();
    });
  }

  onMaskClick() {
    if (this.#closeHeaderBtn?.disabled) return;
    this.#doClose();
  }

  // ── Build ───────────────────────────────────────────────────────────────────

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
          <label class="params-toolbar-toggle-label vars-bulk-label"
                 title="Toggle between bulk JSON editor and key/value row editor">
            <input type="checkbox" class="params-toolbar-toggle vars-bulk-toggle" checked>
            Bulk editor
          </label>
          <span class="body-validate-badge vars-validate-badge" aria-live="polite" data-state=""></span>
          <span class="vars-hint">Valid JSON key/value pairs only</span>
        </div>
        <textarea
          class="body-text-editor vars-textarea"
          spellcheck="false"
          autocomplete="off"
          placeholder='{&#10;  "key": "value"&#10;}'
          aria-label="Variables JSON editor"
        ></textarea>
        <div class="vars-kv-wrap" style="display:none">
          <div class="vars-kv-header params-header-row">
            <span></span><span>Name</span><span class="params-col-value">Value</span><span></span>
          </div>
          <div class="vars-kv-list params-list" aria-label="Variables"></div>
          <div class="vars-kv-add-bar">
            <button class="icon-btn vars-add-btn" title="Add variable" aria-label="Add variable">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
                  stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <line x1="6" y1="1" x2="6" y2="11"/><line x1="1" y1="6" x2="11" y2="6"/>
              </svg>
              Add
            </button>
          </div>
        </div>
      </div>
      <div class="popup-footer vars-popup-footer">
        <button class="popup-btn popup-btn--secondary vars-reset-btn"
                title="Reset variables to the values they had when this dialog was opened">Reset</button>
      </div>
    `;

    this.#titleEl        = el.querySelector(".vars-popup-title");
    this.#bulkToggleEl   = el.querySelector(".vars-bulk-toggle");
    this.#badgeEl        = el.querySelector(".vars-validate-badge");
    this.#hintEl         = el.querySelector(".vars-hint");
    this.#textareaEl     = el.querySelector(".vars-textarea");
    this.#kvWrapEl       = el.querySelector(".vars-kv-wrap");
    this.#kvListEl       = el.querySelector(".vars-kv-list");
    this.#resetBtn       = el.querySelector(".vars-reset-btn");
    this.#closeHeaderBtn = el.querySelector(".popup-close");

    this.#closeHeaderBtn.addEventListener("click", () => this.#doClose());
    this.#bulkToggleEl.addEventListener("change", () => this.#handleBulkToggle());
    this.#textareaEl.addEventListener("input", () => {
      this.#scheduleValidate();
      this.#scheduleAutoSave();
    });
    el.querySelector(".vars-add-btn").addEventListener("click", () => this.#addRow());
    this.#resetBtn.addEventListener("click", () => this.#handleReset());

    // ── List-level drag-and-drop (fires even when cursor is over the phantom) ──
    this.#kvListEl.addEventListener("dragover", (e) => {
      if (!this.#dragSrcId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      // If the phantom drifted outside (e.g. dragged past last row), re-append it
      if (!this.#kvListEl.contains(this.#phantom)) {
        this.#kvListEl.appendChild(this.#phantom);
      }
    });

    this.#kvListEl.addEventListener("drop", (e) => {
      e.preventDefault();
      if (!this.#dragSrcId) return;
      this.#dragHandled = true;
      const ph       = this.#phantom;
      const children = [...this.#kvListEl.children];
      const phIdx    = children.indexOf(ph);
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
    this.#badgeEl.style.display    = bulk ? "" : "none";
    this.#hintEl.style.display     = bulk ? "" : "none";
    if (!bulk) this.#applyValidity(null); // clear invalid → re-enable Close
  }

  #handleBulkToggle() {
    const nowBulk = this.#bulkToggleEl.checked;

    if (nowBulk && !this.#isBulkMode) {
      // Table → Bulk: serialise rows
      const obj = this.#rowsToObject();
      this.#textareaEl.value = Object.keys(obj).length > 0
        ? JSON.stringify(obj, null, 2) : "{}";
    } else if (!nowBulk && this.#isBulkMode) {
      // Bulk → Table: parse current textarea
      const text  = this.#textareaEl.value.trim();
      if (text) {
        try {
          const parsed = JSON.parse(text);
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
            this.#rows = this.#jsonToRows(parsed);
          }
        } catch (_) { /* keep existing rows */ }
      }
    }

    this.#isBulkMode = nowBulk;
    this.#applyMode();

    if (nowBulk) {
      this.#validateNow();
      requestAnimationFrame(() => this.#textareaEl.focus());
    } else {
      this.#renderRows();
      this.#saveFromRows();
    }

    window.dispatchEvent(new CustomEvent("wurl:vars-bulk-editor-changed", {
      detail: { bulkEditor: nowBulk }, bubbles: true,
    }));
  }

  // ── KV helpers ──────────────────────────────────────────────────────────────

  #jsonToRows(obj) {
    return Object.entries(obj).map(([name, value]) => ({
      id:    crypto.randomUUID(),
      name,
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
    el.className  = "vars-kv-row params-row";
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

    // Drag
    el.addEventListener("dragstart", (e) => {
      this.#dragSrcId  = row.id;
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

  #saveFromRows() {
    if (!this.#envId) return;
    this.#dispatchSave(this.#rowsToObject());
  }

  // ── Validation (bulk mode) ──────────────────────────────────────────────────

  #scheduleValidate() {
    clearTimeout(this.#validateTimer);
    this.#validateTimer = setTimeout(() => this.#validateNow(), VariablesPopup.#VALIDATE_MS);
  }

  #validateNow() {
    const text = this.#textareaEl?.value ?? "";
    if (!text.trim()) { this.#applyValidity(null); return; }
    try {
      const parsed = JSON.parse(text);
      this.#applyValidity(
        parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? "valid" : "invalid",
      );
    } catch (_) { this.#applyValidity("invalid"); }
  }

  /** @param {"valid"|"invalid"|null} state */
  #applyValidity(state) {
    if (!this.#badgeEl) return;
    this.#badgeEl.dataset.state = state ?? "";
    if      (state === "valid")   { this.#badgeEl.textContent = "✓ valid";   this.#badgeEl.title = "JSON is valid"; }
    else if (state === "invalid") { this.#badgeEl.textContent = "✗ invalid"; this.#badgeEl.title = "Must be a valid JSON object { \"key\": \"value\" }"; }
    else                          { this.#badgeEl.textContent = "";           this.#badgeEl.title = ""; }

    const canClose = !this.#isBulkMode || state !== "invalid";
    if (this.#closeHeaderBtn) this.#closeHeaderBtn.disabled = !canClose;
  }

  // ── Auto-save (bulk mode) ───────────────────────────────────────────────────

  #scheduleAutoSave() {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => this.#trySave(), VariablesPopup.#SAVE_MS);
  }

  #trySave() {
    if (!this.#envId) return false;
    const text = this.#textareaEl?.value ?? "";
    if (!text.trim()) return false;
    try {
      const parsed = JSON.parse(text);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        this.#dispatchSave(parsed); return true;
      }
    } catch (_) { /* skip */ }
    return false;
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
        this.#textareaEl.value = this.#initialJson;
        this.#validateNow();
        this.#trySave();
      } else {
        try {
          this.#rows = this.#jsonToRows(JSON.parse(this.#initialJson));
        } catch (_) { this.#rows = []; }
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
    clearTimeout(this.#validateTimer);
    clearTimeout(this.#saveTimer);
    this.#cancelResetConfirm();
    if (this.#isBulkMode) this.#trySave(); else this.#saveFromRows();
    PopupManager.close();
  }
}

