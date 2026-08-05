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
