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
import { shortcutTable } from "../keymap.js";

/**
 * KeyboardShortcuts — the read-only cheat-sheet listing every application
 * shortcut, grouped by area. Lightweight one-shot modal (static factory per
 * open, mirroring ExportModal / BackupModal); the key labels come from the
 * single keymap source of truth so this never drifts from the live bindings.
 *
 * Open with `KeyboardShortcuts.open()` — guarded so a second ⌘/Ctrl+K (or a
 * Help-menu click) while it is already showing is a no-op rather than stacking a
 * duplicate popup over the live one.
 */
export class KeyboardShortcuts {
  /** @type {boolean} guards against opening a duplicate over the live one */
  static #isOpen = false;

  #el;
  #onKey;

  /** Open the cheat-sheet (no-op if already open). */
  static open() {
    if (KeyboardShortcuts.#isOpen) return;
    const inst = new KeyboardShortcuts();
    KeyboardShortcuts.#isOpen = true;
    PopupManager.open(inst);

    // Any close path (button, mask click, resize) hides the mask and fires
    // popup-closed; clear the guard and detach the Escape listener there so it
    // never leaks regardless of how the popup went away.
    window.addEventListener(
      "hippo:popup-closed",
      () => {
        KeyboardShortcuts.#isOpen = false;
        document.removeEventListener("keydown", inst.#onKey, true);
      },
      { once: true },
    );
  }

  constructor() {
    this.#el = this.#build();
    this.#el
      .querySelector(".popup-close")
      .addEventListener("click", () => PopupManager.close());

    // Escape closes; capture-phase so it wins over any focused control inside.
    this.#onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        PopupManager.close();
      }
    };
    document.addEventListener("keydown", this.#onKey, true);
  }

  get element() {
    return this.#el;
  }

  /** Called by PopupManager when the user clicks the overlay mask. */
  onMaskClick() {
    PopupManager.close();
  }

  #build() {
    const el = document.createElement("div");
    el.className = "popup shortcuts-modal";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", t("shortcuts.title"));

    const groups = shortcutTable()
      .map(
        (g) => `
        <section class="shortcuts-group">
          <h3 class="shortcuts-group-title">${escapeHtml(g.title)}</h3>
          <ul class="shortcuts-list">
            ${g.rows
              .map(
                (r) => `
              <li class="shortcuts-row">
                <span class="shortcuts-desc">${escapeHtml(r.desc)}</span>
                <kbd class="shortcuts-keys">${escapeHtml(r.keys)}</kbd>
              </li>`,
              )
              .join("")}
          </ul>
        </section>`,
      )
      .join("");

    el.innerHTML = `
      <div class="popup-header">
        <span class="popup-title">${escapeHtml(t("shortcuts.title"))}</span>
        <button class="popup-close" aria-label="${escapeHtml(t("common.close"))}" title="${escapeHtml(t("common.close"))}">${icon("close", { size: 13 })}</button>
      </div>
      <div class="popup-body shortcuts-body">
        ${groups}
      </div>
    `;
    return el;
  }
}
