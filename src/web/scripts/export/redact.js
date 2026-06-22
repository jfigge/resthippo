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
 * export/redact.js
 *
 * Shared secret-redaction policy for every interchange exporter (Postman,
 * Insomnia, OpenAPI, HAR). Authentication credentials and `secure` variables
 * are always treated as secrets: the field/key is preserved so the importing
 * tool keeps the structure (and prompts for the missing value), but the secret
 * value itself is stripped. Only the genuinely sensitive fields are blanked —
 * identifiers like username, clientId, URLs, and scope round-trip intact. This
 * is the long-standing behaviour of the Postman exporter, now factored out so
 * all exporters share one source of truth for what counts as a secret.
 *
 * The renderer is sandboxed and cannot import the main-process crypto helpers
 * (`src/app/store/crypto.js` `redact*`), so this module is the renderer-side
 * counterpart of that policy.
 */

/**
 * Redact a canonical variable list. Returns entries in the same
 * { name, value, secure } shape, but with the value blanked when `secure`.
 * Entries with an empty name are dropped; non-array input yields [].
 *
 * Callers map this neutral shape onto their own format (Postman key/value,
 * Insomnia environment data, …).
 *
 * @param {Array|undefined} list
 * @returns {{ name: string, value: string, secure: boolean }[]}
 */
export function redactVariables(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const v of list) {
    if (!v || typeof v !== "object") continue;
    const name = String(v.name ?? "").trim();
    if (!name) continue;
    const secure = Boolean(v.secure);
    out.push({ name, value: secure ? "" : String(v.value ?? ""), secure });
  }
  return out;
}

/**
 * Format-neutral, secret-free view of a request node's authentication, or null
 * when the request has no enabled auth. Secret fields (passwords, bearer/API-key
 * values, oauth2 clientSecret, AWS secret key & session token) are omitted
 * entirely; identifiers, placement, URLs, and non-secret config (username,
 * clientId, API-key name, NTLM domain/workstation, AWS accessKeyId/region/
 * service) are kept — by analogy to basic auth, the access key id is the
 * identifier and the secret access key the secret — so the receiving tool
 * retains the auth scheme and only needs the secret re-entered. Each exporter
 * maps this onto its own auth representation.
 *
 * @param {object} node  Rest Hippo request node
 * @returns {null
 *   | { type: "basic", username: string }
 *   | { type: "bearer" }
 *   | { type: "apikey", name: string, addTo: "header" | "query" }
 *   | { type: "digest", username: string }
 *   | { type: "ntlm", username: string, domain: string, workstation: string }
 *   | { type: "aws-iam", accessKeyId: string, region: string, service: string }
 *   | { type: "oauth1", consumerKey: string, signatureMethod: string, realm: string }
 *   | { type: "oauth2", grantType: string, clientId: string,
 *       accessTokenUrl: string, authUrl: string, scope: string }}
 */
export function redactedAuth(node) {
  if (!node?.authEnabled || !node.authType || node.authType === "none") {
    return null;
  }
  const { authType: type } = node;
  if (type === "basic") {
    return { type: "basic", username: node.authBasic?.username ?? "" };
  }
  if (type === "bearer") {
    return { type: "bearer" };
  }
  if (type === "apikey") {
    const a = node.authApiKey ?? {};
    return {
      type: "apikey",
      name: a.name ?? "",
      addTo: a.addTo === "query" ? "query" : "header",
    };
  }
  if (type === "digest") {
    return { type: "digest", username: node.authDigest?.username ?? "" };
  }
  if (type === "ntlm") {
    const n = node.authNtlm ?? {};
    return {
      type: "ntlm",
      username: n.username ?? "",
      domain: n.domain ?? "",
      workstation: n.workstation ?? "",
    };
  }
  if (type === "aws-iam") {
    const a = node.authAwsIam ?? {};
    return {
      type: "aws-iam",
      accessKeyId: a.accessKeyId ?? "",
      region: a.region ?? "",
      service: a.service ?? "",
    };
  }
  if (type === "oauth1") {
    // consumerKey is the identifier (kept); consumerSecret, token and
    // tokenSecret are the secrets (omitted). signatureMethod/realm are config.
    const o = node.authOAuth1 ?? {};
    return {
      type: "oauth1",
      consumerKey: o.consumerKey ?? "",
      signatureMethod: o.signatureMethod ?? "HMAC-SHA1",
      realm: o.realm ?? "",
    };
  }
  if (type === "oauth2") {
    const o = node.authOAuth2 ?? {};
    return {
      type: "oauth2",
      grantType: o.grantType ?? "authorization_code",
      clientId: o.clientId ?? "",
      accessTokenUrl: o.accessTokenUrl ?? "",
      authUrl: o.authUrl ?? "",
      scope: o.scope ?? "",
    };
  }
  return null;
}

