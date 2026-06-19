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

// websocket.js — main-process WebSocket client hub (Feature 32).
//
// The renderer is sandboxed and cannot open raw sockets, so every ws://wss://
// connection lives here in the main process — mirroring how http:execute owns
// outgoing HTTP. The hub keeps a registry of live connections keyed by an opaque
// id; main.js bridges the renderer's ws:open/ws:send/ws:close/ws:ping invocations
// to these methods and streams status + frames back over the ws:status/ws:message
// push channels.
//
// Proxy and TLS settings are honored exactly as the HTTP path honors them: the
// shared makeProxyAgent() (net/proxy.js) selects the SOCKS / HTTP / HTTPS-CONNECT
// agent, and rejectUnauthorized carries the "Verify SSL" setting. Auth headers
// (e.g. bearer) are resolved in the renderer and arrive pre-built in opts.headers,
// just like the handshake of any other request.
"use strict";

const WebSocket = require("ws");
const { URL } = require("url");
const {
  withProxyCredentials,
  hostBypassesProxy,
  makeProxyAgent,
} = require("./proxy");

/** Monotonic-ish timestamp for frame ordering; ms since epoch is plenty. */
function now() {
  return Date.now();
}

/**
 * Normalise a subprotocol spec (comma/space separated string or array) into the
 * array `ws` expects, or undefined when none are requested.
 *
 * @param {string|string[]|undefined} sub
 * @returns {string[]|undefined}
 */
function normaliseSubprotocols(sub) {
  let list;
  if (Array.isArray(sub)) list = sub;
  else if (typeof sub === "string") list = sub.split(/[\s,]+/);
  else return undefined;
  list = list.map((s) => String(s).trim()).filter(Boolean);
  return list.length ? list : undefined;
}

class WebSocketHub {
  constructor() {
    /** @type {Map<string, { ws: WebSocket, senderId: number|null }>} */
    this._conns = new Map();
  }

  /** Number of live connections — used by tests to assert no leaks. */
  get size() {
    return this._conns.size;
  }

  /** Whether a connection with `id` is currently registered. */
  has(id) {
    return this._conns.has(id);
  }

