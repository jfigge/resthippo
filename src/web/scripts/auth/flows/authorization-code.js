/**
 * auth/flows/authorization-code.js
 *
 * OAuth 2.0 Authorization Code Grant — RFC 6749 §4.1
 * with optional PKCE extension (RFC 7636) for public clients.
 *
 * Flow:
 *   1. Generate state (+ PKCE code_verifier / code_challenge for public clients)
 *   2. Build authorization URL
 *   3. Open Electron popup and wait for the redirect callback
 *   4. Validate state (CSRF check)
 *   5. Exchange authorization code for tokens via token endpoint
 *   6. Return normalised OAuthResult
 */

"use strict";

import { openOAuthPopup, DEFAULT_REDIRECT_URI } from "../popup/callback-interceptor.js";
import { generateCodeVerifier, generateCodeChallenge } from "../utils/pkce.js";
import { generateState, validateState, discardState }  from "../utils/state.js";
import { buildUrl, extractAuthCode }                   from "../utils/url.js";
import { postTokenRequest }                            from "../network/electron-network.js";
import { oauthResultFromTokenResponse, oauthResultFromError } from "../types/oauth-types.js";
import {
  configurationError, stateMismatchError, popupCancelledError,
  fromTokenErrorResponse, OAuthError, OAuthErrorCode,
} from "../types/oauth-errors.js";

/**
 * Execute the Authorization Code grant (confidential or public/PKCE client).
 *
 * Distinguishes client types via `config.clientType`:
 *   "confidential" — standard secret-based flow (no PKCE unless overridden)
 *   "public"       — always adds PKCE (S256)
 *
 * @param {object} config - authOAuth2 state from the request editor
 * @returns {Promise<import('../types/oauth-types').OAuthResult>}
 */
export async function authorizationCodeFlow(config) {
  // ── Validate ─────────────────────────────────────────────────────────────
  if (!config.clientId?.trim())       return oauthResultFromError(configurationError("Client ID is required."));
  if (!config.authUrl?.trim())        return oauthResultFromError(configurationError("Auth URL is required."));
  if (!config.accessTokenUrl?.trim()) return oauthResultFromError(configurationError("Access Token URL is required."));

  const isPkce      = config.clientType === "public";
  const redirectUri = config.redirectUri?.trim() || DEFAULT_REDIRECT_URI;

  // ── CSRF state ────────────────────────────────────────────────────────────
  const state = generateState();

  // ── PKCE material ─────────────────────────────────────────────────────────
  let codeVerifier   = null;
  let codeChallenge  = null;

  if (isPkce) {
    codeVerifier  = generateCodeVerifier();
    codeChallenge = await generateCodeChallenge(codeVerifier);
  }

  // ── Build authorization URL ───────────────────────────────────────────────
  const authParams = {
    response_type: "code",
    client_id:     config.clientId.trim(),
    redirect_uri:  redirectUri,
    state,
  };

  if (config.scope?.trim())    authParams.scope          = config.scope.trim();
  if (config.audience?.trim()) authParams.audience       = config.audience.trim();
  if (config.resource?.trim()) authParams.resource       = config.resource.trim();
  if (config.nonce?.trim())    authParams.nonce          = config.nonce.trim();
  if (config.origin?.trim())   authParams.origin         = config.origin.trim();

  // Advanced params surfaced from the UI
  if (config.prompt?.trim())       authParams.prompt       = config.prompt.trim();
  if (config.loginHint?.trim())    authParams.login_hint   = config.loginHint.trim();
  if (config.acrValues?.trim())    authParams.acr_values   = config.acrValues.trim();
  if (config.responseMode?.trim()) authParams.response_mode = config.responseMode.trim();

  if (isPkce) {
    authParams.code_challenge        = codeChallenge;
    authParams.code_challenge_method = "S256";
  }

  // Extra custom parameters
  if (config.extraParams && typeof config.extraParams === "object") {
    for (const [k, v] of Object.entries(config.extraParams)) {
      if (k && v != null && v !== "") authParams[k] = String(v);
    }
  }

  const authUrl = buildUrl(config.authUrl.trim(), authParams);

  // ── Open popup ────────────────────────────────────────────────────────────
  let callbackUrl;
  try {
    callbackUrl = await openOAuthPopup(
      authUrl,
      redirectUri,
      "OAuth 2.0 — Authorization Code",
    );
  } catch (err) {
    discardState(state);
    return oauthResultFromError(err instanceof OAuthError ? err : popupCancelledError(err?.message));
  }

  // ── Parse callback ────────────────────────────────────────────────────────
  const { code, state: returnedState, error, errorDescription } = extractAuthCode(callbackUrl);

  // CSRF state check
  if (!validateState(returnedState)) {
    return oauthResultFromError(stateMismatchError());
  }

  // Server-side authorization error
  if (error) {
    return oauthResultFromError(
      new OAuthError(
        Object.values(OAuthErrorCode).includes(error) ? error : OAuthErrorCode.UNKNOWN,
        errorDescription ?? error,
      ),
    );
  }

  if (!code) {
    return oauthResultFromError(
      new OAuthError(OAuthErrorCode.MALFORMED_RESPONSE, "No authorization code in callback URL."),
    );
  }

  // ── Exchange code for tokens ──────────────────────────────────────────────
  const tokenParams = {
    grant_type:   "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id:    config.clientId.trim(),
  };

  if (isPkce && codeVerifier) {
    tokenParams.code_verifier = codeVerifier;
  }

  if (config.scope?.trim()) tokenParams.scope = config.scope.trim();

  // Extra custom token params
  if (config.extraTokenParams && typeof config.extraTokenParams === "object") {
    for (const [k, v] of Object.entries(config.extraTokenParams)) {
      if (k && v != null && v !== "") tokenParams[k] = String(v);
    }
  }

  const tokenHeaders = {};
  const credMethod   = config.credentials ?? "header";

  if (!isPkce) {
    // Confidential client: also send secret
    if (credMethod === "body") {
      tokenParams.client_secret = config.clientSecret?.trim() ?? "";
    } else if (config.clientSecret?.trim()) {
      const encoded = btoa(`${config.clientId.trim()}:${config.clientSecret.trim()}`);
      tokenHeaders["Authorization"] = `Basic ${encoded}`;
    }
  }

  let response;
  try {
    response = await postTokenRequest(config.accessTokenUrl.trim(), tokenParams, {
      headers:  tokenHeaders,
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
    return oauthResultFromError(
      configurationError("Token endpoint did not return an access_token."),
    );
  }

  return oauthResultFromTokenResponse(response);
}

