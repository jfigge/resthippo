"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const {
  parseChallenge,
  selectDigestChallenge,
  buildAuthorization,
  _hashName,
} = require("../digest.js");

const md5 = (s) => crypto.createHash("md5").update(s, "utf8").digest("hex");

// Pull a single param out of a built "Digest k=v, …" header for assertions.
function field(header, key) {
  const m = new RegExp(
    `(?:^|[,\\s])${key}=(?:"((?:[^"\\\\]|\\\\.)*)"|([^,\\s]+))`,
  ).exec(header);
  if (!m) return undefined;
  return m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2];
}

// ── parseChallenge ──────────────────────────────────────────────────────────

test("parseChallenge: extracts realm, nonce, qop, algorithm, opaque", () => {
  const p = parseChallenge(
    'Digest realm="r@host", qop="auth,auth-int", nonce="abc123", algorithm=SHA-256, opaque="op"',
  );
  assert.equal(p.realm, "r@host");
  assert.equal(p.nonce, "abc123");
  assert.equal(p.qop, "auth,auth-int");
  assert.equal(p.algorithm, "SHA-256");
  assert.equal(p.opaque, "op");
});

test("parseChallenge: handles escaped quotes inside a quoted value", () => {
  const p = parseChallenge('Digest realm="a\\"b", nonce="n"');
  assert.equal(p.realm, 'a"b');
  assert.equal(p.nonce, "n");
});

test("parseChallenge: returns null for non-Digest schemes", () => {
  assert.equal(parseChallenge('Basic realm="x"'), null);
  assert.equal(parseChallenge(""), null);
  assert.equal(parseChallenge(undefined), null);
});

// ── selectDigestChallenge ─────────────────────────────────────────────────────

test("selectDigestChallenge: picks the Digest challenge among multiple schemes", () => {
  assert.match(
    selectDigestChallenge(['Basic realm="x"', 'Digest realm="y", nonce="z"']),
    /^Digest /,
  );
  assert.equal(selectDigestChallenge(['Basic realm="x"', "Negotiate"]), null);
  assert.equal(selectDigestChallenge([]), null);
  assert.equal(selectDigestChallenge(null), null);
});

// ── buildAuthorization: canonical RFC vectors ─────────────────────────────────

test("buildAuthorization: RFC 2617 §3.5 MD5 vector", () => {
  const challenge = parseChallenge(
    'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"',
  );
  const header = buildAuthorization({
    method: "GET",
    uri: "/dir/index.html",
    username: "Mufasa",
    password: "Circle Of Life",
    challenge,
    cnonce: "0a4f113b",
    nc: 1,
  });
  assert.equal(field(header, "response"), "6629fae49393a05397450978507c4ef1");
  assert.equal(field(header, "qop"), "auth"); // "auth" preferred over "auth-int"
  assert.equal(field(header, "nc"), "00000001");
  assert.equal(field(header, "cnonce"), "0a4f113b");
  assert.equal(field(header, "uri"), "/dir/index.html");
  assert.equal(field(header, "opaque"), "5ccc069c403ebaf9f0171e9517f40e41");
});

test("buildAuthorization: RFC 7616 §3.9.1 SHA-256 vector", () => {
  const challenge = parseChallenge(
    'Digest realm="http-auth@example.org", qop="auth, auth-int", algorithm=SHA-256, nonce="7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v", opaque="FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS"',
  );
  const header = buildAuthorization({
    method: "GET",
    uri: "/dir/index.html",
    username: "Mufasa",
    password: "Circle of Life",
    challenge,
    cnonce: "f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ",
    nc: 1,
  });
  assert.equal(
    field(header, "response"),
    "753927fa0e85d155564e2e272a28d1802ca10daf4496794697cf8db5856cb6c1",
  );
  assert.equal(field(header, "algorithm"), "SHA-256");
});

test("buildAuthorization: RFC 7616 §3.9.1 MD5 vector (same inputs)", () => {
  const challenge = parseChallenge(
    'Digest realm="http-auth@example.org", qop="auth, auth-int", algorithm=MD5, nonce="7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v", opaque="FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS"',
  );
  const header = buildAuthorization({
    method: "GET",
    uri: "/dir/index.html",
    username: "Mufasa",
    password: "Circle of Life",
    challenge,
    cnonce: "f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ",
    nc: 1,
  });
  assert.equal(field(header, "response"), "8ca523f5e9506fed4657c9700eebdbec");
});

