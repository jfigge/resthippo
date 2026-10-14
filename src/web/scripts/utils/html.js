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
 * html.js — the single home for HTML string-escaping helpers.
 *
 * Two related-but-distinct jobs live here:
 *
 *  1. Injection escaping — `escapeHtml`. Use this when interpolating
 *     caller-supplied data into an `innerHTML` template. It escapes the four
 *     characters that matter (`&`, `<`, `>`, `"`), so the result is safe in
 *     BOTH element text and a double-quoted attribute value without the call
 *     site having to know which context it lands in. Over-escaping is invisible
 *     here because the browser un-escapes the entities when it renders.
 *
 *         el.innerHTML = `<span title="${escapeHtml(name)}">${escapeHtml(name)}</span>`;
 *
 *  2. Source serialization — `escapeHtmlText` / `escapeHtmlAttr`. Use these
 *     when reconstructing readable HTML *source* that will itself be displayed
 *     (e.g. the pretty-printed body view, which is shown to the user verbatim).
 *     There, over-escaping is VISIBLE — a literal `"` in text must stay a `"`,
 *     not become `&quot;` — so each helper escapes only the minimum its context
 *     requires while staying injection-safe for that context:
 *       • `escapeHtmlText` — HTML text node:            `&`, `<`, `>`
 *       • `escapeHtmlAttr` — double-quoted attribute:   `&`, `"`
 *
 * Prefer `escapeHtml` unless you are deliberately serializing source and the
 * extra entities would be seen by the user. All attribute values in this
 * codebase use double quotes; if a single-quoted-attribute context ever arises,
 * escape `'` as well at that call site.
 *
 * This file replaces the per-component `#escape`/`#esc`/`escAttr`/`escText`
 * copies that previously lived in individual components — some of which omitted
 * the `"` (unsafe inside attributes) or the `&` escape.
 */

"use strict";

/**
 * Escape a value for an HTML text node: `&`, `<`, `>`.
 * Safe and faithful inside element text (does not touch `"`).
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtmlText(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Escape a value for a double-quoted HTML attribute value: `&`, `"`.
 * Safe and faithful inside `attr="…"` (does not touch `<`/`>`, which are legal
 * literally in attribute values).
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtmlAttr(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;");
}

/**
 * Escape a value for safe insertion into HTML text OR any quoted attribute.
 * The five-character superset (`&`, `<`, `>`, `"`, `'`) — the default for
 * injecting caller data into `innerHTML`. Escaping `'` as well makes it
 * context-agnostic (safe inside single- or double-quoted attributes), so a
 * value like `' onmouseover=…` cannot break out even if a template happens to
 * use single quotes.
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return escapeHtmlText(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
