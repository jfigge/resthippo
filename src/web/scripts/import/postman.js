"use strict";

import {
  buildAuth,
  noBody,
  rawBody,
  fileBody,
  graphqlBody,
  formBody,
  splitUrlQuery,
} from "./shape.js";

/** Assemble Postman's string- or object-form URL into a single URL string. */
function rawUrlString(url) {
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

// Base URL with the query stripped. Rest Hippo stores the base and the query rows
// separately and re-assembles them at send time (buildRequestPayload), so
// leaving the query on the URL *and* in `params` would send it twice. Mirrors
// the cURL / HAR importers, which split the query out the same way.
function parseUrl(url) {
  return splitUrlQuery(rawUrlString(url)).base;
}

function parseQueryFromUrl(url) {
  if (!url) return [];
  // Postman's structured form carries an explicit `query` array that preserves
  // each param's disabled flag — authoritative when present.
  if (typeof url === "object" && Array.isArray(url.query) && url.query.length) {
    return url.query.map((q) => ({
      enabled: !q.disabled,
      name: q.key ?? "",
      value: q.value ?? "",
    }));
  }
  // String form (or a structured form whose raw URL carries the query but has no
  // separate `query` array): parse the query out of the assembled URL string.
  return splitUrlQuery(rawUrlString(url)).params;
}

// Map Postman's auth representation onto the neutral descriptor consumed by the
// shared `buildAuth` (which owns the canonical Rest Hippo auth shape). Postman stores
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
  if (type === "apikey") {
    const byKey = _kvArray(auth.apikey);
    return buildAuth({
      type: "apikey",
      name: byKey.key,
      value: byKey.value,
      addTo: byKey.in === "query" ? "query" : "header",
    });
  }
  if (type === "digest") {
    const byKey = _kvArray(auth.digest);
    return buildAuth({
      type: "digest",
      username: byKey.username,
      password: byKey.password,
    });
  }
  if (type === "ntlm") {
    const byKey = _kvArray(auth.ntlm);
    return buildAuth({
      type: "ntlm",
      username: byKey.username,
      password: byKey.password,
      domain: byKey.domain,
      workstation: byKey.workstation,
    });
  }
  // Postman names AWS SigV4 "awsv4".
  if (type === "awsv4") {
    const byKey = _kvArray(auth.awsv4);
    return buildAuth({
      type: "aws-iam",
      accessKeyId: byKey.accessKey,
      secretAccessKey: byKey.secretKey,
      sessionToken: byKey.sessionToken,
      region: byKey.region,
      service: byKey.service,
    });
  }
  if (type === "oauth1") {
    const byKey = _kvArray(auth.oauth1);
    return buildAuth({
      type: "oauth1",
      consumerKey: byKey.consumerKey,
      consumerSecret: byKey.consumerSecret,
      token: byKey.token,
      tokenSecret: byKey.tokenSecret,
      signatureMethod: byKey.signatureMethod,
      realm: byKey.realm,
    });
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
            // multi-file field. Rest Hippo is one file per row, so we take the first
            // and warn that the rest were dropped.
            if (Array.isArray(r.src) && r.src.length > 1) {
              warnings?.push(
                `Form-data field "${r.key ?? ""}" listed ${r.src.length} files; ` +
                  `only the first was imported (Rest Hippo supports one file per field).`,
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

/** Read Postman's url.variable (path variables) into Rest Hippo path params. */
function parsePathVars(url) {
  if (!url || typeof url !== "object" || !Array.isArray(url.variable))
    return [];
  return url.variable.map((v) => ({
    id: crypto.randomUUID(),
    name: v.key ?? "",
    value: v.value ?? "",
  }));
}

/** Map a Postman `variable` array to the canonical { name, value, secure } shape. */
function parseVariables(list) {
  const out = [];
  for (const v of list ?? []) {
    if (v.key)
      out.push({
        name: v.key,
        value: v.value ?? "",
        secure: v.type === "secret",
      });
  }
  return out;
}

function parseItem(item, warnings) {
  if (Array.isArray(item.item)) {
    return {
      id: crypto.randomUUID(),
      type: "collection",
      name: item.name ?? "Folder",
      // Folder-scoped variables survive the round-trip (export writes them too).
      variables: parseVariables(item.variable),
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
  const warnings = [];
  const variables = parseVariables(root.variable);

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
