/**
 * crypto.test.js — Unit tests for the secrets-at-rest encryption helpers.
 *
 * In this Node.js test context Electron's safeStorage is unavailable, so all
 * encrypt/decrypt functions operate in no-op (plaintext pass-through) mode.
 * The tests cover field-mapping correctness and immutability guarantees that
 * hold regardless of whether OS-level encryption is active.
 *
 * Run with:
 *   node --test src/app/store/tests/crypto.test.js
 */
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  isAvailable,
  isEncrypted,
  encryptString,
  decryptString,
  encryptRequest,
  decryptRequest,
  encryptSettings,
  decryptSettings,
} = require("../crypto");

describe("isAvailable", () => {
  it("returns false in a plain Node.js test environment", () => {
    assert.equal(isAvailable(), false);
  });
});

describe("isEncrypted", () => {
  it("recognises the enc:v1: prefix", () => {
    assert.ok(isEncrypted("enc:v1:abc123"));
  });

  it("returns false for plaintext strings", () => {
    assert.ok(!isEncrypted("plaintext"));
    assert.ok(!isEncrypted(""));
    assert.ok(!isEncrypted("enc:"));
  });

  it("returns false for non-string types", () => {
    assert.ok(!isEncrypted(null));
    assert.ok(!isEncrypted(undefined));
    assert.ok(!isEncrypted(42));
  });
});

describe("encryptString / decryptString (no-op mode)", () => {
  it("encryptString returns plaintext unchanged when encryption unavailable", () => {
    assert.equal(encryptString("secret"), "secret");
  });

  it("encryptString returns empty string unchanged", () => {
    assert.equal(encryptString(""), "");
  });

  it("decryptString returns plaintext values unchanged", () => {
    assert.equal(decryptString("plaintext"), "plaintext");
  });

  it("decryptString passes through enc:v1: values when safeStorage absent", () => {
    assert.equal(decryptString("enc:v1:abc123"), "enc:v1:abc123");
  });
});

describe("encryptRequest (no-op mode)", () => {
  it("returns an object that deeply equals the input", () => {
    const req = {
      id: "r1",
      authBasic:  { username: "user", password: "secret" },
      authBearer: { token: "bearer-tok" },
      authOAuth2: { clientSecret: "cs", token: "tok", refreshToken: "rt", username: "u", password: "p" },
      authAwsIam: { accessKeyId: "key", secretAccessKey: "sak", sessionToken: "st" },
    };
    assert.deepEqual(encryptRequest(req), req);
  });

  it("does not mutate the original object", () => {
    const req = { authBasic: { username: "u", password: "p" } };
    encryptRequest(req);
    assert.equal(req.authBasic.password, "p");
  });

  it("creates a new sub-object for each touched parent key", () => {
    const req = { authBasic: { username: "u", password: "p" } };
    const encrypted = encryptRequest(req);
    assert.notEqual(encrypted.authBasic, req.authBasic);
  });

  it("leaves non-secret fields untouched", () => {
    const req = { id: "r1", name: "test", method: "GET", url: "https://api.example.com" };
    assert.deepEqual(encryptRequest(req), req);
  });

  it("handles missing auth sub-objects gracefully", () => {
    const req = { id: "r1" };
    assert.doesNotThrow(() => encryptRequest(req));
    assert.deepEqual(encryptRequest(req), req);
  });

  it("handles null/undefined input gracefully", () => {
    assert.equal(encryptRequest(null), null);
    assert.equal(encryptRequest(undefined), undefined);
  });
});

describe("decryptRequest (no-op mode)", () => {
  it("returns plaintext request unchanged", () => {
    const req = { id: "r1", authBasic: { username: "u", password: "plaintext" } };
    assert.deepEqual(decryptRequest(req), req);
  });

  it("passes through enc:v1: values when safeStorage absent", () => {
    const req = { authBasic: { username: "u", password: "enc:v1:abc123" } };
    assert.equal(decryptRequest(req).authBasic.password, "enc:v1:abc123");
  });

  it("does not mutate the original object", () => {
    const req = { authBearer: { token: "tok" } };
    decryptRequest(req);
    assert.equal(req.authBearer.token, "tok");
  });
});

describe("encryptSettings / decryptSettings (no-op mode)", () => {
  it("encryptSettings returns settings unchanged when encryption unavailable", () => {
    const settings = { theme: "dark", proxyUrl: "http://proxy:8080" };
    assert.deepEqual(encryptSettings(settings), settings);
  });

  it("does not mutate the original settings object", () => {
    const settings = { proxyUrl: "http://proxy:8080" };
    encryptSettings(settings);
    assert.equal(settings.proxyUrl, "http://proxy:8080");
  });

  it("decryptSettings returns plaintext proxyUrl unchanged", () => {
    const settings = { proxyUrl: "http://proxy:8080" };
    assert.equal(decryptSettings(settings).proxyUrl, "http://proxy:8080");
  });

  it("decryptSettings passes through enc:v1: proxyUrl when safeStorage absent", () => {
    const settings = { proxyUrl: "enc:v1:abc123" };
    assert.equal(decryptSettings(settings).proxyUrl, "enc:v1:abc123");
  });

  it("handles missing proxyUrl without error", () => {
    const settings = { theme: "dark" };
    assert.doesNotThrow(() => encryptSettings(settings));
    assert.doesNotThrow(() => decryptSettings(settings));
  });

  it("handles null/undefined input gracefully", () => {
    assert.equal(encryptSettings(null), null);
    assert.equal(decryptSettings(undefined), undefined);
  });
});
