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

/**
 * oauth1.js — OAuth 1.0a request signing (RFC 5849).
 *
 * Pure, dependency-free helpers used by the main process to add a one-shot
 * `Authorization: OAuth …` header to an outgoing request, mirroring the way AWS
 * SigV4 is applied at the http:execute boundary. OAuth 1.0a signs the request
 * line + normalised parameters, so — like SigV4 — it must run in the main
 * process where the final method, URL (including query) and body are known.
 *
 * Supports the three signature methods OAuth 1.0a defines:
 *   • HMAC-SHA1   (the de-facto default; RFC 5849 §3.4.2)
 *   • HMAC-SHA256 (RFC 5849bis / widely deployed extension)
 *   • PLAINTEXT   (§3.4.4 — secrets sent in the clear; HTTPS only)
 *
 * `nonce` and `timestamp` are injectable so the output is deterministic under
 * test; in production they default to 16 random bytes and the current epoch.
 */
"use strict";

const crypto = require("crypto");

/**
 * Percent-encode per RFC 5849 §3.6 (RFC 3986 unreserved set only):
 * leave A-Z a-z 0-9 - . _ ~ unencoded, escape everything else. Builds on
 * encodeURIComponent, which already matches except for the four sub-delims
 * `! * ' ( )` it leaves intact.
 *
 * @param {string} value
 * @returns {string}
 */
