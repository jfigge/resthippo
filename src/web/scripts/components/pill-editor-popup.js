"use strict";

import { PopupManager } from "../popup-manager.js";
import { resolveVariable } from "./variable-resolver.js";

const TYPE_LABELS = {
  variable: "Variable",
  function: "Function",
};

/**
 * PillEditorPopup — modal editor for variable and function pills.
 *
 * Open via the static factory:
 *   PillEditorPopup.open({ type, rawValue, getContext, onCommit });
 *   PillEditorPopup.open({ type: "function", funcName, funcDef, rawArgs, getContext,
 *                          getItems, getPreview, onCommit });
 *
 * Config shape (variable):
 *   type       — "variable"
 *   rawValue   — current pill value, e.g. "{{token}}"
 *   getContext — () => { envVariables, folderChain }
 *   onCommit   — (newRawValue: string) => void  — called with "{{name}}"
 *
 * Config shape (function):
 *   type       — "function"
 *   funcName   — string, e.g. "now"
 *   funcDef    — registry entry: { label, category, params[] }
 *   rawArgs    — string[], current arg values (already unquoted)
 *   getContext — () => context object (passed to getPreview)
 *   getItems   — () => Array<{id, name}> for request-picker params
 *   getPreview — async (args: string[]) => string  for live preview
 *   onCommit   — (newRawToken: string) => void
 */
export class PillEditorPopup {
  #el;
  #type;
  #getContext;
  #onCommit;
  #funcName = null;
  #funcDef = null;
  #getPreview = null;
  #suggestionsEl = null; // variable type only
  #varNames = []; // variable type: all available names
  #selectedVarName = ""; // variable type: currently selected name
  #paramEls = []; // function type: one element per param
  #errorEl = null;
  #previewValueEl = null;
  #previewSeq = 0; // monotonic counter — guards against stale async preview results

