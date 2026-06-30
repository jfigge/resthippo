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
 * tests/request-editor.test.js
 *
 * Payload-coverage tests for the real RequestEditor. Each case loads a request
 * (the editor's public "selected" entry point), clicks the real Send button, and
 * captures the `hippo:send-request` descriptor the editor builds — asserting that
 * params, the various body types, and the static auth transforms all reach the
 * wire correctly.
 *
 * This complements renderer-e2e.test.js (which proves the full cycle for one
 * request) by sweeping the editor's load()/gather/build branches that a single
 * end-to-end path never touches. No IPC is needed: the editor dispatches
 * `hippo:send-request` after building the payload, so the test only listens.
 *
 * Run with:   node --test tests/request-editor.test.js
 */

"use strict";

// MUST precede the component import (the Prism bundle reads `Element` on load).
import { resetDom } from "./jsdom-setup.js";

import { test } from "node:test";
import assert from "node:assert/strict";

import { RequestEditor } from "../components/request-editor.js";

/**
 * Fresh DOM + editor; load `node`, click Send, and resolve the captured
 * `hippo:send-request` descriptor (or reject if the editor never dispatches).
 */
async function sendAndCapture(node) {
  const window = resetDom();
  window.hippo = { isElectron: false };

  const editor = new RequestEditor();
  document.body.appendChild(editor.element);
  editor.setVariableContext({ environmentVariables: {}, folderChain: [] });
  editor.load(node);

  const captured = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("editor never dispatched hippo:send-request")),
      1000,
    );
    window.addEventListener("hippo:send-request", (e) => {
      clearTimeout(timer);
      resolve(e.detail);
    });
  });

  editor.element.querySelector('[aria-label="Send request"]').click();
  return captured;
}

test("query params are appended to the URL, disabled rows skipped", async () => {
  const detail = await sendAndCapture({
    id: "r",
    method: "GET",
    url: "https://api.example.com/search",
    params: [
      { name: "q", value: "a b", enabled: true },
      { name: "skip", value: "no", enabled: false },
      { name: "page", value: "2", enabled: true },
    ],
  });
  assert.equal(detail.url, "https://api.example.com/search?q=a%20b&page=2");
});

test("form-urlencoded body is encoded with the right Content-Type", async () => {
  const detail = await sendAndCapture({
    id: "r",
    method: "POST",
    url: "https://x",
    bodyType: "form-urlencoded",
    bodyFormRows: [
      { name: "a", value: "1 2", enabled: true },
      { name: "b", value: "y&z", enabled: true },
    ],
  });
  assert.equal(detail.body, "a=1+2&b=y%26z");
  assert.equal(
    detail.headers["Content-Type"],
    "application/x-www-form-urlencoded",
  );
});

test("form-data body produces a multipart Content-Type and parts", async () => {
  const detail = await sendAndCapture({
    id: "r",
    method: "POST",
    url: "https://x",
    bodyType: "form-data",
    bodyFormRows: [{ name: "field", value: "val", enabled: true }],
  });
  assert.match(
    detail.headers["Content-Type"],
    /^multipart\/form-data; boundary=/,
  );
  assert.match(detail.body, /name="field"/);
});

test("basic auth builds a base64 Authorization header", async () => {
  const detail = await sendAndCapture({
    id: "r",
    method: "GET",
    url: "https://x",
    authEnabled: true,
    authType: "basic",
    authBasic: { username: "alice", password: "hunter2" },
  });
  assert.equal(
    detail.headers["Authorization"],
    `Basic ${btoa("alice:hunter2")}`,
  );
});

test("bearer auth builds a Bearer Authorization header", async () => {
  const detail = await sendAndCapture({
    id: "r",
    method: "GET",
    url: "https://x",
    authEnabled: true,
    authType: "bearer",
    authBearer: { token: "tok-123" },
  });
  assert.equal(detail.headers["Authorization"], "Bearer tok-123");
});

test("api-key auth in query placement appends to the URL, not the headers", async () => {
  const detail = await sendAndCapture({
    id: "r",
    method: "GET",
    url: "https://x",
    authEnabled: true,
    authType: "apikey",
    authApiKey: { name: "api_key", value: "k 1", addTo: "query" },
  });
  assert.equal(detail.headers["api_key"], undefined);
  // The editor normalises the base URL via encodeBaseUrl(), so a bare host gains
  // a trailing slash before the api-key query param is appended.
  assert.equal(detail.url, "https://x/?api_key=k%201");
});

test("a GET request carries no body even if a body type is set", async () => {
  const detail = await sendAndCapture({
    id: "r",
    method: "GET",
    url: "https://x",
    bodyType: "json",
    bodyText: '{"a":1}',
  });
  assert.equal(detail.body, null);
  assert.equal(detail.headers["Content-Type"], undefined);
});

