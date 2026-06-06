"use strict";

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

function parseAuth(auth) {
  if (!auth || auth.type === "noauth")
    return { authEnabled: false, authType: "none" };

  const { type } = auth;
  if (type === "basic") {
    const byKey = _kvArray(auth.basic);
    return {
      authEnabled: true,
      authType: "basic",
      authBasic: {
        username: byKey.username ?? "",
        password: byKey.password ?? "",
      },
    };
  }
  if (type === "bearer") {
    const byKey = _kvArray(auth.bearer);
    return {
      authEnabled: true,
      authType: "bearer",
      authBearer: { token: byKey.token ?? "" },
    };
  }
  if (type === "oauth2") {
    const byKey = _kvArray(auth.oauth2);
    return {
      authEnabled: true,
      authType: "oauth2",
      authOAuth2: {
        grantType: byKey.grant_type ?? "authorization_code",
        clientId: byKey.clientId ?? "",
        clientSecret: byKey.clientSecret ?? "",
        accessTokenUrl: byKey.accessTokenUrl ?? "",
        authUrl: byKey.authUrl ?? "",
        scope: byKey.scope ?? "",
      },
    };
  }
  return { authEnabled: false, authType: "none" };
}

function _kvArray(arr) {
  if (!Array.isArray(arr)) return {};
  return Object.fromEntries(arr.map((i) => [i.key, i.value ?? ""]));
}

function parseBody(body) {
  if (!body || body.mode === "none") return { bodyType: "no-body" };

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
      return { bodyType: type, bodyText: body.raw ?? "" };
    }
    case "urlencoded":
      return {
        bodyType: "form-urlencoded",
        bodyFormRows: (body.urlencoded ?? []).map((r) => ({
          enabled: !r.disabled,
          name: r.key ?? "",
          value: r.value ?? "",
        })),
      };
    case "formdata":
      return {
        bodyType: "form-data",
        bodyFormRows: (body.formdata ?? []).map((r) => {
          if (r.type === "file") {
            // Postman's `src` is a path string (or an array of paths for a
            // multi-file field — we take the first; wurl is one file per row).
            const filePath = Array.isArray(r.src)
              ? (r.src[0] ?? "")
              : (r.src ?? "");
            return {
              enabled: !r.disabled,
              name: r.key ?? "",
              value: "",
              kind: "file",
              filePath,
              fileName: filePath.split(/[\\/]/).pop() ?? "",
              contentType: r.contentType ?? "",
            };
          }
          return {
            enabled: !r.disabled,
            name: r.key ?? "",
            value: r.value ?? "",
          };
        }),
      };
    case "graphql": {
      const gql = body.graphql ?? {};
      // Postman variables is usually a JSON string, but tolerate an object.
      const variables =
        typeof gql.variables === "string"
          ? gql.variables
          : gql.variables != null
            ? JSON.stringify(gql.variables, null, 2)
            : "";
      return {
        bodyType: "graphql",
        bodyGraphql: { query: gql.query ?? "", variables },
      };
    }
    case "file":
      return { bodyType: "file", bodyFilePath: body.src ?? "" };
    default:
      return { bodyType: "no-body" };
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

function parseItem(item) {
  if (Array.isArray(item.item)) {
    return {
      id: crypto.randomUUID(),
      type: "collection",
      name: item.name ?? "Folder",
      variables: {},
      children: item.item.map(parseItem).filter(Boolean),
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
    ...parseBody(req.body),
    ...parseAuth(req.auth),
  };
}

/**
 * Parse a Postman v2.0 / v2.1 collection export.
 *
 * @param {object} data  Parsed JSON
 * @returns {{ collection: object, variables: object }}
 */
export function parsePostman(data) {
  // Support both top-level and wrapped ({ collection: { ... } }) formats
  const root = data.collection ?? data;
  const info = root.info ?? {};
  const items = root.item ?? [];
  const variables = {};

  for (const v of root.variable ?? []) {
    if (v.key) variables[v.key] = v.value ?? "";
  }

  return {
    collection: {
      id: crypto.randomUUID(),
      type: "collection",
      name: info.name ?? "Imported Collection",
      variables: {},
      children: items.map(parseItem).filter(Boolean),
    },
    variables,
  };
}
