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
 * Multiple trigger buttons can be bound to one instance so the same picker
 * works in the panel header and the nav-settings bar.
 *
 * Usage:
 *   const collPicker = new CollPicker({ onManage: () => openPopup() });
 *   collPicker.bindTrigger(document.getElementById("btn-collection"));
 *   collPicker.load(currentColls);
 */

import { t } from "../i18n.js";

const _STACK = `<svg class="coll-picker-icon" xmlns="http://www.w3.org/2000/svg"
    width="16" height="16" viewBox="0 0 24 24"
    fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <polygon points="12 2 2 7 12 12 22 7 12 2"/>
  <polyline points="2 17 12 22 22 17"/>
  <polyline points="2 12 12 17 22 12"/>
</svg>`;

export class CollPicker {
  #data = { collections: [], activeCollectionId: null };
  #onManage;
  #triggers = [];

  constructor({ onManage } = {}) {
    this.#onManage = onManage;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  bindTrigger(btn) {
    if (!btn) return;
    this.#syncTrigger(btn);
    btn.addEventListener("click", () => this.#onManage?.());
    this.#triggers.push(btn);
  }

  load(data) {
    this.#data = data ?? this.#data;
    this.#triggers.forEach((t) => this.#syncTrigger(t));
  }

  // ── Private ────────────────────────────────────────────────────────────────

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
