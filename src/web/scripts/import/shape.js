"use strict";

/**
 * import/shape.js
 *
 * Shared canonical-shape builders for every interchange importer (Postman,
 * Insomnia, …). The wurl request shape — the field names and structure a parsed
 * request must have — is identical across formats; only the *source* field names
 * differ. This module owns that canonical shape so it cannot drift between
 * importers: each importer maps its format onto the neutral descriptors here and
 * the builders emit the wurl fields.
 *
 * It is the import-side counterpart of `export/redact.js`: there, one neutral
 * shape (`redactedAuth`) is mapped *onto* each export format; here, each import
 * format is mapped *into* one neutral descriptor and the builders produce the
 * canonical wurl shape. Genuinely format-specific concerns (Postman's `mode`
 * vs. Insomnia's `mimeType`, multi-file fields, disabled-auth conventions) stay
 * in the per-format adapters; everything below is what they have in common.
 */

/**
 * Build the canonical wurl auth fields from a neutral, format-agnostic auth
 * descriptor. Returns the no-auth shape for a null/typeless/unsupported
 * descriptor, so callers can pass `null` for "no auth" and let unsupported
 * schemes fall through harmlessly.
 *
 * Descriptor:
 *   null
 *   | { type: "basic",  username?, password? }
 *   | { type: "bearer", token? }
 *   | { type: "oauth2", grantType?, clientId?, clientSecret?,
 *       accessTokenUrl?, authUrl?, scope? }
 *
 * @param {object|null} d
 * @returns {object} wurl request auth fields
 */
export function buildAuth(d) {
  if (!d || !d.type) return { authEnabled: false, authType: "none" };

  if (d.type === "basic") {
    return {
      authEnabled: true,
      authType: "basic",
      authBasic: {
        username: d.username ?? "",
        password: d.password ?? "",
      },
    };
  }
  if (d.type === "bearer") {
    return {
      authEnabled: true,
      authType: "bearer",
      authBearer: { token: d.token ?? "" },
    };
  }
  if (d.type === "oauth2") {
    return {
      authEnabled: true,
      authType: "oauth2",
      authOAuth2: {
        grantType: d.grantType ?? "authorization_code",
        clientId: d.clientId ?? "",
        clientSecret: d.clientSecret ?? "",
        accessTokenUrl: d.accessTokenUrl ?? "",
        authUrl: d.authUrl ?? "",
        scope: d.scope ?? "",
      },
    };
  }
  return { authEnabled: false, authType: "none" };
}

/** The canonical "no body" shape. */
export function noBody() {
  return { bodyType: "no-body" };
}

/**
 * A raw-text body (json / xml / yaml / text). The caller resolves its format's
 * language/mime onto one of the wurl raw `bodyType`s.
 *
 * @param {string} bodyType
 * @param {string|undefined} text
 */
export function rawBody(bodyType, text) {
  return { bodyType, bodyText: text ?? "" };
}

/** A single-file body referencing a path on disk (no inline content). */
export function fileBody(filePath) {
  return { bodyType: "file", bodyFilePath: filePath ?? "" };
}

/**
 * A GraphQL body. `variables` may arrive as a JSON string (kept verbatim), an
 * object/array (pretty-printed to a JSON string), or null/undefined (→ ""). Both
 * Postman and Insomnia exhibit all three, so the normalization lives here.
 *
 * @param {string|undefined} query
 * @param {*} variables
 */
export function graphqlBody(query, variables) {
  return {
    bodyType: "graphql",
    bodyGraphql: {
      query: query ?? "",
      variables: normalizeGraphqlVariables(variables),
    },
  };
}

/** Normalize GraphQL variables to wurl's string form. @see graphqlBody */
export function normalizeGraphqlVariables(variables) {
  if (variables == null) return "";
  return typeof variables === "string"
    ? variables
    : JSON.stringify(variables, null, 2);
}

/**
 * A form body (form-urlencoded or form-data). Rows are neutral descriptors; the
 * builder owns the canonical row shape — including the file/text distinction,
 * the blanked `value` on file rows, and `fileName` derivation from the path — so
 * it stays identical across formats.
 *
 * Neutral row:
 *   { enabled, name, value? }                         // text field
 *   { enabled, name, file: { path, contentType? } }   // file field
 *
 * @param {string} bodyType  "form-urlencoded" | "form-data"
 * @param {Array} rows
 */
export function formBody(bodyType, rows) {
  return { bodyType, bodyFormRows: rows.map(buildFormRow) };
}

function buildFormRow(row) {
  if (row.file) {
    const path = row.file.path ?? "";
    return {
      enabled: row.enabled,
      name: row.name ?? "",
      value: "",
      kind: "file",
      filePath: path,
      fileName: path.split(/[\\/]/).pop() ?? "",
      contentType: row.file.contentType ?? "",
    };
  }
  return { enabled: row.enabled, name: row.name ?? "", value: row.value ?? "" };
}
