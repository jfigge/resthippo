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
    viewTimelineResponse: (url, response, timestamp) =>
      calls.view.push({ url, response, timestamp }),
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
  const timestamp = Date.UTC(2026, 0, 2, 3, 4, 5);
  fire("hippo:timeline-select", {
    requestUrl: "http://x/",
    response,
    timestamp,
  });
  assert.deepEqual(calls.view, [{ url: "http://x/", response, timestamp }]);
});

test("timeline-select without a timestamp forwards null (viewer dates it itself)", () => {
  const { calls, fire } = setup();
  fire("hippo:timeline-select", { requestUrl: "http://x/", response: {} });
  assert.equal(calls.view[0].timestamp, null);
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
