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
 * auth/utils/pkce.js
 *
 * PKCE (Proof Key for Code Exchange) — RFC 7636
 * https://tools.ietf.org/html/rfc7636
 *
 * Uses the Web Crypto API available in Electron's renderer context.
 * No Node.js crypto module is required.
 */

"use strict";

import { base64UrlEncode } from "./base64url.js";

// Allowed characters in a PKCE code verifier (RFC 7636 §4.1)
const VERIFIER_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

/**
 * Generate a cryptographically secure PKCE code verifier.
 *
 * Length must be between 43 and 128 characters (RFC 7636 §4.1).
 *
 * @param {number} [length=64] - Verifier length (43–128)
 * @returns {string}
 */
export function generateCodeVerifier(length = 64) {
  if (length < 43 || length > 128) {
    throw new RangeError(
      "PKCE code verifier length must be between 43 and 128 characters.",
    );
  }
  const alphabet = VERIFIER_CHARS.length;
  const limit = Math.floor(256 / alphabet) * alphabet; // rejection threshold
  const result = [];
  while (result.length < length) {
    const batch = new Uint8Array(Math.ceil((length - result.length) * 1.1 + 8));
    crypto.getRandomValues(batch);
    for (const b of batch) {
      if (b < limit) result.push(VERIFIER_CHARS[b % alphabet]);
      if (result.length === length) break;
    }
  }
  return result.join("");
}

/**
 * Derive the S256 code challenge from a code verifier.
 *
 *   code_challenge = BASE64URL(SHA-256(ASCII(code_verifier)))
 *
 * @param {string} verifier - The code verifier produced by generateCodeVerifier()
 * @returns {Promise<string>} Base64url-encoded SHA-256 digest (no padding)
 */
export async function generateCodeChallenge(verifier) {
  const encoded = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return base64UrlEncode(digest);
}
