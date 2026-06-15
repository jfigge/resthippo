/**
 * auth/flows/token-exchange.js
 *
 * OAuth 2.0 Token Exchange — RFC 8693.
 *
 * A single POST to the token endpoint that swaps a `subject_token` (and,
 * optionally, an `actor_token` for delegation) for a new token, optionally
 * narrowing it to a target `audience` / `resource` / `scope` and requesting a
 * specific `requested_token_type`. Used for impersonation/delegation and for
 * exchanging tokens across trust domains.
 *
 * This is a standard token-endpoint POST (success returns an access_token, 4xx
 * is a terminal OAuth error), so it reuses token-request.js#requestToken and the
 * shared client-authentication path.
 */

"use strict";

import { applyClientAuth, requestToken } from "./token-request.js";
import { mergeExtraParams } from "../utils/params.js";
import { TOKEN_EXCHANGE_GRANT_TYPE } from "../types/oauth-types.js";

/**
 * Execute the RFC 8693 Token Exchange grant.
 *
 * Reads from `config`:
 *   subjectToken, subjectTokenType (required), actorToken, actorTokenType,
 *   requestedTokenType, scope, audience, resource, credentials, clientId,
 *   clientSecret, extraParams, timeout, verifySsl.
 *
 * @param {object} config - authOAuth2 state from the request editor
 * @returns {Promise<import('../types/oauth-types').OAuthResult>}
 */
export async function tokenExchangeFlow(config) {
  // Config (subjectToken + subjectTokenType + accessTokenUrl) is validated up
  // front by the executor via validateOAuthConfig().
  const params = {
    grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
    subject_token: config.subjectToken.trim(),
    subject_token_type: config.subjectTokenType.trim(),
  };

  if (config.actorToken?.trim()) {
    params.actor_token = config.actorToken.trim();
    // actor_token_type is REQUIRED whenever an actor_token is present (§2.1).
    if (config.actorTokenType?.trim())
      params.actor_token_type = config.actorTokenType.trim();
  }
  if (config.requestedTokenType?.trim())
    params.requested_token_type = config.requestedTokenType.trim();
  if (config.scope?.trim()) params.scope = config.scope.trim();
  if (config.audience?.trim()) params.audience = config.audience.trim();
  if (config.resource?.trim()) params.resource = config.resource.trim();

  mergeExtraParams(params, config.extraParams);

  const headers = {};
  applyClientAuth(params, headers, config);

  return requestToken(config.accessTokenUrl.trim(), params, headers, config);
}
