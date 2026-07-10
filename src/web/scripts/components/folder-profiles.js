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
 * folder-profiles.js — pure model logic for folder-variable PROFILES.
 *
 * A folder's variables (`node.variables`, the canonical `[{name,value,secure}]`
 * array) are its **Default** profile — a profile whose name is BLANK. Named
 * profiles — whose names span the whole collection — store their own *value* per
 * variable in `node.profileValues[profileId] = { [name]: value }`.
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
 *   • The active profile is live at send time: resolution uses
 *     `resolvedProfileVars(...)` for each folder in the chain (blank → Default).
 *
 * The Default profile is represented by a null / empty `profileId`; named
 * profiles carry a UUID. Every function here is pure (no DOM, no persistence).
 */

import { normalizeVariables } from "./variable-shape.js";

/**
 * Most NAMED profiles a collection may hold (the Default is implicit and always
 * present, so this is the cap on user-created profiles). Kept at 9 so the whole
 * set maps onto the ⌥⌘0–9 switch shortcuts — ⌥⌘0 selects the Default and ⌥⌘1–9
 * the nine named profiles. Enforced where a profile is created (app.js
 * `handleProfileAdd`) and mirrored in the editor's [+] control (vars-editor.js).
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
 * generation) for a folder under a given profile. Names + secure flags always
 * come from the Default. Values resolve by **presence** (the same distinction the
 * editor shows): a name the profile has an explicit override for resolves to that
 * stored value — empty included — while a name it does not override inherits the
 * Default's value.
 *
 * @param {Array|object} defaultVars      The folder's Default profile variables.
 * @param {object} [profileValues]        `{ [profileId]: { [name]: value } }`.
 * @param {string|null} [profileId]       Active profile (null/"" = Default).
 * @returns {{name:string,value:string,secure:boolean}[]}
 */
export function resolvedProfileVars(defaultVars, profileValues, profileId) {
  const base = normalizeVariables(defaultVars);
  if (!profileId) return base; // Default profile (blank name)
  const values = profileValues?.[profileId];
  return base.map((v) => ({
    name: v.name,
    secure: v.secure,
    // Present (override) → stored value, even ""; absent → inherit the Default.
    value: has(values, v.name) ? values[v.name] : v.value,
  }));
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
 * @param {{variables?:Array, profileValues?:object}} current
 * @param {string|null} profileId          Active profile (null/"" = Default).
 * @param {Array} editedVars               Effective vars emitted by the editor.
 * @param {string[]} [profileIds]          Every named profile id in the collection.
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
  const profileValues = {};
  for (const pid of profileIds) {
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
    profileValues[pid] = map;
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
