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
 * pill-picker-data.js — the data feeding the `{{ }}` typeahead picker.
 *
 * Both pill editors built the picker's variable-scope list and function list the
 * same way (the lists were byte-for-byte identical, modulo comments). These pure
 * helpers are the single source of truth; the editors pass their resolved
 * context in and hand the result straight to PillPicker. Kept separate from the
 * DOM pill builders (pill-builders.js) and free of any editor/caret coupling, so
 * the forthcoming picker controller can reuse them too.
 */
"use strict";

import { t } from "../i18n.js";
import { collectScopes } from "./variable-resolver.js";
import { registry } from "./function-registry.js";

/**
 * The picker's variable groups for a resolved context: non-folder scopes lowest
 * priority first (global → environment → collection) with picker labels, then a
 * single de-duplicated "Folders" group for the reachable folder-chain names.
 * @param {object|null} ctx
 * @returns {Array<{ label: string, variables: string[] }>}
 */
export function pickerScopes(ctx) {
  // collectScopes() is the single source of truth for which context keys are
  // scopes and their resolution priority; here we render them lowest-priority
  // first (the reverse) with picker-specific labels.
  const bySource = { global: null, environment: null, collection: null };
  const folderNames = new Set();
  for (const { source, vars } of collectScopes(ctx)) {
    if (source === "folder") {
      for (const name of Object.keys(vars)) folderNames.add(name);
    } else {
      bySource[source] = vars;
    }
  }

  const labels = {
    global: "Global",
    environment: ctx?.activeEnvironmentName || "Environment",
    collection: ctx?.collectionName || "Collection",
  };

  const scopes = [];
  // Non-folder scopes, lowest priority first: global → environment → collection.
  for (const source of ["global", "environment", "collection"]) {
    const vars = bySource[source];
    if (!vars) continue;
    const names = Object.keys(vars).sort();
    if (names.length) scopes.push({ label: labels[source], variables: names });
  }

  // Folder chain — child folders override their parents, so when several folders
  // in the chain define the same name only the innermost is ever reachable.
  // Present the reachable set as a single "Folders" list of unique names rather
  // than one subsection per folder (which would surface superseded duplicates).
  if (folderNames.size)
    scopes.push({
      label: t("vars.folders"),
      variables: [...folderNames].sort(),
    });

  return scopes;
}

/** The picker's function list — every registered function with its definition. */
export function pickerFunctions() {
  return Object.entries(registry).map(([name, funcDef]) => ({ name, funcDef }));
}
