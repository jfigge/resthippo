"use strict";

import {
  buildAuth,
  noBody,
  rawBody,
  formBody,
  authFromHeaderValue,
  splitUrlQuery,
  parseUrlencodedRows,
} from "./shape.js";

/**
 * import/har.js
 *
 * Parse a HAR 1.2 archive (`{ log: { entries: [...] } }`) — the universal
 * browser/proxy capture format ("Save all as HAR") — into a wurl collection of
 * requests. Each `log.entries[].request` becomes one request; entries are
 * grouped into a folder per host so a multi-host capture stays navigable.
 *
 * Only the request side is imported — response payloads are dropped (a captured
 * response isn't a request you re-send). HTTP/2 pseudo-headers (`:method`,
 * `:authority`, …) are filtered, and an `Authorization` header is surfaced in
 * the Auth tab. Returns the shared `{ collection, variables, warnings }` shape.
 */

/** The request host, used as a folder name; falls back when the URL is opaque. */
function hostOf(url) {
  try {
    return new URL(url).host || "Requests";
  } catch {
    return "Requests";
  }
}

/** A readable request name from method + URL path (e.g. "GET /users/1"). */
function requestName(method, url) {
  try {
    const u = new URL(url);
    const path = u.pathname && u.pathname !== "/" ? u.pathname : u.host;
    return `${method} ${path}`;
  } catch {
    return `${method} ${url || "Request"}`.trim();
  }
}

/** Map a HAR `postData` object onto a canonical wurl body. */
function bodyFromPostData(postData, warnings) {
  if (!postData) return noBody();
  const mime = (postData.mimeType ?? "").toLowerCase();

  // Structured params (HAR splits urlencoded / multipart bodies into `params`).
  if (Array.isArray(postData.params) && postData.params.length) {
    if (mime.includes("multipart/form-data")) {
      return formBody(
        "form-data",
        postData.params.map((p) => {
          if (p.fileName != null) {
            warnings.push(
              `Form field "${p.name ?? ""}" references a file ("${p.fileName}"); re-attach it before sending.`,
            );
            return {
              enabled: true,
              name: p.name ?? "",
              file: { path: p.fileName, contentType: p.contentType ?? "" },
            };
          }
          return { enabled: true, name: p.name ?? "", value: p.value ?? "" };
        }),
      );
    }
    return formBody(
      "form-urlencoded",
      postData.params.map((p) => ({
        enabled: true,
        name: p.name ?? "",
        value: p.value ?? "",
      })),
    );
  }

  const txt = typeof postData.text === "string" ? postData.text : "";
  if (mime.includes("x-www-form-urlencoded"))
    return formBody("form-urlencoded", parseUrlencodedRows(txt));
  if (mime.includes("json")) return rawBody("json", txt);
  if (mime.includes("xml")) return rawBody("xml", txt);
  if (mime.includes("yaml") || mime.includes("yml"))
    return rawBody("yaml", txt);
  if (txt) return rawBody("text", txt);
  return noBody();
}

/** Build a wurl request node from a HAR `entry.request`. */
function buildRequest(req, warnings) {
  const method = (req.method ?? "GET").toUpperCase();
  const url = req.url ?? "";
  const { base, params: parsedParams } = splitUrlQuery(url);

  // Prefer HAR's explicit `queryString` (already split + decoded); fall back to
  // parsing the URL when a capture omits it.
  const params =
    Array.isArray(req.queryString) && req.queryString.length
      ? req.queryString.map((q) => ({
          enabled: true,
          name: q.name ?? "",
          value: q.value ?? "",
        }))
      : parsedParams;

  let auth = buildAuth(null);
  const headers = [];
  for (const h of req.headers ?? []) {
    const name = h.name ?? "";
    if (!name || name.startsWith(":")) continue; // drop HTTP/2 pseudo-headers
    if (name.toLowerCase() === "authorization") {
      const desc = authFromHeaderValue(h.value ?? "");
      if (desc) {
        auth = buildAuth(desc); // surfaced in the Auth tab
        continue;
      }
    }
    headers.push({ enabled: true, name, value: h.value ?? "" });
  }

  return {
    id: crypto.randomUUID(),
    type: "request",
    name: requestName(method, url),
    method,
    url: base,
    params,
    headers,
    notes: "",
    ...bodyFromPostData(req.postData, warnings),
    ...auth,
  };
}

/**
 * Parse a HAR 1.2 archive into a wurl collection.
 *
 * @param {object} data  Parsed HAR JSON
 * @returns {{ collection: object,
 *   variables: { name: string, value: string, secure: boolean }[],
 *   warnings: string[] }}
 */
export function parseHar(data) {
  const warnings = [];
  const entries = data?.log?.entries ?? [];

  // One folder per host, preserving first-seen order.
  const folders = new Map();
  let skipped = 0;
  for (const entry of entries) {
    const req = entry?.request;
    if (!req || !req.url) {
      skipped++;
      continue;
    }
    const host = hostOf(req.url);
    if (!folders.has(host)) {
      folders.set(host, {
        id: crypto.randomUUID(),
        type: "collection",
        name: host,
        variables: [],
        children: [],
      });
    }
    folders.get(host).children.push(buildRequest(req, warnings));
  }

  if (skipped > 0) {
    warnings.push(
      `Skipped ${skipped} HAR entr${skipped !== 1 ? "ies" : "y"} with no request URL.`,
    );
  }

  // A single-host capture needs no folder — lift its requests to the top.
  const folderNodes = [...folders.values()];
  const children =
    folderNodes.length === 1 ? folderNodes[0].children : folderNodes;

  return {
    collection: {
      id: crypto.randomUUID(),
      type: "collection",
      name: "Imported from HAR",
      variables: [],
      children,
    },
    variables: [],
    warnings,
  };
}
