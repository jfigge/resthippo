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
 * Command requests (Feature 70) report a process EXIT CODE as their status, so
 * `statusMatches(…, { command: true })` reads the groups as outcomes: "2xx" =
 * success (exit 0), "4xx"/"5xx" = failure (non-zero exit), and exact tokens
 * "0".."255" match an exit code. The default ["2xx"] thus means "on success".
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
/** Exact tokens may also name a process exit code (Command requests). */
const TOKEN_MIN = 0;

const GROUP_TOKENS = new Set(STATUS_GROUPS.map((g) => g.token));

/** True for a "Nxx" group token (N ∈ 1..5). */
function isGroupToken(token) {
  return GROUP_TOKENS.has(token);
}

/**
 * True for an exact-code token: an HTTP status (100–599) or, for Command
 * requests, a process exit code (0–255). A token below 100 never matches an
 * HTTP response (see statusMatches).
 */
export function isCodeToken(token) {
  return (
    /^(0|[1-9]\d{0,2})$/.test(token) &&
    Number(token) >= TOKEN_MIN &&
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
 * @param {number} status  the response's HTTP status code (or exit code)
 * @param {string[]} tokens  normalised selector tokens
 * @param {{ command?: boolean }} [opts]  `command` → `status` is an exit code
 * @returns {boolean}  false for an empty selector (matches nothing)
 */
export function statusMatches(status, tokens, { command = false } = {}) {
  if (!Array.isArray(tokens) || tokens.length === 0) return false;
  const code = Number(status);
  if (command) {
    if (!Number.isInteger(code) || code < 0) return false;
    for (const token of tokens) {
      if (token === STATUS_ANY) return true;
      if (token === "2xx" && code === 0) return true;
      if ((token === "4xx" || token === "5xx") && code !== 0) return true;
      if (isCodeToken(token) && Number(token) === code) return true;
    }
    return false;
  }
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
