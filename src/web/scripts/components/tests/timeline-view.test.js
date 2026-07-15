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
 * timeline-view.test.js — TimelineView (the response run-history master/detail
 * pane, Feature 45). Driven through its small host-deps facade with a stub pane,
 * so rendering, row state, the Feature-29 test indicator, selection/restore
 * events, and the clear-history guard are all exercised under jsdom without a
 * full ResponseViewer.
 */
"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "../../tests/jsdom-setup.js";
import { TimelineView } from "../response/timeline-view.js";

/**
 * A request snapshot in the shape the timeline actually persists: `params` and
 * `headers` are pre-serialized bulk-edit strings ("key: value" lines), NOT the
 * editor's row arrays — see #renderTimelineDetail ("already bulk-edit format").
 */
const snapshot = (over = {}) => ({
  method: "GET",
  url: "http://example.test/",
  params: "",
  headers: "",
  ...over,
});

/** Build an entry; `response` merges over sensible defaults. */
const entry = (id, response = {}, over = {}) => ({
  id,
  timestamp: 1700000000000,
  requestUrl: "http://example.test/",
  requestNode: snapshot(),
  response: {
    status: 200,
    statusText: "OK",
    elapsed: 12,
    size: 34,
    ...response,
  },
  ...over,
});

/**
 * Instantiate a TimelineView on a fresh DOM with a stub deps facade. Returns the
 * view, its pane element, and a spy record of placeholder invocations.
 */
function makeView(activeTab = "timeline") {
  resetDom();
  const pane = document.createElement("div");
  const placeholders = [];
  const view = new TimelineView({
    getActiveTab: () => activeTab,
    getPane: () => pane,
    placeholder: (opts) => {
      placeholders.push(opts);
      const el = document.createElement("div");
      el.className = "stub-placeholder";
      return el;
    },
    statusClass: (code) => `status--${code || "err"}`,
    formatSize: (bytes) => `${bytes}B`,
  });
  return { view, pane, placeholders };
}

/** Record window CustomEvents of the given type fired during `fn`. */
function captureEvent(type, fn) {
  const seen = [];
  const handler = (e) => seen.push(e.detail);
  window.addEventListener(type, handler);
  try {
    fn();
  } finally {
    window.removeEventListener(type, handler);
  }
  return seen;
}

// ── rendering ────────────────────────────────────────────────────────────────

test("update with no entries renders the shared empty placeholder", () => {
  const { view, pane, placeholders } = makeView();
  view.update([], "req-1");
  assert.equal(placeholders.length, 1, "placeholder builder was used");
  assert.ok(pane.querySelector(".stub-placeholder"));
  assert.equal(pane.querySelector(".timeline-item"), null);
});

test("update renders one row per entry; row 0 is marked latest", () => {
  const { view, pane } = makeView();
  view.update([entry("h2"), entry("h1")], "req-1");
  const rows = pane.querySelectorAll(".timeline-item");
  assert.equal(rows.length, 2);
  assert.ok(rows[0].classList.contains("timeline-item--latest"));
  assert.ok(!rows[1].classList.contains("timeline-item--latest"));
});

test("row shows status badge (via statusClass) and formatted time/size", () => {
  const { view, pane } = makeView();
  view.update([entry("h1")], "req-1");
  const row = pane.querySelector(".timeline-item");
  const badge = row.querySelector(".timeline-badge");
  assert.equal(badge.textContent, "200");
  assert.ok(badge.className.includes("status--200"));
  assert.equal(row.querySelector(".timeline-time").textContent, "12 ms");
  assert.equal(row.querySelector(".timeline-size").textContent, "34B");
});

test("an error entry (status 0) shows an ERR badge and Error text", () => {
  const { view, pane } = makeView();
  view.update(
    [entry("h1", { status: 0, statusText: "", elapsed: 0, size: 0 })],
    "req-1",
  );
  const row = pane.querySelector(".timeline-item");
  assert.equal(row.querySelector(".timeline-badge").textContent, "ERR");
  assert.equal(row.querySelector(".timeline-text").textContent, "Error");
});

test("render is a no-op when the timeline tab is not active", () => {
  const { view, pane } = makeView("body");
  view.update([entry("h1")], "req-1");
  assert.equal(pane.innerHTML, "", "inactive tab is never painted");
});

// ── Feature-29 test-result indicator ───────────────────────────────────────────

test("test indicator shows a pass badge when every assertion passed", () => {
  const { view, pane } = makeView();
  view.update(
    [entry("h1", { testResults: [{ passed: true }, { passed: true }] })],
    "req-1",
  );
  const tests = pane.querySelector(".timeline-tests");
  assert.ok(tests.classList.contains("timeline-tests--pass"));
  assert.equal(tests.textContent, "✓ 2/2");
});

