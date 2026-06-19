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
 * tests/diagnostics.test.js
 *
 * Unit tests for the diagnostics bundle builder (app/diagnostics.js). It is a
 * pure string builder, so the report a user attaches to a bug report is pinned
 * here: the header carries the app/build/runtime metadata, each log file appears
 * under a labelled section in chronological (oldest-first) order, and the empty
 * cases ("no logs", "empty file") render readable placeholders instead of gaps.
 *
 * Run with:   node --test tests/diagnostics.test.js
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildReport } = require("../diagnostics");

test("header includes the generated timestamp and every app-info field", () => {
  const report = buildReport({
    app: { version: "1.2.3", platform: "darwin arm64", node: "20.0.0" },
    logs: [],
    generatedAt: "2026-06-11T00:00:00.000Z",
  });
  assert.match(report, /Rest Hippo diagnostics report/);
  assert.match(report, /generated: 2026-06-11T00:00:00\.000Z/);
  assert.match(report, /version: 1\.2\.3/);
  assert.match(report, /platform: darwin arm64/);
  assert.match(report, /node: 20\.0\.0/);
});

test("each log file is rendered under a labelled section, in order", () => {
  const report = buildReport({
    app: {},
    logs: [
      { name: "main.1.log", content: "older line\n" },
      { name: "main.log", content: "newest line\n" },
    ],
  });
  assert.match(report, /----- main\.1\.log -----/);
  assert.match(report, /----- main\.log -----/);
  assert.match(report, /older line/);
  assert.match(report, /newest line/);
  // Oldest-first ordering: main.1.log appears before main.log.
  assert.ok(
    report.indexOf("main.1.log") < report.indexOf("main.log"),
    "rotated file should come before the current file",
  );
});

test("no log files renders an explicit placeholder", () => {
  const report = buildReport({ app: { version: "9" }, logs: [] });
  assert.match(report, /\(no log files found\)/);
});

test("an empty log file renders '(empty)' rather than a blank gap", () => {
  const report = buildReport({
    app: {},
    logs: [{ name: "main.log", content: "" }],
  });
  assert.match(report, /----- main\.log -----\n\(empty\)/);
});

test("the report always ends with a trailing newline", () => {
  assert.ok(buildReport({}).endsWith("\n"));
  assert.ok(
    buildReport({
      app: { a: 1 },
      logs: [{ name: "x", content: "y" }],
    }).endsWith("\n"),
  );
});
