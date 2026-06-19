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
 * cookie-jar.test.js — Unit tests for the pure RFC-6265 cookie engine.
 *
 * These cover parsing, normalisation against a request URL, domain/path/secure
 * matching, expiry (Max-Age vs Expires), upsert identity/replacement, and the
 * Cookie-header ordering/serialisation — the semantics behind Feature 09's
 * acceptance criteria. No filesystem or Electron involved.
 *
 * Run with:
 *   node --test src/app/store/tests/cookie-jar.test.js
 */
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  parseSetCookie,
  cookieFromSetCookie,
  defaultPath,
  domainMatch,
  pathMatch,
  resolveExpiry,
  isExpired,
  upsertCookie,
  selectCookies,
  serializeCookieHeader,
  pruneExpired,
} = require("../cookie-jar");

const NOW = 1_700_000_000_000; // fixed epoch ms for deterministic expiry tests

describe("parseSetCookie", () => {
  it("parses a bare name=value", () => {
    assert.deepEqual(parseSetCookie("sid=abc"), {
      name: "sid",
      value: "abc",
      domain: null,
      path: null,
      maxAge: null,
      expires: null,
      secure: false,
      httpOnly: false,
      sameSite: null,
    });
  });

  it("parses attributes case-insensitively and recognises flags", () => {
    const c = parseSetCookie(
      "sid=abc; Domain=Example.com; Path=/app; Secure; HttpOnly; SameSite=Lax; Max-Age=60",
    );
    assert.equal(c.domain, "example.com");
    assert.equal(c.path, "/app");
    assert.equal(c.secure, true);
    assert.equal(c.httpOnly, true);
    assert.equal(c.sameSite, "Lax");
    assert.equal(c.maxAge, 60);
  });

  it("strips a leading dot from Domain", () => {
    assert.equal(
      parseSetCookie("a=1; Domain=.example.com").domain,
      "example.com",
    );
  });

  it("ignores a Path that does not start with /", () => {
    assert.equal(parseSetCookie("a=1; Path=relative").path, null);
  });

  it("returns null when there is no name=value pair", () => {
    assert.equal(parseSetCookie("justtext"), null);
    assert.equal(parseSetCookie("=novalue"), null);
    assert.equal(parseSetCookie(""), null);
    assert.equal(parseSetCookie(null), null);
  });

  it("keeps an empty value", () => {
    assert.equal(parseSetCookie("a=").value, "");
  });
});

describe("defaultPath", () => {
  it("returns the directory of the request path", () => {
    assert.equal(defaultPath("/a/b/c"), "/a/b");
    assert.equal(defaultPath("/a"), "/");
    assert.equal(defaultPath("/"), "/");
    assert.equal(defaultPath(""), "/");
    assert.equal(defaultPath("noslash"), "/");
  });
});

describe("domainMatch", () => {
  it("matches identical hosts", () => {
    assert.ok(domainMatch("example.com", "example.com"));
  });
  it("matches a subdomain against a parent domain", () => {
    assert.ok(domainMatch("api.example.com", "example.com"));
  });
  it("does not match a sibling or unrelated domain", () => {
    assert.ok(!domainMatch("example.com.evil.com", "example.com"));
    assert.ok(!domainMatch("notexample.com", "example.com"));
    assert.ok(!domainMatch("example.com", "api.example.com"));
  });
});

describe("pathMatch", () => {
  it("matches identical paths", () => {
    assert.ok(pathMatch("/app", "/app"));
  });
  it("matches a prefix at a boundary", () => {
    assert.ok(pathMatch("/app/page", "/app"));
    assert.ok(pathMatch("/app/page", "/app/"));
  });
  it("rejects a non-boundary prefix", () => {
    assert.ok(!pathMatch("/application", "/app"));
  });
});

describe("resolveExpiry", () => {
  it("prefers Max-Age over Expires", () => {
    const exp = resolveExpiry({ maxAge: 60, expires: NOW + 999999 }, NOW);
    assert.equal(exp, NOW + 60_000);
  });
  it("treats Max-Age <= 0 as already expired", () => {
    assert.ok(resolveExpiry({ maxAge: 0, expires: null }, NOW) < NOW);
    assert.ok(resolveExpiry({ maxAge: -5, expires: null }, NOW) < NOW);
  });
  it("returns null (session cookie) when neither given", () => {
    assert.equal(resolveExpiry({ maxAge: null, expires: null }, NOW), null);
  });
});

describe("cookieFromSetCookie", () => {
  it("defaults domain to the request host and marks host-only", () => {
    const c = cookieFromSetCookie("sid=abc", "https://example.com/a/b", NOW);
    assert.equal(c.domain, "example.com");
    assert.equal(c.hostOnly, true);
    assert.equal(c.path, "/a"); // default-path from /a/b
    assert.equal(c.creation, NOW);
  });

  it("honours an explicit Domain (not host-only) when the host matches", () => {
    const c = cookieFromSetCookie(
      "sid=abc; Domain=example.com",
      "https://api.example.com/",
      NOW,
    );
    assert.equal(c.domain, "example.com");
    assert.equal(c.hostOnly, false);
  });

  it("rejects a Domain the request host cannot match (cross-site)", () => {
    const c = cookieFromSetCookie(
      "sid=abc; Domain=evil.com",
      "https://example.com/",
      NOW,
    );
    assert.equal(c, null);
  });

  it("resolves Max-Age into an absolute expiry", () => {
    const c = cookieFromSetCookie("a=1; Max-Age=120", "https://h.test/", NOW);
    assert.equal(c.expires, NOW + 120_000);
  });

  it("returns null for an invalid URL", () => {
    assert.equal(cookieFromSetCookie("a=1", "not a url", NOW), null);
  });
});

