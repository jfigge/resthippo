/**
 * auth/utils/resolve-config.js
 *
 * Resolve {{variable}} / {{fn()}} tokens inside an OAuth 2.0 config before it is
 * handed to the executor.
 *
 * The renderer already resolves a request's URL, headers and body at send time,
 * but OAuth 2.0 runs as an interactive post-step with its own config object that
 * never passes through buildRequestPayload(). Without this step the token /
 * authorization endpoints receive literal `{{clientId}}` placeholders instead of
 * the user's values.
 *
 * The caller supplies `rv` — an async resolver already bound to the active
 * variable context (folder → collection → environment → global) — so this module
 * stays UI-agnostic and only encodes "resolve every user-authored string field".
 */

"use strict";

/**
 * Fields that are never user-authored templates: the acquired access / id /
 * refresh tokens. They are concrete runtime credentials, so they are passed
 * through untouched rather than run through the variable resolver. (`expiresAt`
 * and `discoveredScopes` are non-strings and are skipped by the type guard.)
 */
const NON_TEMPLATE_KEYS = new Set(["token", "idToken", "refreshToken"]);

/**
 * Return a copy of `config` with every non-empty string field resolved through
 * `rv`. Non-string fields (expiresAt, discoveredScopes, booleans, numbers) and
 * the runtime token fields pass through unchanged. Unresolvable `{{name}}`
 * tokens are left intact by the resolver, exactly as every other request field.
 *
 * @param {object} config  authOAuth2 state
 * @param {(s: string) => Promise<string>} rv  async variable resolver
 * @returns {Promise<object>}  new config with string fields resolved
 */
export async function resolveOAuth2Config(config, rv) {
  if (!config || typeof rv !== "function") return { ...config };
  const entries = await Promise.all(
    Object.entries(config).map(async ([key, value]) => {
      if (typeof value !== "string" || !value || NON_TEMPLATE_KEYS.has(key))
        return [key, value];
      return [key, await rv(value)];
    }),
  );
  return Object.fromEntries(entries);
}
