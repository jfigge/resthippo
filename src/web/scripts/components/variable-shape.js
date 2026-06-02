/**
 * variable-shape.js — Canonical shape helpers for variable collections.
 *
 * Variables are stored canonically as an ARRAY of entries:
 *   [{ name: string, value: string, secure: boolean }, …]
 *
 * Historically they were a plain map ({ name: value }), and that shape still
 * appears in legacy on-disk files, in Postman/import payloads, and in the
 * variable-resolver context (which intentionally consumes maps). These two
 * tolerant adapters bridge the two representations:
 *
 *   normalizeVariables(input)    → array  — upgrade map | array | null to canonical
 *   varsArrayToMap(input)        → map     — flatten canonical (or legacy map) to a map
 *   varsArrayToSecureSet(input)  → Set     — names flagged secure (the map drops this)
 *
 * Both accept either shape so callers never have to branch on the input form.
 */

"use strict";

/**
 * Coerce any supported variables input into the canonical array shape.
 *
 * - Array  → each entry normalized to { name, value, secure }; null entries skipped.
 * - Object → map entries become { name, value, secure:false } (legacy upgrade).
 * - null / other → [].
 *
 * Values are kept as-is for strings; non-string values are stringified so the
 * editors (which bind to text inputs) always receive a string.
 *
 * @param {Array|object|null|undefined} input
 * @returns {{ name: string, value: string, secure: boolean }[]}
 */
export function normalizeVariables(input) {
  if (Array.isArray(input)) {
    const out = [];
    for (const entry of input) {
      if (!entry || typeof entry !== "object") continue;
      out.push({
        name: String(entry.name ?? ""),
        value: _asString(entry.value),
        secure: !!entry.secure,
      });
    }
    return out;
  }
  if (input && typeof input === "object") {
    return Object.entries(input).map(([name, value]) => ({
      name: String(name),
      value: _asString(value),
      secure: false,
    }));
  }
  return [];
}

/**
 * Flatten variables to a { name: value } map for the resolver / exporters.
 *
 * - Array  → reduced to a map; entries with an empty name are skipped, last
 *            occurrence wins on duplicate names.
 * - Object → shallow copy (legacy tolerance).
 * - null / other → {}.
 *
 * @param {Array|object|null|undefined} input
 * @returns {Record<string, any>}
 */
export function varsArrayToMap(input) {
  if (Array.isArray(input)) {
    const out = {};
    for (const entry of input) {
      if (!entry || typeof entry !== "object") continue;
      const name = String(entry.name ?? "").trim();
      if (!name) continue;
      out[name] = entry.value;
    }
    return out;
  }
  if (input && typeof input === "object") return { ...input };
  return {};
}

/**
 * Collect the names of variables flagged `secure`.
 *
 * `varsArrayToMap` deliberately drops the `secure` flag (the resolver consumes
 * plain { name: value } maps), so callers that need to know which resolved
 * names are secret build a parallel set with this helper.
 *
 * - Array  → names whose entry has a truthy `secure` flag.
 * - Object → empty set (legacy maps carry no secure info).
 * - null / other → empty set.
 *
 * @param {Array|object|null|undefined} input
 * @returns {Set<string>}
 */
export function varsArrayToSecureSet(input) {
  const out = new Set();
  if (Array.isArray(input)) {
    for (const entry of input) {
      if (!entry || typeof entry !== "object" || !entry.secure) continue;
      const name = String(entry.name ?? "").trim();
      if (name) out.add(name);
    }
  }
  return out;
}

/** Coerce a variable value to a string for display/editing. */
function _asString(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return JSON.stringify(value);
}
