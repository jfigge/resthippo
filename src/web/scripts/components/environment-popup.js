/**
 * environment-popup.js — Environment selector popup
 *
 * Allows the user to:
 *   • View all environments (the active one is marked with a checkmark)
 *   • Select an environment (switches the active tree-view data)
 *   • Add a new environment (empty collections)
 *   • Clone an environment (deep-copies all collections under a new name)
 *   • Delete an environment (disabled when only 1 remains)
 *
 * The popup stays open across operations so the user can make multiple
 * changes.  Each action dispatches a custom event on window; app.js
 * handles the state mutation and calls popup.update() to refresh the list.
 *
 * Events dispatched:
 *   wurl:env-select  { id }                    — switch active environment
 *   wurl:env-add     { name }                  — create new empty environment
 *   wurl:env-clone   { sourceId, name }         — clone an environment
 *   wurl:env-delete  { id }                    — delete an environment
 */

"use strict";

import { PopupManager } from "../popup-manager.js";

// ── SVG icons ─────────────────────────────────────────────────────────────────

const ICON_CHECK = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
  aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`;

const ICON_CLONE = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
  aria-hidden="true">
  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
</svg>`;

const ICON_DELETE = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
  aria-hidden="true">
  <polyline points="3 6 5 6 21 6"/>
  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
  <path d="M10 11v6"/><path d="M14 11v6"/>
  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
