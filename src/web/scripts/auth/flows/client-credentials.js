/**
 * auth/flows/client-credentials.js
 *
 * OAuth 2.0 Client Credentials Grant — RFC 6749 §4.4
 *
 * Suitable for machine-to-machine (M2M) requests where there is no interactive
 * user involved.  The client authenticates directly with its own credentials.
 */

"use strict";

import { postTokenRequest }             from "../network/electron-network.js";
import { oauthResultFromTokenResponse, oauthResultFromError } from "../types/oauth-types.js";
import { configurationError, fromTokenErrorResponse }        from "../types/oauth-errors.js";

/**
 * Execute the Client Credentials flow.
 *
 * Advanced settings honoured from `config`:
 *   audience, resource, scope, credentials ("header"|"body"),
 *   headerPrefix, timeout, verifySsl, extraParams (object)
 *
 * @param {object} config - authOAuth2 state from the request editor
 * @returns {Promise<import('../types/oauth-types').OAuthResult>}
 */
export async function clientCredentialsFlow(config) {
  // ── Validate ─────────────────────────────────────────────────────────────
  if (!config.clientId?.trim())       return oauthResultFromError(configurationError("Client ID is required."));
  if (!config.accessTokenUrl?.trim()) return oauthResultFromError(configurationError("Access Token URL is required."));

  // ── Build parameters ──────────────────────────────────────────────────────
  const params = { grant_type: "client_credentials" };

  if (config.scope?.trim())    params.scope    = config.scope.trim();
  if (config.audience?.trim()) params.audience = config.audience.trim();
  if (config.resource?.trim()) params.resource = config.resource.trim();

  // Merge any extra custom parameters from advanced settings
  if (config.extraParams && typeof config.extraParams === "object") {
    for (const [k, v] of Object.entries(config.extraParams)) {
      if (k && v != null && v !== "") params[k] = String(v);
    }
  }

  // ── Client authentication ─────────────────────────────────────────────────
  const headers    = {};
  const clientId   = config.clientId.trim();
  const credMethod = config.credentials ?? "header";

  params.client_id = clientId;
  if (credMethod === "body") {
    if (config.clientSecret?.trim()) {
      params.client_secret = config.clientSecret.trim();
    }
  } else {
    // Default: Authorization: Basic header
    if (config.clientSecret?.trim()) {
      const encoded = btoa(`${clientId}:${config.clientSecret.trim()}`);
      headers["Authorization"] = `Basic ${encoded}`;
    }
  }

  // ── Execute ──────────────────────────���────────────────────────────────────
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

  // ── Handle error response ────────────────────────────────��────────────────
  if (response.error || response.httpStatus >= 400) {
    return oauthResultFromError(fromTokenErrorResponse(response, response.httpStatus));
  }

  // ── Validate minimum success fields ───────────────────────────────────────
  if (!response.access_token) {
    return oauthResultFromError(
      configurationError("Token endpoint did not return an access_token."),
    );
  }

  return oauthResultFromTokenResponse(response);
}

