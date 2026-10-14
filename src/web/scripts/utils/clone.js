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
 * clone.js — structural deep-copy helper.
 *
 * Replaces the `JSON.parse(JSON.stringify(x))` idiom that was copy-pasted across
 * several components (tree-view, theme-editor, app, collections-popup). Uses
 * `structuredClone` — available in Electron's renderer — which is faster and
 * preserves more value types than a JSON round-trip. Falls back to the old JSON
 * behaviour for the rare input `structuredClone` cannot handle, so existing
 * call sites keep working unchanged.
 *
 *   import { deepClone } from "../utils/clone.js";
 *   const copy = deepClone(node);
 */

"use strict";

/**
 * Deep-copy a JSON-compatible value.
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function deepClone(value) {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}
