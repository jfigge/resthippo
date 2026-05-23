

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
import { generateNonce, validateNonce, discardNonce, decodeIdTokenPayload } from "../utils/nonce.js";
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
  }

  // ── OIDC nonce (replay protection for id_token) ───────────────────────────
  // Per OIDC Core §3.2.2.1, when an id_token is requested the client MUST send
  // a nonce and verify the echoed claim. A user-provided value is honoured
  // (advanced override) but otherwise we generate a fresh cryptographic nonce.
  const wantsIdToken = responseType.includes("id_token");
  let nonce = null;
  if (wantsIdToken) {
    nonce = config.nonce?.trim() || generateNonce();
  }

  // ── Build authorization URL ───────────────────────────────────────────────
  const authParams = {
    response_type: responseType,
    client_id:     config.clientId.trim(),
    redirect_uri:  redirectUri,
    state,
  };

  if (config.scope?.trim())    authParams.scope    = config.scope.trim();
  if (nonce)                   authParams.nonce    = nonce;
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
    if (nonce) discardNonce(nonce);
    return oauthResultFromError(err instanceof OAuthError ? err : popupCancelledError(err?.message));
  }

  // ── Parse callback ────────────────────────────────────────────────────────
  const parts = extractImplicitToken(callbackUrl);

  // CSRF state check
  if (!validateState(parts.state)) {
    discardState(state);
    if (nonce) discardNonce(nonce);
    return oauthResultFromError(stateMismatchError());
  }

  // Server-side error
  if (parts.error) {
    if (nonce) discardNonce(nonce);
    return oauthResultFromError(
      new OAuthError(
        Object.values(OAuthErrorCode).includes(parts.error) ? parts.error : OAuthErrorCode.UNKNOWN,
        parts.errorDescription ?? parts.error,
      ),
    );
  }

  if (!parts.accessToken && !parts.idToken) {
    if (nonce) discardNonce(nonce);
    return oauthResultFromError(
      new OAuthError(OAuthErrorCode.MALFORMED_RESPONSE, "No access_token or id_token in callback."),
    );
  }

  // ── OIDC nonce verification ──────────────────────────────────────────────
  // If we sent a nonce, the id_token's `nonce` claim must match it. A missing
  // id_token when one was requested, or a missing/mismatched claim, is a
  // potential replay attack.
  if (nonce) {
    if (!parts.idToken) {
      discardNonce(nonce);
      return oauthResultFromError(
        new OAuthError(OAuthErrorCode.MALFORMED_RESPONSE, "id_token was requested but not returned."),
      );
    }
    const payload = decodeIdTokenPayload(parts.idToken);
    if (!payload || !validateNonce(payload.nonce)) {
      discardNonce(nonce);
      return oauthResultFromError(
        new OAuthError(OAuthErrorCode.MALFORMED_RESPONSE, "id_token nonce mismatch."),
      );
    }
  }

  const n = Number(parts.expiresIn);
  const expiresIn = Number.isFinite(n) ? n : null;
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

