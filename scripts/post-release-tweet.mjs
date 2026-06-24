#!/usr/bin/env node
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

// Announce a new release on X (Twitter) from the release workflow. Posts a
// single tweet via the X API v2 `POST /2/tweets` endpoint, authenticated with
// OAuth 1.0a user context. Signing uses only Node's built-in crypto — no npm
// dependency — so the release job needs nothing installed.
//
// Driven entirely by environment variables (set from repo secrets in
// release.yml). When ANY of the four credentials is empty the script logs and
// exits 0 without posting — the same graceful-skip contract the signing
// secrets use, so the job is a harmless no-op until the secrets are configured.
//
//   X_API_KEY        OAuth 1.0a consumer (API) key
//   X_API_SECRET     OAuth 1.0a consumer (API) secret
//   X_ACCESS_TOKEN   OAuth 1.0a access token (user context, read+write app)
//   X_ACCESS_SECRET  OAuth 1.0a access token secret
//   RELEASE_TAG      version tag, e.g. "v0.18.1" (defaults to "the latest version").
//                    Minor/major releases (patch component 0, e.g. v0.18.0)
//                    include the download URL; revision releases (patch > 0)
//                    post plain text without a link to avoid X's URL surcharge.
//   TWEET_TEXT       optional full override of the tweet body
//   DRY_RUN          when set, print the tweet + skip the network call
//
//   node scripts/post-release-tweet.mjs
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const TWEETS_URL = "https://api.twitter.com/2/tweets";
const MAX_TWEET_LEN = 280;

// RFC 3986 percent-encoding. encodeURIComponent leaves !*'() unescaped, but
// OAuth 1.0a requires them encoded, so finish the job by hand.
export function pct(value) {
  return encodeURIComponent(String(value)).replace(
    /[!*'()]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

// Build the `Authorization: OAuth …` header for a request. `params` holds any
// query/body parameters that must be folded into the signature base string
// (none for a JSON-body v2 tweet — the body is not signed); the oauth_* fields
// are added here. Exported so the signing can be checked against X's published
// example vector in tests without live credentials.
export function oauthHeader({
  method,
  url,
  params = {},
  consumerKey,
  consumerSecret,
  token,
  tokenSecret,
  nonce,
  timestamp,
}) {
  const oauth = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(timestamp),
    oauth_token: token,
    oauth_version: "1.0",
  };

  const all = { ...params, ...oauth };
  const paramString = Object.keys(all)
    .sort()
    .map((k) => `${pct(k)}=${pct(all[k])}`)
    .join("&");
  const baseString = [
    method.toUpperCase(),
    pct(url),
    pct(paramString),
  ].join("&");
  const signingKey = `${pct(consumerSecret)}&${pct(tokenSecret)}`;
  oauth.oauth_signature = crypto
    .createHmac("sha1", signingKey)
    .update(baseString)
    .digest("base64");

  return (
    "OAuth " +
    Object.keys(oauth)
      .sort()
      .map((k) => `${pct(k)}="${pct(oauth[k])}"`)
      .join(", ")
  );
}

// Normalize a git tag ("v0.18.1", "0.18.1", or empty) into the "v0.18.1" form
// used in the tweet copy.
export function formatVersion(tag) {
  const trimmed = (tag || "").trim();
  if (!trimmed) return "the latest version";
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

// X charges a premium ($0.20) for a post that contains a URL, so the download
// link is reserved for releases worth that cost: minor and major releases,
// whose patch (third) component is 0 (e.g. v0.18.0, v1.0.0). Revision releases
// (patch > 0, e.g. v0.18.1) are routine, so they go out as plain text with no
// link. An unparseable tag defaults to NO link, so an unexpected tag format
// can never silently incur the surcharge.
export function shouldIncludeLink(tag) {
  const m = (tag || "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!m) return false;
  return Number(m[3]) === 0;
}

export function buildTweetText() {
  if (process.env.TWEET_TEXT && process.env.TWEET_TEXT.trim()) {
    return process.env.TWEET_TEXT.trim();
  }
  const version = formatVersion(process.env.RELEASE_TAG);
  const headline = `🦛 Rest Hippo ${version} is out!`;
  return shouldIncludeLink(process.env.RELEASE_TAG)
    ? `${headline}\n\nDownload → https://resthippo.com`
    : headline;
}

async function main() {
  const consumerKey = (process.env.X_API_KEY || "").trim();
  const consumerSecret = (process.env.X_API_SECRET || "").trim();
  const token = (process.env.X_ACCESS_TOKEN || "").trim();
  const tokenSecret = (process.env.X_ACCESS_SECRET || "").trim();

  const text = buildTweetText();
  if ([...text].length > MAX_TWEET_LEN) {
    // Count by code points, matching how X measures length.
    console.error(
      `Tweet is ${[...text].length} characters, over the ${MAX_TWEET_LEN} limit. Aborting.`,
    );
    process.exit(1);
  }

  if (process.env.DRY_RUN) {
    console.log("[dry-run] Would post the following tweet:\n");
    console.log(text);
    return;
  }

  if (!consumerKey || !consumerSecret || !token || !tokenSecret) {
    console.log(
      "X credentials not configured (X_API_KEY/X_API_SECRET/X_ACCESS_TOKEN/X_ACCESS_SECRET); skipping tweet.",
    );
    return;
  }

  const header = oauthHeader({
    method: "POST",
    url: TWEETS_URL,
    consumerKey,
    consumerSecret,
    token,
    tokenSecret,
    nonce: crypto.randomBytes(32).toString("hex"),
    timestamp: Math.floor(Date.now() / 1000),
  });

  const res = await fetch(TWEETS_URL, {
    method: "POST",
    headers: {
      Authorization: header,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });

  const bodyText = await res.text();
  if (!res.ok) {
    // A credits/billing (402) or rate-limit (429) rejection is a transient X
    // account condition, not a release failure: warn and skip cleanly so a
    // depleted-credit or throttled moment never turns the release job red. The
    // Release + website jobs are already done by the time we run. Everything
    // else (401 auth, 403 permissions, 400 bad request) is a real misconfig and
    // still fails loudly.
    if (res.status === 402 || res.status === 429) {
      console.warn(
        `X API returned ${res.status} ${res.statusText}; skipping tweet (not a release failure):\n${bodyText}`,
      );
      return;
    }
    console.error(`X API returned ${res.status} ${res.statusText}:\n${bodyText}`);
    process.exit(1);
  }

  let id = "(unknown id)";
  try {
    id = JSON.parse(bodyText)?.data?.id ?? id;
  } catch {
    // Non-JSON success body is unexpected but not fatal — the post succeeded.
  }
  console.log(`Posted release tweet (id ${id}).`);
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || "").href;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
