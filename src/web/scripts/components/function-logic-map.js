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

"use strict";

import { invokeBackend } from "./function-backend.js";
import { extractJsonPath } from "./json-path.js";

// Simple dot-path jq evaluator for the common REST subset (.field .nested .[0] .).
// Shared with post-response captures via json-path.js; returns null for queries
// outside the subset so the caller can delegate to the backend.
function _simpleJq(jsonStr, query) {
  return extractJsonPath(jsonStr, query);
}

export const logicMap = {
  // ── built-in (synchronous) ──────────────────────────────────────────────
  uuid: (_args, _ctx) => crypto.randomUUID(),

  now: ([fmt = "ISO"], _ctx) => {
    const d = new Date();
    if (fmt === "Unix") return String(Math.floor(d.getTime() / 1000));
    if (fmt === "UnixMs") return String(d.getTime());
    if (fmt === "RFC2822") return d.toUTCString();
    return d.toISOString();
  },

  base64encode: ([v = ""], _ctx) =>
    btoa(unescape(encodeURIComponent(String(v)))),
  base64decode: ([v = ""], _ctx) => {
    try {
      // Inverse of base64encode's UTF-8-safe btoa(unescape(encodeURIComponent))
      // so non-ASCII round-trips instead of decoding to mojibake.
      return decodeURIComponent(escape(atob(String(v))));
    } catch {
      return "";
    }
  },
  urlEncode: ([v = ""], _ctx) => encodeURIComponent(String(v)),
  urlDecode: ([v = ""], _ctx) => {
    try {
      return decodeURIComponent(String(v));
    } catch {
      return String(v);
    }
  },

  randomInt: ([min = "0", max = "100"], _ctx) => {
    const lo = Number(min);
    const hi = Number(max);
    if (isNaN(lo) || isNaN(hi)) return "";
    return String(Math.floor(Math.random() * (hi - lo + 1)) + lo);
  },

  // ── context (synchronous — reads from ctx) ──────────────────────────────
  folderName: ([depth = "0"], ctx) => {
    const d = parseInt(depth, 10);
    if (isNaN(d)) return "";
    return ctx?.folderChain?.[d]?.name ?? "";
  },
  collectionName: (_args, ctx) => ctx?.collectionName ?? "",
  requestName: (_args, ctx) => ctx?.requestName ?? "",
  environmentName: (_args, ctx) => ctx?.activeEnvironmentName ?? "",

  // ── backend (async — delegated to main process via IPC) ─────────────────
  environmentVariable: ([name = ""], _ctx) => {
    if (!name) return "";
    return invokeBackend("env", { name });
  },

  hmac: ([algo = "SHA256", key = "", message = ""], _ctx) =>
    invokeBackend("hmac", { algo, key, message }),

  hash: ([algo = "SHA256", value = ""], _ctx) =>
    invokeBackend("hash", { algo, value }),

  // ── request-output (synchronous — reads from response cache) ────────────
  response: ([name = "", query = "."], ctx) => {
    const body = ctx?.responseCache?.[name] ?? "";
    if (!query || query === ".") return body;
    try {
      const simple = _simpleJq(body, query);
      if (simple !== null) return simple;
    } catch {
      /* fall through to backend */
    }
    return invokeBackend("jq", { json: body, query });
  },
  responseHeader: ([req = "", hdr = ""], ctx) =>
    ctx?.responseHeaders?.[req]?.[hdr.toLowerCase()] ?? "",
  responseStatus: ([name = ""], ctx) => ctx?.responseStatus?.[name] ?? "",

  // run only triggers pre-execution of the named request (done by the
  // prefetch pass in app.js); the token itself always resolves to "".
  run: (_args, _ctx) => "",
};
