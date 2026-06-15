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

import { applyClientAuth, requestToken } from "./token-request.js";
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
  // The refresh token is a runtime argument (not part of the config validated by
  // validateOAuthConfig), so it is still checked here. Config fields such as
  // accessTokenUrl were validated by the executor before this flow runs.
  if (!refreshToken?.trim())
    return oauthResultFromError(
      configurationError("No refresh token available."),
    );

  const params = {
    grant_type: "refresh_token",
    refresh_token: refreshToken.trim(),
  };
  const headers = {};

  // Refresh sends scope but neither audience nor `resource`: a refresh may only
  // narrow the originally granted scope (RFC 6749 §6), and the other indicators
  // were already bound at the initial grant. The omission is intentional.
  if (config.scope?.trim()) params.scope = config.scope.trim();

  // Client authentication. The refresh grant treats the client as optional: under
  // header auth it omits client_id from the body and authenticates with Basic
  // whenever a client_id is present, even without a secret. `optionalClient`
  // captures exactly that divergence.
  applyClientAuth(params, headers, config, { optionalClient: true });

  return requestToken(config.accessTokenUrl.trim(), params, headers, config);
}
