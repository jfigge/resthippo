// proxy.js — proxy connection-string parsing, credential injection, and
// NO_PROXY-style bypass matching for the main-process HTTP execution path.
//
// These helpers are deliberately dependency-free and pure so they can be unit
// tested in isolation (see net/tests/proxy.test.js). The actual proxy-agent
// instantiation lives in main.js, which calls proxyKind() to choose between the
// SOCKS agent and the HTTP/HTTPS CONNECT agents.
"use strict";

/**
 * Classify a proxy connection string by its URL scheme.
 *
 * @param {string} proxyUrl  e.g. "http://host:8080", "socks5://host:1080"
 * @returns {"socks"|"http"} "socks" for any socks* scheme, "http" otherwise.
 *   (The caller still picks HttpsProxyAgent vs HttpProxyAgent for the "http"
 *   case based on whether the *target* is https.)
 */
function proxyKind(proxyUrl) {
  let scheme = "";
  try {
    scheme = new URL(proxyUrl).protocol.replace(/:$/, "").toLowerCase();
  } catch {
    // Bare "host:port" with no scheme — treat as a forward HTTP proxy.
    return "http";
  }
  return scheme.startsWith("socks") ? "socks" : "http";
}

/**
 * Inject separate proxy credentials into a proxy URL's userinfo component.
 *
 * Credentials are kept out of the stored connection string (encrypted on their
 * own) and merged in only at send time. The WHATWG URL setters percent-encode
 * the username/password using the userinfo encode set, so values containing
 * "@", ":", or spaces are escaped correctly — do NOT pre-encode them. Explicit
 * credentials win over any userinfo already present in the URL.
 *
 * @param {string} proxyUrl
 * @param {string} [username]
 * @param {string} [password]
 * @returns {string} The proxy URL with credentials applied (unchanged when none
 *   are supplied, or when the URL cannot be parsed).
 */
function withProxyCredentials(proxyUrl, username = "", password = "") {
  if (!username && !password) return proxyUrl;
  try {
    const u = new URL(proxyUrl);
    if (username) u.username = username;
    if (password) u.password = password;
    return u.toString();
  } catch {
    return proxyUrl;
  }
}

/**
 * Split a NO_PROXY-style bypass list into normalised, lower-cased patterns.
 * Entries may be separated by commas, whitespace, or newlines.
 *
 * @param {string|string[]} list
 * @returns {string[]}
 */
function parseBypassList(list) {
  if (Array.isArray(list)) {
    return list.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  }
  if (typeof list !== "string") return [];
  return list
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Build an anchored, case-insensitive RegExp from a host glob (* and ?). */
function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const pattern = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${pattern}$`, "i");
}

/**
 * Whether a request to `host:port` should bypass the proxy and connect
 * directly, given a NO_PROXY-style bypass list. Supported entry syntax:
 *
 *   *                     → bypass every host
 *   example.com           → example.com and any subdomain (suffix match)
 *   .example.com          → same as above (leading dot is optional)
 *   *.internal, 10.0.*    → glob wildcards (* and ?) matched against the host
 *   192.168.1.10          → exact host (IP or name)
 *   example.com:8443      → only when the request port also matches
 *
 * @param {string} host          request hostname (no brackets/port)
 * @param {number|string} port   request port
 * @param {string|string[]} bypass  raw bypass list
 * @returns {boolean}
 */
function hostBypassesProxy(host, port, bypass) {
  const patterns = parseBypassList(bypass);
  if (patterns.length === 0) return false;

  const h = String(host || "")
    .toLowerCase()
    .replace(/\.$/, ""); // strip a trailing root dot
  if (!h) return false;
  const p = port != null ? String(port) : "";

  for (let entry of patterns) {
    if (entry === "*") return true;

    // Optional ":port" suffix — when present it must match the request port.
    // (Skip IPv6 literals, which contain their own colons.)
    let entryPort = "";
    if (!entry.includes("::")) {
      const colon = entry.lastIndexOf(":");
      if (colon > 0 && /^\d+$/.test(entry.slice(colon + 1))) {
        entryPort = entry.slice(colon + 1);
        entry = entry.slice(0, colon);
      }
    }
    if (entryPort && entryPort !== p) continue;
    if (!entry) continue;

    if (entry.includes("*") || entry.includes("?")) {
      if (globToRegExp(entry).test(h)) return true;
      continue;
    }

    const suffix = entry.replace(/^\./, ""); // ".example.com" → "example.com"
    if (h === suffix || h.endsWith(`.${suffix}`)) return true;
  }
  return false;
}

module.exports = {
  proxyKind,
  withProxyCredentials,
  parseBypassList,
  hostBypassesProxy,
};