test("disabled auth contributes no Authorization header", async () => {
  const detail = await sendAndCapture({
    id: "r",
    method: "GET",
    url: "https://x",
    authEnabled: false,
    authType: "basic",
    authBasic: { username: "u", password: "p" },
  });
  assert.equal(detail.headers["Authorization"], undefined);
});

// ── WebSocket mode (Feature 32) ─────────────────────────────────────────────

/** Fresh DOM + editor loaded with `node`; returns { window, editor }. */
function mountEditor(
  node,
  ctx = { environmentVariables: {}, folderChain: [] },
) {
  const window = resetDom();
  window.hippo = { isElectron: true, ws: {} };
  const editor = new RequestEditor();
  document.body.appendChild(editor.element);
  editor.setVariableContext(ctx);
  editor.load(node);
  return { window, editor };
}

test("WebSocket request renders a WS badge + Message tab (no Body tab)", () => {
  const { editor } = mountEditor({
    id: "w",
    protocol: "websocket",
    url: "wss://x",
  });
  assert.ok(
    editor.element.querySelector(".req-method-select--ws"),
    "WS pill present",
  );
  assert.ok(
    editor.element.querySelector('[data-tab="message"]'),
    "Message tab present",
  );
  assert.equal(
    editor.element.querySelector('[data-tab="body"]'),
    null,
    "Body tab absent",
  );
  assert.ok(
    editor.element.querySelector('[aria-label="Connect WebSocket"]'),
    "Connect button present",
  );
});

test("Connect resolves the URL + bearer header and dispatches ws-connect", async () => {
  const { window, editor } = mountEditor(
    {
      id: "w",
      protocol: "websocket",
      url: "wss://{{host}}/feed",
      authEnabled: true,
      authType: "bearer",
      authBearer: { token: "{{tok}}" },
    },
    {
      environmentVariables: { host: "echo.example.com", tok: "secret123" },
      folderChain: [],
    },
  );
  const captured = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("no ws-connect")), 1000);
    window.addEventListener("hippo:ws-connect", (e) => {
      clearTimeout(t);
      resolve(e.detail);
    });
  });
  editor.element.querySelector('[aria-label="Connect WebSocket"]').click();
  const detail = await captured;
  assert.equal(detail.url, "wss://echo.example.com/feed");
  assert.equal(detail.headers.Authorization, "Bearer secret123");
});

test("a composed message is variable-resolved and dispatched on ws-send", async () => {
  const { window, editor } = mountEditor(
    {
      id: "w",
      protocol: "websocket",
      url: "wss://x",
      wsMessage: "hi {{name}}",
    },
    { environmentVariables: { name: "Ada" }, folderChain: [] },
  );
  // The composer's Send is enabled only once the connection reports "open".
  window.dispatchEvent(
    new CustomEvent("hippo:ws-state", { detail: { state: "open" } }),
  );
  const captured = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("no ws-send")), 1000);
    window.addEventListener("hippo:ws-send", (e) => {
      clearTimeout(t);
      resolve(e.detail);
    });
  });
  const sendBtn = editor.element.querySelector('[aria-label="Send message"]');
  assert.equal(sendBtn.disabled, false, "Send enabled when open");
  sendBtn.click();
  const detail = await captured;
  assert.equal(detail.data, "hi Ada");
});

test("switching WebSocket → HTTP restores the method selector + Body tab", () => {
  const { editor } = mountEditor({
    id: "w",
    protocol: "websocket",
    url: "wss://x",
  });
  assert.ok(editor.element.querySelector(".req-method-select--ws"));
  editor.load({
    id: "h",
    method: "POST",
    url: "https://x",
    bodyType: "json",
    bodyText: "{}",
  });
  assert.equal(
    editor.element.querySelector(".req-method-select--ws"),
    null,
    "WS pill removed",
  );
  assert.ok(
    editor.element.querySelector('[aria-label="HTTP Method"]'),
    "method selector restored",
  );
  assert.ok(
    editor.element.querySelector('[data-tab="body"]'),
    "Body tab restored",
  );
  assert.equal(
    editor.element.querySelector('[data-tab="message"]'),
    null,
    "Message tab removed",
  );
});

// ── Send → Stop during a live stream (Feature 33) ───────────────────────────

