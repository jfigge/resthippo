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
 * auth/utils/url.js
 *
 * URL construction and parsing helpers for OAuth flows.
 */

"use strict";

// ── URL building ─────────────────────────────────────────────────────────────

/**
 * Build a URL by appending query parameters, skipping null/undefined/"" values.
 *
 * @param {string}                       base   - Base URL (must be a valid absolute URL)
 * @param {Record<string,string|null|undefined>} params
 * @returns {string}
 */
export function buildUrl(base, params) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

// ── Callback URL parsing ──────────────────────────────────────────────────────

/**
 * Parse both the query string and hash fragment of a URL into
 * URLSearchParams objects.
 *
 * @param {string} urlString
 * @returns {{ query: URLSearchParams, fragment: URLSearchParams }}
 */
export function parseUrlParams(urlString) {
  try {
    const url = new URL(urlString);
    const query = url.searchParams;
    const hashBody = url.hash.startsWith("#") ? url.hash.slice(1) : "";
    const fragment = new URLSearchParams(hashBody);
    return { query, fragment };
  } catch {
    return { query: new URLSearchParams(), fragment: new URLSearchParams() };
  }
}

/**
 * Extract the authorization code (and related fields) from a callback URL.
 * The code lives in the query string for Authorization Code flow.
 *
 * @param {string} callbackUrl
 * @returns {{
 *   code:             string|null,
 *   state:            string|null,
 *   error:            string|null,
 *   errorDescription: string|null,
 * }}
 */
export function extractAuthCode(callbackUrl) {
  const { query } = parseUrlParams(callbackUrl);
  return {
    code: query.get("code"),
    state: query.get("state"),
    error: query.get("error"),
    errorDescription: query.get("error_description"),
  };
}

/**
 * Extract an implicit-flow token from a callback URL.
 *
 * Per the spec the token fields are in the fragment (#access_token=…).
 * Some IdPs mistakenly put them in the query string — we fall back to
 * query if the fragment has no access_token.
 *
 * @param {string} callbackUrl
 * @returns {{
 *   accessToken:      string|null,
 *   tokenType:        string|null,
 *   expiresIn:        string|null,
 *   idToken:          string|null,
 *   scope:            string|null,
 *   state:            string|null,
 *   error:            string|null,
 *   errorDescription: string|null,
 * }}
 */
export function extractImplicitToken(callbackUrl) {
  const { query, fragment } = parseUrlParams(callbackUrl);
  // Prefer fragment; fall back to query for non-conformant IdPs. Select by the
  // presence of *any* expected field so id_token-only and error responses (which
  // carry no access_token) are still read from the fragment.
  const hasFragment =
    fragment.get("access_token") ||
    fragment.get("id_token") ||
    fragment.get("error");
  const p = hasFragment ? fragment : query;
  return {
    accessToken: p.get("access_token"),
    tokenType: p.get("token_type"),
    expiresIn: p.get("expires_in"),
    idToken: p.get("id_token"),
    scope: p.get("scope"),
    state: p.get("state"),
    error: p.get("error"),
    errorDescription: p.get("error_description"),
  };
}
