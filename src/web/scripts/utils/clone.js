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
 * clone.js — structural deep-copy helper.
 *
 * Replaces the `JSON.parse(JSON.stringify(x))` idiom that was copy-pasted across
 * several components (tree-view, theme-editor, app, environments-popup). Uses
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
