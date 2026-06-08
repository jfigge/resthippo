"use strict";

import { icon } from "../icons.js";
import { PopupManager } from "../popup-manager.js";

/**
 * layout-picker.js — Panel-layout selector
 *
 * Renders a method-picker-style trigger button that opens a fixed-position
 * dropdown showing the four available panel arrangements.  Two trigger buttons
 * can be bound to the same picker instance (header bar + remove-headers bar),
 * matching the pattern used for the collections popup.
 *
 * The dropdown goes through `PopupManager.openMenu()` — the canonical path for
 * anchored menus — so it does not register its own outside-click/mount logic.
 * See the "Popups & menus" note in CLAUDE.md.
 *
 * Usage:
 *   import { LayoutPicker } from "./components/layout-picker.js";
 *   const picker = new LayoutPicker({ layout: 1, onSelect: (n) => applyLayout(n) });
 *   picker.bindTrigger(document.getElementById("btn-layout"));
 *   picker.bindTrigger(document.getElementById("btn-layout-nav"));
 */

// ── Layout icon SVGs (fill="currentColor", viewBox="0 0 28 20") ──────────────
// Three fill-opacity levels mark the three panels: nav 0.38 · request 0.72 · response 0.52

const _NAV = `fill-opacity="0.38"`;
const _REQ = `fill-opacity="0.72"`;
const _RES = `fill-opacity="0.52"`;

const LAYOUT_ICONS = {
  // 1 — three equal columns: [nav | request | response]
  1: `<svg viewBox="0 0 28 20" fill="currentColor" aria-hidden="true">
        <rect x="0"  y="0" width="7"  height="20" rx="1" ${_NAV}/>
        <rect x="9"  y="0" width="9"  height="20" rx="1" ${_REQ}/>
        <rect x="20" y="0" width="8"  height="20" rx="1" ${_RES}/>
      </svg>`,

  // 2 — nav full-height left; request top-right / response bottom-right
  2: `<svg viewBox="0 0 28 20" fill="currentColor" aria-hidden="true">
        <rect x="0" y="0"  width="7"  height="20" rx="1" ${_NAV}/>
        <rect x="9" y="0"  width="19" height="9"  rx="1" ${_REQ}/>
        <rect x="9" y="11" width="19" height="9"  rx="1" ${_RES}/>
      </svg>`,

  // 3 — nav + request side-by-side top; response full width bottom
  3: `<svg viewBox="0 0 28 20" fill="currentColor" aria-hidden="true">
        <rect x="0"  y="0"  width="11" height="9" rx="1" ${_NAV}/>
        <rect x="13" y="0"  width="15" height="9" rx="1" ${_REQ}/>
        <rect x="0"  y="11" width="28" height="9" rx="1" ${_RES}/>
      </svg>`,

  // 4 — all three panels stacked top to bottom
  4: `<svg viewBox="0 0 28 20" fill="currentColor" aria-hidden="true">
        <rect x="0" y="0"  width="28" height="5" rx="1" ${_NAV}/>
        <rect x="0" y="7"  width="28" height="6" rx="1" ${_REQ}/>
        <rect x="0" y="15" width="28" height="5" rx="1" ${_RES}/>
      </svg>`,
};

const LAYOUT_LABELS = {
  1: "Side by side",
  2: "Left + stacked",
  3: "Top + full bottom",
  4: "All stacked",
};

const _CHEVRON = icon("caret", {
  size: null,
  className: "layout-picker__chevron",
});

const _CHECK = icon("check", { size: 12 });

// ── LayoutPicker ─────────────────────────────────────────────────────────────

export class LayoutPicker {
  #layout = 1;
  #onSelect;
  #menu = null;
  #triggers = [];

