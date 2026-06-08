"use strict";

import { PopupManager } from "../popup-manager.js";
import { icon } from "../icons.js";
import { escapeHtml } from "../utils/html.js";

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

const FORMATS = [
  {
    value: "postman",
    label: "Postman v2.1",
    desc: "Postman collection. Re-imports into Postman and wurl.",
  },
  {
    value: "insomnia",
    label: "Insomnia v4",
    desc: "Insomnia export. Re-imports into Insomnia and wurl.",
  },
  {
    value: "openapi",
    label: "OpenAPI 3",
    desc: "OpenAPI 3.0 description of the requests (best-effort, lossy).",
  },
  {
    value: "har",
    label: "HAR 1.2",
    desc: "Recorded exchanges from the most recent run of each request.",
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
    const title = workspace ? "Export All Collections" : "Export";
    const intro = workspace
      ? "Export every collection to a single interchange file (not the encrypted backup). Secrets — passwords, tokens and keys — are redacted."
      : "Export this collection to an interchange file. Secrets — passwords, tokens and keys — are redacted.";

    const el = document.createElement("div");
    el.className = "popup export-modal";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", title);
    el.innerHTML = `
      <div class="popup-header">
        <span class="popup-title">${escapeHtml(title)}</span>
        <button class="popup-close" aria-label="Close" title="Close">${icon("close", { size: 13 })}</button>
      </div>
      <div class="popup-body backup-body">
        <p class="backup-intro">${escapeHtml(intro)}</p>
        <div class="backup-mode-group" role="radiogroup" aria-label="Export format">
          ${FORMATS.map((f, i) => this.#formatOption(f, i === 0)).join("")}
        </div>
        <div class="backup-error" role="alert" aria-live="polite"></div>
      </div>
      <div class="popup-footer">
        <button class="btn popup-btn btn--secondary js-cancel">Cancel</button>
        <button class="btn popup-btn btn--primary js-submit">Export</button>
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
            <span class="backup-mode-desc">${escapeHtml(f.desc)}</span>
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