</svg>`;

// ── EnvironmentPopup class ────────────────────────────────────────────────────

export class EnvironmentPopup {
  /** @type {HTMLElement} */
  #el;

  /** @type {{id: string, name: string}[]} */
  #environments = [];

  /** @type {string|null} */
  #activeId = null;

  /**
   * Tracks which action the name-input row is performing.
   * null | "add" | { type: "clone", sourceId: string, sourceName: string }
   */
  #pendingAction = null;

  constructor() {
    this.#el = this.#build();
  }

  /** Root DOM element — required by PopupManager. */
  get element() {
    return this.#el;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Open the popup, seeded with the current app state.
   * @param {{ environments: object[], activeEnvironmentId: string }} state
   */
  open({ environments, activeEnvironmentId }) {
    this.#environments = environments.map(e => ({ ...e }));
    this.#activeId     = activeEnvironmentId;
    this.#pendingAction = null;
    this.#renderList();
    this.#setNameInputVisible(false);
    PopupManager.open(this);
  }

  /**
   * Refresh the list without closing the popup.
   * Called by app.js after any environment mutation.
   * @param {{ environments: object[], activeEnvironmentId: string }} state
   */
  update({ environments, activeEnvironmentId }) {
    this.#environments  = environments.map(e => ({ ...e }));
    this.#activeId      = activeEnvironmentId;
    this.#pendingAction = null;
    this.#renderList();
    this.#setNameInputVisible(false);
  }

  /** Called by PopupManager when the user clicks the overlay mask. */
  onMaskClick() {
    PopupManager.close();
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  #build() {
    const el = document.createElement("div");
    el.className = "popup env-popup";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", "Environments");

    el.innerHTML = `
      <div class="popup-header">
        <span class="popup-title">Environments</span>
        <button class="popup-close" aria-label="Close environments" title="Close">✕</button>
      </div>
      <div class="popup-body env-popup-body">
        <div class="env-name-input-row">
          <input
            class="env-name-input"
            type="text"
            placeholder="Environment name…"
            autocomplete="off"
            spellcheck="false"
          />
          <button class="popup-btn popup-btn--primary env-name-ok" disabled>Add</button>
          <button class="popup-btn popup-btn--secondary env-name-cancel">Cancel</button>
        </div>
        <ul class="env-list" role="listbox" aria-label="Environments"></ul>
      </div>
      <div class="popup-footer">
        <button class="popup-btn popup-btn--secondary env-new-btn">+ New Environment</button>
        <button class="popup-btn popup-btn--primary js-close">Close</button>
      </div>
    `;

    // Header close
    el.querySelector(".popup-close").addEventListener("click", () => PopupManager.close());
    // Footer close
    el.querySelector(".js-close").addEventListener("click", () => PopupManager.close());
    // New environment
    el.querySelector(".env-new-btn").addEventListener("click", () => this.#startAdd());

    // Name-input controls
    const nameInput  = el.querySelector(".env-name-input");
    const nameOkBtn  = el.querySelector(".env-name-ok");
    const cancelBtn  = el.querySelector(".env-name-cancel");

    nameInput.addEventListener("input", () => {
      nameOkBtn.disabled = !nameInput.value.trim();
    });
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !nameOkBtn.disabled) nameOkBtn.click();
      if (e.key === "Escape") cancelBtn.click();
    });
    nameOkBtn.addEventListener("click",  () => this.#commitName());
    cancelBtn.addEventListener("click",  () => this.#setNameInputVisible(false));

    return el;
  }

  // ── List rendering ─────────────────────────────────────────────────────────

  #renderList() {
    const ul    = this.#el.querySelector(".env-list");
    ul.innerHTML = "";
    const count = this.#environments.length;

    this.#environments.forEach(env => {
      const isActive = env.id === this.#activeId;

      const li = document.createElement("li");
      li.className = "env-list-item" + (isActive ? " env-list-item--active" : "");
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(isActive));

      // Checkmark column
      const check = document.createElement("span");
      check.className = "env-list-item__check";
      check.innerHTML = isActive ? ICON_CHECK : "";

      // Name button (clicking selects the environment)
      const nameBtn = document.createElement("button");
      nameBtn.className = "env-list-item__name";
      nameBtn.textContent = env.name;
      nameBtn.setAttribute("aria-label", `Select ${env.name}`);
      nameBtn.addEventListener("click", () => this.#selectEnv(env.id));

      // Action buttons
      const actions = document.createElement("div");
      actions.className = "env-list-item__actions";

      const cloneBtn = document.createElement("button");
      cloneBtn.className  = "env-action-btn";
      cloneBtn.title      = "Clone environment";
      cloneBtn.innerHTML  = ICON_CLONE;
      cloneBtn.setAttribute("aria-label", `Clone ${env.name}`);
      cloneBtn.addEventListener("click", () => this.#startClone(env));

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "env-action-btn env-action-btn--danger";
      deleteBtn.title     = count <= 1 ? "Cannot delete the only environment" : "Delete environment";
      deleteBtn.disabled  = count <= 1;
      deleteBtn.innerHTML = ICON_DELETE;
      deleteBtn.setAttribute("aria-label", `Delete ${env.name}`);
      deleteBtn.addEventListener("click", () => this.#confirmDelete(env));

      actions.appendChild(cloneBtn);
      actions.appendChild(deleteBtn);

      li.appendChild(check);
      li.appendChild(nameBtn);
      li.appendChild(actions);
      ul.appendChild(li);
    });
  }

  // ── Name input form ────────────────────────────────────────────────────────

  #setNameInputVisible(visible, { placeholder = "Environment name…", defaultValue = "" } = {}) {
    const row    = this.#el.querySelector(".env-name-input-row");
    const input  = this.#el.querySelector(".env-name-input");
    const okBtn  = this.#el.querySelector(".env-name-ok");
    const newBtn = this.#el.querySelector(".env-new-btn");

    if (visible) {
      input.placeholder = placeholder;
      input.value       = defaultValue;
      okBtn.disabled    = !defaultValue.trim();
      input.classList.remove("env-name-input--error");
      row.classList.add("env-name-input-row--visible");
      newBtn.disabled = true;
      requestAnimationFrame(() => { input.focus(); input.select(); });
    } else {
      row.classList.remove("env-name-input-row--visible");
      input.value     = "";
      newBtn.disabled = false;
      this.#pendingAction = null;
    }
  }

  #startAdd() {
    this.#pendingAction = "add";
    this.#setNameInputVisible(true, { placeholder: "New environment name…", defaultValue: "" });
  }

  #startClone(env) {
    this.#pendingAction = { type: "clone", sourceId: env.id, sourceName: env.name };
    this.#setNameInputVisible(true, {
      placeholder:  "New environment name…",
      defaultValue: `${env.name} (copy)`,
    });
  }

  #commitName() {
    const input = this.#el.querySelector(".env-name-input");
    const name  = input.value.trim();
    if (!name) return;

    // Uniqueness check (case-insensitive)
    if (this.#environments.some(e => e.name.toLowerCase() === name.toLowerCase())) {
      input.classList.add("env-name-input--error");
      input.title = "An environment with this name already exists.";
      setTimeout(() => {
        input.classList.remove("env-name-input--error");
        input.title = "";
      }, 1500);
      return;
    }

    const action = this.#pendingAction;
    this.#setNameInputVisible(false);

    if (action === "add") {
      window.dispatchEvent(new CustomEvent("wurl:env-add", { detail: { name }, bubbles: true }));
    } else if (action?.type === "clone") {
      window.dispatchEvent(new CustomEvent("wurl:env-clone", {
        detail: { sourceId: action.sourceId, name },
        bubbles: true,
      }));
    }
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  #selectEnv(id) {
    if (id === this.#activeId) return;
    window.dispatchEvent(new CustomEvent("wurl:env-select", { detail: { id }, bubbles: true }));
  }

  #confirmDelete(env) {
    PopupManager.confirm({
      title:        "Delete Environment?",
      message:      `Delete "<strong>${this.#escape(env.name)}</strong>" and all its collections? This cannot be undone.`,
      confirmLabel: "Delete",
      confirmClass: "popup-btn--danger",
      onConfirm:    () => {
        window.dispatchEvent(new CustomEvent("wurl:env-delete", { detail: { id: env.id }, bubbles: true }));
      },
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  #escape(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
}

