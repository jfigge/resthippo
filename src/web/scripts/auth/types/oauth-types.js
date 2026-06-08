/**
 * auth/types/oauth-types.js
 *
 * OAuth 2.0 / OpenID Connect type helpers for JavaScript.
 * Provides factory functions, constants, and JSDoc type definitions.
 */

"use strict";

// ── Grant type constants ─────────────────────────────────────────────────────

/** RFC 6749 grant type string constants. */
export const GrantType = Object.freeze({
  CLIENT_CREDENTIALS: "client_credentials",
  AUTHORIZATION_CODE: "authorization_code",
  PASSWORD: "password",
  IMPLICIT: "implicit",
  REFRESH_TOKEN: "refresh_token",
});

// ── OAuthResult factory ──────────────────────────────────────────────────────

/**
 * Create a normalised OAuthResult object.
 *
 * Shape:
 * @typedef {object} OAuthResult
 * @property {boolean}                  success       - Whether the flow succeeded
 * @property {string|null}              accessToken   - Opaque access token (do not log)
 * @property {string|null}              refreshToken  - Refresh token, if issued (do not log)
 * @property {string|null}              idToken       - ID token (OpenID Connect), if present
 * @property {number|null}              expiresIn     - Lifetime in seconds from the server
 * @property {number|null}              expiresAt     - Absolute expiry as Date.now() + expiresIn*1000
 * @property {string}                   tokenType     - Usually "Bearer"
 * @property {string|null}              scope         - Space-separated granted scopes
 * @property {import('./oauth-errors').OAuthError|null} error - Structured error when success=false
 *
 * @param {Partial<OAuthResult> & { success: boolean }} data
 * @returns {OAuthResult}
 */
export function createOAuthResult(data) {
  return {
    success: data.success ?? false,
    accessToken: data.accessToken ?? null,
    refreshToken: data.refreshToken ?? null,
    idToken: data.idToken ?? null,
    expiresIn: data.expiresIn ?? null,
    expiresAt: data.expiresAt ?? null,
    tokenType: data.tokenType ?? "Bearer",
    scope: data.scope ?? null,
    error: data.error ?? null,
  };
}

/**
 * Build an OAuthResult from a successful token endpoint JSON response body.
 *
 * @param {object} body - Parsed JSON from the token endpoint
 * @returns {OAuthResult}
 */
export function oauthResultFromTokenResponse(body) {
  // Guard against non-numeric expires_in values (e.g. "abc" or "") which would
  // produce NaN and propagate into expiresAt, defeating the TokenEntry expiry
  // check (NaN comparisons return false → token treated as never-expiring).
  const parsedExpires =
    body.expires_in != null ? Number(body.expires_in) : null;
  const expiresIn = Number.isFinite(parsedExpires) ? parsedExpires : null;
  const expiresAt = expiresIn != null ? Date.now() + expiresIn * 1_000 : null;

  return createOAuthResult({
    success: true,
    accessToken: body.access_token ?? null,
    refreshToken: body.refresh_token ?? null,
    idToken: body.id_token ?? null,
    expiresIn,
    expiresAt,
    tokenType: body.token_type ?? "Bearer",
    scope: body.scope ?? null,
  });
}

/**
 * Build a failed OAuthResult directly from an OAuthError.
 *
 * @param {import('./oauth-errors').OAuthError} error
 * @returns {OAuthResult}
 */
export function oauthResultFromError(error) {
  return createOAuthResult({ success: false, error });
}

// ── OAuth config schema ──────────────────────────────────────────────────────

/**
 * Whether `value` parses as an absolute URL.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isValidUrl(value) {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate that a config object has the minimum required fields for the
 * chosen grant type.  Returns the first validation error message or null.
 *
 * This is the single source of required-field validation for every grant: the
 * executor (oauth-executor.js) calls it before dispatching, and the individual
 * flows assume the config has already passed through here — they do not
 * re-validate. The popup grants (authorization-code, implicit) additionally get
 * their `authUrl` checked for URL validity here so a malformed value is rejected
 * before a window is opened.
 *
 * @param {object} config - authOAuth2 state from the request editor
 * @returns {string|null}
 */
export function validateOAuthConfig(config) {
  const g = config?.grantType;

  if (!g) return "Grant type is required.";

  if (g !== GrantType.IMPLICIT) {
    if (!config.accessTokenUrl?.trim()) return "Access Token URL is required.";
  }

  switch (g) {
    case GrantType.CLIENT_CREDENTIALS:
      if (!config.clientId?.trim()) return "Client ID is required.";
      break;

    case GrantType.AUTHORIZATION_CODE:
      if (!config.clientId?.trim()) return "Client ID is required.";
      if (!config.authUrl?.trim()) return "Auth URL is required.";
      if (!isValidUrl(config.authUrl.trim()))
        return "Auth URL is not a valid URL.";
      break;

    case GrantType.PASSWORD:
      if (!config.clientId?.trim()) return "Client ID is required.";
      if (!config.username?.trim()) return "Username is required.";
      if (!config.password?.trim()) return "Password is required.";
      break;

    case GrantType.IMPLICIT:
      if (!config.authUrl?.trim()) return "Auth URL is required.";
      if (!isValidUrl(config.authUrl.trim()))
        return "Auth URL is not a valid URL.";
      if (!config.clientId?.trim()) return "Client ID is required.";
      break;

    default:
      return `Unsupported grant type: ${g}`;
  }

  return null; // valid
}
