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
 * auth/utils/params.js
 *
 * Shared assembly helpers for OAuth request parameters.
 */

"use strict";

/**
 * Protocol- and security-critical OAuth parameters that user-supplied extra
 * params must never override. The flows assemble these themselves — CSRF
 * `state`, PKCE `code_challenge`/`code_verifier`/`code_challenge_method`, the
 * `redirect_uri`, `response_type`/`grant_type`, client identity, and each
 * grant's own credential/code params. Letting a hostile or malformed
 * `extraParams` value (for example one resolved from an imported collection's
 * environment variables) replace any of them could defeat CSRF/PKCE protection
 * or redirect the authorization flow. Custom params (scope, audience, prompt,
 * vendor extensions, …) remain free to set.
 * @type {ReadonlySet<string>}
 */
const RESERVED_OAUTH_PARAMS = new Set([
  "response_type",
  "grant_type",
  "client_id",
  "client_secret",
  "redirect_uri",
  "state",
  "nonce",
  "code",
  "code_verifier",
  "code_challenge",
  "code_challenge_method",
  "refresh_token",
  "assertion",
  "subject_token",
  "device_code",
  "username",
  "password",
]);

/**
 * Merge user-supplied extra parameters into a token/authorization param object.
 *
 * Mirrors the guard every flow applied by hand: the source must be a non-null
 * object, and only entries with a truthy key and a non-null/non-empty value are
 * copied (each value is coerced to a string). Reserved OAuth params
 * (see {@link RESERVED_OAUTH_PARAMS}) are skipped so extra params can't override
 * the flow's own security-critical fields. Mutates and returns `target`.
 *
 * @param {Record<string,string>} target - param object being assembled (mutated)
 * @param {unknown} src - candidate extra params (e.g. config.extraParams)
 * @returns {Record<string,string>} the same `target`, for chaining
 */
export function mergeExtraParams(target, src) {
  if (!src || typeof src !== "object") return target;
  for (const [k, v] of Object.entries(src)) {
    if (k && v != null && v !== "" && !RESERVED_OAUTH_PARAMS.has(k)) {
      target[k] = String(v);
    }
  }
  return target;
}
