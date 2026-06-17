/**
 * notes-editor.js — the Notes request tab.
 *
 * A plain free-text scratchpad persisted on the request node. Extracted from
 * RequestEditor as a delegated sub-editor (the same pattern as
 * GraphQLBodyEditor / RequestAuthEditor): it owns the notes value and its
 * textarea, and reports edits through the injected `onChange` callback — the
 * host turns that into the request-updated event.
 */
"use strict";

import { t } from "../../i18n.js";

export class NotesEditor {
  #onChange;
  #notes = "";
  #ta = null; // the <textarea>, while mounted

  /** @param {{ onChange?: () => void }} [deps] */
  constructor({ onChange } = {}) {
    this.#onChange = onChange;
  }

  /** @returns {string} the current notes text */
  getValue() {
    return this.#notes;
  }

  /** @param {string} notes */
  setValue(notes) {
    this.#notes = notes ?? "";
    if (this.#ta) this.#ta.value = this.#notes;
  }

  /** Build (or rebuild) the Notes tab-pane element. */
  build() {
    const container = document.createElement("div");
    container.className = "params-editor notes-editor";

    const ta = document.createElement("textarea");
    ta.className = "body-text-editor notes-textarea";
    ta.placeholder = t("request.notes.placeholder");
    ta.spellcheck = true;
    ta.value = this.#notes;
    ta.setAttribute("aria-label", t("request.notes.aria"));

    ta.addEventListener("input", () => {
      this.#notes = ta.value;
      this.#onChange?.();
    });

    this.#ta = ta;
    container.appendChild(ta);
    return container;
  }
}
