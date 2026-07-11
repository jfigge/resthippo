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
 * UrlImportModal — theme-styled modal that imports an interchange document from
 * either a live URL or a local file, chosen by what the single field contains.
 * As the user types, `#detectMode` classifies the value: an `http(s)://` value
 * is a URL, a path-shaped value (absolute / home / relative / Windows drive /
 * UNC, or one ending `.json`/`.yaml`/`.yml`/`.har`) is a file, and anything
 * empty or ambiguous stays a URL. The title flips live between "Import from URL"
 * and "Import from file", and the optional auth-header field (URL-only) hides in
 * file mode. A **Browse…** button opens the native picker as a fallback — the
 * only route that works under the Mac App Store sandbox, where a typed path
 * can't be read.
 *
 * `app.js` owns the work behind each of the three callbacks; every one resolves
 * `true` to close the modal and a falsy value to keep it open (that failure is
 * surfaced as a notification by `app.js`). `onImportFile` may additionally
 * resolve `{ error }` to keep the modal open with that message shown inline:
 *   • `onImport(url, header)`  — fetch a URL (main-process request engine, no
 *     browser CORS) and import it. A bare header token is sent as
 *     `Authorization`, a `Name: Value` line as a custom header.
 *   • `onImportFile(path)`     — read a typed absolute file path (new
 *     `import:file:read` IPC) and import it; resolves `{ error }` on a read
 *     failure (a bad path) so the modal renders that message inline.
 *   • `onBrowse()`             — open the native file picker and import the
 *     chosen file.
 * In every case the format is auto-detected (Postman / Insomnia / OpenAPI /
 * Swagger / HAR / native archive); OpenAPI/Swagger additionally prompts for a
 * base-URL variable. An empty field, or a non-file value that isn't http(s), is
 * caught locally and shown inline without invoking a callback.
 *
 * Open via the static factory:
 *   UrlImportModal.open({ onImport, onImportFile, onBrowse });
 */
export class UrlImportModal {
  #el;
  #onImport;
  #onImportFile;
  #onBrowse;
  #errorEl = null;
  #urlInput = null;
  #headerInput = null;
  #headerField = null;
  /** Current field classification: "url" | "file". */
  #mode = "url";
  #busy = false;

  constructor({ onImport, onImportFile, onBrowse } = {}) {
    this.#onImport = onImport;
    this.#onImportFile = onImportFile;
    this.#onBrowse = onBrowse;
    this.#el = this.#build();
    this.#errorEl = this.#el.querySelector(".url-import-error");
    this.#urlInput = this.#el.querySelector(".url-import-input");
    this.#headerInput = this.#el.querySelector(".url-import-header-input");
    this.#headerField = this.#el.querySelector(".url-import-header-field");
    this.#bindEvents();
  }

  get element() {
    return this.#el;
  }

