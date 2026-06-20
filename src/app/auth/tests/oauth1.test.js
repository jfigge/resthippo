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

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const {
  pctEncode,
  baseStringUri,
  signatureBaseString,
  computeSignature,
  buildAuthorizationHeader,
} = require("../oauth1.js");

// Pull a single oauth_* param value out of an `OAuth k="v", …` header.
function headerParam(header, key) {
  const m = new RegExp(`${key}="([^"]*)"`).exec(header);
  return m ? m[1] : undefined;
}

// ── pctEncode (RFC 5849 §3.6) ────────────────────────────────────────────────

test("pctEncode: leaves unreserved characters, escapes the rest", () => {
  assert.equal(pctEncode("abcABC123-._~"), "abcABC123-._~");
  assert.equal(pctEncode(" "), "%20");
  assert.equal(pctEncode("+"), "%2B");
  assert.equal(pctEncode(","), "%2C");
  assert.equal(pctEncode("="), "%3D");
  // encodeURIComponent leaves these four intact — RFC 5849 requires escaping.
  assert.equal(pctEncode("!*'()"), "%21%2A%27%28%29");
});

// ── baseStringUri (RFC 5849 §3.4.1.2) ─────────────────────────────────────────

test("baseStringUri: lowercases scheme/host, drops default port, query & fragment", () => {
  assert.equal(
    baseStringUri("HTTPS://API.Example.com:443/Path?a=1#frag"),
    "https://api.example.com/Path",
  );
  assert.equal(
    baseStringUri("http://example.com:8080/x"),
    "http://example.com:8080/x",
  );
});

// ── Known test vector — OAuth Core 1.0 Appendix A.5.1 ─────────────────────────
//
// The canonical OAuth 1.0a HMAC-SHA1 example, reproduced verbatim in countless
// library test suites. We verify both the signature base string (authoritative,
// secret-free) and the final oauth_signature digest against the published
// values. The request is a GET with two query params and an access token.

const A5 = {
  method: "GET",
  url: "http://photos.example.net/photos?file=vacation.jpg&size=original",
  consumerKey: "dpf43f3p2l4k3l03",
  consumerSecret: "kd94hf93k423kf44",
  token: "nnch734d00sl2jdk",
  tokenSecret: "pfkkdhi9sl3r4s00",
  nonce: "kllo9940pd9333jh",
  timestamp: "1191242096",
};

const A5_BASE_STRING =
  "GET&http%3A%2F%2Fphotos.example.net%2Fphotos&" +
  "file%3Dvacation.jpg%26oauth_consumer_key%3Ddpf43f3p2l4k3l03%26" +
  "oauth_nonce%3Dkllo9940pd9333jh%26oauth_signature_method%3DHMAC-SHA1%26" +
  "oauth_timestamp%3D1191242096%26oauth_token%3Dnnch734d00sl2jdk%26" +
  "oauth_version%3D1.0%26size%3Doriginal";

const A5_SIGNATURE = "tR3+Ty81lMeYAr/Fid0kMTYa/WM=";

test("signatureBaseString matches the published OAuth 1.0 base string", () => {
  const base = signatureBaseString({
    method: A5.method,
    url: A5.url,
    oauthParams: {
      oauth_consumer_key: A5.consumerKey,
      oauth_nonce: A5.nonce,
      oauth_signature_method: "HMAC-SHA1",
      oauth_timestamp: A5.timestamp,
      oauth_token: A5.token,
      oauth_version: "1.0",
    },
  });
  assert.equal(base, A5_BASE_STRING);
});

test("HMAC-SHA1 signature matches the published OAuth 1.0 signature", () => {
  const signingKey = `${pctEncode(A5.consumerSecret)}&${pctEncode(A5.tokenSecret)}`;
  assert.equal(
    computeSignature("HMAC-SHA1", A5_BASE_STRING, signingKey),
    A5_SIGNATURE,
  );
});

test("buildAuthorizationHeader produces the known vector's signature", () => {
  const header = buildAuthorizationHeader({
    method: A5.method,
    url: A5.url,
    consumerKey: A5.consumerKey,
    consumerSecret: A5.consumerSecret,
    token: A5.token,
    tokenSecret: A5.tokenSecret,
    signatureMethod: "HMAC-SHA1",
    nonce: A5.nonce,
    timestamp: A5.timestamp,
  });
  assert.ok(header.startsWith("OAuth "));
  // oauth_signature is percent-encoded inside the header.
  assert.equal(headerParam(header, "oauth_signature"), pctEncode(A5_SIGNATURE));
  assert.equal(headerParam(header, "oauth_consumer_key"), A5.consumerKey);
  assert.equal(headerParam(header, "oauth_token"), A5.token);
  assert.equal(headerParam(header, "oauth_version"), "1.0");
  assert.equal(headerParam(header, "oauth_signature_method"), "HMAC-SHA1");
});

