/**
 * auth/flows/password.js
 *
 * OAuth 2.0 Resource Owner Password Credentials Grant — RFC 6749 §4.3
 *
 * ⚠️  This grant is considered legacy and has been removed from OAuth 2.1.
 *     Use only when other flows are not possible (e.g. legacy systems).
 */

"use strict";

import { postTokenRequest }             from "../network/electron-network.js";
import { oauthResultFromTokenResponse, oauthResultFromError } from "../types/oauth-types.js";
import { configurationError, fromTokenErrorResponse }        from "../types/oauth-errors.js";

/**
 * Execute the Resource Owner Password Credentials grant.
 *
 * @param {object} config - authOAuth2 state from the request editor
 * @returns {Promise<import('../types/oauth-types').OAuthResult>}
 */
export async function passwordFlow(config) {
  // ── Validate ─────────────────────────────────────────────────────────────
  if (!config.accessTokenUrl?.trim()) return oauthResultFromError(configurationError("Access Token URL is required."));
  if (!config.clientId?.trim())       return oauthResultFromError(configurationError("Client ID is required."));
  if (!config.username?.trim())       return oauthResultFromError(configurationError("Username is required."));
  if (!config.password?.trim())       return oauthResultFromError(configurationError("Password is required."));

  // ── Build parameters ──────────────────────────────────────────────────────
  const params = {
    grant_type: "password",
    username:   config.username.trim(),
    password:   config.password.trim(), // intentionally not logged
  };

  if (config.scope?.trim())    params.scope    = config.scope.trim();
  if (config.audience?.trim()) params.audience = config.audience.trim();

  // Extra custom parameters
  if (config.extraParams && typeof config.extraParams === "object") {
    for (const [k, v] of Object.entries(config.extraParams)) {
      if (k && v != null && v !== "") params[k] = String(v);
    }
  }

  // ── Client authentication ─────────────────────────────────────────────────
  const headers    = {};
  const credMethod = config.credentials ?? "header";

  if (credMethod === "body") {
    params.client_id = config.clientId.trim();
    if (config.clientSecret?.trim()) params.client_secret = config.clientSecret.trim();
  } else {
    params.client_id = config.clientId.trim();
    if (config.clientSecret?.trim()) {
      const encoded = btoa(`${config.clientId.trim()}:${config.clientSecret.trim()}`);
      headers["Authorization"] = `Basic ${encoded}`;
    }
  }

  // ── Execute ────���──────────────────────────────────────────────────────────
  let response;
  try {
    response = await postTokenRequest(config.accessTokenUrl.trim(), params, {
      headers,
      verifySsl: config.verifySsl !== false,
      timeout:   config.timeout   ?? 30_000,
    });
  } catch (err) {
    return oauthResultFromError(err);
  }

  if (response.error || response.httpStatus >= 400) {
    return oauthResultFromError(fromTokenErrorResponse(response, response.httpStatus));
  }

  if (!response.access_token) {
    return oauthResultFromError(configurationError("Token endpoint did not return an access_token."));
  }

  return oauthResultFromTokenResponse(response);
}

