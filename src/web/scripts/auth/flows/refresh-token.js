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

import { postTokenRequest } from "../network/electron-network.js";
import {
  oauthResultFromTokenResponse,
  oauthResultFromError,
} from "../types/oauth-types.js";
import {
  configurationError,
  fromTokenErrorResponse,
} from "../types/oauth-errors.js";

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

  // Client authentication
  const credMethod = config.credentials ?? "header";
  if (credMethod === "body") {
    params.client_id = config.clientId?.trim() ?? "";
    if (config.clientSecret?.trim())
      params.client_secret = config.clientSecret.trim();
  } else if (config.clientId?.trim()) {
    const secret = config.clientSecret?.trim() ?? "";
    const encoded = btoa(`${config.clientId.trim()}:${secret}`);
    headers["Authorization"] = `Basic ${encoded}`;
  }

  let response;
  try {
    response = await postTokenRequest(config.accessTokenUrl.trim(), params, {
      headers,
      verifySsl: config.verifySsl !== false,
      timeout: config.timeout ?? 30_000,
    });
  } catch (err) {
    return oauthResultFromError(err);
  }

  if (response.error || response.httpStatus >= 400) {
    return oauthResultFromError(
      fromTokenErrorResponse(response, response.httpStatus),
    );
  }

  if (!response.access_token) {
    return oauthResultFromError(
      configurationError("Token endpoint did not return an access_token."),
    );
  }

  return oauthResultFromTokenResponse(response);
}