test("form-urlencoded body params are folded into the signature base string", () => {
  // RFC 5849 §3.4.1.3: an x-www-form-urlencoded body contributes its params.
  const base = signatureBaseString({
    method: "POST",
    url: "https://example.com/r",
    oauthParams: { oauth_consumer_key: "ck", oauth_nonce: "n" },
    bodyParams: [
      ["c", "3"],
      ["a", "1"],
    ],
  });
  // Params (a, c, oauth_consumer_key, oauth_nonce) sort lexicographically.
  assert.equal(
    base,
    "POST&https%3A%2F%2Fexample.com%2Fr&a%3D1%26c%3D3%26oauth_consumer_key%3Dck%26oauth_nonce%3Dn",
  );
});

// ── HMAC-SHA256 ───────────────────────────────────────────────────────────────

test("HMAC-SHA256 uses sha256 over the base string", () => {
  const base = "POST&http%3A%2F%2Fexample.com%2F&a%3D1";
  const key = "secret&tokensecret";
  const expected = crypto
    .createHmac("sha256", key)
    .update(base)
    .digest("base64");
  assert.equal(computeSignature("HMAC-SHA256", base, key), expected);
});

// ── PLAINTEXT (RFC 5849 §3.4.4) ───────────────────────────────────────────────

test("PLAINTEXT signature is the signing key itself", () => {
  const header = buildAuthorizationHeader({
    method: "GET",
    url: "https://example.com/resource",
    consumerKey: "ck",
    consumerSecret: "cs",
    token: "tok",
    tokenSecret: "ts",
    signatureMethod: "PLAINTEXT",
    nonce: "n",
    timestamp: "1",
  });
  // signing key = pctEncode("cs") & pctEncode("ts") = "cs&ts", percent-encoded
  // again inside the header value.
  assert.equal(headerParam(header, "oauth_signature"), pctEncode("cs&ts"));
  assert.equal(headerParam(header, "oauth_signature_method"), "PLAINTEXT");
});

test("PLAINTEXT over http:// is refused (would leak secrets in the clear)", () => {
  assert.throws(
    () =>
      buildAuthorizationHeader({
        method: "GET",
        url: "http://example.com/resource",
        consumerKey: "ck",
        consumerSecret: "cs",
        tokenSecret: "ts",
        signatureMethod: "PLAINTEXT",
        nonce: "n",
        timestamp: "1",
      }),
    /PLAINTEXT signing requires an https/i,
  );
});

test("PLAINTEXT over https:// is allowed", () => {
  assert.doesNotThrow(() =>
    buildAuthorizationHeader({
      method: "GET",
      url: "https://example.com/resource",
      consumerKey: "ck",
      consumerSecret: "cs",
      tokenSecret: "ts",
      signatureMethod: "PLAINTEXT",
      nonce: "n",
      timestamp: "1",
    }),
  );
});

test("HMAC methods are unaffected by the PLAINTEXT transport guard over http://", () => {
  // Signed methods don't expose the secret, so http:// stays allowed for them.
  assert.doesNotThrow(() =>
    buildAuthorizationHeader({
      method: "GET",
      url: "http://example.com/resource",
      consumerKey: "ck",
      consumerSecret: "cs",
      signatureMethod: "HMAC-SHA1",
      nonce: "n",
      timestamp: "1",
    }),
  );
});

// ── realm + missing consumer key ──────────────────────────────────────────────

test("realm is included in the header but excluded from the signature base", () => {
  const withRealm = buildAuthorizationHeader({
    method: "GET",
    url: "https://example.com/r",
    consumerKey: "ck",
    consumerSecret: "cs",
    signatureMethod: "HMAC-SHA1",
    realm: "Example",
    nonce: "n",
    timestamp: "1",
  });
  const noRealm = buildAuthorizationHeader({
    method: "GET",
    url: "https://example.com/r",
    consumerKey: "ck",
    consumerSecret: "cs",
    signatureMethod: "HMAC-SHA1",
    nonce: "n",
    timestamp: "1",
  });
  assert.match(withRealm, /realm="Example"/);
  // Same signature with or without realm (realm is not signed).
  assert.equal(
    headerParam(withRealm, "oauth_signature"),
    headerParam(noRealm, "oauth_signature"),
  );
});

test("buildAuthorizationHeader returns null without a consumer key", () => {
  assert.equal(
    buildAuthorizationHeader({
      method: "GET",
      url: "https://x/",
      consumerKey: "",
    }),
    null,
  );
});
