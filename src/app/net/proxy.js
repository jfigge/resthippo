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

// proxy.js — proxy connection-string parsing, credential injection, and
// NO_PROXY-style bypass matching for the main-process HTTP execution path.
//
// The parsing/bypass helpers are deliberately dependency-free and pure so they
// can be unit tested in isolation (see net/tests/proxy.test.js). The single
// impure helper — makeProxyAgent() — lazy-requires the agent modules only when
// called, so importing this file for the pure helpers stays cheap. Both the
// HTTP execution path (main.js) and the WebSocket client (net/websocket.js)
// share makeProxyAgent so agent selection has one source of truth.
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

/**
 * Build the proxy Agent for an outgoing connection. The proxy *type* is taken
 * from the URL scheme: any `socks*://` scheme uses the SOCKS agent; otherwise an
 * HTTP/HTTPS forward-proxy agent is chosen by whether the *target* is secure.
 *
 * HttpsProxyAgent tunnels via CONNECT, which keeps the (encrypted) target
 * connection opaque to the proxy — used for `https://` and `wss://` targets.
 * HttpProxyAgent sends an absolute-URI request the proxy can read — used for
 * `http://` and `ws://` targets. SocksProxyAgent handles both target schemes.
 *
 * The agent modules are required lazily so the pure helpers above remain
 * dependency-free for isolated unit testing.
 *
 * Per-request TLS material for the TARGET (custom `ca`, `rejectUnauthorized`,
 * and the mTLS `cert`/`key`/`pfx`) is intentionally NOT passed to the agent
 * constructor here: the caller sets it on the request `options`, and agent-base
 * spreads `{...options}` into the agent's `connect()`, which https-proxy-agent
 * (and socks-proxy-agent) then forward into the target `tls.connect()`. So the
 * options reach the target handshake through the proxy on their own — verified
 * end-to-end (rejectUnauthorized override, custom CA, and client-cert
 * presentation all work through a CONNECT tunnel). Duplicating them on the
 * constructor would be redundant; do not "fix" this by adding them here.
 *
 * @param {string}  effectiveProxyUrl  proxy URL with any credentials merged in
 * @param {boolean} isSecure           whether the target is https:// or wss://
 * @returns {import('http').Agent}
 */
function makeProxyAgent(effectiveProxyUrl, isSecure) {
  if (proxyKind(effectiveProxyUrl) === "socks") {
    const { SocksProxyAgent } = require("socks-proxy-agent");
    return new SocksProxyAgent(effectiveProxyUrl);
  }
  if (isSecure) {
    const { HttpsProxyAgent } = require("https-proxy-agent");
    return new HttpsProxyAgent(effectiveProxyUrl);
  }
  const { HttpProxyAgent } = require("http-proxy-agent");
  return new HttpProxyAgent(effectiveProxyUrl);
}

module.exports = {
  proxyKind,
  withProxyCredentials,
  parseBypassList,
  hostBypassesProxy,
  makeProxyAgent,
};