test("Send stays Stop while a stream runs and a click cancels with its streamId", async () => {
  const { window, editor } = mountEditor({
    id: "r1",
    method: "GET",
    url: "https://x/sse",
  });
  const sendBtn = editor.element.querySelector(".req-send-btn");

  // In flight → Stop.
  window.dispatchEvent(
    new CustomEvent("hippo:request-loading", {
      detail: { requestId: "r1", streamId: "s1" },
    }),
  );
  assert.ok(
    sendBtn.classList.contains("req-send-btn--cancel"),
    "shows Stop while in flight",
  );

  // The streaming marker resolves execute() but the stream lives on — the button
  // must NOT revert to Send.
  window.dispatchEvent(
    new CustomEvent("hippo:response-received", {
      detail: { requestId: "r1", streaming: true, streamId: "s1" },
    }),
  );
  assert.ok(
    sendBtn.classList.contains("req-send-btn--cancel"),
    "stays Stop while the stream runs",
  );

  // Clicking Stop cancels with the streamId so app.js aborts the stream.
  const cancel = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("no cancel-request")), 1000);
    window.addEventListener("hippo:cancel-request", (e) => {
      clearTimeout(t);
      resolve(e.detail);
    });
  });
  sendBtn.click();
  const detail = await cancel;
  assert.equal(detail.requestId, "r1");
  assert.equal(detail.streamId, "s1");
});

test("the Send button reverts to Send when the stream ends", () => {
  const { window, editor } = mountEditor({
    id: "r1",
    method: "GET",
    url: "https://x/sse",
  });
  const sendBtn = editor.element.querySelector(".req-send-btn");
  window.dispatchEvent(
    new CustomEvent("hippo:request-loading", {
      detail: { requestId: "r1", streamId: "s1" },
    }),
  );
  window.dispatchEvent(
    new CustomEvent("hippo:response-received", {
      detail: { requestId: "r1", streaming: true, streamId: "s1" },
    }),
  );
  assert.ok(
    sendBtn.classList.contains("req-send-btn--cancel"),
    "Stop mid-stream",
  );

  window.dispatchEvent(
    new CustomEvent("hippo:stream-end", {
      detail: { streamId: "s1", aborted: false },
    }),
  );
  assert.equal(
    sendBtn.classList.contains("req-send-btn--cancel"),
    false,
    "reverts to Send once the stream ends",
  );
});

// ── loadSnapshot: test/script/capture config round-trips (timeline restore) ──

test("loadSnapshot restores the test config carried by the snapshot", () => {
  const { editor } = mountEditor({ id: "r1", url: "http://x" });
  const node = editor.loadSnapshot({
    id: "r1",
    method: "GET",
    url: "http://x",
    bodyType: "no-body",
    assertions: [{ source: "status", matcher: "equals", expected: "200" }],
    captures: [{ source: "body", path: "$.id", target: "id" }],
    afterResponseScript: "hippo.test('ok', () => {});",
    afterResponseScriptEnabled: true,
  });
  assert.equal(node.assertions.length, 1, "assertion restored");
  assert.equal(node.assertions[0].expected, "200");
  assert.equal(node.captures.length, 1, "capture restored");
  assert.equal(node.afterResponseScript, "hippo.test('ok', () => {});");
});

test("loadSnapshot keeps the request's current tests when the snapshot has none (old entry)", () => {
  const { editor } = mountEditor({
    id: "r1",
    url: "http://x",
    assertions: [{ source: "status", matcher: "equals", expected: "201" }],
    afterResponseScript: "current();",
  });
  // An older timeline entry predates test-config capture: no assertions/script
  // fields. Restoring it must NOT blank the request's live tests.
  const node = editor.loadSnapshot({
    id: "r1",
    method: "GET",
    url: "http://x",
    bodyType: "no-body",
  });
  assert.equal(node.assertions.length, 1, "current assertions preserved");
  assert.equal(node.assertions[0].expected, "201");
  assert.equal(node.afterResponseScript, "current();", "current script kept");
});

// ── Send types: Immediate / Delayed / Interval ───────────────────────────────

test("the idle Send button shows a type glyph for delayed/interval, none for immediate", () => {
  const { editor } = mountEditor({ id: "r1", url: "http://x" });
  const sendBtn = editor.element.querySelector(".req-send-btn");
  // Default type is "immediate" → no trailing glyph.
  assert.equal(
    sendBtn.querySelector(".req-send-type-icon"),
    null,
    "immediate carries no glyph",
  );

  // Switching the global default to "delayed" adds a regular-sized glyph.
  editor.applySettings({ sendType: "delayed" });
  assert.ok(
    sendBtn.querySelector(".req-send-type-icon svg"),
    "delayed renders a glyph to the right of Send",
  );

  // Back to immediate → glyph removed again.
  editor.applySettings({ sendType: "immediate" });
  assert.equal(
    sendBtn.querySelector(".req-send-type-icon"),
    null,
    "glyph removed when switching back to immediate",
  );
});

