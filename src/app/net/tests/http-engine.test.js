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
 * http-engine.test.js — characterization tests for the HTTP request engine.
 *
 * The engine (`doRequest` / `executeWithRetries`) is the heart of the app and,
 * historically, had no direct coverage: only its building blocks (proxy, retry,
 * tls, sse, timing) and the auth *computations* (digest/ntlm) were tested, never
 * the orchestration that ties them together — redirects, the 401 digest/NTLM
 * challenge-response retries, live streaming, and spill-to-disk.
 *
 * These tests pin that observable behaviour by driving the PUBLIC `http:execute`
 * IPC handler against throwaway local HTTP servers. They are deliberately
 * agnostic to whether the engine lives inline in main.js or in an extracted
 * module: the handler is the seam, so the same suite is the safety net for the
 * upcoming `net/http-engine.js` extraction — extract, re-run, expect green.
 *
 * Electron is unavailable under `node --test`, so we stub the (thin) Electron
 * surface main.js touches and require it once; the registered handlers are
 * captured as they register. No production code is modified.
 *
 * Run with:   node --test src/app/net/tests/http-engine.test.js
 */
"use strict";

const Module = require("module");
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const os = require("os");
const path = require("path");
const fs = require("fs");

const ntlm = require("../../auth/ntlm");

// ── Load main.js under a stubbed Electron, capturing its IPC handlers ─────────
const handlers = {};
const noop = () => {};
const userDataDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "resthippo-httpeng-"),
);

const electronStub = {
  app: {
    requestSingleInstanceLock: () => true,
    whenReady: () => new Promise(() => {}), // never resolves → no window is built
    on: noop,
    off: noop,
    quit: noop,
    setName: noop,
    setAppUserModelId: noop,
    getPath: () => userDataDir,
    getLocale: () => "en-US",
    getVersion: () => "0.0.0-test",
    getName: () => "Rest Hippo",
    setAboutPanelOptions: noop,
    commandLine: { appendSwitch: noop },
    isPackaged: false,
    dock: new Proxy({}, { get: () => noop }),
  },
  BrowserWindow: Object.assign(
    function () {
      return new Proxy({}, { get: () => noop });
    },
    {
      fromId: () => null,
      fromWebContents: () => null,
      getAllWindows: () => [],
    },
  ),
  WebContentsView: function () {
    return new Proxy({}, { get: () => noop });
  },
  ipcMain: {
    handle: (ch, fn) => {
      handlers[ch] = fn;
    },
    on: noop,
    removeHandler: noop,
  },
  shell: { openExternal: noop },
  Menu: Object.assign(
    function () {
      return new Proxy({}, { get: () => noop });
    },
    { setApplicationMenu: noop, buildFromTemplate: () => ({}) },
  ),
  dialog: {},
  nativeImage: { createFromPath: () => ({}), createFromBuffer: () => ({}) },
  session: {
    defaultSession: {
      setProxy: noop,
      webRequest: { onBeforeSendHeaders: noop },
    },
    fromPartition: () => ({ setProxy: noop }),
  },
  screen: {
    getPrimaryDisplay: () => ({ workAreaSize: { width: 1280, height: 800 } }),
    getAllDisplays: () => [],
  },
  crashReporter: { start: noop },
};

const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return electronStub;
  return origLoad.call(this, request, ...rest);
};
require("../../main.js");
Module._load = origLoad; // restore; main.js already captured its electron refs

test.after(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

const exec = handlers["http:execute"];
assert.equal(typeof exec, "function", "http:execute handler was captured");

// ── Helpers ───────────────────────────────────────────────────────────────────

/** A fake webContents sender that records every push (channel + payload). */
function makeSender() {
  const sends = [];
  return {
    id: 1,
    isDestroyed: () => false,
    send: (channel, payload) => sends.push({ channel, payload }),
    sends,
  };
}

/** Run `fn(baseUrl, server)` against a fresh local server, then close it. */
async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base, server);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

/** Invoke the engine; `useCookieJar:false` keeps it off the cookie store. */
function run(desc, sender = makeSender()) {
  return exec({ sender }, { headers: {}, useCookieJar: false, ...desc });
}

// ── Basic request / response ───────────────────────────────────────────────────

