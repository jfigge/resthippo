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

/**
 * components/settings/commands-panel.js — Settings → Commands (Feature 70).
 *
 * Edits the base process environment every Command request starts from:
 * PATH (the app resolves executables against it), HOME and — on Windows — the
 * handful of system variables most CLIs need. The host environment is never
 * inherited, so this list is exactly what a command sees (plus the request's own
 * Environment rows, which override it).
 *
 * Value model (`settings.commandBaseEnv`):
 *   null  → "use the platform defaults" (computed by the main process, shown
 *           here read-write; editing any row switches to an explicit list)
 *   rows  → [{ key, value, enabled }]
 *
 * Mounted by SettingsPopup; reports edits through the `onChange` callback.
 */

"use strict";

import { icon } from "../../icons.js";
import { t } from "../../i18n.js";
import { wireTrimmedPaste } from "../../utils/trimmed-paste.js";

export class CommandsPanel {
  #el;
  #listEl;
  #statusEl;
  #onChange;
  /** @type {{key:string,value:string,enabled:boolean}[]} */
  #rows = [];
  /** true while showing the (dynamic) platform defaults, i.e. value null */
  #usingDefaults = true;
  #defaultsSeq = 0;

  /** @param {{ onChange?: () => void }} [o] */
  constructor({ onChange } = {}) {
    this.#onChange = onChange;
    this.#el = this.#build();
  }

  /** The `<section class="settings-panel">` element. */
  get element() {
    return this.#el;
  }

  /** @returns {{key:string,value:string,enabled:boolean}[]|null} */
  getValue() {
    if (this.#usingDefaults) return null;
    return this.#rows.map((r) => ({
      key: r.key,
      value: r.value,
      enabled: r.enabled !== false,
    }));
  }

  /** @param {{key:string,value:string,enabled?:boolean}[]|null} rows */
  setValue(rows) {
    if (Array.isArray(rows)) {
      this.#usingDefaults = false;
      this.#rows = rows.map((r) => ({
        key: String(r.key ?? r.name ?? ""),
        value: String(r.value ?? ""),
        enabled: r.enabled !== false,
      }));
      this.#render();
    } else {
      this.#loadDefaults();
    }
  }

  #build() {
    const section = document.createElement("section");
    section.className = "settings-panel";
    section.setAttribute("role", "tabpanel");
    section.dataset.panel = "commands";
    section.hidden = true;

    const help = document.createElement("p");
    help.className = "settings-help";
    help.textContent = t("settings.commands.desc");
    section.appendChild(help);

    const list = document.createElement("div");
    list.className = "cmd-base-env-list";
    list.setAttribute("role", "group");
    list.setAttribute("aria-label", t("settings.commands.listAria"));
    this.#listEl = list;
    section.appendChild(list);

    const actions = document.createElement("div");
    actions.className = "settings-row cmd-base-env-actions";
    const add = document.createElement("button");
    add.type = "button";
    add.className = "btn popup-btn btn--secondary";
    add.textContent = t("settings.commands.add");
    add.addEventListener("click", () => {
      this.#materialise();
      this.#rows.push({ key: "", value: "", enabled: true });
      this.#render();
      this.#listEl
        .querySelector(".cmd-base-env-row:last-child input[type=text]")
        ?.focus();
      this.#changed();
    });
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "btn popup-btn btn--secondary";
    reset.textContent = t("settings.commands.reset");
    reset.title = t("settings.commands.resetTitle");
    reset.addEventListener("click", () => {
      this.#loadDefaults();
      this.#changed();
    });
    const status = document.createElement("span");
    status.className = "settings-label cmd-base-env-status";
    status.setAttribute("role", "status");
    this.#statusEl = status;
    actions.append(add, reset, status);
    section.appendChild(actions);
    return section;
  }

  /** Switch from the dynamic defaults to an explicit (editable) list. */
  #materialise() {
    if (!this.#usingDefaults) return;
    this.#usingDefaults = false;
    this.#syncStatus();
  }

  #changed() {
    this.#syncStatus();
    this.#onChange?.();
  }

  async #loadDefaults() {
    this.#usingDefaults = true;
    const seq = ++this.#defaultsSeq;
    let rows = [];
    try {
      rows = (await window.hippo?.command?.defaults?.())?.rows ?? [];
    } catch {
      rows = [];
    }
    if (seq !== this.#defaultsSeq || !this.#usingDefaults) return;
    this.#rows = rows.map((r) => ({
      key: String(r.key ?? ""),
      value: String(r.value ?? ""),
      enabled: r.enabled !== false,
    }));
    this.#render();
  }

  #syncStatus() {
    if (this.#statusEl)
      this.#statusEl.textContent = this.#usingDefaults
        ? t("settings.commands.usingDefaults")
        : "";
  }

  #render() {
    this.#syncStatus();
    this.#listEl.replaceChildren();
    if (this.#rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "params-empty";
      empty.textContent = t("settings.commands.empty");
      this.#listEl.appendChild(empty);
      return;
    }
    this.#rows.forEach((row) => {
      const el = document.createElement("div");
      el.className = "cmd-base-env-row";

      const on = document.createElement("input");
      on.type = "checkbox";
      on.checked = row.enabled !== false;
      on.setAttribute("aria-label", t("settings.commands.enableAria"));
      on.addEventListener("change", () => {
        this.#materialise();
        row.enabled = on.checked;
        this.#changed();
      });

      const key = document.createElement("input");
      key.type = "text";
      key.className = "settings-input cmd-base-env-key";
      key.value = row.key;
      key.spellcheck = false;
      key.placeholder = t("settings.commands.namePlaceholder");
      key.setAttribute("aria-label", t("settings.commands.nameAria"));
      wireTrimmedPaste(key);
      key.addEventListener("input", () => {
        this.#materialise();
        row.key = key.value;
        this.#changed();
      });

      const value = document.createElement("input");
      value.type = "text";
      value.className = "settings-input cmd-base-env-value";
      value.value = row.value;
      value.spellcheck = false;
      value.placeholder = t("settings.commands.valuePlaceholder");
      value.setAttribute("aria-label", t("settings.commands.valueAria"));
      wireTrimmedPaste(value);
      value.addEventListener("input", () => {
        this.#materialise();
        row.value = value.value;
        this.#changed();
      });

      const del = document.createElement("button");
      del.type = "button";
      del.className = "icon-btn cmd-base-env-delete";
      del.title = t("settings.commands.delete");
      del.setAttribute("aria-label", t("settings.commands.delete"));
      del.innerHTML = icon("close", { size: 11 });
      del.addEventListener("click", () => {
        this.#materialise();
        this.#rows = this.#rows.filter((r) => r !== row);
        this.#render();
        this.#changed();
      });

      el.append(on, key, value, del);
      this.#listEl.appendChild(el);
    });
  }
}
