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
 * ws-handlers.test.js — the WebSocket connect/send/disconnect event-bus handlers
 * (Feature 32). A mock bus context + a stubbed window.hippo.ws exercise the
 * desktop-only guard, the connect happy path (registers a live connection +
 * mirrors state), the pre-registration terminal-status race, the open-failure
 * path, and send/disconnect with and without a live connection.
 */
"use strict";

import { resetDom } from "../../tests/jsdom-setup.js";

import { test } from "node:test";
import assert from "node:assert/strict";

import { installWsHandlers } from "../ws-handlers.js";

/** Let the async handlers (awaiting resolved stubs) run to completion. */
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A recording stand-in for a WsConsole. */
const makeConsole = () => ({
  statuses: [],
  frames: [],
  applyStatus(s) {
    this.statuses.push(s);
  },
  addFrame(f) {
    this.frames.push(f);
  },
  reset() {},
});

function setup({
  selectedId = "r1",
  settings = {},
  conn = null,
  pendingTerminal = null,
  openResult = { id: "sock1" },
  openThrows = false,
  sendResult = { ok: true },
  hippo = "electron", // "electron" | "web" | "no-ws"
} = {}) {
  resetDom();
  const states = [];
  window.addEventListener("hippo:ws-state", (e) => states.push(e.detail.state));

  const calls = { close: [], setPane: [], open: [], wsClose: [], liveIds: 0 };
  const guardConsole = makeConsole();
  let currentConsole = guardConsole;
  const wsConns = new Map();
  const wsPendingTerminal = new Map();
  if (pendingTerminal) wsPendingTerminal.set(openResult.id, pendingTerminal);

  const ws = {
    open: async (desc) => {
      calls.open.push(desc);
      if (openThrows) throw new Error("open failed");
      return openResult;
    },
    send: async () => sendResult,
    close: async (args) => {
      calls.wsClose.push(args);
    },
  };
  window.hippo =
    hippo === "electron"
      ? { isElectron: true, ws }
      : hippo === "web"
        ? { isElectron: false }
        : { isElectron: true }; // "no-ws"

  const ctx = {
    getSelectedNode: () => (selectedId ? { id: selectedId } : null),
    getSettings: () => settings,
    getWsConsole: () => currentConsole,
    getTreeView: () => ({ setWsLiveIds: () => calls.liveIds++ }),
    wsConns,
    wsPendingTerminal,
    closeWsConn: async (id) => calls.close.push(id),
    setResponsePane: (show, console) => {
      calls.setPane.push(show);
      if (console) currentConsole = console;
    },
    connForRequest: () => conn,
    getLiveRequestIds: () => new Set(wsConns.keys()),
    proxyDescriptorFields: (s) => ({ proxy: s.proxy ?? null }),
  };
  installWsHandlers(ctx);

  const fire = (type, detail) =>
    window.dispatchEvent(new CustomEvent(type, { detail }));
  return { ctx, calls, states, wsConns, guardConsole, fire };
}

// ── connect ────────────────────────────────────────────────────────────────────

test("ws-connect off desktop shows a desktop-only error and does not open a socket", async () => {
  const { calls, states, guardConsole, fire } = setup({ hippo: "web" });
  fire("hippo:ws-connect", { url: "wss://x/" });
  await tick();
  assert.equal(calls.open.length, 0, "no socket opened in a browser build");
  assert.deepEqual(states, ["error"]);
  assert.equal(guardConsole.statuses.at(-1).state, "error");
});

test("ws-connect opens the socket, mirrors state, and registers a live connection", async () => {
  const { calls, states, wsConns, fire } = setup({
    settings: { verifySsl: false, timeout: 5000, proxy: "p" },
  });
  fire("hippo:ws-connect", {
    url: "wss://x/",
    headers: { A: "1" },
    subprotocols: ["v1"],
  });
  await tick();

  assert.deepEqual(calls.close, ["r1"], "any prior connection is closed first");
  assert.deepEqual(
    calls.setPane,
    [true],
    "response pane switched to the WS console",
  );
  assert.ok(states.includes("connecting"));
  assert.equal(calls.open.length, 1);
  assert.deepEqual(calls.open[0], {
    url: "wss://x/",
    headers: { A: "1" },
    subprotocols: ["v1"],
    verifySsl: false,
    timeout: 5000,
    proxy: "p",
  });
  assert.ok(
    wsConns.has("sock1"),
    "the live connection is registered by socket id",
  );
  assert.equal(wsConns.get("sock1").requestId, "r1");
  assert.equal(calls.liveIds, 1, "tree WS-live ids refreshed");
});

test("ws-connect surfaces a terminal status that raced ahead of registration", async () => {
  const { wsConns, states, fire } = setup({
    pendingTerminal: { state: "error", message: "refused" },
  });
  fire("hippo:ws-connect", { url: "wss://x/" });
  await tick();
  assert.ok(
    !wsConns.has("sock1"),
    "no live connection registered for a dead socket",
  );
  assert.equal(
    states.at(-1),
    "error",
    "the pre-seen terminal state is surfaced",
  );
});

test("ws-connect reports an error when the socket fails to open", async () => {
  const { wsConns, states, fire } = setup({ openThrows: true });
  fire("hippo:ws-connect", { url: "wss://x/" });
  await tick();
  assert.equal(states.at(-1), "error");
  assert.equal(wsConns.size, 0, "no connection left registered on failure");
});

// ── send ─────────────────────────────────────────────────────────────────────

test("ws-send mirrors a sent frame into the connection's console on success", async () => {
  const console = makeConsole();
  const { fire } = setup({ conn: { id: "sock1", console } });
  fire("hippo:ws-send", { data: "hello" });
  await tick();
  assert.equal(console.frames.length, 1);
  assert.equal(console.frames[0].direction, "sent");
  assert.equal(console.frames[0].data, "hello");
});

test("ws-send shows a system status when the send fails", async () => {
  const console = makeConsole();
  const { fire } = setup({
    conn: { id: "sock1", console },
    sendResult: { ok: false, reason: "closed" },
  });
  fire("hippo:ws-send", { data: "hi" });
  await tick();
  assert.equal(console.frames.length, 0, "nothing mirrored on failure");
  assert.equal(console.statuses.at(-1).state, "system");
});

test("ws-send is a no-op with no live connection", async () => {
  const { calls, fire } = setup({ conn: null });
  fire("hippo:ws-send", { data: "hi" });
  await tick();
  assert.equal(calls.wsClose.length, 0);
});

// ── disconnect ─────────────────────────────────────────────────────────────────

test("ws-disconnect closes the socket with a normal (1000) code", async () => {
  const console = makeConsole();
  const conn = { id: "sock1", console, state: "open" };
  const { calls, states, fire } = setup({ conn });
  fire("hippo:ws-disconnect", {});
  await tick();
  assert.equal(conn.state, "closing");
  assert.equal(console.statuses.at(-1).state, "closing");
  assert.ok(states.includes("closing"));
  assert.deepEqual(calls.wsClose, [
    { id: "sock1", code: 1000, reason: "client" },
  ]);
});

test("ws-disconnect is a no-op with no live connection", async () => {
  const { calls, fire } = setup({ conn: null });
  fire("hippo:ws-disconnect", {});
  await tick();
  assert.equal(calls.wsClose.length, 0);
});
