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
 * profile-picker.js — variable-profile selector (native OS menu).
 *
 * The mirror of {@link EnvPicker} for folder-variable PROFILES. Bound to a small
 * trigger button (the "swap" icon the RequestEditor places by the URL preview /
 * Send button), it opens a native OS popup menu listing the active collection's
 * profiles — the Default (id null) plus each named profile — with a check beside
 * the active one and each profile's ⌥⌘0–9 switch shortcut advertised on the right.
 * Selecting one routes to `onActivate(id)` (id null = Default); the RequestEditor
 * turns that into the app-wide profile change.
 *
 * The menu is shown by the main process over `ui:context-menu:show`
 * (window.hippo.ui.contextMenu.show), which resolves with the clicked item's id,
 * so this component only builds the item list and routes the result.
 *
 * Usage:
 *   const picker = new ProfilePicker({ onActivate: (id) => activateProfile(id) });
 *   picker.bindTrigger(iconButton);
 *   picker.load({ profiles, activeProfileId });
 */

import { t } from "../i18n.js";
import { profileSlotAccelerator } from "../keymap.js";

export class ProfilePicker {
  #data = { profiles: [], activeProfileId: null };
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

  load(data) {
    this.#data = data ?? this.#data;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /**
   * Open a native OS popup menu anchored under the trigger listing the active
   * collection's profiles — Default (id null) then each named profile, with a
   * check beside the active one and its ⌥⌘0–9 shortcut on the right. Resolves to
   * the clicked id (or null when dismissed); a change routes to onActivate.
   */
  async #openMenu(btn) {
    // Re-entrancy guard; also a no-op outside Electron (no native menu host).
    if (this.#open || !window.hippo?.ui?.contextMenu?.show) return;

    const activeId = this.#data.activeProfileId ?? null;

    // Native menu ids are strings; key each row by index and map the chosen key
    // back to its (possibly null) profile id.
    const idByKey = new Map();
    const entries = [
      { id: null, name: t("profiles.default") },
      ...(this.#data.profiles ?? []).map((p) => ({ id: p.id, name: p.name })),
    ];
    const items = entries.map((entry, i) => {
      const key = `profile:${i}`;
      idByKey.set(key, entry.id);
      return {
        id: key,
        label: String(entry.name ?? ""),
        type: "checkbox",
        checked: entry.id === activeId,
        // Slot i (0 = Default, 1–9 = the Nth named profile) — advertise the
        // switch shortcut. Only 0–9 have one (named profiles cap at 9).
        ...(i <= 9 ? { accelerator: profileSlotAccelerator(i) } : {}),
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
      return; // IPC failure — leave the active profile unchanged
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
