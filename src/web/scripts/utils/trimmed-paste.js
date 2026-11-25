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
 * utils/trimmed-paste.js — trim leading/trailing whitespace (and invisible
 * zero-width characters) from text pasted into a variable / bulk editor field.
 *
 * A value copied from a terminal, spreadsheet or web page usually drags in stray
 * spaces, tabs, a trailing newline, or an invisible zero-width character. The
 * bulk parsers trim each line, but keep the text after `=` verbatim — so pasting
 * " abc\n" after "token=" would store " abc" — and the per-row inputs store
 * whatever they are given. Only the pasted string is trimmed; existing content
 * and interior whitespace (multi-line pastes) are left alone.
 */

// Characters stripped from the ends of a paste: everything `\s` matches (space,
// tab, CR/LF, NBSP, U+2028/9, BOM, the Unicode Zs spaces) plus the invisible
// format characters `String.prototype.trim()` does NOT remove — zero-width
// space/non-joiner/joiner (U+200B–U+200D), word joiner (U+2060) and the Mongolian
// vowel separator (U+180E).
const EDGE_RE =
  /^[\s\u200B-\u200D\u2060\u180E\uFEFF]+|[\s\u200B-\u200D\u2060\u180E\uFEFF]+$/g;

/**
 * Strip leading/trailing whitespace and invisible zero-width characters.
 * Interior characters are preserved.
 * @param {string} text
 * @returns {string}
 */
export function trimPastedText(text) {
  return String(text ?? "").replace(EDGE_RE, "");
}

/**
 * Trim every plain-text paste into `field` (a `<textarea>` or text `<input>`)
 * before it is inserted. A paste that is already trimmed is left to the native
 * handler untouched.
 * @param {HTMLTextAreaElement|HTMLInputElement} field
 */
export function wireTrimmedPaste(field) {
  field.addEventListener("paste", (e) => {
    // A read-only/disabled field takes no paste natively; don't let the
    // setRangeText fallback write into it either.
    if (field.readOnly || field.disabled) return;
    const text = e.clipboardData?.getData("text/plain");
    if (!text) return;
    const trimmed = trimPastedText(text);
    if (trimmed === text) return;
    e.preventDefault();
    insertText(field, trimmed);
  });
}

/**
 * Replace the field's selection with `text`. execCommand keeps the native
 * undo stack and fires `input`; where it is unavailable (jsdom) fall back to
 * setRangeText + a synthetic `input` so the editor's listener still runs.
 */
function insertText(field, text) {
  const doc = field.ownerDocument;
  field.focus();
  // execCommand("insertText", "") is a no-op, so an empty insert (whitespace-only
  // paste over a selection) always takes the fallback path.
  if (text && doc.execCommand?.("insertText", false, text)) return;
  field.setRangeText(text, field.selectionStart, field.selectionEnd, "end");
  field.dispatchEvent(new Event("input", { bubbles: true }));
}
