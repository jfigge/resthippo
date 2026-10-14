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
 * A secret-free scheme://host[:port] view of a ws:// / wss:// URL for the
 * diagnostics log — strips userinfo, path, query and fragment (any of which can
 * carry an access token). Falls back to a placeholder on an unparseable URL.
 */
function redactWsUrl(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "(invalid URL)";
  }
}

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
    // Log only the host: this line is teed into the rotating diagnostics log
    // that Export Diagnostics bundles, so a `wss://user:pass@host` credential
    // or a `?access_token=…` query secret must never reach disk.
    console.log("[ws:open] →", redactWsUrl(opts.url));
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
