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
 * secret-storage.test.js — Tests for the selectable secret-storage backend:
 * mode inference, the 0600 app-key file, master-password verification, and the
 * mode-switch re-encryption migration (happy path, non-destructive failure, and
 * crash-resume idempotency).
 *
 * Run with:
 *   node --test src/app/store/tests/secret-storage.test.js
 */
"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");
const nodeCrypto = require("node:crypto");

const { Paths } = require("../paths");
const { SecretStorage } = require("../secret-storage");
const { Stores } = require("../stores");
const crypto = require("../crypto");

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rh-secret-store-"));
}
function rmTmpDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
function resetCrypto() {
  crypto.configure({ mode: "os-keychain", appKey: null, masterKey: null });
}

describe("mode inference (no decrypt → no keychain prompt)", () => {
  afterEach(resetCrypto);

  it("a fresh profile infers app-key, persists it, and generates the key file", () => {
    const dir = makeTmpDir();
    try {
      const ss = new SecretStorage(new Paths(dir));
      const { mode } = ss.bootstrap();
      assert.equal(mode, "app-key");
      assert.equal(ss.readConfig().mode, "app-key");
      assert.ok(fs.existsSync(new Paths(dir).secretKeyPath()));
      assert.equal(crypto.getMode(), "app-key");
    } finally {
      rmTmpDir(dir);
    }
  });

  it("infers os-keychain when an enc:v1: value exists on disk", () => {
    const dir = makeTmpDir();
    try {
      const paths = new Paths(dir);
      fs.mkdirSync(path.dirname(paths.manifestPath()), { recursive: true });
      fs.writeFileSync(
        paths.manifestPath(),
        JSON.stringify({ settings: { proxyUrl: "enc:v1:abc" } }),
      );
      const ss = new SecretStorage(paths);
      assert.equal(ss.bootstrap().mode, "os-keychain");
      // No app key generated for an os-keychain inference.
      assert.ok(!fs.existsSync(paths.secretKeyPath()));
    } finally {
      rmTmpDir(dir);
    }
  });

  it("infers master-password from encm: ciphertext and never mints an app key", () => {
    const dir = makeTmpDir();
    try {
      const paths = new Paths(dir);
      fs.mkdirSync(path.dirname(paths.manifestPath()), { recursive: true });
      // A profile whose secrets were sealed under a master password, with the
      // config file lost. Defaulting to app-key here would generate a fresh key
      // and the encm: secrets could NEVER be unlocked again.
      fs.writeFileSync(
        paths.manifestPath(),
        JSON.stringify({ settings: { proxyPassword: "encm:v1:sealed" } }),
      );
      const ss = new SecretStorage(paths);
      const { mode, locked } = ss.bootstrap();
      assert.equal(mode, "master-password");
      assert.equal(locked, true); // starts locked → prompts to unlock (recoverable)
      assert.equal(ss.readConfig().mode, "master-password");
      // The regression guard: no fresh app key was minted over the secrets.
      assert.ok(!fs.existsSync(paths.secretKeyPath()));
    } finally {
      rmTmpDir(dir);
    }
  });

  it("prefers master-password over a stray enc:v1: value (recovery priority)", () => {
    const dir = makeTmpDir();
    try {
      const paths = new Paths(dir);
      fs.mkdirSync(path.dirname(paths.manifestPath()), { recursive: true });
      // A half-migrated profile with both families present; the unlock-only
      // master-password data must win so it stays recoverable.
      fs.writeFileSync(
        paths.manifestPath(),
        JSON.stringify({
          settings: { proxyUrl: "enc:v1:abc", proxyPassword: "encm:v1:sealed" },
        }),
      );
      const ss = new SecretStorage(paths);
      assert.equal(ss.bootstrap().mode, "master-password");
      assert.ok(!fs.existsSync(paths.secretKeyPath()));
    } finally {
      rmTmpDir(dir);
    }
  });

  it("infers app-key when only enck: ciphertext exists", () => {
    const dir = makeTmpDir();
    try {
      const paths = new Paths(dir);
      fs.mkdirSync(path.dirname(paths.manifestPath()), { recursive: true });
      fs.writeFileSync(
        paths.manifestPath(),
        JSON.stringify({ settings: { proxyPassword: "enck:v1:sealed" } }),
      );
      const ss = new SecretStorage(paths);
      assert.equal(ss.bootstrap().mode, "app-key");
    } finally {
      rmTmpDir(dir);
    }
  });
});

