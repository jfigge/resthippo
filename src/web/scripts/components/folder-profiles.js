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
 * folder-profiles.js — pure model logic for folder-variable PROFILES.
 *
 * A folder's variables (`node.variables`, the canonical `[{name,value,secure}]`
 * array) are its **Default** profile — a profile whose name is BLANK. Named
 * profiles store their own *value* per variable in
 * `node.profileValues[profileId] = { [name]: value }`.
 *
 * A named profile is OWNED by one scope — the collection tier
 * (`collections[i].variableProfiles`) or one folder (`node.profiles`) — and is
 * visible only to its owner and that owner's descendants. This module stays
 * ownership-agnostic: it takes ids and values. Which ids are in scope at a given
 * node, and in what order, is {@link module:components/profile-scope}'s job.
 *
 * Model rules:
 *   • The Default profile OWNS the variable set. A variable's **name and secure
 *     flag always come from `node.variables`**, and only a Default edit can add,
 *     remove, or rename a variable (or flip its secure flag). Every named profile
 *     shares that exact name set.
 *   • A named profile stores ONLY values, keyed by name — and does so by
 *     **presence**: a name PRESENT in `profileValues[profileId]` is an explicit
 *     override (used verbatim, even when its value is an empty string); a name
 *     ABSENT from the map **inherits** the Default's value. This is the same
 *     model Postman uses for scope layering — "unset" and "explicitly empty" are
 *     distinct, per variable, with no global mode switch.
 *   • The EDITOR reflects that per row: an inheriting (absent) name shows blank
 *     with an "inherits default" hint and no override; typing a value (or
 *     clearing it to empty) makes it an explicit override; a "reset to inherit"
 *     control drops the override again. `effectiveProfileVars` carries an
 *     `overridden` flag per variable so the editor can render this.
 *   • At SEND time (`resolvedProfileVars`) a present name resolves to its stored
 *     value (empty included), an absent name to the Default's value. So a profile
 *     only needs to carry the variables that differ, yet can still force a
 *     genuinely empty value where wanted.
 *   • Editing a named profile can only change VALUES. Names + secure flags are
 *     taken from the Default: a name in the edit that is not in the Default set
 *     is ignored, and a Default name the edit dropped (e.g. deleted in the bulk
 *     editor) is restored with a blank value.
 *   • Active profiles are live at send time and LAYER: resolution passes each
 *     folder in the chain the ids active in its scope, outermost owner first, and
 *     the innermost override of a name wins (blank list → Default).
 *
 * The Default profile is represented by a null / empty `profileId`; named
 * profiles carry a UUID. Every function here is pure (no DOM, no persistence).
 */

import { normalizeVariables } from "./variable-shape.js";

/**
 * Most NAMED profiles a single OWNER may hold — the collection tier, or one folder
 * (the Default is implicit and always present, so this is the cap on user-created
 * profiles per owner). Kept at 9 so one owner's set still maps onto the ⌥⌘0–9
 * switch shortcuts. Because profiles are scoped, the total VISIBLE at a deep
 * folder is the sum across its owner chain and may exceed 9; only the first nine
 * in outermost→innermost order get a shortcut. Enforced where a profile is created
 * and mirrored in the editor's [+] control (vars-profile-bar.js).
 */
export const MAX_NAMED_PROFILES = 9;

const has = (obj, key) =>
  obj != null && Object.prototype.hasOwnProperty.call(obj, key);

/**
 * The effective variables to SHOW in the editor for a folder under a given
 * profile. Names + secure flags always come from the Default set. For the Default
 * profile this is just the canonical `{name,value,secure}` set. For a named
 * profile each entry also carries `overridden` — whether the profile has an
 * explicit value for that name (present in the map). An overriding entry shows its
 * stored value (empty included); an inheriting entry shows **blank** (the editor
 * renders an "inherits default" hint rather than pre-filling the Default), so you
 * can see which values the profile overrides. See {@link resolvedProfileVars} for
 * what each resolves to at send time.
 *
 * @param {Array|object} defaultVars     The folder's Default profile variables.
 * @param {object} [profileValues]       `{ [profileId]: { [name]: value } }`.
 * @param {string|null} [profileId]      Active profile (null/"" = Default).
 * @returns {{name:string,value:string,secure:boolean,overridden?:boolean}[]}
 */
export function effectiveProfileVars(defaultVars, profileValues, profileId) {
  const base = normalizeVariables(defaultVars);
  if (!profileId) return base; // Default profile (blank name) — no override concept
  const values = profileValues?.[profileId];
  return base.map((v) => {
    const overridden = has(values, v.name);
    return {
      name: v.name,
      secure: v.secure,
      value: overridden ? values[v.name] : "", // inheriting shows blank in the editor
      overridden,
    };
  });
}

/**
 * The effective `[{name,value,secure}]` to RESOLVE (send / preview / cURL / code
 * generation) for a folder under the profiles active in its scope. Names + secure
 * flags always come from the Default. Values resolve by **presence** (the same
 * distinction the editor shows): a name a profile has an explicit override for
 * resolves to that stored value — empty included — while a name no active profile
 * overrides inherits the Default's value.
 *
 * Profiles LAYER. `profileIds` is ordered **outermost owner → innermost owner**
 * (the collection tier first, then each ancestor folder that owns an active
 * profile, then the folder itself), and the last layer to override a name wins.
 * So a subfolder's profile beats its parent's on a shared variable name, while a
 * name only the parent's profile touches still comes through.
 *
 * @param {Array|object} defaultVars      The folder's Default profile variables.
 * @param {object} [profileValues]        `{ [profileId]: { [name]: value } }`.
 * @param {string|string[]|null} [profileIds]  Active profile ids, outermost first.
 *   A bare string is accepted as a one-element list; null/""/[] = Default only.
 * @returns {{name:string,value:string,secure:boolean}[]}
 */