  // Drops our stale #menu reference whenever PopupManager closes the menu by
  // any path (item select, mask click, window resize) — all fire
  // wurl:popup-closed — so the next trigger click re-opens instead of no-oping.
  #onPopupClosed = () => {
    this.#menu = null;
  };

  /**
   * @param {{ layout?: number, onSelect?: (layout: number) => void }} opts
   */
  constructor({ layout = 1, onSelect } = {}) {
    this.#layout = layout;
    this.#onSelect = onSelect;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Wire an existing <button> element as a trigger for this picker.
   * Multiple buttons can be bound — they all open the same dropdown.
   * @param {HTMLButtonElement} btn
   */
  bindTrigger(btn) {
    this.#syncTrigger(btn);
    btn.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      this.#menu ? this.#closeMenu() : this.#openMenu(btn);
    });
    this.#triggers.push(btn);
  }

  /**
   * Update the displayed layout without firing onSelect.
   * Call this when restoring persisted settings.
   * @param {number} layout  1–4
   */
  load(layout) {
    this.#layout = layout;
    this.#triggers.forEach((t) => this.#syncTrigger(t));
    if (this.#menu) this.#syncChecks();
  }

  // ── Private ───────────────────────────────────────────────────────────────

  #syncTrigger(btn) {
    btn.innerHTML = `
      <span class="layout-picker__icon">${LAYOUT_ICONS[this.#layout]}</span>
      ${_CHEVRON}
    `;
  }

  #syncChecks() {
    this.#menu?.querySelectorAll(".layout-picker__item").forEach((item) => {
      const n = parseInt(item.dataset.layout, 10);
      item.classList.toggle(
        "layout-picker__item--selected",
        n === this.#layout,
      );
      item.setAttribute("aria-selected", String(n === this.#layout));
    });
  }

  #openMenu(nearEl) {
    if (this.#menu) return;

    const menu = document.createElement("div");
    menu.className = "layout-picker__menu";
    menu.setAttribute("role", "listbox");
    menu.setAttribute("aria-label", "Layout options");
    menu.addEventListener("mousedown", (e) => e.preventDefault());

    for (let i = 1; i <= 4; i++) {
      const item = document.createElement("div");
      item.className = "layout-picker__item";
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(i === this.#layout));
      item.dataset.layout = String(i);
      if (i === this.#layout)
        item.classList.add("layout-picker__item--selected");

      item.innerHTML = `
        <span class="layout-picker__item-check" aria-hidden="true">${_CHECK}</span>
        <span class="layout-picker__item-icon">${LAYOUT_ICONS[i]}</span>
        <span class="layout-picker__item-label">${LAYOUT_LABELS[i]}</span>
      `;

      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const selected = parseInt(item.dataset.layout, 10);
        this.#layout = selected;
        this.#triggers.forEach((t) => this.#syncTrigger(t));
        this.#closeMenu();
        this.#onSelect?.(selected);
      });

      menu.appendChild(item);
    }

    const { x, y } = this.#menuPosition(nearEl);
    PopupManager.openMenu(menu, x, y);
    this.#menu = menu;

    // openMenu owns the click-capturing mask and fires wurl:popup-opened. A
    // mask click or window resize closes the menu via PopupManager and fires
    // wurl:popup-closed — listen once to drop our reference (see #onPopupClosed).
    window.addEventListener("wurl:popup-closed", this.#onPopupClosed, {
      once: true,
    });
  }

  #closeMenu() {
    if (!this.#menu) return;
    // PopupManager.close() fires wurl:popup-closed → #onPopupClosed nulls #menu.
    PopupManager.close();
  }

  // Anchor point for openMenu: left-aligned under the trigger, flipped above it
  // when the menu would overflow the bottom. openMenu's own viewport clamp acts
  // only as a safety net for the (unused-for-layout) right-edge case.
  #menuPosition(nearEl) {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const MW = 200;
    const MH = 4 * 42 + 10;
    const r = nearEl.getBoundingClientRect();
    const left = Math.max(4, Math.min(r.left, W - MW - 4));
    const below = r.bottom + 4;
    const above = r.top - MH - 4;
    const top = below + MH > H - 4 ? Math.max(4, above) : below;
    return { x: left, y: top };
  }
}
