/**
 * digest.js — HTTP Digest Access Authentication (RFC 2617 / RFC 7616).
 *
 * Pure, dependency-free helpers used by the main process to answer a server's
 * `401 WWW-Authenticate: Digest …` challenge with a matching
 * `Authorization: Digest …` header on a retried request.
 *
 * Digest is NOT connection-bound — the server's nonce travels in the response
 * header — so the challenge/response round-trip is handled as a one-shot retry
 * inside doRequest() (mirroring the redirect recursion), not via a stateful
 * socket-pinned handshake the way NTLM requires.
 *
 * Supported algorithms: MD5, MD5-sess, SHA-256, SHA-256-sess, SHA-512-256,
 * SHA-512-256-sess. Supported qop: auth, auth-int, and the legacy RFC 2069
 * (no qop) form. `cnonce` is injectable so the output is deterministic under
 * test; in production it defaults to 16 random bytes.
 */
"use strict";

const crypto = require("crypto");

/**
 * Map an RFC algorithm token (e.g. "SHA-256-sess") to a Node hash name.
 * Returns null for anything we can't compute, so callers can fall through to
 * leaving the request unauthenticated rather than sending a bad header.
 *
 * @param {string|undefined} algorithm
 * @returns {string|null}
 */
function _hashName(algorithm) {
  const base = String(algorithm || "MD5")
    .toLowerCase()
    .replace(/-sess$/, "");
  switch (base) {
    case "md5":
      return "md5";
    case "sha-256":
    case "sha256":
      return "sha256";
    case "sha-512-256":
    case "sha512-256":
      return "sha512-256";
    default:
      return null;
  }
}

/** Hex digest of `str` (UTF-8) under the named hash. */
function _hash(name, str) {
  return crypto.createHash(name).update(str, "utf8").digest("hex");
}

/** Escape `"` and `\` so a value is safe inside a quoted-string. */
function _escapeQuoted(s) {
  return String(s).replace(/(["\\])/g, "\\$1");
}

/**
 * Parse a single `Digest …` challenge value into a flat params object with
 * lower-cased keys (realm, nonce, qop, algorithm, opaque, domain, stale, …).
 *
 * @param {string} headerValue  e.g. `Digest realm="x", nonce="y", qop="auth"`
 * @returns {object|null}        params, or null if not a Digest challenge
 */
function parseChallenge(headerValue) {
  if (!headerValue) return null;
  const m = /^\s*Digest\s+(.*)$/is.exec(headerValue);
  if (!m) return null;
  const params = {};
  // token = ( "quoted, with \" escapes" | bare-token ), comma-separated.
  const re = /([a-zA-Z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g;
  let mm;
  while ((mm = re.exec(m[1])) !== null) {
    const key = mm[1].toLowerCase();
    const val = mm[2] !== undefined ? mm[2].replace(/\\(.)/g, "$1") : mm[3];
    params[key] = val;
  }
  return params;
}

/**
 * Given the raw (un-joined) WWW-Authenticate header values from a 401 response,
 * return the first one that is a Digest challenge, or null.
 *
 * Node joins duplicate response headers with ", " in its flattened header map,
 * which would corrupt a challenge that itself contains commas. Pass
 * `res.rawHeaders`-derived values here to keep each challenge intact.
 *
 * @param {string[]} rawValues
 * @returns {string|null}
 */
function selectDigestChallenge(rawValues) {
  if (!Array.isArray(rawValues)) return null;
  for (const v of rawValues) {
    if (/^\s*Digest\s/i.test(v)) return v;
  }
  return null;
}

/**
 * Build an `Authorization: Digest …` header value answering `challenge`.
 *
 * Returns null when the challenge cannot be satisfied (missing realm/nonce, or
 * an algorithm we don't implement) so the caller can leave the request as-is.
 *
 * @param {object}              opts
 * @param {string}              opts.method       HTTP method (GET, POST, …)
 * @param {string}              opts.uri          request-target (path + query)
 * @param {string}              opts.username
 * @param {string}              opts.password
 * @param {object}              opts.challenge    parsed via parseChallenge()
 * @param {Buffer|string|null} [opts.entityBody]  request body, for qop=auth-int
 * @param {string}             [opts.cnonce]      injectable client nonce (tests)
 * @param {number}             [opts.nc]          nonce count (default 1)
 * @returns {string|null}
 */
function buildAuthorization({
  method,
  uri,
  username,
  password,
  challenge,
  entityBody = null,
  cnonce,
  nc = 1,
}) {
  if (!challenge || !challenge.nonce || !challenge.realm) return null;
  const hashName = _hashName(challenge.algorithm);
  if (!hashName) return null;

  const algorithm = challenge.algorithm; // echoed verbatim when present
  const isSess = /-sess$/i.test(algorithm || "");
  const { realm, nonce, opaque } = challenge;
  const cnonceVal = cnonce || crypto.randomBytes(16).toString("hex");
  const ncVal = String(nc).padStart(8, "0");

  // qop negotiation: prefer "auth"; fall back to "auth-int"; else legacy 2069.
  let qop = null;
  if (challenge.qop) {
    const offered = challenge.qop.split(",").map((s) => s.trim().toLowerCase());
    if (offered.includes("auth")) qop = "auth";
    else if (offered.includes("auth-int")) qop = "auth-int";
  }

  let ha1 = _hash(hashName, `${username}:${realm}:${password}`);
  if (isSess) ha1 = _hash(hashName, `${ha1}:${nonce}:${cnonceVal}`);

  let ha2;
  if (qop === "auth-int") {
    const bodyBuf =
      entityBody == null
        ? Buffer.alloc(0)
        : Buffer.isBuffer(entityBody)
          ? entityBody
          : Buffer.from(String(entityBody), "utf8");
    const bodyHash = crypto.createHash(hashName).update(bodyBuf).digest("hex");
    ha2 = _hash(hashName, `${method}:${uri}:${bodyHash}`);
  } else {
    ha2 = _hash(hashName, `${method}:${uri}`);
  }

  const response = qop
    ? _hash(hashName, `${ha1}:${nonce}:${ncVal}:${cnonceVal}:${qop}:${ha2}`)
    : _hash(hashName, `${ha1}:${nonce}:${ha2}`); // RFC 2069 fallback

  const parts = [
    `username="${_escapeQuoted(username)}"`,
    `realm="${_escapeQuoted(realm)}"`,
    `nonce="${_escapeQuoted(nonce)}"`,
    `uri="${_escapeQuoted(uri)}"`,
    `response="${response}"`,
  ];
  if (algorithm) parts.push(`algorithm=${algorithm}`);
  if (opaque !== undefined) parts.push(`opaque="${_escapeQuoted(opaque)}"`);
  if (qop) {
    parts.push(`qop=${qop}`);
    parts.push(`nc=${ncVal}`);
    parts.push(`cnonce="${cnonceVal}"`);
  }
  return `Digest ${parts.join(", ")}`;
}

module.exports = {
  parseChallenge,
  selectDigestChallenge,
  buildAuthorization,
  _hashName,
};
