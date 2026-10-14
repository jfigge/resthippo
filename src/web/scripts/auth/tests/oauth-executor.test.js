/*
 * Copyright 2026 Jason Figge
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This file is part of Rest Hippo.
 *
 * Rest Hippo is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option) any later
 * version.
 *
 * Rest Hippo is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR
 * A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with
 * Rest Hippo. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * oauth-executor.test.js — the OAuthExecutor acquisition orchestration, covering
 * the paths that never touch the network: config validation short-circuits before
 * any flow; a still-valid cached token is returned without a grant; the cache key
 * is content-addressed (a fresh config object with the same fields reuses it); and
 * clearToken evicts. The refresh/grant flows (which do I/O) are out of scope here.
 */
"use strict";

// jsdom-setup first — some flow modules touch DOM globals at import time.
import "../../tests/jsdom-setup.js";

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import { oauthExecutor } from "../oauth-executor.js";
import { tokenStore } from "../tokens/token-store.js";
import { GrantType } from "../types/oauth-types.js";

/** Minimal config that passes validateOAuthConfig for client-credentials. */
const validConfig = (over = {}) => ({
  grantType: GrantType.CLIENT_CREDENTIALS,
  accessTokenUrl: "https://idp.test/token",
  clientId: "cid",
  ...over,
});

// Never-expiring cached token payload (expiresAt:null → always isValid()).
const cachedToken = (over = {}) => ({
  success: true,
  accessToken: "cached-abc",
  refreshToken: "cached-refresh",
  idToken: "cached-id",
  tokenType: "Bearer",
  scope: "read",
  expiresAt: null,
  ...over,
});

// Track keys we seed so the shared singleton store stays clean between tests.
const seeded = new Set();
const seed = (config, token) => {
  const key = tokenStore.keyFor(config);
  tokenStore.set(key, token);
  seeded.add(key);
  return key;
};
afterEach(() => {
  for (const key of seeded) tokenStore.clear(key);
  seeded.clear();
});

// ── validation short-circuit (no network) ──────────────────────────────────────

test("acquireToken rejects a config with no grant type before any flow", async () => {
  const res = await oauthExecutor.acquireToken({});
  assert.equal(res.success, false);
  assert.ok(res.error, "carries an OAuthError");
  assert.equal(res.accessToken, null);
});

test("acquireToken rejects a client-credentials config missing the token URL", async () => {
  const res = await oauthExecutor.acquireToken({
    grantType: GrantType.CLIENT_CREDENTIALS,
    clientId: "cid",
  });
  assert.equal(res.success, false);
  assert.ok(res.error);
});

// ── cache hit (no network) ──────────────────────────────────────────────────────

test("acquireToken returns a still-valid cached token without running a flow", async () => {
  const config = validConfig();
  seed(config, cachedToken());

  const res = await oauthExecutor.acquireToken(config);
  assert.equal(res.success, true);
  assert.equal(res.accessToken, "cached-abc");
  assert.equal(res.refreshToken, "cached-refresh");
  assert.equal(res.idToken, "cached-id");
  assert.equal(res.scope, "read");
});

test("the cache key is content-addressed: a fresh config object reuses the entry", async () => {
  seed(validConfig(), cachedToken({ accessToken: "shared" }));
  // A brand-new object with identical fields must resolve to the same cache key.
  const res = await oauthExecutor.acquireToken(validConfig());
  assert.equal(res.accessToken, "shared", "same fields → same key → cache hit");
});

test("a different clientId does not collide with another config's cached token", () => {
  const a = seed(validConfig({ clientId: "A" }), cachedToken());
  const b = tokenStore.keyFor(validConfig({ clientId: "B" }));
  assert.notEqual(a, b, "distinct client ids produce distinct cache keys");
  assert.equal(tokenStore.get(b) ?? null, null, "B has no cached token");
});

// ── eviction ────────────────────────────────────────────────────────────────────

test("clearToken evicts the cached token for a config", () => {
  const config = validConfig({ clientId: "evict-me" });
  const key = seed(config, cachedToken());
  assert.ok(tokenStore.get(key), "seeded");
  oauthExecutor.clearToken(config);
  assert.equal(tokenStore.get(key) ?? null, null, "cache entry removed");
});
