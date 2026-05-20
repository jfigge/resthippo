

/**
 * auth/flows/implicit.js
 *
 * OAuth 2.0 Implicit Grant — RFC 6749 §4.2
 *
 * ⚠️  The Implicit flow is considered insecure and has been removed from
 *     OAuth 2.1.  Include only for legacy IdPs that do not support
 *     Authorization Code + PKCE.
 *
 * The access token is returned directly in the URL fragment of the
 * redirect callback (not via a server-side token exchange).
 * All popup handling goes through Electron's BrowserWindow IPC.
 */

"use strict";

import { openOAuthPopup, DEFAULT_REDIRECT_URI } from "../popup/callback-interceptor.js";
import { generateState, validateState, discardState } from "../utils/state.js";
import { buildUrl, extractImplicitToken }              from "../utils/url.js";
import { oauthResultFromError, createOAuthResult }     from "../types/oauth-types.js";
import {
  configurationError, stateMismatchError, popupCancelledError,
  OAuthError, OAuthErrorCode,
} from "../types/oauth-errors.js";

/**
 * Execute the Implicit Grant flow.
 *
 * @param {object} config - authOAuth2 state from the request editor
 * @returns {Promise<import('../types/oauth-types').OAuthResult>}
 */
export async function implicitFlow(config) {
  // ── Validate ─────────────────────────────────────────────────────────────
  if (!config.clientId?.trim()) return oauthResultFromError(configurationError("Client ID is required."));
  if (!config.authUrl?.trim())  return oauthResultFromError(configurationError("Auth URL is required."));

  const redirectUri = config.redirectUri?.trim() || DEFAULT_REDIRECT_URI;

  // ── CSRF state ────────────────────────────────────────────────────────────
  const state = generateState();

  // ── Determine response_type ───────────────────────────────────────────────
  let responseType = "token";
  switch (config.responseType) {
    case "id_token": responseType = "id_token";       break;
    case "both":     responseType = "token id_token"; break;
    default:         responseType = "token";           break;
  }

  // ── Build authorization URL ───────────────────────────────────────────────
  const authParams = {
    response_type: responseType,
    client_id:     config.clientId.trim(),
    redirect_uri:  redirectUri,
    state,
  };

  if (config.scope?.trim())    authParams.scope    = config.scope.trim();
  if (config.nonce?.trim())    authParams.nonce    = config.nonce.trim();
  if (config.audience?.trim()) authParams.audience = config.audience.trim();
  if (config.resource?.trim()) authParams.resource = config.resource.trim();

  // Advanced / extra params
  if (config.extraParams && typeof config.extraParams === "object") {
    for (const [k, v] of Object.entries(config.extraParams)) {
      if (k && v != null && v !== "") authParams[k] = String(v);
    }
  }

  const authUrl = buildUrl(config.authUrl.trim(), authParams);

  // ── Open popup ────────────────────────────────────────────────────────────
  let callbackUrl;
  try {
    callbackUrl = await openOAuthPopup(authUrl, redirectUri, "OAuth 2.0 — Implicit");
  } catch (err) {
    discardState(state);
    return oauthResultFromError(err instanceof OAuthError ? err : popupCancelledError(err?.message));
  }

  // ── Parse callback ────────────────────────────────────────────────────────
  const parts = extractImplicitToken(callbackUrl);

  // CSRF state check
  if (!validateState(parts.state)) {
    return oauthResultFromError(stateMismatchError());
  }

  // Server-side error
  if (parts.error) {
    return oauthResultFromError(
      new OAuthError(
        Object.values(OAuthErrorCode).includes(parts.error) ? parts.error : OAuthErrorCode.UNKNOWN,
        parts.errorDescription ?? parts.error,
      ),
    );
  }

  if (!parts.accessToken && !parts.idToken) {
    return oauthResultFromError(
      new OAuthError(OAuthErrorCode.MALFORMED_RESPONSE, "No access_token or id_token in callback."),
    );
  }

  const expiresIn = parts.expiresIn != null ? Number(parts.expiresIn) : null;
  const expiresAt = expiresIn != null ? Date.now() + expiresIn * 1_000 : null;

  return createOAuthResult({
    success:      true,
    accessToken:  parts.accessToken,
    idToken:      parts.idToken      ?? null,
    refreshToken: null, // implicit flow never issues a refresh token
    expiresIn,
    expiresAt,
    tokenType:    parts.tokenType ?? "Bearer",
    scope:        parts.scope     ?? config.scope ?? null,
  });
}

