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
 * oauth-redirect.js — pure helpers for the OAuth authorization popup
 * (`oauth:open-popup` in main.js). Extracted so the security-sensitive
 * redirect-URI match and authorization-URL scheme guard are unit-testable in
 * isolation (no Electron, no BrowserWindow).
 */
"use strict";

const { URL } = require("url");

/**
 * Whether `url` is an http(s) URL — the only schemes a real authorization
 * endpoint uses. Guards `popup.loadURL(authUrl)` so a stray
 * `file:`/`data:`/`javascript:` value (authUrl is built from user config) can
 * never be loaded in the popup. A value that doesn't parse is rejected.
 *
 * @param {string} url
 * @returns {boolean}
 */
function isHttpUrl(url) {
  try {
    const proto = new URL(url).protocol;
    return proto === "http:" || proto === "https:";
  } catch {
    return false;
  }
}

/**
 * Whether a navigation URL matches the registered OAuth redirect URI — the
 * signal that the IdP has bounced back with the authorization `code`/token.
 * Matches on scheme + host + port + path (origin-and-path), case-insensitively
 * for scheme/host; a registered root path (`/`) also matches an empty path.
 *
 * `urn:` redirect URIs (e.g. `urn:ietf:wg:oauth:2.0:oob`) cannot be matched via
 * a navigation and return false. A nav URL or redirect_uri that doesn't parse
 * returns false too: we deliberately do NOT fall back to a substring/prefix
 * compare. `navUrl.startsWith(redirectUri)` over-matches — an attacker origin
 * like `https://app.example.com.evil/cb` "starts with" the registered
 * `https://app.example.com` — and would hand the callback URL (carrying the
 * authorization code) to the wrong navigation. Custom and loopback redirect URIs
 * parse fine via WHATWG URL, so the structured comparison already covers every
 * real scheme; failing closed here is correct.
 *
 * @param {string} navUrl       URL being navigated to
 * @param {string} redirectUri  registered redirect URI
 * @returns {boolean}
 */
function matchesRedirect(navUrl, redirectUri) {
  if (!navUrl || !redirectUri) return false;
  try {
    const nav = new URL(navUrl);
    const redirect = new URL(redirectUri);
    if (redirect.protocol === "urn:") return false;
    const sameOrigin =
      nav.protocol.toLowerCase() === redirect.protocol.toLowerCase() &&
      nav.hostname.toLowerCase() === redirect.hostname.toLowerCase() &&
      nav.port === redirect.port;
    const samePath =
      nav.pathname === redirect.pathname ||
      (redirect.pathname === "/" &&
        (nav.pathname === "" || nav.pathname === "/"));
    return sameOrigin && samePath;
  } catch {
    return false;
  }
}

module.exports = { isHttpUrl, matchesRedirect };
