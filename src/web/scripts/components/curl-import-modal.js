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
 * CurlImportModal — theme-styled modal with a paste box for importing a single
 * request from a raw `curl` command (e.g. a browser's "Copy as cURL"). The modal
 * only collects the pasted text and hands it to the async `onImport(text)`
 * callback; `app.js` owns parsing it (via `parseCurl`) and appending the result
 * as a new collection. Mirrors the structure and styling of `ExportModal`.
 *
 * `onImport` resolves `true` when the import succeeded (modal closes) and
 * `false` when it failed (modal stays open so the user can fix the paste — the
 * failure is surfaced as a notification by `app.js`). An empty paste is caught
 * locally and shown inline without invoking the callback.
 *
 * Open via the static factory:
 *   CurlImportModal.open(async (text) => true | false);
 */
export class CurlImportModal {
  #el;
  #onImport;
  #errorEl = null;
  #textarea = null;
  #busy = false;

  constructor({ onImport } = {}) {
    this.#onImport = onImport;
    this.#el = this.#build();
    this.#errorEl = this.#el.querySelector(".curl-import-error");
    this.#textarea = this.#el.querySelector(".curl-import-textarea");
    this.#bindEvents();
  }

  get element() {
    return this.#el;
  }

  /** Open the cURL paste modal. */
  static open(onImport) {
    const modal = new CurlImportModal({ onImport });
    PopupManager.open(modal);
    // PopupManager focuses the first focusable (the close button) on the next
    // frame; override that here so the paste box gets focus instead.
    requestAnimationFrame(() => modal.focusInput());
  }

  /** Move focus into the paste box. */
  focusInput() {
    this.#textarea?.focus();
  }

  /** Called by PopupManager when the user clicks the overlay mask. */
  onMaskClick() {
    if (!this.#busy) PopupManager.close();
  }

  #build() {
    const title = t("curlImport.title");
    const el = document.createElement("div");
    el.className = "popup curl-import-modal";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", title);
    el.innerHTML = `
      <div class="popup-header">
        <span class="popup-title">${escapeHtml(title)}</span>
        <button class="popup-close" aria-label="${escapeHtml(t("common.close"))}" title="${escapeHtml(t("common.close"))}">${icon("close", { size: 13 })}</button>
      </div>
      <div class="popup-body backup-body">
        <p class="backup-intro">${escapeHtml(t("curlImport.intro"))}</p>
        <textarea class="curl-import-textarea" spellcheck="false" autocomplete="off"
          aria-label="${escapeHtml(t("curlImport.aria"))}"
          placeholder="${escapeHtml(t("curlImport.placeholder"))}"></textarea>
        <div class="curl-import-error backup-error" role="alert" aria-live="polite"></div>
      </div>
      <div class="popup-footer">
        <button class="btn popup-btn btn--secondary js-cancel">${escapeHtml(t("common.cancel"))}</button>
        <button class="btn popup-btn btn--primary js-submit">${escapeHtml(t("curlImport.submit"))}</button>
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

    this.#textarea.addEventListener("keydown", (e) => {
      // Cmd/Ctrl+Enter submits; plain Enter inserts a newline (multi-line paste).
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.#submit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.onMaskClick();
      }
    });
    this.#textarea.addEventListener("input", () => this.#clearError());
  }

  #clearError() {
    if (this.#errorEl) this.#errorEl.textContent = "";
  }

  #setError(message) {
    if (this.#errorEl) this.#errorEl.textContent = message;
  }

  async #submit() {
    if (this.#busy) return;
    const text = this.#textarea.value.trim();
    if (!text) {
      this.#setError(t("curlImport.empty"));
      this.#textarea.focus();
      return;
    }

    this.#setBusy(true);
    try {
      // The callback parses + persists; it returns true to close and false to
      // keep the modal open (the failure was already surfaced by app.js).
      const ok = await this.#onImport?.(text);
      if (ok) PopupManager.close();
    } catch {
      // Defensive: app.js surfaces failures via Notifications; keep the modal.
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
    if (this.#textarea) this.#textarea.disabled = busy;
  }
}
