/**
 * auth/utils/nonce.js
 *
 * OpenID Connect nonce parameter — id_token replay protection (OIDC Core §3.2.2.1).
 *
 * When `response_type` includes `id_token`, the client generates a random nonce
 * and includes it in the authorization request. The IdP echoes it back as the
 * `nonce` claim in the id_token; the client verifies the claim matches a nonce
 * it issued, defeating replay of a previously captured id_token.
 *
 * Pending nonces are held in a module-level Map and expire after 10 minutes.
 * Each nonce is a 64-character cryptographically random hex string.
 */

"use strict";

/** Pending nonce entries: Map<nonce_string → { createdAt: number }> */
const _pending = new Map();

/** Nonces expire after 10 minutes. */
const TTL_MS = 10 * 60 * 1_000;

/**
 * Generate and register a cryptographically secure nonce string.
 *
 * @returns {string} 64-hex-character random value
 */
export function generateNonce() {
  // Prune expired entries so _pending does not accumulate indefinitely.
  const now = Date.now();
  for (const [k, v] of _pending) {
    if (now - v.createdAt > TTL_MS) _pending.delete(k);
  }

  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const nonce = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  _pending.set(nonce, { createdAt: now });
  return nonce;
}

/**
 * Validate a nonce value extracted from an id_token claim.
 *
 * A nonce is valid only if it was previously returned by `generateNonce()` and
 * has not yet expired.  The entry is consumed (deleted) on the first successful
 * validation so it cannot be replayed.
 *
 * @param {string|null|undefined} nonce - Value from the id_token `nonce` claim
 * @returns {boolean}
 */
export function validateNonce(nonce) {
  if (!nonce || typeof nonce !== "string") return false;
  const entry = _pending.get(nonce);
  if (!entry) return false;
  _pending.delete(nonce);
  return Date.now() - entry.createdAt < TTL_MS;
}

/**
 * Discard a previously generated nonce without validating it.
 * Call this when the popup is cancelled before a callback arrives.
 *
 * @param {string} nonce
 */
export function discardNonce(nonce) {
  if (nonce) _pending.delete(nonce);
}

/**
 * Decode the JWT payload (middle segment) of an id_token without verifying its
 * signature. Verification of the signature is the IdP's responsibility per the
 * implicit flow contract (the channel itself is the trust boundary); this
 * helper exists only to extract claims for client-side replay protection.
 *
 * @param {string} idToken
 * @returns {object|null} parsed payload, or null if the token cannot be decoded
 */
export function decodeIdTokenPayload(idToken) {
  if (!idToken || typeof idToken !== "string") return null;
  const parts = idToken.split(".");
  if (parts.length < 2) return null;
  try {
    // base64url → base64
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4;
    if (pad) b64 += "=".repeat(4 - pad);
    const json = atob(b64);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Clear all pending nonces.
 * Useful for testing or when the user navigates away from the auth flow.
 */
export function clearAllNonces() {
  _pending.clear();
}
