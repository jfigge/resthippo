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
 * Constructor callbacks (this is a parent-owned popup that reports back to its
 * creator, so it uses callbacks rather than global hippo:* events — see the
 * "Component ↔ app communication" rule in CLAUDE.md):
 *   onSave({ scopeId, variables })       — debounced 500ms auto-save
 *   onBulkEditorChange({ bulkEditor }) — bulk-textarea / KV-row toggle changed
 */

"use strict";

import { PopupManager } from "../popup-manager.js";
import { icon } from "../icons.js";
import { wireDeleteConfirm } from "../delete-confirm.js";
import { normalizeVariables } from "./variable-shape.js";
import { t } from "../i18n.js";

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

  /** @type {string|null} */ #scopeId = null;

  /** true = textarea (bulk); false = KV rows */
  #isBulkMode = true;

  /** @type {{ id:string, name:string, value:string, secure:boolean }[]} */
  #rows = [];

  /** @type {number|null} */ #saveTimer = null;

  /** Whether the "Remove headers" setting is active. */
  #removeHeaders = false;

  static #SAVE_MS = 500;

  /** Auto re-mask a revealed secure value after this many ms. */
  static #REVEAL_MS = 30000;

  /** @type {(payload: { scopeId: string, variables: Array }) => void} */
  #onSave;
  /** @type {(payload: { bulkEditor: boolean }) => void} */
  #onBulkEditorChange;

  /**
   * @param {{
   *   onSave?: (payload: { scopeId: string, variables: Array }) => void,
   *   onBulkEditorChange?: (payload: { bulkEditor: boolean }) => void,
   * }} [opts]
   */
  constructor({ onSave, onBulkEditorChange } = {}) {
    this.#onSave = onSave;
    this.#onBulkEditorChange = onBulkEditorChange;
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
   * @param {{ scopeId:string, scopeName:string, variables:Array|object, bulkEditor?:boolean }} opts
   */
  open({ scopeId, scopeName, variables, bulkEditor = true }) {
    this.#scopeId = scopeId;
    this.#titleEl.textContent = t("variables.titleScope", { scope: scopeName });
    this.#el.setAttribute(
      "aria-label",
      t("variables.titleScope", { scope: scopeName }),
    );

    const vars = normalizeVariables(variables);

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
    el.setAttribute("aria-label", t("vars.title"));

    el.innerHTML = `
      <div class="popup-header">
        <span class="popup-title vars-popup-title">${t("common.variables")}</span>
        <button class="popup-close" aria-label="${t("common.close")}" title="${t("common.close")}">${icon("close", { size: 13 })}</button>
      </div>
      <div class="popup-body vars-popup-body">
        <div class="vars-toolbar">
          <label class="params-toolbar-toggle-label vars-bulk-label"
                 title="${t("kv.bulkEditorTitle")}">
            <input type="checkbox" class="params-toolbar-toggle vars-bulk-toggle" checked>
            ${t("kv.bulkEditor")}
          </label>
          <button class="icon-btn params-toolbar-btn vars-add-btn" title="${t("vars.add")}" aria-label="${t("vars.add")}" style="display:none"><span class="icon">${icon("add", { size: 15 })}</span></button>
          <span class="vars-hint">${t("kv.varsHint")}</span>
        </div>
        <textarea
          class="body-text-editor vars-textarea"
          spellcheck="false"
          autocomplete="off"
          placeholder="${t("vars.bulkPlaceholder")}"
          aria-label="${t("vars.editorAria")}"
        ></textarea>
        <div class="vars-kv-wrap" style="display:none">
          <div class="vars-kv-header params-header-row">
            <span>${t("kv.name")}</span><span class="params-col-value">${t("kv.value")}</span><span></span><span></span>
          </div>
          <div class="vars-kv-list params-list" aria-label="${t("common.variables")}"></div>
        </div>
      </div>
      <div class="popup-footer vars-popup-footer">
        <button class="btn popup-btn btn--primary js-close"
                title="${t("vars.saveAndClose")}">${t("common.close")}</button>
      </div>
    `;

    this.#titleEl = el.querySelector(".vars-popup-title");
    this.#bulkToggleEl = el.querySelector(".vars-bulk-toggle");
    this.#textareaEl = el.querySelector(".vars-textarea");
    this.#kvWrapEl = el.querySelector(".vars-kv-wrap");
    this.#kvListEl = el.querySelector(".vars-kv-list");
    this.#closeHeaderBtn = el.querySelector(".popup-close");
    this.#closeFooterBtn = el.querySelector(".js-close");
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
      this.#textareaEl.value = this.#varsToText(this.#rowsToArray());
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

    this.#onBulkEditorChange?.({ bulkEditor: nowBulk });
  }

  // ── Conversion helpers ──────────────────────────────────────────────────────

  /**
   * Convert a canonical variables array to multi-line  name=value  text.
   * Secure variables are prefixed with "$ " (dollar + space) so the bulk
   * editor round-trips the secure flag.
   * @param {{name:string,value:string,secure:boolean}[]} vars
   * @returns {string}
   */
  #varsToText(vars) {
    return vars
      .map((v) => `${v.secure ? "$ " : ""}${v.name}=${v.value}`)
      .join("\n");
  }

  /**
   * Parse multi-line  name=value  text into a canonical variables array.
   * A leading "$ " (dollar + space) marks the variable secure. Lines without
   * '=' are silently ignored.
   * @param {string} text
   * @returns {{name:string,value:string,secure:boolean}[]}
   */
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

  /** Convert a canonical variables array to an editor rows array. */
  #varsToRows(vars) {
    return vars.map((v) => ({
      id: crypto.randomUUID(),
      name: v.name,
      value: v.value,
      secure: !!v.secure,
    }));
  }

  /** Serialise the editor rows back to a canonical variables array. */
  #rowsToArray() {
    const out = [];
    for (const r of this.#rows) {
      if (r.name.trim()) {
        out.push({ name: r.name, value: r.value, secure: !!r.secure });
      }
    }
    return out;
  }

  // ── KV row rendering ────────────────────────────────────────────────────────

  #renderRows() {
    this.#kvListEl.innerHTML = "";
    if (this.#rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "params-empty";
      empty.textContent = t("collections.variablesEmpty");
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
    nameIn.placeholder = t("kv.name");
    nameIn.value = row.name;
    nameIn.setAttribute("aria-label", t("vars.name"));
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
    valIn.placeholder = t("kv.value");
    valIn.value = row.value;
    valIn.setAttribute("aria-label", t("vars.value"));
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
      const action = revealed ? t("common.hideValue") : t("common.revealValue");
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
        }, VariablesPopup.#REVEAL_MS);
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
      secure.classList.toggle("params-secure-btn--active", !!row.secure);
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
    del.title = t("vars.delete");
    del.setAttribute("aria-label", t("vars.delete"));
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
    if (!this.#scopeId) return;
    this.#dispatchSave(this.#textToVars(this.#textareaEl.value));
  }

  #saveFromRows() {
    if (!this.#scopeId) return;
    this.#dispatchSave(this.#rowsToArray());
  }

  #dispatchSave(variables) {
    this.#onSave?.({ scopeId: this.#scopeId, variables });
  }

  // ── Close ───────────────────────────────────────────────────────────────────

  #doClose() {
    clearTimeout(this.#saveTimer);
    if (this.#isBulkMode) this.#saveFromBulk();
    else this.#saveFromRows();
    PopupManager.close();
  }
}
