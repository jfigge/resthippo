"use strict";

/**
 * env-picker.js — Environment selector
 *
 * Renders a trigger button that opens a native OS popup menu listing every
 * environment (plus the Global pseudo-environment), with a check beside the
 * active one, a separator, and a "Manage…" entry that opens the environments
 * editor. Selecting an environment activates it; the OS dismisses the menu.
 *
 * The menu is shown by the main process over the `ui:context-menu:show` IPC
 * channel (window.hippo.ui.contextMenu.show), which resolves with the clicked
 * item's id — so this component only builds the item list and routes the result.
 *
 * Multiple trigger buttons can be bound to one instance so the same picker
 * works in the panel header, the nav-settings bar, and the ctrl-group.
 *
 * Usage:
 *   const envPicker = new EnvPicker({
 *     onActivate: (id) => activateEnv(id),  // id is null for Global
 *     onManage: () => openPopup(),
 *   });
 *   envPicker.bindTrigger(document.getElementById("btn-env-picker"));
 *   envPicker.load(currentEnvironments);
 */

import { t } from "../i18n.js";

const _GLOBE = `<svg class="env-picker-globe" xmlns="http://www.w3.org/2000/svg"
    width="12" height="12" viewBox="0 0 24 24"
    fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <circle cx="12" cy="12" r="10"/>
  <line x1="2" y1="12" x2="22" y2="12"/>
  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
</svg>`;

// Sentinel id for the "Manage…" row — kept distinct from environment ids (which
// are UUIDs) so the resolved menu id is unambiguous.
const _MANAGE_ID = "__manage__";

export class EnvPicker {
  #data = { globalVariables: {}, activeEnvironmentId: null, environments: [] };
  #onManage;
  #onActivate;
  #triggers = [];
  #open = false;

  constructor({ onManage, onActivate } = {}) {
    this.#onManage = onManage;
    this.#onActivate = onActivate;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  bindTrigger(btn) {
    if (!btn) return;
    this.#syncTrigger(btn);
    btn.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
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

  #activeEnv() {
    const id = this.#data.activeEnvironmentId;
    return id ? (this.#data.environments ?? []).find((e) => e.id === id) : null;
  }

  #syncTrigger(btn) {
    const env = this.#activeEnv();
    const label = env?.name ?? t("env.global");
    btn.innerHTML = `${_GLOBE}<span class="env-picker-label"></span>`;
    btn.querySelector(".env-picker-label").textContent = label;
    btn.classList.toggle("env-picker-trigger--active", !!env);
  }

  /**
   * Open a native OS popup menu anchored under the trigger. Rows are Global
   * (id null) then each named environment with a check beside the active one, a
   * separator, then "Manage…". Environment labels are upper-cased to match the
   * trigger and the environments list. Resolves to the clicked id (or null when
   * dismissed); we map it back to the activate / manage action.
   */
  async #openMenu(btn) {
    // Re-entrancy guard; also a no-op outside Electron (no native menu host).
    if (this.#open || !window.hippo?.ui?.contextMenu?.show) return;

    const activeId = this.#data.activeEnvironmentId ?? null;
    const entries = [
      { id: null, name: t("env.global") },
      ...(this.#data.environments ?? []).map((e) => ({
        id: e.id,
        name: e.name,
      })),
    ];

    // Native menu ids are strings; key each row by index and map the chosen key
    // back to its (possibly null) environment id.
    const idByKey = new Map();
    const items = entries.map((entry, i) => {
      const key = `env:${i}`;
      idByKey.set(key, entry.id);
      return {
        id: key,
        label: String(entry.name ?? "").toUpperCase(),
        type: "checkbox",
        checked: entry.id === activeId,
      };
    });
    items.push({ type: "separator" });
    items.push({ id: _MANAGE_ID, label: t("env.manage") });

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
    if (choice === _MANAGE_ID) {
      this.#onManage?.();
      return;
    }
    if (idByKey.has(choice)) {
      const id = idByKey.get(choice);
      if (id !== activeId) this.#onActivate?.(id);
    }
  }
}
