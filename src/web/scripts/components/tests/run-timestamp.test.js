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
