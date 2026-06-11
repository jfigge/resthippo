/**
 * tls.test.js — Unit tests for the mTLS / custom-trust helpers.
 *
 * Pure logic only: host→cert selection and verify-skip matching reuse the proxy
 * NO_PROXY dialect, and the file loaders take an injected reader so they never
 * touch disk. No Electron / no network.
 *
 * Run with:  node --test src/app/net/tests/tls.test.js
 */
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  selectClientCert,
  hostSkipsTlsVerify,
  loadClientCertMaterial,
  loadCaBundle,
} = require("../tls");

describe("selectClientCert", () => {
  const certs = [
    { host: "secure.bank.com", format: "pem", certPath: "/a.pem" },
    { host: "*.internal", format: "pfx", pfxPath: "/b.pfx" },
    { host: "api.example.com:8443", format: "pem", certPath: "/c.pem" },
  ];

  it("returns null when nothing is configured", () => {
    assert.equal(selectClientCert("x.com", 443, []), null);
    assert.equal(selectClientCert("x.com", 443, undefined), null);
  });

  it("matches an exact host", () => {
    assert.equal(
      selectClientCert("secure.bank.com", 443, certs)?.certPath,
      "/a.pem",
    );
  });

  it("matches a wildcard host", () => {
    assert.equal(
      selectClientCert("host1.internal", 443, certs)?.pfxPath,
      "/b.pfx",
    );
  });

  it("honours an entry's :port qualifier", () => {
    assert.equal(
      selectClientCert("api.example.com", 8443, certs)?.certPath,
      "/c.pem",
    );
    assert.equal(selectClientCert("api.example.com", 443, certs), null);
  });

  it("returns the FIRST matching entry (top-to-bottom precedence)", () => {
    const ordered = [
      { host: "a.internal", certPath: "/specific.pem" },
      { host: "*.internal", certPath: "/wildcard.pem" },
    ];
    assert.equal(
      selectClientCert("a.internal", 443, ordered)?.certPath,
      "/specific.pem",
    );
  });

  it("ignores entries with no host", () => {
    assert.equal(selectClientCert("a.com", 443, [{ certPath: "/x" }]), null);
  });

  it("returns null when no host matches", () => {
    assert.equal(selectClientCert("other.com", 443, certs), null);
  });
});

describe("hostSkipsTlsVerify", () => {
  it("is false for an empty list", () => {
    assert.equal(hostSkipsTlsVerify("a.com", 443, ""), false);
    assert.equal(hostSkipsTlsVerify("a.com", 443, undefined), false);
  });

  it("matches suffixes, globs and exact hosts (NO_PROXY dialect)", () => {
    assert.equal(hostSkipsTlsVerify("dev.test", 443, "*.test"), true);
    assert.equal(
      hostSkipsTlsVerify("internal.example.com", 443, "example.com"),
      true,
    );
    assert.equal(hostSkipsTlsVerify("other.com", 443, "example.com"), false);
  });

  it("accepts comma- or newline-separated lists", () => {
    assert.equal(hostSkipsTlsVerify("b.com", 443, "a.com, b.com"), true);
    assert.equal(hostSkipsTlsVerify("b.com", 443, "a.com\nb.com"), true);
  });
});

describe("loadClientCertMaterial", () => {
  const read = (p) => Buffer.from(`bytes:${p}`);

  it("reads cert + key for a PEM entry and carries the passphrase", () => {
    const out = loadClientCertMaterial(
      {
        format: "pem",
        certPath: "/c.pem",
        keyPath: "/k.pem",
        passphrase: "pw",
      },
      read,
    );
    assert.equal(out.cert.toString(), "bytes:/c.pem");
    assert.equal(out.key.toString(), "bytes:/k.pem");
    assert.equal(out.passphrase, "pw");
    assert.equal(out.pfx, undefined);
  });

  it("omits the key when none is configured (key in the cert file)", () => {
    const out = loadClientCertMaterial(
      { format: "pem", certPath: "/c.pem" },
      read,
    );
    assert.ok(out.cert);
    assert.equal(out.key, undefined);
    assert.equal(out.passphrase, undefined);
  });

  it("reads the PFX blob for a pfx entry", () => {
    const out = loadClientCertMaterial(
      { format: "pfx", pfxPath: "/b.pfx", passphrase: "pw" },
      read,
    );
    assert.equal(out.pfx.toString(), "bytes:/b.pfx");
    assert.equal(out.passphrase, "pw");
    assert.equal(out.cert, undefined);
  });

  it("throws when a PEM entry has no cert path", () => {
    assert.throws(() => loadClientCertMaterial({ format: "pem" }, read));
  });

  it("throws when a PFX entry has no pfx path", () => {
    assert.throws(() => loadClientCertMaterial({ format: "pfx" }, read));
  });

  it("propagates a read error (missing file is a hard error)", () => {
    const boom = () => {
      throw new Error("ENOENT");
    };
    assert.throws(
      () => loadClientCertMaterial({ format: "pem", certPath: "/x" }, boom),
      /ENOENT/,
    );
  });
});

describe("loadCaBundle", () => {
  const read = (p) => Buffer.from(`ca:${p}`);
  const roots = ["ROOT_A", "ROOT_B"];

  it("returns null when no custom CA is configured", () => {
    assert.equal(loadCaBundle([], read, roots), null);
    assert.equal(loadCaBundle(undefined, read, roots), null);
  });

  it("merges custom CAs AFTER the system roots", () => {
    const out = loadCaBundle(["/ca1.pem", "/ca2.pem"], read, roots);
    assert.equal(out.length, 4);
    assert.deepEqual(out.slice(0, 2), roots);
    assert.equal(out[2].toString(), "ca:/ca1.pem");
    assert.equal(out[3].toString(), "ca:/ca2.pem");
  });

  it("skips an unreadable CA file and reports it, keeping the rest", () => {
    const errs = [];
    const reader = (p) => {
      if (p === "/bad.pem") throw new Error("boom");
      return Buffer.from(`ca:${p}`);
    };
    const out = loadCaBundle(["/bad.pem", "/ok.pem"], reader, roots, (p, e) =>
      errs.push([p, e.message]),
    );
    assert.equal(out.length, 3); // 2 roots + 1 good CA
    assert.deepEqual(errs, [["/bad.pem", "boom"]]);
  });

  it("returns null when every custom CA fails to read", () => {
    const reader = () => {
      throw new Error("boom");
    };
    assert.equal(
      loadCaBundle(["/bad.pem"], reader, roots, () => {}),
      null,
    );
  });
});
