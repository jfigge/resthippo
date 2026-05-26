"use strict";

/**
 * env-picker.js — Environment selector
 *
 * Renders a method-picker-style trigger button that opens a fixed-position
 * dropdown listing Global + all named environments (checkmark on active),
 * a separator, and a "Manage…" entry that opens the environments popup.
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
  #data        = { globalVariables: {}, activeEnvironmentId: null, environments: [] };
  #onManage;
  #menu        = null;
  #menuHandler = null;
  #triggers    = [];

  constructor({ onManage } = {}) {
    this.#onManage = onManage;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  bindTrigger(btn) {
    if (!btn) return;
    this.#syncTrigger(btn);
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.#menu ? this.#closeMenu() : this.#openMenu(btn);
    });
    this.#triggers.push(btn);
  }

  load(data) {
    this.#data = data ?? this.#data;
    this.#triggers.forEach(t => this.#syncTrigger(t));
    if (this.#menu) this.#syncChecks();
  }

  // ── Private ────────────────────────────────────────────────────────────────

  #activeEnv() {
    const id = this.#data.activeEnvironmentId;
    return id ? (this.#data.environments ?? []).find(e => e.id === id) : null;
  }

  #syncTrigger(btn) {
    const env   = this.#activeEnv();
    const label = env?.name ?? "Global";
    btn.innerHTML = `${_GLOBE}<span class="env-picker__label">${label}</span>${_CHEVRON}`;
    btn.classList.toggle("env-picker__trigger--active", !!env);
  }

  #syncChecks() {
    const activeId = this.#data.activeEnvironmentId;
    this.#menu?.querySelectorAll(".env-picker__item[data-id]").forEach(item => {
      const id  = item.dataset.id;
      const sel = id === "__global__" ? !activeId : id === activeId;
      item.classList.toggle("env-picker__item--selected", sel);
      item.setAttribute("aria-selected", String(sel));
    });
  }

  #openMenu(nearEl) {
    if (this.#menu) return;
    window.dispatchEvent(new CustomEvent("wurl:popup-opened"));

    const menu = document.createElement("div");
    menu.className = "env-picker__menu";
    menu.setAttribute("role", "listbox");
    menu.setAttribute("aria-label", "Environment options");
    menu.addEventListener("mousedown", e => e.preventDefault());

    const activeId = this.#data.activeEnvironmentId;

    menu.appendChild(this.#makeItem("__global__", "Global", !activeId));
    for (const env of (this.#data.environments ?? [])) {
      menu.appendChild(this.#makeItem(env.id, env.name, env.id === activeId));
    }

    const sep = document.createElement("div");
    sep.className = "env-picker__separator";
    sep.setAttribute("role", "separator");
    menu.appendChild(sep);

    const manage = document.createElement("div");
    manage.className = "env-picker__manage";
    manage.setAttribute("role", "option");
    manage.textContent = "Manage…";
    manage.addEventListener("mousedown", e => {
      e.preventDefault();
      this.#closeMenu();
      this.#onManage?.();
    });
    menu.appendChild(manage);

    this.#positionMenu(menu, nearEl);
    document.body.appendChild(menu);
    this.#menu = menu;

    this.#menuHandler = e => {
      if (!menu.contains(e.target) &&
          !this.#triggers.some(t => t === e.target || t.contains(e.target))) {
        this.#closeMenu();
      }
    };
    document.addEventListener("mousedown", this.#menuHandler, { capture: true });
  }

  #makeItem(id, label, selected) {
    const item = document.createElement("div");
    item.className = "env-picker__item" + (selected ? " env-picker__item--selected" : "");
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(selected));
    item.dataset.id = id;
    item.innerHTML = `
      <span class="env-picker__item-check" aria-hidden="true"></span>
      <span class="env-picker__item-label">${label}</span>
    `;
    item.addEventListener("mousedown", e => {
      e.preventDefault();
      const newId = id === "__global__" ? null : id;
      this.#closeMenu();
      window.dispatchEvent(new CustomEvent("wurl:env-activate", { detail: { id: newId } }));
    });
    return item;
  }

  #closeMenu() {
    if (!this.#menu) return;
    this.#menu.remove();
    this.#menu = null;
    if (this.#menuHandler) {
      document.removeEventListener("mousedown", this.#menuHandler, { capture: true });
      this.#menuHandler = null;
    }
    window.dispatchEvent(new CustomEvent("wurl:popup-closed"));
  }

  #positionMenu(menu, nearEl) {
    const W  = window.innerWidth;
    const H  = window.innerHeight;
    const MW = 180;
    const itemCount = (this.#data.environments?.length ?? 0) + 3; // global + envs + sep + manage
    const MH = itemCount * 30 + 20;
    const r     = nearEl.getBoundingClientRect();
    const left  = Math.max(4, Math.min(r.left, W - MW - 4));
    const below = r.bottom + 4;
    const above = r.top - MH - 4;
    const top   = (below + MH > H - 4) ? Math.max(4, above) : below;
    menu.style.cssText = `left:${left}px; top:${top}px;`;
  }
}
