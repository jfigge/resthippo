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

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  DecryptError,
  PasswordError,
  _setSafeStorage,
  isAvailable,
  isEncrypted,
  encryptString,
  decryptString,
  encryptRequest,
  decryptRequest,
  encryptSettings,
  decryptSettings,
  redactSettings,
  encryptVariables,
  decryptVariables,
  redactVariables,
  restoreUndecryptableVariables,
  isPasswordEncrypted,
  encryptWithPassword,
  decryptWithPassword,
  exportRequestSecrets,
  importRequestSecrets,
  exportSettingsSecrets,
  importSettingsSecrets,
  exportVariableSecrets,
  importVariableSecrets,
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

  it("decryptString throws DecryptError for enc:v1: values when safeStorage absent", () => {
    assert.throws(
      () => decryptString("enc:v1:abc123"),
      (err) => {
        assert.ok(err instanceof DecryptError);
        // `.code` is the canonical discriminator; `.reason` is its back-compat alias.
        assert.equal(err.code, "encryption-unavailable");
        assert.equal(err.reason, "encryption-unavailable");
        return true;
      },
    );
  });
});

describe("encryptRequest (no-op mode)", () => {
  it("returns an object that deeply equals the input", () => {
    const req = {
      id: "r1",
      authBasic: { username: "user", password: "secret" },
      authBearer: { token: "bearer-tok" },
      authOAuth2: {
        clientSecret: "cs",
        token: "tok",
        refreshToken: "rt",
        username: "u",
        password: "p",
      },
      authAwsIam: {
        accessKeyId: "key",
        secretAccessKey: "sak",
        sessionToken: "st",
      },
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
    const req = {
      id: "r1",
      name: "test",
      method: "GET",
      url: "https://api.example.com",
    };
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
    const req = {
      id: "r1",
      authBasic: { username: "u", password: "plaintext" },
    };
    assert.deepEqual(decryptRequest(req), req);
  });

  it("blanks enc:v1: values and records them in _decryptErrors when safeStorage absent", () => {
    const req = { authBasic: { username: "u", password: "enc:v1:abc123" } };
    const out = decryptRequest(req);
    assert.equal(out.authBasic.password, "");
    assert.deepEqual(out._decryptErrors, ["authBasic.password"]);
  });

  it("does not throw and leaves no marker for a fully plaintext request", () => {
    const req = { id: "r1", authBearer: { token: "plain" } };
    const out = decryptRequest(req);
    assert.equal(out.authBearer.token, "plain");
    assert.ok(!("_decryptErrors" in out));
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

  it("decryptSettings blanks enc:v1: proxyUrl and records it when safeStorage absent", () => {
    const settings = { proxyUrl: "enc:v1:abc123" };
    const out = decryptSettings(settings);
    assert.equal(out.proxyUrl, "");
    assert.deepEqual(out._decryptErrors, ["proxyUrl"]);
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

  it("redactSettings blanks every proxy secret field but keeps other keys", () => {
    const out = redactSettings({
      theme: "dark",
      proxyUrl: "http://h:8080",
      proxyUsername: "user",
      proxyPassword: "pass",
      proxyBypass: "localhost",
    });
    assert.equal(out.proxyUrl, "");
    assert.equal(out.proxyUsername, "");
    assert.equal(out.proxyPassword, "");
    // Non-secret fields (bypass list, theme) round-trip intact.
    assert.equal(out.proxyBypass, "localhost");
    assert.equal(out.theme, "dark");
  });
});

/**
 * The mTLS client-certificate list (settings.clientCerts) carries a per-entry
 * `passphrase` secret nested inside an array; only that field is sensitive (the
 * cert/key/PFX/CA paths are not). These verify it rides the same
 * encrypt/decrypt/redact/portable rails as the flat settings secrets.
 */
describe("settings clientCerts passphrase handling", () => {
  const reversibleSafeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(s, "utf8"),
    decryptString: (buf) => Buffer.from(buf).toString("utf8"),
  };

  afterEach(() => {
    _setSafeStorage(null);
  });

  const sample = () => ({
    theme: "dark",
    clientCerts: [
      {
        id: "1",
        host: "a.com",
        format: "pem",
        certPath: "/c",
        keyPath: "/k",
        passphrase: "pw1",
      },
      { id: "2", host: "b.com", format: "pfx", pfxPath: "/p", passphrase: "" },
    ],
  });

  it("encryptSettings encrypts only the passphrase, leaving paths untouched", () => {
    _setSafeStorage(reversibleSafeStorage);
    const out = encryptSettings(sample());
    assert.ok(isEncrypted(out.clientCerts[0].passphrase));
    assert.equal(out.clientCerts[0].certPath, "/c");
    assert.equal(out.clientCerts[0].keyPath, "/k");
    assert.equal(out.clientCerts[0].host, "a.com");
    // An empty passphrase stays empty (encryptString no-ops on falsy input).
    assert.equal(out.clientCerts[1].passphrase, "");
    assert.equal(out.clientCerts[1].pfxPath, "/p");
  });

  it("encryptSettings → decryptSettings round-trips the passphrase", () => {
    _setSafeStorage(reversibleSafeStorage);
    const out = decryptSettings(encryptSettings(sample()));
    assert.equal(out.clientCerts[0].passphrase, "pw1");
    assert.equal(out.clientCerts[1].passphrase, "");
    assert.ok(!("_decryptErrors" in out));
  });

  it("decryptSettings blanks an undecryptable passphrase and records its path", () => {
    // safeStorage absent → an enc:v1: value cannot be decrypted.
    const out = decryptSettings({
      clientCerts: [
        { id: "1", host: "a.com", format: "pem", passphrase: "enc:v1:abc" },
      ],
    });
    assert.equal(out.clientCerts[0].passphrase, "");
    assert.deepEqual(out._decryptErrors, ["clientCerts[0].passphrase"]);
  });

  it("redactSettings blanks every cert passphrase but keeps paths + host", () => {
    const out = redactSettings(sample());
    assert.equal(out.clientCerts[0].passphrase, "");
    assert.equal(out.clientCerts[0].certPath, "/c");
    assert.equal(out.clientCerts[0].host, "a.com");
  });

  it("export → import round-trips the passphrase under a password (portable)", () => {
    const PW = "correct horse";
    const exported = exportSettingsSecrets(sample(), PW);
    assert.ok(isPasswordEncrypted(exported.clientCerts[0].passphrase));
    // Paths are not secret — they travel verbatim.
    assert.equal(exported.clientCerts[0].certPath, "/c");
    const imported = importSettingsSecrets(exported, PW);
    assert.equal(imported.clientCerts[0].passphrase, "pw1");
  });

  it("importSettingsSecrets clears portable cert passphrases without a password", () => {
    const exported = exportSettingsSecrets(sample(), "pw");
    const imported = importSettingsSecrets(exported, "");
    assert.equal(imported.clientCerts[0].passphrase, "");
    // The entry's structure (host, paths) survives the clear.
    assert.equal(imported.clientCerts[0].host, "a.com");
  });

  it("tolerates settings with no clientCerts array", () => {
    assert.doesNotThrow(() => encryptSettings({ theme: "x" }));
    assert.doesNotThrow(() => decryptSettings({ theme: "x" }));
    assert.doesNotThrow(() => redactSettings({ theme: "x" }));
  });
});

/**
 * Forces the decrypt-failure branch by injecting a mock safeStorage that
 * reports encryption as available but throws on decryptString() — simulating a
 * corrupted blob, a keystore/profile mismatch, or a rotated key. Verifies that
 * failures surface (typed error + non-silent marker) instead of silently
 * returning a blank or stale-ciphertext value.
 */
describe("decrypt failure branch (mock safeStorage that throws)", () => {
  // Mock that is "available" but cannot decrypt anything.
  const throwingSafeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(s, "utf8"),
    decryptString: () => {
      throw new Error("boom");
    },
  };

  afterEach(() => {
    // Restore the real (absent) state so other suites keep their no-op mode.
    _setSafeStorage(null);
  });

  it("decryptString throws a DecryptError with reason 'decrypt-failed'", () => {
    _setSafeStorage(throwingSafeStorage);
    assert.throws(
      () => decryptString("enc:v1:" + Buffer.from("x").toString("base64")),
      (err) => {
        assert.ok(err instanceof DecryptError);
        assert.equal(err.code, "decrypt-failed");
        assert.equal(err.reason, "decrypt-failed");
        return true;
      },
    );
  });

  it("decryptRequest blanks the field, records the path, and does not throw", () => {
    _setSafeStorage(throwingSafeStorage);
    const req = {
      id: "r1",
      authBasic: { username: "u", password: "enc:v1:abc" },
      authBearer: { token: "enc:v1:def" },
    };
    let out;
    assert.doesNotThrow(() => {
      out = decryptRequest(req);
    });
    assert.equal(out.authBasic.password, "");
    assert.equal(out.authBearer.token, "");
    assert.deepEqual(out._decryptErrors, [
      "authBasic.password",
      "authBearer.token",
    ]);
    // Original object is never mutated.
    assert.equal(req.authBasic.password, "enc:v1:abc");
  });

  it("decryptSettings blanks proxyUrl, records it, and does not throw", () => {
    _setSafeStorage(throwingSafeStorage);
    const settings = { theme: "dark", proxyUrl: "enc:v1:abc" };
    let out;
    assert.doesNotThrow(() => {
      out = decryptSettings(settings);
    });
    assert.equal(out.proxyUrl, "");
    assert.deepEqual(out._decryptErrors, ["proxyUrl"]);
    assert.equal(settings.proxyUrl, "enc:v1:abc");
  });

  it("decryptSettings records every failing proxy credential field", () => {
    _setSafeStorage(throwingSafeStorage);
    const settings = {
      theme: "dark",
      proxyUrl: "enc:v1:a",
      proxyUsername: "enc:v1:b",
      proxyPassword: "enc:v1:c",
    };
    const out = decryptSettings(settings);
    assert.equal(out.proxyUrl, "");
    assert.equal(out.proxyUsername, "");
    assert.equal(out.proxyPassword, "");
    assert.deepEqual(out._decryptErrors, [
      "proxyUrl",
      "proxyUsername",
      "proxyPassword",
    ]);
  });

  it("encryptRequest strips the _decryptErrors marker so it is never persisted", () => {
    _setSafeStorage(throwingSafeStorage);
    const decrypted = decryptRequest({
      id: "r1",
      authBasic: { username: "u", password: "enc:v1:abc" },
    });
    assert.ok("_decryptErrors" in decrypted);
    const reencrypted = encryptRequest(decrypted);
    assert.ok(!("_decryptErrors" in reencrypted));
  });
});

/**
 * Variable-list helpers operate on the canonical array shape
 * [{ name, value, secure }]. In no-op mode (safeStorage absent) secure values
 * pass through as plaintext; the encrypt/decrypt round-trip and failure markers
 * are exercised with the reversible / throwing mocks below.
 */
describe("encryptVariables / decryptVariables / redactVariables (no-op mode)", () => {
  it("encryptVariables returns non-array input unchanged", () => {
    assert.equal(encryptVariables(null), null);
    assert.equal(encryptVariables(undefined), undefined);
  });

  it("encryptVariables leaves secure values as plaintext when encryption unavailable", () => {
    const list = [
      { name: "base", value: "https://x", secure: false },
      { name: "key", value: "s3cr3t", secure: true },
    ];
    assert.deepEqual(encryptVariables(list), list);
  });

  it("encryptVariables does not mutate the original entries", () => {
    const list = [{ name: "key", value: "s3cr3t", secure: true }];
    encryptVariables(list);
    assert.equal(list[0].value, "s3cr3t");
  });

  it("decryptVariables returns plaintext list unchanged with no marker", () => {
    const list = [
      { name: "base", value: "https://x", secure: false },
      { name: "key", value: "s3cr3t", secure: true },
    ];
    const out = decryptVariables(list);
    assert.deepEqual(out, list);
    assert.ok(!out.some((e) => "decryptError" in e));
  });

  it("decryptVariables blanks enc:v1: values and marks the entry when safeStorage absent", () => {
    const list = [
      { name: "base", value: "https://x", secure: false },
      { name: "key", value: "enc:v1:abc123", secure: true },
    ];
    const out = decryptVariables(list, "environment", "env-1");
    assert.equal(out[0].value, "https://x");
    assert.ok(!("decryptError" in out[0]));
    assert.equal(out[1].value, "");
    assert.equal(out[1].decryptError, "encryption-unavailable");
  });

  it("redactVariables blanks only secure values", () => {
    const list = [
      { name: "base", value: "https://x", secure: false },
      { name: "key", value: "s3cr3t", secure: true },
    ];
    const out = redactVariables(list);
    assert.equal(out[0].value, "https://x");
    assert.equal(out[1].value, "");
    // Original is not mutated.
    assert.equal(list[1].value, "s3cr3t");
  });

  it("redactVariables returns non-array input unchanged", () => {
    assert.equal(redactVariables(null), null);
  });
});

describe("variable helpers — reversible mock safeStorage", () => {
  // Reversible mock: round-trips a string through a base64 buffer so the
  // encrypt → on-disk → decrypt path can be exercised without a real keystore.
  const reversibleSafeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(s, "utf8"),
    decryptString: (buf) => Buffer.from(buf).toString("utf8"),
  };

  afterEach(() => {
    _setSafeStorage(null);
  });

  it("encryptVariables → decryptVariables round-trips secure values", () => {
    _setSafeStorage(reversibleSafeStorage);
    const list = [
      { name: "base", value: "https://x", secure: false },
      { name: "key", value: "s3cr3t", secure: true },
    ];
    const encrypted = encryptVariables(list);
    // Secure value is ciphertext at rest; non-secure value stays plaintext.
    assert.ok(isEncrypted(encrypted[1].value));
    assert.equal(encrypted[0].value, "https://x");

    const decrypted = decryptVariables(encrypted);
    assert.equal(decrypted[1].value, "s3cr3t");
    assert.ok(!decrypted.some((e) => "decryptError" in e));
  });

  it("encryptVariables strips a stale decryptError marker so it is never persisted", () => {
    _setSafeStorage(reversibleSafeStorage);
    const list = [
      {
        name: "key",
        value: "s3cr3t",
        secure: true,
        decryptError: "decrypt-failed",
      },
    ];
    const encrypted = encryptVariables(list);
    assert.ok(!("decryptError" in encrypted[0]));
    assert.ok(isEncrypted(encrypted[0].value));
  });
});

describe("variable helpers — decrypt failure branch (throwing mock)", () => {
  const throwingSafeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(s, "utf8"),
    decryptString: () => {
      throw new Error("boom");
    },
  };

  afterEach(() => {
    _setSafeStorage(null);
  });

  it("decryptVariables blanks the failing entry, marks it, and does not throw", () => {
    _setSafeStorage(throwingSafeStorage);
    const list = [
      { name: "base", value: "https://x", secure: false },
      { name: "key", value: "enc:v1:abc", secure: true },
    ];
    let out;
    assert.doesNotThrow(() => {
      out = decryptVariables(list, "environment", "env-1");
    });
    assert.equal(out[1].value, "");
    assert.equal(out[1].decryptError, "decrypt-failed");
    // Original list is never mutated.
    assert.equal(list[1].value, "enc:v1:abc");
  });
});

describe("restoreUndecryptableVariables (clobber guard)", () => {
  it("restores ciphertext for a blank, decryptError-marked entry the caller echoed back", () => {
    // Simulates: read failed to decrypt (value blanked + marked), the renderer
    // round-tripped that blank value back on save. The guard must restore the
    // still-recoverable on-disk ciphertext rather than persist the blank.
    const incoming = [
      { name: "key", value: "", secure: true, decryptError: "decrypt-failed" },
    ];
    const encrypted = encryptVariables(incoming); // blank value, marker stripped
    const existing = [{ name: "key", value: "enc:v1:onDisk", secure: true }];
    const out = restoreUndecryptableVariables(encrypted, incoming, existing);
    assert.equal(out[0].value, "enc:v1:onDisk");
  });

  it("does NOT restore when the user re-entered a fresh value", () => {
    // The caller supplied a real new value (no decryptError marker) — honour it.
    const incoming = [{ name: "key", value: "brand-new", secure: true }];
    const encrypted = encryptVariables(incoming);
    const existing = [{ name: "key", value: "enc:v1:onDisk", secure: true }];
    const out = restoreUndecryptableVariables(encrypted, incoming, existing);
    assert.equal(out[0].value, "brand-new");
  });

  it("does NOT restore when the marked entry has a non-blank value", () => {
    const incoming = [
      {
        name: "key",
        value: "typed-over",
        secure: true,
        decryptError: "decrypt-failed",
      },
    ];
    const encrypted = encryptVariables(incoming);
    const existing = [{ name: "key", value: "enc:v1:onDisk", secure: true }];
    const out = restoreUndecryptableVariables(encrypted, incoming, existing);
    assert.equal(out[0].value, "typed-over");
  });

  it("leaves entries with no matching existing ciphertext untouched", () => {
    const incoming = [
      { name: "new", value: "", secure: true, decryptError: "decrypt-failed" },
    ];
    const encrypted = encryptVariables(incoming);
    const out = restoreUndecryptableVariables(encrypted, incoming, []);
    assert.equal(out[0].value, "");
  });

  it("returns non-array encrypted input unchanged", () => {
    assert.equal(restoreUndecryptableVariables(null, [], []), null);
  });
});

// ── Password-based portable encryption (encp:v1:) ─────────────────────────────
//
// Unlike the keystore helpers above, these use Node's `crypto` directly, so they
// perform REAL encryption in this test environment. Tests exercise round-trips,
// the encp:v1: tagging, tamper/wrong-password detection, and the object-level
// portable transforms for requests, settings, and variables.

const PW = "correct horse battery staple";

describe("isPasswordEncrypted", () => {
  it("recognises the encp:v1: prefix", () => {
    assert.ok(isPasswordEncrypted("encp:v1:abc"));
  });

  it("returns false for keystore ciphertext, plaintext, and non-strings", () => {
    assert.ok(!isPasswordEncrypted("enc:v1:abc"));
    assert.ok(!isPasswordEncrypted("plaintext"));
    assert.ok(!isPasswordEncrypted(""));
    assert.ok(!isPasswordEncrypted(null));
    assert.ok(!isPasswordEncrypted(42));
  });
});

describe("encryptWithPassword / decryptWithPassword", () => {
  it("round-trips a secret through a password", () => {
    const ct = encryptWithPassword("s3cret", PW);
    assert.ok(isPasswordEncrypted(ct));
    assert.notEqual(ct, "s3cret");
    assert.equal(decryptWithPassword(ct, PW), "s3cret");
  });

  it("produces different ciphertext each call (random salt+iv)", () => {
    const a = encryptWithPassword("s3cret", PW);
    const b = encryptWithPassword("s3cret", PW);
    assert.notEqual(a, b);
    assert.equal(decryptWithPassword(a, PW), "s3cret");
    assert.equal(decryptWithPassword(b, PW), "s3cret");
  });

  it("round-trips unicode and long values", () => {
    const v = "🔐 пароль — " + "x".repeat(5000);
    assert.equal(decryptWithPassword(encryptWithPassword(v, PW), PW), v);
  });

  it("passes empty/falsy plaintext through unchanged", () => {
    assert.equal(encryptWithPassword("", PW), "");
    assert.equal(encryptWithPassword(null, PW), null);
    assert.equal(encryptWithPassword(undefined, PW), undefined);
  });

  it("is idempotent — already-portable input is returned unchanged", () => {
    const ct = encryptWithPassword("s3cret", PW);
    assert.equal(encryptWithPassword(ct, PW), ct);
  });

  it("throws PasswordError(malformed) when encrypting with no password", () => {
    assert.throws(
      () => encryptWithPassword("s3cret", ""),
      (err) => {
        assert.ok(err instanceof PasswordError);
        assert.equal(err.reason, "malformed");
        return true;
      },
    );
  });

  it("passes non-portable values through decrypt unchanged", () => {
    assert.equal(decryptWithPassword("plaintext", PW), "plaintext");
    assert.equal(decryptWithPassword("enc:v1:abc", PW), "enc:v1:abc");
  });

  it("throws PasswordError(bad-password) on the wrong password", () => {
    const ct = encryptWithPassword("s3cret", PW);
    assert.throws(
      () => decryptWithPassword(ct, "wrong"),
      (err) => {
        assert.ok(err instanceof PasswordError);
        // `.code` is the field backup:import discriminates on; `.reason` is its alias.
        assert.equal(err.code, "bad-password");
        assert.equal(err.reason, "bad-password");
        return true;
      },
    );
  });

  it("throws PasswordError(bad-password) when decrypting with no password", () => {
    const ct = encryptWithPassword("s3cret", PW);
    assert.throws(
      () => decryptWithPassword(ct, ""),
      (err) => {
        assert.equal(err.reason, "bad-password");
        return true;
      },
    );
  });

  it("throws PasswordError(malformed) on a truncated blob", () => {
    assert.throws(
      () => decryptWithPassword("encp:v1:AAAA", PW),
      (err) => {
        assert.equal(err.reason, "malformed");
        return true;
      },
    );
  });

  it("throws PasswordError(bad-password) on tampered ciphertext", () => {
    const ct = encryptWithPassword("s3cret", PW);
    const raw = Buffer.from(ct.slice("encp:v1:".length), "base64");
    raw[raw.length - 1] ^= 0xff; // flip a ciphertext bit
    const tampered = "encp:v1:" + raw.toString("base64");
    assert.throws(
      () => decryptWithPassword(tampered, PW),
      (err) => {
        assert.equal(err.reason, "bad-password");
        return true;
      },
    );
  });
});

describe("exportVariableSecrets / importVariableSecrets", () => {
  it("re-encrypts only secure entries under the password", () => {
    const list = [
      { name: "host", value: "example.com", secure: false },
      { name: "token", value: "t0p", secure: true },
    ];
    const out = exportVariableSecrets(list, PW);
    assert.equal(out[0].value, "example.com"); // non-secure untouched
    assert.ok(isPasswordEncrypted(out[1].value));
    assert.equal(decryptWithPassword(out[1].value, PW), "t0p");
  });

  it("round-trips secure values with the password on import", () => {
    const list = [{ name: "token", value: "t0p", secure: true }];
    const exported = exportVariableSecrets(list, PW);
    const imported = importVariableSecrets(exported, PW);
    assert.deepEqual(imported, [{ name: "token", value: "t0p", secure: true }]);
  });

  it("clears secure values (keeps flag) when importing without a password", () => {
    const list = [{ name: "token", value: "t0p", secure: true }];
    const exported = exportVariableSecrets(list, PW);
    const imported = importVariableSecrets(exported, "");
    assert.deepEqual(imported, [{ name: "token", value: "", secure: true }]);
  });

  it("strips the decryptError marker on export", () => {
    const list = [
      { name: "k", value: "v", secure: true, decryptError: "decrypt-failed" },
    ];
    const out = exportVariableSecrets(list, PW);
    assert.ok(!("decryptError" in out[0]));
  });

  it("returns a non-array list unchanged", () => {
    assert.equal(exportVariableSecrets(null, PW), null);
    assert.equal(importVariableSecrets(undefined, PW), undefined);
  });
});

describe("exportSettingsSecrets / importSettingsSecrets", () => {
  it("re-encrypts proxyUrl and round-trips it with the password", () => {
    const exported = exportSettingsSecrets({ proxyUrl: "http://u:p@h" }, PW);
    assert.ok(isPasswordEncrypted(exported.proxyUrl));
    const imported = importSettingsSecrets(exported, PW);
    assert.equal(imported.proxyUrl, "http://u:p@h");
  });

  it("clears proxyUrl when importing without a password", () => {
    const exported = exportSettingsSecrets({ proxyUrl: "http://u:p@h" }, PW);
    assert.equal(importSettingsSecrets(exported, "").proxyUrl, "");
  });

  it("round-trips separate proxy credentials with the password", () => {
    const exported = exportSettingsSecrets(
      {
        proxyUrl: "socks5://h:1080",
        proxyUsername: "user",
        proxyPassword: "pw",
      },
      PW,
    );
    assert.ok(isPasswordEncrypted(exported.proxyUsername));
    assert.ok(isPasswordEncrypted(exported.proxyPassword));
    const imported = importSettingsSecrets(exported, PW);
    assert.equal(imported.proxyUsername, "user");
    assert.equal(imported.proxyPassword, "pw");
  });

  it("clears proxy credentials when importing without a password", () => {
    const exported = exportSettingsSecrets(
      { proxyUsername: "user", proxyPassword: "pw" },
      PW,
    );
    const imported = importSettingsSecrets(exported, "");
    assert.equal(imported.proxyUsername, "");
    assert.equal(imported.proxyPassword, "");
  });

  it("leaves objects without proxyUrl and non-objects untouched", () => {
    assert.deepEqual(exportSettingsSecrets({ a: 1 }, PW), { a: 1 });
    assert.equal(exportSettingsSecrets(null, PW), null);
  });
});

describe("exportRequestSecrets / importRequestSecrets", () => {
  it("round-trips a request's auth secret with the password", () => {
    const req = { authBearer: { token: "abc123" } };
    const exported = exportRequestSecrets(req, PW);
    assert.ok(isPasswordEncrypted(exported.authBearer.token));
    const imported = importRequestSecrets(exported, PW);
    assert.equal(imported.authBearer.token, "abc123");
  });

  it("clears a request's auth secret when importing without a password", () => {
    const req = { authBasic: { password: "hunter2" } };
    const exported = exportRequestSecrets(req, PW);
    assert.equal(importRequestSecrets(exported, "").authBasic.password, "");
  });
});