test("Delayed send counts down then fires once after the delay", async () => {
  const { window, editor } = mountEditor({ id: "r1", url: "http://x/d" });
  editor.applySettings({ sendType: "delayed", sendDelayMs: 30 });
  const sendBtn = editor.element.querySelector(".req-send-btn");

  const fired = new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error("delayed send never fired")),
      1000,
    );
    window.addEventListener("hippo:send-request", (e) => {
      clearTimeout(t);
      resolve(e.detail);
    });
  });

  sendBtn.click();
  // While counting down: the cancellable "Cancel" state, not yet dispatched.
  assert.ok(
    sendBtn.classList.contains("req-send-btn--countdown"),
    "shows the countdown state immediately",
  );

  const detail = await fired;
  assert.equal(detail.requestId, "r1");
  // After firing, the one-shot countdown is cleared.
  assert.ok(
    !sendBtn.classList.contains("req-send-btn--countdown"),
    "countdown cleared once fired",
  );
});

test("clicking Cancel during a delayed countdown stops it (no send)", async () => {
  const { window, editor } = mountEditor({ id: "r1", url: "http://x/d" });
  editor.applySettings({ sendType: "delayed", sendDelayMs: 60 });
  const sendBtn = editor.element.querySelector(".req-send-btn");

  let fired = false;
  window.addEventListener("hippo:send-request", () => {
    fired = true;
  });

  sendBtn.click();
  assert.ok(sendBtn.classList.contains("req-send-btn--countdown"));
  // Cancel before the timer elapses.
  sendBtn.click();
  assert.ok(
    !sendBtn.classList.contains("req-send-btn--countdown"),
    "reverts to idle Send on cancel",
  );

  await new Promise((r) => setTimeout(r, 120));
  assert.equal(fired, false, "cancelled countdown never dispatches a request");
});

test("Interval re-arms the countdown after the fired request completes", async () => {
  const { window, editor } = mountEditor({ id: "r1", url: "http://x/i" });
  // Interval waits its interval before every send — keep it small so the cycle
  // completes within the test timeout.
  editor.applySettings({ sendType: "interval", sendIntervalMs: 25 });
  const sendBtn = editor.element.querySelector(".req-send-btn");

  const nextSend = () =>
    new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error("interval never fired")),
        1000,
      );
      window.addEventListener(
        "hippo:send-request",
        (e) => {
          clearTimeout(t);
          resolve(e.detail);
        },
        { once: true },
      );
    });

  // First cycle: count down → fire.
  const first = nextSend();
  sendBtn.click();
  await first;

  // Complete the fired request; the loop must re-arm and fire a second time.
  const second = nextSend();
  window.dispatchEvent(
    new CustomEvent("hippo:response-received", { detail: { requestId: "r1" } }),
  );
  await second;

  // Stop the loop so the test's timers don't keep running.
  if (sendBtn.classList.contains("req-send-btn--countdown")) sendBtn.click();
  window.dispatchEvent(
    new CustomEvent("hippo:request-error", { detail: { requestId: "r1" } }),
  );
});

/** Open the native send-type menu (stubbed to resolve `choiceId`) and settle. */
async function pickSendType(window, editor, choiceId) {
  const calls = [];
  window.hippo.ui = {
    contextMenu: {
      show: async (opts) => {
        calls.push(opts);
        return choiceId;
      },
    },
  };
  const trigger = editor.element.querySelector(".req-send-type-trigger");
  trigger.dispatchEvent(
    new window.MouseEvent("mousedown", { button: 0, bubbles: true }),
  );
  await new Promise((r) => setTimeout(r, 0)); // let the async menu flow settle
  return calls;
}

test("the native send-type menu offers the three types with a checkmark on the active one", async () => {
  const { window, editor } = mountEditor({ id: "r1", url: "http://x" });
  const calls = await pickSendType(window, editor, null); // dismissed

  assert.equal(calls.length, 1, "native menu was shown");
  const items = calls[0].items;
  assert.deepEqual(
    items.map((i) => i.id),
    ["immediate", "delayed", "interval"],
  );
  // Immediate is active by default → its item is checked, the others not.
  assert.equal(items.find((i) => i.id === "immediate").checked, true);
  assert.equal(items.find((i) => i.id === "delayed").checked, false);
  // Immediate carries no icon; delayed/interval do (a data URL when rasterised,
  // else undefined — the key is that immediate never gets one).
  assert.equal(items.find((i) => i.id === "immediate").iconDataUrl, undefined);
});

