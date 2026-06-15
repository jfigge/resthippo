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

/** How many milliseconds before expiry we consider a token "about to expire" and proactively refresh it. */
const EXPIRY_BUFFER_MS = 60_000; // 60 s

/**
 * Non-cryptographic, non-reversible fingerprint for inclusion in cache keys.
 * djb2 — chosen because the keyspace is small (a few cache entries per session)
 * and we only need collision resistance among a user's own credentials, not
 * adversarial pre-image resistance. Returning a hex digest keeps the key safe
 * to surface via `keys()` for diagnostics.
 */
function fingerprint(value) {
  if (value === "") return "";
  let h = 5381;
  for (let i = 0; i < value.length; i++) {
    h = ((h << 5) + h + value.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

// ── TokenEntry ───────────────────────────────────────────────────────────────

class TokenEntry {
  /**
   * @param {import('../types/oauth-types').OAuthResult} result
   */
  constructor(result) {
    this.tokenType = result.tokenType ?? "Bearer";
    this.scope = result.scope ?? null;
    this.expiresAt = result.expiresAt ?? null; // ms timestamp or null (never expires)
    this.expiresIn = result.expiresIn ?? null;

    // Sensitive fields — non-enumerable so they don't appear in JSON.stringify / console.log
    Object.defineProperty(this, "_accessToken", {
      value: result.accessToken,
      writable: true,
      enumerable: false,
    });
    Object.defineProperty(this, "_refreshToken", {
      value: result.refreshToken,
      writable: true,
      enumerable: false,
    });
    Object.defineProperty(this, "_idToken", {
      value: result.idToken,
      writable: true,
      enumerable: false,
    });
  }

  get accessToken() {
    return this._accessToken;
  }
  get refreshToken() {
    return this._refreshToken;
  }
  get idToken() {
    return this._idToken;
  }

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
      tokenType: this.tokenType,
      scope: this.scope,
      expiresAt: this.expiresAt,
      expiresIn: this.expiresIn,
      hasRefresh: !!this._refreshToken,
      hasIdToken: !!this._idToken,
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
   * The key incorporates every field that can produce a *different* token from
   * the IdP, so distinct configurations never collide on the same cached entry.
   * The clientSecret is included via a non-reversible fingerprint — its raw
   * value is never embedded in the key (which may be surfaced by `keys()` for
   * diagnostics).
   *
   * @param {object} config - authOAuth2 state
   * @returns {string}
   */
  keyFor(config) {
    const parts = [
      config.grantType ?? "",
      config.clientId ?? "",
      fingerprint(config.clientSecret ?? ""),
      config.authUrl ?? "",
      config.accessTokenUrl ?? "",
      config.scope ?? "",
      config.username ?? "",
      config.audience ?? "",
      config.resource ?? "",
      // Token-exchange swaps a different token per subject; fingerprint it so
      // distinct subject tokens never share a cached result. The raw value is
      // never embedded in the key (it may be surfaced by keys() for diagnostics).
      fingerprint(config.subjectToken ?? ""),
    ];
    return parts.join("|");
  }

  /**
   * Store a successful OAuthResult under the given key.
   *
   * Caches when either an access token or an id_token is present — the OIDC
   * implicit flow with `response_type=id_token` returns no access token but
   * the id_token is still a useful credential for OIDC clients.
   *
   * @param {string}                              key
   * @param {import('../types/oauth-types').OAuthResult} result
   */
  set(key, result) {
    if (!result?.success) return;
    if (!result.accessToken && !result.idToken) return;
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
