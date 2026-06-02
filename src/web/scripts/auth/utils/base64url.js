/**
 * auth/utils/base64url.js
 *
 * base64url codec (RFC 4648 §5 — URL-safe alphabet, no "=" padding) shared by
 * PKCE code-challenge generation (encode side) and id_token payload decoding
 * (decode side). Both rely on the Web Crypto-adjacent btoa/atob available in
 * Electron's renderer context; no Node.js Buffer is required.
 */

"use strict";

/**
 * Encode an ArrayBuffer (or ArrayBuffer view) as base64url.
 *
 * @param {ArrayBuffer|ArrayBufferView} buffer
 * @returns {string} URL-safe base64 with "=" padding stripped
 */
export function base64UrlEncode(buffer) {
  let binary = "";
  const bytes = new Uint8Array(
    buffer instanceof ArrayBuffer ? buffer : buffer.buffer,
  );
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/**
 * Decode a base64url string to a binary string (the atob output — one char per
 * byte). Restores the standard base64 alphabet and "=" padding before decoding.
 *
 * @param {string} b64url
 * @returns {string} decoded binary string
 */
export function base64UrlDecode(b64url) {
  let b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4;
  if (pad) b64 += "=".repeat(4 - pad);
  return atob(b64);
}