describe("upsertCookie", () => {
  const base = () => cookieFromSetCookie("a=1; Path=/", "https://h.test/", NOW);

  it("inserts a new cookie", () => {
    const out = upsertCookie([], base(), NOW);
    assert.equal(out.length, 1);
    assert.equal(out[0].value, "1");
  });

  it("replaces a cookie with the same name+domain+path and preserves creation", () => {
    const first = base();
    const second = {
      ...cookieFromSetCookie("a=2; Path=/", "https://h.test/", NOW + 5000),
    };
    const out = upsertCookie([first], second, NOW + 5000);
    assert.equal(out.length, 1);
    assert.equal(out[0].value, "2");
    assert.equal(out[0].creation, NOW); // creation preserved from the original
  });

  it("keeps cookies that differ by path", () => {
    const root = cookieFromSetCookie("a=1; Path=/", "https://h.test/", NOW);
    const app = cookieFromSetCookie(
      "a=2; Path=/app",
      "https://h.test/app",
      NOW,
    );
    const out = upsertCookie([root], app, NOW);
    assert.equal(out.length, 2);
  });

  it("removes an existing cookie when the incoming one is expired (deletion)", () => {
    const root = base();
    const del = cookieFromSetCookie(
      "a=; Max-Age=0; Path=/",
      "https://h.test/",
      NOW,
    );
    const out = upsertCookie([root], del, NOW);
    assert.equal(out.length, 0);
  });

  it("drops stale survivors during upsert", () => {
    const stale = cookieFromSetCookie(
      "old=1; Max-Age=10; Path=/",
      "https://h.test/",
      NOW,
    );
    const fresh = base();
    const out = upsertCookie([stale], fresh, NOW + 60_000);
    assert.deepEqual(
      out.map((c) => c.name),
      ["a"],
    );
  });
});

describe("selectCookies / serializeCookieHeader", () => {
  function jarFor() {
    let cookies = [];
    cookies = upsertCookie(
      cookies,
      cookieFromSetCookie("root=r; Path=/", "https://example.com/", NOW),
      NOW,
    );
    cookies = upsertCookie(
      cookies,
      cookieFromSetCookie(
        "app=a; Path=/app",
        "https://example.com/app",
        NOW + 1,
      ),
      NOW + 1,
    );
    cookies = upsertCookie(
      cookies,
      cookieFromSetCookie(
        "sec=s; Path=/; Secure",
        "https://example.com/",
        NOW + 2,
      ),
      NOW + 2,
    );
    cookies = upsertCookie(
      cookies,
      cookieFromSetCookie("other=o", "https://other.com/", NOW + 3),
      NOW + 3,
    );
    return cookies;
  }

  it("does not send cookies across non-matching domains", () => {
    const out = selectCookies(jarFor(), "https://example.com/", NOW + 10);
    assert.ok(!out.some((c) => c.name === "other"));
  });

  it("excludes Secure cookies over http", () => {
    const out = selectCookies(jarFor(), "http://example.com/", NOW + 10);
    assert.ok(!out.some((c) => c.name === "sec"));
  });

  it("includes Secure cookies over https", () => {
    const out = selectCookies(jarFor(), "https://example.com/", NOW + 10);
    assert.ok(out.some((c) => c.name === "sec"));
  });

  it("applies path scoping (/app cookie not sent to /)", () => {
    const out = selectCookies(jarFor(), "https://example.com/", NOW + 10);
    assert.ok(!out.some((c) => c.name === "app"));
  });

  it("orders longer paths first", () => {
    const out = selectCookies(jarFor(), "https://example.com/app/x", NOW + 10);
    assert.equal(out[0].name, "app"); // /app is longer than /
  });

  it("serializes to a Cookie header value", () => {
    const out = selectCookies(jarFor(), "https://example.com/", NOW + 10);
    const header = serializeCookieHeader(out);
    assert.match(header, /root=r/);
    assert.match(header, /sec=s/);
    assert.ok(!header.includes("other"));
  });

  it("excludes expired cookies", () => {
    const cookies = upsertCookie(
      [],
      cookieFromSetCookie("a=1; Max-Age=10; Path=/", "https://h.test/", NOW),
      NOW,
    );
    const out = selectCookies(cookies, "https://h.test/", NOW + 60_000);
    assert.equal(out.length, 0);
  });

  it("host-only cookies are not sent to subdomains", () => {
    const cookies = upsertCookie(
      [],
      cookieFromSetCookie("a=1", "https://example.com/", NOW), // host-only
      NOW,
    );
    const out = selectCookies(cookies, "https://api.example.com/", NOW + 1);
    assert.equal(out.length, 0);
  });

  it("domain cookies ARE sent to subdomains", () => {
    const cookies = upsertCookie(
      [],
      cookieFromSetCookie(
        "a=1; Domain=example.com",
        "https://example.com/",
        NOW,
      ),
      NOW,
    );
    const out = selectCookies(cookies, "https://api.example.com/", NOW + 1);
    assert.equal(out.length, 1);
  });
});

describe("isExpired / pruneExpired", () => {
  it("session cookies (null expiry) never expire", () => {
    assert.ok(!isExpired({ expires: null }, NOW));
  });
  it("prunes only past-expiry cookies", () => {
    const list = [
      { name: "live", expires: NOW + 1000 },
      { name: "dead", expires: NOW - 1000 },
      { name: "session", expires: null },
    ];
    assert.deepEqual(
      pruneExpired(list, NOW).map((c) => c.name),
      ["live", "session"],
    );
  });
});
