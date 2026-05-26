/**
 * auth/utils/state.js
 *
 * OAuth 2.0 state parameter — CSRF protection for authorization code and
 * implicit flows (RFC 6749 §10.12).
 *
 * Pending states are held in a module-level Map and expire after 10 minutes.
 * Each state is a 64-character cryptographically random hex string.
 */

"use strict";

/** Pending state entries: Map<state_string → { createdAt: number }> */
const _pending = new Map();

/** States expire after 10 minutes. */
const TTL_MS = 10 * 60 * 1_000;

/**
 * Generate and register a cryptographically secure state string.
 *
 * @returns {string} 64-hex-character random value
 */
export function generateState() {
  // Prune expired entries so _pending does not accumulate indefinitely.
  const now = Date.now();
  for (const [k, v] of _pending) {
    if (now - v.createdAt > TTL_MS) _pending.delete(k);
  }

  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const state = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  _pending.set(state, { createdAt: now });
  return state;
}

/**
 * Validate a state value received in an authorization callback.
 *
 * A state is valid only if it was previously returned by `generateState()` and
 * has not yet expired.  The entry is consumed (deleted) on the first successful
 * validation so it cannot be replayed.
 *
 * @param {string|null|undefined} state - Value from the callback URL
 * @returns {boolean}
 */
export function validateState(state) {
  if (!state || typeof state !== "string") return false;
  const entry = _pending.get(state);
  if (!entry) return false;
  _pending.delete(state);
  return Date.now() - entry.createdAt < TTL_MS;
}

/**
 * Discard a previously generated state without validating it.
 * Call this when the popup is cancelled before a callback arrives.
 *
 * @param {string} state
 */
export function discardState(state) {
  if (state) _pending.delete(state);
}

/**
 * Clear all pending states.
 * Useful for testing or when the user navigates away from the auth flow.
 */
export function clearAllStates() {
  _pending.clear();
}
