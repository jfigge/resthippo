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
 * tests/notifications.test.js
 *
 * Behaviour + accessibility tests for the toast surface (notifications.js) under
 * jsdom. The toast surface is the single app-wide way the renderer tells the user
 * something happened (write failed, import succeeded, …), so these pin the
 * contract the rest of the app relies on:
 *   • errors are persistent, live in the assertive region, and are dismissible;
 *   • info/warning/success auto-dismiss from the polite region;
 *   • the optional action button fires its callback and dismisses;
 *   • the stack evicts the oldest toast past its cap;
 *   • both live regions carry the correct aria-live politeness.
 *
 * The module binds its container to whatever `document` is current on first use;
 * the suite therefore keeps the single jsdom document installed at module-load
 * (no per-test resetDom) and clears leftover toast nodes between cases instead.
 *
 * Run with:   node --test tests/notifications.test.js
 */

"use strict";

// Installs a jsdom document onto the Node globals the component reads.
import "./jsdom-setup.js";

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { Notifications } from "../notifications.js";

/** Let queued rAF (shimmed to setTimeout 0) + short timers settle. */
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

/** Reset the surface to a clean slate between cases (registry + DOM nodes). */
beforeEach(() => {
  Notifications.dismissAll();
  const region = document.querySelector(".toast-region");
  if (region)
    for (const el of [...region.querySelectorAll(".toast")]) el.remove();
});

const assertiveRegion = () => document.querySelector(".toast-stack--assertive");
const politeRegion = () => document.querySelector(".toast-stack--polite");

test("error(): mounts a persistent, dismissible toast in the assertive region", async () => {
  Notifications.error("boom", { title: "Save failed" });
  await tick();

  const region = assertiveRegion();
  assert.ok(region, "an assertive live region exists");
  assert.equal(region.getAttribute("aria-live"), "assertive");

  const toast = region.querySelector(".toast--error");
  assert.ok(toast, "the error toast lives in the assertive region");
  assert.match(toast.querySelector(".toast-message").textContent, /boom/);
  assert.match(toast.querySelector(".toast-title").textContent, /Save failed/);
  assert.ok(toast.querySelector(".toast-close"), "has a keyboard close button");

  // Errors never auto-dismiss — still present well past any default duration.
  await tick(40);
  assert.ok(
    !toast.classList.contains("toast--leaving"),
    "the error toast is still showing (no auto-dismiss)",
  );
});

test("info(): mounts in the polite region with aria-live=polite", async () => {
  Notifications.info("heads up");
  await tick();

  const region = politeRegion();
  assert.ok(region);
  assert.equal(region.getAttribute("aria-live"), "polite");
  assert.ok(region.querySelector(".toast--info"));
});

test("success(): auto-dismisses after its duration", async () => {
  Notifications.success("done", { duration: 20 });
  await tick();
  const toast = politeRegion().querySelector(".toast--success");
  assert.ok(toast);
  assert.ok(
    !toast.classList.contains("toast--leaving"),
    "visible before timeout",
  );

  await tick(50);
  assert.ok(
    toast.classList.contains("toast--leaving"),
    "auto-dismiss started after the duration elapsed",
  );
});

test("close button dismisses the toast", async () => {
  Notifications.error("dismiss me");
  await tick();
  const toast = assertiveRegion().querySelector(".toast--error");
  toast.querySelector(".toast-close").click();

  assert.ok(toast.classList.contains("toast--leaving"));
});

test("action button invokes its callback and dismisses", async () => {
  let invoked = 0;
  Notifications.error("retryable", {
    actionLabel: "Retry",
    onAction: () => invoked++,
  });
  await tick();

  const toast = assertiveRegion().querySelector(".toast--error");
  const action = toast.querySelector(".toast-action");
  assert.ok(action, "the action button is rendered");
  assert.equal(action.textContent.trim(), "Retry");

  action.click();
  assert.equal(invoked, 1, "the action callback fired");
  assert.ok(
    toast.classList.contains("toast--leaving"),
    "and the toast dismissed",
  );
});

test("Escape dismisses a toast that has focus", async () => {
  Notifications.error("escape me");
  await tick();
  const toast = assertiveRegion().querySelector(".toast--error");

  toast.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  assert.ok(toast.classList.contains("toast--leaving"));
});

test("the stack evicts the oldest toast past the visible cap", async () => {
  // Persistent (duration 0) so only eviction — not an auto-dismiss timer —
  // can remove a toast during the test window.
  for (let i = 0; i < 6; i++) {
    Notifications.info(`msg ${i}`, { duration: 0 });
  }
  await tick();

  const region = politeRegion();
  const leaving = region.querySelectorAll(".toast--leaving");
  const active = region.querySelectorAll(".toast:not(.toast--leaving)");
  assert.equal(active.length, 5, "at most five toasts remain visible");
  assert.equal(leaving.length, 1, "the oldest toast was evicted");
});
