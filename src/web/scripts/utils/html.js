/**
 * html.js — HTML-escaping helper.
 *
 * `escapeHtml` escapes the four characters that matter when injecting
 * caller-supplied strings into `innerHTML`: `&`, `<`, `>` and `"`. Escaping the
 * double-quote makes the result equally safe inside a double-quoted attribute
 * value (`value="${escapeHtml(x)}"`) and in element text, so one helper covers
 * both contexts used across the renderer. All attribute values in this codebase
 * use double quotes; if a single-quoted-attribute context ever arises, escape
 * `'` as well at that call site.
 *
 * This replaces the half-dozen private `#escape`/`#esc`/`#escapeHtml` copies
 * that previously lived in individual components — two of which omitted the
 * `"` escape and were unsafe inside attributes.
 *
 *   import { escapeHtml } from "../utils/html.js";
 *   el.innerHTML = `<span title="${escapeHtml(name)}">${escapeHtml(name)}</span>`;
 */

"use strict";

/**
 * Escape a value for safe insertion into HTML text or a double-quoted attribute.
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
