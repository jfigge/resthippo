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
