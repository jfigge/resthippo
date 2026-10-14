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
 * utils/trimmed-paste.js — trim leading/trailing whitespace from text pasted
 * into a bulk-editor textarea.
 *
 * A value copied from a terminal or spreadsheet usually drags in stray spaces,
 * tabs or a trailing newline. The bulk parsers trim each line, but keep the text
 * after `=` verbatim — so pasting " abc\n" after "token=" would store " abc".
 * Only the pasted string is trimmed; existing content and interior whitespace
 * (multi-line pastes) are left alone.
 */

/**
 * Trim every plain-text paste into `textarea` before it is inserted. A paste
 * that is already trimmed is left to the native handler untouched.
 * @param {HTMLTextAreaElement} textarea
 */
export function wireTrimmedPaste(textarea) {
  textarea.addEventListener("paste", (e) => {
    const text = e.clipboardData?.getData("text/plain");
    if (!text) return;
    const trimmed = text.trim();
    if (trimmed === text) return;
    e.preventDefault();
    insertText(textarea, trimmed);
  });
}

/**
 * Replace the textarea's selection with `text`. execCommand keeps the native
 * undo stack and fires `input`; where it is unavailable (jsdom) fall back to
 * setRangeText + a synthetic `input` so the editor's listener still runs.
 */
function insertText(textarea, text) {
  const doc = textarea.ownerDocument;
  textarea.focus();
  // execCommand("insertText", "") is a no-op, so an empty insert (whitespace-only
  // paste over a selection) always takes the fallback path.
  if (text && doc.execCommand?.("insertText", false, text)) return;
  textarea.setRangeText(
    text,
    textarea.selectionStart,
    textarea.selectionEnd,
    "end",
  );
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}
