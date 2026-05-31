/**
 * cookie-jar.js — Pure RFC-6265 cookie logic (no filesystem, no Electron).
 *
 * This module is the self-contained engine behind the per-collection cookie
 * jar: it parses `Set-Cookie` response headers, normalises them against the
 * request URL (default domain/path, host-only flag, Max-Age vs Expires), and
 * decides which stored cookies match an outgoing request so they can be
 * serialised into a `Cookie` header.
 *
 * It deliberately depends on nothing else so the semantics can be exercised in
 * a plain Node.js test environment. Persistence lives in cookie-store.js.
 *
 * Scope note: this is a deliberately small implementation, not a full RFC-6265
 * library — there is no public-suffix list, so Domain attributes are validated
 * only by the domain-match rule below. That is the right trade-off for a
 * desktop API client talking to known hosts; see features/09-cookie-jar.md.
 */
"use strict";

/** Attribute-less booleans recognised on a Set-Cookie line. */
const FLAG_ATTRS = new Set(["secure", "httponly"]);

/**
 * Parse the date forms permitted in a cookie `Expires` attribute into epoch ms.
 * Node's Date can parse the RFC-1123 form servers actually send; anything it
 * rejects yields null (treated as "no expiry given").
 * @param {string} str
 * @returns {number|null}
 */
function parseExpires(str) {
  const t = Date.parse(str);
  return Number.isNaN(t) ? null : t;
}

/**
 * Parse a single raw `Set-Cookie` header value into its constituent parts.
 *
 * Returns null when the line has no `name=value` pair (per RFC-6265 §5.2 such a
 * cookie is ignored). Attribute names are matched case-insensitively. Expiry is
 * left as the raw Max-Age / Expires inputs — normalisation happens in
 * {@link cookieFromSetCookie} where the request time is known.
 *
 * @param {string} line
 * @returns {{name:string,value:string,domain:string|null,path:string|null,
 *   maxAge:number|null,expires:number|null,secure:boolean,httpOnly:boolean,
 *   sameSite:string|null}|null}
 */
function parseSetCookie(line) {
  if (typeof line !== "string" || !line.trim()) return null;
  const parts = line.split(";");
  const first = parts.shift();
  const eq = first.indexOf("=");
  if (eq < 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name) return null;

  const cookie = {
    name,
    value,
    domain: null,
    path: null,
    maxAge: null,
    expires: null,
    secure: false,
    httpOnly: false,
    sameSite: null,
  };

  for (const raw of parts) {
    const seg = raw.trim();
    if (!seg) continue;
    const i = seg.indexOf("=");
    const attr = (i < 0 ? seg : seg.slice(0, i)).trim().toLowerCase();
    const attrVal = i < 0 ? "" : seg.slice(i + 1).trim();

    if (FLAG_ATTRS.has(attr)) {
      if (attr === "secure") cookie.secure = true;
      else cookie.httpOnly = true;
      continue;
    }
    switch (attr) {
      case "domain":
        // Leading dot is allowed but not significant (RFC-6265 §5.2.3).
        cookie.domain = attrVal.replace(/^\./, "").toLowerCase() || null;
        break;
      case "path":
        cookie.path = attrVal.startsWith("/") ? attrVal : null;
        break;
      case "max-age": {
        const n = parseInt(attrVal, 10);
        if (!Number.isNaN(n)) cookie.maxAge = n;
        break;
      }
      case "expires":
        cookie.expires = parseExpires(attrVal);
        break;
      case "samesite":
        cookie.sameSite = attrVal || null;
        break;
      default:
        break; // unknown attribute — ignore
    }
  }
  return cookie;
}

/**
 * Compute the default-path for a cookie from the request path (RFC-6265 §5.1.4):
 * everything up to, but not including, the rightmost "/". Yields "/" for a
 * request to the root or a path with no internal slash.
 * @param {string} pathname
 * @returns {string}
 */
function defaultPath(pathname) {
  if (!pathname || !pathname.startsWith("/")) return "/";
  const idx = pathname.lastIndexOf("/");
  return idx <= 0 ? "/" : pathname.slice(0, idx);
}

/**
 * RFC-6265 §5.1.3 domain-match. Both arguments must be lowercase hostnames.
 * @param {string} host    request hostname
 * @param {string} domain  cookie domain
 * @returns {boolean}
 */
function domainMatch(host, domain) {
  if (!host || !domain) return false;
  if (host === domain) return true;
  return host.endsWith("." + domain);
}

/**
 * RFC-6265 §5.1.4 path-match.
 * @param {string} reqPath     request path
 * @param {string} cookiePath  cookie path
 * @returns {boolean}
 */
function pathMatch(reqPath, cookiePath) {
  if (cookiePath === reqPath) return true;
  if (!reqPath.startsWith(cookiePath)) return false;
  // Prefix match only counts at a path boundary.
  return cookiePath.endsWith("/") || reqPath[cookiePath.length] === "/";
}

/**
 * Resolve a cookie's absolute expiry (epoch ms) from its Max-Age / Expires.
 * Max-Age takes precedence (RFC-6265 §5.3). Returns null for a session cookie
 * (no persistent expiry). A non-null value in the past means "already expired".
 * @param {{maxAge:number|null,expires:number|null}} c
 * @param {number} now epoch ms
 * @returns {number|null}
 */
