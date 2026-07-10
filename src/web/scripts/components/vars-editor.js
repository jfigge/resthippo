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
 * vars-editor.js — Key/Value variable editor mounted in the center panel
 *
 * The in-window counterpart to VariablesPopup: the same flat key/value variable
 * editor, but rendered inline in the request panel (replacing the request editor)
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
 * FOLDER PROFILES (folders only): when `profilesEnabled`, the toolbar gains a
 * profile switcher on the far right — a selector (Default + named profiles), a
 * [+] add button, and a delete button. Only the [+] shows while just the Default
 * profile exists; the selector + delete appear once at least one named profile
 * is defined. The [+] opens a small anchored popup to name a new profile (Enter
 * adds, Escape / outside-click cancels). All the model logic (which values a
 * profile shows, how the Default owns the set) lives in app.js +
 * folder-profiles.js; this component only renders the controls and reports
 * intent. The variable rows always show the EFFECTIVE values for the active
 * profile (computed by the creator and passed to `load`), and every save carries
 * the active `profileId` so the creator can route it to the right profile.
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
 *   onProfileAdd({ name })                    — [+] popup committed a new profile name
 *   onProfileRename({ profileId, name })      — rename popup committed a new name
 *   onProfileSelect({ profileId })            — profile selector changed (null = Default)
 *   onProfileDelete({ profileId })            — delete pressed for the active named profile
 */

"use strict";

import { icon } from "../icons.js";
import { debounce } from "../utils/debounce.js";
import { normalizeVariables } from "./variable-shape.js";
import {
  variablesToText,
  textToVariables,
  variablesToRows,
  blankVariableRow,
  rowsToVariables,
  buildVariableRow,
} from "./variable-editor-shared.js";
import { escapeHtml } from "../utils/html.js";
import { t } from "../i18n.js";
import { MAX_NAMED_PROFILES } from "./folder-profiles.js";

export class VarsEditor {
  /** @type {HTMLElement} */ #el;
  /** @type {HTMLInputElement} */ #bulkToggleEl;
  /** @type {HTMLTextAreaElement} */ #textareaEl;
  /** @type {HTMLElement} */ #kvWrapEl;
  /** @type {HTMLElement} */ #kvListEl;
  /** @type {HTMLElement} */ #hintEl;
  /** @type {HTMLButtonElement} */ #addBtnEl;

  // ── Profile controls (folder scope only) ───────────────────────────────────
  /** @type {HTMLElement} */ #profileControlsEl;
  /** @type {HTMLSelectElement} */ #profileSelectEl;
  /** @type {HTMLButtonElement} */ #profileRenameBtnEl;
  /** @type {HTMLButtonElement} */ #profileAddBtnEl;
  /** @type {HTMLButtonElement} */ #profileDelBtnEl;
  #profilesEnabled = false;
  /** @type {{id:string,name:string}[]} */ #profiles = [];
  /** @type {string|null} */ #activeProfileId = null;
  /** @type {HTMLElement|null} */ #profilePopupEl = null;
  /** @type {(() => void)|null} */ #profilePopupCleanup = null;

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
  /** @type {(payload: { name: string }) => void} */
  #onProfileAdd;
  /** @type {(payload: { profileId: string, name: string }) => void} */
  #onProfileRename;
  /** @type {(payload: { profileId: string|null }) => void} */
  #onProfileSelect;
  /** @type {(payload: { profileId: string }) => void} */
  #onProfileDelete;

  /**
   * @param {{
   *   onSave?: (payload: { scopeId: string, profileId: string|null, variables: Array }) => void,
   *   onBulkEditorChange?: (payload: { bulkEditor: boolean }) => void,
   *   onProfileAdd?: (payload: { name: string }) => void,
   *   onProfileRename?: (payload: { profileId: string, name: string }) => void,
   *   onProfileSelect?: (payload: { profileId: string|null }) => void,
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
    this.#onProfileAdd = onProfileAdd;
    this.#onProfileRename = onProfileRename;
    this.#onProfileSelect = onProfileSelect;
    this.#onProfileDelete = onProfileDelete;
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
   * `variables` are the EFFECTIVE values for `activeProfileId` (the creator
   * merges the folder's Default + the profile's overrides before calling in).
   * `profilesEnabled` is true only for folders; `profiles` lists the collection's
   * named profiles (Default is implicit and always offered in the selector).
   *
   * @param {{
   *   scopeId: string, scopeName: string, variables: Array|object, bulkEditor?: boolean,
   *   profilesEnabled?: boolean, profiles?: {id:string,name:string}[], activeProfileId?: string|null,
   * }} opts
   */
  load({
    scopeId,
    scopeName,
    variables,
    bulkEditor = true,
    profilesEnabled = false,
    profiles = [],
    activeProfileId = null,
  }) {
    // Flush a pending save for whatever scope/profile was showing before.
    this.flush();
    this.#closeProfilePopup();

    this.#scopeId = scopeId;
    this.#profilesEnabled = profilesEnabled;
    this.#profiles = Array.isArray(profiles) ? profiles : [];
    this.#activeProfileId = activeProfileId ?? null;
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
      this.#rows = variablesToRows(vars);
      this.#applyMode();
      this.#renderRows();
    }

