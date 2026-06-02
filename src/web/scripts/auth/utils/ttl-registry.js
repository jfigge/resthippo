/**
 * auth/utils/ttl-registry.js
 *
 * Single-use, expiring random-token registry shared by the OAuth `state` (CSRF
 * protection, RFC 6749 §10.12) and OIDC `nonce` (id_token replay protection,
 * OIDC Core §3.2.2.1) mechanisms. Both need exactly the same lifecycle: mint a
 * 64-hex-character cryptographically random value, hold it until a callback
 * arrives, validate-and-consume it once, and expire anything older than the TTL.
 *
 * Each createTtlRegistry() call owns an independent Map, so `state` and `nonce`
 * never share storage.
 */

"use strict";

/** Entries expire after 10 minutes. */
const TTL_MS = 10 * 60 * 1_000;

/**
 * Create an independent registry of single-use, expiring random tokens.
 *
 * @returns {{
 *   generate(): string,
 *   validate(value: string|null|undefined): boolean,
 *   discard(value: string): void,
 *   clearAll(): void,
 * }}
 */
export function createTtlRegistry() {
  /** Pending entries: Map<token_string → { createdAt: number }> */
  const pending = new Map();

  /**
   * Generate and register a cryptographically secure token.
   * @returns {string} 64-hex-character random value
   */
  function generate() {
    // Prune expired entries so `pending` does not accumulate indefinitely.
    const now = Date.now();
    for (const [k, v] of pending) {
      if (now - v.createdAt > TTL_MS) pending.delete(k);
    }

    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const token = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    pending.set(token, { createdAt: now });
    return token;
  }

  /**
   * Validate (and consume) a value received in a callback.
   *
   * Valid only if previously returned by generate() and not yet expired. The
   * entry is consumed (deleted) on the first successful validation so it cannot
   * be replayed.
   *
   * @param {string|null|undefined} value
   * @returns {boolean}
   */
  function validate(value) {
    if (!value || typeof value !== "string") return false;
    const entry = pending.get(value);
    if (!entry) return false;
    pending.delete(value);
    return Date.now() - entry.createdAt < TTL_MS;
  }

  /**
   * Discard a previously generated value without validating it.
   * Call this when the popup is cancelled before a callback arrives.
   *
   * @param {string} value
   */
  function discard(value) {
    if (value) pending.delete(value);
  }

  /**
   * Clear all pending values.
   * Useful for testing or when the user navigates away from the auth flow.
   */
  function clearAll() {
    pending.clear();
  }

  return { generate, validate, discard, clearAll };
}
