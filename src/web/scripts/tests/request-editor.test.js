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
  editor.setVariableContext({ collectionVariables: {}, folderChain: [] });
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
function mountEditor(node, ctx = { collectionVariables: {}, folderChain: [] }) {
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
      collectionVariables: { host: "echo.example.com", tok: "secret123" },
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
    { collectionVariables: { name: "Ada" }, folderChain: [] },
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
