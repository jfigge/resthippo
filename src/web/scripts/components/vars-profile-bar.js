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
 * vars-profile-bar.js — the profile switcher on the folder variable editor's
 * toolbar. Extracted from VarsEditor, which owns the variable rows; this owns
 * everything about PROFILES there.
 *
 * Profiles are scoped, so the selector is grouped rather than flat: `Default`,
 * then one `<optgroup>` per owner visible at this folder — the collection tier
 * first, then each ancestor folder, then this folder — labelled with the owner's
 * name. The selected entry is the profile whose overrides the rows below are
 * editing (the innermost active one), so "what is selected" and "what I am
 * editing" are always the same thing.
 *
 * Management stays at the definition site: `✎` and `🗑` are enabled only for a
 * profile this folder owns, or a collection-tier one (which has no folder to
 * navigate to and so must stay editable everywhere). For an ancestor's profile
 * they are disabled with a title naming the owning folder — that is what makes
 * the scoping legible rather than mysterious.
 *
 * `＋` opens a small anchored popup asking for a name and a SCOPE: *This folder*
 * (the default — the new profile is visible here and below) or *Whole collection*
 * (visible everywhere). Each scope caps at MAX_NAMED_PROFILES independently; a
 * scope at its cap is disabled in the popup, and `＋` itself only when both are.
 *
 * Communication is by constructor callback: this is a widget its parent
 * (VarsEditor) creates and reads back from, so no global events.
 *
 *   onSelect({ ownerKey, profileId })  — a different entry was chosen
 *   onAdd({ name, scope })             — the [+] popup committed
 *   onRename({ profileId, name })      — the rename popup committed
 *   onDelete({ profileId })            — delete pressed for the selected profile
 *   onBeforeSelect()                   — flush any in-flight edit first
 */

import { icon } from "../icons.js";
import { escapeHtml } from "../utils/html.js";
import { t } from "../i18n.js";
import { MAX_NAMED_PROFILES } from "./folder-profiles.js";
import {
  PROFILE_SCOPE_FOLDER,
  PROFILE_SCOPE_COLLECTION,
} from "./profile-controller.js";

export class VarsProfileBar {
  /** @type {HTMLElement} */ #el;
  /** @type {HTMLSelectElement} */ #selectEl;
  /** @type {HTMLButtonElement} */ #renameBtnEl;
  /** @type {HTMLButtonElement} */ #addBtnEl;
  /** @type {HTMLButtonElement} */ #delBtnEl;

  #enabled = false;
  /** @type {object[]} Owner groups visible here, outermost → innermost. */
  #groups = [];
  /** @type {string|null} The profile whose overrides the rows are editing. */
  #editingProfileId = null;
  /** @type {string|null} The folder this editor is showing (its ownerKey). */
  #ownerKey = null;

  /** @type {HTMLElement|null} */ #popupEl = null;
  /** @type {(() => void)|null} */ #popupCleanup = null;

  #onSelect;
  #onAdd;
  #onRename;
  #onDelete;
  #onBeforeSelect;

  constructor({ onSelect, onAdd, onRename, onDelete, onBeforeSelect } = {}) {
    this.#onSelect = onSelect;
    this.#onAdd = onAdd;
    this.#onRename = onRename;
    this.#onDelete = onDelete;
    this.#onBeforeSelect = onBeforeSelect;
    this.#el = this.#build();
  }

