"use strict";

/**
 * status-match.js — response-code matching for capture rules (Feature 03).
 *
 * A capture rule fires only when the response's HTTP status matches the rule's
 * status selector. The selector is a list of *tokens*; the rule matches if the
 * status satisfies ANY token:
 *   - "any"          — matches every response code
 *   - "1xx".."5xx"   — a status-class group (e.g. "2xx" = 200–299)
 *   - "100".."599"   — an exact status code
 *
 * Pure and DOM/i18n-free so it can be unit-tested under `node --test` and shared
 * by both the editor UI (`captures-editor.js`) and the executor (`captures.js`).
 * The default for an absent selector is `["2xx"]`, preserving the historical
 * "captures run on a 2xx response" behaviour for rules saved before this field
 * existed.
 */

/** The selectable status-class groups, in display order. */
export const STATUS_GROUPS = [
  { token: "1xx", min: 100, max: 199 },
  { token: "2xx", min: 200, max: 299 },
  { token: "3xx", min: 300, max: 399 },
  { token: "4xx", min: 400, max: 499 },
  { token: "5xx", min: 500, max: 599 },
];

/** The wildcard token that matches every response code. */
export const STATUS_ANY = "any";

/** Lowest / highest plausible HTTP status code we accept as an exact match. */
const CODE_MIN = 100;
const CODE_MAX = 599;

const GROUP_TOKENS = new Set(STATUS_GROUPS.map((g) => g.token));

/** True for a "Nxx" group token (N ∈ 1..5). */
function isGroupToken(token) {
  return GROUP_TOKENS.has(token);
}

/** True for an exact-code token in the 100–599 range. */
export function isCodeToken(token) {
  return (
    /^\d{3}$/.test(token) &&
    Number(token) >= CODE_MIN &&
    Number(token) <= CODE_MAX
  );
}

/**
 * Normalise a raw status selector into an array of valid, de-duplicated tokens.
 *
 * An absent / non-array value defaults to `["2xx"]` (back-compat). An explicit
 * empty array is preserved as empty — the user deliberately cleared it, and an
 * empty selector matches nothing.
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeStatusMatch(raw) {
  if (!Array.isArray(raw)) return ["2xx"];
  const out = [];
  const seen = new Set();
  for (const entry of raw) {
    const token = String(entry ?? "").trim();
    const valid =
      token === STATUS_ANY || isGroupToken(token) || isCodeToken(token);
    if (valid && !seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}

/**
 * Does `status` satisfy the selector `tokens`?
 *
 * @param {number} status  the response's HTTP status code
 * @param {string[]} tokens  normalised selector tokens
 * @returns {boolean}  false for an empty selector (matches nothing)
 */
export function statusMatches(status, tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return false;
  const code = Number(status);
  // A code outside the plausible HTTP range (e.g. 0 = no response) is not a real
  // status, so it matches nothing — not even "any".
  if (!Number.isFinite(code) || code < CODE_MIN || code > CODE_MAX)
    return false;

  for (const token of tokens) {
    if (token === STATUS_ANY) return true;
    if (isGroupToken(token) && Math.floor(code / 100) === Number(token[0])) {
      return true;
    }
    if (isCodeToken(token) && Number(token) === code) return true;
  }
  return false;
}
