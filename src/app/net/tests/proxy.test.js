"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  proxyKind,
  withProxyCredentials,
  parseBypassList,
  hostBypassesProxy,
} = require("../proxy.js");

describe("proxyKind", () => {
  it("classifies socks schemes as socks", () => {
    for (const url of [
      "socks://h:1080",
      "socks4://h:1080",
      "socks5://h:1080",
      "socks5h://h:1080",
      "SOCKS5://H:1080",
    ]) {
      assert.equal(proxyKind(url), "socks", url);
    }
  });

  it("classifies http/https schemes as http", () => {
    assert.equal(proxyKind("http://h:8080"), "http");
    assert.equal(proxyKind("https://h:8443"), "http");
  });

  it("defaults a scheme-less host:port to http", () => {
    assert.equal(proxyKind("proxy.local:8080"), "http");
  });
});

describe("withProxyCredentials", () => {
  it("returns the URL unchanged when no credentials are given", () => {
    assert.equal(
      withProxyCredentials("http://h:8080", "", ""),
      "http://h:8080",
    );
  });

  it("injects username and password as userinfo", () => {
    const out = withProxyCredentials("http://h:8080", "user", "pass");
    const u = new URL(out);
    assert.equal(u.username, "user");
    assert.equal(u.password, "pass");
    assert.equal(u.hostname, "h");
    assert.equal(u.port, "8080");
  });

  it("percent-encodes credentials containing reserved characters", () => {
    const out = withProxyCredentials("socks5://h:1080", "a@b", "p:s/w@rd");
    const u = new URL(out);
    // Round-trips back to the raw values despite the reserved chars.
    assert.equal(decodeURIComponent(u.username), "a@b");
    assert.equal(decodeURIComponent(u.password), "p:s/w@rd");
    assert.equal(u.protocol, "socks5:");
  });

  it("explicit credentials override inline userinfo", () => {
    const out = withProxyCredentials("http://old:secret@h:8080", "new", "np");
    const u = new URL(out);
    assert.equal(u.username, "new");
    assert.equal(u.password, "np");
  });

  it("returns the original string when the URL cannot be parsed", () => {
    assert.equal(withProxyCredentials("::bogus::", "u", "p"), "::bogus::");
  });
});

describe("parseBypassList", () => {
  it("splits on commas, whitespace, and newlines and lower-cases", () => {
    assert.deepEqual(
      parseBypassList("Example.com, .internal\n10.0.*  localhost"),
      ["example.com", ".internal", "10.0.*", "localhost"],
    );
  });

  it("accepts an array and drops empties", () => {
    assert.deepEqual(parseBypassList(["A", "", "b "]), ["a", "b"]);
  });

  it("returns [] for non-string, non-array input", () => {
    assert.deepEqual(parseBypassList(null), []);
    assert.deepEqual(parseBypassList(42), []);
  });
});

describe("hostBypassesProxy", () => {
  it("returns false for an empty list", () => {
    assert.equal(hostBypassesProxy("example.com", 443, ""), false);
  });

  it("matches '*' against every host", () => {
    assert.equal(hostBypassesProxy("anything.com", 80, "*"), true);
  });

  it("matches a bare domain and its subdomains (suffix)", () => {
    assert.equal(hostBypassesProxy("example.com", 443, "example.com"), true);
    assert.equal(
      hostBypassesProxy("api.example.com", 443, "example.com"),
      true,
    );
    assert.equal(
      hostBypassesProxy("notexample.com", 443, "example.com"),
      false,
    );
  });

  it("treats a leading dot the same as a bare domain", () => {
    assert.equal(hostBypassesProxy("example.com", 443, ".example.com"), true);
    assert.equal(
      hostBypassesProxy("a.b.example.com", 443, ".example.com"),
      true,
    );
  });

  it("supports glob wildcards", () => {
    assert.equal(hostBypassesProxy("10.0.0.5", 80, "10.0.*"), true);
    assert.equal(hostBypassesProxy("10.1.0.5", 80, "10.0.*"), false);
    assert.equal(hostBypassesProxy("host.internal", 80, "*.internal"), true);
  });

  it("matches exact IPs", () => {
    assert.equal(hostBypassesProxy("192.168.1.10", 80, "192.168.1.10"), true);
    assert.equal(hostBypassesProxy("192.168.1.11", 80, "192.168.1.10"), false);
  });

  it("honours an optional :port qualifier", () => {
    assert.equal(
      hostBypassesProxy("example.com", 8443, "example.com:8443"),
      true,
    );
    assert.equal(
      hostBypassesProxy("example.com", 443, "example.com:8443"),
      false,
    );
  });

  it("matches any entry in a multi-entry list", () => {
    const list = "localhost, .internal, 10.0.*";
    assert.equal(hostBypassesProxy("svc.internal", 80, list), true);
    assert.equal(hostBypassesProxy("localhost", 80, list), true);
    assert.equal(hostBypassesProxy("public.example.com", 80, list), false);
  });

  it("ignores a trailing root dot on the host", () => {
    assert.equal(hostBypassesProxy("example.com.", 443, "example.com"), true);
  });
});
