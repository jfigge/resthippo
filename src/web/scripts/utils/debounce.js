/*
 * Copyright 2026 Jason Figge
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * debounce.js — trailing-edge debounce with imperative cancel/pending.
 *
 * Replaces the hand-rolled `clearTimeout(this.#saveTimer); this.#saveTimer =
 * setTimeout(…)` autosave pattern that was copy-pasted across the variable
 * editors (vars-editor, variables-popup, collections-popup). Returns the
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
