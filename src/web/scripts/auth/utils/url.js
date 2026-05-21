/**
 * auth/utils/url.js
 *
 * URL construction and parsing helpers for OAuth flows.
 */

"use strict";

// ── URL building ─────────────────────────────────────────────────────────────

/**
 * Build a URL by appending query parameters, skipping null/undefined/"" values.
 *
 * @param {string}                       base   - Base URL (must be a valid absolute URL)
 * @param {Record<string,string|null|undefined>} params
 * @returns {string}
 */
export function buildUrl(base, params) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

// ── Callback URL parsing ──────────────────────────────────────────────────────

/**
 * Parse both the query string and hash fragment of a URL into
 * URLSearchParams objects.
 *
 * @param {string} urlString
 * @returns {{ query: URLSearchParams, fragment: URLSearchParams }}
 */
export function parseUrlParams(urlString) {
  try {
    const url      = new URL(urlString);
    const query    = url.searchParams;
    const hashBody = url.hash.startsWith("#") ? url.hash.slice(1) : "";
    const fragment = new URLSearchParams(hashBody);
    return { query, fragment };
  } catch {
    return { query: new URLSearchParams(), fragment: new URLSearchParams() };
  }
}

/**
 * Extract the authorization code (and related fields) from a callback URL.
 * The code lives in the query string for Authorization Code flow.
 *
 * @param {string} callbackUrl
 * @returns {{
 *   code:             string|null,
 *   state:            string|null,
 *   error:            string|null,
 *   errorDescription: string|null,
 * }}
 */
export function extractAuthCode(callbackUrl) {
  const { query } = parseUrlParams(callbackUrl);
  return {
    code:             query.get("code"),
    state:            query.get("state"),
    error:            query.get("error"),
    errorDescription: query.get("error_description"),
  };
}

/**
 * Extract an implicit-flow token from a callback URL.
 *
 * Per the spec the token fields are in the fragment (#access_token=…).
 * Some IdPs mistakenly put them in the query string — we fall back to
 * query if the fragment has no access_token.
 *
 * @param {string} callbackUrl
 * @returns {{
 *   accessToken:      string|null,
 *   tokenType:        string|null,
 *   expiresIn:        string|null,
 *   idToken:          string|null,
 *   scope:            string|null,
 *   state:            string|null,
 *   error:            string|null,
 *   errorDescription: string|null,
 * }}
 */
export function extractImplicitToken(callbackUrl) {
  const { query, fragment } = parseUrlParams(callbackUrl);
  // Prefer fragment; fall back to query for non-conformant IdPs
  const p = fragment.get("access_token") ? fragment : query;
  return {
    accessToken:      p.get("access_token"),
    tokenType:        p.get("token_type"),
    expiresIn:        p.get("expires_in"),
    idToken:          p.get("id_token"),
    scope:            p.get("scope"),
    state:            p.get("state"),
    error:            p.get("error"),
    errorDescription: p.get("error_description"),
  };
}

/**
 * Normalise a redirect URI: ensure it has no trailing slashes except for
 * bare-origin forms (e.g. "http://localhost/").
 *
 * @param {string} uri
 * @returns {string}
 */
export function normaliseRedirectUri(uri) {
  try {
    const u = new URL(uri);
    if (u.pathname === "/") return u.origin + "/";
    return u.origin + u.pathname.replace(/\/+$/, "") + u.search + u.hash;
  } catch {
    return uri;
  }
}

/**
 * Return the effective port string for a URL, substituting the scheme default
 * when `URL.port` is empty (i.e. the port is implicit).
 *
 * @param {URL} url
 * @returns {string}
 */
function effectivePort(url) {
  if (url.port !== "") return url.port;
  if (url.protocol === "https:") return "443";
  if (url.protocol === "http:")  return "80";
  return "";
}

/**
 * Test whether a given URL starts with the registered redirect URI.
 * Comparison is case-sensitive for the path and case-insensitive for the host.
 *
 * @param {string} urlToCheck
 * @param {string} registeredRedirectUri
 * @returns {boolean}
 */
export function matchesRedirectUri(urlToCheck, registeredRedirectUri) {
  if (!urlToCheck || !registeredRedirectUri) return false;
  try {
    const check    = new URL(urlToCheck);
    const redirect = new URL(registeredRedirectUri);

    // urn: schemes (e.g. urn:ietf:wg:oauth:2.0:oob) can't match a navigating URL
    if (redirect.protocol === "urn:") return false;

    const sameOrigin   = check.protocol.toLowerCase() === redirect.protocol.toLowerCase()
                      && check.hostname.toLowerCase()  === redirect.hostname.toLowerCase()
                      && effectivePort(check)          === effectivePort(redirect);
    const samePath     = check.pathname === redirect.pathname
                      || (redirect.pathname === "/" && check.pathname === "");
    return sameOrigin && samePath;
  } catch {
    // Fallback: prefix match
    return urlToCheck.startsWith(registeredRedirectUri);
  }
}

