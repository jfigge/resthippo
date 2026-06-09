"use strict";

/**
 * json-path.js — A tiny dot-path extractor for the common REST subset.
 *
 * Handles the jq-style subset the app supports everywhere a body value is read:
 *   .field    .field.nested    .[0]    .
 *
 * This is the same logic that backs the `response("Name", ".token")` function
 * (function-logic-map.js) and the post-response captures (captures.js). It lives
 * in its own IPC-free module so both consumers — and unit tests — can use it
 * without pulling in the function-backend / IPC layer.
 */

/**
 * Walk a simple dot-path into a parsed JSON string.
 *
 * @param {string} jsonStr  Raw response body (JSON text).
 * @param {string} query    Dot-path, e.g. ".data.token" or ".[0].id" or ".".
 * @returns {string|null}
 *   - `null` when `query` is not a member of the simple subset (callers may then
 *     fall back to a richer evaluator).
 *   - `""` when the body is empty, or the path resolves to `undefined`/`null`.
 *   - the string value, or `JSON.stringify(value)` for objects/arrays/numbers.
 */
export function extractJsonPath(jsonStr, query) {
  if (!jsonStr.trim()) return "";
  const q = query.trim();
  if (q === ".") {
    const data = JSON.parse(jsonStr);
    return typeof data === "string" ? data : JSON.stringify(data);
  }
  if (!/^(\.[a-zA-Z_][a-zA-Z0-9_]*|\.\[\d+\])+$/.test(q)) {
    return null; // not a simple query — caller falls back to the backend
  }
  let val = JSON.parse(jsonStr);
  for (const seg of q.match(/\.[a-zA-Z_][a-zA-Z0-9_]*|\.\[\d+\]/g) ?? []) {
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