test("choosing Delayed sets the type and opens a dialog with only the delay field", async () => {
  const { window, editor } = mountEditor({ id: "r1", url: "http://x" });
  const changes = [];
  window.addEventListener("hippo:editor-setting-changed", (e) =>
    changes.push(e.detail),
  );

  await pickSendType(window, editor, "delayed");

  assert.ok(changes.some((c) => c.sendType === "delayed"));
  assert.ok(
    editor.element.querySelector(".req-send-btn .req-send-type-icon svg"),
    "button shows the delayed glyph",
  );

  const dialog = document.querySelector(".req-send-duration-dialog");
  assert.ok(dialog, "duration dialog opened");
  assert.equal(
    dialog.querySelectorAll(".req-send-type-duration-input").length,
    1,
    "delayed asks for the delay only",
  );

  // Editing the delay (seconds) persists milliseconds.
  const input = dialog.querySelector(".req-send-type-duration-input");
  input.value = "3";
  input.dispatchEvent(new window.Event("change", { bubbles: true }));
  assert.deepEqual(changes.at(-1), { sendDelayMs: 3000 });
});

test("choosing Interval opens a dialog with only the interval field", async () => {
  const { window, editor } = mountEditor({ id: "r1", url: "http://x" });
  const changes = [];
  window.addEventListener("hippo:editor-setting-changed", (e) =>
    changes.push(e.detail),
  );

  await pickSendType(window, editor, "interval");

  assert.ok(changes.some((c) => c.sendType === "interval"));
  const dialog = document.querySelector(".req-send-duration-dialog");
  assert.ok(dialog, "duration dialog opened");
  const inputs = dialog.querySelectorAll(".req-send-type-duration-input");
  assert.equal(inputs.length, 1, "interval asks for the interval only");

  // Default interval is 10s.
  assert.equal(inputs[0].value, "10");

  inputs[0].value = "12";
  inputs[0].dispatchEvent(new window.Event("change", { bubbles: true }));
  assert.deepEqual(changes.at(-1), { sendIntervalMs: 12000 });
});

test("loading another request cancels a schedule and resets the type to Immediate", () => {
  const { window, editor } = mountEditor({ id: "r1", url: "http://x/1" });
  editor.applySettings({ sendType: "interval", sendIntervalMs: 5000 });
  const sendBtn = editor.element.querySelector(".req-send-btn");
  assert.ok(
    sendBtn.querySelector(".req-send-type-icon"),
    "interval glyph shown before switching",
  );

  // Arm an interval countdown.
  sendBtn.click();
  assert.ok(
    sendBtn.classList.contains("req-send-btn--countdown"),
    "countdown running",
  );

  const changes = [];
  window.addEventListener("hippo:editor-setting-changed", (e) =>
    changes.push(e.detail),
  );

  // Switch to another request.
  editor.load({ id: "r2", url: "http://x/2" });

  assert.ok(
    !sendBtn.classList.contains("req-send-btn--countdown"),
    "countdown cancelled on request switch",
  );
  assert.equal(
    sendBtn.querySelector(".req-send-type-icon"),
    null,
    "send type reset to Immediate (no glyph)",
  );
  assert.ok(
    changes.some((c) => c.sendType === "immediate"),
    "reset persisted to settings",
  );
});

// ── Params / Headers CRUD, bulk mode, path params, URL preview ───────────────
//
// The Params/Headers tables render one `.params-row` per row. Name and value are
// `VariablePillEditor` instances (contentEditable divs, `.params-name` /
// `.params-value`); the enable toggle is `.params-checkbox`; delete is
// `.params-delete-btn`. A pill editor reads its value back from the DOM on every
// `input` event, so an edit is simulated by writing `.textContent` and firing a
// bubbling `input` — exactly what native typing does.

/** Drive a VariablePillEditor edit by writing text + firing its input event. */
function typeInPill(window, el, text) {
  el.textContent = text;
  el.dispatchEvent(new window.Event("input", { bubbles: true }));
}

/** Collect the latest `hippo:request-updated` detail matching a predicate. */
function captureRequestUpdates(window, pred = () => true) {
  const updates = [];
  window.addEventListener("hippo:request-updated", (e) => {
    if (pred(e.detail)) updates.push(e.detail);
  });
  return updates;
}

test("loading a request renders its params + headers rows with the right values", () => {
  const { editor } = mountEditor({
    id: "r",
    method: "GET",
    url: "https://api.example.com",
    params: [
      { name: "q", value: "hello", enabled: true },
      { name: "page", value: "2", enabled: false },
    ],
    headers: [{ name: "Accept", value: "application/json", enabled: true }],
  });

  const paramRows = editor.element.querySelectorAll(
    "#req-tab-params .params-row",
  );
  assert.equal(paramRows.length, 2, "two param rows rendered");
  assert.equal(paramRows[0].querySelector(".params-name").textContent, "q");
  assert.equal(
    paramRows[0].querySelector(".params-value").textContent,
    "hello",
  );
  // The disabled row carries the disabled modifier + an unchecked toggle.
  assert.ok(paramRows[1].classList.contains("params-row--disabled"));
  assert.equal(paramRows[1].querySelector(".params-checkbox").checked, false);

  const headerRows = editor.element.querySelectorAll(
    "#req-tab-headers .params-row",
  );
  assert.equal(headerRows.length, 1, "one header row rendered");
  // Header NAME is a plain input (combo-box), VALUE is a pill editor.
  assert.equal(headerRows[0].querySelector(".params-name").value, "Accept");
  assert.equal(
    headerRows[0].querySelector(".params-value").textContent,
    "application/json",
  );
});

