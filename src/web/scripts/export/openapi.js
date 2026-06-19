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

"use strict";

import { redactedAuth } from "./redact.js";

/**
 * OpenAPI 3.0.3 exporter — best-effort.
 *
 * A Rest Hippo collection is a set of concrete requests; OpenAPI is a description of
 * an API surface. The mapping is therefore lossy by nature, and the lossy areas
 * are intentional and documented here:
 *
 *   - PATHS: each request URL is reduced to a server origin + a path; the most
 *     common concrete `https://host` among requests becomes the single server,
 *     and request paths are made relative to it. Rest Hippo `{{var}}` templates become
 *     OpenAPI `{var}` path templates (and are declared as path parameters).
 *   - COLLISIONS: OpenAPI allows one operation per (path, method); when two
 *     requests collapse to the same pair, the first wins and the rest are
 *     dropped from the spec.
 *   - PARAMETERS: only enabled query params and non-reserved headers are
 *     emitted (Authorization / Content-Type / Accept are owned by security and
 *     content, not parameters); disabled rows are not representable.
 *   - BODIES: emitted as a single example under the matching media type; no
 *     JSON Schema is inferred beyond object/string shapes.
 *   - AUTH: mapped to `components.securitySchemes`. Security schemes carry NO
 *     secret values in OpenAPI, so redaction is satisfied inherently; we never
 *     embed `secure` variable values anywhere in the document.
 *
 * To export a whole workspace, callers wrap every collection as a folder under
 * one synthetic root collection; each folder becomes a tag.
 */

const RESERVED_HEADERS = new Set(["authorization", "content-type", "accept"]);

/** Convert a slug-ish operationId fragment from a request name. */
function slug(name) {
  return (
    String(name ?? "")
      .trim()
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "operation"
  );
}

