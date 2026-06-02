/**
 * auth/flows/refresh-token.js
 *
 * OAuth 2.0 Refresh Token Grant — RFC 6749 §6
 *
 * Exchanges a refresh token for a new access token (and optionally a new
 * refresh token).  Called automatically by the executor when an access token
 * has expired and a refresh token is available.
 */

"use strict";

import { basicAuthHeader, requestToken } from "./token-exchange.js";
import { oauthResultFromError } from "../types/oauth-types.js";
import { configurationError } from "../types/oauth-errors.js";

/**
 * Execute the Refresh Token grant.
 *
 * @param {object} config       - authOAuth2 state (needs accessTokenUrl, clientId)
 * @param {string} refreshToken - The refresh token to exchange
 * @returns {Promise<import('../types/oauth-types').OAuthResult>}
 */
export async function refreshTokenFlow(config, refreshToken) {
  if (!refreshToken?.trim())
    return oauthResultFromError(
      configurationError("No refresh token available."),
    );
  if (!config.accessTokenUrl?.trim())
    return oauthResultFromError(
      configurationError("Access Token URL is required."),
    );

  const params = {
    grant_type: "refresh_token",
    refresh_token: refreshToken.trim(),
  };
  const headers = {};

  if (config.scope?.trim()) params.scope = config.scope.trim();

  // Client authentication. Unlike the other token-acquiring grants, the refresh
  // exchange treats client_id as optional and does NOT echo it into the body
  // under header auth, so it keeps its own block rather than using
  // applyClientAuth(); only the Basic header construction is shared.
  const credMethod = config.credentials ?? "header";
  if (credMethod === "body") {
    params.client_id = config.clientId?.trim() ?? "";
    if (config.clientSecret?.trim())
      params.client_secret = config.clientSecret.trim();
  } else if (config.clientId?.trim()) {
    headers["Authorization"] = basicAuthHeader(
      config.clientId.trim(),
      config.clientSecret?.trim() ?? "",
    );
  }

  return requestToken(config.accessTokenUrl.trim(), params, headers, config);
}
