/**
 * variables-popup.js — Key/Value variable editor popup
 *
 * A resizable dialog that lets the user edit a set of variables stored as a
 * flat JSON key/value object.  The same popup is reused for any variable scope
 * (global, environment, folder, request) — only the `title` and `variables`
 * payload differ.
 *
 * Features:
 *   • Live JSON validation with a ✓ valid / ✗ invalid badge (same logic as
 *     the request-editor JSON body validator).
 *   • Auto-save (debounced) whenever the JSON is valid.
 *   • Reset button with an inline confirm pattern (one click → "Confirm?";
 *     second click → restores the JSON that was loaded when the popup opened;
 *     click elsewhere / Escape → cancel).
 *   • Close button — flushes any pending valid save then closes.
 *   • User-resizable via CSS `resize: both`.
 *
 * Events dispatched on window:
 *   wurl:vars-save  { envId, variables }  — a valid JSON object was saved
 */

"use strict";

import { PopupManager } from "../popup-manager.js";

export class VariablesPopup {
  /** @type {HTMLElement} */
  #el;
  /** @type {HTMLElement} */
  #titleEl;
  /** @type {HTMLTextAreaElement} */
  #textareaEl;
  /** @type {HTMLElement} */
  #badgeEl;
  /** @type {HTMLButtonElement} */
  #resetBtn;
  /** @type {HTMLButtonElement} */
  #closeBtnEl;
  /** @type {HTMLButtonElement} */
  #closeHeaderBtn;

  /** @type {string|null} */
  #envId = null;

  /** The JSON string that was loaded when the popup opened — used by Reset. */
  #initialJson = "{}";

  /** @type {number|null} */
  #validateTimer = null;
  /** @type {number|null} */
  #saveTimer = null;

  /**
   * Cleanup function installed while the Reset button is in "Confirm?" state.
   * Null when the button is in its normal state.
   * @type {Function|null}
   */
  #resetCleanup = null;

  static #VALIDATE_MS = 400;
  static #SAVE_MS     = 600;

  constructor() {
    this.#el = this.#build();
  }

