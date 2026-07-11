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

/**
 * import/shape.js
 *
 * Shared canonical-shape builders for every interchange importer (Postman,
 * Insomnia, …). The Rest Hippo request shape — the field names and structure a parsed
 * request must have — is identical across formats; only the *source* field names
 * differ. This module owns that canonical shape so it cannot drift between
 * importers: each importer maps its format onto the neutral descriptors here and
 * the builders emit the Rest Hippo fields.
 *
 * It is the import-side counterpart of `export/redact.js`: there, one neutral
 * shape (`redactedAuth`) is mapped *onto* each export format; here, each import
 * format is mapped *into* one neutral descriptor and the builders produce the
 * canonical Rest Hippo shape. Genuinely format-specific concerns (Postman's `mode`
 * vs. Insomnia's `mimeType`, multi-file fields, disabled-auth conventions) stay
 * in the per-format adapters; everything below is what they have in common.
 */

/** OAuth 1.0a signature methods Rest Hippo supports; others fall back to HMAC-SHA1. */
const OAUTH1_SIG_METHODS = new Set(["HMAC-SHA1", "HMAC-SHA256", "PLAINTEXT"]);

/**
 * Coerce a value to an array of plain objects. A malformed-but-parseable import
 * may carry a non-array where a list is expected, or null elements inside it —
 * filtering here keeps every per-format parser to its "never throws on
 * malformed-but-parseable input" contract (only `parseImport` itself throws).
 *
 * @param {*} arr
 * @returns {object[]}
 */
export function objRows(arr) {
  return Array.isArray(arr)
    ? arr.filter((x) => x && typeof x === "object")
    : [];
}

/**
 * Build the canonical Rest Hippo auth fields from a neutral, format-agnostic auth
 * descriptor. Returns the no-auth shape for a null/typeless/unsupported
 * descriptor, so callers can pass `null` for "no auth" and let unsupported
 * schemes fall through harmlessly.
 *
 * This is the import-side mirror of `export/redact.js`'s `redactedAuth`: it
 * accepts the same neutral descriptor (plus the secret fields a third-party
 * file may carry — Rest Hippo's own exports blank them but keep the structure).
 *
 * Descriptor:
 *   null
 *   | { type: "basic",   username?, password? }
 *   | { type: "bearer",  token? }
 *   | { type: "apikey",  name?, value?, addTo? }
 *   | { type: "digest",  username?, password? }
 *   | { type: "ntlm",    username?, password?, domain?, workstation? }
 *   | { type: "aws-iam", accessKeyId?, secretAccessKey?, region?, service?,
 *       sessionToken? }
 *   | { type: "oauth1",  consumerKey?, consumerSecret?, token?, tokenSecret?,
 *       signatureMethod?, realm? }
 *   | { type: "oauth2",  grantType?, clientId?, clientSecret?,
 *       accessTokenUrl?, authUrl?, scope? }
 *
 * @param {object|null} d
 * @returns {object} Rest Hippo request auth fields
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
  if (d.type === "apikey") {
    return {
      authEnabled: true,
      authType: "apikey",
      authApiKey: {
        name: d.name ?? "",
        value: d.value ?? "",
        addTo: d.addTo === "query" ? "query" : "header",
      },
    };
  }
  if (d.type === "digest") {
    return {
      authEnabled: true,
      authType: "digest",
      authDigest: {
        username: d.username ?? "",
        password: d.password ?? "",
      },
    };
  }
  if (d.type === "ntlm") {
    return {
      authEnabled: true,
      authType: "ntlm",
      authNtlm: {
        username: d.username ?? "",
        password: d.password ?? "",
        domain: d.domain ?? "",
        workstation: d.workstation ?? "",
      },
    };
  }
  if (d.type === "aws-iam") {
    return {
      authEnabled: true,
      authType: "aws-iam",
      authAwsIam: {
        accessKeyId: d.accessKeyId ?? "",
        secretAccessKey: d.secretAccessKey ?? "",
        region: d.region ?? "",
        service: d.service ?? "",
        sessionToken: d.sessionToken ?? "",
      },
    };
  }
  if (d.type === "oauth1") {
    return {
      authEnabled: true,
      authType: "oauth1",
      authOAuth1: {
        consumerKey: d.consumerKey ?? "",
        consumerSecret: d.consumerSecret ?? "",
        token: d.token ?? "",
        tokenSecret: d.tokenSecret ?? "",
        signatureMethod: OAUTH1_SIG_METHODS.has(d.signatureMethod)
          ? d.signatureMethod
          : "HMAC-SHA1",
        realm: d.realm ?? "",
      },
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

/**
 * Map an `Authorization` header value onto a neutral auth descriptor for
 * `buildAuth`, or null if the scheme isn't one Rest Hippo surfaces in its Auth tab.
 * Shared by the cURL and HAR importers so a captured `Authorization: Bearer …`
 * / `Basic …` becomes editable auth rather than an opaque header. Anything else
 * (Digest, Negotiate, AWS sigv4, …) returns null so the caller keeps it as a
 * plain header.
 *
 * @param {string} value  Raw header value (e.g. "Bearer abc123")
 * @returns {object|null}  Neutral descriptor for `buildAuth`, or null
 */
