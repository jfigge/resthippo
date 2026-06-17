/**
 * cookie-store.test.js — Persistence + scoping tests for the cookie jar store.
 *
 * Exercises capture → attach round-trips, per-collection isolation, expiry
 * pruning on disk, and clear/delete taking effect immediately — Feature 09's
 * acceptance criteria at the store layer. RFC-6265 semantics are covered
 * separately in cookie-jar.test.js.
 *
 * Run with:
 *   node --test src/app/store/tests/cookie-store.test.js
 */
"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");

const { Paths } = require("../paths");
const { CookieStore } = require("../cookie-store");

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "resthippo-cookie-test-"));
}

/** A CookieStore whose clock is fixed and advanceable for deterministic expiry. */
function makeStore(dir, startNow) {
  const store = new CookieStore(new Paths(dir));
  let now = startNow;
  store._now = () => now;
  return {
    store,
    set: (t) => {
      now = t;
    },
  };
}

const NOW = 1_700_000_000_000;
const COLL = "coll-1";

describe("CookieStore capture + attach", () => {
  let dir;
  beforeEach(() => {
    dir = makeTmpDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a captured Set-Cookie is sent on the next matching request", () => {
    const { store } = makeStore(dir, NOW);
    store.captureSetCookies(COLL, "https://example.com/login", [
      "sid=abc; Path=/",
    ]);
    assert.equal(
      store.cookieHeaderFor(COLL, "https://example.com/api"),
      "sid=abc",
    );
  });

  it("persists across store instances (re-read from disk)", () => {
    const a = makeStore(dir, NOW);
    a.store.captureSetCookies(COLL, "https://example.com/", ["sid=abc"]);
    const b = makeStore(dir, NOW + 1000);
    assert.equal(
      b.store.cookieHeaderFor(COLL, "https://example.com/"),
      "sid=abc",
    );
  });

  it("does not send cookies to a non-matching domain", () => {
    const { store } = makeStore(dir, NOW);
    store.captureSetCookies(COLL, "https://example.com/", ["sid=abc"]);
    assert.equal(store.cookieHeaderFor(COLL, "https://other.com/"), "");
  });

  it("respects path scoping", () => {
    const { store } = makeStore(dir, NOW);
    store.captureSetCookies(COLL, "https://example.com/admin", [
      "adm=1; Path=/admin",
    ]);
    assert.equal(store.cookieHeaderFor(COLL, "https://example.com/public"), "");
    assert.equal(
      store.cookieHeaderFor(COLL, "https://example.com/admin/x"),
      "adm=1",
    );
  });

  it("does not send expired cookies", () => {
    const { store, set } = makeStore(dir, NOW);
    store.captureSetCookies(COLL, "https://example.com/", ["t=1; Max-Age=10"]);
    set(NOW + 60_000);
    assert.equal(store.cookieHeaderFor(COLL, "https://example.com/"), "");
  });

  it("updates a cookie value on re-capture (upsert)", () => {
    const { store } = makeStore(dir, NOW);
    store.captureSetCookies(COLL, "https://example.com/", ["sid=v1; Path=/"]);
    store.captureSetCookies(COLL, "https://example.com/", ["sid=v2; Path=/"]);
    assert.equal(store.cookieHeaderFor(COLL, "https://example.com/"), "sid=v2");
  });

  it("merges multiple cookies on one request", () => {
    const { store } = makeStore(dir, NOW);
    store.captureSetCookies(COLL, "https://example.com/", ["a=1", "b=2"]);
    const header = store.cookieHeaderFor(COLL, "https://example.com/");
    assert.ok(header.includes("a=1"));
    assert.ok(header.includes("b=2"));
  });
});

describe("CookieStore isolation + management", () => {
  let dir;
  beforeEach(() => {
    dir = makeTmpDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps each collection's jar separate", () => {
    const { store } = makeStore(dir, NOW);
    store.captureSetCookies("coll-a", "https://example.com/", ["x=1"]);
    store.captureSetCookies("coll-b", "https://example.com/", ["y=2"]);
    assert.equal(
      store.cookieHeaderFor("coll-a", "https://example.com/"),
      "x=1",
    );
    assert.equal(
      store.cookieHeaderFor("coll-b", "https://example.com/"),
      "y=2",
    );
  });

  it("clearJar takes effect immediately", () => {
    const { store } = makeStore(dir, NOW);
    store.captureSetCookies(COLL, "https://example.com/", ["a=1"]);
    store.clearJar(COLL);
    assert.equal(store.cookieHeaderFor(COLL, "https://example.com/"), "");
    assert.deepEqual(store.listCookies(COLL), []);
  });

  it("deleteCookie removes one entry by identity", () => {
    const { store } = makeStore(dir, NOW);
    store.captureSetCookies(COLL, "https://example.com/", ["a=1", "b=2"]);
    const list = store.listCookies(COLL);
    const a = list.find((c) => c.name === "a");
    store.deleteCookie(COLL, { name: "a", domain: a.domain, path: a.path });
    const header = store.cookieHeaderFor(COLL, "https://example.com/");
    assert.equal(header, "b=2");
  });

  it("listCookies prunes expired entries from disk", () => {
    const { store, set } = makeStore(dir, NOW);
    store.captureSetCookies(COLL, "https://example.com/", [
      "live=1",
      "dead=1; Max-Age=10",
    ]);
    set(NOW + 60_000);
    const live = store.listCookies(COLL);
    assert.deepEqual(
      live.map((c) => c.name),
      ["live"],
    );
    // The pruned state is persisted.
    const raw = JSON.parse(
      fs.readFileSync(
        path.join(dir, "collections", COLL, "cookies.json"),
        "utf8",
      ),
    );
    assert.deepEqual(
      raw.cookies.map((c) => c.name),
      ["live"],
    );
  });

  it("listCookies returns [] for an unknown collection", () => {
    const { store } = makeStore(dir, NOW);
    assert.deepEqual(store.listCookies("never-seen"), []);
  });

  it("rejects an unsafe collection id", () => {
    const { store } = makeStore(dir, NOW);
    assert.throws(() => store.listCookies("../escape"));
  });
});
