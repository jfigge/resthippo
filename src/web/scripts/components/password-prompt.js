"use strict";

import { PopupManager } from "../popup-manager.js";
import { icon } from "../icons.js";
import { escapeHtml } from "../utils/html.js";
import { t } from "../i18n.js";

/**
 * PasswordPrompt — a small modal that collects a password. Two variants:
 *
 *   "create" — set a new password (password + confirmation), used when exporting
 *              a Rest Hippo v1 archive whose secrets must be encrypted.
 *   "enter"  — type an existing password (single field), used when importing a
 *              password-protected archive. Stays open on a wrong password so the
 *              caller can re-prompt.
 *
 * The caller does the real work in `onSubmit(password)` and returns `{ ok }` (or
 * `{ ok:false, error }` to keep the modal open with an inline error). It reuses
 * the Backup modal's CSS so it matches the rest of the app without new styles.
 *
 *   PasswordPrompt.open({ variant, onSubmit });
 */
export class PasswordPrompt {
  #el;
  #variant; // "create" | "enter"
  #onSubmit;
  #errorEl = null;
  #busy = false;

  constructor({ variant = "enter", onSubmit } = {}) {
    this.#variant = variant;
    this.#onSubmit = onSubmit;
    this.#el = this.#build();
    this.#errorEl = this.#el.querySelector(".backup-error");
    this.#bindEvents();
  }

  get element() {
    return this.#el;
  }

  /** Open a password prompt. @param {{ variant?: "create"|"enter", onSubmit: Function }} opts */
  static open(opts) {
    PopupManager.open(new PasswordPrompt(opts));
  }

  /** Called by PopupManager when the user clicks the overlay mask. */
  onMaskClick() {
    if (!this.#busy) PopupManager.close();
  }

  #build() {
    const create = this.#variant === "create";
    const title = create
      ? t("passwordPrompt.exportTitle")
      : t("passwordPrompt.importTitle");
    const intro = create
      ? t("passwordPrompt.exportIntro")
      : t("passwordPrompt.importIntro");
    const submit = create
      ? t("export.submit")
      : t("passwordPrompt.submitImport");
    const confirmField = create
      ? `
            <label class="backup-field">
              <span class="backup-field-label">${escapeHtml(t("backup.confirmPassword"))}</span>
              <input class="settings-input backup-input js-pw-confirm" type="password" autocomplete="new-password" spellcheck="false" />
            </label>`
      : "";

    const el = document.createElement("div");
    el.className = "popup backup-modal password-prompt-modal";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", title);
    el.innerHTML = `
      <div class="popup-header">
        <span class="popup-title">${escapeHtml(title)}</span>
        <button class="popup-close" aria-label="${escapeHtml(t("common.close"))}" title="${escapeHtml(t("common.close"))}">${icon("close", { size: 13 })}</button>
      </div>
      <div class="popup-body backup-body">
        <p class="backup-intro">${escapeHtml(intro)}</p>
        <div class="backup-pw-fields">
          <label class="backup-field">
            <span class="backup-field-label">${escapeHtml(t("backup.password"))}</span>
            <input class="settings-input backup-input js-pw" type="password" autocomplete="${create ? "new-password" : "off"}" spellcheck="false" />
          </label>${confirmField}
        </div>
        <div class="backup-error" role="alert" aria-live="polite"></div>
      </div>
      <div class="popup-footer">
        <button class="btn popup-btn btn--secondary js-cancel">${escapeHtml(t("common.cancel"))}</button>
        <button class="btn popup-btn btn--primary js-submit">${escapeHtml(submit)}</button>
      </div>
    `;
    return el;
  }

  #bindEvents() {
    this.#el
      .querySelector(".popup-close")
      .addEventListener("click", () => this.onMaskClick());
    this.#el
      .querySelector(".js-cancel")
      .addEventListener("click", () => this.onMaskClick());
    this.#el
      .querySelector(".js-submit")
      .addEventListener("click", () => this.#submit());

    for (const input of this.#el.querySelectorAll(".backup-input")) {
      input.addEventListener("input", () => this.#clearError());
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.#submit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          this.onMaskClick();
        }
      });
    }
    requestAnimationFrame(() => this.#el.querySelector(".js-pw")?.focus());
  }

  async #submit() {
    if (this.#busy) return;
    const pw = this.#el.querySelector(".js-pw").value;
    if (!pw) {
      this.#showError(t("backup.error.passwordRequired"));
      return;
    }
    if (this.#variant === "create") {
      const confirm = this.#el.querySelector(".js-pw-confirm").value;
      if (pw !== confirm) {
        this.#showError(t("backup.error.passwordMismatch"));
        return;
      }
    }

    this.#setBusy(true);
    try {
      const res = (await this.#onSubmit?.(pw)) ?? { ok: true };
      if (res.ok) {
        PopupManager.close();
      } else {
        // Stay open for a retry (e.g. wrong password on import).
        this.#showError(res.error || t("backup.error.badPassword"));
        const pwInput = this.#el.querySelector(".js-pw");
        if (pwInput) {
          pwInput.value = "";
          pwInput.focus();
        }
      }
    } finally {
      this.#setBusy(false);
    }
  }

  #setBusy(busy) {
    this.#busy = busy;
    const submit = this.#el.querySelector(".js-submit");
    const cancel = this.#el.querySelector(".js-cancel");
    if (submit) submit.disabled = busy;
    if (cancel) cancel.disabled = busy;
  }

  #showError(msg) {
    if (this.#errorEl) this.#errorEl.textContent = msg;
  }

  #clearError() {
    if (this.#errorEl) this.#errorEl.textContent = "";
  }
}
