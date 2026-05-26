"use strict";

import { invokeBackend } from "./function-backend.js";

// Simple dot-path jq evaluator for the common REST subset.
// Handles: .field  .field.nested  .[0]  .
// Delegates anything else to the backend.
function _simpleJq(jsonStr, query) {
  if (!jsonStr.trim()) return "";
  const q = query.trim();
  if (q === ".") {
    const data = JSON.parse(jsonStr);
    return typeof data === "string" ? data : JSON.stringify(data);
  }
  if (!/^(\.[a-zA-Z_][a-zA-Z0-9_]*|\.\[\d+\])+$/.test(q)) {
    return null; // not a simple query — caller falls back to backend
  }
  let val = JSON.parse(jsonStr);
  for (const seg of q.match(/\.[a-zA-Z_][a-zA-Z0-9_]*|\.\[\d+\]/g) ?? []) {
    if (seg.startsWith(".[")) {
      val = val?.[parseInt(seg.slice(2, -1), 10)];
    } else {
      val = val?.[seg.slice(1)];
    }
  }
  if (val === undefined || val === null) return "";
  if (typeof val === "string") return val;
  return JSON.stringify(val);
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
      return atob(String(v));
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
  collectionName: (_args, ctx) => ctx?.envName ?? "",
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
};
