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

const { computeTiming, formatTiming } = require("../timing.js");

describe("computeTiming", () => {
  it("returns undefined without start/end", () => {
    assert.equal(computeTiming({}), undefined);
    assert.equal(computeTiming({ start: 0 }), undefined);
    assert.equal(computeTiming({ end: 5 }), undefined);
  });

  it("computes every phase for a fresh HTTPS connection", () => {
    // start=0, socket=2, lookup=12, connect=46, secure=91, response=211, end=219
    const t = computeTiming(
      {
        start: 0,
        socket: 2,
        lookup: 12,
        connect: 46,
        secure: 91,
        response: 211,
        end: 219,
      },
      { isHttps: true },
    );
    assert.deepEqual(t, {
      total: 219,
      dns: 10, // 12 - 2
      tcp: 34, // 46 - 12
      tls: 45, // 91 - 46
      ttfb: 120, // 211 - 91
      download: 8, // 219 - 211
    });
  });

  it("phases sum to ≈ total (within the pre-socket gap)", () => {
    const t = computeTiming(
      {
        start: 0,
        socket: 1,
        lookup: 11,
        connect: 40,
        secure: 80,
        response: 200,
        end: 210,
      },
      { isHttps: true },
    );
    const sum = t.dns + t.tcp + t.tls + t.ttfb + t.download;
    // The only unaccounted slice is start→socket (1ms here).
    assert.ok(
      t.total - sum >= 0 && t.total - sum <= 1,
      `gap was ${t.total - sum}`,
    );
  });

  it("omits TLS for plain HTTP", () => {
    const t = computeTiming(
      { start: 0, socket: 1, lookup: 6, connect: 20, response: 60, end: 70 },
      { isHttps: false },
    );
    assert.equal(t.tls, undefined);
    assert.equal(t.dns, 5);
    assert.equal(t.tcp, 14);
    assert.equal(t.ttfb, 40); // 60 - 20 (connect is the ready mark)
    assert.equal(t.download, 10);
  });

  it("reports only ttfb/download for a reused keep-alive socket", () => {
    // No lookup/connect/secure marks — connection was already open.
    const t = computeTiming(
      { start: 0, socket: 0, response: 50, end: 58 },
      { isHttps: true },
    );
    assert.deepEqual(t, { total: 58, ttfb: 50, download: 8 });
  });

  it("falls back to socket as the TCP start when DNS is skipped (IP host)", () => {
    const t = computeTiming(
      { start: 0, socket: 2, connect: 30, response: 90, end: 95 },
      { isHttps: false },
    );
    assert.equal(t.dns, undefined);
    assert.equal(t.tcp, 28); // 30 - 2 (socket)
  });

  it("drops phases whose marks are out of order (clock skew safety)", () => {
    const t = computeTiming(
      { start: 0, socket: 10, lookup: 5, connect: 30, response: 90, end: 95 },
      { isHttps: false },
    );
    assert.equal(t.dns, undefined); // lookup < socket
  });
});

describe("formatTiming", () => {
  it("returns [] for falsy or phase-less timing", () => {
    assert.deepEqual(formatTiming(undefined), []);
    assert.deepEqual(formatTiming(null), []);
    assert.deepEqual(formatTiming({}), []);
  });

  it("renders a header, one aligned row per present phase, and a total", () => {
    const lines = formatTiming({
      total: 219,
      dns: 10,
      tcp: 34,
      tls: 45,
      ttfb: 120,
      download: 8,
    });
    assert.equal(lines[0], "* Request timing:");
    assert.equal(lines.length, 7); // header + 5 phases + total
    // Every body line is curl-style and ends with the millisecond value.
    for (const line of lines.slice(1)) assert.match(line, /^\* {3}.+ \d+ ms$/);
    assert.ok(lines.some((l) => /DNS lookup/.test(l) && /10 ms$/.test(l)));
    assert.ok(lines.some((l) => /Total/.test(l) && /219 ms$/.test(l)));
    // Values are right-aligned to a common width (3 → "  8").
    assert.ok(lines.some((l) => /Content download {2,}8 ms$/.test(l)));
  });

  it("skips absent phases (reused connection → only ttfb/download/total)", () => {
    const lines = formatTiming({ total: 58, ttfb: 50, download: 8 });
    const body = lines.join("\n");
    assert.doesNotMatch(body, /DNS|TCP|TLS/);
    assert.match(body, /Waiting \(TTFB\)/);
    assert.match(body, /Total/);
  });
});
