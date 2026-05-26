/**
 * auth/types/oauth-errors.js
 *
 * Structured OAuth 2.0 error types.
 * Normalises errors from all OAuth flows into a consistent shape so every
 * caller deals with the same interface regardless of which flow produced it.
 */

"use strict";

// ── Error codes ─────────────────────────────────────────────────────────────

/**
 * Canonical OAuth 2.0 / OpenID Connect error codes.
 * Values are the exact strings the spec defines (RFC 6749, RFC 8628, OIDC Core).
 */
export const OAuthErrorCode = Object.freeze({
  // RFC 6749 §5.2  Token Error Response
  INVALID_REQUEST: "invalid_request",
  INVALID_CLIENT: "invalid_client",
  INVALID_GRANT: "invalid_grant",
  UNAUTHORIZED_CLIENT: "unauthorized_client",
  UNSUPPORTED_GRANT_TYPE: "unsupported_grant_type",
  INVALID_SCOPE: "invalid_scope",

  // RFC 6749 §4.1.2.1  Authorization Error Response
  ACCESS_DENIED: "access_denied",
  UNSUPPORTED_RESPONSE_TYPE: "unsupported_response_type",
  SERVER_ERROR: "server_error",
  TEMPORARILY_UNAVAILABLE: "temporarily_unavailable",

  // Local / client-side errors (not from the OAuth server)
  NETWORK_ERROR: "network_error",
  TIMEOUT: "timeout",
  POPUP_CANCELLED: "popup_cancelled",
  POPUP_UNAVAILABLE: "popup_unavailable",
  INVALID_REDIRECT: "invalid_redirect",
  STATE_MISMATCH: "state_mismatch",
  NONCE_MISMATCH: "nonce_mismatch",
  MALFORMED_RESPONSE: "malformed_response",
  CONFIGURATION_ERROR: "configuration_error",
  TOKEN_EXPIRED: "token_expired",
  UNKNOWN: "unknown",
});

// ── OAuthError class ────────────────────────────────────────────────────────

/**
 * Represents any error that occurred during an OAuth flow.
 *
 * @property {string}      code        - One of OAuthErrorCode values
 * @property {string}      description - Human-readable explanation
 * @property {number|null} httpStatus  - HTTP status code if the error came from a server response
 * @property {object|null} raw         - Raw server response body (never log tokens from this)
 */
export class OAuthError extends Error {
  /**
   * @param {string}      code
   * @param {string}      description
   * @param {number|null} [httpStatus]
   * @param {object|null} [raw]
   */
  constructor(code, description, httpStatus = null, raw = null) {
    super(description);
    this.name = "OAuthError";
    this.code = code;
    this.description = description;
    this.httpStatus = httpStatus;
    // Raw is intentionally not enumerable so it can't easily leak into logs.
    Object.defineProperty(this, "raw", {
      value: raw,
      enumerable: false,
      writable: true,
    });
  }

  toJSON() {
    return {
      code: this.code,
      description: this.description,
      httpStatus: this.httpStatus,
    };
  }
}

// ── Factory helpers ─────────────────────────────────────────────────────────

/**
 * Create an OAuthError from a caught network / transport error.
 *
 * @param {Error|{name?: string, message?: string}|string} err
 * @returns {OAuthError}
 */
export function fromNetworkError(err) {
  const msg =
    (err instanceof Error ? err.message : (err?.message ?? String(err))) ||
    "Unknown network error";
  const code = /timeout|timed.?out/i.test(msg)
    ? OAuthErrorCode.TIMEOUT
    : OAuthErrorCode.NETWORK_ERROR;
  return new OAuthError(code, msg);
}

/**
 * Create an OAuthError from a token-endpoint JSON error response.
 *
 * @param {object} body       - Parsed JSON body from the token endpoint
 * @param {number} httpStatus - HTTP status code
 * @returns {OAuthError}
 */
export function fromTokenErrorResponse(body, httpStatus) {
  const serverCode = typeof body?.error === "string" ? body.error : null;
  const desc =
    typeof body?.error_description === "string"
      ? body.error_description
      : (serverCode ?? `Token request failed (HTTP ${httpStatus})`);

  const code =
    serverCode && Object.values(OAuthErrorCode).includes(serverCode)
      ? serverCode
      : OAuthErrorCode.UNKNOWN;

  return new OAuthError(code, desc, httpStatus, body);
}

/**
 * Create a configuration error (missing required field, invalid URL, etc.)
 *
 * @param {string} message
 * @returns {OAuthError}
 */
export function configurationError(message) {
  return new OAuthError(OAuthErrorCode.CONFIGURATION_ERROR, message);
}

/**
 * Create a popup-cancelled error.
 *
 * @param {string} [message]
 * @returns {OAuthError}
 */
export function popupCancelledError(
  message = "Authorization cancelled by user",
) {
  return new OAuthError(OAuthErrorCode.POPUP_CANCELLED, message);
}

/**
 * Create a state-mismatch (CSRF) error.
 *
 * @returns {OAuthError}
 */
export function stateMismatchError() {
  return new OAuthError(
    OAuthErrorCode.STATE_MISMATCH,
    "OAuth state mismatch — possible CSRF attack. Request was not completed.",
  );
}
