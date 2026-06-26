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
 * ipc/websocket.js — WebSocket IPC (Feature 32).
 *
 * Extracted verbatim (behaviour-preserving) from main.js's initWebSocketIPC.
 * Owns every live ws://wss:// connection in the main process — the sandboxed
 * renderer can't open raw sockets. Connections are driven by the request/reply
 * channels ws:open / ws:send / ws:close / ws:ping and stream their lifecycle +
 * inbound frames back over the ws:status / ws:message push channels. Proxy and
 * TLS settings are honored exactly as on the HTTP path (see net/websocket.js).
 */
"use strict";

const { WebSocketHub } = require("../net/websocket");
const io = require("../store/io");

/**
 * @param {object} deps
 * @param {Electron.IpcMain} deps.ipcMain
 * @param {Electron.App} deps.app
 */
function registerWebSocketIPC({ ipcMain, app }) {
  const hub = new WebSocketHub();

  /** Push to a renderer only while its webContents is still alive. */
  function sendTo(sender, channel, payload) {
    if (sender && !sender.isDestroyed()) {
      sender.send(channel, payload);
    }
  }

  // Open a connection. Returns an opaque id the renderer uses for subsequent
  // send/close/ping calls and to demultiplex the ws:status / ws:message pushes.
  ipcMain.handle("ws:open", (event, opts = {}) => {
    const id = io.newUUID();
    const sender = event.sender;
    console.log("[ws:open] →", opts.url);
    hub.open(
      id,
      { ...opts, senderId: sender.id },
      {
        onStatus: (status) => sendTo(sender, "ws:status", { id, ...status }),
        onMessage: (frame) => sendTo(sender, "ws:message", { id, ...frame }),
      },
    );
    return { id };
  });

  ipcMain.handle("ws:send", (_event, { id, data } = {}) => hub.send(id, data));

  ipcMain.handle("ws:close", (_event, { id, code, reason } = {}) =>
    hub.close(id, code, reason),
  );

  ipcMain.handle("ws:ping", (_event, { id } = {}) => hub.ping(id));

  // ── Lifecycle cleanup — never leak a socket past its renderer ──────────────
  // A reload (did-navigate) or a destroyed/crashed webContents drops every
  // connection that renderer owned; quitting drops them all.
  app.on("web-contents-created", (_e, contents) => {
    const drop = () => hub.closeForSender(contents.id);
    contents.on("did-navigate", drop); // full reload (incl. dev hot-reload)
    contents.on("render-process-gone", drop);
    contents.on("destroyed", drop);
  });
  app.on("before-quit", () => hub.closeAll());
}

module.exports = { registerWebSocketIPC };
