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
 * clipboard.js — copy-to-clipboard with a brief "copied" button flash.
 *
 * Collapses the copy-then-confirm pattern that was copy-pasted across the URL
 * preview (request-editor), the OAuth2 token row (request-auth-editor), the
 * timeline detail rows (timeline-view), and the code-gen / GraphQL-schema modals.
 * Two flavours mirror the two visual styles already in use: an icon swap (copy
 * glyph → check glyph plus a `--copied` modifier class) and a label swap
 * ("Copy" → "Copied"). Both write to the clipboard first and rethrow on failure
 * so the caller decides whether to surface an error, and both guard the deferred
 * restore on `btn.isConnected` so a re-render mid-flash can't touch a stale node.
 *
 * Callers own the displayed strings (already routed through `t()`); this module
 * carries no user-facing text of its own.
 */

/**
 * Copy `text`, then flash `btn` by swapping its innerHTML to a check glyph and
 * toggling `cls`, restoring the copy glyph after `ms`.
 *
 * @param {string} text       Text to write to the clipboard.
 * @param {HTMLElement} btn    Button to flash.
 * @param {object} opts
 * @param {string} opts.checkHtml  innerHTML for the "copied" (check) state.
 * @param {string} opts.copyHtml   innerHTML to restore (the copy glyph).
 * @param {string} [opts.cls]      Optional modifier class toggled during the flash.
 * @param {number} [opts.ms=1500]  Flash duration in milliseconds.
 * @returns {Promise<void>}  Rejects if the clipboard write fails (before flashing).
 */
export async function copyWithIconFlash(
  text,
  btn,
  { checkHtml, copyHtml, cls, ms = 1500 },
) {
  await navigator.clipboard.writeText(text);
  btn.innerHTML = checkHtml;
  if (cls) btn.classList.add(cls);
  setTimeout(() => {
    if (!btn.isConnected) return;
    btn.innerHTML = copyHtml;
    if (cls) btn.classList.remove(cls);
  }, ms);
}

/**
 * Copy `text`, then flash `btn`'s text label to `copiedText`, restoring
 * `restoreText` after `ms`.
 *
 * @param {string} text          Text to write to the clipboard.
 * @param {HTMLElement} btn       Button whose label flashes.
 * @param {object} opts
 * @param {string} opts.copiedText   Label for the "copied" state.
 * @param {string} opts.restoreText  Label to restore afterwards.
 * @param {number} [opts.ms=1200]    Flash duration in milliseconds.
 * @returns {Promise<void>}  Rejects if the clipboard write fails (before flashing).
 */
export async function copyWithLabelFlash(
  text,
  btn,
  { copiedText, restoreText, ms = 1200 },
) {
  await navigator.clipboard.writeText(text);
  btn.textContent = copiedText;
  setTimeout(() => {
    if (btn.isConnected) btn.textContent = restoreText;
  }, ms);
}
