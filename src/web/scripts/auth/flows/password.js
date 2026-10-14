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
 * auth/flows/password.js
 *
 * OAuth 2.0 Resource Owner Password Credentials Grant — RFC 6749 §4.3
 *
 * ⚠️  This grant is considered legacy and has been removed from OAuth 2.1.
 *     Use only when other flows are not possible (e.g. legacy systems).
 */

"use strict";

import { applyClientAuth, requestToken } from "./token-request.js";
import { mergeExtraParams } from "../utils/params.js";

/**
 * Execute the Resource Owner Password Credentials grant.
 *
 * @param {object} config - authOAuth2 state from the request editor
 * @returns {Promise<import('../types/oauth-types').OAuthResult>}
 */
export async function passwordFlow(config) {
  // Config is validated up front by the executor via validateOAuthConfig().

  // ── Build parameters ────────────────────────────────────────────────────────
  // Passwords are sent verbatim — trimming would silently corrupt secrets that
  // legitimately contain leading or trailing whitespace. Existence is checked
  // by validateOAuthConfig against the trimmed value, which still rejects
  // all-whitespace input.
  const params = {
    grant_type: "password",
    username: config.username.trim(),
    password: config.password, // intentionally not logged, not trimmed
  };

  // The password grant carries scope and audience but not `resource`: RFC 8707
  // resource indicators are scoped to the redirect-based grants in this client,
  // so the omission here is intentional, not incidental.
  if (config.scope?.trim()) params.scope = config.scope.trim();
  if (config.audience?.trim()) params.audience = config.audience.trim();

  // Extra custom parameters
  mergeExtraParams(params, config.extraParams);

  // ── Client authentication ────────────────────────────────────────────────────
  const headers = {};
  applyClientAuth(params, headers, config);

  // ── Execute ──────────────────────────────────────────────────────────────────
  return requestToken(config.accessTokenUrl.trim(), params, headers, config);
}
