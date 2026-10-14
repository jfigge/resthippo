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
 * vars-editor.js — Key/Value variable editor mounted in the center panel
 *
 * The in-window counterpart to the CollectionsPopup Environment tab: the same
 * flat key/value variable editor, but rendered inline in the request panel
 * (replacing the request editor)
 * while a container — a collection or folder — is the active tree selection,
 * rather than in a modal dialog. The popup chrome (header / footer / close /
 * PopupManager) is dropped; the editor body fills the panel.
 *
 * Behaviour mirrors the popup and reuses the same machinery in
 * variable-editor-shared.js:
 *   • "Bulk editor" toggle (remembered in settings):
 *       - ON  → textarea where each line is a  name=value  pair
 *       - OFF → key/value row list (same appearance as request params)
 *   • Auto-save (debounced) on every keystroke / row change.
 *
 * FOLDER PROFILES (folders only): when `profilesEnabled`, the toolbar gains the
 * profile switcher on the far right — {@link VarsProfileBar}, which owns the
 * grouped selector, the add/rename/delete controls and the name popup. Profiles
 * are SCOPED, so what it lists depends on the folder: the collection tier plus
 * every ancestor's profiles plus this folder's own. This editor keeps only
 * `#activeProfileId` — the profile whose overrides its rows are showing — and
 * forwards the bar's callbacks to its own creator. All the model logic lives in
 * components/profile-scope.js (visibility, layering) and folder-profiles.js
 * (values); the rows always show the EFFECTIVE values for that profile (computed
 * by the creator and passed to `load`), and every save carries its `profileId` so
 * the creator can route the edit to the right profile.
 *
 * Only the Default profile owns the variable SET. On a named profile the editor
 * locks structure: the KV table's name inputs are read-only, the per-row secure
 * + delete buttons are disabled, and the [+] add-variable button is hidden — only
 * VALUES can change. The bulk-text editor stays fully editable (type anything),
 * but its content is reconciled back to the Default's names on save / mode-toggle
 * (out-of-set names dropped, missing names restored blank).
 *
 * Constructor callbacks (this is a parent-owned panel that reports back to its
 * creator, so it uses callbacks rather than global hippo:* events — see the
 * "Component ↔ app communication" rule in CLAUDE.md):
 *   onSave({ scopeId, profileId, variables }) — debounced 500ms auto-save
 *   onBulkEditorChange({ bulkEditor })        — bulk-textarea / KV-row toggle changed
 *   onProfileAdd({ name, scope })             — [+] popup committed a name + scope
 *                                               ("folder" | "collection")
 *   onProfileRename({ profileId, name })      — rename popup committed a new name
 *   onProfileSelect({ ownerKey, profileId })  — selector changed; null profileId
 *                                               returns that owner to its Default
 *   onProfileDelete({ profileId })            — delete pressed for the selected profile
 */

"use strict";

import { icon } from "../icons.js";
import { debounce } from "../utils/debounce.js";
import { wireTrimmedPaste } from "../utils/trimmed-paste.js";
import { normalizeVariables } from "./variable-shape.js";
import {
  variablesToText,
  textToVariables,
  variablesToRows,
  blankVariableRow,
  rowsToVariables,
  buildVariableRow,
} from "./variable-editor-shared.js";
import { t } from "../i18n.js";
import { VarsProfileBar } from "./vars-profile-bar.js";

export class VarsEditor {
  /** @type {HTMLElement} */ #el;
  /** @type {HTMLInputElement} */ #bulkToggleEl;
  /** @type {HTMLTextAreaElement} */ #textareaEl;
  /** @type {HTMLElement} */ #kvWrapEl;
  /** @type {HTMLElement} */ #kvListEl;
  /** @type {HTMLElement} */ #hintEl;
  /** @type {HTMLButtonElement} */ #addBtnEl;

  // ── Profile controls (folder scope only) ───────────────────────────────────
  // The whole profile switcher lives in VarsProfileBar; this editor only knows
  // which profile's overrides its rows are showing.
  /** @type {VarsProfileBar} */ #profileBar;
  /** @type {string|null} */ #activeProfileId = null;

  // Only the Default profile (blank name → null id) owns the variable SET. On a
  // named profile the names + secure flags are frozen to the Default's structure
  // (captured below at load time) and only VALUES are editable.
  #canEditStructure = true;
  /** @type {{name:string,secure:boolean}[]} */ #structureVars = [];

  /** @type {string|null} */ #scopeId = null;

