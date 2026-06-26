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
 * SwaggerUrlImportModal — theme-styled modal that imports an OpenAPI/Swagger spec
 * straight from a live URL instead of a local file. It collects the document URL
 * and an optional auth header (a bare token is sent as `Authorization`, or a
 * `Name: Value` line as a custom header) and hands them to the async
 * `onImport(url, header)` callback; `app.js` owns the fetch (via the main-process
 * request engine — no browser CORS), format detection, and the rest of the
 * OpenAPI import flow. Mirrors the structure and styling of `CurlImportModal`.
 *
 * `onImport` resolves `true` when the spec was fetched and recognized (the modal
 * closes; `app.js` then runs the base-URL prompt + import) and `false` when the
 * fetch failed or the URL didn't return an OpenAPI/Swagger document (the modal
 * stays open so the user can fix the URL — the failure is surfaced as a
 * notification by `app.js`). An empty or non-http(s) URL is caught locally and
 * shown inline without invoking the callback.
 *
 * Open via the static factory:
 *   SwaggerUrlImportModal.open(async (url, header) => true | false);
 */
export class SwaggerUrlImportModal {
  #el;
  #onImport;
  #errorEl = null;
  #urlInput = null;
  #headerInput = null;
  #busy = false;

  constructor({ onImport } = {}) {
    this.#onImport = onImport;
    this.#el = this.#build();
    this.#errorEl = this.#el.querySelector(".swagger-url-error");
    this.#urlInput = this.#el.querySelector(".swagger-url-input");
    this.#headerInput = this.#el.querySelector(".swagger-url-header-input");
    this.#bindEvents();
  }

  get element() {
    return this.#el;
  }

  /** Open the URL import modal. */
  static open(onImport) {
    const modal = new SwaggerUrlImportModal({ onImport });
    PopupManager.open(modal);
    // PopupManager focuses the first focusable (the close button) on the next
    // frame; override that here so the URL field gets focus instead.
    requestAnimationFrame(() => modal.focusInput());
  }

  /** Move focus into the URL field. */
  focusInput() {
    this.#urlInput?.focus();
  }

  /** Called by PopupManager when the user clicks the overlay mask. */
  onMaskClick() {
    if (!this.#busy) PopupManager.close();
  }

  #build() {
    const title = t("urlImport.title");
    const el = document.createElement("div");
    el.className = "popup swagger-url-import-modal";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", title);
    el.innerHTML = `
      <div class="popup-header">
        <span class="popup-title">${escapeHtml(title)}</span>
        <button class="popup-close" aria-label="${escapeHtml(t("common.close"))}" title="${escapeHtml(t("common.close"))}">${icon("close", { size: 13 })}</button>
      </div>
      <div class="popup-body backup-body">
        <p class="backup-intro">${escapeHtml(t("urlImport.intro"))}</p>
        <label class="backup-field">
          <span class="backup-field-label">${escapeHtml(t("urlImport.urlLabel"))}</span>
          <input class="settings-input swagger-url-input" type="text" inputmode="url"
            spellcheck="false" autocomplete="off" autocapitalize="off"
            aria-label="${escapeHtml(t("urlImport.urlLabel"))}"
            placeholder="${escapeHtml(t("urlImport.urlPlaceholder"))}" />
        </label>
        <label class="backup-field">
          <span class="backup-field-label">${escapeHtml(t("urlImport.headerLabel"))}</span>
          <input class="settings-input swagger-url-header-input" type="text"
            spellcheck="false" autocomplete="off" autocapitalize="off"
            aria-label="${escapeHtml(t("urlImport.headerLabel"))}"
            placeholder="${escapeHtml(t("urlImport.headerPlaceholder"))}" />
        </label>
        <div class="swagger-url-error backup-error" role="alert" aria-live="polite"></div>
      </div>
      <div class="popup-footer">
        <button class="btn popup-btn btn--secondary js-cancel">${escapeHtml(t("common.cancel"))}</button>
        <button class="btn popup-btn btn--primary js-submit">${escapeHtml(t("urlImport.submit"))}</button>
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

    for (const input of [this.#urlInput, this.#headerInput]) {
      input?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.#submit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          this.onMaskClick();
        }
      });
      input?.addEventListener("input", () => this.#clearError());
    }
  }

  #clearError() {
    if (this.#errorEl) this.#errorEl.textContent = "";
  }

  #setError(message) {
    if (this.#errorEl) this.#errorEl.textContent = message;
  }

  async #submit() {
    if (this.#busy) return;
    const url = this.#urlInput.value.trim();
    if (!url) {
      this.#setError(t("urlImport.empty"));
      this.#urlInput.focus();
      return;
    }
    // Only http(s) is fetchable, and rejecting other schemes (file:, ftp:, …)
    // keeps a pasted URL from reaching the local filesystem via the request
    // engine. Loopback / private hosts are intentionally allowed — importing
    // from a locally-running API server is a legitimate use case.
    if (!/^https?:\/\//i.test(url)) {
      this.#setError(t("urlImport.errScheme"));
      this.#urlInput.focus();
      return;
    }

    const header = this.#headerInput.value.trim();

    this.#setBusy(true);
    try {
      // The callback fetches + parses; it returns true to close (app.js then
      // runs the base-URL prompt) and false to keep the modal open (the failure
      // was already surfaced by app.js).
      const ok = await this.#onImport?.(url, header);
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
    if (this.#urlInput) this.#urlInput.disabled = busy;
    if (this.#headerInput) this.#headerInput.disabled = busy;
  }
}
