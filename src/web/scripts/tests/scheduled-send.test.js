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
 * scheduled-send.test.js — characterization of the Send button's scheduled-send
 * state machine (Immediate / Delayed / Interval), driven through RequestEditor's
 * public surface with mocked timers.
 *
 * This pins the exact timer sequencing — a delayed send fires once after its
 * delay, a second click cancels a live countdown, and an interval re-arms only
 * after the fired request settles — so the extraction of the state machine into
 * its own module is provably behaviour-preserving. The countdown's colour sweep
 * uses requestAnimationFrame, which the jsdom harness backs with setTimeout(0);
 * under mock.timers that would self-reschedule forever, so we neutralise rAF (it
 * is purely visual — the fire is driven by the mocked setTimeout).
 *
 * Run with:   node --test src/web/scripts/tests/scheduled-send.test.js
 */
"use strict";

// MUST precede the component import (it touches document / Prism on load).
import { resetDom } from "./jsdom-setup.js";

import { test, mock } from "node:test";
import assert from "node:assert/strict";

import { RequestEditor } from "../components/request-editor.js";

// The real setTimeout, captured before any mock.timers.enable — used to flush
// the async #sendRequest chain (variable resolution + dispatch) past mock timers.
const realSetTimeout = globalThis.setTimeout;
const flush = () => new Promise((r) => realSetTimeout(r, 0));

const NODE = { id: "r1", method: "GET", url: "https://api.example.com/x" };
const sendBtn = (editor) => editor.element.querySelector(".req-send-btn");
const rightClick = (btn, window) =>
  btn.dispatchEvent(
    new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
  );
// The timing dialog (#openDurationDialog) is mounted on document.body by
// PopupManager.openMenu; its single field's value is the timing in seconds.
const durationDialog = () =>
  document.querySelector(".req-send-duration-dialog");
const dialogSeconds = () =>
  durationDialog()?.querySelector(".req-send-type-duration-input")?.value;

function mount() {
  const window = resetDom();
  window.hippo = { isElectron: true, ws: {} };
  // Neutralise the sweep's rAF (see file header).
  const noop = () => 0;
  globalThis.requestAnimationFrame = noop;
  window.requestAnimationFrame = noop;
  globalThis.cancelAnimationFrame = () => {};
  window.cancelAnimationFrame = () => {};

  const editor = new RequestEditor();
  document.body.appendChild(editor.element);
  editor.setVariableContext({ collectionVariables: {}, folderChain: [] });
  editor.load(NODE);

  const sends = [];
  window.addEventListener("hippo:send-request", (e) => sends.push(e.detail));
  return { window, editor, sends };
}

test("delayed send: arms a countdown, then fires once at the deadline", async () => {
  const { editor, sends } = mount();
  // load() resets the type to immediate; set delayed AFTER load.
  editor.applySettings({ sendType: "delayed", sendDelayMs: 5000 });

  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    sendBtn(editor).click(); // arm the countdown
    await flush();
    assert.equal(sends.length, 0, "nothing sent during the countdown");
    assert.ok(
      sendBtn(editor).classList.contains("req-send-btn--countdown"),
      "the button shows the countdown",
    );

    mock.timers.tick(4999);
    await flush();
    assert.equal(sends.length, 0, "still counting just before the deadline");

    mock.timers.tick(1);
    await flush();
    assert.equal(sends.length, 1, "fired exactly once at the deadline");
  } finally {
    mock.timers.reset();
  }
});

test("delayed send: a second click cancels the live countdown (never fires)", async () => {
  const { editor, sends } = mount();
  editor.applySettings({ sendType: "delayed", sendDelayMs: 5000 });

  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    sendBtn(editor).click(); // arm
    sendBtn(editor).click(); // cancel (a click while counting cancels)
    assert.ok(
      !sendBtn(editor).classList.contains("req-send-btn--countdown"),
      "the button returned to idle",
    );

    mock.timers.tick(10000);
    await flush();
    assert.equal(sends.length, 0, "the cancelled countdown never fires");
  } finally {
    mock.timers.reset();
  }
});

test("interval send: fires, then re-arms after the request settles", async () => {
  const { window, editor, sends } = mount();
  editor.applySettings({ sendType: "interval", sendIntervalMs: 3000 });

  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    sendBtn(editor).click(); // arm the interval
    mock.timers.tick(3000);
    await flush();
    assert.equal(sends.length, 1, "first interval send fired");

    // The fired request completing is what re-arms the interval's next wait.
    window.dispatchEvent(
      new window.CustomEvent("hippo:response-received", {
        detail: { requestId: "r1" },
      }),
    );
    mock.timers.tick(3000);
    await flush();
    assert.equal(
      sends.length,
      2,
      "interval re-armed and fired again after settle",
    );
  } finally {
    mock.timers.reset();
  }
});

test("immediate send: fires synchronously on click, no countdown", async () => {
  const { editor, sends } = mount();
  // Default type after load() is immediate.
  sendBtn(editor).click();
  await flush();
  assert.equal(sends.length, 1, "immediate send fired on click");
  assert.ok(
    !sendBtn(editor).classList.contains("req-send-btn--countdown"),
    "no countdown for an immediate send",
  );
});

test("right-click in delayed mode (idle) re-opens the delay timing dialog", () => {
  const { window, editor } = mount();
  editor.applySettings({ sendType: "delayed", sendDelayMs: 7000 });

  rightClick(sendBtn(editor), window);
  assert.ok(durationDialog(), "the timing dialog opened");
  assert.equal(dialogSeconds(), "7", "it shows the active delay (7s)");
});

test("right-click in interval mode (idle) re-opens the interval timing dialog", () => {
  const { window, editor } = mount();
  editor.applySettings({ sendType: "interval", sendIntervalMs: 4000 });

  rightClick(sendBtn(editor), window);
  assert.ok(durationDialog(), "the timing dialog opened");
  assert.equal(dialogSeconds(), "4", "it shows the active interval (4s)");
});

test("right-click while counting down does nothing (editor locked)", () => {
  const { window, editor } = mount();
  editor.applySettings({ sendType: "delayed", sendDelayMs: 5000 });

  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    sendBtn(editor).click(); // arm — now counting down
    assert.ok(
      sendBtn(editor).classList.contains("req-send-btn--countdown"),
      "precondition: the countdown is live",
    );
    rightClick(sendBtn(editor), window);
    assert.equal(durationDialog(), null, "no timing dialog while running");
  } finally {
    mock.timers.reset();
  }
});

test("right-click in immediate mode does nothing (no timing to edit)", () => {
  const { window, editor } = mount();
  // Default type after load() is immediate.
  rightClick(sendBtn(editor), window);
  assert.equal(durationDialog(), null, "immediate has no timing dialog");
});
