"use strict";

function exportAuth(node) {
  if (!node.authEnabled || !node.authType || node.authType === "none") {
    return { type: "noauth" };
  }
  const { authType: type } = node;
  if (type === "basic") {
    const b = node.authBasic ?? {};
    return {
      type: "basic",
      basic: [
        { key: "username", value: b.username ?? "", type: "string" },
        { key: "password", value: b.password ?? "", type: "string" },
      ],
    };
  }
  if (type === "bearer") {
    return {
      type: "bearer",
      bearer: [
        { key: "token", value: node.authBearer?.token ?? "", type: "string" },
      ],
    };
  }
  if (type === "oauth2") {
    const o = node.authOAuth2 ?? {};
    return {
      type: "oauth2",
      oauth2: [
        {
          key: "grant_type",
          value: o.grantType ?? "authorization_code",
          type: "string",
        },
        { key: "clientId", value: o.clientId ?? "", type: "string" },
        { key: "clientSecret", value: o.clientSecret ?? "", type: "string" },
        {
          key: "accessTokenUrl",
          value: o.accessTokenUrl ?? "",
          type: "string",
        },
        { key: "authUrl", value: o.authUrl ?? "", type: "string" },
        { key: "scope", value: o.scope ?? "", type: "string" },
      ],
    };
  }
  return { type: "noauth" };
}

function exportBody(node) {
  const type = node.bodyType ?? "no-body";
  if (type === "no-body") return undefined;

  if (type === "json" || type === "xml" || type === "yaml" || type === "text") {
    const language = type === "text" ? "text" : type;
    return {
      mode: "raw",
      raw: node.bodyText ?? "",
      options: { raw: { language } },
    };
  }
  if (type === "form-urlencoded") {
    return {
      mode: "urlencoded",
      urlencoded: (node.bodyFormRows ?? []).map((r) => ({
        key: r.name ?? "",
        value: r.value ?? "",
        disabled: !r.enabled,
      })),
    };
  }
  if (type === "form-data") {
    return {
      mode: "formdata",
      formdata: (node.bodyFormRows ?? []).map((r) => ({
        key: r.name ?? "",
        value: r.value ?? "",
        disabled: !r.enabled,
      })),
    };
  }
  if (type === "file") {
    // Postman v2.1 schema: file payload lives under body.file.src, not body.src.
    // Earlier shapes were accepted by some tools but Postman itself drops the
    // top-level field silently on round-trip, losing the attachment.
    return { mode: "file", file: { src: node.bodyFilePath ?? null } };
  }
  return undefined;
}

function exportItem(node) {
  if (node.type === "collection") {
    return {
      name: node.name ?? "Folder",
      item: (node.children ?? []).map(exportItem).filter(Boolean),
    };
  }
  if (node.type === "request") {
    const req = {
      method: node.method ?? "GET",
      header: (node.headers ?? []).map((h) => ({
        key: h.name ?? "",
        value: h.value ?? "",
        disabled: !h.enabled,
      })),
      url: {
        raw: node.url ?? "",
        query: (node.params ?? []).map((p) => ({
          key: p.name ?? "",
          value: p.value ?? "",
          disabled: !p.enabled,
        })),
      },
      auth: exportAuth(node),
      description: node.notes ?? "",
    };
    const body = exportBody(node);
    if (body) req.body = body;
    return { name: node.name ?? "Request", request: req, response: [] };
  }
  return null;
}

/**
 * Serialize a wurl collection to a Postman v2.1 JSON string.
 *
 * @param {object}   collection  Wurl collection node (type: "collection")
 * @param {object}   [variables] Environment-level variables to embed
 * @returns {string} Formatted JSON
 */
export function exportToPostman(collection, variables = {}) {
  return JSON.stringify(
    {
      info: {
        // Prefer the wurl collection id so re-exports of the same collection
        // produce a stable `_postman_id`. Falling back to randomUUID still gives
        // Postman a unique value when the source has none.
        _postman_id: collection.id ?? crypto.randomUUID(),
        name: collection.name ?? "Exported Collection",
        schema:
          "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
      },
      item: (collection.children ?? []).map(exportItem).filter(Boolean),
      variable: Object.entries(variables).map(([key, value]) => ({
        key,
        value: String(value),
      })),
    },
    null,
    2,
  );
}
