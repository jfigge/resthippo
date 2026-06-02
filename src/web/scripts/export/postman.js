"use strict";

// Authentication credentials are always treated as secrets and redacted on
// export: the field is preserved (so the importing tool keeps the auth scheme
// and prompts for the missing value) but the secret itself is stripped. Only
// the genuinely sensitive fields are blanked — identifiers like username,
// clientId, URLs, and scope round-trip intact.
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
        { key: "password", value: "", type: "string" },
      ],
    };
  }
  if (type === "bearer") {
    return {
      type: "bearer",
      bearer: [{ key: "token", value: "", type: "string" }],
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
        { key: "clientSecret", value: "", type: "string" },
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

/**
 * Convert a wurl variable list to Postman `variable` entries.
 *
 * Folder variables are stored canonically as an array of
 * { name, value, secure }; Postman wants { key, value }. Entries with an empty
 * name are skipped. Returns [] for missing/empty input so callers can drop the
 * field entirely when there is nothing to emit.
 *
 * Secure variables are redacted: the key is preserved so the collection
 * structure round-trips, but the secret value is stripped and the entry is
 * flagged as a Postman secret (`type: "secret"`) so the receiving tool masks
 * it rather than treating the empty value as intentional.
 *
 * @param {Array|undefined} list
 * @returns {{ key: string, value: string, type?: string }[]}
 */
function exportVariables(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const v of list) {
    if (!v || typeof v !== "object") continue;
    const key = String(v.name ?? "").trim();
    if (!key) continue;
    if (v.secure) {
      out.push({ key, value: "", type: "secret" });
    } else {
      out.push({ key, value: String(v.value ?? "") });
    }
  }
  return out;
}

function exportItem(node) {
  if (node.type === "collection") {
    const item = {
      name: node.name ?? "Folder",
      item: (node.children ?? []).map(exportItem).filter(Boolean),
    };
    // Postman v2.1 item-groups (folders) carry their own `variable` array;
    // include it so folder-scoped variables survive the round-trip.
    const variable = exportVariables(node.variables);
    if (variable.length) item.variable = variable;
    return item;
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
 * @param {object} collection  Wurl collection node (type: "collection")
 * @param {Array}  [variables] Collection-level variables in canonical array
 *                             shape ({ name, value, secure }); secure entries
 *                             are redacted on export.
 * @returns {string} Formatted JSON
 */
export function exportToPostman(collection, variables = []) {
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
      variable: exportVariables(variables),
    },
    null,
    2,
  );
}
