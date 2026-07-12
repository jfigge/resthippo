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
 * stream-view.test.js — StreamView (live SSE/chunked streaming, Feature 33).
 *
 * Driven through a stub `host` facade (the accessors ResponseViewer owns), so the
 * tricky ordering guarantees are exercised in isolation: the arm→buffer→replay of
 * frames that arrive before the streaming marker, a terminal frame that races
 * ahead of the marker, the streaming/ended/error toolbar state, teardown, and the
 * save-filename derivation.
 */
"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "../../tests/jsdom-setup.js";
import { StreamView } from "../response/stream-view.js";

/** Build a status bar with the slots StreamView reads/writes. */
function makeStatusBar() {
  const bar = document.createElement("div");
  for (const cls of ["res-status-badge", "res-time", "res-size"]) {
    const s = document.createElement("span");
    s.className = cls;
    bar.appendChild(s);
  }
  return bar;
}

/** A recording stub of the ResponseViewer host facade + a fresh StreamView. */
function makeView({ activeTab = "body", loading = false } = {}) {
  resetDom();
  const bodyPane = document.createElement("div");
  const statusBar = makeStatusBar();
  const calls = { switchTab: [], headers: [], cookies: [], console: [] };
  const host = {
    getActiveTab: () => activeTab,
    getBodyPane: () => bodyPane,
    getStatusBar: () => statusBar,
    isLoading: () => loading,
    statusClass: (code) => `status--${code || "err"}`,
    formatSize: (bytes) => `${bytes}B`,
    setStatus: () => {},
    setCurrentMethod: () => {},
    setPreviewTabVisible: () => {},
    switchTab: (id) => calls.switchTab.push(id),
    renderHeadersPane: (h) => calls.headers.push(h),
    renderCookiesPane: (c) => calls.cookies.push(c),
    renderConsole: (l) => calls.console.push(l),
    teardownBinaryEphemera: () => {},
    destroyHtmlPreview: () => {},
    clearSearchHighlights: () => {},
    setFoldReveal: () => {},
    resetStaticBody: () => {},
  };
  return { view: new StreamView(host), bodyPane, statusBar, calls };
}

const marker = (over = {}) => ({
  streamId: 1,
  status: 200,
  statusText: "OK",
  elapsed: 5,
  headers: { "content-type": "text/event-stream" },
  cookies: [],
  consoleLog: [],
  request: { method: "GET", url: "http://example.test/sse" },
  ...over,
});

const dot = (bodyPane) => bodyPane.querySelector(".res-stream-dot");
const stateLabel = (bodyPane) =>
  bodyPane.querySelector(".res-stream-state-label")?.textContent;

// ── lifecycle / streaming state ────────────────────────────────────────────────

test("isStreaming tracks start → teardown", () => {
  const { view, bodyPane } = makeView();
  assert.equal(view.isStreaming(), false);

  view.startStream(marker(), "http://example.test/sse");
  assert.equal(view.isStreaming(), true);
  assert.ok(bodyPane.querySelector(".res-stream"), "stream pane built");
  assert.equal(dot(bodyPane).dataset.state, "streaming");

  view.teardownStream();
  assert.equal(view.isStreaming(), false);
});

test("startStream switches to the Body tab and renders marker headers/cookies/console", () => {
  const { view, calls } = makeView({ activeTab: "headers" });
  view.startStream(marker({ cookies: [{ name: "s", value: "1" }] }));
  assert.deepEqual(calls.switchTab, ["body"], "forced to the body tab");
  assert.equal(calls.headers.length, 1);
  assert.equal(calls.cookies.length, 1);
  assert.equal(calls.console.length, 1);
});

test("startStream does not switch tab when Body is already active", () => {
  const { view, calls } = makeView({ activeTab: "body" });
  view.startStream(marker());
  assert.deepEqual(calls.switchTab, []);
});

// ── buffering: frames before the marker are replayed, not dropped ──────────────

test("data arriving before the marker is buffered then replayed on startStream", () => {
  const { view, statusBar } = makeView();
  view.arm(1);
  // Frame arrives before startStream — buffered, so the status bar is untouched.
  view.onStreamData({
    streamId: 1,
    kind: "data",
    data: "x",
    totalBytes: 42,
    count: 1,
  });
  assert.equal(statusBar.querySelector(".res-size").textContent, "");

  // The marker activates the stream and drains the buffer → counters update.
  view.startStream(marker());
  assert.equal(
    statusBar.querySelector(".res-size").textContent,
    "42B",
    "buffered frame's byte total was applied on replay",
  );
});

