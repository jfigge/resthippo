/**
 * auth/network/electron-network.js
 *
 * ElectronAuthNetworkService — routes ALL outbound OAuth HTTP requests through:
 *   • Electron:     window.wurl.http.execute  (IPC → main-process Node.js http/https)
 *   • Dev-server:   POST /api/execute          (Go server makes the outgoing call)
 *
 * NEVER uses browser fetch() / XMLHttpRequest directly.
 * This keeps all networking centralised, avoids CORS, and lets the OS-level
 * proxy / SSL settings from the Go / Electron layer apply consistently.
 */

"use strict";

import { fromNetworkError, OAuthError, OAuthErrorCode } from "../types/oauth-errors.js";

// ── Low-level execute ────────────────────────────────────────────────────────

/**
 * Execute a single HTTP request via the backend networking layer.
 *
 * @param {object}         desc
 * @param {string}         desc.method
 * @param {string}         desc.url
 * @param {object}         [desc.headers]
 * @param {string|null}    [desc.body]
 * @param {number}         [desc.timeout]        ms — default 30 000
 * @param {boolean}        [desc.followRedirects] default true
 * @param {boolean}        [desc.verifySsl]       default true
 * @returns {Promise<{status:number, statusText:string, headers:object, body:string, error?:{name:string,message:string}}>}
 */
export async function executeRequest(desc) {
  const payload = {
    method:          desc.method          ?? "GET",
    url:             desc.url,
    headers:         desc.headers         ?? {},
    body:            desc.body            ?? null,
    timeout:         desc.timeout         ?? 30_000,
    followRedirects: desc.followRedirects !== false,
    verifySsl:       desc.verifySsl       !== false,
  };

  if (typeof window.wurl?.http?.execute === "function") {
    // Electron path — IPC to main process Node.js http/https
    return await window.wurl.http.execute(payload);
  }

  // Go dev-server path — proxy endpoint makes the outgoing call
  const res = await fetch("/api/execute", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Execute API returned HTTP ${res.status}`);
  return await res.json();
}

// ── Token endpoint POST ──────────────────────────────────────────────────────

/**
 * POST to an OAuth token endpoint with application/x-www-form-urlencoded body.
 *
 * Resolves with the parsed JSON response body (merged with httpStatus / httpStatusText).
 * Rejects with an OAuthError on network failure or malformed response.
 * Returns structured OAuth error object (does NOT reject) for 4xx server errors
 * so the caller can inspect error fields without catching.
 *
 * @param {string}                      url     - Token endpoint URL
 * @param {Record<string,string>}       params  - Form body parameters
 * @param {object}                      [opts]
 * @param {Record<string,string>}       [opts.headers]    - Extra request headers
 * @param {boolean}                     [opts.verifySsl]  - default true
 * @param {number}                      [opts.timeout]    - ms, default 30 000
 * @returns {Promise<{httpStatus:number, httpStatusText:string, [key:string]:any}>}
 */
export async function postTokenRequest(url, params, opts = {}) {
  const body    = new URLSearchParams(params).toString();
  const headers = {
    "Content-Type": "application/x-www-form-urlencoded",
    "Accept":       "application/json",
    ...opts.headers,
  };

  let result;
  try {
    result = await executeRequest({
      method:          "POST",
      url,
      headers,
      body,
      timeout:         opts.timeout  ?? 30_000,
      verifySsl:       opts.verifySsl !== false,
      followRedirects: true,
    });
  } catch (err) {
    throw fromNetworkError(err);
  }

  // Network-level failure (no HTTP response)
  if (result.error && (result.status == null || result.status === 0)) {
    throw fromNetworkError(result.error);
  }

  // Parse the response body as JSON
  if (!result.body) {
    throw new Error(`Token endpoint returned an empty body (HTTP ${result.status})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(result.body);
  } catch {
    throw new OAuthError(
      OAuthErrorCode.MALFORMED_RESPONSE,
      `Token endpoint returned non-JSON (HTTP ${result.status}): ${String(result.body).slice(0, 200)}`,
      result.status,
    );
  }

  return {
    httpStatus:     result.status,
    httpStatusText: result.statusText,
    ...parsed,
  };
}


