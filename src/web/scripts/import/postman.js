"use strict";

import {
  buildAuth,
  noBody,
  rawBody,
  fileBody,
  graphqlBody,
  formBody,
} from "./shape.js";

function parseUrl(url) {
  if (typeof url === "string") return url;
  if (!url) return "";
  if (url.raw) return url.raw;
  const proto = url.protocol ? `${url.protocol}://` : "";
  const host = Array.isArray(url.host) ? url.host.join(".") : (url.host ?? "");
  const pathStr = Array.isArray(url.path)
    ? "/" + url.path.map((s) => s ?? "").join("/")
    : "";
  return proto + host + pathStr;
}

function parseQueryFromUrl(url) {
  if (!url) return [];
  // Postman URLs come in two shapes: a bare string ("https://api.example.com?x=1")
  // or a structured object with a separate `query` array. The structured form
  // already separates query params; the string form does not, so parse it here
  // — otherwise string-form URLs lose all their query params on import.
  if (typeof url === "string") {
    try {
      // Provide a base so relative or template-prefixed URLs still parse.
      const parsed = new URL(url, "http://_/");
      return [...parsed.searchParams.entries()].map(([name, value]) => ({
        enabled: true,
        name,
        value,
      }));
    } catch {
      return [];
    }
  }
  if (typeof url !== "object") return [];
  return (url.query ?? []).map((q) => ({
    enabled: !q.disabled,
    name: q.key ?? "",
    value: q.value ?? "",
  }));
}

// Map Postman's auth representation onto the neutral descriptor consumed by the
// shared `buildAuth` (which owns the canonical wurl auth shape). Postman stores
// each scheme's fields as a key/value array; we read those out by key here.
function parseAuth(auth) {
  if (!auth || auth.type === "noauth") return buildAuth(null);

  const { type } = auth;
  if (type === "basic") {
    const byKey = _kvArray(auth.basic);
    return buildAuth({
      type: "basic",
      username: byKey.username,
      password: byKey.password,
    });
  }
  if (type === "bearer") {
    const byKey = _kvArray(auth.bearer);
    return buildAuth({ type: "bearer", token: byKey.token });
  }
  if (type === "oauth2") {
    const byKey = _kvArray(auth.oauth2);
    return buildAuth({
      type: "oauth2",
      grantType: byKey.grant_type,
      clientId: byKey.clientId,
      clientSecret: byKey.clientSecret,
      accessTokenUrl: byKey.accessTokenUrl,
      authUrl: byKey.authUrl,
      scope: byKey.scope,
    });
  }
  return buildAuth(null);
}

function _kvArray(arr) {
  if (!Array.isArray(arr)) return {};
  return Object.fromEntries(arr.map((i) => [i.key, i.value ?? ""]));
}

// Map Postman's `mode`-tagged body onto the shared canonical body builders.
// `warnings` (optional) collects non-fatal lossy conversions.
function parseBody(body, warnings) {
  if (!body || body.mode === "none") return noBody();

  switch (body.mode) {
    case "raw": {
      const lang = body.options?.raw?.language ?? "text";
      const type =
        lang === "json"
          ? "json"
          : lang === "xml"
            ? "xml"
            : lang === "yaml"
              ? "yaml"
              : "text";
      return rawBody(type, body.raw);
    }
    case "urlencoded":
      return formBody(
        "form-urlencoded",
        (body.urlencoded ?? []).map((r) => ({
          enabled: !r.disabled,
          name: r.key,
          value: r.value,
        })),
      );
    case "formdata":
      return formBody(
        "form-data",
        (body.formdata ?? []).map((r) => {
          if (r.type === "file") {
            // Postman's `src` is a path string, or an array of paths for a
            // multi-file field. wurl is one file per row, so we take the first
            // and warn that the rest were dropped.
            if (Array.isArray(r.src) && r.src.length > 1) {
              warnings?.push(
                `Form-data field "${r.key ?? ""}" listed ${r.src.length} files; ` +
                  `only the first was imported (wurl supports one file per field).`,
              );
            }
            const filePath = Array.isArray(r.src)
              ? (r.src[0] ?? "")
              : (r.src ?? "");
            return {
              enabled: !r.disabled,
              name: r.key,
              file: { path: filePath, contentType: r.contentType },
            };
          }
          return { enabled: !r.disabled, name: r.key, value: r.value };
        }),
      );
    case "graphql": {
      const gql = body.graphql ?? {};
      return graphqlBody(gql.query, gql.variables);
    }
    case "file":
      return fileBody(body.src);
    default:
      return noBody();
  }
}

function _descriptionText(desc) {
  if (!desc) return "";
  if (typeof desc === "string") return desc;
  return desc.content ?? "";
}

/** Read Postman's url.variable (path variables) into wurl path params. */
function parsePathVars(url) {
  if (!url || typeof url !== "object" || !Array.isArray(url.variable))
    return [];
  return url.variable.map((v) => ({
    id: crypto.randomUUID(),
    name: v.key ?? "",
    value: v.value ?? "",
  }));
}

function parseItem(item, warnings) {
  if (Array.isArray(item.item)) {
    return {
      id: crypto.randomUUID(),
      type: "collection",
      name: item.name ?? "Folder",
      variables: [],
      children: item.item.map((it) => parseItem(it, warnings)).filter(Boolean),
    };
  }

  const req = item.request ?? {};
  return {
    id: crypto.randomUUID(),
    type: "request",
    name: item.name ?? "Request",
    method: (req.method ?? "GET").toUpperCase(),
    url: parseUrl(req.url),
    params: parseQueryFromUrl(req.url),
    pathParams: parsePathVars(req.url),
    headers: (req.header ?? []).map((h) => ({
      enabled: !h.disabled,
      name: h.key ?? "",
      value: h.value ?? "",
    })),
    notes: _descriptionText(req.description),
    ...parseBody(req.body, warnings),
    ...parseAuth(req.auth),
  };
}

/**
 * Parse a Postman v2.0 / v2.1 collection export.
 *
 * @param {object} data  Parsed JSON
 * @returns {{ collection: object,
 *   variables: { name: string, value: string, secure: boolean }[],
 *   warnings: string[] }}
 *   Variables use the canonical array shape. Postman flags a secret collection
 *   variable with type:"secret" (its value is exported blank), mapped to secure.
 *   `warnings` reports non-fatal lossy conversions; see `parseImport`.
 */
export function parsePostman(data) {
  // Support both top-level and wrapped ({ collection: { ... } }) formats
  const root = data.collection ?? data;
  const info = root.info ?? {};
  const items = root.item ?? [];
  const variables = [];
  const warnings = [];

  for (const v of root.variable ?? []) {
    if (v.key) {
      variables.push({
        name: v.key,
        value: v.value ?? "",
        secure: v.type === "secret",
      });
    }
  }

  return {
    collection: {
      id: crypto.randomUUID(),
      type: "collection",
      name: info.name ?? "Imported Collection",
      variables: [],
      children: items.map((it) => parseItem(it, warnings)).filter(Boolean),
    },
    variables,
    warnings,
  };
}