  /** The `.vars-profile-controls` element, for the host to place in its toolbar. */
  get element() {
    return this.#el;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * @param {{enabled?: boolean, groups?: object[], editingProfileId?: string|null,
   *          ownerKey?: string|null}} state
   */
  load({
    enabled = false,
    groups = [],
    editingProfileId = null,
    ownerKey = null,
  } = {}) {
    this.close();
    this.#enabled = !!enabled;
    this.#groups = Array.isArray(groups) ? groups : [];
    this.#editingProfileId = editingProfileId ?? null;
    this.#ownerKey = ownerKey ?? null;
    this.#render();
  }

  /** Close the name popup, if open. Safe to call at any time. */
  close() {
    this.#popupCleanup?.();
    this.#popupCleanup = null;
    if (this.#popupEl) {
      this.#popupEl.remove();
      this.#popupEl = null;
    }
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  #build() {
    const el = document.createElement("div");
    el.className = "vars-profile-controls";
    el.style.display = "none";
    el.innerHTML = `
      <select class="vars-profile-select" aria-label="${escapeHtml(t("profiles.selectAria"))}"></select>
      <button class="icon-btn vars-profile-rename-btn" title="${escapeHtml(t("profiles.rename"))}" aria-label="${escapeHtml(t("profiles.rename"))}">${icon("rename", { size: 14 })}</button>
      <button class="icon-btn vars-profile-add-btn" title="${escapeHtml(t("profiles.add"))}" aria-label="${escapeHtml(t("profiles.add"))}">${icon("add", { size: 15 })}</button>
      <button class="icon-btn vars-profile-del-btn" title="${escapeHtml(t("profiles.delete"))}" aria-label="${escapeHtml(t("profiles.delete"))}">${icon("trash", { size: 13 })}</button>
    `;
    this.#selectEl = el.querySelector(".vars-profile-select");
    this.#renameBtnEl = el.querySelector(".vars-profile-rename-btn");
    this.#addBtnEl = el.querySelector(".vars-profile-add-btn");
    this.#delBtnEl = el.querySelector(".vars-profile-del-btn");

    this.#selectEl.addEventListener("change", () => {
      // Persist any in-flight edit to the CURRENT profile before switching.
      this.#onBeforeSelect?.();
      const profileId = this.#selectEl.value || null;
      // Selecting a profile also makes it active for ITS owner, so what you edit
      // and what resolves stay the same thing. Plain Default clears the owner of
      // whatever was being edited.
      const ownerKey = profileId
        ? this.#ownerOf(profileId)?.ownerKey
        : this.#ownerOf(this.#editingProfileId)?.ownerKey;
      this.#onSelect?.({ ownerKey: ownerKey ?? null, profileId });
    });
    this.#addBtnEl.addEventListener("click", () => this.#toggleAddPopup());
    this.#renameBtnEl.addEventListener("click", () =>
      this.#toggleRenamePopup(),
    );
    this.#delBtnEl.addEventListener("click", () => {
      if (this.#editingProfileId && this.#canManage(this.#editingProfileId)) {
        this.#onDelete?.({ profileId: this.#editingProfileId });
      }
    });
    return el;
  }

  // ── Model helpers ──────────────────────────────────────────────────────────

  /** The group owning `profileId`, or null. */
  #ownerOf(profileId) {
    if (!profileId) return null;
    return (
      this.#groups.find((g) =>
        (g.profiles ?? []).some((p) => p.id === profileId),
      ) ?? null
    );
  }

  /** A profile is manageable here if this folder owns it, or it is collection-wide. */
  #canManage(profileId) {
    const owner = this.#ownerOf(profileId);
    if (!owner) return false;
    return owner.tier === "collection" || owner.ownerKey === this.#ownerKey;
  }

  /** Display label for a group heading (the collection may be unnamed). */
  #groupLabel(g) {
    return g.ownerName || t("profiles.groupCollection");
  }

  /** How many profiles each creation scope already holds (the cap is per owner). */
  #scopeCounts() {
    const find = (pred) => this.#groups.find(pred)?.profiles?.length ?? 0;
    return {
      collection: find((g) => g.tier === "collection"),
      folder: find((g) => g.ownerKey === this.#ownerKey),
    };
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  #render() {
    if (!this.#enabled) {
      this.#el.style.display = "none";
      return;
    }
    this.#el.style.display = "";

    const hasAny = this.#groups.some((g) => (g.profiles ?? []).length > 0);
    // With no profiles in scope the Default is the only thing there is — only the
    // [+] shows, exactly as before scoping.
    this.#selectEl.style.display = hasAny ? "" : "none";
    this.#renameBtnEl.style.display = hasAny ? "" : "none";
    this.#delBtnEl.style.display = hasAny ? "" : "none";

    if (!hasAny) {
      // Clear rather than just hide. Profiles are scoped, so moving to a folder
      // outside every owner's subtree must not leave the previous folder's
      // options (and their disabled state) sitting in the DOM — hidden today,
      // but wrong the moment anything reads or re-shows the control.
      this.#selectEl.innerHTML = `<option value="">${escapeHtml(t("profiles.default"))}</option>`;
      this.#selectEl.value = "";
      for (const [btn, key] of [
        [this.#renameBtnEl, "profiles.rename"],
        [this.#delBtnEl, "profiles.delete"],
      ]) {
        btn.disabled = true;
        btn.title = t(key);
      }
    }

    if (hasAny) {
      const active = this.#editingProfileId ?? "";
      const parts = [
        `<option value="">${escapeHtml(t("profiles.default"))}</option>`,
      ];
      for (const g of this.#groups) {
        if (!(g.profiles ?? []).length) continue;
        parts.push(`<optgroup label="${escapeHtml(this.#groupLabel(g))}">`);
        for (const p of g.profiles) {
          const sel = p.id === active ? " selected" : "";
          parts.push(
            `<option value="${escapeHtml(p.id)}"${sel}>${escapeHtml(p.name)}</option>`,
          );
        }
        parts.push(`</optgroup>`);
      }
      this.#selectEl.innerHTML = parts.join("");
      this.#selectEl.value = active;

      // Default is neither renamable nor deletable; nor is an ancestor's profile
      // (manage it where it is defined, so one folder can't pull it from under
      // its siblings).
      const manageable = this.#canManage(this.#editingProfileId);
      const owner = this.#ownerOf(this.#editingProfileId);
      const blocked =
        this.#editingProfileId && !manageable && owner
          ? t("profiles.ownedElsewhere", {
              name: owner.profiles.find((p) => p.id === this.#editingProfileId)
                ?.name,
              owner: this.#groupLabel(owner),
            })
          : null;
      for (const [btn, key] of [
        [this.#renameBtnEl, "profiles.rename"],
        [this.#delBtnEl, "profiles.delete"],
      ]) {
        btn.disabled = !manageable;
        btn.title = blocked ?? t(key);
      }
    }

    // The cap is per owner, so [+] only gives up when BOTH scopes are full.
    const counts = this.#scopeCounts();
    const bothFull =
      counts.folder >= MAX_NAMED_PROFILES &&
      counts.collection >= MAX_NAMED_PROFILES;
    this.#addBtnEl.disabled = bothFull;
    this.#addBtnEl.title = bothFull
      ? t("profiles.limitOwner", { max: MAX_NAMED_PROFILES })
      : t("profiles.add");
  }

  // ── Name popups ────────────────────────────────────────────────────────────

  /** Toggle the [+] popup that names (and scopes) a NEW profile. */
  #toggleAddPopup() {
    if (this.#popupEl) {
      this.close();
      return;
    }
    const counts = this.#scopeCounts();
    this.#openNamePopup({
      anchor: this.#addBtnEl,
      ariaLabel: t("profiles.add"),
      scopeCounts: counts,
      onCommit: (name, scope) => this.#onAdd?.({ name, scope }),
    });
  }

  /**
   * Toggle the RENAME popup for the selected profile — the same anchored box,
   * pre-filled with (and selecting) the current name. The Default has no id, and
   * an ancestor's profile is managed where it is defined, so both are no-ops.
   */
  #toggleRenamePopup() {
    if (this.#popupEl) {
      this.close();
      return;
    }
    const id = this.#editingProfileId;
    if (!id || !this.#canManage(id)) return;
    const current = this.#ownerOf(id)?.profiles.find((p) => p.id === id);
    this.#openNamePopup({
      anchor: this.#renameBtnEl,
      ariaLabel: t("profiles.rename"),
      initialValue: current?.name ?? "",
      onCommit: (name) => this.#onRename?.({ profileId: id, name }),
    });
  }

  /**
   * Small anchored popup that captures a profile name (Enter commits with the
   * trimmed value, Esc / outside-click cancels). Shared by the add and rename
   * flows: `initialValue` pre-fills + selects the text; `scopeCounts` (add only)
   * adds the scope radios and disables whichever scope is at its cap.
   *
   * @param {{anchor: HTMLElement, ariaLabel: string, initialValue?: string,
   *   scopeCounts?: {folder: number, collection: number},
   *   onCommit: (name: string, scope: string) => void}} opts
   */
  #openNamePopup({
    anchor,
    ariaLabel,
    initialValue = "",
    scopeCounts,
    onCommit,
  }) {
    this.close();

    const pop = document.createElement("div");
    pop.className = "vars-profile-popup";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", ariaLabel);

    const folderFull = (scopeCounts?.folder ?? 0) >= MAX_NAMED_PROFILES;
    const collFull = (scopeCounts?.collection ?? 0) >= MAX_NAMED_PROFILES;
    // Default to this folder unless it is full; scoping to the folder is the
    // point of the feature, so it leads.
    const folderFirst = !folderFull;
    const scopeMarkup = scopeCounts
      ? `<fieldset class="vars-profile-scope">
           <legend class="vars-profile-scope-legend">${escapeHtml(t("profiles.scopeAria"))}</legend>
           <label class="vars-profile-scope-option">
             <input type="radio" name="vars-profile-scope" value="${PROFILE_SCOPE_FOLDER}"
               ${folderFirst ? "checked" : ""} ${folderFull ? "disabled" : ""}>
             ${escapeHtml(t("profiles.scopeFolder"))}
           </label>
           <label class="vars-profile-scope-option">
             <input type="radio" name="vars-profile-scope" value="${PROFILE_SCOPE_COLLECTION}"
               ${folderFirst ? "" : "checked"} ${collFull ? "disabled" : ""}>
             ${escapeHtml(t("profiles.scopeCollection"))}
           </label>
         </fieldset>`
      : "";

    pop.innerHTML = `<input type="text" class="settings-input vars-profile-name-input"
      placeholder="${escapeHtml(t("profiles.namePlaceholder"))}"
      aria-label="${escapeHtml(t("profiles.nameAria"))}"
      autocomplete="off" autocapitalize="off" spellcheck="false">${scopeMarkup}`;
    document.body.appendChild(pop);
    this.#popupEl = pop;

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

    const input = pop.querySelector("input[type=text]");
    input.value = initialValue;
    const commit = () => {
      const name = input.value.trim();
      const scope =
        pop.querySelector("input[name=vars-profile-scope]:checked")?.value ??
        PROFILE_SCOPE_FOLDER;
      this.close();
      if (name) onCommit?.(name, scope);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    });
    // Enter from a radio commits too, so the whole popup is keyboard-completable.
    for (const radio of pop.querySelectorAll("input[type=radio]")) {
      radio.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
      });
    }

    // Outside pointer-down cancels (the trigger's own toggle handles a click on
    // the anchor itself).
    const onDown = (e) => {
      if (!pop.contains(e.target) && !anchor.contains(e.target)) this.close();
    };
    // Defer so the click that opened the popup doesn't immediately close it.
    setTimeout(() => document.addEventListener("pointerdown", onDown, true), 0);
    this.#popupCleanup = () =>
      document.removeEventListener("pointerdown", onDown, true);

    requestAnimationFrame(() => {
      input.focus();
      // Rename: select the whole current name with the caret at the right end.
      if (initialValue)
        input.setSelectionRange(0, input.value.length, "forward");
    });
  }
}