    this.#renderProfileControls();
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
        <div class="vars-profile-controls" style="display:none">
          <select class="vars-profile-select" aria-label="${t("profiles.selectAria")}"></select>
          <button class="icon-btn vars-profile-rename-btn" title="${t("profiles.rename")}" aria-label="${t("profiles.rename")}">${icon("rename", { size: 14 })}</button>
          <button class="icon-btn vars-profile-add-btn" title="${t("profiles.add")}" aria-label="${t("profiles.add")}">${icon("add", { size: 15 })}</button>
          <button class="icon-btn vars-profile-del-btn" title="${t("profiles.delete")}" aria-label="${t("profiles.delete")}">${icon("trash", { size: 13 })}</button>
        </div>
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
    this.#profileControlsEl = el.querySelector(".vars-profile-controls");
    this.#profileSelectEl = el.querySelector(".vars-profile-select");
    this.#profileRenameBtnEl = el.querySelector(".vars-profile-rename-btn");
    this.#profileAddBtnEl = el.querySelector(".vars-profile-add-btn");
    this.#profileDelBtnEl = el.querySelector(".vars-profile-del-btn");

    this.#bulkToggleEl.addEventListener("change", () =>
      this.#handleBulkToggle(),
    );
    this.#textareaEl.addEventListener("input", () => this.#debouncedSave());
    this.#addBtnEl.addEventListener("click", () => this.#addRow());

    this.#profileSelectEl.addEventListener("change", () => {
      // Persist any in-flight edit to the CURRENT profile before switching.
      this.flush();
      this.#onProfileSelect?.({
        profileId: this.#profileSelectEl.value || null,
      });
    });
    this.#profileAddBtnEl.addEventListener("click", () =>
      this.#toggleProfileNamePopup(),
    );
    this.#profileRenameBtnEl.addEventListener("click", () =>
      this.#toggleProfileRenamePopup(),
    );
    this.#profileDelBtnEl.addEventListener("click", () => {
      if (this.#activeProfileId) {
        this.#onProfileDelete?.({ profileId: this.#activeProfileId });
      }
    });

    return el;
  }

  // ── Profile controls ──────────────────────────────────────────────────────

  /**
   * Show/populate the profile switcher. The whole group is hidden for the
   * collection scope; the selector + rename + delete stay hidden until at least
   * one named profile exists (only the [+] shows for a lone Default). Rename and
   * delete are disabled while the Default profile is the active selection (the
   * Default profile can neither be renamed nor deleted).
   */
  #renderProfileControls() {
    if (!this.#profilesEnabled) {
      this.#profileControlsEl.style.display = "none";
      this.#closeProfilePopup();
      return;
    }
    this.#profileControlsEl.style.display = "";

    const hasNamed = this.#profiles.length > 0;
    this.#profileSelectEl.style.display = hasNamed ? "" : "none";
    this.#profileRenameBtnEl.style.display = hasNamed ? "" : "none";
    this.#profileDelBtnEl.style.display = hasNamed ? "" : "none";

    if (hasNamed) {
      const active = this.#activeProfileId ?? "";
      const opts = [
        `<option value="">${escapeHtml(t("profiles.default"))}</option>`,
      ];
      for (const p of this.#profiles) {
        const sel = p.id === active ? " selected" : "";
        opts.push(
          `<option value="${escapeHtml(p.id)}"${sel}>${escapeHtml(p.name)}</option>`,
        );
      }
      this.#profileSelectEl.innerHTML = opts.join("");
      this.#profileSelectEl.value = active;
      // Default (empty selection) is neither renamable nor deletable.
      this.#profileRenameBtnEl.disabled = !this.#activeProfileId;
      this.#profileDelBtnEl.disabled = !this.#activeProfileId;
    }

    // Cap creation at MAX_NAMED_PROFILES (⌥⌘1–9 map to the nine slots). At the
    // limit the [+] is disabled and its tooltip explains why.
    const atLimit = this.#profiles.length >= MAX_NAMED_PROFILES;
    this.#profileAddBtnEl.disabled = atLimit;
    this.#profileAddBtnEl.title = atLimit
      ? t("profiles.limit", { max: MAX_NAMED_PROFILES })
      : t("profiles.add");
  }

  /** Toggle the [+] popup that names a NEW profile (Enter adds, Esc/away cancels). */
  #toggleProfileNamePopup() {
    if (this.#profilePopupEl) {
      this.#closeProfilePopup();
      return;
    }
    this.#openProfileNamePopup({
      anchor: this.#profileAddBtnEl,
      ariaLabel: t("profiles.add"),
      onCommit: (name) => this.#onProfileAdd?.({ name }),
    });
  }

  /**
   * Toggle the RENAME popup for the active named profile — the same anchored box,
   * pre-filled with (and selecting) the current name. The Default profile (empty
   * selection) can't be renamed, so this is a no-op there.
   */
  #toggleProfileRenamePopup() {
    if (this.#profilePopupEl) {
      this.#closeProfilePopup();
      return;
    }
    const id = this.#activeProfileId;
    if (!id) return; // Default profile can't be renamed
    const current = this.#profiles.find((p) => p.id === id);
    this.#openProfileNamePopup({
      anchor: this.#profileRenameBtnEl,
      ariaLabel: t("profiles.rename"),
      initialValue: current?.name ?? "",
      onCommit: (name) => this.#onProfileRename?.({ profileId: id, name }),
    });
  }

  /**
   * Small anchored popup that captures a profile name (Enter commits with the
   * trimmed value, Esc / outside-click cancels). Shared by the add and rename
   * flows: `initialValue` pre-fills + selects the text, `onCommit(name)` receives
   * the trimmed non-empty result.
   *
   * @param {{ anchor: HTMLElement, ariaLabel: string, initialValue?: string,
   *   onCommit: (name: string) => void }} opts
   */
  #openProfileNamePopup({ anchor, ariaLabel, initialValue = "", onCommit }) {
    this.#closeProfilePopup();

    const pop = document.createElement("div");
    pop.className = "vars-profile-popup";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", ariaLabel);
    pop.innerHTML = `<input type="text" class="settings-input vars-profile-name-input"
      placeholder="${escapeHtml(t("profiles.namePlaceholder"))}"
      aria-label="${escapeHtml(t("profiles.nameAria"))}"
      autocomplete="off" autocapitalize="off" spellcheck="false">`;
    document.body.appendChild(pop);
    this.#profilePopupEl = pop;

    // Anchor below the trigger button, right-aligned to it, clamped to viewport.
    const r = anchor.getBoundingClientRect();
    pop.style.position = "fixed";
    pop.style.top = `${Math.round(r.bottom + 4)}px`;
    const width = pop.getBoundingClientRect().width || 200;
    const left = Math.min(
      Math.max(8, Math.round(r.right - width)),
      window.innerWidth - width - 8,
    );
    pop.style.left = `${left}px`;

    const input = pop.querySelector("input");
    input.value = initialValue;
    const commit = () => {
      const name = input.value.trim();
      this.#closeProfilePopup();
      if (name) onCommit?.(name);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.#closeProfilePopup();
      }
    });

    // Outside pointer-down cancels (the trigger's own toggle handles a click on
    // the anchor itself).
    const onDown = (e) => {
      if (!pop.contains(e.target) && !anchor.contains(e.target)) {
        this.#closeProfilePopup();
      }
    };
    // Defer so the click that opened the popup doesn't immediately close it.
    setTimeout(() => document.addEventListener("pointerdown", onDown, true), 0);
    this.#profilePopupCleanup = () =>
      document.removeEventListener("pointerdown", onDown, true);

    requestAnimationFrame(() => {
      input.focus();
      // Rename: select the whole current name with the caret at the right end.
      if (initialValue)
        input.setSelectionRange(0, input.value.length, "forward");
    });
  }

  #closeProfilePopup() {
    this.#profilePopupCleanup?.();
    this.#profilePopupCleanup = null;
    if (this.#profilePopupEl) {
      this.#profilePopupEl.remove();
      this.#profilePopupEl = null;
    }
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
    return this.#structureVars.map((s) => ({
      name: s.name,
      secure: s.secure,
      value: byName.has(s.name) ? byName.get(s.name) : "",
    }));
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
          // On a named profile only VALUES are editable — the name + secure +
          // delete are frozen to the Default's structure.
          lockStructure: !editable,
          // On a named profile a blank value falls through to the Default's value
          // at send time — hint that in the empty field (the placeholder only
          // shows while the field is empty, i.e. exactly when it falls through).
          valuePlaceholder: editable ? undefined : t("profiles.fallThrough"),
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
    this.#dispatchSave(textToVariables(this.#textareaEl.value));
  }

  #saveFromRows() {
    if (!this.#scopeId) return;
    this.#dispatchSave(rowsToVariables(this.#rows));
  }

  #dispatchSave(variables) {
    this.#onSave?.({
      scopeId: this.#scopeId,
      profileId: this.#activeProfileId,
      variables,
    });
  }
}
