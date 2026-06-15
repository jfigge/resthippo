"use strict";

import { resolveString } from "../variable-resolver.js";
import {
  BODY_CONTENT_TYPES,
  NO_BODY_METHODS,
  encodeBaseUrl,
  applyPathParams,
} from "../request-payload.js";
import { extractOperationName } from "../graphql-schema.js";

/**
 * code-gen/request-model.js — normalize a request tree node into a flat,
 * language-agnostic model that every code-generation target consumes.
 *
 * This is the single place request shape + variable resolution live for code
 * generation: it mirrors `RequestEditor.#sendRequest()` / the old
 * `TreeView.#buildCurl()` so a generated snippet matches what the Send button
 * actually transmits (resolved path/query params, enabled headers, auth header,
 * and body by type — text / urlencoded / multipart / file / graphql).
 *
 * The returned model is intentionally dumb data — no language specifics — so a
 * new target is a small, localized addition (see ./index.js).
 *
 * Model shape:
 *   {
 *     method: string,
 *     url: string,                       // base + percent-encoded query string
 *     headers: { name, value }[],        // ordered; includes the effective
 *                                        //   Content-Type for raw/urlencoded
 *                                        //   bodies; never set for multipart
 *     body:
 *       | { kind: "none" }
 *       | { kind: "raw", text }                       // Content-Type is a header
 *       | { kind: "urlencoded", fields: {name,value}[] }   // raw (un-encoded)
 *       | { kind: "multipart", fields: (
 *             | { kind: "text", name, value }
 *             | { kind: "file", name, file, contentType, filename }
 *           )[] }
 *       | { kind: "file", path },
 *     notes: string[],                   // caveats (e.g. AWS SigV4) emitted as
 *                                        //   leading comments by each target
 *   }
 *
 * @param {object} node     a request-type tree node (live copy)
 * @param {object} context  variable-resolver context { envVariables, folderChain }
 * @returns {object} the normalized request model
 */
