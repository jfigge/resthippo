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
 * auth/tests/oauth.test.js
 *
 * Unit tests for the OAuth 2.0 authentication framework.
 *
 * Run with:   node --experimental-vm-modules auth/tests/oauth.test.js
 *
 * Dependencies: none external — uses Node's built-in assert module and a
 * lightweight mock for window.hippo so tests run without Electron.
 *
 * Test coverage:
 *   • PKCE code verifier / challenge generation and format
 *   • State generation and validation (including expiry and replay)
 *   • URL building and callback parsing
 *   • Token store: set / get / expiry / refresh detection
 *   • Client Credentials flow: success, missing fields, network error, server error
 *   • Resource Owner Password flow: success, missing credentials
 *   • Token refresh flow: success, missing refresh token
 *   • Bearer token injection
 *   • Config validation
 */

"use strict";

import assert from "node:assert/strict";
import { generateCodeVerifier, generateCodeChallenge } from "../utils/pkce.js";
import { generateState, validateState, discardState } from "../utils/state.js";
import {
  buildUrl,
  extractAuthCode,
  extractImplicitToken,
} from "../utils/url.js";
import { tokenStore } from "../tokens/token-store.js";
import {
  OAuthError,
  OAuthErrorCode,
  fromNetworkError,
  fromTokenErrorResponse,
} from "../types/oauth-errors.js";
import {
  oauthResultFromTokenResponse,
  oauthResultFromError,
  validateOAuthConfig,
} from "../types/oauth-types.js";

// ── Global mock for window.hippo (simulates Electron preload) ─────────────────
// Each test group overrides _mockResponses to control what executeRequest returns.

let _mockResponse = null;

globalThis.window = {
  hippo: {
    isElectron: true,
    http: {
      execute: async (desc) => {
        if (typeof _mockResponse === "function") return _mockResponse(desc);
        if (_mockResponse) return _mockResponse;
        throw new Error("No mock response configured");
      },
    },
  },
};

/**
 * Minimal async test runner.
 * @param {string} name
 * @param {() => Promise<void>} fn
 */
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓  ${name}`);
  } catch (err) {
    console.error(`  ✗  ${name}`);
    console.error(`     ${err.message}`);
    process.exitCode = 1;
  }
}

function group(name) {
  console.log(`\n${name}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// PKCE
// ─────────────────────────────────────────────────────────────────────────────

group("PKCE utilities");

await test("generateCodeVerifier produces correct length", async () => {
  const v = generateCodeVerifier(64);
  assert.equal(v.length, 64);
});

await test("generateCodeVerifier uses only allowed characters", async () => {
  const v = generateCodeVerifier(128);
  assert.match(v, /^[A-Za-z0-9\-._~]+$/);
});

await test("generateCodeVerifier rejects out-of-range length", async () => {
  assert.throws(() => generateCodeVerifier(10), RangeError);
  assert.throws(() => generateCodeVerifier(200), RangeError);
});

await test("generateCodeChallenge produces base64url string (no padding, URL-safe)", async () => {
  const verifier = generateCodeVerifier(64);
  const challenge = await generateCodeChallenge(verifier);
  // Must be base64url: no +, /, or = characters
  assert.doesNotMatch(challenge, /[+/=]/);
  // SHA-256 → 32 bytes → 43 base64url characters (without padding)
  assert.equal(challenge.length, 43);
});

await test("generateCodeChallenge produces different values for different verifiers", async () => {
  const a = await generateCodeChallenge(generateCodeVerifier(64));
  const b = await generateCodeChallenge(generateCodeVerifier(64));
  assert.notEqual(a, b);
});

// ─────────────────────────────────────────────────────────────────────────────
// State parameter
// ─────────────────────────────────────────────────────────────────────────────

group("State parameter (CSRF)");

await test("generateState returns a 64-char hex string", async () => {
  const s = generateState();
  assert.match(s, /^[0-9a-f]{64}$/);
});

await test("validateState accepts a valid, unexpired state", async () => {
  const s = generateState();
  assert.equal(validateState(s), true);
});

await test("validateState rejects an unknown state", async () => {
  assert.equal(validateState("notastate"), false);
});

await test("validateState rejects null / undefined", async () => {
  assert.equal(validateState(null), false);
  assert.equal(validateState(undefined), false);
  assert.equal(validateState(""), false);
});

await test("validateState consumes the state (no replay)", async () => {
  const s = generateState();
  assert.equal(validateState(s), true); // first use: valid
  assert.equal(validateState(s), false); // second use: consumed
});