test("an empty params/headers list shows the empty placeholder", () => {
  const { editor } = mountEditor({ id: "r", method: "GET", url: "https://x" });
  assert.ok(
    editor.element.querySelector("#req-tab-params .params-empty"),
    "params empty placeholder",
  );
  assert.ok(
    editor.element.querySelector("#req-tab-headers .params-empty"),
    "headers empty placeholder",
  );
});

test("the Add control appends a param row and edits dispatch request-updated", () => {
  const { window, editor } = mountEditor({
    id: "r",
    method: "GET",
    url: "https://x",
  });
  const updates = captureRequestUpdates(window, (d) => "params" in d);

  const addBtn = editor.element.querySelector(
    '#req-tab-params [aria-label="Add parameter"]',
  );
  assert.ok(addBtn, "Add parameter control present");
  addBtn.click();

  const rows = editor.element.querySelectorAll("#req-tab-params .params-row");
  assert.equal(rows.length, 1, "one row added");
  // Adding a row dispatches params with one (blank) entry.
  assert.ok(updates.length >= 1);
  assert.equal(updates.at(-1).params.length, 1);

  // Edit the new row's name + value via its pill editors.
  typeInPill(window, rows[0].querySelector(".params-name"), "token");
  typeInPill(window, rows[0].querySelector(".params-value"), "abc");

  const last = updates.at(-1);
  assert.equal(last.params[0].name, "token");
  assert.equal(last.params[0].value, "abc");
});

test("toggling a param row's checkbox flips enabled and re-dispatches", () => {
  const { window, editor } = mountEditor({
    id: "r",
    method: "GET",
    url: "https://x",
    params: [{ name: "a", value: "1", enabled: true }],
  });
  const updates = captureRequestUpdates(window, (d) => "params" in d);

  const cb = editor.element.querySelector(
    "#req-tab-params .params-row .params-checkbox",
  );
  assert.equal(cb.checked, true);
  cb.checked = false;
  cb.dispatchEvent(new window.Event("change", { bubbles: true }));

  assert.equal(updates.at(-1).params[0].enabled, false);
  assert.ok(
    editor.element
      .querySelector("#req-tab-params .params-row")
      .classList.contains("params-row--disabled"),
  );
});

test("deleting a param row removes it and dispatches the shorter list", () => {
  const { window, editor } = mountEditor({
    id: "r",
    method: "GET",
    url: "https://x",
    params: [
      { name: "a", value: "1", enabled: true },
      { name: "b", value: "2", enabled: true },
    ],
  });
  const updates = captureRequestUpdates(window, (d) => "params" in d);

  // wireDeleteConfirm uses a two-click inline confirm — click twice.
  const delBtn = editor.element.querySelector(
    "#req-tab-params .params-row .params-delete-btn",
  );
  delBtn.click();
  delBtn.click();

  const rows = editor.element.querySelectorAll("#req-tab-params .params-row");
  assert.equal(rows.length, 1, "one row left after delete");
  assert.equal(updates.at(-1).params.length, 1);
  assert.equal(updates.at(-1).params[0].name, "b");
});

test("a header value edit dispatches the updated headers list", () => {
  const { window, editor } = mountEditor({
    id: "r",
    method: "GET",
    url: "https://x",
    headers: [{ name: "Accept", value: "text/plain", enabled: true }],
  });
  const updates = captureRequestUpdates(window, (d) => "headers" in d);

  // Header name is a plain input; value is a pill editor.
  const row = editor.element.querySelector("#req-tab-headers .params-row");
  typeInPill(window, row.querySelector(".params-value"), "application/json");

  assert.equal(updates.at(-1).headers[0].value, "application/json");
  assert.equal(updates.at(-1).headers[0].name, "Accept");
});

