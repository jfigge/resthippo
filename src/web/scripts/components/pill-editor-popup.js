"use strict";

import { PopupManager } from "../popup-manager.js";
import { resolveVariable } from "./variable-resolver.js";

const TYPE_LABELS = {
  variable: "Variable",
};

const VAR_RE = /^\{\{([^{}]+)\}\}$/;

/**
 * PillEditorPopup — modal editor for inline variable (and future function) pills.
 *
 * Open via the static factory:
 *   PillEditorPopup.open({ type, rawValue, getContext, onCommit, sections });
 *
 * Config shape:
 *   type       — "variable" (other types TBD, e.g. "function")
 *   rawValue   — current pill value, e.g. "{{token}}"
 *   getContext — () => { envVariables, folderChain }  for live preview resolution
 *   onCommit   — (newRawValue: string) => void  called on Done/Enter; not called on Cancel
 *   sections   — Array<{ html: string }>  extra DOM sections inserted above the divider
 *                (reserved for function parameter editors — see FUNCTION_PILLS_DESIGN.md)
 */
export class PillEditorPopup {
  #el;
  #type;
  #getContext;
  #onCommit;
  #inputEl        = null;
  #errorEl        = null;
  #previewValueEl = null;

  constructor({ type = "variable", rawValue = "", getContext = () => null, onCommit = null, sections = [] } = {}) {
    this.#type       = type;
    this.#getContext = getContext;
    this.#onCommit   = onCommit;
    this.#el         = this.#build({ type, rawValue, sections });
    this.#inputEl    = this.#el.querySelector(".pill-editor-input");
    this.#errorEl    = this.#el.querySelector(".pill-editor-error");
    this.#previewValueEl = this.#el.querySelector(".pill-editor-preview-value");
    this.#bindEvents();
    this.#updatePreview();
  }

  get element() { return this.#el; }

  /** Factory — build, open via PopupManager, and focus the input. */
  static open(config) {
    const popup = new PillEditorPopup(config);
    PopupManager.open(popup);
    requestAnimationFrame(() => {
      const input = popup.#inputEl;
      if (input) {
        input.focus();
        input.select();
      }
    });
  }

  /** Called by PopupManager when user clicks the overlay mask. */
  onMaskClick() {
    PopupManager.close();
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  #build({ type, rawValue, sections }) {
    const label = TYPE_LABELS[type] ?? type;
    const el    = document.createElement("div");
    el.className = "popup pill-editor-popup";
    el.setAttribute("role",       "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", `${label} editor`);

    const sectionsHtml = sections.map(s => s.html ?? "").join("");

    el.innerHTML = `
      <div class="popup-header">
        <span class="popup-title">${this.#esc(label)} editor</span>
        <button class="popup-close" aria-label="Close" title="Close">✕</button>
      </div>
      <div class="popup-body pill-editor-body">
        <div class="pill-editor-field-row">
          <span class="pill-editor-type-label">${this.#esc(label)}</span>
          <input
            class="pill-editor-input settings-input"
            type="text"
            value="${this.#esc(rawValue)}"
            spellcheck="false"
            autocomplete="off"
          />
        </div>
        <div class="pill-editor-error" role="alert" aria-live="polite"></div>
        ${sectionsHtml}
        <hr class="pill-editor-divider" />
        <div class="pill-editor-preview">
          <span class="pill-editor-preview-label">Live Preview</span>
          <span class="pill-editor-preview-value pill-editor-preview--undefined">—</span>
        </div>
      </div>
      <div class="popup-footer">
        <button class="popup-btn popup-btn--secondary js-cancel">Cancel</button>
        <button class="popup-btn popup-btn--primary   js-done">Done</button>
      </div>
    `;
    return el;
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  #bindEvents() {
    this.#inputEl.addEventListener("input", () => {
      this.#clearError();
      this.#updatePreview();
    });

    this.#inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.#tryCommit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        PopupManager.close();
      }
    });

    this.#el.querySelector(".popup-close").addEventListener("click", () => PopupManager.close());
    this.#el.querySelector(".js-cancel").addEventListener("click",  () => PopupManager.close());
    this.#el.querySelector(".js-done").addEventListener("click",    () => this.#tryCommit());
  }

  // ── Commit ─────────────────────────────────────────────────────────────────

  #tryCommit() {
    const raw = this.#inputEl.value.trim();

    if (this.#type === "variable") {
      if (!VAR_RE.test(raw)) {
        this.#showError("Must be in the form {{variableName}}");
        this.#inputEl.focus();
        return;
      }
    }

    PopupManager.close();
    this.#onCommit?.(raw);
  }

  // ── Live preview ───────────────────────────────────────────────────────────

  #updatePreview() {
    if (!this.#previewValueEl) return;
    const raw = this.#inputEl.value.trim();

    if (this.#type === "variable") {
      const match = VAR_RE.exec(raw);
      if (!match) {
        this.#setPreview(null);
        return;
      }
      const { found, value } = resolveVariable(match[1], this.#getContext());
      this.#setPreview(found ? String(value ?? "") : null);
    } else {
      this.#setPreview(null);
    }
  }

  #setPreview(value) {
    if (value === null) {
      this.#previewValueEl.textContent = "Undefined";
      this.#previewValueEl.classList.add("pill-editor-preview--undefined");
    } else {
      this.#previewValueEl.textContent = value === "" ? "(empty string)" : value;
      this.#previewValueEl.classList.remove("pill-editor-preview--undefined");
    }
  }

  // ── Error ──────────────────────────────────────────────────────────────────

  #showError(msg) {
    if (!this.#errorEl) return;
    this.#errorEl.textContent = msg;
  }

  #clearError() {
    if (!this.#errorEl) return;
    this.#errorEl.textContent = "";
  }

  // ── Utils ──────────────────────────────────────────────────────────────────

  #esc(s) {
    return String(s ?? "")
      .replace(/&/g,  "&amp;")
      .replace(/</g,  "&lt;")
      .replace(/>/g,  "&gt;")
      .replace(/"/g,  "&quot;");
  }
}
