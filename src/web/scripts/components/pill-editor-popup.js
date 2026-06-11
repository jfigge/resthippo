"use strict";

import { PopupManager } from "../popup-manager.js";
import { icon } from "../icons.js";
import { escapeHtml } from "../utils/html.js";
import { t } from "../i18n.js";
import {
  resolveVariable,
  buildFunctionToken,
  collectScopeNames,
} from "./variable-resolver.js";

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
  #revealBtn = null; // eye toggle — shown only for secure variables
  #previewRaw = null; // last resolved value (null = undefined / not found)
  #previewSecure = false; // whether the resolved variable is stored as a secret
  #secretRevealed = false; // whether the secret is currently shown in clear text
  #secretRevealTimer = null; // auto-remask timer handle
  static #REVEAL_MS = 30000; // secrets auto-remask 30s after reveal

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
      this.#varNames = collectScopeNames(getContext());
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
    this.#revealBtn = this.#el.querySelector(".pill-editor-preview-reveal");
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
        <span class="popup-title">${escapeHtml(t("pillEditor.editorTitle", { label }))}</span>
        <button class="popup-close" aria-label="${t("common.close")}" title="${t("common.close")}">${icon("close", { size: 13 })}</button>
      </div>
      <div class="popup-body pill-editor-body">
        ${bodyHtml}
        <hr class="pill-editor-divider" />
        <div class="pill-editor-preview">
          <span class="pill-editor-preview-label">${t("pillEditor.livePreview")}</span>
          <span class="pill-editor-preview-value pill-editor-preview--undefined">—</span>
          <button class="pill-editor-preview-reveal secret-field-toggle" type="button" tabindex="-1" hidden></button>
        </div>
      </div>
      <div class="popup-footer">
        <button class="btn popup-btn btn--secondary js-cancel">${t("common.cancel")}</button>
        <button class="btn popup-btn btn--primary   js-done">${t("pillEditor.done")}</button>
      </div>
    `;
    return el;
  }

  #variableBodyHtml() {
    return `
      <span class="pill-editor-type-label">${t("pillEditor.title")}</span>
      <div class="pill-editor-var-suggestions" role="listbox" aria-label="${t("pillEditor.availableVars")}" tabindex="0"></div>
    `;
  }

  #functionBodyHtml(funcName, funcDef, rawArgs, getItems) {
    let paramsHtml;
    if (!funcDef?.params?.length) {
      paramsHtml = `<p class="pill-editor-no-params">${t("pillEditor.noParams")}</p>`;
    } else {
      paramsHtml = `<div class="pill-editor-params">${funcDef.params
        .map((p, i) => {
          const val = rawArgs[i] ?? p.default ?? "";
          let inputHtml;

          if (p.type === "enum") {
            const opts = (p.options ?? [])
              .map(
                (o) =>
                  `<option value="${escapeHtml(o)}"${o === val ? " selected" : ""}>${escapeHtml(o)}</option>`,
              )
              .join("");
            inputHtml = `<select class="pill-editor-param-input settings-input" data-param-idx="${i}">${opts}</select>`;
          } else if (p.type === "request-picker") {
            const items = getItems ? getItems() : [];
            const opts = items
              .map(
                (item) =>
                  `<option value="${escapeHtml(item.name)}"${item.name === val ? " selected" : ""}>${escapeHtml(item.name)}</option>`,
              )
              .join("");
            inputHtml =
              `<select class="pill-editor-param-input settings-input" data-param-idx="${i}">` +
              `<option value="">— select request —</option>${opts}</select>`;
          } else {
            const ph = p.placeholder
              ? ` placeholder="${escapeHtml(p.placeholder)}"`
              : "";
            inputHtml =
              `<input class="pill-editor-param-input settings-input" type="text"` +
              ` value="${escapeHtml(val)}" autocomplete="off" spellcheck="false"` +
              ` data-param-idx="${i}"${ph} />`;
          }

          return `
            <div class="pill-editor-param-row">
              <label class="pill-editor-param-label">${escapeHtml(t(p.labelKey))}</label>
              ${inputHtml}
            </div>`;
        })
        .join("")}</div>`;
    }

    return `
      <div class="pill-editor-func-header">
        <span class="pill-editor-func-name">${escapeHtml(funcName ?? "")}</span>
        <span class="pill-editor-func-label">${escapeHtml(funcDef?.labelKey ? t(funcDef.labelKey) : "")}</span>
      </div>
      ${paramsHtml}
      <div class="pill-editor-error" role="alert" aria-live="polite"></div>
    `;
  }

  // ── Variable suggestions ───────────────────────────────────────────────────

  #renderSuggestions() {
    if (!this.#suggestionsEl) return;

    if (!this.#varNames.length) {
      this.#suggestionsEl.innerHTML = `<div class="pill-editor-var-empty">${t("pillEditor.noVarsDefined")}</div>`;
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

    if (this.#revealBtn) {
      this.#revealBtn.addEventListener("click", () => this.#toggleReveal());
    }

    // Clear any pending auto-remask timer once the popup is dismissed (via any
    // path — Done, Cancel, Escape, or mask click).
    const onClosed = () => {
      this.#clearRevealTimer();
      window.removeEventListener("wurl:popup-closed", onClosed);
    };
    window.addEventListener("wurl:popup-closed", onClosed);
  }

  // ── Commit ─────────────────────────────────────────────────────────────────

  #tryCommit() {
    if (this.#type === "variable") {
      if (!this.#selectedVarName) return;
      PopupManager.close();
      this.#onCommit?.(`{{${this.#selectedVarName}}}`);
    } else if (this.#type === "function") {
      const args = this.#getParamArgs();
      const rawToken = buildFunctionToken(this.#funcName, args);
      PopupManager.close();
      this.#onCommit?.(rawToken);
    }
  }

  #getParamArgs() {
    return this.#paramEls.map((el) => el.value);
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
      const { found, value, secure } = resolveVariable(
        name,
        this.#getContext(),
      );
      if (seq === this.#previewSeq)
        this.#setPreview(found ? String(value ?? "") : null, secure);
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

  /**
   * Update the preview to show `value` (null = undefined / not found).
   * Secure variables are masked as `***` until the user reveals them via the
   * eye toggle; switching variables resets any in-progress reveal.
   *
   * @param {string|null} value
   * @param {boolean} [secure]
   */
  #setPreview(value, secure = false) {
    this.#previewRaw = value;
    this.#previewSecure = !!secure && value !== null;
    // Any selection change cancels a prior reveal so secrets never leak across
    // variables.
    this.#clearRevealTimer();
    this.#secretRevealed = false;
    this.#renderPreview();
  }

  /** Paint the preview value + eye toggle from the current state. */
  #renderPreview() {
    const value = this.#previewRaw;

    if (this.#revealBtn) this.#revealBtn.hidden = !this.#previewSecure;
    this.#updateRevealBtn();

    if (value === null) {
      this.#previewValueEl.textContent = t("pillEditor.undefined");
      this.#previewValueEl.classList.add("pill-editor-preview--undefined");
      return;
    }

    this.#previewValueEl.classList.remove("pill-editor-preview--undefined");
    if (this.#previewSecure && !this.#secretRevealed) {
      this.#previewValueEl.textContent = "***";
    } else {
      this.#previewValueEl.textContent =
        value === "" ? "(empty string)" : value;
    }
  }

  /** Reveal a masked secret for 30s, or re-mask immediately if already shown. */
  #toggleReveal() {
    if (!this.#previewSecure) return;
    if (this.#secretRevealed) {
      this.#clearRevealTimer();
      this.#secretRevealed = false;
      this.#renderPreview();
      return;
    }
    this.#secretRevealed = true;
    this.#renderPreview();
    this.#secretRevealTimer = setTimeout(() => {
      this.#secretRevealTimer = null;
      this.#secretRevealed = false;
      this.#renderPreview();
    }, PillEditorPopup.#REVEAL_MS);
  }

  /** Sync the eye toggle's icon / accessible label to the reveal state. */
  #updateRevealBtn() {
    if (!this.#revealBtn || this.#revealBtn.hidden) return;
    // Masked → offer "reveal" (open eye); revealed → offer "hide".
    this.#revealBtn.innerHTML = icon(this.#secretRevealed ? "eyeOff" : "eye");
    const action = this.#secretRevealed ? "Hide value" : "Reveal value";
    this.#revealBtn.title = action;
    this.#revealBtn.setAttribute("aria-label", action);
    this.#revealBtn.setAttribute("aria-pressed", String(this.#secretRevealed));
  }

  /** Cancel a pending auto-remask timer, if any. */
  #clearRevealTimer() {
    if (this.#secretRevealTimer) {
      clearTimeout(this.#secretRevealTimer);
      this.#secretRevealTimer = null;
    }
  }

  // ── Error ──────────────────────────────────────────────────────────────────

  #clearError() {
    if (!this.#errorEl) return;
    this.#errorEl.textContent = "";
  }

  // ── Utils ──────────────────────────────────────────────────────────────────
}