test("Bulk Editor mode shows the rows as text and editing it syncs back to rows", () => {
  const { window, editor } = mountEditor({
    id: "r",
    method: "GET",
    url: "https://x",
    params: [
      { name: "a", value: "1", enabled: true },
      { name: "b", value: "2", enabled: false },
    ],
  });
  const updates = captureRequestUpdates(window, (d) => "params" in d);

  // The Bulk Editor toggle is the first toolbar checkbox in the params pane.
  const bulkToggle = editor.element.querySelector(
    "#req-tab-params .params-toolbar .params-toolbar-toggle",
  );
  bulkToggle.checked = true;
  bulkToggle.dispatchEvent(new window.Event("change", { bubbles: true }));

  const ta = editor.element.querySelector("#req-tab-params .body-text-editor");
  assert.ok(ta, "bulk textarea present");
  // Enabled rows are bare; disabled rows are "# "-prefixed.
  assert.equal(ta.value, "a=1\n# b=2");
  // The bulk textarea is shown and the KV list's wrapper is hidden.
  assert.equal(ta.style.display, "");
  assert.equal(
    editor.element.querySelector("#req-tab-params .params-list").parentElement
      .style.display,
    "none",
    "KV list hidden in bulk mode",
  );

  // Editing the textarea reparses into rows and dispatches them.
  ta.value = "x=9\ny=10";
  ta.dispatchEvent(new window.Event("input", { bubbles: true }));
  const last = updates.at(-1);
  assert.deepEqual(
    last.params.map((p) => [p.name, p.value, p.enabled]),
    [
      ["x", "9", true],
      ["y", "10", true],
    ],
  );
});

test("path params are derived from :id / {slug} URL tokens, query params kept separate", () => {
  const { editor } = mountEditor({
    id: "r",
    method: "GET",
    url: "https://api.example.com/users/:id/posts/{slug}",
    params: [{ name: "q", value: "x", enabled: true }],
  });

  // One query row + two path rows (the path rows carry the braces indicator).
  const pathNames = [
    ...editor.element.querySelectorAll(
      "#req-tab-params .params-row .path-param-name",
    ),
  ].map((i) => i.value);
  assert.deepEqual(pathNames, ["id", "slug"], "both path tokens derived");
  // Path rows show the path indicator instead of a checkbox.
  const pathIcons = editor.element.querySelectorAll(
    "#req-tab-params .path-param-icon",
  );
  assert.equal(pathIcons.length, 2);
  // The query param row is still present and toggleable.
  assert.ok(
    editor.element.querySelector("#req-tab-params .params-checkbox"),
    "query row keeps its checkbox",
  );
});

test("editing the URL re-derives the path-param rows", () => {
  const { window, editor } = mountEditor({
    id: "r",
    method: "GET",
    url: "https://x/items/:id",
  });
  assert.deepEqual(
    [
      ...editor.element.querySelectorAll("#req-tab-params .path-param-name"),
    ].map((i) => i.value),
    ["id"],
  );

  // The URL bar is a pill editor; drive an input to re-derive tokens.
  const urlEl = editor.element.querySelector(".req-url-input");
  typeInPill(window, urlEl, "https://x/items/:id/sub/:childId");

  assert.deepEqual(
    [
      ...editor.element.querySelectorAll("#req-tab-params .path-param-name"),
    ].map((i) => i.value),
    ["id", "childId"],
    "new token derived after URL edit",
  );
});

test("URL preview reflects the resolved URL with enabled query params when enabled", async () => {
  const { editor } = mountEditor(
    {
      id: "r",
      method: "GET",
      url: "https://api.example.com/{ver}/search",
      pathParams: [{ name: "ver", value: "v2" }],
      params: [
        { name: "q", value: "hi there", enabled: true },
        { name: "off", value: "x", enabled: false },
      ],
    },
    { environmentVariables: {}, folderChain: [] },
  );

  editor.applySettings({ showUrlPreview: true });
  // #updateUrlPreview resolves asynchronously; let the microtasks settle.
  await new Promise((r) => setTimeout(r, 0));

  const previewInput = editor.element.querySelector(".req-url-preview-input");
  assert.ok(previewInput, "preview input present");
  assert.ok(
    !editor.element
      .querySelector(".req-url-preview")
      .classList.contains("req-url-preview--hidden"),
    "preview bar shown when enabled",
  );
  // Path param substituted, enabled query encoded, disabled query omitted.
  assert.equal(
    previewInput.value,
    "https://api.example.com/v2/search?q=hi%20there",
  );
});

test("disabling the URL preview hides the preview bar", async () => {
  const { editor } = mountEditor({
    id: "r",
    method: "GET",
    url: "https://x",
  });
  editor.applySettings({ showUrlPreview: false });
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(
    editor.element
      .querySelector(".req-url-preview")
      .classList.contains("req-url-preview--hidden"),
    "preview bar hidden",
  );
});

// ── WebSocket message composer (Feature 32) ──────────────────────────────────

