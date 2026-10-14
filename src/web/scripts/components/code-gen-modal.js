/*
 * Copyright 2026 Jason Figge
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This file is part of Rest Hippo.
 *
 * Rest Hippo is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option) any later
 * version.
 *
 * Rest Hippo is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR
 * A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with
 * Rest Hippo. If not, see <https://www.gnu.org/licenses/>.
 */

"use strict";

import { PopupManager } from "../popup-manager.js";
import { icon } from "../icons.js";
import { escapeHtml } from "../utils/html.js";
import { copyWithLabelFlash } from "../utils/clipboard.js";
import { t } from "../i18n.js";
import Prism from "../vendor/prism.js";
import { TARGETS, generateCode } from "./code-gen/index.js";

/**
 * CodeGenModal — read-only "Generate code" dialog. A target dropdown drives a
 * syntax-highlighted preview of the request rendered as cURL / fetch / requests
 * / Go / HTTPie (see ./code-gen/index.js); the footer copies the active snippet.
 *
 * It is handed an already-resolved request model (variable substitution and the
 * unresolved-variable pre-flight happen in TreeView before opening), so it is a
 * pure renderer — switching target just re-runs `generateCode` on the model.
 *
 * Open via the static factory:
 *   CodeGenModal.open(model);
 */
export class CodeGenModal {
  #el;
  #model;
  #targetId;
  #code = "";

  constructor({ model } = {}) {
    this.#model = model;
    this.#targetId = TARGETS[0].id;
    this.#el = this.#build();
    this.#bindEvents();
    this.#render();
  }

  get element() {
    return this.#el;
  }

  /** Open the preview dialog for a normalized request model. */
  static open(model) {
    PopupManager.open(new CodeGenModal({ model }));
  }

  /** Called by PopupManager when the user clicks the overlay mask. */
  onMaskClick() {
    PopupManager.close();
  }

  #build() {
    const options = TARGETS.map(
      (tg) =>
        `<option value="${escapeHtml(tg.id)}">${escapeHtml(tg.label)}</option>`,
    ).join("");

    const el = document.createElement("div");
    el.className = "popup code-gen-modal";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", t("tree.code.aria"));
    el.innerHTML = `
      <div class="popup-header">
        <span class="popup-title">${escapeHtml(t("tree.code.title"))}</span>
        <button class="popup-close" aria-label="${escapeHtml(t("common.close"))}" title="${escapeHtml(t("common.close"))}">${icon("close", { size: 13 })}</button>
      </div>
      <div class="popup-body code-gen-body">
        <div class="code-gen-toolbar">
          <label class="code-gen-target-label" for="code-gen-target">${escapeHtml(t("tree.code.target"))}</label>
          <select class="code-gen-target" id="code-gen-target">${options}</select>
        </div>
        <pre class="code-gen-pre"><code class="language-bash"></code></pre>
      </div>
      <div class="popup-footer">
        <button class="btn popup-btn btn--secondary js-copy">${escapeHtml(t("common.copy"))}</button>
        <button class="btn popup-btn btn--primary js-close">${escapeHtml(t("common.close"))}</button>
      </div>
    `;
    return el;
  }

  #bindEvents() {
    this.#el
      .querySelector(".popup-close")
      .addEventListener("click", () => PopupManager.close());
    this.#el
      .querySelector(".js-close")
      .addEventListener("click", () => PopupManager.close());
    this.#el
      .querySelector(".js-copy")
      .addEventListener("click", (e) => this.#copy(e.currentTarget));
    this.#el
      .querySelector(".code-gen-target")
      .addEventListener("change", (e) => {
        this.#targetId = e.currentTarget.value;
        this.#render();
      });
  }

  /** Regenerate + re-highlight the snippet for the active target. */
  #render() {
    const target = TARGETS.find((tg) => tg.id === this.#targetId) ?? TARGETS[0];
    this.#code = generateCode(target.id, this.#model);

    const codeEl = this.#el.querySelector(".code-gen-pre code");
    const grammar = Prism.languages[target.language];
    codeEl.className = `language-${target.language}`;
    codeEl.innerHTML = grammar
      ? Prism.highlight(this.#code, grammar, target.language)
      : escapeHtml(this.#code);

    // Reset the copy button label if a prior copy left it flashed.
    const copyBtn = this.#el.querySelector(".js-copy");
    if (copyBtn) copyBtn.textContent = t("common.copy");
  }

  /** Copy the active snippet, flashing the button label on success. */
  async #copy(btn) {
    try {
      await copyWithLabelFlash(this.#code, btn, {
        copiedText: t("common.copied"),
        restoreText: t("common.copy"),
      });
    } catch {
      // Clipboard denied — nothing actionable to surface from a read-only view.
    }
  }
}
