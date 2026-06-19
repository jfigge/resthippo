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

const {
  normalizeRetry,
  retryReason,
  backoffDelay,
  parseStatusCodes,
} = require("../retry.js");

describe("parseStatusCodes", () => {
  it("parses a comma/space string into a Set, dropping out-of-range values", () => {
    const s = parseStatusCodes("429, 503 700 abc 0");
    assert.deepEqual([...s].sort(), [429, 503]);
  });

  it("accepts an array of numbers", () => {
    assert.deepEqual([...parseStatusCodes([502, 504])].sort(), [502, 504]);
  });
});

describe("normalizeRetry", () => {
  it("returns null when disabled or absent", () => {
    assert.equal(normalizeRetry(null), null);
    assert.equal(normalizeRetry({ enabled: false, maxAttempts: 3 }), null);
  });

  it("returns null when maxAttempts <= 1", () => {
    assert.equal(normalizeRetry({ enabled: true, maxAttempts: 1 }), null);
  });

  it("returns null when no condition is selected", () => {
    const out = normalizeRetry({
      enabled: true,
      maxAttempts: 3,
      onConnectionError: false,
      onTimeout: false,
      statusCodes: "",
    });
    assert.equal(out, null);
  });

  it("clamps numeric fields into range and applies defaults", () => {
    const out = normalizeRetry({
      enabled: true,
      maxAttempts: 99,
      backoffMs: -5,
      multiplier: 100,
      maxDelayMs: 9e9,
    });
    assert.equal(out.maxAttempts, 10);
    assert.equal(out.backoffMs, 0);
    assert.equal(out.multiplier, 10);
    assert.equal(out.maxDelayMs, 600000);
    assert.equal(out.onConnectionError, true); // default on
    assert.equal(out.onTimeout, true);
  });

  it("parses statusCodes into a Set", () => {
    const out = normalizeRetry({
      enabled: true,
      maxAttempts: 2,
      onConnectionError: false,
      onTimeout: false,
      statusCodes: "503,504",
    });
    assert.ok(out.statusCodes.has(503));
    assert.ok(out.statusCodes.has(504));
  });
});

describe("retryReason", () => {
  const policy = normalizeRetry({
    enabled: true,
    maxAttempts: 3,
    onConnectionError: true,
    onTimeout: true,
    statusCodes: "503",
  });

  it("retries a tagged timeout when onTimeout is set", () => {
    const r = { status: 0, error: { name: "ETIMEDOUT", message: "x" } };
    assert.equal(retryReason(r, policy), "timeout");
  });

  it("classifies a timeout off the canonical .code field", () => {
    // The live HTTP path stamps result.error.code; classification must key off it.
    const r = { status: 0, error: { code: "ETIMEDOUT", message: "x" } };
    assert.equal(retryReason(r, policy), "timeout");
  });

  it("classifies a connection error off the canonical .code field", () => {
    const r = { status: 0, error: { code: "ECONNREFUSED", message: "x" } };
    assert.match(retryReason(r, policy), /connection error \(ECONNREFUSED\)/);
  });

  it("recognises a timeout by message text", () => {
    const r = {
      status: 0,
      error: { name: "Error", message: "Request timed out after 30000ms" },
    };
    assert.equal(retryReason(r, policy), "timeout");
  });

  it("retries connection errors", () => {
    const r = { status: 0, error: { name: "ECONNREFUSED", message: "x" } };
    assert.match(retryReason(r, policy), /connection error \(ECONNREFUSED\)/);
  });

  it("retries an opted-in status code", () => {
    assert.equal(retryReason({ status: 503 }, policy), "HTTP 503");
  });

  it("does not retry a status code that is not opted in", () => {
    assert.equal(retryReason({ status: 500 }, policy), null);
  });

  it("does not retry a successful response", () => {
    assert.equal(retryReason({ status: 200 }, policy), null);
  });

  it("respects disabled conditions", () => {
    const p = normalizeRetry({
      enabled: true,
      maxAttempts: 3,
      onConnectionError: false,
      onTimeout: true,
      statusCodes: "",
    });
    const timeout = { status: 0, error: { name: "ETIMEDOUT", message: "" } };
    const conn = { status: 0, error: { name: "ECONNRESET", message: "" } };
    assert.equal(retryReason(timeout, p), "timeout");
    assert.equal(retryReason(conn, p), null);
  });
});

describe("backoffDelay", () => {
  const policy = normalizeRetry({
    enabled: true,
    maxAttempts: 5,
    backoffMs: 500,
    multiplier: 2,
    maxDelayMs: 10000,
  });

  it("grows exponentially from the base delay", () => {
    assert.equal(backoffDelay(policy, 1), 500); // 500 * 2^0
    assert.equal(backoffDelay(policy, 2), 1000); // 500 * 2^1
    assert.equal(backoffDelay(policy, 3), 2000); // 500 * 2^2
  });

  it("caps at maxDelayMs", () => {
    assert.equal(backoffDelay(policy, 10), 10000);
  });
});
