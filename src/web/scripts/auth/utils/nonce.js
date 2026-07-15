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
 * auth/utils/nonce.js
 *
 * OpenID Connect nonce parameter — id_token replay protection (OIDC Core §3.2.2.1).
 *
 * When `response_type` includes `id_token`, the client generates a random nonce
 * and includes it in the authorization request. The IdP echoes it back as the
 * `nonce` claim in the id_token; the client verifies the claim matches a nonce
 * it issued, defeating replay of a previously captured id_token.
 *
 * The mint / validate-once / expire lifecycle is the shared single-use TTL
 * registry (see ttl-registry.js); only decodeIdTokenPayload() below is
 * OIDC-specific. Each nonce is a 64-character cryptographically random hex
 * string that expires after 10 minutes.
 */

"use strict";

import { createTtlRegistry } from "./ttl-registry.js";
import { base64UrlDecodeToString } from "./base64url.js";

const _nonces = createTtlRegistry();

/**
 * Generate and register a cryptographically secure nonce string.
 * @returns {string} 64-hex-character random value
 */
export function generateNonce() {
  return _nonces.generate();
}

/**
 * Validate (and consume) a nonce value extracted from an id_token claim.
 * @param {string|null|undefined} nonce - Value from the id_token `nonce` claim
 * @returns {boolean}
 */
export function validateNonce(nonce) {
  return _nonces.validate(nonce);
}

/**
 * Discard a previously generated nonce without validating it.
 * Call this when the popup is cancelled before a callback arrives.
 * @param {string} nonce
 */
export function discardNonce(nonce) {
  _nonces.discard(nonce);
}

/**
 * Decode the JWT payload (middle segment) of an id_token, after rejecting an
 * UNSIGNED token outright. We do not verify the signature here — that needs the
 * IdP's JWKS and is out of scope for the (legacy) implicit flow — but an
 * `alg: none` (or missing-alg / missing-signature) token can be forged by
 * anyone, so we refuse to decode or trust it at all. This is the cheap floor
 * beneath the nonce replay check; full verification would additionally check
 * the signature, `iss`, `aud` and `exp`.
 *
 * @param {string} idToken
 * @returns {object|null} parsed payload, or null if the token is unsigned or
 *   cannot be decoded
 */
export function decodeIdTokenPayload(idToken) {
  if (!idToken || typeof idToken !== "string") return null;
  const parts = idToken.split(".");
  // A signed JWT has three segments and a non-empty signature.
  if (parts.length !== 3 || !parts[2]) return null;
  try {
    const header = JSON.parse(base64UrlDecodeToString(parts[0]));
    const alg = typeof header.alg === "string" ? header.alg.toLowerCase() : "";
    if (!alg || alg === "none") return null; // unsigned — never trust it
    return JSON.parse(base64UrlDecodeToString(parts[1]));
  } catch {
    return null;
  }
}