  /** true = textarea (bulk); false = KV rows */
  #isBulkMode = true;

  /** @type {{ id:string, name:string, value:string, secure:boolean }[]} */
  #rows = [];

  // Debounced save for BOTH modes (per-keystroke typing). A folder save walks +
  // deep-clones the whole tree, persists to disk, and rebuilds the request-editor
  // variable context, so running it on every keystroke lags badly on a large
  // collection — coalesce to one save per idle window (flush() forces it on
  // switch/blur). Structural edits (add / delete a row, mode toggle) still save
  // immediately since they're one-shot, not per-keystroke.
  #debouncedSave = debounce(() => {
    if (this.#isBulkMode) this.#saveFromBulk();
    else this.#saveFromRows();
  }, VarsEditor.#SAVE_MS);

  /** Whether the "Remove headers" setting is active. */
  #removeHeaders = false;

  static #SAVE_MS = 500;

  /** Auto re-mask a revealed secure value after this many ms. */
  static #REVEAL_MS = 30000;

  /** @type {(payload: { scopeId: string, profileId: string|null, variables: Array }) => void} */
  #onSave;
  /** @type {(payload: { bulkEditor: boolean }) => void} */
  #onBulkEditorChange;
  /**
   * @param {{
   *   onSave?: (payload: { scopeId: string, profileId: string|null, variables: Array }) => void,
   *   onBulkEditorChange?: (payload: { bulkEditor: boolean }) => void,
   *   onProfileAdd?: (payload: { name: string, scope: string }) => void,
   *   onProfileRename?: (payload: { profileId: string, name: string }) => void,
   *   onProfileSelect?: (payload: { ownerKey: string|null, profileId: string|null }) => void,
   *   onProfileDelete?: (payload: { profileId: string }) => void,
   * }} [opts]
   */
  constructor({
    onSave,
    onBulkEditorChange,
    onProfileAdd,
    onProfileRename,
    onProfileSelect,
    onProfileDelete,
  } = {}) {
    this.#onSave = onSave;
    this.#onBulkEditorChange = onBulkEditorChange;
    // The profile bar is a parent-owned widget: it computes a change and hands it
    // straight back to whoever created this editor.
    this.#profileBar = new VarsProfileBar({
      onAdd: onProfileAdd,
      onRename: onProfileRename,
      onDelete: onProfileDelete,
      onSelect: onProfileSelect,
      // Persist any in-flight edit to the CURRENT profile before switching.
      onBeforeSelect: () => this.flush(),
    });
    this.#el = this.#build();
  }

  get element() {
    return this.#el;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Receive global settings. Currently responds to `removeHeaders`.
   * Safe to call at any time — applies immediately.
   * @param {{ removeHeaders?: boolean }} settings
   */
  applySettings(settings) {
    if (settings.removeHeaders !== undefined) {
      this.#removeHeaders = settings.removeHeaders;
      this.#applyRemoveHeaders();
    }
  }

  /**
   * Render the editor for a scope. Replaces the previous scope's contents; any
   * pending debounced save for the previous scope is flushed first.
   *
   * `variables` are the EFFECTIVE values for `editingProfileId` (the creator
   * merges the folder's Default + that profile's overrides before calling in).
   * `profilesEnabled` is true only for folders; `profileGroups` are the profiles
   * visible at this folder, grouped by their owner (Default is implicit and
   * always offered in the selector) — see components/profile-scope.js.
   *
   * @param {{
   *   scopeId: string, scopeName: string, variables: Array|object, bulkEditor?: boolean,
   *   profilesEnabled?: boolean, profileGroups?: object[],
   *   editingProfileId?: string|null, ownerKey?: string|null,
   * }} opts
   */
  load({
    scopeId,
    scopeName,
    variables,
    bulkEditor = true,
    profilesEnabled = false,
    profileGroups = [],
    editingProfileId = null,
    ownerKey = null,
  }) {
    // Flush a pending save for whatever scope/profile was showing before.
    this.flush();

    this.#scopeId = scopeId;
    this.#activeProfileId = editingProfileId ?? null;
    this.#profileBar.load({
      enabled: profilesEnabled,
      groups: profileGroups,
      editingProfileId: this.#activeProfileId,
      ownerKey: ownerKey ?? scopeId,
    });
    // The set is editable only on the Default profile (null id). Names + secure
    // flags in the effective vars are always the Default's — capture them so the
    // KV table can stay locked to that structure on a named profile.
    this.#canEditStructure = !this.#activeProfileId;
    this.#el.setAttribute(
      "aria-label",
      t("variables.titleScope", { scope: scopeName }),
    );

    const vars = normalizeVariables(variables);
    this.#structureVars = vars.map((v) => ({ name: v.name, secure: v.secure }));

    this.#isBulkMode = bulkEditor;
    this.#bulkToggleEl.checked = this.#isBulkMode;

    if (this.#isBulkMode) {
      this.#textareaEl.value = variablesToText(vars);
      this.#applyMode();
    } else {
      // Build rows from the raw effective vars (not the normalized copy) so a
      // named profile's per-variable `overridden` flag reaches the row.
      this.#rows = variablesToRows(Array.isArray(variables) ? variables : vars);
      this.#applyMode();
      this.#renderRows();
    }

    this.#applyRemoveHeaders();
  }

  /** Force any pending debounced save to run now (e.g. when switching away). */
  flush() {
    if (!this.#debouncedSave.pending()) return;
    this.#debouncedSave.cancel();
    if (this.#isBulkMode) this.#saveFromBulk();
    else this.#saveFromRows();
  }

  // ── Build ───────────────────────────────────────────────────────────────────

  /**
   * Apply (or clear) the "Remove headers" style to the KV-mode column-label
   * row ("Name" / "Value"). Idempotent — safe to call any number of times.
   */
  #applyRemoveHeaders() {
    const display = this.#removeHeaders ? "none" : "";
    const kvHeader = this.#el.querySelector(".vars-kv-header");
    if (kvHeader) kvHeader.style.display = display;
  }

  #build() {
    const el = document.createElement("div");
    el.className = "vars-editor";
    el.setAttribute("role", "region");
    el.setAttribute("aria-label", t("common.variables"));

    el.innerHTML = `
      <div class="vars-toolbar">
        <label class="params-toolbar-toggle-label vars-bulk-label"
               title="${t("kv.bulkEditorTitle")}">
          <input type="checkbox" class="params-toolbar-toggle vars-bulk-toggle" checked>
          ${t("kv.bulkEditor")}
        </label>
        <button class="icon-btn params-toolbar-btn vars-add-btn" title="${t("vars.add")}" aria-label="${t("vars.add")}" style="display:none"><span class="icon">${icon("add", { size: 15 })}</span></button>
        <span class="vars-hint">${t("kv.varsHint")}</span>
      </div>
      <textarea
        class="body-text-editor vars-textarea"
        spellcheck="false"
        autocomplete="off"
        placeholder="${t("vars.bulkPlaceholder")}"
        aria-label="${t("vars.editorAria")}"
      ></textarea>
      <div class="vars-kv-wrap" style="display:none">
        <div class="vars-kv-header params-header-row">
          <span>${t("kv.name")}</span><span class="params-col-value">${t("kv.value")}</span><span></span><span></span>
        </div>
        <div class="vars-kv-list params-list" aria-label="${t("common.variables")}"></div>
      </div>
    `;

    this.#bulkToggleEl = el.querySelector(".vars-bulk-toggle");
    this.#textareaEl = el.querySelector(".vars-textarea");
    this.#kvWrapEl = el.querySelector(".vars-kv-wrap");
    this.#kvListEl = el.querySelector(".vars-kv-list");
    this.#hintEl = el.querySelector(".vars-hint");
    this.#addBtnEl = el.querySelector(".vars-add-btn");
    el.querySelector(".vars-toolbar").appendChild(this.#profileBar.element);

    this.#bulkToggleEl.addEventListener("change", () =>
      this.#handleBulkToggle(),
    );
    this.#textareaEl.addEventListener("input", () => this.#debouncedSave());
    wireTrimmedPaste(this.#textareaEl);
    this.#addBtnEl.addEventListener("click", () => this.#addRow());

    return el;
  }

  // ── Mode switching ──────────────────────────────────────────────────────────

  #applyMode() {
    const bulk = this.#isBulkMode;
    this.#textareaEl.style.display = bulk ? "" : "none";
    this.#kvWrapEl.style.display = bulk ? "none" : "";
    if (this.#hintEl) this.#hintEl.style.display = bulk ? "" : "none";
    // Add-variable only in KV mode, and only where the set is editable (Default).
    if (this.#addBtnEl)
      this.#addBtnEl.style.display =
        bulk || !this.#canEditStructure ? "none" : "";
  }

  /**
   * Map parsed vars onto the locked Default structure (names + secure flags),
   * taking each name's value from `vars` (blank when absent) and dropping any
   * name not in the structure — the KV-table counterpart of applyProfileEdit's
   * named-profile reconciliation. Only meaningful when `#canEditStructure` false.
   */
  #reconcileToStructure(vars) {
    const byName = new Map(vars.map((v) => [v.name, v.value]));
    return this.#structureVars.map((s) => {
      const value = byName.has(s.name) ? byName.get(s.name) : "";
      // The bulk editor can't express an empty override, so a non-blank value is
      // an override and a blank inherits the Default (presence heuristic).
      return {
        name: s.name,
        secure: s.secure,
        value,
        overridden: value !== "",
      };
    });
  }

  #handleBulkToggle() {
    const nowBulk = this.#bulkToggleEl.checked;

    if (nowBulk && !this.#isBulkMode) {
      // Table → Bulk: serialise rows to text
      this.#textareaEl.value = variablesToText(rowsToVariables(this.#rows));
    } else if (!nowBulk && this.#isBulkMode) {
      // Bulk → Table: parse text to rows. On a named profile the set is frozen
      // to the Default structure, so reconcile the typed values against it
      // (out-of-set names dropped, missing names restored blank).
      let vars = textToVariables(this.#textareaEl.value);
      if (!this.#canEditStructure) vars = this.#reconcileToStructure(vars);
      this.#rows = variablesToRows(vars);
    }

    this.#isBulkMode = nowBulk;
    this.#applyMode();

    if (nowBulk) {
      requestAnimationFrame(() => this.#textareaEl.focus());
    } else {
      this.#renderRows();
      this.#saveFromRows();
    }

    this.#onBulkEditorChange?.({ bulkEditor: nowBulk });
  }

  // ── KV row rendering ────────────────────────────────────────────────────────

  #renderRows() {
    this.#kvListEl.innerHTML = "";
    if (this.#rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "params-empty";
      empty.textContent = t("collections.variablesEmpty");
      this.#kvListEl.appendChild(empty);
      return;
    }
    const editable = this.#canEditStructure;
    this.#rows.forEach((row) =>
      this.#kvListEl.appendChild(
        buildVariableRow({
          row,
          rowClass: "vars-kv-row params-row",
          revealMs: VarsEditor.#REVEAL_MS,
          // On a named profile only VALUES are editable — the name + secure are
          // frozen to the Default's structure, and the delete slot becomes the
          // "reset to inherit" control (buildVariableRow, driven by lockStructure).
          lockStructure: !editable,
          // Debounced: fires per keystroke as the user edits a name/value.
          onChange: () => this.#debouncedSave(),
          onEnter: editable ? () => this.#addRow() : undefined,
          onDelete: editable
            ? () => {
                this.#rows = this.#rows.filter((r) => r.id !== row.id);
                this.#renderRows();
                this.#saveFromRows();
              }
            : undefined,
          // Named profile: dropping an override (reset to inherit) mutates the row
          // in place; persist the new presence state.
          onResetInherit: editable ? undefined : () => this.#saveFromRows(),
        }),
      ),
    );
  }

  #addRow() {
    if (!this.#canEditStructure) return; // only the Default profile owns the set
    const row = blankVariableRow();
    this.#rows.push(row);
    this.#renderRows();
    const rows = this.#kvListEl.querySelectorAll(".vars-kv-row");
    if (rows.length)
      rows[rows.length - 1].querySelector(".params-name")?.focus();
  }

  // ── Save ────────────────────────────────────────────────────────────────────

  #saveFromBulk() {
    if (!this.#scopeId) return;
    // Bulk text can't express an empty override, so leave `overrides` unset and
    // let applyProfileEdit fall back to "non-blank value = override".
    this.#dispatchSave(textToVariables(this.#textareaEl.value));
  }

  #saveFromRows() {
    if (!this.#scopeId) return;
    // On a named profile the KV table knows exactly which rows are explicit
    // overrides (presence) — pass their names so an empty override is preserved.
    const overrides = this.#canEditStructure
      ? undefined
      : this.#rows.filter((r) => r.overridden).map((r) => r.name);
    this.#dispatchSave(rowsToVariables(this.#rows), overrides);
  }

  #dispatchSave(variables, overrides) {
    this.#onSave?.({
      scopeId: this.#scopeId,
      profileId: this.#activeProfileId,
      variables,
      overrides,
    });
  }
}
