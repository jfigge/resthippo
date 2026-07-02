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
import { copyWithLabelFlash } from "../utils/clipboard.js";
import { t } from "../i18n.js";
import Prism from "../vendor/prism.js";

/**
 * GraphQLSchemaViewer — read-only modal that displays a fetched GraphQL schema
 * as SDL. Opened from the "schema loaded" badge's right-click menu ("View
 * Schema"). The body is a scrollable, syntax-highlighted, non-editable block;
 * the footer offers Copy / Download / Close.
 *
 * Open via the static factory:
 *   GraphQLSchemaViewer.open(sdl, { onDownload });
 *
 * `onDownload` (optional) is invoked when the user clicks "Download" — the
 * caller owns the native save dialog so file naming/IO stays in one place.
 */
export class GraphQLSchemaViewer {
  #el;
  #sdl;
  #onDownload;

  constructor({ sdl, onDownload } = {}) {
    this.#sdl = sdl ?? "";
    this.#onDownload = onDownload;
    this.#el = this.#build();
    this.#bindEvents();
  }

  get element() {
    return this.#el;
  }

  /** Open the read-only schema viewer for the given SDL string. */
  static open(sdl, { onDownload } = {}) {
    PopupManager.open(new GraphQLSchemaViewer({ sdl, onDownload }));
  }

  /** Called by PopupManager when the user clicks the overlay mask. */
  onMaskClick() {
    PopupManager.close();
  }

  #build() {
    const grammar = Prism.languages.graphql;
    const codeHtml = grammar
      ? Prism.highlight(this.#sdl, grammar, "graphql")
      : escapeHtml(this.#sdl);

    const el = document.createElement("div");
    el.className = "popup graphql-schema-viewer";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", t("graphqlSchema.aria"));
    el.innerHTML = `
      <div class="popup-header">
        <span class="popup-title">${t("graphqlSchema.title")}</span>
        <button class="popup-close" aria-label="${t("common.close")}" title="${t("common.close")}">${icon("close", { size: 13 })}</button>
      </div>
      <div class="popup-body graphql-schema-viewer-body">
        <pre class="graphql-schema-viewer-pre"><code class="language-graphql">${codeHtml}</code></pre>
      </div>
      <div class="popup-footer">
        <button class="btn popup-btn btn--secondary js-copy">${t("common.copy")}</button>
        <button class="btn popup-btn btn--secondary js-download">${t("common.download")}</button>
        <button class="btn popup-btn btn--primary js-close">${t("common.close")}</button>
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
    this.#el.querySelector(".js-download").addEventListener("click", () => {
      this.#onDownload?.();
    });
  }

  /** Copy the SDL to the clipboard, flashing the button label on success. */
  async #copy(btn) {
    try {
      const prev = btn.textContent;
      await copyWithLabelFlash(this.#sdl, btn, {
        copiedText: t("common.copied"),
        restoreText: prev,
      });
    } catch {
      // Clipboard denied — nothing actionable to surface from a read-only view.
    }
  }
}
