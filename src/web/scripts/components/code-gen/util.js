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
 * code-gen/util.js — string-literal helpers shared by the per-target code
 * generators. Each helper turns an arbitrary (already variable-resolved) value
 * into a syntactically valid literal for one target language, so generators
 * stay focused on structure rather than escaping.
 */

/**
 * Single-quote a POSIX shell token, escaping embedded single quotes via the
 * `'\''` idiom. Used by the cURL and HTTPie targets.
 * @param {string} s
 * @returns {string}
 */
export function shellSingleQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

/**
 * A double-quoted JavaScript string literal. `JSON.stringify` produces exactly
 * this — quotes, newlines, backslashes and control chars all escaped — and the
 * result is also a valid Python and Go string literal (all three accept the
 * same `\n` / `\"` / `\\` / `\uXXXX` escapes), so the Python target reuses it.
 * @param {string} s
 * @returns {string}
 */
export function jsString(s) {
  return JSON.stringify(String(s));
}

/** Python string literal — identical escaping rules to {@link jsString}. */
export const pyString = jsString;

/**
 * A Go string literal. Prefers a back-quoted raw string for values that would
 * otherwise need escaping — multi-line or double-quote-bearing (JSON bodies) —
 * since the raw form keeps them readable; but only when the value itself has no
 * back-quote. Short, quote-free tokens (methods, header names, URLs) read better
 * as idiomatic double-quoted literals, which Go escapes the same way as
 * {@link jsString}.
 * @param {string} s
 * @returns {string}
 */
export function goString(s) {
  const str = String(s);
  if ((str.includes('"') || str.includes("\n")) && !str.includes("`")) {
    return `\`${str}\``;
  }
  return JSON.stringify(str);
}
