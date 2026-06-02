/**
 * auth/flows/password.js
 *
 * OAuth 2.0 Resource Owner Password Credentials Grant — RFC 6749 §4.3
 *
 * ⚠️  This grant is considered legacy and has been removed from OAuth 2.1.
 *     Use only when other flows are not possible (e.g. legacy systems).
 */

"use strict";

import { applyClientAuth, requestToken } from "./token-exchange.js";
import { oauthResultFromError } from "../types/oauth-types.js";
import { configurationError } from "../types/oauth-errors.js";

/**
 * Execute the Resource Owner Password Credentials grant.
 *
 * @param {object} config - authOAuth2 state from the request editor
 * @returns {Promise<import('../types/oauth-types').OAuthResult>}
 */
export async function passwordFlow(config) {
  // ── Validate ──────────────────────────────────────────────────────────────
  if (!config.accessTokenUrl?.trim())
    return oauthResultFromError(
      configurationError("Access Token URL is required."),
    );
  if (!config.clientId?.trim())
    return oauthResultFromError(configurationError("Client ID is required."));
  if (!config.username?.trim())
    return oauthResultFromError(configurationError("Username is required."));
  if (!config.password?.trim())
    return oauthResultFromError(configurationError("Password is required."));

  // ── Build parameters ────────────────────────────────────────────────────────
  // Passwords are sent verbatim — trimming would silently corrupt secrets that
  // legitimately contain leading or trailing whitespace. Existence is checked
  // above against the trimmed value, which still rejects all-whitespace input.
  const params = {
    grant_type: "password",
    username: config.username.trim(),
    password: config.password, // intentionally not logged, not trimmed
  };

  if (config.scope?.trim()) params.scope = config.scope.trim();
  if (config.audience?.trim()) params.audience = config.audience.trim();

  // Extra custom parameters
  if (config.extraParams && typeof config.extraParams === "object") {
    for (const [k, v] of Object.entries(config.extraParams)) {
      if (k && v != null && v !== "") params[k] = String(v);
    }
  }

  // ── Client authentication ────────────────────────────────────────────────────
  const headers = {};
  applyClientAuth(params, headers, config);

  // ── Execute ──────────────────────────────────────────────────────────────────
  return requestToken(config.accessTokenUrl.trim(), params, headers, config);
}
