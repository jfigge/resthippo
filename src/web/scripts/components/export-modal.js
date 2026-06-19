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
 * ExportModal — theme-styled modal for picking an interchange format when
 * exporting a single collection or the whole workspace. The modal only collects
 * the chosen format and hands it to the `onChoose(format)` callback; `app.js`
 * owns building the file and driving the native save dialog. Mirrors the
 * structure and styling of `BackupModal`.
 *
 * Open via the static factories:
 *   ExportModal.openCollection(collection, (format) => …);
 *   ExportModal.openWorkspace((format) => …);
 */

// `label` carries the format/version name verbatim (a proper noun, not
// translated); `descKey` is resolved through t() at render time — never at
// module load, since the catalog isn't ready yet.
const FORMATS = [
  {
    value: "resthippo",
    label: "Rest Hippo v1",
    descKey: "export.format.resthippoDesc",
  },
  {
    value: "postman",
    label: "Postman v2.1",
    descKey: "export.format.postmanDesc",
  },
  {
    value: "insomnia",
    label: "Insomnia v4",
    descKey: "export.format.insomniaDesc",
  },
  {
    value: "openapi",
    label: "OpenAPI 3",
    descKey: "export.format.openapiDesc",
  },
  {
    value: "har",
    label: "HAR 1.2",
    descKey: "export.format.harDesc",
  },
];

export class ExportModal {
  #el;
  #variant; // "collection" | "workspace"
  #onChoose;
  #errorEl = null;
  #busy = false;

  constructor({ variant, onChoose } = {}) {
    this.#variant = variant;
    this.#onChoose = onChoose;
    this.#el = this.#build();
    this.#errorEl = this.#el.querySelector(".backup-error");
    this.#bindEvents();
  }

  get element() {
    return this.#el;
  }

  /** Open the per-collection "Export" modal. */
  static openCollection(collection, onChoose) {
    const modal = new ExportModal({ variant: "collection", onChoose });
    PopupManager.open(modal);
  }

  /** Open the workspace-level "Export All Collections" modal. */
  static openWorkspace(onChoose) {
    const modal = new ExportModal({ variant: "workspace", onChoose });
    PopupManager.open(modal);
  }

  /** Called by PopupManager when the user clicks the overlay mask. */
  onMaskClick() {
    if (!this.#busy) PopupManager.close();
  }

  #build() {
    const workspace = this.#variant === "workspace";
    const title = workspace ? t("export.titleWorkspace") : t("export.title");
    const intro = workspace
      ? t("export.introWorkspace")
      : t("export.introCollection");

    const el = document.createElement("div");
    el.className = "popup export-modal";
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
        <div class="backup-mode-group" role="radiogroup" aria-label="${escapeHtml(t("export.formatAria"))}">
          ${FORMATS.map((f, i) => this.#formatOption(f, i === 0)).join("")}
        </div>
        <div class="backup-error" role="alert" aria-live="polite"></div>
      </div>
      <div class="popup-footer">
        <button class="btn popup-btn btn--secondary js-cancel">${escapeHtml(t("common.cancel"))}</button>
        <button class="btn popup-btn btn--primary js-submit">${escapeHtml(t("export.submit"))}</button>
      </div>
    `;
    return el;
  }

  #formatOption(f, checked) {
    return `
      <label class="backup-mode-option">
        <span class="backup-mode-head">
          <input type="radio" name="export-format" value="${f.value}"${checked ? " checked" : ""} />
          <span class="backup-mode-text">
            <span class="backup-mode-label">${escapeHtml(f.label)}</span>
            <span class="backup-mode-desc">${escapeHtml(t(f.descKey))}</span>
          </span>
        </span>
      </label>
    `;
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

    for (const radio of this.#el.querySelectorAll('input[type="radio"]')) {
      radio.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.#submit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          this.onMaskClick();
        }
      });
    }
  }

  #selectedFormat() {
    const checked = this.#el.querySelector('input[type="radio"]:checked');
    return checked ? checked.value : null;
  }

  async #submit() {
    if (this.#busy) return;
    const format = this.#selectedFormat();
    if (!format) return;

    this.#setBusy(true);
    try {
      // The callback builds the file and drives the native save dialog; the
      // modal closes once it settles (success or cancel), mirroring BackupModal.
      await this.#onChoose?.(format);
      PopupManager.close();
    } catch {
      // app.js surfaces failures via Notifications; just release the modal.
      PopupManager.close();
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
}
