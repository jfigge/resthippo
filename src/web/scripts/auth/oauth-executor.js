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
 * auth/oauth-executor.js
 *
 * OAuthExecutor — main entry point for all OAuth 2.0 token acquisition.
 *
 * Responsibilities:
 *   1. Route to the correct flow based on config.grantType
 *   2. Check the token cache before executing a flow
 *   3. Attempt token refresh when a cached token is about to expire
 *   4. Cache successful results
 *   5. Attach the bearer token to outgoing API request headers
 *
 * Usage (from request-editor.js):
 *   import { oauthExecutor } from './auth/oauth-executor.js';
 *
 *   // Acquire a token (uses cache / refresh automatically)
 *   const result = await oauthExecutor.acquireToken(authOAuth2Config);
 */

"use strict";

import { tokenStore } from "./tokens/token-store.js";
import { refreshTokenFlow } from "./flows/refresh-token.js";
import { clientCredentialsFlow } from "./flows/client-credentials.js";
import { authorizationCodeFlow } from "./flows/authorization-code.js";
import { passwordFlow } from "./flows/password.js";
import { implicitFlow } from "./flows/implicit.js";
import { deviceCodeFlow } from "./flows/device-code.js";
import { tokenExchangeFlow } from "./flows/token-exchange.js";
import {
  oauthResultFromError,
  createOAuthResult,
} from "./types/oauth-types.js";
import { validateOAuthConfig, GrantType } from "./types/oauth-types.js";
import { configurationError } from "./types/oauth-errors.js";

class OAuthExecutor {
  /**
   * Acquire an OAuth access token for the given configuration.
   *
   * Strategy:
   *   1. Validate config
   *   2. Return cached token if still valid
   *   3. Try refresh token if cached token is expired
   *   4. Run the full grant flow
   *   5. Cache and return result
   *
   * @param {object} config - authOAuth2 state from the request editor
   * @returns {Promise<import('./types/oauth-types').OAuthResult>}
   */
  /**
   * In-flight token acquisitions keyed by cacheKey. Concurrent callers for the
   * same config share one network round-trip instead of racing N parallel
   * refresh/grant requests — with refresh-token rotation (OAuth 2.1) those races
   * would invalidate each other and fail with invalid_grant.
   * @type {Map<string, Promise<import('./types/oauth-types').OAuthResult>>}
   */
  #inFlight = new Map();

