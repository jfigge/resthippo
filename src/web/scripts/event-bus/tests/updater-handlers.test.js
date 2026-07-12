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
 * updater-handlers.test.js — the auto-update toast handlers (Feature 36). The
 * Notifications facade is spied so the guard logic is pinned: available/ready
 * always toast (ready wires a Restart action → updater.install), while
 * "up to date" and error toast ONLY on an explicit manual check (and never for a
 * dev build), so a silent startup check can't nag.
 */
"use strict";

import { resetDom } from "../../tests/jsdom-setup.js";

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { installUpdaterHandlers } from "../updater-handlers.js";
import { Notifications } from "../../notifications.js";

const original = {};
let calls;

beforeEach(() => {
  resetDom();
  calls = { info: [], success: [], error: [] };
  for (const kind of ["info", "success", "error"]) {
    original[kind] = Notifications[kind];
    Notifications[kind] = (message, opts = {}) =>
      calls[kind].push({ message, opts });
  }
  installUpdaterHandlers();
});

afterEach(() => {
  for (const kind of ["info", "success", "error"]) {
    Notifications[kind] = original[kind];
  }
});

const fire = (type, detail) =>
  window.dispatchEvent(new CustomEvent(type, { detail }));

test("updater-available shows an info toast carrying the version", () => {
  fire("hippo:updater-available", { version: "1.2.3" });
  assert.equal(calls.info.length, 1);
  assert.match(calls.info[0].message, /1\.2\.3/);
});

test("updater-downloaded shows a success toast whose action installs the update", () => {
  const installed = [];
  window.hippo = { updater: { install: () => installed.push(true) } };
  fire("hippo:updater-downloaded", { version: "2.0.0" });

  assert.equal(calls.success.length, 1);
  const { opts } = calls.success[0];
  assert.ok(opts.actionLabel, "a Restart action label is set");
  assert.equal(typeof opts.onAction, "function");
  opts.onAction();
  assert.deepEqual(installed, [true], "the action triggers updater.install()");
});

test("updater-not-available toasts only on a manual, non-dev check", () => {
  fire("hippo:updater-not-available", { manual: false }); // silent startup check
  assert.equal(calls.success.length, 0, "a silent check never nags");

  fire("hippo:updater-not-available", { manual: true, reason: "dev-build" });
  assert.equal(calls.success.length, 0, "dev builds report status elsewhere");

  fire("hippo:updater-not-available", { manual: true });
  assert.equal(calls.success.length, 1, "an explicit up-to-date check toasts");
});

test("updater-error toasts only on a manual check", () => {
  fire("hippo:updater-error", { manual: false });
  assert.equal(calls.error.length, 0, "a background failure stays silent");

  fire("hippo:updater-error", { manual: true });
  assert.equal(calls.error.length, 1);
});