test("GET returns status, decoded body, lowercased headers, size and timing", async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain", "X-Custom": "yes" });
      res.end("hello world");
    },
    async (base) => {
      const r = await run({ method: "GET", url: `${base}/x` });
      assert.equal(r.status, 200);
      assert.equal(r.statusText, "OK");
      assert.equal(r.body, "hello world");
      assert.equal(r.headers["x-custom"], "yes");
      assert.equal(r.size, Buffer.byteLength("hello world"));
      assert.equal(typeof r.elapsed, "number");
      assert.ok(Array.isArray(r.consoleLog) && r.consoleLog.length > 0);
    },
  );
});

test("POST forwards the body and custom request headers", async () => {
  await withServer(
    (req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            method: req.method,
            got: body,
            xtest: req.headers["x-test"],
          }),
        );
      });
    },
    async (base) => {
      const r = await run({
        method: "POST",
        url: `${base}/echo`,
        headers: { "Content-Type": "application/json", "X-Test": "abc" },
        body: '{"a":1}',
      });
      assert.equal(r.status, 200);
      const got = JSON.parse(r.body);
      assert.equal(got.method, "POST");
      assert.equal(got.got, '{"a":1}');
      assert.equal(got.xtest, "abc");
    },
  );
});

// ── Redirects ───────────────────────────────────────────────────────────────────

test("follows a 302 redirect to the final resource", async () => {
  await withServer(
    (req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { Location: "/final" });
        return res.end();
      }
      res.writeHead(200, {});
      res.end(`arrived:${req.method}`);
    },
    async (base) => {
      const r = await run({ method: "GET", url: `${base}/start` });
      assert.equal(r.status, 200);
      assert.equal(r.body, "arrived:GET");
    },
  );
});

test("303 downgrades a POST to GET; 307/308 preserve the method AND body", async () => {
  // The final leg echoes both the method and the received body, so this pins the
  // body-preservation contract: a 307/308 must re-send the original body on the
  // redirected leg (regression guard — the body build must not be gated on the
  // redirect count), while a 303 downgrade to GET drops the body.
  await withServer(
    (req, res) => {
      if (req.url === "/r303") {
        res.writeHead(303, { Location: "/final" });
        return res.end();
      }
      if (req.url === "/r307") {
        res.writeHead(307, { Location: "/final" });
        return res.end();
      }
      if (req.url === "/r308") {
        res.writeHead(308, { Location: "/final" });
        return res.end();
      }
      let got = "";
      req.on("data", (c) => (got += c));
      req.on("end", () => {
        res.writeHead(200, {});
        res.end(`final:${req.method}:${got}`);
      });
    },
    async (base) => {
      const a = await run({ method: "POST", url: `${base}/r303`, body: "x" });
      assert.equal(a.body, "final:GET:", "303 → GET drops the body");

      const b = await run({
        method: "POST",
        url: `${base}/r307`,
        body: "keepme",
      });
      assert.equal(
        b.body,
        "final:POST:keepme",
        "307 must preserve the POST method and re-send the body",
      );

      const c = await run({
        method: "PUT",
        url: `${base}/r308`,
        body: "keepme",
      });
      assert.equal(
        c.body,
        "final:PUT:keepme",
        "308 must preserve the PUT method and re-send the body",
      );
    },
  );
});

test("followRedirects:false surfaces the 3xx itself", async () => {
  await withServer(
    (req, res) => {
      res.writeHead(302, { Location: "/elsewhere" });
      res.end();
    },
    async (base) => {
      const r = await run({
        method: "GET",
        url: `${base}/start`,
        followRedirects: false,
      });
      assert.equal(r.status, 302);
      assert.equal(r.headers.location, "/elsewhere");
    },
  );
});

test("a redirect loop stops at maxRedirects with a RedirectError", async () => {
  await withServer(
    (req, res) => {
      res.writeHead(302, { Location: "/loop" });
      res.end();
    },
    async (base) => {
      const r = await run({
        method: "GET",
        url: `${base}/loop`,
        maxRedirects: 3,
      });
      assert.equal(r.status, 302);
      assert.equal(r.error?.name, "RedirectError");
    },
  );
});

