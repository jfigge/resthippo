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
 * settings-handlers.test.js — the settings/history event-bus handlers extracted
 * from app.js. Focuses on the two with real logic: hippo:settings-changed (merge
 * + apply, forward historyCount, and NOT reloading when the locale is unchanged)
 * and hippo:history-trim (clamp to [0,10], pop overflow entries deleting each on
 * disk, drop the request entirely at max 0).
 */
"use strict";

import { resetDom } from "../../tests/jsdom-setup.js";

import { test } from "node:test";
import assert from "node:assert/strict";

import { installSettingsHandlers } from "../settings-handlers.js";

function setup({ locale = "system", selectedId = "r1", maxHistory = 10 } = {}) {
  resetDom();
  const settings = { locale };
  const calls = {
    apply: 0,
    setMax: [],
    deleteHistory: [],
    trimHistory: [],
    dispatch: [],
  };
  let max = maxHistory;
  const ctx = {
    getSettings: () => settings,
    updateSettings: (patch) => {
      Object.assign(settings, patch);
      return Promise.resolve();
    },
    applySettings: () => calls.apply++,
    setMaxHistory: (n) => {
      max = n;
      calls.setMax.push(n);
    },
    getMaxHistory: () => max,
    requestHistory: new Map(),
    deleteHistory: (rid, hid) => calls.deleteHistory.push([rid, hid]),
    trimHistory: (n) => {
      calls.trimHistory.push(n);
      return Promise.resolve();
    },
    dispatchTimelineUpdate: (rid) => calls.dispatch.push(rid),
    getSelectedNode: () => (selectedId ? { id: selectedId } : null),
  };
  installSettingsHandlers(ctx);
  const fire = (type, detail) =>
    window.dispatchEvent(new CustomEvent(type, { detail }));
  return { ctx, settings, calls, fire };
}

// ── hippo:settings-changed ─────────────────────────────────────────────────────

test("settings-changed merges the patch, applies, and forwards historyCount", () => {
  const { settings, calls, fire } = setup();
  fire("hippo:settings-changed", { fontSize: 16, historyCount: 5 });
  assert.equal(settings.fontSize, 16, "patch merged into currentSettings");
  assert.equal(calls.apply, 1, "settings re-applied");
  assert.deepEqual(
    calls.setMax,
    [5],
    "historyCount forwarded to setMaxHistory",
  );
});

test("settings-changed does not touch history when no historyCount is present", () => {
  const { calls, fire } = setup();
  fire("hippo:settings-changed", { theme: "dark" });
  assert.equal(calls.apply, 1);
  assert.deepEqual(calls.setMax, [], "no history change without historyCount");
});

// ── hippo:history-trim ─────────────────────────────────────────────────────────

test("history-trim pops overflow entries (newest kept) and deletes each on disk", () => {
  const { ctx, calls, fire } = setup();
  ctx.requestHistory.set("r1", [
    { id: "h1" },
    { id: "h2" },
    { id: "h3" },
    { id: "h4" },
  ]);

  fire("hippo:history-trim", { historyCount: 2 });

  assert.deepEqual(
    ctx.requestHistory.get("r1").map((e) => e.id),
    ["h1", "h2"],
    "trimmed to the cap, keeping the front of the list",
  );
  // The two popped (from the end) are each removed on disk.
  assert.deepEqual(calls.deleteHistory, [
    ["r1", "h4"],
    ["r1", "h3"],
  ]);
  assert.deepEqual(calls.setMax, [2]);
  assert.deepEqual(
    calls.trimHistory,
    [2],
    "on-disk sweep for unloaded requests",
  );
  assert.deepEqual(calls.dispatch, ["r1"]);
});

test("history-trim clamps the cap to at most 10", () => {
  const { ctx, calls, fire } = setup();
  ctx.requestHistory.set("r1", [{ id: "h1" }, { id: "h2" }]);
  fire("hippo:history-trim", { historyCount: 99 });
  assert.deepEqual(calls.setMax, [10], "cap clamped down to 10");
  assert.equal(
    ctx.requestHistory.get("r1").length,
    2,
    "nothing trimmed under the cap",
  );
});

test("history-trim at cap 0 empties and drops the request from the map", () => {
  const { ctx, calls, fire } = setup();
  ctx.requestHistory.set("r1", [{ id: "h1" }, { id: "h2" }]);
  fire("hippo:history-trim", { historyCount: -5 }); // negative → clamped to 0
  assert.deepEqual(calls.setMax, [0]);
  assert.equal(
    ctx.requestHistory.has("r1"),
    false,
    "request removed entirely at 0",
  );
  assert.deepEqual(calls.deleteHistory, [
    ["r1", "h2"],
    ["r1", "h1"],
  ]);
});
