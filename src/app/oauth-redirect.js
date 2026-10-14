/*
 * Copyright 2026 Jason Figge
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This file is part of Rest Hippo.
 *
 * Rest Hippo is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option) any later
 * version.
 *
 * Rest Hippo is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR
 * A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with
 * Rest Hippo. If not, see <https://www.gnu.org/licenses/>.
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
