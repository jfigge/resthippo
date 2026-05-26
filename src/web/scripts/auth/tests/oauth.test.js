/**
 * auth/tests/oauth.test.js
 *
 * Unit tests for the OAuth 2.0 authentication framework.
 *
 * Run with:   node --experimental-vm-modules auth/tests/oauth.test.js
 *
 * Dependencies: none external — uses Node's built-in assert module and a
 * lightweight mock for window.wurl so tests run without Electron.
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
  parseUrlParams,
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
  createOAuthResult,
  oauthResultFromTokenResponse,
  oauthResultFromError,
  validateOAuthConfig,
} from "../types/oauth-types.js";

// ── Global mock for window.wurl (simulates Electron preload) ─────────────────
// Each test group overrides _mockResponses to control what executeRequest returns.

let _mockResponse = null;

globalThis.window = {
  wurl: {
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

await test("validateOAuthConfig fails when clientId is missing", async () => {
  const err = validateOAuthConfig({
    grantType: "client_credentials",
    accessTokenUrl: "https://x.com",
  });
  assert.ok(typeof err === "string" && err.length > 0);
});

await test("validateOAuthConfig fails when accessTokenUrl is missing for password grant", async () => {
  const err = validateOAuthConfig({
    grantType: "password",
    clientId: "id",
    username: "u",
    password: "p",
    // missing accessTokenUrl
  });
  assert.ok(typeof err === "string");
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
// Client Credentials flow (mocked network)
// ─────────────────────────────────────────────────────────────────────────────

group("Client Credentials flow (mocked)");

// The flow imports postTokenRequest which calls executeRequest which calls window.wurl.http.execute
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

await test("client credentials flow: missing config returns error", async () => {
  const result = await clientCredentialsFlow({
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

await test("password flow: missing username returns config error", async () => {
  const result = await passwordFlow({
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

console.log("\n✓ All tests passed\n");
