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
 * json-path.js — A tiny dot-path extractor for the common REST subset.
 *
 * Handles the jq-style subset the app supports everywhere a body value is read:
 *   .field    .field.nested    .[0]    .
 *
 * Two entry points:
 *   - `extractJsonPath(str, q)` parses a JSON string, then walks the path.
 *   - `queryDataPath(value, q)` walks the path over an ALREADY-parsed value, so
 *     callers that parse the body themselves (e.g. captures.js, which also
 *     accepts YAML) reuse the exact same walk without re-implementing it.
 *
 * This is the same logic that backs the `response("Name", ".token")` function
 * (function-logic-map.js) and the post-response captures (captures.js). It lives
 * in its own IPC-free module so both consumers — and unit tests — can use it
 * without pulling in the function-backend / IPC layer.
 */

const SIMPLE_PATH = /^(\.[a-zA-Z_][a-zA-Z0-9_]*|\.\[\d+\])+$/;
const SEGMENT = /\.[a-zA-Z_][a-zA-Z0-9_]*|\.\[\d+\]/g;

/**
 * Walk a simple dot-path over an already-parsed value.
 *
 * @param {*} value         Parsed body (object / array / scalar).
 * @param {string} query    Dot-path, e.g. ".data.token" or ".[0].id" or ".".
 * @returns {string|null}
 *   - `null` when `query` is not a member of the simple subset (callers may then
 *     fall back to a richer evaluator).
 *   - `""` when the path resolves to `undefined`/`null`.
 *   - the string value, or `JSON.stringify(value)` for objects/arrays/numbers.
 */
export function queryDataPath(value, query) {
  const q = query.trim();
  if (q === ".") {
    return typeof value === "string" ? value : JSON.stringify(value);
  }
  if (!SIMPLE_PATH.test(q)) {
    return null; // not a simple query — caller falls back to the backend
  }
  let val = value;
  for (const seg of q.match(SEGMENT) ?? []) {
    if (seg.startsWith(".[")) {
      val = val?.[parseInt(seg.slice(2, -1), 10)];
    } else {
      val = val?.[seg.slice(1)];
    }
  }
  if (val === undefined || val === null) return "";
  if (typeof val === "string") return val;
  return JSON.stringify(val);
}

/**
 * Parse a JSON string and walk a simple dot-path into it.
 *
 * @param {string} jsonStr  Raw response body (JSON text).
 * @param {string} query    Dot-path, e.g. ".data.token" or ".[0].id" or ".".
 * @returns {string|null}   See {@link queryDataPath}; `""` for an empty body.
 */
export function extractJsonPath(jsonStr, query) {
  if (!jsonStr.trim()) return "";
  return queryDataPath(JSON.parse(jsonStr), query);
}