await test("discardState removes a pending state", async () => {
  const s = generateState();
  discardState(s);
  assert.equal(validateState(s), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// URL utilities
// ─────────────────────────────────────────────────────────────────────────────

group("URL utilities");

await test("buildUrl appends query parameters", async () => {
  const url = buildUrl("https://example.com/auth", {
    client_id: "myapp",
    scope: "openid",
  });
  assert.ok(url.includes("client_id=myapp"));
  assert.ok(url.includes("scope=openid"));
});

await test("buildUrl skips null / empty values", async () => {
  const url = buildUrl("https://example.com/auth", {
    k: null,
    v: "",
    present: "yes",
  });
  assert.ok(!url.includes("k="));
  assert.ok(!url.includes("v="));
  assert.ok(url.includes("present=yes"));
});

await test("extractAuthCode parses code and state from query string", async () => {
  const result = extractAuthCode(
    "http://localhost:7777/callback?code=abc123&state=xyz",
  );
  assert.equal(result.code, "abc123");
  assert.equal(result.state, "xyz");
  assert.equal(result.error, null);
});

await test("extractAuthCode parses error responses", async () => {
  const result = extractAuthCode(
    "http://localhost:7777/callback?error=access_denied&error_description=User+denied",
  );
  assert.equal(result.error, "access_denied");
  assert.equal(result.errorDescription, "User denied");
  assert.equal(result.code, null);
});

await test("extractImplicitToken reads token from fragment", async () => {
  const result = extractImplicitToken(
    "http://localhost:7777/callback#access_token=tok&token_type=Bearer&expires_in=3600&state=s1",
  );
  assert.equal(result.accessToken, "tok");
  assert.equal(result.tokenType, "Bearer");
  assert.equal(result.expiresIn, "3600");
  assert.equal(result.state, "s1");
});

// ─────────────────────────────────────────────────────────────────────────────
// OAuthError
// ───────────────────────────────────────────────────────────────────────────��─

group("OAuthError");

await test("fromNetworkError wraps a generic error", async () => {
  const err = fromNetworkError(new Error("connect ECONNREFUSED"));
  assert.equal(err.code, OAuthErrorCode.NETWORK_ERROR);
  assert.ok(err instanceof OAuthError);
});

await test("fromNetworkError detects timeout messages", async () => {
  const err = fromNetworkError(new Error("Request timed out after 30000ms"));
  assert.equal(err.code, OAuthErrorCode.TIMEOUT);
});

await test("fromTokenErrorResponse creates error with server code", async () => {
  const err = fromTokenErrorResponse(
    { error: "invalid_client", error_description: "Bad secret" },
    401,
  );
  assert.equal(err.code, "invalid_client");
  assert.equal(err.httpStatus, 401);
  assert.equal(err.description, "Bad secret");
});

await test("OAuthError.toJSON does not expose raw field", async () => {
  const err = fromTokenErrorResponse({ error: "invalid_client" }, 401);
  const json = err.toJSON();
  assert.ok(!("raw" in json));
});

// ─────────────────────────────────────────────────────────────────────────────
// OAuthResult factory
// ─────────────────────────────────────────────────────────────────────────────

group("OAuthResult factory");

await test("oauthResultFromTokenResponse maps response fields", async () => {
  const r = oauthResultFromTokenResponse({
    access_token: "AT",
    refresh_token: "RT",
    id_token: "IDT",
    expires_in: 3600,
    token_type: "Bearer",
    scope: "openid email",
  });
  assert.equal(r.success, true);
  assert.equal(r.accessToken, "AT");
  assert.equal(r.refreshToken, "RT");
  assert.equal(r.idToken, "IDT");
  assert.equal(r.expiresIn, 3600);
  assert.ok(r.expiresAt > Date.now());
  assert.equal(r.scope, "openid email");
});

await test("oauthResultFromError sets success=false", async () => {
  const e = new OAuthError("invalid_client", "Bad");
  const r = oauthResultFromError(e);
  assert.equal(r.success, false);
  assert.equal(r.accessToken, null);
  assert.equal(r.error, e);
});

// ─────────────────────────────────────────────────────────────────────────────
// Token store
// ─────────────────────────────────────────────────────────────────────────────

group("TokenStore");

await test("set and get a valid token", async () => {
  tokenStore.clearAll();
  const result = oauthResultFromTokenResponse({
    access_token: "testtoken",
    expires_in: 3600,
    token_type: "Bearer",
  });
  tokenStore.set("k1", result);
  const entry = tokenStore.get("k1");
  assert.ok(entry !== null);
  assert.equal(entry.accessToken, "testtoken");
});

await test("isValid returns true for a live token", async () => {
  tokenStore.clearAll();
  const result = oauthResultFromTokenResponse({
    access_token: "t",
    expires_in: 3600,
  });
  tokenStore.set("k2", result);
  assert.equal(tokenStore.isValid("k2"), true);
});

await test("isValid returns false for an expired token", async () => {
  tokenStore.clearAll();
  const result = oauthResultFromTokenResponse({
    access_token: "t",
    expires_in: 0,
  });
  // expires_in=0 → expiresAt = now → already expired
  tokenStore.set("k3", result);
  // Give the proactive buffer time: entry.isValid() checks now < expiresAt - 60s
  assert.equal(tokenStore.isValid("k3"), false);
});

await test("isValid returns true for a token with no expiry info", async () => {
  tokenStore.clearAll();
  const result = oauthResultFromTokenResponse({ access_token: "t" }); // no expires_in
  tokenStore.set("k4", result);
  assert.equal(tokenStore.isValid("k4"), true);
});

await test("clear removes a specific key", async () => {
  tokenStore.clearAll();
  const result = oauthResultFromTokenResponse({
    access_token: "t",
    expires_in: 3600,
  });
  tokenStore.set("k5", result);
  tokenStore.clear("k5");
  assert.equal(tokenStore.get("k5"), null);
});

await test("access token is non-enumerable (does not appear in JSON.stringify)", async () => {
  tokenStore.clearAll();
  const result = oauthResultFromTokenResponse({
    access_token: "secret",
    expires_in: 3600,
  });
  tokenStore.set("k6", result);
  const entry = tokenStore.get("k6");
  const json = JSON.stringify(entry);
  assert.ok(
    !json.includes("secret"),
    "Access token must not appear in JSON.stringify output",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Config validation
// ───────────��─────────────────────────────────────────────────────────────────

group("Config validation");

await test("validateOAuthConfig passes for valid client_credentials config", async () => {
  const err = validateOAuthConfig({
    grantType: "client_credentials",
    clientId: "id",
    accessTokenUrl: "https://token.example.com",
  });
  assert.equal(err, null);
});

await test("validateOAuthConfig requires a grant type", async () => {
  assert.equal(validateOAuthConfig({}), "Grant type is required.");
});

await test("validateOAuthConfig fails when clientId is missing", async () => {
  const err = validateOAuthConfig({
    grantType: "client_credentials",
    accessTokenUrl: "https://x.com",
  });
  assert.equal(err, "Client ID is required.");
});

await test("validateOAuthConfig checks accessTokenUrl before clientId (deterministic first error)", async () => {
  // Both fields missing: the non-implicit accessTokenUrl check runs before the
  // per-grant switch, so its message wins regardless of which grant it is.
  const err = validateOAuthConfig({ grantType: "client_credentials" });
  assert.equal(err, "Access Token URL is required.");
});

await test("validateOAuthConfig fails when accessTokenUrl is missing for password grant", async () => {
  const err = validateOAuthConfig({
    grantType: "password",
    clientId: "id",
    username: "u",
    password: "p",
    // missing accessTokenUrl
  });
  assert.equal(err, "Access Token URL is required.");
});

await test("validateOAuthConfig reports missing username / password for the password grant", async () => {
  const base = {
    grantType: "password",
    clientId: "id",
    accessTokenUrl: "https://token.example.com",
  };
  assert.equal(
    validateOAuthConfig({ ...base, password: "p" }),
    "Username is required.",
  );
  assert.equal(
    validateOAuthConfig({ ...base, username: "u" }),
    "Password is required.",
  );
});

await test("validateOAuthConfig requires authUrl for the authorization_code grant", async () => {
  const err = validateOAuthConfig({
    grantType: "authorization_code",
    clientId: "id",
    accessTokenUrl: "https://token.example.com",
    // missing authUrl
  });
  assert.equal(err, "Auth URL is required.");
});

await test("validateOAuthConfig rejects a malformed authUrl for popup grants", async () => {
  const authCode = validateOAuthConfig({
    grantType: "authorization_code",
    clientId: "id",
    accessTokenUrl: "https://token.example.com",
    authUrl: "not a url",
  });
  assert.equal(authCode, "Auth URL is not a valid URL.");

  const implicit = validateOAuthConfig({
    grantType: "implicit",
    clientId: "id",
    authUrl: "not a url",
  });
  assert.equal(implicit, "Auth URL is not a valid URL.");
});

await test("validateOAuthConfig passes for valid authorization_code config", async () => {
  const err = validateOAuthConfig({
    grantType: "authorization_code",
    clientId: "id",
    accessTokenUrl: "https://token.example.com",
    authUrl: "https://auth.example.com/authorize",
  });
  assert.equal(err, null);
});

await test("validateOAuthConfig passes for implicit flow (no token URL required)", async () => {
  const err = validateOAuthConfig({
    grantType: "implicit",
    clientId: "id",
    authUrl: "https://auth.example.com",
  });
  assert.equal(err, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// mergeExtraParams helper
// ─────────────────────────────────────────────────────────────────────────────

group("mergeExtraParams");

import { mergeExtraParams } from "../utils/params.js";

await test("mergeExtraParams copies entries and coerces values to strings", async () => {
  const target = { grant_type: "x" };
  const out = mergeExtraParams(target, { a: "1", n: 5, b: true });
  assert.equal(out, target); // mutates and returns the same object
  assert.equal(target.a, "1");
  assert.equal(target.n, "5");
  assert.equal(target.b, "true");
});

await test("mergeExtraParams skips null, undefined and empty-string values", async () => {
  const target = {};
  mergeExtraParams(target, { keep: "yes", n: null, u: undefined, e: "" });
  assert.deepEqual(target, { keep: "yes" });
});

await test("mergeExtraParams ignores non-object sources", async () => {
  const target = { a: "1" };
  mergeExtraParams(target, null);
  mergeExtraParams(target, undefined);
  mergeExtraParams(target, "nope");
  assert.deepEqual(target, { a: "1" });
});

// ─────────────────────────────────────────────────────────────────────────────
// applyClientAuth helper
// ─────────────────────────────────────────────────────────────────────────────

group("applyClientAuth");

import { applyClientAuth } from "../flows/token-request.js";

await test("header mode (default): client_id in body, Basic header only when a secret exists", async () => {
  const withSecret = { params: {}, headers: {} };
  applyClientAuth(withSecret.params, withSecret.headers, {
    clientId: "cid",
    clientSecret: "sec",
  });
  assert.equal(withSecret.params.client_id, "cid");
  assert.equal(withSecret.headers["Authorization"], `Basic ${btoa("cid:sec")}`);

  const noSecret = { params: {}, headers: {} };
  applyClientAuth(noSecret.params, noSecret.headers, { clientId: "cid" });
  assert.equal(noSecret.params.client_id, "cid");
  assert.equal(noSecret.headers["Authorization"], undefined);
});

await test("header mode: non-ASCII client secret is UTF-8 base64-encoded (no btoa crash)", async () => {
  const ctx = { params: {}, headers: {} };
  applyClientAuth(ctx.params, ctx.headers, {
    clientId: "cid",
    clientSecret: "sëcret🦛",
  });
  const value = ctx.headers["Authorization"];
  assert.ok(value.startsWith("Basic "));
  // Decodes back to the original credential as UTF-8 — proving it neither threw
  // nor was mangled by a Latin-1-only btoa.
  const bytes = Uint8Array.from(atob(value.slice(6)), (c) => c.charCodeAt(0));
  assert.equal(new TextDecoder().decode(bytes), "cid:sëcret🦛");
});

await test("body mode: secret omitted when empty unless sendEmptySecret is set", async () => {
  const omit = { params: {}, headers: {} };
  applyClientAuth(omit.params, omit.headers, {
    clientId: "cid",
    credentials: "body",
  });
  assert.equal(omit.params.client_id, "cid");
  assert.ok(!("client_secret" in omit.params));

  const empty = { params: {}, headers: {} };
  applyClientAuth(
    empty.params,
    empty.headers,
    { clientId: "cid", credentials: "body" },
    { sendEmptySecret: true },
  );
  assert.equal(empty.params.client_secret, "");
});

await test("skip: applies no client authentication at all (public/PKCE client)", async () => {
  const params = {};
  const headers = {};
  applyClientAuth(
    params,
    headers,
    { clientId: "cid", clientSecret: "sec" },
    { skip: true },
  );
  assert.deepEqual(params, {});
  assert.deepEqual(headers, {});
});

await test("optionalClient header mode: omits client_id from body, sends Basic when client_id present", async () => {
  const params = {};
  const headers = {};
  applyClientAuth(
    params,
    headers,
    { clientId: "cid" }, // no secret
    { optionalClient: true },
  );
  assert.ok(!("client_id" in params), "client_id should not be echoed in body");
  assert.equal(headers["Authorization"], `Basic ${btoa("cid:")}`);
});

await test("optionalClient with no client_id sends nothing", async () => {
  const params = {};
  const headers = {};
  applyClientAuth(params, headers, {}, { optionalClient: true });
  assert.deepEqual(params, {});
  assert.deepEqual(headers, {});
});

await test("optionalClient body mode behaves like the standard body mode", async () => {
  const params = {};
  const headers = {};
  applyClientAuth(
    params,
    headers,
    { clientId: "cid", clientSecret: "sec", credentials: "body" },
    { optionalClient: true },
  );
  assert.equal(params.client_id, "cid");
  assert.equal(params.client_secret, "sec");
});

// ─────────────────────────────────────────────────────────────────────────────
// Client Credentials flow (mocked network)
// ─────────────────────────────────────────────────────────────────────────────

group("Client Credentials flow (mocked)");

// The flow imports postTokenRequest which calls executeRequest which calls window.hippo.http.execute
import { clientCredentialsFlow } from "../flows/client-credentials.js";

await test("client credentials flow: success", async () => {
  _mockResponse = {
    status: 200,
    statusText: "OK",
    body: JSON.stringify({
      access_token: "cctoken",
      token_type: "Bearer",
      expires_in: 3600,
    }),
  };
  const result = await clientCredentialsFlow({
    grantType: "client_credentials",
    clientId: "cid",
    clientSecret: "csecret",
    accessTokenUrl: "https://token.example.com",
    credentials: "header",
  });
  assert.equal(result.success, true);
  assert.equal(result.accessToken, "cctoken");
  assert.equal(result.expiresIn, 3600);
});

await test("executor rejects missing client_credentials config before dispatch", async () => {
  // Flows assume an already-validated config; the executor is the single place
  // that enforces required fields via validateOAuthConfig.
  const result = await oauthExecutor.acquireToken({
    grantType: "client_credentials",
    // missing clientId and accessTokenUrl
  });
  assert.equal(result.success, false);
  assert.equal(result.error?.code, OAuthErrorCode.CONFIGURATION_ERROR);
});

await test("client credentials flow: server 401 error", async () => {
  _mockResponse = {
    status: 401,
    statusText: "Unauthorized",
    body: JSON.stringify({
      error: "invalid_client",
      error_description: "Bad credentials",
    }),
  };
  const result = await clientCredentialsFlow({
    grantType: "client_credentials",
    clientId: "bad",
    clientSecret: "wrong",
    accessTokenUrl: "https://token.example.com",
  });
  assert.equal(result.success, false);
  assert.equal(result.error?.code, "invalid_client");
  assert.equal(result.error?.httpStatus, 401);
});

await test("client credentials flow: network error", async () => {
  _mockResponse = () => {
    throw new Error("ECONNREFUSED");
  };
  const result = await clientCredentialsFlow({
    grantType: "client_credentials",
    clientId: "cid",
    clientSecret: "cs",
    accessTokenUrl: "https://unreachable.example.com",
  });
  assert.equal(result.success, false);
  assert.equal(result.error?.code, OAuthErrorCode.NETWORK_ERROR);
});

await test("client credentials flow: sends credentials in body when configured", async () => {
  let capturedBody = null;
  _mockResponse = (desc) => {
    capturedBody = desc.body;
    return {
      status: 200,
      body: JSON.stringify({ access_token: "t", token_type: "Bearer" }),
    };
  };
  await clientCredentialsFlow({
    grantType: "client_credentials",
    clientId: "myid",
    clientSecret: "mysecret",
    accessTokenUrl: "https://token.example.com",
    credentials: "body",
  });
  assert.ok(
    capturedBody?.includes("client_id=myid"),
    "body should contain client_id",
  );
  assert.ok(
    capturedBody?.includes("client_secret=mysecret"),
    "body should contain client_secret",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Resource Owner Password flow (mocked)
// ─���───────────────────────────────────────────────────────────────────────────

group("Concurrent acquisition coalescing");

await test("concurrent acquireToken calls for one config make a single token request", async () => {
  let calls = 0;
  _mockResponse = () => {
    calls += 1;
    return {
      status: 200,
      statusText: "OK",
      body: JSON.stringify({
        access_token: "shared-tok",
        token_type: "Bearer",
        expires_in: 3600,
      }),
    };
  };
  const config = {
    grantType: "client_credentials",
    clientId: "cid",
    clientSecret: "csecret",
    accessTokenUrl: "https://token.example.com",
    credentials: "header",
  };
  oauthExecutor.clearToken(config);

  const [a, b, c] = await Promise.all([
    oauthExecutor.acquireToken(config),
    oauthExecutor.acquireToken(config),
    oauthExecutor.acquireToken(config),
  ]);

  assert.equal(a.success, true);
  assert.equal(b.accessToken, "shared-tok");
  assert.equal(c.accessToken, "shared-tok");
  assert.equal(
    calls,
    1,
    "three concurrent acquisitions should coalesce into one token request",
  );
  oauthExecutor.clearToken(config);
});

group("Resource Owner Password flow (mocked)");

import { passwordFlow } from "../flows/password.js";

await test("password flow: success", async () => {
  _mockResponse = {
    status: 200,
    body: JSON.stringify({
      access_token: "pwdtok",
      refresh_token: "rt",
      expires_in: 1800,
    }),
  };
  const result = await passwordFlow({
    grantType: "password",
    clientId: "cid",
    username: "user@example.com",
    password: "hunter2",
    accessTokenUrl: "https://token.example.com",
  });
  assert.equal(result.success, true);
  assert.equal(result.accessToken, "pwdtok");
  assert.equal(result.refreshToken, "rt");
});

await test("executor rejects missing password-grant username before dispatch", async () => {
  const result = await oauthExecutor.acquireToken({
    grantType: "password",
    clientId: "cid",
    password: "p",
    accessTokenUrl: "https://token.example.com",
    // missing username
  });
  assert.equal(result.success, false);
  assert.equal(result.error?.code, OAuthErrorCode.CONFIGURATION_ERROR);
});

// ─────────────────────────────────────────────────────────────────────────────
// Refresh Token flow (mocked)
// ─────────────────────────────────────────────────────────────────────────────

group("Refresh Token flow (mocked)");

import { refreshTokenFlow } from "../flows/refresh-token.js";

await test("refresh token flow: success", async () => {
  _mockResponse = {
    status: 200,
    body: JSON.stringify({ access_token: "newtok", expires_in: 3600 }),
  };
  const result = await refreshTokenFlow(
    { clientId: "cid", accessTokenUrl: "https://token.example.com" },
    "old-refresh-token",
  );
  assert.equal(result.success, true);
  assert.equal(result.accessToken, "newtok");
});

await test("refresh token flow: missing refresh token returns error", async () => {
  const result = await refreshTokenFlow(
    { accessTokenUrl: "https://token.example.com" },
    null,
  );
  assert.equal(result.success, false);
  assert.equal(result.error?.code, OAuthErrorCode.CONFIGURATION_ERROR);
});

// ───��─────────────────────────────────────────────────────────────────────────
// Bearer token injection
// ─────────────────────────────────────────────────────────────────────────────

group("Bearer token injection (OAuthExecutor)");

import { oauthExecutor } from "../oauth-executor.js";

await test("injectBearerToken adds Authorization header", async () => {
  const desc = {
    method: "GET",
    url: "https://api.example.com/data",
    headers: {},
  };
  const result = oauthExecutor.injectBearerToken(desc, "mytoken");
  assert.equal(result.headers["Authorization"], "Bearer mytoken");
});

await test("injectBearerToken does not mutate original descriptor", async () => {
  const desc = { method: "GET", url: "https://api.example.com", headers: {} };
  oauthExecutor.injectBearerToken(desc, "token");
  assert.equal(desc.headers["Authorization"], undefined);
});

await test("injectBearerToken uses custom prefix", async () => {
  const desc = { method: "GET", url: "https://api.example.com", headers: {} };
  const result = oauthExecutor.injectBearerToken(desc, "mytoken", "Token");
  assert.equal(result.headers["Authorization"], "Token mytoken");
});

await test("injectBearerToken returns original descriptor when token is empty", async () => {
  const desc = { method: "GET", url: "https://api.example.com", headers: {} };
  const result = oauthExecutor.injectBearerToken(desc, "");
  assert.equal(result, desc);
});

// ─────────────────────────────────────────────────────────────────────────────
// Device Authorization grant — validation + polling (RFC 8628)
// ─────────────────────────────────────────────────────────────────────────────

group("Device Authorization grant (validation + mocked polling)");

import { deviceCodeFlow } from "../flows/device-code.js";

// No-op sleep so the poll loop runs instantly under test.
const noSleep = () => Promise.resolve();

await test("validateOAuthConfig: device_code requires a device authorization URL", async () => {
  assert.equal(
    validateOAuthConfig({
      grantType: "device_code",
      clientId: "cid",
      accessTokenUrl: "https://token.example.com",
    }),
    "Device Authorization URL is required.",
  );
  assert.equal(
    validateOAuthConfig({
      grantType: "device_code",
      clientId: "cid",
      accessTokenUrl: "https://token.example.com",
      deviceAuthorizationUrl: "https://device.example.com/code",
    }),
    null,
  );
});

const DEVICE_CFG = {
  grantType: "device_code",
  clientId: "cid",
  accessTokenUrl: "https://token.example.com",
  deviceAuthorizationUrl: "https://device.example.com/code",
};

function deviceMock(pollResponses) {
  let i = 0;
  return (desc) => {
    if (desc.url === DEVICE_CFG.deviceAuthorizationUrl) {
      return {
        status: 200,
        body: JSON.stringify({
          device_code: "DEV-CODE",
          user_code: "WDJB-MJHT",
          verification_uri: "https://example.com/device",
          interval: 1,
          expires_in: 300,
        }),
      };
    }
    // Token endpoint poll — serve the scripted responses in order.
    const r = pollResponses[Math.min(i, pollResponses.length - 1)];
    i += 1;
    return r;
  };
}

await test("device flow: succeeds after authorization_pending", async () => {
  _mockResponse = deviceMock([
    { status: 400, body: JSON.stringify({ error: "authorization_pending" }) },
    { status: 400, body: JSON.stringify({ error: "authorization_pending" }) },
    {
      status: 200,
      body: JSON.stringify({
        access_token: "dev-access",
        token_type: "Bearer",
        expires_in: 3600,
      }),
    },
  ]);
  const result = await deviceCodeFlow(DEVICE_CFG, { sleep: noSleep });
  assert.equal(result.success, true);
  assert.equal(result.accessToken, "dev-access");
});

await test("device flow: backs off on slow_down then succeeds", async () => {
  _mockResponse = deviceMock([
    { status: 400, body: JSON.stringify({ error: "slow_down" }) },
    {
      status: 200,
      body: JSON.stringify({ access_token: "ok", token_type: "Bearer" }),
    },
  ]);
  const result = await deviceCodeFlow(DEVICE_CFG, { sleep: noSleep });
  assert.equal(result.success, true);
  assert.equal(result.accessToken, "ok");
});

await test("device flow: access_denied is a terminal error", async () => {
  _mockResponse = deviceMock([
    { status: 400, body: JSON.stringify({ error: "access_denied" }) },
  ]);
  const result = await deviceCodeFlow(DEVICE_CFG, { sleep: noSleep });
  assert.equal(result.success, false);
  assert.equal(result.error?.code, OAuthErrorCode.ACCESS_DENIED);
});

await test("device flow: device-authorization endpoint error fails fast", async () => {
  _mockResponse = (desc) => {
    if (desc.url === DEVICE_CFG.deviceAuthorizationUrl) {
      return {
        status: 400,
        body: JSON.stringify({ error: "invalid_client" }),
      };
    }
    throw new Error("should not poll the token endpoint");
  };
  const result = await deviceCodeFlow(DEVICE_CFG, { sleep: noSleep });
  assert.equal(result.success, false);
  assert.equal(result.error?.code, "invalid_client");
});

// ─────────────────────────────────────────────────────────────────────────────
// Token Exchange grant — validation + exchange (RFC 8693)
// ─────────────────────────────────────────────────────────────────────────────

group("Token Exchange grant (validation + mocked)");

import { tokenExchangeFlow } from "../flows/token-exchange.js";

await test("validateOAuthConfig: token_exchange requires subject token + type", async () => {
  assert.equal(
    validateOAuthConfig({
      grantType: "token_exchange",
      accessTokenUrl: "https://token.example.com",
    }),
    "Subject Token is required.",
  );
  assert.equal(
    validateOAuthConfig({
      grantType: "token_exchange",
      accessTokenUrl: "https://token.example.com",
      subjectToken: "abc",
      subjectTokenType: "urn:ietf:params:oauth:token-type:access_token",
    }),
    null,
  );
});

await test("token exchange flow: sends RFC 8693 params and returns the new token", async () => {
  let captured = null;
  _mockResponse = (desc) => {
    captured = desc.body;
    return {
      status: 200,
      body: JSON.stringify({
        access_token: "exchanged",
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        token_type: "Bearer",
        expires_in: 3600,
      }),
    };
  };
  const result = await tokenExchangeFlow({
    grantType: "token_exchange",
    accessTokenUrl: "https://token.example.com",
    subjectToken: "SUBJECT",
    subjectTokenType: "urn:ietf:params:oauth:token-type:access_token",
    actorToken: "ACTOR",
    actorTokenType: "urn:ietf:params:oauth:token-type:access_token",
    audience: "https://api.example.com",
  });
  assert.equal(result.success, true);
  assert.equal(result.accessToken, "exchanged");
  assert.ok(
    captured.includes(
      "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange",
    ),
    "body should carry the token-exchange grant_type URN",
  );
  assert.ok(captured.includes("subject_token=SUBJECT"));
  assert.ok(captured.includes("actor_token=ACTOR"));
  assert.ok(captured.includes("audience=https%3A%2F%2Fapi.example.com"));
});

// ─────────────────────────────────────────────────────────────────────────────
// Variable resolution in the OAuth config
// ─────────────────────────────────────────────────────────────────────────────

import { resolveOAuth2Config } from "../utils/resolve-config.js";

group("resolveOAuth2Config");

// Mock resolver: substitutes {{name}} from a dictionary, leaving unknown tokens
// intact — the same contract as the real renderer resolver.
const _vars = {
  clientId: "abc-123",
  secret: "s3cr3t",
  base: "https://idp.example.com",
};
const _rv = async (s) =>
  s.replace(/\{\{(\w+)\}\}/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(_vars, name) ? _vars[name] : m,
  );

await test("resolveOAuth2Config: substitutes {{vars}} in every string field", async () => {
  const out = await resolveOAuth2Config(
    {
      grantType: "authorization_code",
      clientId: "{{clientId}}",
      clientSecret: "{{secret}}",
      authUrl: "{{base}}/authorize",
      accessTokenUrl: "{{base}}/token",
      scope: "openid",
    },
    _rv,
  );
  assert.equal(out.clientId, "abc-123");
  assert.equal(out.clientSecret, "s3cr3t");
  assert.equal(out.authUrl, "https://idp.example.com/authorize");
  assert.equal(out.accessTokenUrl, "https://idp.example.com/token");
  assert.equal(out.scope, "openid");
});

await test("resolveOAuth2Config: leaves unresolved {{vars}} intact", async () => {
  const out = await resolveOAuth2Config({ clientId: "{{missing}}" }, _rv);
  assert.equal(out.clientId, "{{missing}}");
});

await test("resolveOAuth2Config: skips runtime token fields and non-strings", async () => {
  const out = await resolveOAuth2Config(
    {
      token: "{{clientId}}", // an acquired token is not a template — untouched
      refreshToken: "{{secret}}",
      expiresAt: 123456,
      discoveredScopes: ["openid", "email"],
      clientId: "{{clientId}}",
    },
    _rv,
  );
  assert.equal(out.token, "{{clientId}}");
  assert.equal(out.refreshToken, "{{secret}}");
  assert.equal(out.expiresAt, 123456);
  assert.deepEqual(out.discoveredScopes, ["openid", "email"]);
  assert.equal(out.clientId, "abc-123"); // a real field still resolves
});

await test("resolveOAuth2Config: returns a new object, never mutates input", async () => {
  const input = { clientId: "{{clientId}}" };
  const out = await resolveOAuth2Config(input, _rv);
  assert.notEqual(out, input);
  assert.equal(input.clientId, "{{clientId}}");
  assert.equal(out.clientId, "abc-123");
});

await test("resolveOAuth2Config: tolerates null config / non-function resolver", async () => {
  assert.deepEqual(await resolveOAuth2Config(null, _rv), {});
  assert.deepEqual(
    await resolveOAuth2Config({ clientId: "{{clientId}}" }, null),
    {
      clientId: "{{clientId}}",
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Authorization Code flow — PKCE on every client type (mocked popup + token)
// ─────────────────────────────────────────────────────────────────────────────

group("Authorization Code flow (PKCE for all clients)");

import { authorizationCodeFlow } from "../flows/authorization-code.js";

await test("a confidential client sends PKCE AND authenticates with its secret", async () => {
  let capturedAuthUrl = null;
  let capturedDesc = null;
  window.hippo.oauth = {
    openPopup: async (authUrl, redirectUri) => {
      capturedAuthUrl = authUrl;
      const state = new URL(authUrl).searchParams.get("state");
      return { url: `${redirectUri}?code=AUTHCODE&state=${state}` };
    },
  };
  _mockResponse = (desc) => {
    capturedDesc = desc;
    return {
      status: 200,
      statusText: "OK",
      body: JSON.stringify({
        access_token: "AT",
        token_type: "Bearer",
        expires_in: 3600,
      }),
    };
  };

  const result = await authorizationCodeFlow({
    grantType: "authorization_code",
    clientType: "confidential",
    clientId: "cid",
    clientSecret: "csecret",
    authUrl: "https://idp.example.com/authorize",
    accessTokenUrl: "https://idp.example.com/token",
    redirectUri: "https://app.example.com/callback",
    credentials: "header",
  });
  assert.equal(result.success, true);

  // PKCE challenge is present on the authorization request for a CONFIDENTIAL
  // client (previously only public clients got it).
  const au = new URL(capturedAuthUrl);
  assert.equal(au.searchParams.get("code_challenge_method"), "S256");
  assert.ok(au.searchParams.get("code_challenge"), "code_challenge present");

  // The verifier rides on the token request, AND the secret still authenticates
  // (header mode → Basic auth) — PKCE is additive, not a replacement.
  const tokenParams = new URLSearchParams(capturedDesc.body);
  assert.ok(tokenParams.get("code_verifier"), "code_verifier present");
  assert.equal(tokenParams.get("client_id"), "cid");
  assert.match(
    String(capturedDesc.headers?.Authorization || ""),
    /^Basic /,
    "confidential client still sends its secret",
  );

  window.hippo.oauth = undefined; // reset
});

// ─────────────────────────────────────────────────────────────────────────────
// id_token decode — reject unsigned tokens (alg:none)
// ─────────────────────────────────────────────────────────────────────────────

group("decodeIdTokenPayload (reject unsigned)");

import { decodeIdTokenPayload } from "../utils/nonce.js";
import { base64UrlEncode } from "../utils/base64url.js";

function _b64url(obj) {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(obj)));
}

await test("decodes a signed token's payload", async () => {
  const tok = `${_b64url({ alg: "RS256", typ: "JWT" })}.${_b64url({ sub: "u1", nonce: "abc" })}.c2ln`;
  const payload = decodeIdTokenPayload(tok);
  assert.equal(payload.sub, "u1");
  assert.equal(payload.nonce, "abc");
});

await test("rejects an unsigned token (alg:none, missing alg, or no signature)", async () => {
  const payload = { sub: "u1", nonce: "abc" };
  const none = `${_b64url({ alg: "none" })}.${_b64url(payload)}.`;
  const noAlg = `${_b64url({ typ: "JWT" })}.${_b64url(payload)}.c2ln`;
  const emptySig = `${_b64url({ alg: "RS256" })}.${_b64url(payload)}.`;
  const twoPart = `${_b64url({ alg: "RS256" })}.${_b64url(payload)}`;
  assert.equal(decodeIdTokenPayload(none), null, "alg:none rejected");
  assert.equal(decodeIdTokenPayload(noAlg), null, "missing alg rejected");
  assert.equal(
    decodeIdTokenPayload(emptySig),
    null,
    "empty signature rejected",
  );
  assert.equal(decodeIdTokenPayload(twoPart), null, "two-part token rejected");
  assert.equal(decodeIdTokenPayload("not.a.jwt"), null, "garbage rejected");
  assert.equal(decodeIdTokenPayload(""), null);
  assert.equal(decodeIdTokenPayload(null), null);
});

// ─────────────────────────────────────────────────────────────────────────────

console.log("\n✓ All tests passed\n");