test("onStreamData for an unrelated stream id is ignored", () => {
  const { view, statusBar } = makeView();
  view.arm(1);
  view.onStreamData({ streamId: 999, kind: "data", data: "x", totalBytes: 7 });
  view.startStream(marker());
  assert.equal(
    statusBar.querySelector(".res-size").textContent,
    "0B",
    "no buffered frame → size stays at the initial 0",
  );
});

// ── terminal frames ────────────────────────────────────────────────────────────

test("onStreamEnd while streaming moves the toolbar to the ended state", () => {
  const { view, bodyPane, statusBar } = makeView();
  view.startStream(marker());
  view.onStreamEnd({
    streamId: 1,
    elapsed: 50,
    totalBytes: 100,
    eventCount: 3,
  });
  assert.equal(dot(bodyPane).dataset.state, "ended");
  assert.equal(statusBar.querySelector(".res-time").textContent, "50 ms");
  assert.equal(statusBar.querySelector(".res-size").textContent, "100B");
});

test("onStreamError while streaming moves the toolbar to the error state", () => {
  const { view, bodyPane } = makeView();
  view.startStream(marker());
  view.onStreamError({ streamId: 1, message: "boom" });
  assert.equal(dot(bodyPane).dataset.state, "error");
  assert.notEqual(stateLabel(bodyPane), undefined);
});

test("a terminal frame that races ahead of the marker is applied on startStream", () => {
  const { view, bodyPane } = makeView();
  view.arm(1);
  // End arrives before the marker (very short stream) — held, not dropped.
  view.onStreamEnd({ streamId: 1, elapsed: 9, totalBytes: 4, eventCount: 1 });
  view.startStream(marker());
  assert.equal(
    dot(bodyPane).dataset.state,
    "ended",
    "the pending terminal reached its end state after activation",
  );
});

test("onStreamEnd is ignored after the stream already ended", () => {
  const { view, bodyPane } = makeView();
  view.startStream(marker());
  view.onStreamEnd({ streamId: 1, elapsed: 10 });
  view.onStreamError({ streamId: 1, message: "late" }); // must not override 'ended'
  assert.equal(dot(bodyPane).dataset.state, "ended");
});

// ── NDJSON heads-up hint ───────────────────────────────────────────────────────

test("onStreamHint inserts the NDJSON banner only while the armed stream is loading", () => {
  const { view, bodyPane } = makeView({ loading: true });
  view.arm(7);
  view.onStreamHint({ streamId: 7 });
  assert.ok(bodyPane.querySelector(".res-stream-hint-banner"), "hint shown");
  // Idempotent — a second hint doesn't stack a duplicate banner.
  view.onStreamHint({ streamId: 7 });
  assert.equal(bodyPane.querySelectorAll(".res-stream-hint-banner").length, 1);
});

test("onStreamHint does nothing when not loading", () => {
  const { view, bodyPane } = makeView({ loading: false });
  view.arm(7);
  view.onStreamHint({ streamId: 7 });
  assert.equal(bodyPane.querySelector(".res-stream-hint-banner"), null);
});

// ── save-filename derivation ───────────────────────────────────────────────────

test("saveStream derives a filename from the URL's last path segment", () => {
  const { view } = makeView();
  const saved = [];
  window.hippo = {
    http: { stream: { save: (id, name) => saved.push([id, name]) } },
  };
  view.startStream(marker(), "http://example.test/api/data.json?x=1");
  view.saveStream();
  assert.deepEqual(
    saved,
    [[1, "data.json"]],
    "extension preserved, query stripped",
  );
});

test("saveStream appends .txt when the last segment has no extension", () => {
  const { view } = makeView();
  const saved = [];
  window.hippo = {
    http: { stream: { save: (id, name) => saved.push([id, name]) } },
  };
  view.startStream(marker(), "http://example.test/events");
  view.saveStream();
  assert.deepEqual(saved, [[1, "events.txt"]]);
});
