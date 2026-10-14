/*
 * Copyright 2026 Jason Figge
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This file is part of Rest Hippo.
 *
 * Rest Hippo is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option) any later
 * version.
 *
 * Rest Hippo is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR
 * A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with
 * Rest Hippo. If not, see <https://www.gnu.org/licenses/>.
 */

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

/**
 * Decode a base64url string to a UTF-8 JavaScript string. Unlike
 * {@link base64UrlDecode} (which returns a Latin-1 "one char per byte" binary
 * string), this reinterprets the bytes as UTF-8 — required for JWT parts, whose
 * JSON claims may contain multi-byte characters (e.g. a `name` of "José"). The
 * binary form corrupts such claims and can even make JSON.parse throw.
 *
 * @param {string} b64url
 * @returns {string} UTF-8 decoded string
 */
export function base64UrlDecodeToString(b64url) {
  const binary = base64UrlDecode(b64url);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