/** Extract the `https?://host[:port]` origin from a URL, or "" if none. */
function originOf(rawUrl) {
  const m = String(rawUrl ?? "")
    .trim()
    .match(/^(https?:\/\/[^/?#]+)/i);
  return m ? m[1] : "";
}

/** Pick the most frequent concrete origin among the requests (for `servers`). */
function commonOrigin(requests) {
  const counts = new Map();
  for (const r of requests) {
    const o = originOf(r.url);
    if (o) counts.set(o, (counts.get(o) ?? 0) + 1);
  }
  let best = "";
  let bestN = 0;
  for (const [o, n] of counts) {
    if (n > bestN) {
      best = o;
      bestN = n;
    }
  }
  return best;
}

/**
 * Reduce a request URL to an OpenAPI path: drop the query, convert `{{var}}` and
 * `:name` path tokens to `{var}`, strip the server origin (the chosen one, or any
 * concrete origin), and guarantee a leading slash.
 */
function toOpenApiPath(rawUrl, serverOrigin) {
  let url = String(rawUrl ?? "").trim();
  const q = url.search(/[?#]/);
  if (q >= 0) url = url.slice(0, q);
  url = url.replace(/\{\{\s*([^}]+?)\s*\}\}/g, "{$1}");

  if (serverOrigin && url.startsWith(serverOrigin)) {
    url = url.slice(serverOrigin.length);
  } else {
    const m = url.match(/^https?:\/\/[^/]+(\/.*)?$/i);
    if (m) url = m[1] || "/";
  }
  if (!url) url = "/";
  if (!url.startsWith("/")) url = `/${url}`;
  // Convert the app's other path-param style (`/:name`) to OpenAPI `{name}` —
  // done after the origin is stripped so a scheme's `://` is never touched.
  url = url.replace(/\/:([A-Za-z_]\w*)/g, "/{$1}");
  return url;
}

/** Path parameters declared by `{name}` tokens in the path. */
function pathParams(path) {
  const params = [];
  const seen = new Set();
  for (const m of path.matchAll(/\{([^}]+)\}/g)) {
    const name = m[1];
    if (seen.has(name)) continue;
    seen.add(name);
    params.push({
      name,
      in: "path",
      required: true,
      schema: { type: "string" },
    });
  }
  return params;
}

/** Query + header parameters from a request node (reserved headers excluded). */
function ioParams(node) {
  const out = [];
  for (const p of node.params ?? []) {
    if (!p?.enabled) continue;
    const name = p.name ?? "";
    if (!name) continue;
    const param = {
      name,
      in: "query",
      required: false,
      schema: { type: "string" },
    };
    if (p.value) param.example = p.value;
    out.push(param);
  }
  for (const h of node.headers ?? []) {
    if (!h?.enabled) continue;
    const name = h.name ?? "";
    if (!name || RESERVED_HEADERS.has(name.toLowerCase())) continue;
    const param = {
      name,
      in: "header",
      required: false,
      schema: { type: "string" },
    };
    if (h.value) param.example = h.value;
    out.push(param);
  }
  return out;
}

/** Build a requestBody object from a Rest Hippo body, or undefined for no-body. */
function requestBody(node) {
  const type = node.bodyType ?? "no-body";
  if (type === "no-body") return undefined;

  if (type === "json") {
    let example = node.bodyText ?? "";
    try {
      example = JSON.parse(node.bodyText ?? "");
    } catch {
      /* keep raw text as the example */
    }
    return { content: { "application/json": { example } } };
  }
  if (type === "xml") {
    return { content: { "application/xml": { example: node.bodyText ?? "" } } };
  }
  if (type === "yaml") {
    return {
      content: { "application/yaml": { example: node.bodyText ?? "" } },
    };
  }
  if (type === "text") {
    return { content: { "text/plain": { example: node.bodyText ?? "" } } };
  }
  if (type === "form-urlencoded" || type === "form-data") {
    const mime =
      type === "form-data"
        ? "multipart/form-data"
        : "application/x-www-form-urlencoded";
    const properties = {};
    const example = {};
    for (const r of node.bodyFormRows ?? []) {
      if (!r?.enabled || !r.name) continue;
      if (r.kind === "file") {
        // OpenAPI represents an upload field as a binary-format string.
        properties[r.name] = { type: "string", format: "binary" };
      } else {
        properties[r.name] = { type: "string" };
        example[r.name] = r.value ?? "";
      }
    }
    return {
      content: { [mime]: { schema: { type: "object", properties }, example } },
    };
  }
  if (type === "file") {
    return {
      content: {
        "application/octet-stream": {
          schema: { type: "string", format: "binary" },
        },
      },
    };
  }
  return undefined;
}

/**
 * Derive an OpenAPI security scheme from a request's auth, registering it in
 * `schemes` under a stable name and returning that name (or null). No secret
 * value is ever placed in the scheme.
 */
function securityScheme(node, schemes) {
  const auth = redactedAuth(node);
  if (!auth) return null;

  if (auth.type === "basic") {
    schemes.basicAuth ??= { type: "http", scheme: "basic" };
    return "basicAuth";
  }
  if (auth.type === "bearer") {
    schemes.bearerAuth ??= { type: "http", scheme: "bearer" };
    return "bearerAuth";
  }
  if (auth.type === "apikey") {
    schemes.apiKeyAuth ??= {
      type: "apiKey",
      in: auth.addTo === "query" ? "query" : "header",
      name: auth.name || "X-API-Key",
    };
    return "apiKeyAuth";
  }
  if (auth.type === "digest") {
    schemes.digestAuth ??= { type: "http", scheme: "digest" };
    return "digestAuth";
  }
  if (auth.type === "ntlm") {
    // NTLM has no standard OpenAPI scheme; `http`+`scheme: ntlm` is the
    // widely-recognised convention (Azure / autorest).
    schemes.ntlmAuth ??= { type: "http", scheme: "ntlm" };
    return "ntlmAuth";
  }
  if (auth.type === "aws-iam") {
    // AWS SigV4 has no native OpenAPI scheme; the de-facto representation is an
    // apiKey on the Authorization header tagged with the API Gateway auth type.
    schemes.awsAuth ??= {
      type: "apiKey",
      in: "header",
      name: "Authorization",
      "x-amazon-apigateway-authtype": "awsSigv4",
    };
    return "awsAuth";
  }
  if (auth.type === "oauth2") {
    if (!schemes.oauth2Auth) {
      const flows = {};
      const scopes = {};
      if (auth.grantType === "authorization_code") {
        flows.authorizationCode = {
          authorizationUrl: auth.authUrl,
          tokenUrl: auth.accessTokenUrl,
          scopes,
        };
      } else if (auth.grantType === "implicit") {
        flows.implicit = { authorizationUrl: auth.authUrl, scopes };
      } else if (auth.grantType === "password") {
        flows.password = { tokenUrl: auth.accessTokenUrl, scopes };
      } else {
        flows.clientCredentials = { tokenUrl: auth.accessTokenUrl, scopes };
      }
      schemes.oauth2Auth = { type: "oauth2", flows };
    }
    return "oauth2Auth";
  }
  return null;
}

/** Walk the tree, collecting requests tagged by their nearest folder name. */
function collectRequests(root) {
  const requests = [];
  const walk = (node, tag) => {
    for (const child of node.children ?? []) {
      if (child.type === "collection") {
        walk(child, child.name ?? tag);
      } else if (child.type === "request") {
        requests.push({ node: child, tag });
      }
    }
  };
  walk(root ?? {}, root?.name ?? "Default");
  return requests;
}

/**
 * Serialize a Rest Hippo collection to an OpenAPI 3.0.3 JSON string.
 *
 * @param {object} collection   Rest Hippo collection node (type: "collection")
 * @param {Array}  [_variables]  Collection-level variables — intentionally not
 *                               embedded in the document (no secret leaks);
 *                               accepted only for a uniform exporter signature.
 * @returns {string} Formatted JSON
 */
export function exportToOpenApi(collection, _variables = []) {
  const collected = collectRequests(collection);
  const server = commonOrigin(collected.map((c) => c.node));

  const paths = {};
  const schemes = {};
  const tagSet = new Set();
  const usedOpIds = new Set();

  for (const { node, tag } of collected) {
    const method = (node.method ?? "GET").toLowerCase();
    const path = toOpenApiPath(node.url, server);

    paths[path] ??= {};
    // One operation per (path, method): first request wins on collision.
    if (paths[path][method]) continue;

    // Merge path + query/header params, deduped by (name, in).
    const params = [...pathParams(path), ...ioParams(node)];
    const deduped = [];
    const seen = new Set();
    for (const p of params) {
      const key = `${p.in}:${p.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(p);
    }

    let opId = slug(node.name);
    while (usedOpIds.has(opId)) opId = `${opId}_${usedOpIds.size}`;
    usedOpIds.add(opId);

    const operation = {
      operationId: opId,
      summary: node.name ?? "",
      responses: { 200: { description: "OK" } },
    };
    if (node.notes) operation.description = node.notes;
    if (tag) {
      operation.tags = [tag];
      tagSet.add(tag);
    }
    if (deduped.length) operation.parameters = deduped;

    const body = requestBody(node);
    if (body) operation.requestBody = body;

    const schemeName = securityScheme(node, schemes);
    if (schemeName) operation.security = [{ [schemeName]: [] }];

    paths[path][method] = operation;
  }

  const doc = {
    openapi: "3.0.3",
    info: { title: collection?.name ?? "Exported API", version: "1.0.0" },
    paths,
  };
  if (server) doc.servers = [{ url: server }];
  if (tagSet.size) doc.tags = [...tagSet].map((name) => ({ name }));
  if (Object.keys(schemes).length)
    doc.components = { securitySchemes: schemes };

  return JSON.stringify(doc, null, 2);
}