test("a cross-origin redirect drops the Authorization and Cookie headers", async () => {
  let bAuth = "unset";
  let bCookie = "unset";
  await withServer(
    (req, res) => {
      // Destination origin (different port → different origin).
      bAuth = req.headers.authorization ?? null;
      bCookie = req.headers.cookie ?? null;
      res.writeHead(200, {});
      res.end("arrived");
    },
    async (baseB) => {
      await withServer(
        (req, res) => {
          res.writeHead(302, { Location: `${baseB}/end` });
          res.end();
        },
        async (baseA) => {
          const r = await run({
            method: "GET",
            url: `${baseA}/start`,
            headers: { Authorization: "Bearer secret", Cookie: "s=1" },
          });
          assert.equal(r.body, "arrived");
          assert.equal(bAuth, null, "Authorization not replayed cross-origin");
          assert.equal(bCookie, null, "Cookie not replayed cross-origin");
        },
      );
    },
  );
});

test("a same-origin redirect keeps the Authorization header", async () => {
  let endAuth = "unset";
  await withServer(
    (req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { Location: "/end" });
        return res.end();
      }
      endAuth = req.headers.authorization ?? null;
      res.writeHead(200, {});
      res.end("ok");
    },
    async (base) => {
      const r = await run({
        method: "GET",
        url: `${base}/start`,
        headers: { Authorization: "Bearer secret" },
      });
      assert.equal(r.body, "ok");
      assert.equal(endAuth, "Bearer secret", "Authorization kept same-origin");
    },
  );
});

test("credential request headers are redacted in the verbose console", async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, {});
      res.end("x");
    },
    async (base) => {
      const r = await run({
        method: "GET",
        url: `${base}/x`,
        headers: { Authorization: "Bearer supersecret", Cookie: "sess=abc" },
      });
      const log = r.consoleLog.join("\n");
      assert.ok(!log.includes("supersecret"), "bearer token not in console");
      assert.ok(!log.includes("sess=abc"), "cookie value not in console");
      assert.match(log, /> Authorization: <redacted>/, "authorization masked");
      assert.match(log, /> Cookie: <redacted>/, "cookie masked");
    },
  );
});

// ── Digest auth (RFC 2617 / 7616) one-shot retry ───────────────────────────────

test("answers a Digest 401 by recomputing Authorization and retrying once", async () => {
  let sawDigestAuth = false;
  await withServer(
    (req, res) => {
      const auth = req.headers.authorization || "";
      if (!/^Digest /i.test(auth)) {
        res.writeHead(401, {
          "WWW-Authenticate":
            'Digest realm="test", qop="auth", nonce="abc123", opaque="zz"',
        });
        return res.end("challenge");
      }
      sawDigestAuth = /username="user"/.test(auth) && /response="/.test(auth);
      res.writeHead(200, {});
      res.end("secret");
    },
    async (base) => {
      const r = await run({
        method: "GET",
        url: `${base}/digest`,
        authDigest: { username: "user", password: "pw" },
      });
      assert.equal(r.status, 200);
      assert.equal(r.body, "secret");
      assert.ok(sawDigestAuth, "retry carried Digest credentials");
    },
  );
});

test("a persistently-rejecting Digest server surfaces the 401 without looping", async () => {
  let hits = 0;
  await withServer(
    (req, res) => {
      hits++;
      res.writeHead(401, {
        "WWW-Authenticate": 'Digest realm="t", qop="auth", nonce="n"',
      });
      res.end("nope");
    },
    async (base) => {
      const r = await run({
        method: "GET",
        url: `${base}/digest`,
        authDigest: { username: "user", password: "bad" },
      });
      assert.equal(r.status, 401);
      assert.equal(
        hits,
        2,
        "exactly one retry — the _digestRetried guard holds",
      );
    },
  );
});

// ── NTLM (MS-NLMP) negotiate → challenge → response ────────────────────────────

test("completes an NTLM Type1→Type2→Type3 handshake on the same connection", async () => {
  const type2 = buildType2();
  let sawType1 = false;
  let sawType3 = false;
  await withServer(
    (req, res) => {
      const auth = req.headers.authorization || "";
      const blob = auth.startsWith("NTLM ") ? auth.slice(5) : "";
      const msgType = blob ? Buffer.from(blob, "base64").readUInt32LE(8) : null;
      if (msgType === 1) {
        sawType1 = true;
        res.writeHead(401, { "WWW-Authenticate": `NTLM ${type2}` });
        return res.end("challenge");
      }
      if (msgType === 3) {
        sawType3 = true;
        res.writeHead(200, {});
        return res.end("authed");
      }
      res.writeHead(401, { "WWW-Authenticate": "NTLM" });
      res.end("need-ntlm");
    },
    async (base) => {
      const r = await run({
        method: "GET",
        url: `${base}/ntlm`,
        authNtlm: { username: "u", password: "p", domain: "D" },
      });
      assert.equal(r.status, 200);
      assert.equal(r.body, "authed");
      assert.ok(sawType1, "negotiate (Type 1) leg was sent");
      assert.ok(sawType3, "authenticate (Type 3) leg was sent");
    },
  );
});