  /** Root DOM element — required by PopupManager. */
  get element() {
    return this.#el;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Open the popup seeded with an environment's current variables.
   *
   * @param {{
   *   envId:     string,
   *   envName:   string,
   *   variables: object,
   * }} opts
   */
  open({ envId, envName, variables }) {
    this.#envId = envId;

    // Dynamic title so users know which scope they're editing
    this.#titleEl.textContent = `Variables — ${envName}`;
    this.#el.setAttribute("aria-label", `Variables — ${envName}`);

    // Populate editor with prettified JSON (or empty object on first use)
    const vars = (variables && typeof variables === "object" && !Array.isArray(variables))
      ? variables
      : {};
    this.#textareaEl.value = Object.keys(vars).length > 0
      ? JSON.stringify(vars, null, 2)
      : "{}";

    // Snapshot the initial content so Reset can restore it exactly
    this.#initialJson = this.#textareaEl.value;

    // Reset transient state
    this.#cancelResetConfirm();
    clearTimeout(this.#validateTimer);
    clearTimeout(this.#saveTimer);

    // Validate whatever content we just loaded
    this.#validateNow();

    PopupManager.open(this);
    requestAnimationFrame(() => this.#textareaEl.focus());
  }

  /** Called by PopupManager when the user clicks the overlay mask. */
  onMaskClick() {
    if (this.#closeBtnEl?.disabled) return; // block close while JSON is invalid
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
      </div>
      <div class="popup-footer vars-popup-footer">
        <button class="popup-btn popup-btn--secondary vars-reset-btn" title="Reset variables to the values they had when this dialog was opened">Reset</button>
        <button class="popup-btn popup-btn--primary  vars-close-btn">Close</button>
      </div>
    `;

    this.#titleEl        = el.querySelector(".vars-popup-title");
    this.#textareaEl     = el.querySelector(".vars-textarea");
    this.#badgeEl        = el.querySelector(".vars-validate-badge");
    this.#resetBtn       = el.querySelector(".vars-reset-btn");
    this.#closeBtnEl     = el.querySelector(".vars-close-btn");
    this.#closeHeaderBtn = el.querySelector(".popup-close");

    // Header × close
    el.querySelector(".popup-close").addEventListener("click", () => this.#doClose());

    // Footer close
    el.querySelector(".vars-close-btn").addEventListener("click", () => this.#doClose());

    // Live validation + auto-save on any keystroke
    this.#textareaEl.addEventListener("input", () => {
      this.#scheduleValidate();
      this.#scheduleAutoSave();
    });

    // Reset with inline confirm
    this.#resetBtn.addEventListener("click", () => this.#handleReset());

    return el;
  }

  // ── Validation ──────────────────────────────────────────────────────────────

  #scheduleValidate() {
    clearTimeout(this.#validateTimer);
    this.#validateTimer = setTimeout(
      () => this.#validateNow(),
      VariablesPopup.#VALIDATE_MS,
    );
  }

  #validateNow() {
    const text = this.#textareaEl?.value ?? "";
    if (!text.trim()) {
      this.#applyValidity(null);
      return;
    }
    try {
      const parsed = JSON.parse(text);
      const isObj  = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
      this.#applyValidity(isObj ? "valid" : "invalid");
    } catch (_) {
      this.#applyValidity("invalid");
    }
  }

  /**
   * Apply a validation state to the badge element.
   * @param {"valid"|"invalid"|null} state
   */
  #applyValidity(state) {
    if (!this.#badgeEl) return;
    this.#badgeEl.dataset.state = state ?? "";
    if (state === "valid") {
      this.#badgeEl.textContent = "✓ valid";
      this.#badgeEl.title = "JSON is valid";
    } else if (state === "invalid") {
      this.#badgeEl.textContent = "✗ invalid";
      this.#badgeEl.title = "Must be a valid JSON object { \"key\": \"value\" }";
    } else {
      this.#badgeEl.textContent = "";
      this.#badgeEl.title = "";
    }

    // Close is only allowed when the content is valid (or empty/untouched)
    const canClose = state !== "invalid";
    if (this.#closeBtnEl)     this.#closeBtnEl.disabled     = !canClose;
    if (this.#closeHeaderBtn) this.#closeHeaderBtn.disabled = !canClose;
  }

  // ── Auto-save ───────────────────────────────────────────────────────────────

  #scheduleAutoSave() {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(
      () => this.#trySave(),
      VariablesPopup.#SAVE_MS,
    );
  }

  /**
   * Parse the current textarea content and, if it is a valid plain object,
   * dispatch the save event.
   * @returns {boolean} true if the save was dispatched
   */
  #trySave() {
    if (!this.#envId) return false;
    const text = this.#textareaEl?.value ?? "";
    if (!text.trim()) return false;
    try {
      const parsed = JSON.parse(text);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        this.#dispatchSave(parsed);
        return true;
      }
    } catch (_) { /* invalid JSON — skip */ }
    return false;
  }

  #dispatchSave(variables) {
    window.dispatchEvent(new CustomEvent("wurl:vars-save", {
      detail: { envId: this.#envId, variables },
      bubbles: true,
    }));
  }

  // ── Reset ───────────────────────────────────────────────────────────────────

  #handleReset() {
    if (this.#resetCleanup) {
      // ── Second click: commit the reset ──────────────────────────────────
      this.#cancelResetConfirm();

      this.#textareaEl.value = this.#initialJson;
      this.#validateNow();
      this.#trySave();
      return;
    }

    // ── First click: enter "Confirm?" state ──────────────────────────────
    this.#resetBtn.textContent = "Confirm?";
    this.#resetBtn.classList.remove("popup-btn--secondary");
    this.#resetBtn.classList.add("popup-btn--warning");

    const restore = () => {
      this.#resetBtn.textContent = "Reset";
      this.#resetBtn.classList.remove("popup-btn--warning");
      this.#resetBtn.classList.add("popup-btn--secondary");
      document.removeEventListener("keydown",   onEsc,     true);
      document.removeEventListener("mousedown", onOutside, true);
      this.#resetCleanup = null;
    };

    const onEsc = (e) => {
      if (e.key === "Escape") restore();
    };

    // Any click outside the Reset button (like on the mask or Close) cancels.
    const onOutside = (e) => {
      if (!this.#resetBtn.contains(e.target)) restore();
    };

    document.addEventListener("keydown",   onEsc,     true);
    document.addEventListener("mousedown", onOutside, true);
    this.#resetCleanup = restore;
  }

  #cancelResetConfirm() {
    if (this.#resetCleanup) {
      this.#resetCleanup();
    }
  }

  // ── Close ───────────────────────────────────────────────────────────────────

  #doClose() {
    // Flush any pending timers
    clearTimeout(this.#validateTimer);
    clearTimeout(this.#saveTimer);
    this.#cancelResetConfirm();

    // Persist any valid unsaved content before closing
    this.#trySave();

    PopupManager.close();
  }
}