export function authFromHeaderValue(value) {
  if (typeof value !== "string") return null;
  const m = value.match(/^\s*(\S+)\s+([\s\S]+)$/);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  const rest = m[2].trim();
  if (scheme === "bearer") return { type: "bearer", token: rest };
  if (scheme === "basic") {
    let decoded;
    try {
      decoded = atob(rest);
    } catch {
      return null; // not valid base64 — leave it as a header
    }
    const idx = decoded.indexOf(":");
    return {
      type: "basic",
      username: idx >= 0 ? decoded.slice(0, idx) : decoded,
      password: idx >= 0 ? decoded.slice(idx + 1) : "",
    };
  }
  return null;
}

/**
 * Split a URL into its base (everything before `?`) and the canonical query-param
 * rows parsed from the query string. Rest Hippo stores the base URL and the query rows
 * separately, then re-assembles them at send time (`buildRequestPayload`); a URL
 * that kept its `?query` *and* repeated it in `params` would be sent twice, so
 * importers strip the query here. The fragment (`#…`, never sent) is dropped.
 *
 * @param {string} rawUrl
 * @returns {{ base: string, params: { enabled: boolean, name: string, value: string }[] }}
 */
export function splitUrlQuery(rawUrl) {
  const url = rawUrl ?? "";
  const qIdx = url.indexOf("?");
  if (qIdx < 0) return { base: url, params: [] };
  const base = url.slice(0, qIdx);
  let query = url.slice(qIdx + 1);
  const hashIdx = query.indexOf("#");
  if (hashIdx >= 0) query = query.slice(0, hashIdx);
  return { base, params: parseUrlencodedRows(query) };
}

/**
 * Parse an `application/x-www-form-urlencoded` string (a query string or a form
 * body) into canonical `{ enabled, name, value }` rows. `URLSearchParams` owns
 * the percent / `+` decoding so values round-trip through `buildRequestPayload`'s
 * re-encoding. Shared by the cURL and HAR importers.
 *
 * @param {string} text
 * @returns {{ enabled: boolean, name: string, value: string }[]}
 */
export function parseUrlencodedRows(text) {
  return [...new URLSearchParams(text ?? "").entries()].map(
    ([name, value]) => ({ enabled: true, name, value }),
  );
}

/**
 * Derive a readable request name from a method + URL (e.g. "POST /login"): the
 * URL path, or the host for a root path, falling back to the raw URL when it
 * isn't parseable. Shared by the cURL and HAR importers.
 *
 * @param {string} method
 * @param {string} url
 * @returns {string}
 */
export function requestName(method, url) {
  try {
    const u = new URL(url);
    const path = u.pathname && u.pathname !== "/" ? u.pathname : u.host;
    return `${method} ${path}`;
  } catch {
    return `${method} ${url || "Request"}`.trim();
  }
}

/** The canonical "no body" shape. */
export function noBody() {
  return { bodyType: "no-body" };
}

/**
 * A raw-text body (json / xml / yaml / text). The caller resolves its format's
 * language/mime onto one of the Rest Hippo raw `bodyType`s.
 *
 * @param {string} bodyType
 * @param {string|undefined} text
 */
export function rawBody(bodyType, text) {
  return { bodyType, bodyText: text ?? "" };
}

/**
 * Map a Content-Type / mimeType onto a Rest Hippo *raw* body (json / xml / yaml), or
 * null when the type isn't one of those raw languages — the caller then applies
 * its own fallback (plain text, a form parse, or "no body"). Shared by the cURL /
 * HAR / Insomnia importers so the language sniff can't drift.
 *
 * @param {string} contentType
 * @param {string|undefined} text
 * @returns {{ bodyType: string, bodyText: string } | null}
 */
export function rawBodyFromMime(contentType, text) {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("json")) return rawBody("json", text);
  if (ct.includes("xml")) return rawBody("xml", text);
  if (ct.includes("yaml") || ct.includes("yml")) return rawBody("yaml", text);
  return null;
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

/** Normalize GraphQL variables to Rest Hippo's string form. @see graphqlBody */
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