// Header names whose value is always a live credential in a recorded exchange.
const SECRET_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
]);

/**
 * Whether a header's value should be blanked on export. HAR records a real HTTP
 * exchange, so an Authorization / Cookie / API-key header carries a live secret
 * that auth materialization injected at send time. Blank the value but keep the
 * name so the structure round-trips. Matching is case-insensitive and also
 * catches custom API-key headers (e.g. `X-API-Key`, `api_key`).
 *
 * @param {string} name  Header name
 * @returns {boolean}
 */
export function isSecretHeader(name) {
  const n = String(name ?? "")
    .toLowerCase()
    .trim();
  if (SECRET_HEADERS.has(n)) return true;
  return n.includes("api-key") || n.includes("apikey") || n.includes("api_key");
}

// Body-field names whose value is a credential, matched case-insensitively as a
// substring so client_secret, refresh_token, x-api-key, csrf_token, etc. are all
// caught. Deliberately tight to avoid blanking benign fields: identifiers like
// username, client_id, grant_type, scope, redirect_uri — and the single-use
// OAuth `code` — round-trip intact, mirroring redactedAuth's "keep the id, drop
// the secret".
const SECRET_FIELD_RE =
  /pass(?:word|wd)?|secret|token|credential|assertion|private[-_]?key|api[-_]?key|session[-_]?id/i;

/**
 * Whether a request/response body FIELD name carries a secret value.
 * @param {string} name
 * @returns {boolean}
 */
export function isSecretField(name) {
  return SECRET_FIELD_RE.test(String(name ?? ""));
}

/**
 * Deep-copy a parsed JSON value, blanking the value of any secret-named key.
 * `ctx.changed` is set true if anything was blanked, so the caller can leave a
 * secret-free body byte-for-byte untouched instead of reflowing its formatting.
 */
function redactJsonValue(val, ctx) {
  if (Array.isArray(val)) return val.map((v) => redactJsonValue(v, ctx));
  if (val && typeof val === "object") {
    // Null-prototype so a literal "__proto__" key from JSON.parse is copied as
    // plain data (and re-serialized faithfully) rather than mutating a prototype.
    const out = Object.create(null);
    for (const [k, v] of Object.entries(val)) {
      if (isSecretField(k)) {
        out[k] = "";
        ctx.changed = true;
      } else {
        out[k] = redactJsonValue(v, ctx);
      }
    }
    return out;
  }
  return val;
}

/**
 * Redact secret-bearing fields from a recorded request/response BODY before it
 * is written to an export (e.g. HAR `postData.text` / response `content.text`).
 * A recorded exchange materializes credentials into the body too — an OAuth
 * token-request (`grant_type=password&password=…&client_secret=…`) or a token
 * response (`{"access_token":"…","refresh_token":"…"}`) — which header/cookie
 * redaction alone misses.
 *
 * Only structured bodies we can parse are scrubbed: x-www-form-urlencoded and
 * JSON. Any other body (HTML, plain text, binary, raw multipart) can't be safely
 * located/parsed for secrets and is returned verbatim — callers exporting such
 * bodies should treat them as potentially sensitive.
 *
 * @param {string} mimeType  the body's Content-Type (any casing)
 * @param {string} text      the body text
 * @returns {string} the redacted body (or the original when nothing applies)
 */
export function redactBody(mimeType, text) {
  if (typeof text !== "string" || !text) return text;
  const mt = String(mimeType ?? "").toLowerCase();

  if (mt.includes("application/x-www-form-urlencoded")) {
    try {
      const pairs = [];
      let changed = false;
      for (const [k, v] of new URLSearchParams(text).entries()) {
        if (isSecretField(k)) {
          pairs.push([k, ""]);
          changed = true;
        } else {
          pairs.push([k, v]);
        }
      }
      return changed ? new URLSearchParams(pairs).toString() : text;
    } catch {
      return text;
    }
  }

  if (mt.includes("json")) {
    try {
      const ctx = { changed: false };
      const redacted = redactJsonValue(JSON.parse(text), ctx);
      // Leave a secret-free body exactly as recorded (preserve its formatting);
      // only reflow to compact JSON when something was actually blanked.
      return ctx.changed ? JSON.stringify(redacted) : text;
    } catch {
      return text; // not actually JSON — leave it untouched
    }
  }

  return text;
}