  /**
   * Open a new WebSocket connection registered under `id`.
   *
   * Status and inbound frames are delivered through the supplied callbacks
   * (never thrown): `onStatus(state)` for lifecycle transitions and system
   * events, `onMessage(frame)` for received data frames. The method itself does
   * not throw — a bad URL or immediate failure is reported via onStatus("error").
   *
   * @param {string} id
   * @param {{
   *   url: string,
   *   headers?: object,
   *   subprotocols?: string|string[],
   *   verifySsl?: boolean,
   *   proxy?: string|null,
   *   proxyUsername?: string,
   *   proxyPassword?: string,
   *   proxyBypass?: string,
   *   timeout?: number,
   *   senderId?: number,
   * }} opts
   * @param {{ onStatus: (s: object) => void, onMessage: (f: object) => void }} handlers
   */
  open(id, opts, handlers) {
    const onStatus = handlers?.onStatus ?? (() => {});
    const onMessage = handlers?.onMessage ?? (() => {});
    const {
      url,
      headers = {},
      subprotocols,
      verifySsl = true,
      proxy = null,
      proxyUsername = "",
      proxyPassword = "",
      proxyBypass = "",
      timeout = 30000,
      senderId = null,
    } = opts || {};

    // ── Validate / classify the target URL ─────────────────────────────────
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      onStatus({
        state: "error",
        message: `Invalid URL: ${e.message}`,
        ts: now(),
      });
      return;
    }
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      onStatus({
        state: "error",
        message: `Unsupported scheme "${parsed.protocol}" — use ws:// or wss://`,
        ts: now(),
      });
      return;
    }
    const isSecure = parsed.protocol === "wss:";
    const port = parsed.port ? parseInt(parsed.port, 10) : isSecure ? 443 : 80;

    // ── Build connection options (TLS + proxy honored as for HTTP) ─────────
    const wsOptions = {
      headers,
      handshakeTimeout: timeout,
      rejectUnauthorized: verifySsl !== false,
    };
    if (proxy) {
      if (hostBypassesProxy(parsed.hostname, port, proxyBypass)) {
        onStatus({
          state: "system",
          message: `Bypassing proxy for ${parsed.hostname} (matches no-proxy list)`,
          ts: now(),
        });
      } else {
        try {
          const effectiveProxyUrl = withProxyCredentials(
            proxy,
            proxyUsername,
            proxyPassword,
          );
          wsOptions.agent = makeProxyAgent(effectiveProxyUrl, isSecure);
        } catch (e) {
          onStatus({
            state: "system",
            message: `Invalid proxy configuration: ${e.message}`,
            ts: now(),
          });
        }
      }
    }

    // ── Create the socket ──────────────────────────────────────────────────
    let ws;
    try {
      ws = new WebSocket(url, normaliseSubprotocols(subprotocols), wsOptions);
    } catch (e) {
      onStatus({ state: "error", message: e.message, ts: now() });
      return;
    }

    this._conns.set(id, { ws, senderId });

    ws.on("open", () => {
      onStatus({
        state: "open",
        protocol: ws.protocol || "",
        ts: now(),
      });
    });

    ws.on("message", (data, isBinary) => {
      // `ws` hands us a Buffer (or array of Buffers in fragmented edge cases).
      const buf = Array.isArray(data) ? Buffer.concat(data) : data;
      onMessage({
        direction: "received",
        binary: !!isBinary,
        data: isBinary ? buf.toString("base64") : buf.toString("utf8"),
        size: buf.length,
        ts: now(),
      });
    });

    ws.on("ping", () => {
      onStatus({ state: "system", message: "← ping", ts: now() });
    });
    ws.on("pong", () => {
      onStatus({ state: "system", message: "← pong", ts: now() });
    });

    // A non-101 handshake (e.g. 401) lands here because a listener is present;
    // ws would otherwise raise it as a generic error. Surface the status code,
    // tear down the half-open request, and clean up — no close event follows.
    ws.on("unexpected-response", (req, res) => {
      onStatus({
        state: "error",
        code: res.statusCode,
        message:
          `Handshake rejected: ${res.statusCode} ${res.statusMessage || ""}`.trim(),
        ts: now(),
      });
      try {
        req.destroy();
      } catch {
        /* best-effort */
      }
      this._cleanup(id);
    });

    ws.on("error", (err) => {
      // Report the error; the subsequent "close" performs the cleanup. (For an
      // unexpected-response we already cleaned up and removed listeners, so this
      // won't double-fire.)
      onStatus({ state: "error", message: err.message, ts: now() });
    });

    ws.on("close", (code, reasonBuf) => {
      this._cleanup(id);
      onStatus({
        state: "closed",
        code,
        reason: reasonBuf ? reasonBuf.toString("utf8") : "",
        ts: now(),
      });
    });
  }

  /**
   * Send a text frame on connection `id`.
   * @returns {{ ok: boolean, reason?: string }}
   */
  send(id, data) {
    const entry = this._conns.get(id);
    if (!entry) return { ok: false, reason: "no-connection" };
    if (entry.ws.readyState !== WebSocket.OPEN) {
      return { ok: false, reason: "not-open" };
    }
    try {
      entry.ws.send(typeof data === "string" ? data : String(data ?? ""));
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  /**
   * Send a ping frame on connection `id`.
   * @returns {{ ok: boolean, reason?: string }}
   */
  ping(id) {
    const entry = this._conns.get(id);
    if (!entry) return { ok: false, reason: "no-connection" };
    try {
      entry.ws.ping();
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  /**
   * Begin closing connection `id`. The actual teardown + "closed" status arrive
   * via the socket's close event. A still-connecting socket is terminated so a
   * stuck handshake can't linger.
   *
   * @returns {{ ok: boolean, reason?: string }}
   */
  close(id, code, reason) {
    const entry = this._conns.get(id);
    if (!entry) return { ok: false, reason: "no-connection" };
    const { ws } = entry;
    try {
      if (ws.readyState === WebSocket.CONNECTING) {
        ws.terminate(); // emits "close" → _cleanup
      } else {
        ws.close(code ?? 1000, reason ?? "");
      }
      return { ok: true };
    } catch (e) {
      // Force the socket down so the registry can't leak on a malformed close.
      try {
        ws.terminate();
      } catch {
        /* best-effort */
      }
      return { ok: false, reason: e.message };
    }
  }

  /** Terminate and unregister every connection owned by a given webContents. */
  closeForSender(senderId) {
    for (const [id, entry] of this._conns) {
      if (entry.senderId === senderId) {
        try {
          entry.ws.terminate();
        } catch {
          /* best-effort */
        }
        this._cleanup(id);
      }
    }
  }

  /** Terminate and unregister every connection (app shutdown). */
  closeAll() {
    for (const [id, entry] of this._conns) {
      try {
        entry.ws.terminate();
      } catch {
        /* best-effort */
      }
      this._cleanup(id);
    }
  }

  /**
   * Detach all listeners and drop the registry entry. Idempotent: safe to call
   * from the close handler and again from closeForSender/closeAll. Removing the
   * listeners is what guarantees no handler closures outlive the socket.
   */
  _cleanup(id) {
    const entry = this._conns.get(id);
    if (!entry) return;
    try {
      entry.ws.removeAllListeners();
    } catch {
      /* best-effort */
    }
    this._conns.delete(id);
  }
}

module.exports = { WebSocketHub, normaliseSubprotocols };
