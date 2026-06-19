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

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { WebSocketServer } = require("ws");

const { WebSocketHub, normaliseSubprotocols } = require("../websocket.js");
const { makeProxyAgent } = require("../proxy.js");
const { SocksProxyAgent } = require("socks-proxy-agent");
const { HttpProxyAgent } = require("http-proxy-agent");
const { HttpsProxyAgent } = require("https-proxy-agent");

/** Poll `predicate` until truthy or the timeout elapses. */
function waitUntil(predicate, { timeout = 2000, interval = 10 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      let ok = false;
      try {
        ok = predicate();
      } catch (e) {
        return reject(e);
      }
      if (ok) return resolve();
      if (Date.now() - start > timeout) {
        return reject(new Error("waitUntil timed out"));
      }
      setTimeout(tick, interval);
    };
    tick();
  });
}

/** Start an in-process echo WebSocket server on an ephemeral port. */
async function startEchoServer() {
  const server = new WebSocketServer({ port: 0 });
  server.on("connection", (socket) => {
    socket.on("message", (data, isBinary) =>
      socket.send(data, { binary: isBinary }),
    );
  });
  await once(server, "listening");
  return { server, port: server.address().port };
}

describe("normaliseSubprotocols", () => {
  it("splits a comma/space separated string", () => {
    assert.deepEqual(normaliseSubprotocols("graphql-ws, json  chat"), [
      "graphql-ws",
      "json",
      "chat",
    ]);
  });

  it("trims array entries and drops empties", () => {
    assert.deepEqual(normaliseSubprotocols([" a ", "", "b"]), ["a", "b"]);
  });

  it("returns undefined when nothing is requested", () => {
    assert.equal(normaliseSubprotocols(""), undefined);
    assert.equal(normaliseSubprotocols([]), undefined);
    assert.equal(normaliseSubprotocols(undefined), undefined);
  });
});

describe("makeProxyAgent (shared agent selection)", () => {
  it("uses the SOCKS agent for any socks scheme, regardless of target", () => {
    assert.ok(
      makeProxyAgent("socks5://127.0.0.1:1080", false) instanceof
        SocksProxyAgent,
    );
    assert.ok(
      makeProxyAgent("socks5://127.0.0.1:1080", true) instanceof
        SocksProxyAgent,
    );
  });

  it("uses HttpProxyAgent for an insecure (ws://) target", () => {
    assert.ok(
      makeProxyAgent("http://127.0.0.1:8080", false) instanceof HttpProxyAgent,
    );
  });

  it("uses the CONNECT-tunnelling HttpsProxyAgent for a secure (wss://) target", () => {
    assert.ok(
      makeProxyAgent("http://127.0.0.1:8080", true) instanceof HttpsProxyAgent,
    );
  });
});

describe("WebSocketHub", () => {
  it("rejects an invalid scheme without registering a connection", () => {
    const hub = new WebSocketHub();
    const statuses = [];
    hub.open(
      "bad",
      { url: "http://example.com" },
      { onStatus: (s) => statuses.push(s), onMessage() {} },
    );
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0].state, "error");
    assert.equal(hub.size, 0);
  });

  it("returns a no-connection error for send/ping/close on an unknown id", () => {
    const hub = new WebSocketHub();
    assert.deepEqual(hub.send("x", "y"), {
      ok: false,
      reason: "no-connection",
    });
    assert.deepEqual(hub.ping("x"), { ok: false, reason: "no-connection" });
    assert.deepEqual(hub.close("x"), { ok: false, reason: "no-connection" });
  });

  it("connects, echoes a message, then closes and cleans up (no leak)", async () => {
    const { server, port } = await startEchoServer();
    const hub = new WebSocketHub();
    const statuses = [];
    const messages = [];
    const id = "conn-1";

    hub.open(
      id,
      { url: `ws://127.0.0.1:${port}` },
      {
        onStatus: (s) => statuses.push(s),
        onMessage: (m) => messages.push(m),
      },
    );

    await waitUntil(() => statuses.some((s) => s.state === "open"));
    assert.equal(hub.size, 1);

    assert.deepEqual(hub.send(id, "hello echo"), { ok: true });
    await waitUntil(() => messages.length > 0);
    assert.equal(messages[0].direction, "received");
    assert.equal(messages[0].binary, false);
    assert.equal(messages[0].data, "hello echo");

    hub.close(id, 1000, "done");
    await waitUntil(() => statuses.some((s) => s.state === "closed"));
    const closed = statuses.find((s) => s.state === "closed");
    assert.equal(closed.code, 1000);
    assert.equal(hub.size, 0, "registry empties on close — no leaked entry");

    server.close();
    await once(server, "close");
  });

  it("rejects an inbound message larger than the payload cap (no unbounded buffering)", async () => {
    // Server sends one frame just over the client's 16 MB maxPayload.
    const server = new WebSocketServer({ port: 0 });
    server.on("connection", (socket) => {
      socket.on("error", () => {}); // ignore send-side errors when the client bails
      socket.send(Buffer.alloc(17 * 1024 * 1024, 0x61));
    });
    await once(server, "listening");
    const port = server.address().port;

    const hub = new WebSocketHub();
    const statuses = [];
    const messages = [];
    try {
      hub.open(
        "big",
        { url: `ws://127.0.0.1:${port}` },
        {
          onStatus: (s) => statuses.push(s),
          onMessage: (m) => messages.push(m),
        },
      );

      // The oversized frame surfaces an error and tears the socket down; it is
      // never delivered as a message (the whole point — no unbounded buffering).
      // The close code is abnormal (1006) rather than a clean 1009, and varies
      // by ws version, so we assert the behaviour, not the code.
      await waitUntil(() => statuses.some((s) => s.state === "closed"));
      assert.equal(messages.length, 0, "oversized message is never delivered");
      assert.ok(
        statuses.some((s) => s.state === "error"),
        "an error is surfaced for the oversized frame",
      );
      assert.equal(hub.size, 0, "registry empties — no leaked entry");
    } finally {
      hub.closeAll();
      server.close();
      await once(server, "close").catch(() => {});
    }
  });

  it("send on a not-yet-open connection reports not-open", async () => {
    const { server, port } = await startEchoServer();
    const hub = new WebSocketHub();
    const id = "conn-2";
    hub.open(
      id,
      { url: `ws://127.0.0.1:${port}` },
      { onStatus() {}, onMessage() {} },
    );
    // Immediately after open() the socket is still CONNECTING.
    assert.deepEqual(hub.send(id, "early"), { ok: false, reason: "not-open" });
    hub.close(id);
    server.close();
    await once(server, "close");
  });

  it("closeAll terminates and clears every connection", async () => {
    const { server, port } = await startEchoServer();
    const hub = new WebSocketHub();
    const statuses = [];
    for (const id of ["a", "b"]) {
      hub.open(
        id,
        { url: `ws://127.0.0.1:${port}` },
        { onStatus: (s) => statuses.push(s), onMessage() {} },
      );
    }
    await waitUntil(
      () => statuses.filter((s) => s.state === "open").length === 2,
    );
    assert.equal(hub.size, 2);

    hub.closeAll();
    assert.equal(hub.size, 0, "closeAll empties the registry synchronously");

    server.close();
    await once(server, "close");
  });
});
