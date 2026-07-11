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

/**
 * variable-editor-shared.js — shared machinery for the secure-variable editors.
 *
 * The variable editors — CollectionsPopup (its Environment tab) and the inline
 * VarsEditor — both edit the same kind of list:
 * `{ name, value, secure }` rows with an inline reveal (eye) toggle and a per-row
 * secure (lock) toggle, plus a bulk-text mode where each line is `name=value` and
 * a leading `$ ` marks the variable secure. This module holds the pieces they
 * share — extracted so the row builder and the bulk <→> rows converters live in
 * one place instead of byte-identical copies.
 *
 * This is the secure-variable counterpart to kv-editor-shared.js, which serves
 * the params/headers/body-form `{ name, value, enabled }` rows (a different
 * shape: enabled checkbox + drag-reorder, no secure masking).
 *
 * Everything here is concern-agnostic: callers pass all state in as arguments
 * and wire persistence/re-render through the callbacks.
 */

"use strict";

import { icon } from "../icons.js";
import { wireDeleteConfirm } from "../delete-confirm.js";
import { t } from "../i18n.js";

/**
 * Serialise a canonical variables array to multi-line `name=value` text.
 * Secure variables are prefixed with `$ ` (dollar + space) so the bulk editor
 * round-trips the secure flag.
 * @param {{name:string,value:string,secure:boolean}[]} vars
 * @returns {string}
 */
export function variablesToText(vars) {
  return vars
    .map((v) => `${v.secure ? "$ " : ""}${v.name}=${v.value}`)
    .join("\n");
}

/**
 * Parse multi-line `name=value` bulk text into a canonical variables array.
 * A leading `$ ` (dollar + space) marks the variable secure. Lines without an
 * `=` are silently ignored.
 * @param {string} text
 * @returns {{name:string,value:string,secure:boolean}[]}
 */
export function textToVariables(text) {
  const out = [];
  for (const line of text.split("\n")) {
    let trimmed = line.trim();
    if (!trimmed) continue;
    let secure = false;
    if (trimmed.startsWith("$ ")) {
      secure = true;
      trimmed = trimmed.slice(1).trim();
    }
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1);
    if (key) out.push({ name: key, value: val, secure });
  }
  return out;
}

/**
 * Convert a canonical variables array to an editor rows array (adds row ids).
 * A per-variable `overridden` flag (folder-variable profiles) is carried through
 * onto the row when present, so a named-profile row remembers whether its value
 * is an explicit override or an inherited blank.
 */
export function variablesToRows(vars) {
  return (Array.isArray(vars) ? vars : []).map((v) => ({
    id: crypto.randomUUID(),
    name: v.name,
    value: v.value,
    secure: !!v.secure,
    ...(v.overridden !== undefined ? { overridden: !!v.overridden } : {}),
  }));
}

/** Build one blank editor row (fresh id, empty name/value, not secure). */
export function blankVariableRow() {
  return { id: crypto.randomUUID(), name: "", value: "", secure: false };
}

/**
 * Serialise editor rows back to a canonical variables array, dropping rows whose
 * name is blank (whitespace-only).
 * @param {{name:string,value:string,secure:boolean}[]} rows
 * @returns {{name:string,value:string,secure:boolean}[]}
 */
export function rowsToVariables(rows) {
  const out = [];
  for (const r of rows) {
    if (r.name.trim()) {
      out.push({ name: r.name, value: r.value, secure: !!r.secure });
    }
  }
  return out;
}

/**
 * Build one secure-variable editor row (name input, value input with reveal
 * toggle, secure lock toggle, delete button). The `row` object is mutated in
 * place as the user edits; callbacks drive persistence and list lifecycle:
 *
 *   onChange() — after a name/value edit or a secure-toggle flip (debounced save)
 *   onEnter()  — Enter pressed in the name or value input (append a new row)
 *   onDelete() — a confirmed delete (remove this row, re-render, save)
 *
 * When `lockStructure` is true the row's SET is frozen: the name is read-only and
 * the per-row secure (lock) toggle is shown but disabled. This is the named
 * folder-variable profile case, where only the Default profile owns the set. On
 * such a row the VALUE inherits the Default unless it is an explicit override
 * (`row.overridden`): an inheriting row shows an "inherits default" placeholder,
 * and typing a value makes it an override; the delete slot becomes a
 * "reset to inherit" control (enabled only while overriding) that drops the
 * override again via `onResetInherit`.
 *
 * @param {object} opts
 * @param {{id:string,name:string,value:string,secure:boolean,overridden?:boolean}} opts.row
 * @param {string}  opts.rowClass        — row element class (e.g. "vars-kv-row params-row")
 * @param {number} [opts.revealMs=30000] — auto re-mask delay after reveal
 * @param {boolean} [opts.lockStructure=false] — named profile: freeze name/secure, values inherit-or-override
 * @param {string} [opts.valuePlaceholder] — placeholder for the value input (non-inheriting rows); defaults to the generic value placeholder
 * @param {() => void} [opts.onChange]
 * @param {() => void} [opts.onEnter]
 * @param {() => void} [opts.onDelete]
 * @param {() => void} [opts.onResetInherit] — named profile: drop this override (back to inheriting the Default)
 * @returns {HTMLElement}
 */