export function buildRequestModel(node, context) {
  const method = node.method ?? "GET";
  const rv = (s) => resolveString(s ?? "", context);
  const notes = [];

  // ── URL — substitute resolved+encoded path params, then percent-encode the
  //    base, mirroring the send path so the URL matches what is sent. ─────────
  const pathMap = new Map();
  for (const pp of node.pathParams ?? []) {
    const name = (pp.name ?? "").trim();
    if (name) pathMap.set(name, encodeURIComponent(rv(pp.value ?? "")));
  }
  const baseUrl = encodeBaseUrl(
    applyPathParams(rv(node.url || "<url>"), pathMap),
  );

  // Append enabled, non-blank query parameters (resolved + encoded).
  const params = Array.isArray(node.params) ? node.params : [];
  const enabledParams = params.filter((p) => p.enabled && p.name.trim());
  let url = baseUrl;
  if (enabledParams.length) {
    const qs = enabledParams
      .map(
        (p) =>
          `${encodeURIComponent(rv(p.name))}=${encodeURIComponent(rv(p.value))}`,
      )
      .join("&");
    url += (baseUrl.includes("?") ? "&" : "?") + qs;
  }

  // ── Headers — enabled array rows (new format) or legacy object. Kept as an
  //    insertion-ordered plain object so the `!headers["Content-Type"]` default
  //    check below matches the old cURL builder exactly. ─────────────────────
  const headers = {};
  if (Array.isArray(node.headers)) {
    node.headers
      .filter((h) => h.enabled && h.name.trim())
      .forEach((h) => {
        headers[rv(h.name).trim()] = rv(h.value);
      });
  } else if (node.headers && typeof node.headers === "object") {
    Object.entries(node.headers).forEach(([k, v]) => {
      headers[rv(k)] = rv(v);
    });
  }

  // ── Auth — inject Authorization header when enabled. ──────────────────────
  const authEnabled = node.authEnabled ?? true;
  const authType = node.authType ?? "none";
  if (authEnabled && authType !== "none") {
    switch (authType) {
      case "basic": {
        const username = rv(node.authBasic?.username ?? "");
        const password = rv(node.authBasic?.password ?? "");
        if (username || password) {
          headers["Authorization"] = `Basic ${btoa(`${username}:${password}`)}`;
        }
        break;
      }
      case "bearer":
        if (node.authBearer?.token)
          headers["Authorization"] = `Bearer ${rv(node.authBearer.token)}`;
        break;
      case "oauth2":
        if (node.authOAuth2?.token)
          headers["Authorization"] = `Bearer ${rv(node.authOAuth2.token)}`;
        break;
      case "aws-iam":
        // Signature v4 must be computed at request time from the live payload,
        // so it cannot be baked into a static snippet — flag it and omit.
        notes.push(
          "AWS Signature v4 auth is computed at request time and is not included in this snippet.",
        );
        break;
    }
  }

  // ── Body — match the send path's assembly by type. ────────────────────────
  let body = { kind: "none" };
  const bodyType = node.bodyType ?? "no-body";
  if (!NO_BODY_METHODS.has(method)) {
    switch (bodyType) {
      case "form-data": {
        const rows = (node.bodyFormRows ?? []).filter(
          (r) => r.enabled && r.name.trim(),
        );
        if (rows.length > 0) {
          body = {
            kind: "multipart",
            fields: rows.map((r) =>
              r.kind === "file"
                ? {
                    kind: "file",
                    name: rv(r.name),
                    file: r.filePath ?? "",
                    contentType: r.contentType || "",
                    filename: r.fileName || "",
                  }
                : { kind: "text", name: rv(r.name), value: rv(r.value) },
            ),
          };
        }
        break;
      }
      case "form-urlencoded": {
        const rows = (node.bodyFormRows ?? []).filter(
          (r) => r.enabled && r.name.trim(),
        );
        if (rows.length > 0) {
          body = {
            kind: "urlencoded",
            fields: rows.map((r) => ({ name: rv(r.name), value: rv(r.value) })),
          };
          if (!headers["Content-Type"])
            headers["Content-Type"] = "application/x-www-form-urlencoded";
        }
        break;
      }
      case "json":
      case "yaml":
      case "xml":
      case "text":
        if (node.bodyText?.trim()) {
          body = { kind: "raw", text: rv(node.bodyText) };
          if (!headers["Content-Type"])
            headers["Content-Type"] = BODY_CONTENT_TYPES[bodyType];
        }
        break;
      case "graphql": {
        // Mirror request-payload.js: a JSON { query, variables, operationName }
        // POST. {{var}} tokens resolve in both the query and variables JSON.
        const query = rv(node.bodyGraphql?.query ?? "");
        const varsText = rv(node.bodyGraphql?.variables ?? "").trim();
        if (query.trim() || varsText) {
          const payload = { query };
          if (varsText) {
            try {
              payload.variables = JSON.parse(varsText);
            } catch {
              // Invalid variables JSON — omit rather than emit a malformed field.
            }
          }
          const operationName = extractOperationName(query);
          if (operationName) payload.operationName = operationName;
          body = { kind: "raw", text: JSON.stringify(payload) };
          if (!headers["Content-Type"])
            headers["Content-Type"] = "application/json";
        }
        break;
      }
      case "file":
        if (node.bodyFilePath) body = { kind: "file", path: node.bodyFilePath };
        break;
      default:
        break; // "no-body" — leave body as { kind: "none" }
    }
  }

  // Multipart: the HTTP client owns the Content-Type (it carries the boundary),
  // so strip any header the user/auth path may have set to avoid emitting a
  // boundary-less type that would break non-cURL clients.
  if (body.kind === "multipart") {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === "content-type") delete headers[key];
    }
  }

  const headerList = Object.entries(headers).map(([name, value]) => ({
    name,
    value,
  }));

  return { method, url, headers: headerList, body, notes };
}
