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

// retry.js — request retry-policy normalisation and decision logic for the
// main-process HTTP execution path.
//
// Pure and dependency-free so the policy can be unit tested (see
// net/tests/retry.test.js). The actual retry loop (which awaits doRequest and
// sleeps between attempts) lives in main.js; it calls normalizeRetry() once,
// then retryReason()/backoffDelay() per attempt.
"use strict";

/** Clamp a finite number into [min, max], falling back to `dflt` if invalid. */
function clampNum(value, min, max, dflt) {
  const n = Number(value);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

// RFC 7231 §4.2.2 idempotent methods — re-issuing one cannot cause a second
// side effect, so it is safe to auto-retry after a network failure. POST, PATCH
// (and CONNECT) are NOT idempotent: a connection error or timeout may strike
// AFTER the request reached the server and was processed but the response was
// lost, so re-sending risks a duplicate write. Such methods are therefore not
// retried on a network failure unless the policy opts in (retryNonIdempotent).
// A server-signalled status retry (429/503/…) is allowed for any method — the
// server's response tells us it did not act on the request.
const IDEMPOTENT_METHODS = new Set([
  "GET",
  "HEAD",
  "PUT",
  "DELETE",
  "OPTIONS",
  "TRACE",
]);

/**
 * @param {string} method  HTTP method (any casing)
 * @returns {boolean} true for an RFC-idempotent method.
 */
function isIdempotentMethod(method) {
  return IDEMPOTENT_METHODS.has(String(method || "").toUpperCase());
}

/**
 * Parse the "retry on these HTTP status codes" field into a Set of integers.
 * Accepts an array of numbers or a comma/space separated string ("429, 503").
 * Only plausible HTTP status codes (100–599) are kept.
 *
 * @param {string|number[]} codes
 * @returns {Set<number>}
 */
function parseStatusCodes(codes) {
  const out = new Set();
  const add = (v) => {
    const n = parseInt(v, 10);
    if (Number.isInteger(n) && n >= 100 && n <= 599) out.add(n);
  };
  if (Array.isArray(codes)) {
    codes.forEach(add);
  } else if (typeof codes === "string") {
    codes.split(/[\s,]+/).forEach((s) => s && add(s));
  }
  return out;
}

/**
 * Normalise a raw retry-policy descriptor into a validated, clamped object, or
 * null when retries are disabled / would be a no-op (≤ 1 attempt). Returning
 * null lets the caller treat "no policy" and "disabled" identically.
 *
 * @param {object|null} policy
 * @returns {null | {
 *   maxAttempts: number, backoffMs: number, multiplier: number,
 *   maxDelayMs: number, onConnectionError: boolean, onTimeout: boolean,
 *   retryNonIdempotent: boolean, statusCodes: Set<number>
 * }}
 */
function normalizeRetry(policy) {
  if (!policy || typeof policy !== "object" || !policy.enabled) return null;

  const maxAttempts = clampNum(policy.maxAttempts, 1, 10, 3);
  const statusCodes = parseStatusCodes(policy.statusCodes);
  const onConnectionError = policy.onConnectionError !== false;
  const onTimeout = policy.onTimeout !== false;

  // Nothing to retry on, or only one attempt allowed → not a real policy.
  if (maxAttempts <= 1) return null;
  if (!onConnectionError && !onTimeout && statusCodes.size === 0) return null;

  return {
    maxAttempts: Math.round(maxAttempts),
    backoffMs: clampNum(policy.backoffMs, 0, 60000, 500),
    multiplier: clampNum(policy.multiplier, 1, 10, 2),
    maxDelayMs: clampNum(policy.maxDelayMs, 0, 600000, 10000),
    onConnectionError,
    onTimeout,
    // Opt-in (default off): also retry POST/PATCH/… on a network failure. Off by
    // default so a lost-response write isn't silently duplicated.
    retryNonIdempotent: policy.retryNonIdempotent === true,
    statusCodes,
  };
}

/**
 * True when a result is a timeout failure (status 0, timed-out error).
 *
 * Classification keys off the canonical `.code` discriminator (the HTTP path
 * stamps `result.error.code` with the Node error code), falling back to `.name`
 * for older/synthetic results that only carry a name.
 */
function isTimeoutResult(result) {
  const err = result && result.error;
  if (!err) return false;
  const kind = err.code || err.name;
  return kind === "ETIMEDOUT" || /timed out/i.test(err.message || "");
}

/**
 * Decide whether a finished attempt warrants a retry under `policy`, returning a
 * short human-readable reason (for the Console) or null to stop.
 *
 * @param {object} result  the resolved doRequest() result
 * @param {object} policy  a normalizeRetry() result (non-null)
 * @param {string} [method]  the request's HTTP method (for the idempotency gate)
 * @returns {string|null}
 */
function retryReason(result, policy, method) {
  if (!result || !policy) return null;

  // Network-level failure (no HTTP response). The request may already have
  // reached the server, so only retry when re-sending is safe: an idempotent
  // method, or the explicit retryNonIdempotent opt-in. (A server-signalled
  // status retry below is method-agnostic — the server told us it didn't act.)
  if (result.status === 0 && result.error) {
    if (!policy.retryNonIdempotent && !isIdempotentMethod(method)) return null;
    if (isTimeoutResult(result)) {
      return policy.onTimeout ? "timeout" : null;
    }
    if (policy.onConnectionError) {
      return `connection error (${result.error.code || result.error.name || "network"})`;
    }
    return null;
  }

  // HTTP response with a status the policy opts into retrying.
  if (result.status > 0 && policy.statusCodes.has(result.status)) {
    return `HTTP ${result.status}`;
  }
  return null;
}

/**
 * Parse a `Retry-After` header value into a delay in milliseconds, or null when
 * absent/invalid. Accepts both RFC 7231 §7.1.3 forms: delta-seconds ("120") and
 * an HTTP-date ("Wed, 21 Oct 2015 07:28:00 GMT"), the latter resolved relative
 * to `nowMs`. A past date or zero clamps to 0 (retry now), never negative.
 *
 * @param {string|undefined|null} value  the Retry-After header value
 * @param {number} nowMs                 current epoch ms (Date.now() at call site)
 * @returns {number|null}
 */
function parseRetryAfter(value, nowMs) {
  if (value == null) return null;
  const s = String(value).trim();
  if (s === "") return null;
  if (/^\d+$/.test(s)) return Number(s) * 1000; // delta-seconds
  // HTTP-date: an IMF-fixdate always carries alphabetic weekday/month/"GMT", so
  // require a letter before trusting Date.parse — otherwise junk like "1.5",
  // "-5", or a comma-folded duplicate ("3, 5") would be misread as a bogus date
  // instead of failing the "null when invalid" contract.
  if (!/[a-zA-Z]/.test(s)) return null;
  const when = Date.parse(s);
  if (Number.isNaN(when)) return null;
  return Math.max(0, when - nowMs);
}

/**
 * Delay (ms) before the next attempt. Honors a `Retry-After` header on the
 * just-failed response when present and valid — the server's own hint — using it
 * as a floor over the exponential backoff; otherwise falls back to backoff
 * alone. Always clamped to [0, maxDelayMs] so a large Retry-After can't stall the
 * client past the user's configured ceiling (it may then retry a little early).
 *
 * @param {object} policy            a normalizeRetry() result
 * @param {number} completedAttempt  1-based number of the attempt that failed
 * @param {object} [result]          the doRequest() result (for Retry-After)
 * @param {number} [nowMs=0]         current epoch ms (for HTTP-date Retry-After)
 * @returns {number}
 */
function retryDelay(policy, completedAttempt, result, nowMs = 0) {
  const base = backoffDelay(policy, completedAttempt);
  const after = parseRetryAfter(result?.headers?.["retry-after"], nowMs);
  if (after === null) return base;
  return Math.round(Math.min(policy.maxDelayMs, Math.max(base, after)));
}

/**
 * Exponential backoff delay (ms) to wait before the next attempt, capped at
 * maxDelayMs.
 *
 * @param {object} policy           a normalizeRetry() result
 * @param {number} completedAttempt the 1-based number of the attempt that just
 *   failed (1 → delay before the 2nd attempt)
 * @returns {number}
 */
function backoffDelay(policy, completedAttempt) {
  const exp = Math.max(0, completedAttempt - 1);
  const raw = policy.backoffMs * Math.pow(policy.multiplier, exp);
  return Math.round(Math.min(policy.maxDelayMs, raw));
}

module.exports = {
  normalizeRetry,
  retryReason,
  backoffDelay,
  retryDelay,
  parseRetryAfter,
  parseStatusCodes,
  isIdempotentMethod,
};
