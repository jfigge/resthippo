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
