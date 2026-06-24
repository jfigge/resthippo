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

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  oauthHeader,
  pct,
  formatVersion,
  shouldIncludeLink,
  buildTweetText,
} from "../post-release-tweet.mjs";

// Pull the percent-encoded oauth_signature back out of an Authorization header.
function signatureOf(header) {
  const m = header.match(/oauth_signature="([^"]+)"/);
  assert.ok(m, "header should contain oauth_signature");
  return decodeURIComponent(m[1]);
}

test("oauthHeader signs X's documented example vector deterministically", () => {
  // Inputs are the canonical worked example from X's "Creating a signature"
  // docs (consumer key xvz1evFS4wEEPTGEFPHBog, fixed nonce/timestamp/secrets).
  // The base string this produces matches X's documented one byte-for-byte, and
  // the expected signature below is the HMAC-SHA1 over it — cross-checked once
  // against X's live API (a GET signed by this same code returned 200), so this
  // pins the signing end to end without needing live credentials in CI.
  const header = oauthHeader({
    method: "POST",
    url: "https://api.twitter.com/1.1/statuses/update.json",
    params: {
      status: "Hello Ladies + Gentlemen, a signed OAuth request!",
      include_entities: "true",
    },
    consumerKey: "xvz1evFS4wEEPTGEFPHBog",
    consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Y7",
    token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
    tokenSecret: "LswwdoUaIVS25Hql20oxUzhTpHu5Lkd0wYWjbQ4Wn7",
    nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
    timestamp: 1318622958,
  });

  assert.equal(signatureOf(header), "+Pvdn7Xc3hrrjy25d7RIq2sBmzk=");
});

test("oauthHeader emits only oauth_* params, sorted, percent-encoded", () => {
  const header = oauthHeader({
    method: "POST",
    url: "https://api.twitter.com/2/tweets",
    consumerKey: "ck",
    consumerSecret: "cs",
    token: "tok",
    tokenSecret: "ts",
    nonce: "nonce123",
    timestamp: 1700000000,
  });

  assert.ok(header.startsWith("OAuth "));
  // The JSON body is not signed, so no request params leak into the header.
  assert.ok(!header.includes("text="));
  const keys = [...header.matchAll(/(oauth_[a-z_]+)=/g)].map((m) => m[1]);
  assert.deepEqual(keys, [...keys].sort(), "params must be alphabetical");
  assert.ok(keys.includes("oauth_signature"));
  assert.ok(keys.includes("oauth_consumer_key"));
});

test("pct encodes the OAuth-reserved characters encodeURIComponent skips", () => {
  assert.equal(pct("a!b*c'd(e)"), "a%21b%2Ac%27d%28e%29");
  assert.equal(pct("Hello + World!"), "Hello%20%2B%20World%21");
});

test("formatVersion normalizes the release tag", () => {
  assert.equal(formatVersion("v0.18.1"), "v0.18.1");
  assert.equal(formatVersion("0.18.1"), "v0.18.1");
  assert.equal(formatVersion("  v1.2.3  "), "v1.2.3");
  assert.equal(formatVersion(""), "the latest version");
  assert.equal(formatVersion(undefined), "the latest version");
});

test("shouldIncludeLink: only minor/major releases (patch 0) carry the link", () => {
  // Minor + major releases (patch component 0) → include the URL.
  assert.equal(shouldIncludeLink("v0.18.0"), true);
  assert.equal(shouldIncludeLink("0.18.0"), true);
  assert.equal(shouldIncludeLink("v1.0.0"), true);
  assert.equal(shouldIncludeLink("v2.3.0"), true);
  // Revision releases (patch > 0) → no URL, avoiding X's surcharge.
  assert.equal(shouldIncludeLink("v0.18.1"), false);
  assert.equal(shouldIncludeLink("v1.2.10"), false);
  // Unparseable / empty tags default to no URL (never silently pay).
  assert.equal(shouldIncludeLink(""), false);
  assert.equal(shouldIncludeLink(undefined), false);
  assert.equal(shouldIncludeLink("nightly"), false);
});

test("buildTweetText: link on minor releases, plain text on revisions", (t) => {
  const prevTag = process.env.RELEASE_TAG;
  const prevText = process.env.TWEET_TEXT;
  delete process.env.TWEET_TEXT;
  t.after(() => {
    if (prevTag === undefined) delete process.env.RELEASE_TAG;
    else process.env.RELEASE_TAG = prevTag;
    if (prevText === undefined) delete process.env.TWEET_TEXT;
    else process.env.TWEET_TEXT = prevText;
  });

  process.env.RELEASE_TAG = "v0.18.0";
  assert.equal(
    buildTweetText(),
    "🦛 Rest Hippo v0.18.0 is out!\n\nDownload → https://resthippo.com",
  );

  process.env.RELEASE_TAG = "v0.18.1";
  assert.equal(buildTweetText(), "🦛 Rest Hippo v0.18.1 is out!");
  assert.ok(!buildTweetText().includes("http"), "revision tweet has no URL");

  // An explicit TWEET_TEXT override wins regardless of version.
  process.env.TWEET_TEXT = "custom";
  assert.equal(buildTweetText(), "custom");
});
