/**
 * auth/flows/token-exchange.js
 *
 * Shared building blocks for the OAuth grants that POST to a token endpoint
 * (authorization-code, client-credentials, password, refresh-token). Three
 * concerns recurred verbatim across those four flows and are centralised here:
 *
 *   • basicAuthHeader()  — RFC 6749 §2.3.1 HTTP Basic credential string.
 *   • applyClientAuth()  — place client_id (+ client_secret) in the body or an
 *                          Authorization header per `config.credentials`.
 *   • requestToken()     — POST the request and normalise the response into an
 *                          OAuthResult (transport error / OAuth error / missing
 *                          access_token guards).
 *
 * The implicit grant is intentionally absent: it receives its token from a URL
 * fragment and never contacts the token endpoint, so it shares none of this.
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
 * Build an HTTP Basic `Authorization` credential (RFC 6749 §2.3.1): the
 * client_id is the username and the client_secret the password, joined by ":"
 * and base64-encoded. An absent secret encodes as an empty password.
 *
 * @param {string} clientId
 * @param {string} [clientSecret=""]
 * @returns {string} e.g. "Basic Zm9vOmJhcg=="
 */
export function basicAuthHeader(clientId, clientSecret = "") {
  return `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
}

/**
 * Apply client authentication to a token request, mutating `params` / `headers`
 * in place per `config.credentials`:
 *
 *   "body":   client_id (and client_secret, when present) go in the form body.
 *   "header" (default): client_id stays in the body and the secret is sent as an
 *             HTTP Basic Authorization header — only when a secret is present.
 *
 * This is the single client-authentication path for every token-acquiring grant.
 * Three behaviours that genuinely differ between grants are selected via `opts`
 * rather than re-implemented at the call site:
 *
 *   • client-credentials / password — defaults.
 *   • authorization-code — `{ sendEmptySecret: true }` for confidential clients;
 *     public (PKCE) clients pass `{ skip: true }` since possession is proven by
 *     the code_verifier alone.
 *   • refresh-token — `{ optionalClient: true }` (see below).
 *
 * @param {Record<string,string>} params  - form body params (mutated)
 * @param {Record<string,string>} headers - request headers (mutated)
 * @param {object} config                 - reads clientId, clientSecret, credentials
 * @param {object} [opts]
 * @param {boolean} [opts.sendEmptySecret=false] - in "body" mode, emit
 *        client_secret even when empty (the confidential authorization-code
 *        grant sends `client_secret=""` rather than omitting the field).
 * @param {boolean} [opts.skip=false] - apply no client authentication at all
 *        (public/PKCE authorization-code clients).
 * @param {boolean} [opts.optionalClient=false] - treat the client as optional,
 *        per the refresh-token grant (RFC 6749 §6): under header auth omit
 *        client_id from the body and send the Basic header whenever a client_id
 *        is present, even without a secret (public clients may refresh).
 */
export function applyClientAuth(params, headers, config, opts = {}) {
  const {
    sendEmptySecret = false,
    skip = false,
    optionalClient = false,
  } = opts;
  if (skip) return;

  const clientId = config.clientId?.trim() ?? "";
  const secret = config.clientSecret?.trim() ?? "";
  const credMethod = config.credentials ?? "header";

  if (credMethod === "body") {
    params.client_id = clientId;
    if (secret || sendEmptySecret) params.client_secret = secret;
    return;
  }

  // Header (HTTP Basic) credentials mode.
  if (!optionalClient) params.client_id = clientId;
  if (optionalClient ? clientId : secret) {
    headers["Authorization"] = basicAuthHeader(clientId, secret);
  }
}

/**
 * POST a token request and normalise the outcome into an OAuthResult.
 *
 * This is the byte-identical tail every token-acquiring grant ended with: one
 * network call wrapped so transport failures become an error result, then the
 * two standard response guards (server/OAuth error, then missing access_token)
 * before mapping a success response.
 *
 * @param {string} url                    - token endpoint (already trimmed)
 * @param {Record<string,string>} params  - form body params
 * @param {Record<string,string>} headers - request headers
 * @param {object} config                 - reads verifySsl, timeout
 * @returns {Promise<import('../types/oauth-types').OAuthResult>}
 */
export async function requestToken(url, params, headers, config) {
  let response;
  try {
    response = await postTokenRequest(url, params, {
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