test("WebSocket Message tab exposes a format toggle that flips text ↔ json", () => {
  const { window, editor } = mountEditor({
    id: "w",
    protocol: "websocket",
    url: "wss://x",
    wsMessage: "{}",
    wsMessageFormat: "text",
  });
  const updates = captureRequestUpdates(window, (d) => "wsMessageFormat" in d);

  const fmt = editor.element.querySelector(
    "#req-tab-message .ws-composer-format",
  );
  assert.ok(fmt, "format toggle present");
  fmt.click();
  assert.equal(updates.at(-1).wsMessageFormat, "json", "flipped to json");
  fmt.click();
  assert.equal(updates.at(-1).wsMessageFormat, "text", "flipped back to text");
});

test("WebSocket subprotocols input updates state + dispatches", () => {
  const { window, editor } = mountEditor({
    id: "w",
    protocol: "websocket",
    url: "wss://x",
  });
  const updates = captureRequestUpdates(window, (d) => "wsSubprotocols" in d);

  const sub = editor.element.querySelector(
    "#req-tab-message .ws-composer-subproto",
  );
  assert.ok(sub, "subprotocols input present");
  sub.value = "graphql-ws, json";
  sub.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(updates.at(-1).wsSubprotocols, "graphql-ws, json");
});

test("the WebSocket composer Send button is disabled until the connection is open", () => {
  const { window, editor } = mountEditor({
    id: "w",
    protocol: "websocket",
    url: "wss://x",
  });
  const sendBtn = editor.element.querySelector(
    '#req-tab-message [aria-label="Send message"]',
  );
  assert.equal(sendBtn.disabled, true, "disabled while idle");
  window.dispatchEvent(
    new CustomEvent("hippo:ws-state", { detail: { state: "open" } }),
  );
  assert.equal(sendBtn.disabled, false, "enabled once open");
  window.dispatchEvent(
    new CustomEvent("hippo:ws-state", { detail: { state: "closed" } }),
  );
  assert.equal(sendBtn.disabled, true, "disabled again once closed");
});

// ── Tab visibility (Settings → Request) ──────────────────────────────────────

test("applySettings hides/shows the gated request tabs", () => {
  const { editor } = mountEditor({ id: "r", method: "GET", url: "https://x" });
  const tabHidden = (id) =>
    editor.element
      .querySelector(`.req-tab-btn[data-tab="${id}"]`)
      .classList.contains("req-tab-btn--hidden");

  editor.applySettings({
    showCapturesTab: true,
    showScriptsTab: true,
    showTestsTab: true,
    showNotesTab: true,
  });
  for (const id of ["captures", "scripts", "tests", "notes"])
    assert.equal(tabHidden(id), false, `${id} shown`);

  editor.applySettings({
    showCapturesTab: false,
    showScriptsTab: false,
    showTestsTab: false,
    showNotesTab: false,
  });
  for (const id of ["captures", "scripts", "tests", "notes"])
    assert.equal(tabHidden(id), true, `${id} hidden`);

  // Params / Headers / Body / Auth are never gated.
  for (const id of ["params", "headers", "body", "auth"])
    assert.equal(tabHidden(id), false, `${id} always visible`);
});

test("switching tabs activates the clicked tab and reveals its pane", () => {
  const { editor } = mountEditor({ id: "r", method: "GET", url: "https://x" });
  // Params is active by default.
  const headersBtn = editor.element.querySelector(
    '.req-tab-btn[data-tab="headers"]',
  );
  headersBtn.click();
  assert.ok(headersBtn.classList.contains("req-tab-btn--active"));
  assert.equal(headersBtn.getAttribute("aria-selected"), "true");
  assert.equal(
    editor.element.querySelector("#req-tab-headers").hidden,
    false,
    "headers pane shown",
  );
  assert.equal(
    editor.element.querySelector("#req-tab-params").hidden,
    true,
    "params pane hidden",
  );
});

// ── load() resets prior params/headers/path-params state ─────────────────────

test("loading a second request clears the previous params, headers and path params", () => {
  const { editor } = mountEditor({
    id: "r1",
    method: "GET",
    url: "https://x/items/:id",
    params: [{ name: "a", value: "1", enabled: true }],
    headers: [{ name: "Accept", value: "json", enabled: true }],
  });
  assert.equal(
    editor.element.querySelectorAll("#req-tab-params .params-row").length,
    2, // 1 query + 1 path
  );

  editor.load({ id: "r2", method: "POST", url: "https://y" });

  // The new request has no params/headers/path params → empty placeholders.
  assert.ok(editor.element.querySelector("#req-tab-params .params-empty"));
  assert.ok(editor.element.querySelector("#req-tab-headers .params-empty"));
  assert.equal(
    editor.element.querySelectorAll("#req-tab-params .path-param-name").length,
    0,
    "no path-param rows after switching to a token-free URL",
  );
  // The method selector reflects the new request.
  assert.equal(
    editor.element.querySelector(".req-method-select-label").textContent,
    "POST",
  );
});