function pctEncode(value) {
  return encodeURIComponent(String(value ?? "")).replace(
    /[!*'()]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/**
 * Normalise the request base URI (RFC 5849 §3.4.1.2): lower-cased scheme +
 * host, default port (80/443) omitted, no query or fragment.
 *
 * @param {string} url
 * @returns {string}
 */
function baseStringUri(url) {
  const u = new URL(url);
  const scheme = u.protocol.replace(/:$/, "").toLowerCase();
  const host = u.hostname.toLowerCase();
  const isDefaultPort =
    !u.port ||
    (scheme === "http" && u.port === "80") ||
    (scheme === "https" && u.port === "443");
  const port = isDefaultPort ? "" : `:${u.port}`;
  return `${scheme}://${host}${port}${u.pathname}`;
}

/**
 * Build the normalised parameter string (RFC 5849 §3.4.1.3): percent-encode
 * every key and value, sort by encoded key then encoded value, and join as
 * `k=v` pairs with `&`.
 *
 * @param {Array<[string,string]>} params  - [key, value] tuples
 * @returns {string}
 */
function normalizeParams(params) {
  return params
    .map(([k, v]) => [pctEncode(k), pctEncode(v)])
    .sort((a, b) =>
      a[0] < b[0]
        ? -1
        : a[0] > b[0]
          ? 1
          : a[1] < b[1]
            ? -1
            : a[1] > b[1]
              ? 1
              : 0,
    )
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

/**
 * Build the signature base string (RFC 5849 §3.4.1.1):
 *   UPPER(method) & pctEncode(baseUri) & pctEncode(normalizedParams)
 *
 * The collected params are every query-string param, the supplied oauth_*
 * params, and (for an `application/x-www-form-urlencoded` body) the body params
 * — but never `realm` or `oauth_signature`.
 *
 * @param {object} opts
 * @param {string} opts.method
 * @param {string} opts.url
 * @param {Record<string,string>} opts.oauthParams   - oauth_* params (no signature)
 * @param {Array<[string,string]>} [opts.bodyParams] - form-urlencoded body params
 * @returns {string}
 */
function signatureBaseString({ method, url, oauthParams, bodyParams = [] }) {
  const u = new URL(url);
  /** @type {Array<[string,string]>} */
  const params = [];
  for (const [k, v] of u.searchParams.entries()) params.push([k, v]);
  for (const [k, v] of Object.entries(oauthParams)) params.push([k, String(v)]);
  for (const [k, v] of bodyParams) params.push([k, v]);

  return [
    String(method).toUpperCase(),
    pctEncode(baseStringUri(url)),
    pctEncode(normalizeParams(params)),
  ].join("&");
}

/**
 * Compute the oauth_signature value for the given signature method.
 *
 * @param {string} method        - signature method (HMAC-SHA1 | HMAC-SHA256 | PLAINTEXT)
 * @param {string} baseString    - signature base string (ignored for PLAINTEXT)
 * @param {string} signingKey    - pctEncode(consumerSecret)&pctEncode(tokenSecret)
 * @returns {string}
 */
function computeSignature(method, baseString, signingKey) {
  switch (String(method).toUpperCase()) {
    case "PLAINTEXT":
      return signingKey;
    case "HMAC-SHA256":
      return crypto
        .createHmac("sha256", signingKey)
        .update(baseString)
        .digest("base64");
    case "HMAC-SHA1":
    default:
      return crypto
        .createHmac("sha1", signingKey)
        .update(baseString)
        .digest("base64");
  }
}

/**
 * Build an `Authorization: OAuth …` header value for a request.
 *
 * Returns null when no consumer key is configured, so the caller can leave the
 * request unsigned rather than send a malformed header.
 *
 * @param {object} opts
 * @param {string}  opts.method
 * @param {string}  opts.url
 * @param {string}  opts.consumerKey
 * @param {string} [opts.consumerSecret=""]
 * @param {string} [opts.token=""]            - oauth_token (access token)
 * @param {string} [opts.tokenSecret=""]
 * @param {string} [opts.signatureMethod="HMAC-SHA1"]
 * @param {string} [opts.realm]               - included in the header, NOT signed
 * @param {Array<[string,string]>} [opts.bodyParams] - form-urlencoded body params
 * @param {string} [opts.nonce]               - injectable for tests
 * @param {number|string} [opts.timestamp]    - injectable for tests (epoch seconds)
 * @returns {string|null}
 */
function buildAuthorizationHeader({
  method,
  url,
  consumerKey,
  consumerSecret = "",
  token = "",
  tokenSecret = "",
  signatureMethod = "HMAC-SHA1",
  realm,
  bodyParams = [],
  nonce,
  timestamp,
}) {
  if (!consumerKey) return null;

  const sigMethod = String(signatureMethod || "HMAC-SHA1").toUpperCase();
  // PLAINTEXT transmits the signing key (consumer + token secrets) verbatim in
  // the Authorization header, so it is only safe over TLS (RFC 5849 §3.4.4).
  // Refuse to sign a cleartext request rather than leak the secrets — the caller
  // surfaces this as a request error instead of sending them in the clear.
  if (sigMethod === "PLAINTEXT" && new URL(url).protocol !== "https:") {
    throw new Error(
      "OAuth 1.0a PLAINTEXT signing requires an https:// URL — it would send " +
        "the consumer/token secrets in the clear over http://.",
    );
  }
  const oauthParams = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: nonce || crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: sigMethod,
    oauth_timestamp: String(timestamp || Math.floor(Date.now() / 1000)),
    oauth_version: "1.0",
  };
  if (token) oauthParams.oauth_token = token;

  const signingKey = `${pctEncode(consumerSecret)}&${pctEncode(tokenSecret)}`;
  const baseString =
    sigMethod === "PLAINTEXT"
      ? ""
      : signatureBaseString({ method, url, oauthParams, bodyParams });
  oauthParams.oauth_signature = computeSignature(
    sigMethod,
    baseString,
    signingKey,
  );

  // Header params: realm (unsigned) first when present, then the oauth_* params
  // sorted for stable output. Each value is percent-encoded inside quotes.
  const headerParts = [];
  if (realm) headerParts.push(`realm="${pctEncode(realm)}"`);
  for (const key of Object.keys(oauthParams).sort()) {
    headerParts.push(`${pctEncode(key)}="${pctEncode(oauthParams[key])}"`);
  }
  return `OAuth ${headerParts.join(", ")}`;
}

module.exports = {
  pctEncode,
  baseStringUri,
  normalizeParams,
  signatureBaseString,
  computeSignature,
  buildAuthorizationHeader,
};