// ── buildAuthorization: algorithm + qop variants ──────────────────────────────

test("buildAuthorization: MD5-sess folds nonce+cnonce into HA1", () => {
  const challenge = parseChallenge(
    'Digest realm="r", algorithm=MD5-sess, qop="auth", nonce="NONCE"',
  );
  const cnonce = "CNONCE";
  const header = buildAuthorization({
    method: "GET",
    uri: "/x",
    username: "u",
    password: "p",
    challenge,
    cnonce,
    nc: 1,
  });
  const ha1Inner = md5("u:r:p");
  const ha1 = md5(`${ha1Inner}:NONCE:${cnonce}`);
  const ha2 = md5("GET:/x");
  const expected = md5(`${ha1}:NONCE:00000001:${cnonce}:auth:${ha2}`);
  assert.equal(field(header, "response"), expected);
  assert.equal(field(header, "algorithm"), "MD5-sess");
});

test("buildAuthorization: qop=auth-int hashes the entity body into HA2", () => {
  const challenge = parseChallenge(
    'Digest realm="r", algorithm=MD5, qop="auth-int", nonce="N"',
  );
  const cnonce = "C";
  const body = Buffer.from('{"a":1}', "utf8");
  const header = buildAuthorization({
    method: "POST",
    uri: "/p",
    username: "u",
    password: "p",
    challenge,
    entityBody: body,
    cnonce,
    nc: 1,
  });
  const ha1 = md5("u:r:p");
  const ha2 = md5(`POST:/p:${md5(body.toString("utf8"))}`);
  const expected = md5(`${ha1}:N:00000001:${cnonce}:auth-int:${ha2}`);
  assert.equal(field(header, "response"), expected);
  assert.equal(field(header, "qop"), "auth-int");
});

test("buildAuthorization: legacy RFC 2069 (no qop) omits qop/nc/cnonce", () => {
  const challenge = parseChallenge('Digest realm="r", nonce="N"');
  const header = buildAuthorization({
    method: "GET",
    uri: "/x",
    username: "u",
    password: "p",
    challenge,
    cnonce: "ignored",
  });
  const ha1 = md5("u:r:p");
  const ha2 = md5("GET:/x");
  assert.equal(field(header, "response"), md5(`${ha1}:N:${ha2}`));
  assert.equal(field(header, "qop"), undefined);
  assert.equal(field(header, "nc"), undefined);
  assert.equal(field(header, "cnonce"), undefined);
  assert.equal(field(header, "algorithm"), undefined); // none offered → none echoed
});

// ── buildAuthorization: failure modes ─────────────────────────────────────────

test("buildAuthorization: returns null for an unsupported algorithm", () => {
  const challenge = parseChallenge(
    'Digest realm="r", algorithm=whirlpool, nonce="N"',
  );
  assert.equal(
    buildAuthorization({
      method: "GET",
      uri: "/x",
      username: "u",
      password: "p",
      challenge,
    }),
    null,
  );
});

test("buildAuthorization: returns null when realm or nonce is missing", () => {
  assert.equal(
    buildAuthorization({
      method: "GET",
      uri: "/x",
      username: "u",
      password: "p",
      challenge: parseChallenge('Digest realm="r"'),
    }),
    null,
  );
  assert.equal(
    buildAuthorization({
      method: "GET",
      uri: "/x",
      username: "u",
      password: "p",
      challenge: { nonce: "N" },
    }),
    null,
  );
});

test("_hashName: maps RFC tokens (case/-sess insensitive), null for unknown", () => {
  assert.equal(_hashName("MD5"), "md5");
  assert.equal(_hashName("md5-sess"), "md5");
  assert.equal(_hashName("SHA-256"), "sha256");
  assert.equal(_hashName("SHA-256-sess"), "sha256");
  assert.equal(_hashName("SHA-512-256"), "sha512-256");
  assert.equal(_hashName(undefined), "md5"); // default
  assert.equal(_hashName("bogus"), null);
});
