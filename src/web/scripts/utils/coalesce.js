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
 * utils/coalesce.js — collapse overlapping async work into a single in-flight
 * run that always runs once more with the latest state.
 *
 * Extracted from app.js's tree-save loop (the `_collSaveInFlight`/`_collSaveDirty`
 * pattern): every trigger marks the task dirty; if a run is already active it
 * just sets the flag and returns; the active run loops until no trigger arrived
 * during its last pass. Because `task` takes no arguments and reads the latest
 * state itself at call time, the final run always reflects the newest edit even
 * if many triggers landed while it was busy. This keeps an expensive serialize-
 * everything-over-IPC save off the hot path without dropping the last change.
 */

"use strict";

/**
 * @param {() => (Promise<void> | void)} task  Idempotent task; reads current
 *   state itself (takes no args) so the final run reflects the latest trigger.
 * @param {(err: unknown) => void} [onError]   Called if a task run rejects/throws.
 *   Omitted → a rejection surfaces as an unhandled rejection (the pre-extraction
 *   behaviour), so pass one to log/swallow.
 * @returns {(() => void) & { pending(): boolean }}  Fire-and-forget trigger; the
 *   returned function never throws. `.pending()` reports whether a run is active.
 */
export function coalesce(task, onError) {
  let inFlight = false;
  let dirty = false;
  const trigger = () => {
    dirty = true;
    if (inFlight) return;
    inFlight = true;
    (async () => {
      try {
        while (dirty) {
          dirty = false;
          await task();
        }
      } catch (err) {
        if (onError) onError(err);
      } finally {
        inFlight = false;
      }
    })();
  };
  trigger.pending = () => inFlight;
  return trigger;
}