describe("app-key file", () => {
  afterEach(resetCrypto);

  it(
    "is written with 0600 permissions",
    { skip: process.platform === "win32" },
    () => {
      const dir = makeTmpDir();
      try {
        const ss = new SecretStorage(new Paths(dir));
        ss.ensureAppKey();
        const mode = fs.statSync(new Paths(dir).secretKeyPath()).mode & 0o777;
        assert.equal(mode, 0o600);
      } finally {
        rmTmpDir(dir);
      }
    },
  );

  it("is stable across calls (read-or-generate)", () => {
    const dir = makeTmpDir();
    try {
      const ss = new SecretStorage(new Paths(dir));
      const a = ss.ensureAppKey();
      const b = ss.ensureAppKey();
      assert.ok(a.equals(b));
      assert.equal(a.length, 32);
    } finally {
      rmTmpDir(dir);
    }
  });

  it("deleteAppKey() removes the file and is a no-op when absent", () => {
    const dir = makeTmpDir();
    try {
      const paths = new Paths(dir);
      const ss = new SecretStorage(paths);
      ss.ensureAppKey();
      assert.ok(fs.existsSync(paths.secretKeyPath()));
      ss.deleteAppKey();
      assert.ok(!fs.existsSync(paths.secretKeyPath()));
      assert.doesNotThrow(() => ss.deleteAppKey()); // idempotent
    } finally {
      rmTmpDir(dir);
    }
  });
});

describe("master-password verifier", () => {
  it("verifies the right password and rejects the wrong one", () => {
    const ss = new SecretStorage(new Paths(makeTmpDir()));
    const prep = ss.prepareMasterPassword("hunter2");
    const config = { kdf: prep.kdf, verifier: prep.verifier };
    assert.equal(ss.verifyMasterPassword("nope", config), null);
    const key = ss.verifyMasterPassword("hunter2", config);
    assert.ok(Buffer.isBuffer(key) && key.equals(prep.key));
  });
});