function resolveExpiry(c, now) {
  if (c.maxAge !== null) {
    // Max-Age <= 0 means expire immediately.
    return c.maxAge <= 0 ? now - 1 : now + c.maxAge * 1000;
  }
  return c.expires;
}

/**
 * Normalise a parsed Set-Cookie against the request URL into a storable jar
 * entry, applying default domain/path, the host-only flag, and resolved expiry.
 *
 * Returns null if the cookie must be rejected — currently only when a Domain
 * attribute is present that the request host does not domain-match
 * (RFC-6265 §5.3 step 6).
 *
 * @param {string} line       raw Set-Cookie header value
 * @param {string} requestUrl the URL the response came from
 * @param {number} now        epoch ms (injectable for tests)
 * @returns {object|null} jar entry, or null if rejected/unparseable
 */
function cookieFromSetCookie(line, requestUrl, now) {
  const parsed = parseSetCookie(line);
  if (!parsed) return null;

  let url;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();

  let domain = parsed.domain;
  let hostOnly = false;
  if (domain) {
    // A Domain that the request host can't match is a forged/cross-site cookie.
    if (!domainMatch(host, domain)) return null;
  } else {
    domain = host;
    hostOnly = true;
  }

  const path = parsed.path || defaultPath(url.pathname);

  return {
    name: parsed.name,
    value: parsed.value,
    domain,
    path,
    hostOnly,
    secure: parsed.secure,
    httpOnly: parsed.httpOnly,
    sameSite: parsed.sameSite,
    expires: resolveExpiry(parsed, now),
    creation: now,
  };
}

/**
 * @param {object} c jar entry
 * @param {number} now epoch ms
 * @returns {boolean} true if the cookie has a persistent expiry in the past
 */
function isExpired(c, now) {
  return c.expires !== null && c.expires <= now;
}

/**
 * Two cookies are the same identity when name + domain + path all match
 * (RFC-6265 §5.3 step 11). Used to replace rather than duplicate on upsert.
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
function sameIdentity(a, b) {
  return a.name === b.name && a.domain === b.domain && a.path === b.path;
}

/**
 * Insert or replace `incoming` into `cookies`, dropping any cookie that is
 * expired (the incoming one, or stale survivors). Preserves the original
 * creation time when replacing (RFC-6265 §5.3 step 11.3). Returns a new array;
 * `cookies` is not mutated.
 *
 * @param {object[]} cookies existing jar entries
 * @param {object}   incoming normalised entry from {@link cookieFromSetCookie}
 * @param {number}   now epoch ms
 * @returns {object[]}
 */
function upsertCookie(cookies, incoming, now) {
  const kept = [];
  let prior = null;
  for (const c of cookies) {
    if (sameIdentity(c, incoming)) {
      prior = c;
      continue; // drop the old copy; incoming replaces it (if not expired)
    }
    if (!isExpired(c, now)) kept.push(c);
  }
  if (!isExpired(incoming, now)) {
    if (prior) incoming = { ...incoming, creation: prior.creation };
    kept.push(incoming);
  }
  return kept;
}

/**
 * Select the cookies that should be sent on a request to `requestUrl`,
 * applying domain/path/secure/expiry rules and RFC-6265 §5.4 ordering
 * (longer paths first, then earlier creation).
 *
 * @param {object[]} cookies jar entries
 * @param {string}   requestUrl outgoing request URL
 * @param {number}   now epoch ms
 * @returns {object[]} matching, ordered jar entries
 */
function selectCookies(cookies, requestUrl, now) {
  let url;
  try {
    url = new URL(requestUrl);
  } catch {
    return [];
  }
  const host = url.hostname.toLowerCase();
  const isSecure = url.protocol === "https:";
  const reqPath = url.pathname || "/";

  return cookies
    .filter((c) => {
      if (isExpired(c, now)) return false;
      if (c.secure && !isSecure) return false;
      const dMatch = c.hostOnly
        ? host === c.domain
        : domainMatch(host, c.domain);
      if (!dMatch) return false;
      return pathMatch(reqPath, c.path);
    })
    .sort((a, b) => {
      if (b.path.length !== a.path.length) return b.path.length - a.path.length;
      return (a.creation ?? 0) - (b.creation ?? 0);
    });
}

/**
 * Serialise selected cookies into a `Cookie` request-header value.
 * @param {object[]} cookies already-selected, already-ordered entries
 * @returns {string} e.g. "a=1; b=2" — empty string when none
 */
function serializeCookieHeader(cookies) {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

/**
 * Drop every expired cookie from a list (used to prune on read).
 * @param {object[]} cookies
 * @param {number} now epoch ms
 * @returns {object[]}
 */
function pruneExpired(cookies, now) {
  return cookies.filter((c) => !isExpired(c, now));
}

module.exports = {
  parseSetCookie,
  cookieFromSetCookie,
  defaultPath,
  domainMatch,
  pathMatch,
  resolveExpiry,
  isExpired,
  sameIdentity,
  upsertCookie,
  selectCookies,
  serializeCookieHeader,
  pruneExpired,
};