  constructor({
    type = "variable",
    rawValue = "",
    getContext = () => null,
    onCommit = null,
    funcName = null,
    funcDef = null,
    rawArgs = [],
    getItems = () => [],
    getPreview = null,
  } = {}) {
    this.#type = type;
    this.#getContext = getContext;
    this.#onCommit = onCommit;
    this.#funcName = funcName;
    this.#funcDef = funcDef;
    this.#getPreview = getPreview;

    if (type === "variable") {
      this.#varNames = this.#collectVarNames(getContext());
    }

    const varName = type === "variable" ? this.#extractVarName(rawValue) : "";
    if (type === "variable") this.#selectedVarName = varName;
    this.#el = this.#build({ type, funcName, funcDef, rawArgs, getItems });

    if (type === "variable") {
      this.#suggestionsEl = this.#el.querySelector(
        ".pill-editor-var-suggestions",
      );
      this.#renderSuggestions();
    } else if (type === "function") {
      this.#paramEls = [
        ...this.#el.querySelectorAll(".pill-editor-param-input"),
      ];
    }

    this.#errorEl = this.#el.querySelector(".pill-editor-error");
    this.#previewValueEl = this.#el.querySelector(".pill-editor-preview-value");
    this.#bindEvents();
    this.#updatePreview();
  }

  get element() {
    return this.#el;
  }

  /** Factory — build, open via PopupManager, and focus the first interactive field. */
  static open(config) {
    const popup = new PillEditorPopup(config);
    PopupManager.open(popup);
    requestAnimationFrame(() => {
      if (popup.#type === "function") {
        const target = popup.#paramEls[0];
        if (target) {
          target.focus();
          if (target.tagName === "INPUT") target.select();
        }
      } else if (popup.#type === "variable") {
        popup.#suggestionsEl?.focus();
      }
    });
  }

  /** Called by PopupManager when user clicks the overlay mask. */
  onMaskClick() {
    PopupManager.close();
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  #build({ type, funcName, funcDef, rawArgs, getItems }) {
    const label = TYPE_LABELS[type] ?? type;
    const el = document.createElement("div");
    el.className = "popup pill-editor-popup";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", `${label} editor`);

    const bodyHtml =
      type === "function"
        ? this.#functionBodyHtml(funcName, funcDef, rawArgs, getItems)
        : this.#variableBodyHtml();

    el.innerHTML = `
      <div class="popup-header">
        <span class="popup-title">${this.#esc(label)} editor</span>
        <button class="popup-close" aria-label="Close" title="Close"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button>
      </div>
      <div class="popup-body pill-editor-body">
        ${bodyHtml}
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

  #variableBodyHtml() {
    return `
      <span class="pill-editor-type-label">Select Variable</span>
      <div class="pill-editor-var-suggestions" role="listbox" aria-label="Available variables" tabindex="0"></div>
    `;
  }

  #functionBodyHtml(funcName, funcDef, rawArgs, getItems) {
    let paramsHtml;
    if (!funcDef?.params?.length) {
      paramsHtml = `<p class="pill-editor-no-params">This function has no parameters.</p>`;
    } else {
      paramsHtml = `<div class="pill-editor-params">${funcDef.params
        .map((p, i) => {
          const val = rawArgs[i] ?? p.default ?? "";
          let inputHtml;

          if (p.type === "enum") {
            const opts = (p.options ?? [])
              .map(
                (o) =>
                  `<option value="${this.#esc(o)}"${o === val ? " selected" : ""}>${this.#esc(o)}</option>`,
              )
              .join("");
            inputHtml = `<select class="pill-editor-param-input settings-input" data-param-idx="${i}">${opts}</select>`;
          } else if (p.type === "request-picker") {
            const items = getItems ? getItems() : [];
            const opts = items
              .map(
                (item) =>
                  `<option value="${this.#esc(item.name)}"${item.name === val ? " selected" : ""}>${this.#esc(item.name)}</option>`,
              )
              .join("");
            inputHtml =
              `<select class="pill-editor-param-input settings-input" data-param-idx="${i}">` +
              `<option value="">— select request —</option>${opts}</select>`;
          } else {
            const ph = p.placeholder
              ? ` placeholder="${this.#esc(p.placeholder)}"`
              : "";
            inputHtml =
              `<input class="pill-editor-param-input settings-input" type="text"` +
              ` value="${this.#esc(val)}" autocomplete="off" spellcheck="false"` +
              ` data-param-idx="${i}"${ph} />`;
          }

          return `
            <div class="pill-editor-param-row">
              <label class="pill-editor-param-label">${this.#esc(p.label)}</label>
              ${inputHtml}
            </div>`;
        })
        .join("")}</div>`;
    }

    return `
      <div class="pill-editor-func-header">
        <span class="pill-editor-func-name">${this.#esc(funcName ?? "")}</span>
        <span class="pill-editor-func-label">${this.#esc(funcDef?.label ?? "")}</span>
      </div>
      ${paramsHtml}
      <div class="pill-editor-error" role="alert" aria-live="polite"></div>
    `;
  }

  // ── Variable suggestions ───────────────────────────────────────────────────

  #renderSuggestions() {
    if (!this.#suggestionsEl) return;

    if (!this.#varNames.length) {
      this.#suggestionsEl.innerHTML = `<div class="pill-editor-var-empty">No variables defined</div>`;
      return;
    }

    this.#suggestionsEl.innerHTML = "";
    for (const name of this.#varNames) {
      const item = document.createElement("div");
      item.className = "pill-editor-var-item";
      item.setAttribute("role", "option");
      item.dataset.varName = name;
      item.textContent = name;
      if (name === this.#selectedVarName) {
        item.classList.add("pill-editor-var-item--active");
        item.setAttribute("aria-selected", "true");
      }
      item.addEventListener("click", () => this.#selectVar(name));
      this.#suggestionsEl.appendChild(item);
    }

    this.#scrollActiveIntoView();
  }

  #selectVar(name) {
    this.#selectedVarName = name;
    this.#updatePreview();
    for (const el of this.#suggestionsEl.querySelectorAll(
      ".pill-editor-var-item",
    )) {
      const active = el.dataset.varName === name;
      el.classList.toggle("pill-editor-var-item--active", active);
      el.setAttribute("aria-selected", String(active));
    }
    this.#scrollActiveIntoView();
  }

  #scrollActiveIntoView() {
    const active = this.#suggestionsEl?.querySelector(
      ".pill-editor-var-item--active",
    );
    active?.scrollIntoView({ block: "nearest" });
  }

  #collectVarNames(ctx) {
    const seen = new Set();
    if (ctx?.folderChain) {
      for (const folder of ctx.folderChain) {
        if (folder?.variables)
          Object.keys(folder.variables)
            .sort()
            .forEach((k) => seen.add(k));
      }
    }
    if (ctx?.envVariables)
      Object.keys(ctx.envVariables)
        .sort()
        .forEach((k) => seen.add(k));
    return [...seen];
  }

  #extractVarName(rawValue) {
    const m = /^\{\{([^{}]+)\}\}$/.exec(rawValue ?? "");
    return m ? m[1] : (rawValue ?? "").replace(/^\{\{|\}\}$/g, "");
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  #bindEvents() {
    if (this.#type === "variable" && this.#suggestionsEl) {
      this.#suggestionsEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.#tryCommit();
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          PopupManager.close();
          return;
        }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const idx = this.#varNames.indexOf(this.#selectedVarName);
          const next =
            e.key === "ArrowDown"
              ? Math.min(idx + 1, this.#varNames.length - 1)
              : Math.max(idx - 1, 0);
          if (this.#varNames[next] !== undefined)
            this.#selectVar(this.#varNames[next]);
        }
      });
    } else if (this.#type === "function") {
      for (const el of this.#paramEls) {
        el.addEventListener("input", () => {
          this.#clearError();
          this.#updatePreview();
        });
        el.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            this.#tryCommit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            PopupManager.close();
          }
        });
      }
    }

    this.#el
      .querySelector(".popup-close")
      .addEventListener("click", () => PopupManager.close());
    this.#el
      .querySelector(".js-cancel")
      .addEventListener("click", () => PopupManager.close());
    this.#el
      .querySelector(".js-done")
      .addEventListener("click", () => this.#tryCommit());
  }

  // ── Commit ─────────────────────────────────────────────────────────────────

  #tryCommit() {
    if (this.#type === "variable") {
      if (!this.#selectedVarName) return;
      PopupManager.close();
      this.#onCommit?.(`{{${this.#selectedVarName}}}`);
    } else if (this.#type === "function") {
      const args = this.#getParamArgs();
      const rawToken = this.#buildFuncToken(this.#funcName, args);
      PopupManager.close();
      this.#onCommit?.(rawToken);
    }
  }

  #getParamArgs() {
    return this.#paramEls.map((el) => el.value);
  }

  #buildFuncToken(name, args) {
    if (!args.length) return `{{${name}()}}`;
    const argStrs = args
      .map((a) => `"${String(a).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
      .join(", ");
    return `{{${name}(${argStrs})}}`;
  }

  // ── Live preview ───────────────────────────────────────────────────────────

  async #updatePreview() {
    if (!this.#previewValueEl) return;
    const seq = ++this.#previewSeq;

    if (this.#type === "variable") {
      const name = this.#selectedVarName;
      if (!name) {
        this.#setPreview(null);
        return;
      }
      const { found, value } = resolveVariable(name, this.#getContext());
      if (seq === this.#previewSeq)
        this.#setPreview(found ? String(value ?? "") : null);
    } else if (this.#type === "function" && this.#getPreview) {
      try {
        const result = await this.#getPreview(this.#getParamArgs());
        if (seq === this.#previewSeq)
          this.#setPreview(result != null ? String(result) : null);
      } catch {
        if (seq === this.#previewSeq) this.#setPreview(null);
      }
    } else {
      this.#setPreview(null);
    }
  }

  #setPreview(value) {
    if (value === null) {
      this.#previewValueEl.textContent = "Undefined";
      this.#previewValueEl.classList.add("pill-editor-preview--undefined");
    } else {
      this.#previewValueEl.textContent =
        value === "" ? "(empty string)" : value;
      this.#previewValueEl.classList.remove("pill-editor-preview--undefined");
    }
  }

  // ── Error ──────────────────────────────────────────────────────────────────

  #clearError() {
    if (!this.#errorEl) return;
    this.#errorEl.textContent = "";
  }

  // ── Utils ──────────────────────────────────────────────────────────────────

  #esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
}