describe("reencryptAll migration", () => {
  afterEach(resetCrypto);

  // Seed a workspace whose secrets are sealed under `mode`, returning paths.
  function seed(dir, mode, keys) {
    const paths = new Paths(dir);
    crypto.configure({ mode, ...keys });
    fs.mkdirSync(paths.requestsDir("c1"), { recursive: true });
    fs.mkdirSync(path.dirname(paths.manifestPath()), { recursive: true });
    fs.writeFileSync(
      paths.manifestPath(),
      JSON.stringify({
        settings: { proxyUrl: crypto.encryptString("http://u:p@h") },
      }),
    );
    fs.writeFileSync(
      paths.requestPath("c1", "r1"),
      JSON.stringify({
        id: "r1",
        authBearer: { token: crypto.encryptString("tok") },
      }),
    );
    fs.mkdirSync(paths.environmentsDir(), { recursive: true });
    fs.writeFileSync(
      paths.environmentsPath(),
      JSON.stringify({
        globalVariables: [
          { name: "k", value: crypto.encryptString("v"), secure: true },
        ],
      }),
    );
    return paths;
  }

  it("re-encrypts every secret to the target backend (app-key → master)", () => {
    const dir = makeTmpDir();
    try {
      const APP_KEY = nodeCrypto.randomBytes(32);
      const MK = nodeCrypto.randomBytes(32);
      const paths = seed(dir, "app-key", { appKey: APP_KEY });
      const ss = new SecretStorage(paths);

      // Both keys loaded so the migration can decrypt enck: and seal encm:.
      crypto.configure({ mode: "app-key", appKey: APP_KEY, masterKey: MK });
      const res = ss.reencryptAll("master-password");
      assert.ok(res.ok);
      assert.equal(res.failures.length, 0);

      // Every secret value now carries the encm: prefix.
      const manifest = JSON.parse(
        fs.readFileSync(paths.manifestPath(), "utf8"),
      );
      const req = JSON.parse(
        fs.readFileSync(paths.requestPath("c1", "r1"), "utf8"),
      );
      const envs = JSON.parse(
        fs.readFileSync(paths.environmentsPath(), "utf8"),
      );
      assert.ok(manifest.settings.proxyUrl.startsWith("encm:v1:"));
      assert.ok(req.authBearer.token.startsWith("encm:v1:"));
      assert.ok(envs.globalVariables[0].value.startsWith("encm:v1:"));

      // …and decrypts back to the originals under the master key.
      crypto.configure({ mode: "master-password", masterKey: MK });
      assert.equal(crypto.decryptString(req.authBearer.token), "tok");
      assert.equal(
        crypto.decryptString(manifest.settings.proxyUrl),
        "http://u:p@h",
      );
    } finally {
      rmTmpDir(dir);
    }
  });

  it("is non-destructive on failure and leaves the mode caller-decided", () => {
    const dir = makeTmpDir();
    try {
      const MK = nodeCrypto.randomBytes(32);
      const paths = seed(dir, "master-password", { masterKey: MK });
      const before = fs.readFileSync(paths.requestPath("c1", "r1"), "utf8");

      // Drop the master key → the encm: values can't be decrypted to migrate.
      const ss = new SecretStorage(paths);
      crypto.configure({ mode: "master-password", masterKey: null });
      const res = ss.reencryptAll("app-key");
      assert.equal(res.ok, false);
      assert.ok(res.failures.length >= 1);
      // The file is untouched — original ciphertext preserved.
      assert.equal(
        fs.readFileSync(paths.requestPath("c1", "r1"), "utf8"),
        before,
      );
    } finally {
      rmTmpDir(dir);
    }
  });

  it("is idempotent / crash-resumable (a second run converts nothing new)", () => {
    const dir = makeTmpDir();
    try {
      const APP_KEY = nodeCrypto.randomBytes(32);
      const paths = seed(dir, "app-key", { appKey: APP_KEY });
      const ss = new SecretStorage(paths);
      crypto.configure({ mode: "app-key", appKey: APP_KEY });

      assert.ok(ss.reencryptAll("app-key").ok); // already app-key
      const after1 = fs.readFileSync(paths.requestPath("c1", "r1"), "utf8");
      const res2 = ss.reencryptAll("app-key");
      assert.ok(res2.ok);
      assert.equal(
        fs.readFileSync(paths.requestPath("c1", "r1"), "utf8"),
        after1,
      );
    } finally {
      rmTmpDir(dir);
    }
  });
});

describe("locked-session save does not wipe secrets (end-to-end)", () => {
  afterEach(resetCrypto);

  it("preserves an environment secret saved while master-password is locked", () => {
    const dir = makeTmpDir();
    try {
      const paths = new Paths(dir);
      // Pin master-password mode for this profile.
      const ss = new SecretStorage(paths);
      const prep = ss.prepareMasterPassword("pw");
      ss.writeConfig({
        mode: "master-password",
        kdf: prep.kdf,
        verifier: prep.verifier,
      });

      // Build Stores (bootstrap configures master-password, locked) then unlock to seed.
      const stores = new Stores(dir);
      crypto.setMasterKey(prep.key);
      stores.environmentStore().saveEnvironments({
        globalVariables: [{ name: "api", value: "s3cret", secure: true }],
      });
      const onDisk = JSON.parse(
        fs.readFileSync(paths.environmentsPath(), "utf8"),
      );
      assert.ok(onDisk.globalVariables[0].value.startsWith("encm:v1:"));

      // Lock, read (value blanks + marks), then save back the blanked list.
      crypto.lock();
      const read = stores.environmentStore().getEnvironments();
      assert.equal(read.globalVariables[0].value, "");
      stores.environmentStore().saveEnvironments(read);

      // The on-disk ciphertext must survive the locked save.
      const after = JSON.parse(
        fs.readFileSync(paths.environmentsPath(), "utf8"),
      );
      assert.equal(
        after.globalVariables[0].value,
        onDisk.globalVariables[0].value,
      );
    } finally {
      rmTmpDir(dir);
    }
  });
});
