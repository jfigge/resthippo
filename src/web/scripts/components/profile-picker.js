/*
 * Copyright 2026 Jason Figge
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This file is part of Rest Hippo.
 *
 * Rest Hippo is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option) any later
 * version.
 *
 * Rest Hippo is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR
 * A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with
 * Rest Hippo. If not, see <https://www.gnu.org/licenses/>.
 */

"use strict";

/**
 * profile-picker.js — variable-profile selector (native OS menu).
 *
 * The mirror of {@link EnvPicker} for folder-variable PROFILES. Bound to a small
 * trigger button (the "swap" icon the RequestEditor places by the URL preview /
 * Send button), it opens a native OS popup menu listing the profiles VISIBLE at
 * the current request — grouped by the owner that defines them, outermost first.
 *
 * Profiles are scoped, so the menu is not one flat list: it opens with a single
 * "All Default" entry that clears every in-scope selection (⌥⌘0), then one section
 * per owner — a separator, a disabled heading naming the owning folder (or the
 * collection), and a RADIO run of that owner's Default plus its profiles. One
 * profile is active per owner and they layer at send time, so each section carries
 * its own independent dot. Electron groups consecutive radio items automatically,
 * which is exactly what the separator + heading between sections gives us.
 *
 * The ⌥⌘1–9 accelerators are advertised against the FLAT outermost→innermost
 * order (Defaults are not addressable), so slot N means the same thing here as it
 * does to the keyboard handler. Only the first nine get one — the visible total
 * may exceed nine once several owners are in scope.
 *
 * Selecting an entry routes to `onActivate({ ownerKey, profileId })`; a null
 * `ownerKey` means "clear every in-scope owner", a null `profileId` means "this
 * owner falls back to its Default". The RequestEditor turns that into the app-wide
 * profile change.
 *
 * The menu is shown by the main process over `ui:context-menu:show`
 * (window.hippo.ui.contextMenu.show), which resolves with the clicked item's id,
 * so this component only builds the item list and routes the result.
 *
 * Usage:
 *   const picker = new ProfilePicker({ onActivate: (sel) => activateProfile(sel) });
 *   picker.bindTrigger(iconButton);
 *   picker.load({ groups, activeByOwner });
 */

import { t } from "../i18n.js";
import { profileSlotAccelerator } from "../keymap.js";

export class ProfilePicker {
  #data = { groups: [], activeByOwner: {} };
  #onActivate;
  #triggers = [];
  #open = false;

  constructor({ onActivate } = {}) {
    this.#onActivate = onActivate;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  bindTrigger(btn) {
    if (!btn) return;
    // Primary (left) click opens the profile list.
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

  /**
   * @param {{groups?: object[], activeByOwner?: Record<string,string>}} data
   *   `groups` are the owner groups visible at the current request, outermost →
   *   innermost (see components/profile-scope.js).
   */
  load(data) {
    this.#data = {
      groups: Array.isArray(data?.groups) ? data.groups : [],
      activeByOwner:
        data?.activeByOwner && typeof data.activeByOwner === "object"
          ? data.activeByOwner
          : {},
    };
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /**
   * Build the native menu template plus the id → selection map that decodes the
   * click. Split out from #openMenu so the shape is testable without a native
   * menu host.
   *
   * @returns {{items: object[], byId: Map<string,{ownerKey: string|null,
   *            profileId: string|null}>}}
   */
  buildMenu() {
    const { groups, activeByOwner } = this.#data;
    const byId = new Map();
    const items = [];

    // Slot numbering runs across the flat outermost→innermost profile order and
    // skips the per-owner Defaults, matching the keyboard handler.
    let slot = 0;
    const anyActive = groups.some((g) => {
      const id = activeByOwner[g.ownerKey];
      return id && (g.profiles ?? []).some((p) => p.id === id);
    });

    byId.set("all", { ownerKey: null, profileId: null });
    items.push({
      id: "all",
      label: t("profiles.allDefault"),
      type: "checkbox",
      checked: !anyActive,
      accelerator: profileSlotAccelerator(0),
    });

    for (const g of groups) {
      const active = activeByOwner[g.ownerKey] ?? null;
      items.push({ type: "separator" });
      // A disabled item is the only way to title a section in a native menu.
      items.push({
        id: `head:${g.ownerKey}`,
        label: g.ownerName || t("profiles.groupCollection"),
        enabled: false,
      });

      const defaultId = `g:${g.ownerKey}:`;
      byId.set(defaultId, { ownerKey: g.ownerKey, profileId: null });
      items.push({
        id: defaultId,
        label: t("profiles.default"),
        type: "radio",
        checked: !active || !(g.profiles ?? []).some((p) => p.id === active),
      });

      for (const p of g.profiles ?? []) {
        const key = `g:${g.ownerKey}:${p.id}`;
        byId.set(key, { ownerKey: g.ownerKey, profileId: p.id });
        slot += 1;
        items.push({
          id: key,
          label: String(p.name ?? ""),
          type: "radio",
          checked: p.id === active,
          ...(slot <= 9 ? { accelerator: profileSlotAccelerator(slot) } : {}),
        });
      }
    }

    return { items, byId };
  }

  /**
   * Open a native OS popup menu anchored under the trigger. Resolves to the
   * clicked id (or null when dismissed); a change routes to onActivate.
   */
  async #openMenu(btn) {
    // Re-entrancy guard; also a no-op outside Electron (no native menu host).
    if (this.#open || !window.hippo?.ui?.contextMenu?.show) return;
    if (!this.#data.groups.length) return; // nothing in scope here

    const { items, byId } = this.buildMenu();
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
      return; // IPC failure — leave the active profiles unchanged
    } finally {
      this.#open = false;
    }

    if (choice == null || !byId.has(choice)) return; // dismissed / a heading
    const sel = byId.get(choice);
    const current = this.#data.activeByOwner[sel.ownerKey] ?? null;
    // "All Default" always routes (it may clear several owners at once); a
    // per-owner pick only routes when it is a real change.
    if (sel.ownerKey === null || sel.profileId !== current) {
      this.#onActivate?.(sel);
    }
  }
}
