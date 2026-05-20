/**
 * auth/tokens/token-store.js
 *
 * In-memory token cache with per-entry expiry tracking and optional refresh.
 *
 * Tokens are keyed by a stable "config key" derived from the OAuth config
 * (grant type + client ID + token URL) so that different requests sharing
 * identical configurations can share cached tokens without re-fetching.
 *
 * Security notes:
 *   • Tokens are held in memory only — never written to disk by this module.
 *   • The entire cache is cleared when the Electron renderer process reloads.
 *   • Access tokens and refresh tokens are never logged or stringified in
 *     enumerable properties.
 */

"use strict";

/** How many seconds before expiry we consider a token "about to expire" and proactively refresh it. */
const EXPIRY_BUFFER_MS = 60_000; // 60 s

// ── TokenEntry ───────────────────────────────────────────────────────────────

class TokenEntry {
  /**
   * @param {import('../types/oauth-types').OAuthResult} result
   */
  constructor(result) {
    this.tokenType    = result.tokenType    ?? "Bearer";
    this.scope        = result.scope        ?? null;
    this.expiresAt    = result.expiresAt    ?? null; // ms timestamp or null (never expires)
    this.expiresIn    = result.expiresIn    ?? null;

    // Sensitive fields — non-enumerable so they don't appear in JSON.stringify / console.log
    Object.defineProperty(this, "_accessToken",  { value: result.accessToken,  writable: true, enumerable: false });
    Object.defineProperty(this, "_refreshToken", { value: result.refreshToken, writable: true, enumerable: false });
    Object.defineProperty(this, "_idToken",      { value: result.idToken,      writable: true, enumerable: false });
  }

  get accessToken()  { return this._accessToken;  }
  get refreshToken() { return this._refreshToken; }
  get idToken()      { return this._idToken;       }

  /** True if the token is still valid (with the proactive-refresh buffer applied). */
  isValid() {
    if (this.expiresAt === null) return true; // no expiry info → assume valid
    return Date.now() < this.expiresAt - EXPIRY_BUFFER_MS;
  }

  /** True if the token has hard-expired (no buffer applied). */
  isExpired() {
    if (this.expiresAt === null) return false;
    return Date.now() >= this.expiresAt;
  }

  /** Convert back to a partial OAuthResult for display purposes (no token values). */
  toDisplayInfo() {
    return {
      tokenType:   this.tokenType,
      scope:       this.scope,
      expiresAt:   this.expiresAt,
      expiresIn:   this.expiresIn,
      hasRefresh:  !!this._refreshToken,
      hasIdToken:  !!this._idToken,
    };
  }
}

// ── TokenStore ───────────────────────────────────────────────────────────────

/**
 * Singleton in-memory store for cached OAuth tokens.
 *
 * Usage:
 *   tokenStore.set(key, result);
 *   tokenStore.get(key);         // returns TokenEntry or null
 *   tokenStore.isValid(key);
 *   tokenStore.clear(key);
 *   tokenStore.clearAll();
 */
class TokenStore {
  /** @type {Map<string, TokenEntry>} */
  #cache = new Map();

  /**
   * Derive a stable cache key from an OAuth config object.
   *
   * @param {object} config - authOAuth2 state
   * @returns {string}
   */
  keyFor(config) {
    const parts = [
      config.grantType      ?? "",
      config.clientId       ?? "",
      config.accessTokenUrl ?? "",
      config.scope          ?? "",
    ];
    return parts.join("|");
  }

  /**
   * Store a successful OAuthResult under the given key.
   *
   * @param {string}                              key
   * @param {import('../types/oauth-types').OAuthResult} result
   */
  set(key, result) {
    if (!result?.success || !result.accessToken) return;
    this.#cache.set(key, new TokenEntry(result));
  }

  /**
   * Retrieve a cached entry, or null if not found.
   *
   * @param {string} key
   * @returns {TokenEntry|null}
   */
  get(key) {
    return this.#cache.get(key) ?? null;
  }

  /**
   * True if there is a cached, still-valid token for the given key.
   *
   * @param {string} key
   * @returns {boolean}
   */
  isValid(key) {
    return this.get(key)?.isValid() ?? false;
  }

  /**
   * Remove a cached entry.
   *
   * @param {string} key
   */
  clear(key) {
    this.#cache.delete(key);
  }

  /** Remove all cached tokens. */
  clearAll() {
    this.#cache.clear();
  }

  /**
   * Return all cache keys (for diagnostic purposes — does NOT expose token values).
   *
   * @returns {string[]}
   */
  keys() {
    return [...this.#cache.keys()];
  }
}

/** Shared singleton token store for the entire renderer session. */
export const tokenStore = new TokenStore();