/** A minimal well-formed NTLMSSP Type 2 challenge (mirrors auth/tests/ntlm). */
function buildType2() {
  const targetName = Buffer.from("Domain", "utf16le");
  const targetInfo = Buffer.alloc(4); // a single AV_EOL terminator
  const HEADER = 48;
  const tnOff = HEADER;
  const tiOff = HEADER + targetName.length;
  const buf = Buffer.alloc(tiOff + targetInfo.length);
  Buffer.from("NTLMSSP\0", "latin1").copy(buf, 0);
  buf.writeUInt32LE(2, 8);
  buf.writeUInt16LE(targetName.length, 12);
  buf.writeUInt16LE(targetName.length, 14);
  buf.writeUInt32LE(tnOff, 16);
  buf.writeUInt32LE(
    ntlm.FLAGS.NEGOTIATE_UNICODE |
      ntlm.FLAGS.NEGOTIATE_NTLM |
      ntlm.FLAGS.NEGOTIATE_TARGET_INFO |
      ntlm.FLAGS.NEGOTIATE_EXTENDED_SESSIONSECURITY,
    20,
  );
  Buffer.from("0123456789abcdef", "latin1").copy(buf, 24, 0, 8);
  buf.writeUInt16LE(targetInfo.length, 40);
  buf.writeUInt16LE(targetInfo.length, 42);
  buf.writeUInt32LE(tiOff, 44);
  targetName.copy(buf, tnOff);
  targetInfo.copy(buf, tiOff);
  return buf.toString("base64");
}

// ── Failure paths ──────────────────────────────────────────────────────────────

test("a refused connection resolves as status 0 with an error object", async () => {
  // Bind+close a server to obtain a definitely-free port, then connect to it.
  const port = await withServer(noop, (_base, server) => server.address().port);
  const r = await run({ method: "GET", url: `http://127.0.0.1:${port}/` });
  assert.equal(r.status, 0);
  assert.ok(r.error && r.error.message, "carries an error object");
});

test("an unparseable URL resolves as status 0 / TypeError", async () => {
  const r = await run({ method: "GET", url: "ht!tp://%%%not a url" });
  assert.equal(r.status, 0);
  assert.equal(r.error?.name, "TypeError");
});

// ── Live streaming (Feature 33) ────────────────────────────────────────────────

test("an SSE response early-resolves a streaming marker and pushes events", async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: one\n\n");
      res.write("data: two\n\n");
      setTimeout(() => res.end(), 20);
    },
    async (base) => {
      const sender = makeSender();
      const r = await run(
        { method: "GET", url: `${base}/sse`, streamCapable: true },
        sender,
      );
      assert.equal(r.streaming, true);
      assert.ok(r.streamId, "carries a streamId");

      // Wait for the stream to finish flushing to the (fake) renderer.
      await waitFor(() =>
        sender.sends.some((s) => s.channel === "http:stream:end"),
      );
      const channels = sender.sends.map((s) => s.channel);
      assert.ok(channels.includes("http:stream:data"), "data was pushed");
      assert.ok(channels.includes("http:stream:end"), "end was pushed");
    },
  );
});

// ── Spill-to-disk for large bodies ─────────────────────────────────────────────

test("a >8MB body spills to disk and is redeemable via http:body:get", async () => {
  const big = "a".repeat(9 * 1024 * 1024); // above the 8MB spill threshold
  await withServer(
    (req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(big);
    },
    async (base) => {
      const r = await run({ method: "GET", url: `${base}/big` });
      assert.equal(r.status, 200);
      assert.ok(r.bodyRef, "a spill ref is returned");
      assert.ok(
        r.body.length < big.length,
        "only a bounded preview crosses inline",
      );
      const full = await handlers["http:body:get"]({}, r.bodyRef);
      assert.equal(full.size, big.length);
      assert.equal(full.body.length, big.length, "full body is redeemable");
    },
  );
});

/** Poll `pred` up to `timeoutMs`, resolving once it is truthy. */
async function waitFor(pred, timeoutMs = 1000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