export function buildVariableRow({
  row,
  rowClass,
  revealMs = 30000,
  lockStructure = false,
  valuePlaceholder,
  onChange,
  onEnter,
  onDelete,
  onResetInherit,
}) {
  const el = document.createElement("div");
  el.className = rowClass;
  if (lockStructure) el.classList.add("vars-kv-row--locked");
  el.dataset.id = row.id;

  const nameIn = document.createElement("input");
  nameIn.type = "text";
  nameIn.className = "params-input params-name";
  nameIn.placeholder = t("kv.name");
  nameIn.value = row.name;
  nameIn.setAttribute("aria-label", t("vars.name"));
  nameIn.setAttribute("autocomplete", "off");
  nameIn.readOnly = lockStructure;
  nameIn.addEventListener("input", () => {
    row.name = nameIn.value;
    onChange?.();
  });
  nameIn.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onEnter?.();
    }
  });

  const valWrap = document.createElement("div");
  valWrap.className = "params-value-wrap";

  // On a named profile (lockStructure) a value INHERITS the Default unless it is
  // an explicit override. `resetBtn`/`syncInherit` (defined with the delete slot
  // below) keep the placeholder, row state and reset control in step.
  const inheritable = lockStructure;
  let resetBtn = null;
  const syncInherit = () => {
    const inheriting = inheritable && !row.overridden;
    // Inheriting → hint that it falls back to the Default; else the generic (or
    // caller-supplied) placeholder. The placeholder only shows while empty.
    valIn.placeholder = inheriting
      ? t("profiles.inheritsDefault")
      : (valuePlaceholder ?? t("kv.value"));
    el.classList.toggle("vars-kv-row--inherited", inheriting);
    if (resetBtn) resetBtn.disabled = !row.overridden;
  };

  const valIn = document.createElement("input");
  valIn.type = "text";
  valIn.className = "params-input params-value";
  valIn.placeholder = valuePlaceholder ?? t("kv.value");
  valIn.value = row.value;
  valIn.setAttribute("aria-label", t("vars.value"));
  valIn.addEventListener("input", () => {
    row.value = valIn.value;
    // First edit on an inheriting row turns it into an explicit override (it stays
    // one even if cleared to empty — "reset to inherit" is the way back).
    if (inheritable && !row.overridden) {
      row.overridden = true;
      syncInherit();
    }
    onChange?.();
  });
  valIn.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onEnter?.();
    }
  });

  // Inline reveal (eye) toggle — only shown for secure rows.
  const reveal = document.createElement("button");
  reveal.type = "button";
  reveal.className = "icon-btn params-reveal-btn";
  reveal.setAttribute("tabindex", "-1");

  let revealed = false;
  let revealTimer = null;
  const applyMask = () => {
    const masked = !!row.secure && !revealed;
    valIn.classList.toggle("params-value--masked", masked);
    reveal.style.display = row.secure ? "" : "none";
    reveal.innerHTML = icon(revealed ? "eyeOff" : "eye", { size: 14 });
    const action = revealed ? t("common.hideValue") : t("common.revealValue");
    reveal.title = action;
    reveal.setAttribute("aria-label", action);
    reveal.setAttribute("aria-pressed", String(revealed));
  };
  reveal.addEventListener("click", () => {
    revealed = !revealed;
    clearTimeout(revealTimer);
    if (revealed) {
      revealTimer = setTimeout(() => {
        revealed = false;
        applyMask();
      }, revealMs);
    }
    applyMask();
  });

  valWrap.appendChild(valIn);
  valWrap.appendChild(reveal);

  // Per-row secure (lock) toggle — encrypts the value at rest.
  const secure = document.createElement("button");
  secure.type = "button";
  secure.className = "icon-btn params-secure-btn";
  const applySecure = () => {
    secure.classList.toggle("params-secure-btn--active", !!row.secure);
    secure.innerHTML = icon(row.secure ? "lock" : "lockOpen", { size: 14 });
    const label = row.secure
      ? t("variables.secureTooltip")
      : t("variables.markSecure");
    secure.title = label;
    secure.setAttribute("aria-label", label);
    secure.setAttribute("aria-pressed", String(!!row.secure));
  };
  // On a locked row (a non-Default profile) the secure + delete controls are
  // shown but disabled (only the Default profile owns the variable SET); the
  // value input + reveal toggle stay editable.
  secure.disabled = lockStructure;
  if (!lockStructure) {
    secure.addEventListener("click", () => {
      row.secure = !row.secure;
      if (!row.secure) {
        revealed = false;
        clearTimeout(revealTimer);
      }
      applySecure();
      applyMask();
      onChange?.();
    });
  }

  const del = document.createElement("button");
  del.type = "button";
  if (lockStructure) {
    // Named profile: the delete slot RESETS the value to inherit the Default
    // (drops the override) — the set is owned by the Default, so there's nothing
    // to delete. Enabled only while this row is an explicit override.
    del.className = "icon-btn params-inherit-btn";
    del.innerHTML = icon("revert", { size: 14 });
    del.title = t("profiles.resetToInherit");
    del.setAttribute("aria-label", t("profiles.resetToInherit"));
    del.addEventListener("click", () => {
      if (!row.overridden) return;
      row.overridden = false;
      row.value = "";
      valIn.value = "";
      syncInherit();
      onResetInherit?.();
    });
    resetBtn = del;
  } else {
    del.className = "icon-btn params-delete-btn";
    del.title = t("vars.delete");
    del.setAttribute("aria-label", t("vars.delete"));
    wireDeleteConfirm(del, () => onDelete?.());
  }

  el.appendChild(nameIn);
  el.appendChild(valWrap);
  el.appendChild(secure);
  el.appendChild(del);

  applySecure();
  applyMask();
  syncInherit();
  return el;
}
