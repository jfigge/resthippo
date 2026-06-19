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
 * utils/base64.js — UTF-8-safe base64 encoding for the renderer.
 *
 * The platform `btoa` only accepts code points 0x00–0xFF (Latin-1); passing a
 * string containing any character above that range throws
 * `InvalidCharacterError`. HTTP Basic credentials (RFC 7617) and OAuth client
 * secrets can legitimately contain Unicode, so callers must UTF-8-encode to
 * bytes first and base64 those bytes — which is what this helper does. For
 * pure-ASCII input the output is byte-identical to `btoa(str)`.
 */

"use strict";

/**
 * Base64-encode a string's UTF-8 bytes (standard alphabet, with "=" padding).
 *
 * @param {string} str
 * @returns {string} standard base64
 */
export function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