export function resolvedProfileVars(defaultVars, profileValues, profileIds) {
  const base = normalizeVariables(defaultVars);
  const ids = (Array.isArray(profileIds) ? profileIds : [profileIds]).filter(
    Boolean,
  );
  if (!ids.length) return base; // Default profile (blank name)
  // Only the layers this folder actually stores values for can change anything.
  const layers = ids
    .map((id) => profileValues?.[id])
    .filter((m) => m != null && typeof m === "object");
  if (!layers.length) return base;
  return base.map((v) => {
    let value = v.value;
    // Outermost → innermost: the last layer that overrides this name wins.
    // Present (override) → stored value, even ""; absent → leave the layer below.
    for (const values of layers) {
      if (has(values, v.name)) value = values[v.name];
    }
    return { name: v.name, secure: v.secure, value };
  });
}

/**
 * Reconcile an edit the variable editor emitted while `profileId` was active.
 * Returns the folder's new `{ variables, profileValues }`.
 *
 *   • Default active   → the edited names + values + secure flags ARE the new
 *     Default set. Every named profile's value map is pruned to the surviving
 *     names (their stored values are otherwise untouched — they do not follow a
 *     Default value change).
 *   • A named profile  → the variable SET is immutable here (it stays the current
 *     Default). The edit rebuilds that profile's value map by presence: a name
 *     the edit marks as an OVERRIDE is stored (empty value included); a name it
 *     does not override is left unstored so it inherits the Default. `overrideNames`
 *     names the explicit overrides (the KV table knows them exactly); when it is
 *     omitted — the bulk editor, which can't express an empty override — a name
 *     falls back to "override iff its edited value is non-blank" (blank → inherit).
 *     Names outside the Default set are ignored.
 *
 * The written key set is the UNION of `profileIds`, the ids already present in
 * `current.profileValues`, and `profileId` — an id the caller does not know about
 * is carried forward **untouched, never pruned**. That matters once profiles are
 * scoped: dragging a folder out from under the ancestor that owns a profile leaves
 * its stored values dormant rather than deleted, so moving it back restores them.
 * Pruning is exclusive to an explicit delete ({@link removeProfileFromFolder}).
 *
 * A profile whose reconciled map is EMPTY is omitted rather than stored as `{}`.
 * The two are indistinguishable at read time (both mean "overrides nothing"), and
 * writing `{}` for every known profile on every save made "has a profileValues
 * key" useless as a signal for which folders actually use a profile.
 *
 * @param {{variables?:Array, profileValues?:object}} current
 * @param {string|null} profileId          Active profile (null/"" = Default).
 * @param {Array} editedVars               Effective vars emitted by the editor.
 * @param {string[]} [profileIds]          Profile ids to reconcile (in-scope ids);
 *                                          ids already stored are kept regardless.
 * @param {string[]|null} [overrideNames]  Names explicitly overridden (KV table);
 *                                          null/undefined → bulk fallback (non-blank).
 * @returns {{ variables: Array, profileValues: object }}
 */
export function applyProfileEdit(
  current,
  profileId,
  editedVars,
  profileIds = [],
  overrideNames = null,
) {
  const edited = normalizeVariables(editedVars);
  const prevDefault = normalizeVariables(current?.variables);
  const isDefault = !profileId;

  // Only a Default edit can change the variable set; a named-profile edit leaves
  // the Default (names + secure flags) exactly as it was.
  const variables = (isDefault ? edited : prevDefault).map((v) => ({
    name: v.name,
    value: v.value,
    secure: v.secure,
  }));

  const names = new Set(variables.map((v) => v.name));
  const editedByName = new Map(edited.map((v) => [v.name, v.value]));
  const overrideSet = Array.isArray(overrideNames)
    ? new Set(overrideNames)
    : null;
  // Union: the caller's in-scope ids + everything already stored + the edited one.
  const knownIds = new Set([
    ...(Array.isArray(profileIds) ? profileIds : []),
    ...Object.keys(current?.profileValues ?? {}),
    ...(profileId ? [profileId] : []),
  ]);
  const profileValues = {};
  for (const pid of knownIds) {
    const map = {};
    if (!isDefault && pid === profileId) {
      // The edited profile: store only the names the edit marks as overrides
      // (presence). With an explicit override set an empty override is kept; the
      // bulk fallback treats any non-blank value as an override. Others inherit.
      for (const name of names) {
        if (!editedByName.has(name)) continue;
        const val = editedByName.get(name);
        const isOverride = overrideSet ? overrideSet.has(name) : val !== "";
        if (isOverride) map[name] = val;
      }
    } else {
      // An untouched profile: carry its stored values forward, dropping any for
      // names the Default no longer has.
      const prevMap = current?.profileValues?.[pid] ?? {};
      for (const [n, val] of Object.entries(prevMap)) {
        if (names.has(n)) map[n] = val;
      }
    }
    // Omit an empty map — "overrides nothing" is the absence of a key.
    if (Object.keys(map).length) profileValues[pid] = map;
  }

  return { variables, profileValues };
}

/**
 * Drop a deleted profile's snapshot from a folder's `profileValues`.
 * @param {object} [profileValues]
 * @param {string} profileId
 * @returns {object} a new map without `profileId`
 */
export function removeProfileFromFolder(profileValues, profileId) {
  if (!profileValues || typeof profileValues !== "object") return {};
  const next = {};
  for (const [pid, map] of Object.entries(profileValues)) {
    if (pid !== profileId) next[pid] = map;
  }
  return next;
}
