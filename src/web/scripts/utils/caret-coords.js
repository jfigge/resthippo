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
 * caret-coords.js — Pixel position of the caret inside a <textarea>.
 *
 * There is no native API for "where is character N rendered", so this uses the
 * well-known mirror-div technique: build an off-screen <div> that copies the
 * textarea's box + typography, fill it with the text up to the caret, place a
 * marker <span> at the caret, and read the marker's offset. Used by the GraphQL
 * query editor to anchor the autocomplete dropdown at the cursor rather than
 * below the whole textarea.
 */

"use strict";

// The textarea CSS properties the mirror div must replicate so wrapping and
// metrics match exactly.
const MIRRORED = [
  "boxSizing",
  "width",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "fontStyle",
  "fontVariant",
  "fontWeight",
  "fontStretch",
  "fontSize",
  "fontSizeAdjust",
  "lineHeight",
  "fontFamily",
  "textAlign",
  "textTransform",
  "textIndent",
  "textDecoration",
  "letterSpacing",
  "wordSpacing",
  "tabSize",
  "whiteSpace",
  "wordWrap",
  "wordBreak",
  "overflowWrap",
];

/**
 * Caret position for character offset `index`, in viewport coordinates.
 *
 * @param {HTMLTextAreaElement} textarea
 * @param {number} index  character offset into the textarea's value
 * @returns {{ left: number, top: number, height: number }} viewport coords of
 *   the caret's top-left and the line height
 */
export function caretCoordinates(textarea, index) {
  const doc = textarea.ownerDocument;
  const style = window.getComputedStyle(textarea);

  const mirror = doc.createElement("div");
  mirror.setAttribute("aria-hidden", "true");
  const s = mirror.style;
  s.position = "absolute";
  s.visibility = "hidden";
  s.whiteSpace = "pre-wrap";
  s.wordWrap = "break-word";
  s.top = "0";
  s.left = "0";
  for (const prop of MIRRORED) s[prop] = style[prop];
  // A textarea always shows its scrollbar gutter; force the same so widths match.
  s.overflow = "hidden";

  mirror.textContent = textarea.value.slice(0, index);
  const marker = doc.createElement("span");
  // A zero-width-ish marker; use the next char (or a placeholder) so it has a box.
  marker.textContent = textarea.value.slice(index) || ".";
  mirror.appendChild(marker);

  doc.body.appendChild(mirror);
  const markerTop = marker.offsetTop;
  const markerLeft = marker.offsetLeft;
  const lineHeight =
    parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2 || 16;
  doc.body.removeChild(mirror);

  const rect = textarea.getBoundingClientRect();
  return {
    left: rect.left + markerLeft - textarea.scrollLeft,
    top: rect.top + markerTop - textarea.scrollTop,
    height: lineHeight,
  };
}
