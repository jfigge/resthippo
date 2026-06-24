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
  retryDelay,
  parseRetryAfter,
  parseStatusCodes,
  isIdempotentMethod,
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

  // Network-error retries are gated on idempotency, so these pass an idempotent
  // method (GET); the idempotency gate itself is exercised below.
  it("retries a tagged timeout when onTimeout is set", () => {
    const r = { status: 0, error: { name: "ETIMEDOUT", message: "x" } };
    assert.equal(retryReason(r, policy, "GET"), "timeout");
  });

  it("classifies a timeout off the canonical .code field", () => {
    // The live HTTP path stamps result.error.code; classification must key off it.
    const r = { status: 0, error: { code: "ETIMEDOUT", message: "x" } };
    assert.equal(retryReason(r, policy, "GET"), "timeout");
  });

  it("classifies a connection error off the canonical .code field", () => {
    const r = { status: 0, error: { code: "ECONNREFUSED", message: "x" } };
    assert.match(
      retryReason(r, policy, "GET"),
      /connection error \(ECONNREFUSED\)/,
    );
  });

  it("recognises a timeout by message text", () => {
    const r = {
      status: 0,
      error: { name: "Error", message: "Request timed out after 30000ms" },
    };
    assert.equal(retryReason(r, policy, "GET"), "timeout");
  });

  it("retries connection errors", () => {
    const r = { status: 0, error: { name: "ECONNREFUSED", message: "x" } };
    assert.match(
      retryReason(r, policy, "GET"),
      /connection error \(ECONNREFUSED\)/,
    );
  });

  it("retries an opted-in status code", () => {
    assert.equal(retryReason({ status: 503 }, policy, "GET"), "HTTP 503");
  });

  it("does not retry a status code that is not opted in", () => {
    assert.equal(retryReason({ status: 500 }, policy, "GET"), null);
  });

  it("does not retry a successful response", () => {
    assert.equal(retryReason({ status: 200 }, policy, "GET"), null);
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
    assert.equal(retryReason(timeout, p, "GET"), "timeout");
    assert.equal(retryReason(conn, p, "GET"), null);
  });
});

describe("retryReason idempotency gate", () => {
  const policy = normalizeRetry({
    enabled: true,
    maxAttempts: 3,
    onConnectionError: true,
    onTimeout: true,
    statusCodes: "503",
  });
  const connErr = { status: 0, error: { code: "ECONNRESET", message: "x" } };
  const timeout = { status: 0, error: { code: "ETIMEDOUT", message: "x" } };

  it("retries network errors for idempotent methods", () => {
    for (const m of ["GET", "HEAD", "PUT", "DELETE", "OPTIONS", "get"]) {
      assert.match(retryReason(connErr, policy, m), /connection error/, m);
      assert.equal(retryReason(timeout, policy, m), "timeout", m);
    }
  });

  it("does NOT retry network errors for non-idempotent methods", () => {
    for (const m of ["POST", "PATCH", "post"]) {
      assert.equal(retryReason(connErr, policy, m), null, m);
      assert.equal(retryReason(timeout, policy, m), null, m);
    }
  });

  it("treats an unknown/missing method as non-idempotent (fails safe)", () => {
    assert.equal(retryReason(connErr, policy, undefined), null);
    assert.equal(retryReason(connErr, policy, "FROBNICATE"), null);
  });

  it("retries non-idempotent network errors when opted in", () => {
    const opted = normalizeRetry({
      enabled: true,
      maxAttempts: 3,
      onConnectionError: true,
      onTimeout: true,
      retryNonIdempotent: true,
      statusCodes: "503",
    });
    assert.match(retryReason(connErr, opted, "POST"), /connection error/);
    assert.equal(retryReason(timeout, opted, "POST"), "timeout");
  });

  it("still retries opted-in STATUS codes for non-idempotent methods", () => {
    // The server responded — it didn't act on the request — so a 503 retry is
    // safe regardless of method, even without the opt-in.
    assert.equal(retryReason({ status: 503 }, policy, "POST"), "HTTP 503");
    assert.equal(retryReason({ status: 503 }, policy, "PATCH"), "HTTP 503");
  });
});

describe("isIdempotentMethod", () => {
  it("recognises the RFC idempotent methods, case-insensitively", () => {
    for (const m of ["GET", "head", "PUT", "Delete", "OPTIONS", "TRACE"]) {
      assert.equal(isIdempotentMethod(m), true, m);
    }
  });
  it("rejects POST/PATCH/CONNECT and junk", () => {
    for (const m of ["POST", "PATCH", "CONNECT", "", undefined, null, 42]) {
      assert.equal(isIdempotentMethod(m), false, String(m));
    }
  });
});

describe("parseRetryAfter", () => {
  it("parses delta-seconds into milliseconds", () => {
    assert.equal(parseRetryAfter("120", 0), 120000);
    assert.equal(parseRetryAfter("0", 0), 0);
  });

  it("parses an HTTP-date relative to now, clamping a past date to 0", () => {
    const now = Date.parse("Wed, 21 Oct 2015 07:28:00 GMT");
    assert.equal(parseRetryAfter("Wed, 21 Oct 2015 07:28:05 GMT", now), 5000);
    assert.equal(parseRetryAfter("Wed, 21 Oct 2015 07:27:00 GMT", now), 0);
  });

  it("returns null for absent / blank / unparseable values", () => {
    assert.equal(parseRetryAfter(undefined, 0), null);
    assert.equal(parseRetryAfter(null, 0), null);
    assert.equal(parseRetryAfter("   ", 0), null);
    assert.equal(parseRetryAfter("soon", 0), null);
  });

  it("returns null for letterless garbage (not a bogus Date.parse result)", () => {
    // Without the letter guard these slip through Date.parse as junk dates.
    assert.equal(parseRetryAfter("1.5", 0), null);
    assert.equal(parseRetryAfter("-5", 0), null);
    assert.equal(parseRetryAfter("3, 5", 0), null); // comma-folded duplicate header
    assert.equal(parseRetryAfter("12:30", 0), null);
  });
});

describe("retryDelay", () => {
  const policy = normalizeRetry({
    enabled: true,
    maxAttempts: 5,
    backoffMs: 500,
    multiplier: 2,
    maxDelayMs: 10000,
  });

  it("falls back to exponential backoff when no Retry-After header", () => {
    assert.equal(retryDelay(policy, 1, { headers: {} }), 500);
    assert.equal(retryDelay(policy, 2, undefined), 1000);
  });

  it("honors Retry-After as a floor over the backoff", () => {
    const r = { status: 503, headers: { "retry-after": "3" } };
    assert.equal(retryDelay(policy, 1, r, 0), 3000); // 3s > 500ms backoff
  });

  it("never waits less than the computed backoff", () => {
    const r = { status: 503, headers: { "retry-after": "0" } };
    assert.equal(retryDelay(policy, 3, r, 0), 2000); // backoff 2s > 0
  });

  it("clamps a large Retry-After to maxDelayMs", () => {
    const r = { status: 503, headers: { "retry-after": "9999" } };
    assert.equal(retryDelay(policy, 1, r, 0), 10000);
  });
});

describe("normalizeRetry idempotency opt-in", () => {
  it("defaults retryNonIdempotent to false and passes through true", () => {
    const off = normalizeRetry({ enabled: true, maxAttempts: 2 });
    assert.equal(off.retryNonIdempotent, false);
    const on = normalizeRetry({
      enabled: true,
      maxAttempts: 2,
      retryNonIdempotent: true,
    });
    assert.equal(on.retryNonIdempotent, true);
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
