"use strict";

/**
 * env-picker.js — Environment selector
 *
 * Renders a trigger button that opens the environments editor directly.
 *
 * Multiple trigger buttons can be bound to one instance so the same picker
 * works in the panel header, the nav-settings bar, and the ctrl-group.
 *
 * Usage:
 *   const envPicker = new EnvPicker({ onManage: () => openPopup() });
 *   envPicker.bindTrigger(document.getElementById("btn-env-picker"));
 *   envPicker.load(currentEnvironments);
 */

const _GLOBE = `<svg class="env-picker-globe" xmlns="http://www.w3.org/2000/svg"
    width="12" height="12" viewBox="0 0 24 24"
    fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <circle cx="12" cy="12" r="10"/>
  <line x1="2" y1="12" x2="22" y2="12"/>
  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
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
    btn.addEventListener("click", () => this.#onManage?.());
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
    btn.innerHTML = `${_GLOBE}<span class="env-picker-label"></span>`;
    btn.querySelector(".env-picker-label").textContent = label;
    btn.classList.toggle("env-picker-trigger--active", !!env);
  }
}
