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
 * array) are its **Default** profile. Named profiles — whose NAMES span the
 * whole collection — store an alternate *value* per variable in
 * `node.profileValues[profileId] = { [name]: value }`.
 *
 * Invariant that makes the whole feature simple: a variable's **name and secure
 * flag always come from the Default set**, and a profile stores only the VALUES
 * that DIFFER from the Default (a sparse override map) — every unset value
 * inherits the Default. Consequences:
 *   • A brand-new profile shows the Default's names + values (an unset override
 *     inherits the Default value — that IS the "import" of req 9); the user then
 *     edits a value to pin an override.
 *   • Editing the Default value only rewrites names the profile has NOT overridden
 *     (overridden values are independent); un-overridden values keep following.
 *   • Adding / deleting a variable edits the Default name set; a profile inherits
 *     a newly-added variable's value and drops overrides for deleted names.
 *     [spec reqs 11, 12 — folder switch re-shows the new folder's Default names.]
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
 * a given profile. Names + secure flags come from the Default set; values are
 * the profile's overrides, falling back to the Default value for any name the
 * profile has no entry for (a freshly-added variable, or an uninitialised
 * profile — which then simply mirrors the Default, i.e. the "import" of req 9).
 *
 * @param {Array|object} defaultVars     The folder's Default profile variables.
 * @param {object} [profileValues]       `{ [profileId]: { [name]: value } }`.
 * @param {string|null} [profileId]      Active profile (null/"" = Default).
 * @returns {{name:string,value:string,secure:boolean}[]}
 */
export function effectiveProfileVars(defaultVars, profileValues, profileId) {
  const base = normalizeVariables(defaultVars);
  if (!profileId) return base; // Default profile
  const overrides = profileValues?.[profileId];
  return base.map((v) => ({
    name: v.name,
    secure: v.secure,
    value: has(overrides, v.name) ? overrides[v.name] : v.value,
  }));
}

/**
 * Reconcile an edit the variable editor emitted while `profileId` was active.
 * Returns the folder's new `{ variables, profileValues }`. Names + secure flags
 * in `edited` are authoritative for the Default; each profile's sparse override
 * map is pruned to the surviving names.
 *
 * Value rules:
 *   • Default active   → the edited values ARE the Default values. Named profiles
 *     keep their overrides (pruned to the current names); un-overridden names
 *     continue to inherit the (possibly changed) Default.
 *   • A named profile  → the edited values are that profile's shown values; each
 *     one becomes an override only when it DIFFERS from the Default (a value that
 *     equals the Default is left un-pinned, so it keeps inheriting). The Default
 *     keeps its existing value for names that already existed (a profile tweak
 *     never rewrites the Default), while a brand-new name seeds the Default from
 *     the only value available (the edited one).
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
  const prevByName = new Map(prevDefault.map((v) => [v.name, v]));
  const isDefault = !profileId;

  const variables = edited.map((v) => {
    const prev = prevByName.get(v.name);
    const value = isDefault || !prev ? v.value : prev.value;
    return { name: v.name, value, secure: v.secure };
  });

  const defByName = new Map(variables.map((v) => [v.name, v.value]));
  const names = new Set(variables.map((v) => v.name));
  const profileValues = {};
  for (const pid of profileIds) {
    const prevMap = current?.profileValues?.[pid] ?? {};
    // Carry existing overrides forward, dropping any for deleted names.
    const map = {};
    for (const [n, val] of Object.entries(prevMap)) {
      if (names.has(n)) map[n] = val;
    }
    if (!isDefault && pid === profileId) {
      // The edited profile: pin an override only where the value differs from
      // the Default; a value equal to the Default is left inheriting.
      for (const v of edited) {
        if (v.value === defByName.get(v.name)) delete map[v.name];
        else map[v.name] = v.value;
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
