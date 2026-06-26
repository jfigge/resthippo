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
 * SwaggerImportModal — theme-styled modal shown before an OpenAPI/Swagger import.
 * Specs describe operations as relative paths, so the import prefixes every
 * request with a `{{name}}` base-URL variable. This modal collects that variable
 * name (default `baseUrl`) and its value (pre-filled from the spec's server URL
 * when present, otherwise blank for the user to fill in later). `app.js` owns the
 * parsing; the modal only gathers the two values. Mirrors the structure and
 * styling of `CurlImportModal` / `BackupModal`.
 *
 * Open via the static factory, which resolves with the collected values or
 * `null` if the user cancels (so the caller can abort the import):
 *   const choice = await SwaggerImportModal.open({ defaultName, defaultValue });
 *   if (!choice) return;            // cancelled
 *   // choice.name, choice.value
 */
export class SwaggerImportModal {
  #el;
  #onSubmit;
  #onCancel;
  #nameInput = null;
  #valueInput = null;

  constructor({
    defaultName = "baseUrl",
    defaultValue = "",
    onSubmit,
    onCancel,
  } = {}) {
    this.#onSubmit = onSubmit;
    this.#onCancel = onCancel;
    this.#el = this.#build(defaultName, defaultValue);
    this.#nameInput = this.#el.querySelector(".js-name");
    this.#valueInput = this.#el.querySelector(".js-value");
    this.#bindEvents();
  }

  get element() {
    return this.#el;
  }

  /**
   * Open the prompt. Resolves with `{ name, value }` when the user confirms, or
   * `null` on any cancel path (Cancel/close button, mask click, Escape, or a
   * window-resize close — which `PopupManager` routes through `close()` directly,
   * bypassing `onMaskClick`). A single `settle` guard guarantees the awaiting
   * caller is resolved exactly once.
   */
  static open({ defaultName = "baseUrl", defaultValue = "" } = {}) {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const modal = new SwaggerImportModal({
        defaultName,
        defaultValue,
        onSubmit: (payload) => {
          settle(payload);
          PopupManager.close();
        },
        onCancel: () => {
          settle(null);
          PopupManager.close();
        },
      });
      // A resize (or any other) close fires hippo:popup-closed without calling
      // back into the modal — settle to null there so the caller never hangs.
      // Submit/cancel settle first, so this listener is then a no-op.
      window.addEventListener("hippo:popup-closed", () => settle(null), {
        once: true,
      });
      PopupManager.open(modal);
      // PopupManager focuses the first focusable (the close button); override so
      // the name field gets focus instead, with its contents selected.
      requestAnimationFrame(() => this.#focus(modal));
    });
  }

  /** Focus and select the name field of the given modal instance. */
  static #focus(modal) {
    modal.#nameInput?.focus();
    modal.#nameInput?.select();
  }

  /** Called by PopupManager when the user clicks the overlay mask. */
  onMaskClick() {
    this.#onCancel?.();
  }

  #build(defaultName, defaultValue) {
    const title = t("swaggerImport.title");
    const el = document.createElement("div");
    el.className = "popup swagger-import-modal";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", title);
    el.innerHTML = `
      <div class="popup-header">
        <span class="popup-title">${escapeHtml(title)}</span>
        <button class="popup-close" aria-label="${escapeHtml(t("common.close"))}" title="${escapeHtml(t("common.close"))}">${icon("close", { size: 13 })}</button>
      </div>
      <div class="popup-body backup-body">
        <p class="backup-intro">${escapeHtml(t("swaggerImport.intro"))}</p>
        <label class="backup-field">
          <span class="backup-field-label">${escapeHtml(t("swaggerImport.nameLabel"))}</span>
          <input class="settings-input swagger-import-input js-name" type="text" spellcheck="false"
            autocomplete="off" autocapitalize="off"
            aria-label="${escapeHtml(t("swaggerImport.nameLabel"))}"
            placeholder="${escapeHtml(t("swaggerImport.namePlaceholder"))}"
            value="${escapeHtml(defaultName)}" />
        </label>
        <label class="backup-field">
          <span class="backup-field-label">${escapeHtml(t("swaggerImport.valueLabel"))}</span>
          <input class="settings-input swagger-import-input js-value" type="text" spellcheck="false"
            autocomplete="off" autocapitalize="off"
            aria-label="${escapeHtml(t("swaggerImport.valueLabel"))}"
            placeholder="${escapeHtml(t("swaggerImport.valuePlaceholder"))}"
            value="${escapeHtml(defaultValue)}" />
        </label>
      </div>
      <div class="popup-footer">
        <button class="btn popup-btn btn--secondary js-cancel">${escapeHtml(t("common.cancel"))}</button>
        <button class="btn popup-btn btn--primary js-submit">${escapeHtml(t("swaggerImport.submit"))}</button>
      </div>
    `;
    return el;
  }

  #bindEvents() {
    this.#el
      .querySelector(".popup-close")
      .addEventListener("click", () => this.#onCancel?.());
    this.#el
      .querySelector(".js-cancel")
      .addEventListener("click", () => this.#onCancel?.());
    this.#el
      .querySelector(".js-submit")
      .addEventListener("click", () => this.#submit());

    for (const input of [this.#nameInput, this.#valueInput]) {
      input?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.#submit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          this.#onCancel?.();
        }
      });
    }
  }

  #submit() {
    // A blank name falls back to the default so the request prefix is never
    // an empty `{{}}`. Strip any braces the user may have typed around it. The
    // value may legitimately be empty (the user fills the host in later).
    const name =
      this.#nameInput.value
        .trim()
        .replace(/^\{+|\}+$/g, "")
        .trim() || "baseUrl";
    const value = this.#valueInput.value.trim();
    this.#onSubmit?.({ name, value });
  }
}