test("test indicator shows a fail badge when any assertion failed", () => {
  const { view, pane } = makeView();
  view.update(
    [entry("h1", { testResults: [{ passed: true }, { passed: false }] })],
    "req-1",
  );
  const tests = pane.querySelector(".timeline-tests");
  assert.ok(tests.classList.contains("timeline-tests--fail"));
  assert.equal(tests.textContent, "✗ 1/2");
});

// ── selection / restore events ─────────────────────────────────────────────────

test("clicking a row selects it and dispatches hippo:timeline-select", () => {
  const { view, pane } = makeView();
  view.update([entry("h2"), entry("h1")], "req-1");

  const details = captureEvent("hippo:timeline-select", () => {
    pane.querySelectorAll(".timeline-item")[1].click();
  });
  assert.equal(details.length, 1);
  assert.equal(details[0].requestUrl, "http://example.test/");
  // Re-rendered row now carries the selected modifier.
  assert.ok(
    pane
      .querySelectorAll(".timeline-item")[1]
      .classList.contains("timeline-item--selected"),
  );
});

test("a double click restores the snapshot (hippo:timeline-restore)", () => {
  const { view, pane } = makeView();
  view.update([entry("h1")], "req-1");

  const details = captureEvent("hippo:timeline-restore", () => {
    // First click selects (and re-renders the list), so the second click must
    // land on the freshly-rendered row — mirroring a real double click.
    pane.querySelector(".timeline-item").click();
    pane.querySelector(".timeline-item").click();
  });
  assert.equal(details.length, 1, "restore fired once");
  assert.ok(details[0].requestNode, "carries the request snapshot");
});

// ── malformed-snapshot resilience ──────────────────────────────────────────────

test("a snapshot with array-typed params/headers renders without throwing", () => {
  const { view, pane } = makeView();
  // Legacy / malformed entry: params & headers as the editor's row arrays rather
  // than the expected bulk-edit strings. The detail panel must not call .trim()
  // on them and crash the whole timeline.
  const bad = entry(
    "h1",
    {},
    {
      requestNode: {
        method: "GET",
        url: "http://example.test/",
        params: [{ name: "a", value: "1", enabled: true }],
        headers: [{ name: "X", value: "y", enabled: true }],
      },
    },
  );
  assert.doesNotThrow(() => view.update([bad], "req-1"));
  assert.equal(
    pane.querySelectorAll(".timeline-item").length,
    1,
    "still rendered",
  );
});

// ── Variables section ──────────────────────────────────────────────────────────

test("the Variables section renders resolved name=value rows with a copy button", () => {
  const { view, pane } = makeView();
  view.update(
    [
      entry(
        "h1",
        {},
        {
          // url/params/headers/auth left empty so the Variables section owns the
          // only copy button and the only detail-kv rows in the panel.
          requestNode: snapshot({
            url: "",
            variables: [
              { name: "baseUrl", value: "http://x" },
              { name: "token", value: "abc" },
            ],
          }),
        },
      ),
    ],
    "req-1",
  );
  const detail = pane.querySelector(".timeline-detail");
  const kv = [...detail.querySelectorAll(".timeline-detail-kv")].map(
    (el) => el.textContent,
  );
  assert.ok(kv.includes("baseUrl=http://x"), "first variable rendered");
  assert.ok(kv.includes("token=abc"), "second variable rendered");
  assert.equal(
    detail.querySelectorAll(".timeline-detail-copy-btn").length,
    1,
    "Variables section has a copy-all button",
  );
});

test("the Variables section shows 'none' when the run captured no variables", () => {
  const { view, pane } = makeView();
  view.update(
    [entry("h1", {}, { requestNode: snapshot({ url: "" }) })],
    "req-1",
  );
  const detail = pane.querySelector(".timeline-detail");
  // params, headers, auth, and variables each render the "none" placeholder.
  assert.equal(detail.querySelectorAll(".timeline-detail-none").length, 4);
  assert.equal(detail.querySelectorAll(".timeline-detail-copy-btn").length, 0);
});

// ── clear-history guard ────────────────────────────────────────────────────────

test("clearAll dispatches hippo:timeline-clear for the current request", () => {
  const { view } = makeView();
  view.update([entry("h1")], "req-42");
  const details = captureEvent("hippo:timeline-clear", () => view.clearAll());
  assert.deepEqual(details, [{ requestId: "req-42" }]);
});

test("clearAll is a no-op when no request is bound", () => {
  const { view } = makeView();
  view.update([entry("h1")], null); // no requestId
  const details = captureEvent("hippo:timeline-clear", () => view.clearAll());
  assert.equal(details.length, 0, "no clear event without a bound request");
});
