"use strict";

import { isSecretHeader } from "./redact.js";

/**
 * HAR 1.2 exporter.
 *
 * HAR (HTTP Archive) records actual request/response exchanges, not request
 * definitions. wurl keeps per-request run history, so this exporter emits one
 * `log.entries` entry per request that has a run — its MOST RECENT run — using
 * the history map the caller assembles. Requests that have never run contribute
 * nothing; a collection with no runs produces a valid HAR with `entries: []`.
 *
 * Secret redaction (parity with the Postman exporter's auth handling): in a
 * recorded exchange the credential lives in materialized headers/cookies, so
 * sensitive request/response header values (Authorization, Cookie, Set-Cookie,
 * API keys) and all response cookie values are blanked — names preserved.
 */

const APP_VERSION = "0.6.1";

/** Look up a request's history entry from a Map or a plain object. */
function lookup(historyByRequestId, id) {
  if (!historyByRequestId || id == null) return null;
  if (typeof historyByRequestId.get === "function") {
    return historyByRequestId.get(id) ?? null;
  }
  return historyByRequestId[id] ?? null;
}

/** UTF-8 byte length of a string (HAR sizes are byte counts). */
function byteLen(str) {
  if (typeof str !== "string" || !str) return 0;
  try {
    return new TextEncoder().encode(str).length;
  } catch {
    return str.length;
  }
}

/** First value of a header from an object map, case-insensitively. */
function headerValue(headersObj, name) {
  if (!headersObj || typeof headersObj !== "object") return "";
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headersObj)) {
    if (k.toLowerCase() === lower)
      return Array.isArray(v) ? (v[0] ?? "") : String(v ?? "");
  }
  return "";
}

/** Convert a header object map to HAR `{name,value}[]`, redacting secrets. */
function harHeaders(headersObj) {
  if (!headersObj || typeof headersObj !== "object") return [];
  const out = [];
  for (const [name, value] of Object.entries(headersObj)) {
    const redact = isSecretHeader(name);
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      out.push({ name, value: redact ? "" : String(v ?? "") });
    }
  }
  return out;
}

/** Map response cookies to HAR cookies, blanking the (secret) values. */
function harCookies(cookies) {
  if (!Array.isArray(cookies)) return [];
  return cookies.map((c) => {
    const out = { name: c?.name ?? "", value: "" };
    if (c?.path) out.path = c.path;
    if (c?.domain) out.domain = c.domain;
    if (c?.expires) out.expires = c.expires;
    if (typeof c?.httpOnly === "boolean") out.httpOnly = c.httpOnly;
    if (typeof c?.secure === "boolean") out.secure = c.secure;
    return out;
  });
}

/** Parse a URL's query string into HAR `{name,value}[]`. */
function harQueryString(url) {
  try {
    const u = new URL(url, "http://_/");
    return [...u.searchParams.entries()].map(([name, value]) => ({
      name,
      value,
    }));
  } catch {
    return [];
  }
}

/** Build the HAR request `postData`, or undefined when there is no body. */
function postData(sent) {
  const body = typeof sent?.body === "string" ? sent.body : null;
  if (!body) return undefined;
  const mimeType =
    headerValue(sent.headers, "content-type") || "application/octet-stream";
  return { mimeType, text: body };
}

/** Build a single HAR entry from a run-history record. */
function buildEntry(entry) {
  const resp = entry.response ?? {};
  const sent = resp.request ?? {};
  const elapsed = resp.elapsed ?? 0;
  const method = (
    sent.method ??
    entry.requestNode?.method ??
    "GET"
  ).toUpperCase();
  const url = sent.url ?? entry.requestUrl ?? "";
  const pd = postData(sent);

  return {
    startedDateTime: new Date(entry.timestamp ?? 0).toISOString(),
    time: elapsed,
    request: {
      method,
      url,
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: harHeaders(sent.headers),
      queryString: harQueryString(url),
      headersSize: -1,
      bodySize: pd ? byteLen(pd.text) : 0,
      ...(pd ? { postData: pd } : {}),
    },
    response: {
      status: resp.status ?? 0,
      statusText: resp.statusText ?? "",
      httpVersion: "HTTP/1.1",
      cookies: harCookies(resp.cookies),
      headers: harHeaders(resp.headers),
      content: {
        size: resp.size ?? byteLen(resp.body ?? ""),
        mimeType: headerValue(resp.headers, "content-type") || "",
        text: typeof resp.body === "string" ? resp.body : "",
      },
      redirectURL: "",
      headersSize: -1,
      bodySize: resp.size ?? 0,
    },
    cache: {},
    timings: { send: 0, wait: elapsed, receive: 0 },
  };
}

/**
 * Serialize a wurl collection's run history to a HAR 1.2 JSON string.
 *
 * @param {object} collection          wurl collection node (type: "collection")
 * @param {Map<string,object>|object}  historyByRequestId  Most-recent run per
 *        request id (the entry shape stored in `_requestHistory`). Requests
 *        absent from the map are skipped.
 * @returns {string} Formatted JSON
 */
export function exportToHar(collection, historyByRequestId) {
  const entries = [];
  const walk = (node) => {
    for (const child of node.children ?? []) {
      if (child.type === "collection") {
        walk(child);
      } else if (child.type === "request") {
        const record = lookup(historyByRequestId, child.id);
        if (record) entries.push(buildEntry(record));
      }
    }
  };
  walk(collection ?? {});

  return JSON.stringify(
    {
      log: {
        version: "1.2",
        creator: { name: "wurl", version: APP_VERSION },
        entries,
      },
    },
    null,
    2,
  );
}
