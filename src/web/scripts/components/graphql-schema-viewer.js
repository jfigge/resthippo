"use strict";

import { PopupManager } from "../popup-manager.js";
import { icon } from "../icons.js";
import { escapeHtml } from "../utils/html.js";
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
    el.setAttribute("aria-label", "GraphQL schema");
    el.innerHTML = `
      <div class="popup-header">
        <span class="popup-title">GraphQL Schema</span>
        <button class="popup-close" aria-label="Close" title="Close">${icon("close", { size: 13 })}</button>
      </div>
      <div class="popup-body graphql-schema-viewer-body">
        <pre class="graphql-schema-viewer-pre"><code class="language-graphql">${codeHtml}</code></pre>
      </div>
      <div class="popup-footer">
        <button class="btn popup-btn btn--secondary js-copy">Copy</button>
        <button class="btn popup-btn btn--secondary js-download">Download</button>
        <button class="btn popup-btn btn--primary js-close">Close</button>
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
      await navigator.clipboard.writeText(this.#sdl);
      const prev = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(() => {
        btn.textContent = prev;
      }, 1200);
    } catch {
      // Clipboard denied — nothing actionable to surface from a read-only view.
    }
  }
}
