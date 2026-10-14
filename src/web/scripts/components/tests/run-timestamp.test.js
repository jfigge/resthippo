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
 * tests/run-timestamp.test.js
 *
 * Unit tests for formatRunAt — the status bar's "when did this run" line. The
 * contract that matters to the caller: a real timestamp renders as an absolute
 * locale date + time (never a relative phrase), and anything unusable renders as
 * "" so the line simply disappears instead of showing "Invalid Date".
 */

"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import { formatRunAt } from "../response/run-timestamp.js";
import { formatDate } from "../../i18n.js";

const TS = Date.UTC(2026, 6, 30, 14, 5, 43); // 2026-07-30T14:05:43Z

test("formats an epoch-ms timestamp as an absolute date + time", () => {
  const out = formatRunAt(TS);
  assert.equal(
    out,
    formatDate(TS, { dateStyle: "short", timeStyle: "medium" }),
    "uses the compact locale date+time format",
  );
  assert.ok(out.length > 0, "renders something");
  // Absolute, not the timeline's relative phrasing.
  assert.doesNotMatch(out, /ago|just now/i);
});

test("accepts a Date as well as epoch ms", () => {
  assert.equal(formatRunAt(new Date(TS)), formatRunAt(TS));
});

test("carries the run's date AND its time (both lines of information)", () => {
  const out = formatRunAt(TS);
  const local = new Date(TS);
  // Day-of-month and minutes appear in every locale's short/medium pairing.
  assert.ok(
    out.includes(String(local.getDate())),
    `day of month present (got: ${out})`,
  );
  assert.ok(
    out.includes(String(local.getMinutes()).padStart(2, "0")),
    `minutes present (got: ${out})`,
  );
});

test("renders an empty string for a missing timestamp", () => {
  assert.equal(formatRunAt(null), "");
  assert.equal(formatRunAt(undefined), "");
  assert.equal(formatRunAt(0), "");
  assert.equal(formatRunAt(""), "");
});

test("renders an empty string for an unparseable value (never 'Invalid Date')", () => {
  assert.equal(formatRunAt("not-a-date"), "");
  assert.equal(formatRunAt(NaN), "");
});