  /**
   * Open the import modal.
   * @param {{ onImport?: Function, onImportFile?: Function, onBrowse?: Function }} handlers
   */
  static open(handlers) {
    const modal = new UrlImportModal(handlers);
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
    el.className = "popup url-import-modal";
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
          <input class="settings-input url-import-input" type="text" inputmode="url"
            spellcheck="false" autocomplete="off" autocapitalize="off"
            aria-label="${escapeHtml(t("urlImport.urlLabel"))}"
            placeholder="${escapeHtml(t("urlImport.urlPlaceholder"))}" />
        </label>
        <label class="backup-field url-import-header-field">
          <span class="backup-field-label">${escapeHtml(t("urlImport.headerLabel"))}</span>
          <input class="settings-input url-import-header-input" type="text"
            spellcheck="false" autocomplete="off" autocapitalize="off"
            aria-label="${escapeHtml(t("urlImport.headerLabel"))}"
            placeholder="${escapeHtml(t("urlImport.headerPlaceholder"))}" />
        </label>
        <div class="url-import-error backup-error" role="alert" aria-live="polite"></div>
      </div>
      <div class="popup-footer">
        <button class="btn popup-btn btn--secondary js-browse">${escapeHtml(t("urlImport.browse"))}</button>
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
    this.#el
      .querySelector(".js-browse")
      .addEventListener("click", () => this.#browse());

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

    // Re-classify the field on every edit so the title + header visibility track
    // what the user is typing (a URL vs a local path).
    this.#urlInput?.addEventListener("input", () => this.#updateMode());
  }

  /**
   * Classify the field value as a URL or a local file path.
   *   • `http(s)://…`            → url
   *   • absolute `/…`, home `~/…`, relative `./`/`../`, Windows drive `C:\`,
   *     UNC `\\…`, or a name ending `.json`/`.yaml`/`.yml`/`.har` → file
   *   • empty or anything else   → url (keeps the current title)
   * @param {string} value
   * @returns {"url"|"file"}
   */
  #detectMode(value) {
    const v = value.trim();
    if (!v) return "url";
    if (/^https?:\/\//i.test(v)) return "url";
    if (
      /^\//.test(v) || // absolute POSIX path
      /^~\//.test(v) || // home-relative path
      /^\.\.?\//.test(v) || // ./ or ../ relative path
      /^[a-zA-Z]:[\\/]/.test(v) || // Windows drive (C:\ or C:/)
      /^\\\\/.test(v) || // UNC \\server\share
      /\.(json|ya?ml|har)$/i.test(v) // known interchange extension
    ) {
      return "file";
    }
    return "url";
  }

  /** Recompute the mode from the field and reflect it in the title + header. */
  #updateMode() {
    const mode = this.#detectMode(this.#urlInput.value);
    if (mode === this.#mode) return;
    this.#mode = mode;
    const isFile = mode === "file";
    const title = isFile ? t("urlImport.titleFile") : t("urlImport.title");
    this.#el.querySelector(".popup-title").textContent = title;
    this.#el.setAttribute("aria-label", title);
    // The auth header only applies to a fetched URL; hide it for a local file.
    if (this.#headerField) this.#headerField.hidden = isFile;
  }

  #clearError() {
    if (this.#errorEl) this.#errorEl.textContent = "";
  }

  #setError(message) {
    if (this.#errorEl) this.#errorEl.textContent = message;
  }

  async #submit() {
    if (this.#busy) return;
    const value = this.#urlInput.value.trim();
    if (!value) {
      this.#setError(t("urlImport.empty"));
      this.#urlInput.focus();
      return;
    }

    const isFile = this.#detectMode(value) === "file";

    // A URL must be http(s): rejecting other schemes (file:, ftp:, …) keeps a
    // pasted URL from reaching the local filesystem via the request engine.
    // Loopback / private hosts are intentionally allowed — importing from a
    // locally-running API server is a legitimate use case. A file path skips
    // this check; it's read via the dedicated import:file:read IPC.
    if (!isFile && !/^https?:\/\//i.test(value)) {
      this.#setError(t("urlImport.errScheme"));
      this.#urlInput.focus();
      return;
    }

    this.#setBusy(true);
    try {
      // Each callback imports and resolves `true` to close. The file callback may
      // instead resolve `{ error }` for a read failure (a bad path) — rendered
      // inline beside the field so the user can fix it in place; any other falsy
      // value keeps the modal open with the failure already surfaced as a toast by
      // app.js. For an OpenAPI/Swagger spec the URL callback returns true after
      // closing this modal itself and handing off to the base-URL prompt.
      let ok;
      if (isFile) {
        const res = await this.#onImportFile?.(value);
        if (res && res.error) {
          this.#setError(res.error);
          this.#urlInput.focus();
          ok = false;
        } else {
          ok = res;
        }
      } else {
        ok = await this.#onImport?.(value, this.#headerInput.value.trim());
      }
      if (ok) PopupManager.close();
    } catch {
      // Defensive: app.js surfaces failures via Notifications; keep the modal.
    } finally {
      this.#setBusy(false);
    }
  }

  /** Open the native file picker (the sandbox-safe fallback to a typed path). */
  async #browse() {
    if (this.#busy) return;
    this.#setBusy(true);
    try {
      const ok = await this.#onBrowse?.();
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
    const browse = this.#el.querySelector(".js-browse");
    if (submit) submit.disabled = busy;
    if (cancel) cancel.disabled = busy;
    if (browse) browse.disabled = busy;
    if (this.#urlInput) this.#urlInput.disabled = busy;
    if (this.#headerInput) this.#headerInput.disabled = busy;
  }
}
