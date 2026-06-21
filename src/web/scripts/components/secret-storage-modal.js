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

"use strict";

import { PopupManager } from "../popup-manager.js";
import { icon } from "../icons.js";
import { escapeHtml } from "../utils/html.js";
import { t } from "../i18n.js";

/**
 * SecretStorageModal — branded "Unlock secrets" dialog for the master-password
 * backend. Shown when a secret is needed but the session is locked (e.g. the
 * "Unlock" affordance on a locked auth field). The renderer holds the plaintext
 * password only long enough to hand it to main, which derives the key, verifies
 * it, and (on success) reloads the window so every panel re-reads decrypted
 * secrets. (Switching INTO master-password mode is handled inline in the Settings
 * → Security panel, not here.)
 *
 * Open from a context where no popup is already active (PopupManager.open would
 * otherwise detach it):
 *   SecretStorageModal.openUnlock();
 */
export class SecretStorageModal {
  #el;
  #errorEl = null;
  #busy = false;

  constructor() {
    this.#el = this.#build();
    this.#errorEl = this.#el.querySelector(".secret-modal-error");
    this.#bindEvents();
  }

  get element() {
    return this.#el;
  }

  static openUnlock() {
    PopupManager.open(new SecretStorageModal());
  }

  onMaskClick() {
    if (!this.#busy) PopupManager.close();
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  #build() {
    const title = t("settings.security.unlockTitle");
    const el = document.createElement("div");
    el.className = "popup secret-modal";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", title);
    el.innerHTML = `
      <div class="popup-header">
        <span class="popup-title">${escapeHtml(title)}</span>
        <button class="popup-close" aria-label="${escapeHtml(t("common.close"))}" title="${escapeHtml(t("common.close"))}">${icon("close", { size: 13 })}</button>
      </div>
      <div class="popup-body secret-modal-body">
        <p class="secret-modal-intro">${escapeHtml(t("settings.security.unlockIntro"))}</p>
        <label class="secret-modal-field">
          <span class="secret-modal-label">${escapeHtml(t("settings.security.password"))}</span>
          <input class="settings-input js-pw" type="password" autocomplete="off" spellcheck="false" />
        </label>
        <div class="secret-modal-error" role="alert" aria-live="polite"></div>
      </div>
      <div class="popup-footer">
        <button class="btn popup-btn btn--secondary js-cancel">${escapeHtml(t("common.cancel"))}</button>
        <button class="btn popup-btn btn--primary js-submit">${escapeHtml(t("settings.security.unlock"))}</button>
      </div>
    `;
    return el;
  }

  // ── Events ─────────────────────────────────────────────────────────────────

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

    const input = this.#el.querySelector(".js-pw");
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
    requestAnimationFrame(() => input.focus());
  }

  // ── Submit ─────────────────────────────────────────────────────────────────

  async #submit() {
    if (this.#busy) return;
    const pw = this.#el.querySelector(".js-pw").value;
    if (!pw) {
      this.#showError(t("settings.security.error.passwordRequired"));
      return;
    }
    this.#setBusy(true);
    try {
      const res = await window.hippo.secretStorage.unlock(pw);
      if (res && res.ok) return; // success reloads the window
      this.#showError(
        res && res.reason === "bad-password"
          ? t("settings.security.error.badPassword")
          : t("settings.security.error.generic"),
      );
      const input = this.#el.querySelector(".js-pw");
      input.value = "";
      input.focus();
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
