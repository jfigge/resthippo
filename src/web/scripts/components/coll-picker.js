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

/**
 * coll-picker.js — Collection selector
 *
 * Renders an icon-only trigger button that opens the collections editor
 * directly. The active collection name is not shown inline — it is the button's
 * tooltip (and the editor it opens lists every collection by name).
 *
 * The two mouse interactions both reach the editor (the secondary one is a
 * redundant affordance that mirrors the environment selector):
 *   • primary (left) click    → opens the collections editor directly.
 *   • secondary (right) click → opens a short native OS popup menu holding a
 *     single "Manage…" entry that opens the same editor.
 *
 * The menu is shown by the main process over the `ui:context-menu:show` IPC
 * channel (window.hippo.ui.contextMenu.show), which resolves with the clicked
 * item's id — so this component only builds the item list and routes the result.
 *
 * Multiple trigger buttons can be bound to one instance so the same picker
 * works in the panel header and the nav-settings bar.
 *
 * Usage:
 *   const collPicker = new CollPicker({ onManage: () => openPopup() });
 *   collPicker.bindTrigger(document.getElementById("btn-collection"));
 *   collPicker.load(currentColls);
 */

import { t } from "../i18n.js";
import { electronAccelerator } from "../keymap.js";

const _STACK = `<svg class="coll-picker-icon" xmlns="http://www.w3.org/2000/svg"
    width="16" height="16" viewBox="0 0 24 24"
    fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <polygon points="12 2 2 7 12 12 22 7 12 2"/>
  <polyline points="2 17 12 22 22 17"/>
  <polyline points="2 12 12 17 22 12"/>
</svg>`;

// Sentinel id for the "Manage…" row — the only entry in the secondary-click
// menu, kept distinct so the resolved menu id is unambiguous.
const _MANAGE_ID = "__manage__";

export class CollPicker {
  #data = { collections: [], activeCollectionId: null };
  #onManage;
  #triggers = [];
  #open = false;

  constructor({ onManage } = {}) {
    this.#onManage = onManage;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  bindTrigger(btn) {
    if (!btn) return;
    this.#syncTrigger(btn);
    // Primary (left) click → open the collections editor directly.
    btn.addEventListener("click", () => this.#onManage?.());
    // Secondary click (right-click / ctrl-click / two-finger tap) → a native OS
    // popup with a single "Manage…" entry. `contextmenu` covers all those
    // gestures cross-platform; preventDefault suppresses the browser menu.
    btn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.#openMenu(btn);
    });
    this.#triggers.push(btn);
  }

  load(data) {
    this.#data = data ?? this.#data;
    this.#triggers.forEach((t) => this.#syncTrigger(t));
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /**
   * Open a native OS popup menu anchored under the trigger holding a single
   * "Manage…" entry that opens the collections editor — the redundant
   * secondary-click affordance mirroring the environment selector. Resolves to
   * the clicked id (or null when dismissed); we route "Manage…" to onManage.
   */
  async #openMenu(btn) {
    // Re-entrancy guard; also a no-op outside Electron (no native menu host).
    if (this.#open || !window.hippo?.ui?.contextMenu?.show) return;

    // The accelerator is display-only (the renderer owns the shortcut); it just
    // advertises it next to the same action this entry triggers.
    const items = [
      {
        id: _MANAGE_ID,
        label: t("collections.manage"),
        accelerator: electronAccelerator("collectionVariables"),
      },
    ];

    const r = btn.getBoundingClientRect();
    this.#open = true;
    let choice = null;
    try {
      choice = await window.hippo.ui.contextMenu.show({
        items,
        x: r.left,
        y: r.bottom + 4,
      });
    } catch {
      return; // IPC failure — nothing to do
    } finally {
      this.#open = false;
    }

    if (choice === _MANAGE_ID) this.#onManage?.();
  }

  #activeColl() {
    const id = this.#data.activeCollectionId;
    return id ? (this.#data.collections ?? []).find((c) => c.id === id) : null;
  }

  #syncTrigger(btn) {
    const coll = this.#activeColl();
    const label = coll?.name ?? t("header.collections");
    // Icon only; the active collection name is the tooltip. (aria-label stays
    // the action — "Open collections" — set once by localizeChrome in app.js.)
    btn.innerHTML = _STACK;
    btn.title = label;
  }
}
