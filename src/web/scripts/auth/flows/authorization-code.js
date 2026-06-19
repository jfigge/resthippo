/*
 * Copyright 2026 Jason Figge
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

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

import {
  openOAuthPopup,
  DEFAULT_REDIRECT_URI,
} from "../popup/callback-interceptor.js";
import { generateCodeVerifier, generateCodeChallenge } from "../utils/pkce.js";
import { generateState, validateState, discardState } from "../utils/state.js";
import { buildUrl, extractAuthCode } from "../utils/url.js";
import { mergeExtraParams } from "../utils/params.js";
import { oauthResultFromError } from "../types/oauth-types.js";
import {
  stateMismatchError,
  popupCancelledError,
  OAuthError,
  OAuthErrorCode,
} from "../types/oauth-errors.js";
import { applyClientAuth, requestToken } from "./token-request.js";

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
  // Config (required fields + authUrl validity) is validated up front by the
  // executor via validateOAuthConfig(); this flow assumes a valid config.
  const clientId = config.clientId.trim();
  const accessTokenUrl = config.accessTokenUrl.trim();
  const isPkce = config.clientType === "public";
  const redirectUri = config.redirectUri?.trim() || DEFAULT_REDIRECT_URI;

  // ── CSRF state ────────────────────────────────────────────────────────────
  const state = generateState();

  // ── PKCE material ─────────────────────────────────────────────────────────
  let codeVerifier = null;
  let codeChallenge = null;

  if (isPkce) {
    codeVerifier = generateCodeVerifier();
    codeChallenge = await generateCodeChallenge(codeVerifier);
  }

  // ── Build authorization URL ───────────────────────────────────────────────
  const authParams = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
  };

  if (config.scope?.trim()) authParams.scope = config.scope.trim();
  if (config.audience?.trim()) authParams.audience = config.audience.trim();
  if (config.resource?.trim()) authParams.resource = config.resource.trim();
  if (config.nonce?.trim()) authParams.nonce = config.nonce.trim();
  if (config.origin?.trim()) authParams.origin = config.origin.trim();

  // Advanced params surfaced from the UI
  if (config.prompt?.trim()) authParams.prompt = config.prompt.trim();
  if (config.loginHint?.trim()) authParams.login_hint = config.loginHint.trim();
  if (config.acrValues?.trim()) authParams.acr_values = config.acrValues.trim();
  if (config.responseMode?.trim())
    authParams.response_mode = config.responseMode.trim();

  if (isPkce) {
    authParams.code_challenge = codeChallenge;
    authParams.code_challenge_method = "S256";
  }

  // Extra custom parameters
  mergeExtraParams(authParams, config.extraParams);

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
    return oauthResultFromError(
      err instanceof OAuthError ? err : popupCancelledError(err?.message),
    );
  }

  // ── Parse callback ────────────────────────────────────────────────────────
  const {
    code,
    state: returnedState,
    error,
    errorDescription,
  } = extractAuthCode(callbackUrl);

  // CSRF state check — must match *this* flow's issued state, not merely any
  // outstanding one (the registry alone can't distinguish concurrent flows).
  // The `!==` short-circuit avoids consuming another flow's pending state.
  if (returnedState !== state || !validateState(returnedState)) {
    discardState(state);
    return oauthResultFromError(stateMismatchError());
  }

  // Server-side authorization error
  if (error) {
    return oauthResultFromError(
      new OAuthError(
        Object.values(OAuthErrorCode).includes(error)
          ? error
          : OAuthErrorCode.UNKNOWN,
        errorDescription ?? error,
      ),
    );
  }

  if (!code) {
    return oauthResultFromError(
      new OAuthError(
        OAuthErrorCode.MALFORMED_RESPONSE,
        "No authorization code in callback URL.",
      ),
    );
  }

  // ── Exchange code for tokens ──────────────────────────────────────────────
  const tokenParams = {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
  };

  if (isPkce) {
    tokenParams.code_verifier = codeVerifier;
  }

  if (config.scope?.trim()) tokenParams.scope = config.scope.trim();

  // Extra custom token params
  mergeExtraParams(tokenParams, config.extraTokenParams);

  // Confidential clients authenticate with their secret; PKCE/public clients
  // prove possession with the code_verifier alone (client_id is already in the
  // token params above), so they skip client authentication entirely.
  const tokenHeaders = {};
  applyClientAuth(tokenParams, tokenHeaders, config, {
    sendEmptySecret: true,
    skip: isPkce,
  });

  return requestToken(accessTokenUrl, tokenParams, tokenHeaders, config);
}
