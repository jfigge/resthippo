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
 * run-timestamp.js — when a run happened, for the response status bar.
 *
 * The status bar's meta column shows the absolute date/time of the run, above
 * the elapsed time and response size that readout describes.
 * Absolute (not the timeline's fuzzy "Last half hour") on purpose: the status
 * bar answers "which run am I looking at?" for a single response, and a replayed
 * history entry must be distinguishable from the one that just fired.
 *
 * Kept short and compact — the bar is narrow and the line must fit over
 * "1234 ms  12.3 KB" without widening the panel (see .res-run-at in
 * components.css).
 */

"use strict";

import { formatDate } from "../../i18n.js";

/**
 * Format a run's epoch-ms timestamp as a compact, locale-aware date + time.
 * Returns "" for a missing / unusable value, so callers can assign the result
 * straight to textContent and get an empty line rather than "Invalid Date".
 *
 * @param {number|Date|null|undefined} ts  epoch milliseconds (or a Date)
 * @returns {string}
 */
export function formatRunAt(ts) {
  if (!ts) return "";
  return formatDate(ts, { dateStyle: "short", timeStyle: "medium" });
}
