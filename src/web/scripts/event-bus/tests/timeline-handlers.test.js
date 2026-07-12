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
 * timeline-handlers.test.js — the non-destructive run-history (timeline)
 * event-bus handlers extracted from app.js. A mock bus context captures the
 * history maps + spy callbacks so the select / delete-entry / clear events can be
 * driven directly, including the id guards and the "only re-render when the
 * affected request is selected" condition.
 */
"use strict";

import { resetDom } from "../../tests/jsdom-setup.js";

import { test } from "node:test";
import assert from "node:assert/strict";

import { installTimelineHandlers } from "../timeline-handlers.js";

function setup({ selectedId = "r1" } = {}) {
  resetDom();
  const calls = { view: [], deleteHistory: [], clearHistory: [], dispatch: [] };
  const ctx = {
    viewTimelineResponse: (url, response) => calls.view.push({ url, response }),
    requestHistory: new Map(),
    historyLoaded: new Set(),
    deleteHistory: (rid, hid) => calls.deleteHistory.push([rid, hid]),
    clearHistory: (rid) => calls.clearHistory.push(rid),
    dispatchTimelineUpdate: (rid) => calls.dispatch.push(rid),
    getSelectedNode: () => (selectedId ? { id: selectedId } : null),
  };
  installTimelineHandlers(ctx);
  const fire = (type, detail) =>
    window.dispatchEvent(new CustomEvent(type, { detail }));
  return { ctx, calls, fire };
}

test("timeline-select forwards the url + response to the viewer (non-destructive)", () => {
  const { calls, fire } = setup();
  const response = { status: 200 };
  fire("hippo:timeline-select", { requestUrl: "http://x/", response });
  assert.deepEqual(calls.view, [{ url: "http://x/", response }]);
});

test("timeline-delete-entry removes the in-memory entry, deletes on disk, and re-renders", () => {
  const { ctx, calls, fire } = setup({ selectedId: "r1" });
  ctx.requestHistory.set("r1", [{ id: "h1" }, { id: "h2" }, { id: "h3" }]);

  fire("hippo:timeline-delete-entry", { requestId: "r1", historyId: "h2" });

  assert.deepEqual(
    ctx.requestHistory.get("r1").map((e) => e.id),
    ["h1", "h3"],
    "the matching entry was spliced out",
  );
  assert.deepEqual(calls.deleteHistory, [["r1", "h2"]]);
  assert.deepEqual(
    calls.dispatch,
    ["r1"],
    "re-render — the request is selected",
  );
});

test("timeline-delete-entry does NOT re-render when a different request is selected", () => {
  const { ctx, calls, fire } = setup({ selectedId: "other" });
  ctx.requestHistory.set("r1", [{ id: "h1" }]);
  fire("hippo:timeline-delete-entry", { requestId: "r1", historyId: "h1" });
  assert.deepEqual(
    calls.deleteHistory,
    [["r1", "h1"]],
    "still deleted on disk",
  );
  assert.deepEqual(
    calls.dispatch,
    [],
    "but the hidden request's pane is not refreshed",
  );
});

test("timeline-delete-entry is a no-op without both ids", () => {
  const { calls, fire } = setup();
  fire("hippo:timeline-delete-entry", { requestId: "r1" }); // missing historyId
  fire("hippo:timeline-delete-entry", { historyId: "h1" }); // missing requestId
  fire("hippo:timeline-delete-entry", {});
  assert.equal(calls.deleteHistory.length, 0);
});

test("timeline-clear empties the request's history and marks it loaded", () => {
  const { ctx, calls, fire } = setup({ selectedId: "r1" });
  ctx.requestHistory.set("r1", [{ id: "h1" }, { id: "h2" }]);

  fire("hippo:timeline-clear", { requestId: "r1" });

  assert.deepEqual(ctx.requestHistory.get("r1"), [], "in-memory list emptied");
  assert.ok(ctx.historyLoaded.has("r1"), "marked loaded so it won't re-fetch");
  assert.deepEqual(calls.clearHistory, ["r1"]);
  assert.deepEqual(calls.dispatch, ["r1"]);
});

test("timeline-clear is a no-op without a requestId", () => {
  const { calls, fire } = setup();
  fire("hippo:timeline-clear", {});
  assert.equal(calls.clearHistory.length, 0);
});
