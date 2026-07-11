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
 * popup-manager.test.js — dismissal semantics of the one-shot confirm dialog.
 *
 * Pins the contract that Escape and an outside (mask) click are treated as
 * Cancel, so a caller that wraps confirm() in a Promise resolved only by its
 * onConfirm/onCancel callbacks (e.g. app.js _askKeepWsAlive) always settles
 * instead of hanging.
 *
 * Run with:
 *   node --test src/web/scripts/tests/popup-manager.test.js
 */
"use strict";

import "./jsdom-setup.js";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import { PopupManager } from "../popup-manager.js";

// A dismissed dialog's DOM node is removed lazily (on transitionend, or a 400 ms
// fallback) — neither fires synchronously under jsdom, so nodes linger. Clear
// them after each case so the active dialog is unambiguous. The overlay mask is
// cached by the manager and intentionally left in place.
afterEach(() => {
  for (const dlg of document.querySelectorAll(
    ".popup-confirm, .popup-notify, .popup-var-warn",
  )) {
    dlg.remove();
  }
});

/** The currently-open dialog (the last one appended to the body). */
function activeDialog() {
  const dialogs = document.querySelectorAll(".popup-confirm");
  return dialogs[dialogs.length - 1];
}

/** Dispatch a real keydown on document (what the dialog's listener observes). */
function pressKey(key) {
  document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

/** Click the overlay mask itself (an "outside" click). */
function clickMask() {
  const mask = document.querySelector(".popup-overlay");
  assert.ok(mask, "overlay mask should exist while a dialog is open");
  mask.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

/** Click a footer button on the active dialog by its data-action. */
function clickAction(action) {
  activeDialog()
    .querySelector(`[data-action='${action}']`)
    .dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

/** Fire a window resize — the event the manager listens for to tear down. */
function resizeWindow() {
  window.dispatchEvent(new Event("resize"));
}

test("confirm: Escape invokes onCancel, not onConfirm", () => {
  let confirmed = false;
  let cancelled = false;
  PopupManager.confirm({
    message: "Proceed?",
    onConfirm: () => {
      confirmed = true;
    },
    onCancel: () => {
      cancelled = true;
    },
  });

  pressKey("Escape");

  assert.equal(cancelled, true, "Escape must run onCancel");
  assert.equal(confirmed, false, "Escape must not run onConfirm");
});

test("confirm: outside (mask) click invokes onCancel", () => {
  let confirmed = false;
  let cancelled = false;
  PopupManager.confirm({
    message: "Proceed?",
    onConfirm: () => {
      confirmed = true;
    },
    onCancel: () => {
      cancelled = true;
    },
  });

  clickMask();

  assert.equal(cancelled, true, "an outside click must run onCancel");
  assert.equal(confirmed, false);
});

test("confirm: a Promise resolved only by the callbacks settles on Escape (no deadlock)", async () => {
  const choice = new Promise((resolve) => {
    PopupManager.confirm({
      message: "Keep the connection open?",
      onConfirm: () => resolve("keep"),
      onCancel: () => resolve("close"),
    });
  });

  pressKey("Escape");

  // Without the fix this await never resolves and the test times out.
  assert.equal(await choice, "close");
});

test("confirm: buttons still resolve their own callbacks", () => {
  let result = null;
  PopupManager.confirm({
    message: "Proceed?",
    onConfirm: () => {
      result = "confirm";
    },
    onCancel: () => {
      result = "cancel";
    },
  });
  clickAction("confirm");
  assert.equal(result, "confirm");

  result = null;
  PopupManager.confirm({
    message: "Proceed?",
    onConfirm: () => {
      result = "confirm";
    },
    onCancel: () => {
      result = "cancel";
    },
  });
  clickAction("cancel");
  assert.equal(result, "cancel");
});

test("confirm: window resize dismisses as cancel and settles an awaiting caller", async () => {
  const choice = new Promise((resolve) => {
    PopupManager.confirm({
      message: "Keep the connection open?",
      onConfirm: () => resolve("keep"),
      onCancel: () => resolve("close"),
    });
  });

  resizeWindow();

  // Without the fix, resize called PopupManager.close() (no callback) and this
  // await hung forever.
  assert.equal(await choice, "close");
});

test("confirm: resize removes the keydown listener (no stale onCancel on a later Escape)", () => {
  let cancels = 0;
  PopupManager.confirm({
    message: "Proceed?",
    onConfirm: () => {},
    onCancel: () => {
      cancels += 1;
    },
  });

  resizeWindow();
  assert.equal(cancels, 1, "resize must run onCancel exactly once");

  // The orphaned onKey listener (pre-fix) would fire a second, stale onCancel.
  pressKey("Escape");
  assert.equal(
    cancels,
    1,
    "a later Escape must not re-fire the settled callback",
  );
});

test("confirm: resize settles the callback exactly once even if a button is clicked after", () => {
  let result = null;
  PopupManager.confirm({
    message: "Proceed?",
    onConfirm: () => {
      result = "confirm";
    },
    onCancel: () => {
      result = "cancel";
    },
  });

  resizeWindow();
  assert.equal(result, "cancel");

  // dismiss() is idempotent — a stray confirm click after teardown is a no-op.
  const dlg = activeDialog();
  if (dlg) {
    const btn = dlg.querySelector("[data-action='confirm']");
    if (btn) btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }
  assert.equal(result, "cancel", "the settled cancel must not be overwritten");
});

test("notify: window resize dismisses without throwing", () => {
  PopupManager.notify({ title: "Heads up", message: "Something happened." });
  assert.doesNotThrow(() => resizeWindow());
});

test("warnVariables: window resize dismisses without proceeding", () => {
  let proceeded = false;
  PopupManager.warnVariables({
    variables: [{ name: "host", found: false, value: null }],
    onAction: () => {
      proceeded = true;
    },
  });

  resizeWindow();
  assert.equal(proceeded, false, "resize must not trigger the proceed action");
});

test("confirmDelete: Escape dismisses safely without deleting (no onCancel supplied)", () => {
  let deleted = false;
  PopupManager.confirmDelete({
    title: "Delete it?",
    message: "This cannot be undone.",
    onConfirm: () => {
      deleted = true;
    },
  });

  assert.doesNotThrow(() => pressKey("Escape"));
  assert.equal(deleted, false, "Escape must not trigger the delete");
});
