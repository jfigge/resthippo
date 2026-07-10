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
 *   • A named profile stores ONLY values, keyed by name. A name it has no stored
 *     value for shows **blank** — it does NOT inherit the Default value. So a
 *     brand-new profile (or a folder never edited under an existing profile)
 *     shows the Default's names with cleared values, ready for the user to fill
 *     in; the values a user leaves unset stay blank.
 *   • Editing a named profile can only change VALUES. Names + secure flags are
 *     taken from the Default: a name in the edit that is not in the Default set
 *     is ignored, and a Default name the edit dropped (e.g. deleted in the bulk
 *     editor) is restored with a blank value.
 *   • The active profile is live at send time: resolution uses
 *     `effectiveProfileVars(...)` for each folder in the chain.
 *
 * The Default profile is represented by a null / empty `profileId`; named
 * profiles carry a UUID. Every function here is pure (no DOM, no persistence).
 */

import { normalizeVariables } from "./variable-shape.js";

const has = (obj, key) =>
  obj != null && Object.prototype.hasOwnProperty.call(obj, key);

/**
 * The effective `[{name,value,secure}]` shown (and resolved) for a folder under
 * a given profile. Names + secure flags always come from the Default set. For a
 * named profile the value is that profile's own stored value, or **blank** when
 * it has no stored value for a name (an unset profile variable is blank — it does
 * not inherit the Default value).
 *
 * @param {Array|object} defaultVars     The folder's Default profile variables.
 * @param {object} [profileValues]       `{ [profileId]: { [name]: value } }`.
 * @param {string|null} [profileId]      Active profile (null/"" = Default).
 * @returns {{name:string,value:string,secure:boolean}[]}
 */
export function effectiveProfileVars(defaultVars, profileValues, profileId) {
  const base = normalizeVariables(defaultVars);
  if (!profileId) return base; // Default profile (blank name)
  const values = profileValues?.[profileId];
  return base.map((v) => ({
    name: v.name,
    secure: v.secure,
    value: has(values, v.name) ? values[v.name] : "",
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
 *     Default). The edited values rebuild that profile's value map by name: a
 *     Default name present in the edit takes its value; a Default name the edit
 *     dropped is restored blank; a name in the edit that is not in the Default
 *     set is ignored. Blank values are left unstored (they render blank anyway),
 *     keeping the map sparse.
 *
 * @param {{variables?:Array, profileValues?:object}} current
 * @param {string|null} profileId          Active profile (null/"" = Default).
 * @param {Array} editedVars               Effective vars emitted by the editor.
 * @param {string[]} [profileIds]          Every named profile id in the collection.
 * @returns {{ variables: Array, profileValues: object }}
 */
export function applyProfileEdit(
  current,
  profileId,
  editedVars,
  profileIds = [],
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
  const profileValues = {};
  for (const pid of profileIds) {
    const map = {};
    if (!isDefault && pid === profileId) {
      // The edited profile: rebuild its values from the Default name set. A name
      // in the edit takes its value; a Default name the edit dropped is restored
      // blank; names outside the Default set are ignored. Blank stays unstored.
      for (const name of names) {
        const val = editedByName.has(name) ? editedByName.get(name) : "";
        if (val !== "") map[name] = val;
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
