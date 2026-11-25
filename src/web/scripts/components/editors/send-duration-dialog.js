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
 * editors/send-duration-dialog.js — the small "Name [ n ] s" timing dialog
 * anchored under the Send/Execute button.
 *
 * Extracted from RequestEditor (#openDurationDialog / #buildDurationRow) so the
 * scheduled-send Delay/Interval and the Command request Timeout (Feature 70)
 * share one implementation. Values persist live (on `change`) and the dialog
 * dismisses on outside click via PopupManager's mask.
 */

"use strict";

import { PopupManager } from "../../popup-manager.js";
import { t } from "../../i18n.js";

/**
 * One labelled "Name [ n ] s" duration input row.
 * @param {string} labelText
 * @param {string} ariaText
 * @param {number} valueMs
 * @param {(ms: number) => void} onCommit
 * @returns {HTMLElement}
 */
export function buildDurationRow(labelText, ariaText, valueMs, onCommit) {
  const row = document.createElement("div");
  row.className = "req-send-type-duration-row";

  const label = document.createElement("span");
  label.className = "req-send-type-duration-label";
  label.textContent = labelText;

  const input = document.createElement("input");
  input.type = "number";
  input.min = "0";
  input.step = "0.5";
  input.className = "req-send-type-duration-input";
  input.value = String(valueMs / 1000);
  input.setAttribute("aria-label", ariaText);

  const unit = document.createElement("span");
  unit.className = "req-send-type-duration-unit";
  unit.textContent = t("request.sendType.seconds");

  const commit = () => {
    const secs = Math.max(0, Number(input.value) || 0);
    const ms = Math.round(secs * 1000);
    input.value = String(ms / 1000);
    onCommit(ms);
  };
  input.addEventListener("change", commit);

  row.append(label, input, unit);
  return row;
}

/**
 * Open a one-field duration dialog under `anchor`.
 * @param {object} o
 * @param {HTMLElement} o.anchor
 * @param {string} o.dialogAria     the dialog's accessible name
 * @param {string} o.label          the row label
 * @param {string} o.inputAria      the input's accessible name
 * @param {number} o.valueMs
 * @param {(ms: number) => void} o.onCommit
 * @param {string} [o.hint]         optional muted line under the row
 */
export function openDurationDialog({
  anchor,
  dialogAria,
  label,
  inputAria,
  valueMs,
  onCommit,
  hint,
}) {
  const dialog = document.createElement("div");
  dialog.className = "req-send-duration-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-label", dialogAria);
  dialog.addEventListener("mousedown", (e) => {
    // Keep clicks inside the dialog (other than the number inputs) from blurring.
    if (e.target.tagName !== "INPUT") e.preventDefault();
  });
  dialog.appendChild(buildDurationRow(label, inputAria, valueMs, onCommit));
  if (hint) {
    const h = document.createElement("div");
    h.className = "req-send-duration-hint";
    h.textContent = hint;
    dialog.appendChild(h);
  }
  const r = anchor.getBoundingClientRect();
  PopupManager.openMenu(dialog, r.left, r.bottom + 4);
  // Focus the field for immediate keyboard entry.
  requestAnimationFrame(() => dialog.querySelector("input")?.focus());
  return dialog;
}
