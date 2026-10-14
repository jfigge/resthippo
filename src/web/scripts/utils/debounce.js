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
 * debounce.js — trailing-edge debounce with imperative cancel/pending.
 *
 * Replaces the hand-rolled `clearTimeout(this.#saveTimer); this.#saveTimer =
 * setTimeout(…)` autosave pattern that was copy-pasted across the variable
 * editors (vars-editor, collections-popup). Returns the
 * debounced function with two extras the callers need:
 *   - `.cancel()`  — drop a pending call without running it (used when a popup
 *                    reloads/switches data, or flushes-then-saves on close).
 *   - `.pending()` — whether a call is currently scheduled (a flush is a no-op
 *                    when nothing is queued).
 * Owning the timer here also removes the easy-to-forget `#saveTimer = null`
 * bookkeeping each call site used to repeat.
 *
 * @param {(...args: any[]) => void} fn  Function to debounce.
 * @param {number} ms                    Trailing delay in milliseconds.
 * @returns {((...args: any[]) => void) & { cancel(): void, pending(): boolean }}
 */
export function debounce(fn, ms) {
  let timer = null;
  const debounced = (...args) => {
    if (timer != null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
  debounced.cancel = () => {
    if (timer != null) clearTimeout(timer);
    timer = null;
  };
  debounced.pending = () => timer != null;
  return debounced;
}
