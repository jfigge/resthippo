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
 *
 *   // Inject bearer header into an outgoing request descriptor
 *   const descriptor = oauthExecutor.injectBearerToken(requestDescriptor, result.accessToken);
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
  async acquireToken(config) {
    // ── Validate configuration ────────────────────────────────────────────
    const configError = validateOAuthConfig(config);
    if (configError)
      return oauthResultFromError(configurationError(configError));

    const cacheKey = tokenStore.keyFor(config);

    // ── Return cached token if still valid (or use for refresh token) ────────
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

    // ── Attempt refresh if we have a stored refresh token ─────────────────
    if (cached?.refreshToken) {
      const refreshResult = await refreshTokenFlow(config, cached.refreshToken);
      if (refreshResult.success) {
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
   * Force a fresh token acquisition, bypassing the cache.
   *
   * @param {object} config - authOAuth2 state
   * @returns {Promise<import('./types/oauth-types').OAuthResult>}
   */
  async forceRefresh(config) {
    const cacheKey = tokenStore.keyFor(config);
    tokenStore.clear(cacheKey);
    return this.acquireToken(config);
  }

  /**
   * Clear the cached token for a given config.
   *
   * @param {object} config
   */
  clearToken(config) {
    tokenStore.clear(tokenStore.keyFor(config));
  }

  /**
   * Inject an Authorization: Bearer header into a request descriptor.
   *
   * Does NOT mutate the original descriptor — returns a new object.
   *
   * @param {object} descriptor  - Request descriptor { method, url, headers, body, … }
   * @param {string} token       - Access token
   * @param {string} [prefix]    - Token prefix, default "Bearer"
   * @returns {object}           New descriptor with Authorization header set
   */
  injectBearerToken(descriptor, token, prefix = "Bearer") {
    if (!token) return descriptor;
    return {
      ...descriptor,
      headers: {
        ...(descriptor.headers ?? {}),
        Authorization: `${prefix} ${token}`,
      },
    };
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
