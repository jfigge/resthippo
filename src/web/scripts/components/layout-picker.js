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
  className: "layout-picker-chevron",
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
    // Keyboard open: a <button> emits no mousedown for Enter/Space, so handle
    // the open keys here. preventDefault stops the synthesized click and page
    // scroll; opening with focus moves into the listbox onto the current layout.
    btn.addEventListener("keydown", (e) => {
      if (
        e.key === "Enter" ||
        e.key === " " ||
        e.key === "ArrowDown" ||
        e.key === "ArrowUp"
      ) {
        e.preventDefault();
        if (!this.#menu) this.#openMenu(btn, { focus: true });
      }
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
      <span class="layout-picker-icon">${LAYOUT_ICONS[this.#layout]}</span>
      ${_CHEVRON}
    `;
  }

  #syncChecks() {
    this.#menu?.querySelectorAll(".layout-picker-item").forEach((item) => {
      const n = parseInt(item.dataset.layout, 10);
      item.classList.toggle("layout-picker-item--selected", n === this.#layout);
      item.setAttribute("aria-selected", String(n === this.#layout));
    });
  }

  /**
   * @param {HTMLElement} nearEl        trigger to anchor the menu beneath
   * @param {{ focus?: boolean }} [opts] when focus is true (keyboard open), move
   *   focus into the listbox onto the currently-selected option
   */
  #openMenu(nearEl, { focus = false } = {}) {
    if (this.#menu) return;

    const menu = document.createElement("div");
    menu.className = "layout-picker-menu";
    menu.setAttribute("role", "listbox");
    menu.setAttribute("aria-label", "Layout options");
    menu.addEventListener("mousedown", (e) => e.preventDefault());
    menu.addEventListener("keydown", (e) => this.#onMenuKeydown(e));

    for (let i = 1; i <= 4; i++) {
      const item = document.createElement("div");
      item.className = "layout-picker-item";
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(i === this.#layout));
      // Roving tabindex: only the selected option is tabbable; arrow keys move
      // the tab stop between options (see #focusItem).
      item.setAttribute("tabindex", i === this.#layout ? "0" : "-1");
      item.dataset.layout = String(i);
      if (i === this.#layout)
        item.classList.add("layout-picker-item--selected");

      item.innerHTML = `
        <span class="layout-picker-item-check" aria-hidden="true">${_CHECK}</span>
        <span class="layout-picker-item-icon">${LAYOUT_ICONS[i]}</span>
        <span class="layout-picker-item-label">${LAYOUT_LABELS[i]}</span>
      `;

      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.#selectItem(item);
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

    // openMenu does not manage focus — when opened by keyboard, land on the
    // selected option so arrow keys work immediately.
    if (focus) {
      const sel =
        menu.querySelector(".layout-picker-item--selected") ??
        menu.querySelector(".layout-picker-item");
      sel?.focus();
    }
  }

  /** Make `item` the sole tabbable option and move focus to it. */
  #focusItem(item) {
    if (!item) return;
    this.#menu?.querySelectorAll(".layout-picker-item").forEach((it) => {
      it.setAttribute("tabindex", it === item ? "0" : "-1");
    });
    item.focus();
  }

  /** Commit the chosen layout, close the menu, and return focus to the trigger. */
  #selectItem(item) {
    const selected = parseInt(item.dataset.layout, 10);
    this.#layout = selected;
    this.#triggers.forEach((t) => this.#syncTrigger(t));
    this.#closeMenu();
    this.#triggers[0]?.focus();
    this.#onSelect?.(selected);
  }

  /** Keyboard model for the open listbox: arrows/Home/End move, Enter/Space
   *  select, Escape/Tab close (returning focus to the trigger). */
  #onMenuKeydown(e) {
    if (!this.#menu) return;
    const items = [...this.#menu.querySelectorAll(".layout-picker-item")];
    const current = e.target.closest(".layout-picker-item");
    const i = items.indexOf(current);

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        this.#focusItem(items[Math.min(items.length - 1, i + 1)]);
        break;
      case "ArrowUp":
        e.preventDefault();
        this.#focusItem(items[Math.max(0, i - 1)]);
        break;
      case "Home":
        e.preventDefault();
        this.#focusItem(items[0]);
        break;
      case "End":
        e.preventDefault();
        this.#focusItem(items[items.length - 1]);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (current) this.#selectItem(current);
        break;
      case "Escape":
        e.preventDefault();
        this.#closeMenu();
        this.#triggers[0]?.focus();
        break;
      case "Tab":
        // Return focus to the trigger first, then let Tab advance from there so
        // focus is never stranded on the about-to-be-removed menu.
        this.#closeMenu();
        this.#triggers[0]?.focus();
        break;
    }
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
