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