  async acquireToken(config) {
    // ── Validate configuration ────────────────────────────────────────────
    const configError = validateOAuthConfig(config);
    if (configError)
      return oauthResultFromError(configurationError(configError));

    const cacheKey = tokenStore.keyFor(config);

    // ── Return cached token if still valid ────────────────────────────────
    const cached = tokenStore.get(cacheKey);
    if (cached?.isValid?.()) {
      return createOAuthResult({
        success: true,
        accessToken: cached.accessToken,
        refreshToken: cached.refreshToken,
        idToken: cached.idToken,
        expiresAt: cached.expiresAt,
        expiresIn: cached.expiresIn,
        tokenType: cached.tokenType,
        scope: cached.scope,
      });
    }

    // ── Coalesce concurrent acquisitions for the same config ──────────────
    const inFlight = this.#inFlight.get(cacheKey);
    if (inFlight) return inFlight;

    const promise = this.#refreshOrGrant(config, cacheKey).finally(() => {
      // Only clear the slot if it's still ours — a forceRefresh() may have
      // superseded it with a newer acquisition for the same key.
      if (this.#inFlight.get(cacheKey) === promise) {
        this.#inFlight.delete(cacheKey);
      }
    });
    this.#inFlight.set(cacheKey, promise);
    return promise;
  }

  /**
   * Uncached acquisition: try a refresh token first, then fall back to the full
   * grant flow. Caches a successful result. Runs under the #inFlight
   * de-duplication so only one of N concurrent callers reaches the network.
   *
   * The refresh token comes from the cached entry (the normal expiry path) or,
   * when `refreshTokenHint` is supplied, from the caller — forceRefresh() clears
   * the cache before this runs, so it passes the component's stored refresh token
   * through explicitly to keep a manual "Refresh Token" a silent exchange rather
   * than a full re-grant (which would reopen the browser popup for auth-code).
   *
   * @param {object} config
   * @param {string} cacheKey
   * @param {string} [refreshTokenHint] - refresh token to prefer over the cache
   * @returns {Promise<import('./types/oauth-types').OAuthResult>}
   */
  async #refreshOrGrant(config, cacheKey, refreshTokenHint) {
    // ── Attempt refresh if we have a refresh token (hint wins over cache) ──
    const refreshToken =
      refreshTokenHint?.trim() || tokenStore.get(cacheKey)?.refreshToken;
    if (refreshToken) {
      const refreshResult = await refreshTokenFlow(config, refreshToken);
      if (refreshResult.success) {
        // RFC 6749 §6: the refresh response MAY omit a new refresh_token, in
        // which case the client keeps using the current one. Carry it forward so
        // a non-rotating IdP doesn't lose its refresh token after one refresh
        // (which would force the next refresh back into a full grant / popup).
        if (!refreshResult.refreshToken)
          refreshResult.refreshToken = refreshToken;
        tokenStore.set(cacheKey, refreshResult);
        return refreshResult;
      }
      // Refresh failed — fall through to full flow
      tokenStore.clear(cacheKey);
    }

    // ── Run the appropriate OAuth flow ────────────────────────────────────
    const result = await this._runFlow(config);

    // Cache successful results
    if (result.success) {
      tokenStore.set(cacheKey, result);
    }

    return result;
  }

  /**
   * Force a fresh token acquisition, bypassing the *cached access token*.
   *
   * This backs the manual "Get Token" / "Refresh Token" button. "Force" means
   * "don't hand back the token already in the cache", not "always run the full
   * grant": when the config carries a refresh token (`config.refreshToken`, the
   * component's stored value) it is preferred, so "Refresh Token" performs a
   * silent `refresh_token` exchange instead of reopening the browser popup. It
   * falls back to the full grant only when there is no refresh token or the
   * refresh fails.
   *
   * @param {object} config - authOAuth2 state (may include `refreshToken`)
   * @returns {Promise<import('./types/oauth-types').OAuthResult>}
   */
  async forceRefresh(config) {
    const cacheKey = tokenStore.keyFor(config);

    // "Force" must run a genuinely fresh acquisition, but it must NOT run one in
    // parallel with an acquisition already in flight for the same config: with
    // refresh-token rotation (OAuth 2.1) two concurrent token requests
    // invalidate each other and fail with invalid_grant. So serialize behind any
    // in-flight promise (awaiting its outcome, which we then discard), clear the
    // cache it may have populated, and only then start the fresh acquisition.
    // The cache clear drops the cached refresh token too, so pass the config's
    // stored refresh token through as the hint to keep the exchange silent.
    // Register the chained promise as the new in-flight entry so concurrent
    // callers coalesce onto this forced refresh instead of starting yet another.
    const prior = this.#inFlight.get(cacheKey);
    const fresh = (async () => {
      if (prior) {
        try {
          await prior;
        } catch {
          // Ignore — we're forcing a new attempt regardless of how it resolved.
        }
      }
      tokenStore.clear(cacheKey);
      return this.#refreshOrGrant(config, cacheKey, config.refreshToken);
    })().finally(() => {
      if (this.#inFlight.get(cacheKey) === fresh) {
        this.#inFlight.delete(cacheKey);
      }
    });
    this.#inFlight.set(cacheKey, fresh);
    return fresh;
  }

  /**
   * Clear the cached token for a given config.
   *
   * @param {object} config
   */
  clearToken(config) {
    tokenStore.clear(tokenStore.keyFor(config));
  }

  // ── Internal routing ───────────���────────────────────────────────────────

  /**
   * Route to the correct flow implementation.
   *
   * @param {object} config
   * @returns {Promise<import('./types/oauth-types').OAuthResult>}
   */
  async _runFlow(config) {
    switch (config.grantType) {
      case GrantType.CLIENT_CREDENTIALS:
        return clientCredentialsFlow(config);

      case GrantType.AUTHORIZATION_CODE:
        return authorizationCodeFlow(config);

      case GrantType.PASSWORD:
        return passwordFlow(config);

      case GrantType.IMPLICIT:
        return implicitFlow(config);

      case GrantType.DEVICE_CODE:
        return deviceCodeFlow(config);

      case GrantType.TOKEN_EXCHANGE:
        return tokenExchangeFlow(config);

      default:
        return oauthResultFromError(
          configurationError(`Unsupported grant type: ${config.grantType}`),
        );
    }
  }
}

/** Shared singleton executor for the renderer process. */
export const oauthExecutor = new OAuthExecutor();
