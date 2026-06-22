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
 * oauth-redirect.test.js — the OAuth popup's redirect matcher + scheme guard.
 * Security-sensitive: a too-loose redirect match leaks the authorization code,
 * and a non-http(s) authUrl must never reach the popup's loadURL.
 *
 * Run with:  node --test src/app/tests/oauth-redirect.test.js
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { isHttpUrl, matchesRedirect } = require("../oauth-redirect");

// ── matchesRedirect ─────────────────────────────────────────────────────────

test("matches an exact loopback redirect URI", () => {
  const r = "http://localhost:7777/oauth/callback";
  assert.equal(matchesRedirect(`${r}?code=abc&state=xyz`, r), true);
});

test("matches a registered root path against an empty path", () => {
  assert.equal(
    matchesRedirect("https://app.example.com", "https://app.example.com/"),
    true,
  );
});

test("does NOT match a different host, port, or scheme", () => {
  const r = "http://localhost:7777/oauth/callback";
  assert.equal(
    matchesRedirect("http://localhost:8888/oauth/callback", r),
    false,
  );
  assert.equal(
    matchesRedirect("https://localhost:7777/oauth/callback", r),
    false,
  );
  assert.equal(
    matchesRedirect("http://127.0.0.1:7777/oauth/callback", r),
    false,
  );
});

test("does NOT match a different path on the same origin", () => {
  const r = "http://localhost:7777/oauth/callback";
  assert.equal(
    matchesRedirect("http://localhost:7777/evil?code=abc", r),
    false,
  );
});

test("does NOT over-match a look-alike suffix host (the prefix-fallback bug)", () => {
  // The old `navUrl.startsWith(redirectUri)` fallback would hand the code to an
  // attacker origin whose host merely *starts with* the registered one.
  const r = "https://app.example.com/cb";
  assert.equal(
    matchesRedirect("https://app.example.com.evil.test/cb?code=abc", r),
    false,
  );
  assert.equal(
    matchesRedirect("https://app.example.com.evil.test/cb", r),
    false,
  );
});

test("does NOT over-match a path that merely starts with the registered path", () => {
  const r = "https://app.example.com/cb";
  assert.equal(
    matchesRedirect("https://app.example.com/cb-not-really?code=1", r),
    false,
  );
});

test("returns false for urn: (out-of-band) redirect URIs", () => {
  assert.equal(
    matchesRedirect("urn:ietf:wg:oauth:2.0:oob", "urn:ietf:wg:oauth:2.0:oob"),
    false,
  );
});

test("returns false for empty / unparseable inputs (fails closed)", () => {
  const r = "http://localhost:7777/oauth/callback";
  assert.equal(matchesRedirect("", r), false);
  assert.equal(matchesRedirect(r, ""), false);
  assert.equal(matchesRedirect("not a url", "also not a url"), false);
});

// ── isHttpUrl ───────────────────────────────────────────────────────────────

test("isHttpUrl accepts http and https", () => {
  assert.equal(isHttpUrl("http://idp.example.com/authorize?x=1"), true);
  assert.equal(isHttpUrl("https://idp.example.com/authorize"), true);
});

test("isHttpUrl rejects dangerous and non-http(s) schemes", () => {
  for (const u of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,<script>1</script>",
    "about:blank",
    "ftp://example.com/x",
    "not a url",
    "",
    null,
    undefined,
  ]) {
    assert.equal(isHttpUrl(u), false, `should reject ${String(u)}`);
  }
});
