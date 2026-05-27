"use strict";

/**
 * env-picker.js — Environment selector
 *
 * Renders a trigger button that opens the native OS context menu listing
 * Global + all named environments (radio-checked on active), a separator,
 * and a "Manage…" entry that opens the environments popup.
 *
 * Multiple trigger buttons can be bound to one instance so the same picker
 * works in the panel header, the nav-settings bar, and the ctrl-group.
 *
 * Usage:
 *   const envPicker = new EnvPicker({ onManage: () => openPopup() });
 *   envPicker.bindTrigger(document.getElementById("btn-env-picker"));
 *   envPicker.load(currentEnvironments);
 */

const _GLOBE = `<svg class="env-picker__globe" xmlns="http://www.w3.org/2000/svg"
    width="12" height="12" viewBox="0 0 24 24"
    fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <circle cx="12" cy="12" r="10"/>
  <line x1="2" y1="12" x2="22" y2="12"/>
  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
</svg>`;

const _CHEVRON = `<svg class="env-picker__chevron" viewBox="0 0 6 4"
    fill="currentColor" aria-hidden="true">
  <path d="M0 0 6 0 3 4Z"/>
</svg>`;

export class EnvPicker {
  #data = { globalVariables: {}, activeEnvironmentId: null, environments: [] };
  #onManage;
  #triggers = [];

  constructor({ onManage } = {}) {
    this.#onManage = onManage;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  bindTrigger(btn) {
    if (!btn) return;
    this.#syncTrigger(btn);
    btn.addEventListener("click", (e) => this.#show(e.clientX, e.clientY));
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
    const label = env?.name ?? "Global";
    btn.innerHTML = `${_GLOBE}<span class="env-picker__label"></span>${_CHEVRON}`;
    btn.querySelector(".env-picker__label").textContent = label;
    btn.classList.toggle("env-picker__trigger--active", !!env);
  }

  async #show(x, y) {
    const activeId = this.#data.activeEnvironmentId;
    const items = [
      {
        id: "__global__",
        label: "GLOBAL",
        type: "radio",
        checked: !activeId,
      },
      ...(this.#data.environments ?? []).map((e) => ({
        id: e.id,
        label: e.name,
        type: "radio",
        checked: e.id === activeId,
      })),
      { type: "separator" },
      { id: "__manage__", label: "Manage…" },
    ];

    const clicked = await window.wurl.ui.contextMenu({ items, x, y });
    if (!clicked) return;

    if (clicked === "__manage__") {
      this.#onManage?.();
    } else {
      window.dispatchEvent(
        new CustomEvent("wurl:env-activate", {
          detail: { id: clicked === "__global__" ? null : clicked },
        }),
      );
    }
  }
}
