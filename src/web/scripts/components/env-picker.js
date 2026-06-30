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
 * env-picker.js — Environment selector
 *
 * Renders a Send-button-styled trigger showing the active environment's name
 * (or "Global") plus a dropdown caret. Clicking opens a native OS popup menu
 * listing the active collection's environments — Global (the collection-wide
 * tier) plus each named environment, with a check beside the active one;
 * selecting one activates it. A right-click opens the same list (and suppresses
 * the browser context menu).
 *
 * The menu is shown by the main process over the `ui:context-menu:show` IPC
 * channel (window.hippo.ui.contextMenu.show), which resolves with the clicked
 * item's id — so this component only builds the item list and routes the result.
 *
 * Multiple trigger buttons can be bound to one instance so the same picker works
 * in more than one toolbar location.
 *
 * Usage:
 *   const envPicker = new EnvPicker({
 *     onActivate: (id) => activateEnv(id),  // id is null for Global
 *   });
 *   envPicker.bindTrigger(document.getElementById("btn-env-picker"));
 *   envPicker.load(currentEnvironments);
 */

import { t } from "../i18n.js";
import { icon } from "../icons.js";

// Solid down-caret (sized by CSS) marking the trigger as a dropdown — the same
// affordance the request method / send-type pickers use.
const _CARET = icon("caret", { size: null, className: "env-picker-caret" });

export class EnvPicker {
  #data = { globalVariables: {}, activeEnvironmentId: null, environments: [] };
  #onActivate;
  #triggers = [];
  #open = false;

  constructor({ onActivate } = {}) {
    this.#onActivate = onActivate;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  bindTrigger(btn) {
    if (!btn) return;
    this.#syncTrigger(btn);
    // Primary (left) click opens the environment list.
    btn.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      this.#openMenu(btn);
    });
    // Right-click opens the same list (and suppresses the browser context menu).
    btn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.#openMenu(btn);
    });
    this.#triggers.push(btn);
  }

  load(data) {
    this.#data = data ?? this.#data;
    this.#triggers.forEach((btn) => this.#syncTrigger(btn));
  }

  // ── Private ────────────────────────────────────────────────────────────────

  #activeEnv() {
    const id = this.#data.activeEnvironmentId;
    return id ? (this.#data.environments ?? []).find((e) => e.id === id) : null;
  }

  #syncTrigger(btn) {
    const env = this.#activeEnv();
    const label = env?.name ?? t("env.global");
    btn.innerHTML = `<span class="env-picker-label"></span>${_CARET}`;
    btn.querySelector(".env-picker-label").textContent = label;
    btn.classList.toggle("env-picker-trigger--active", !!env);
  }

  /**
   * Open a native OS popup menu anchored under the trigger listing the active
   * collection's environments — Global (id null) then each named environment,
   * shown in their stored case, with a check beside the active one.
   * Resolves to the clicked id (or null when dismissed); we map it back to the
   * activate action.
   */
  async #openMenu(btn) {
    // Re-entrancy guard; also a no-op outside Electron (no native menu host).
    if (this.#open || !window.hippo?.ui?.contextMenu?.show) return;

    const activeId = this.#data.activeEnvironmentId ?? null;

    // Native menu ids are strings; key each environment row by index and map
    // the chosen key back to its (possibly null) environment id.
    const idByKey = new Map();
    const entries = [
      { id: null, name: t("env.global") },
      ...(this.#data.environments ?? []).map((e) => ({
        id: e.id,
        name: e.name,
      })),
    ];
    const items = entries.map((entry, i) => {
      const key = `env:${i}`;
      idByKey.set(key, entry.id);
      return {
        id: key,
        label: String(entry.name ?? ""),
        type: "checkbox",
        checked: entry.id === activeId,
      };
    });

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
      return; // IPC failure — leave the active environment unchanged
    } finally {
      this.#open = false;
    }

    if (choice == null) return; // dismissed
    if (idByKey.has(choice)) {
      const id = idByKey.get(choice);
      if (id !== activeId) this.#onActivate?.(id);
    }
  }
}
