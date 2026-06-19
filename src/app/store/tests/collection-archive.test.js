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
 * collection-archive.test.js — secret handling for the native Rest Hippo v1
 * collection archive: detection of secret-bearing archives and the
 * password-encrypt → decrypt round-trip (reusing the portable `encp:v2:` scheme).
 *
 * Password-based crypto is independent of the OS keystore, so no safeStorage mock
 * is needed: plaintext values are encrypted straight under the password.
 *
 * Run with:   node --test store/tests/collection-archive.test.js
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  archiveHasSecrets,
  encryptArchiveSecrets,
  decryptArchiveSecrets,
} = require("../collection-archive");
const { isPasswordEncrypted, PasswordError } = require("../crypto");

function archiveWithSecrets() {
  return {
    format: "resthippo",
    kind: "resthippo-collection",
    collectionVariables: [{ name: "c", value: "plain", secure: false }],
    items: [
      {
        id: "f1",
        type: "collection",
        name: "API",
        variables: [{ name: "fk", value: "folderSecret", secure: true }],
        children: [
          {
            id: "r1",
            type: "request",
            name: "Login",
            authEnabled: true,
            authType: "basic",
            authBasic: { username: "alice", password: "s3cr3t" },
          },
        ],
      },
    ],
    environments: {
      globalVariables: [{ name: "g", value: "gSecret", secure: true }],
      environments: [
        {
          id: "e1",
          name: "Dev",
          variables: [{ name: "ev", value: "envSecret", secure: true }],
        },
      ],
    },
  };
}

test("archiveHasSecrets: true when any auth secret or secure var has a value", () => {
  assert.equal(archiveHasSecrets(archiveWithSecrets()), true);
});

test("archiveHasSecrets: false for a secret-free archive", () => {
  const clean = {
    items: [
      {
        id: "r1",
        type: "request",
        name: "Get",
        authEnabled: false,
        authType: "none",
      },
    ],
    collectionVariables: [{ name: "c", value: "x", secure: false }],
    environments: {
      globalVariables: [{ name: "g", value: "y", secure: false }],
      environments: [],
    },
  };
  assert.equal(archiveHasSecrets(clean), false);
});

test("archiveHasSecrets: a blank secure variable is not a secret", () => {
  const archive = {
    items: [],
    collectionVariables: [{ name: "c", value: "", secure: true }],
    environments: { globalVariables: [], environments: [] },
  };
  assert.equal(archiveHasSecrets(archive), false);
});

test("encrypt → decrypt round-trips every secret under the password", () => {
  const password = "correct horse battery staple";
  const enc = encryptArchiveSecrets(archiveWithSecrets(), password);

  // Envelope tagged; every secret is now portable ciphertext (not plaintext).
  assert.equal(enc.secretsMode, "password");
  const req = enc.items[0].children[0];
  assert.ok(isPasswordEncrypted(req.authBasic.password));
  assert.ok(isPasswordEncrypted(enc.items[0].variables[0].value));
  assert.ok(isPasswordEncrypted(enc.environments.globalVariables[0].value));
  assert.ok(
    isPasswordEncrypted(enc.environments.environments[0].variables[0].value),
  );
  // Non-secret values are untouched.
  assert.equal(enc.items[0].children[0].authBasic.username, "alice");
  assert.equal(enc.collectionVariables[0].value, "plain");

  const dec = decryptArchiveSecrets(enc, password);
  assert.equal(dec.items[0].children[0].authBasic.password, "s3cr3t");
  assert.equal(dec.items[0].variables[0].value, "folderSecret");
  assert.equal(dec.environments.globalVariables[0].value, "gSecret");
  assert.equal(
    dec.environments.environments[0].variables[0].value,
    "envSecret",
  );
});

test("decrypt with the wrong password throws PasswordError", () => {
  const enc = encryptArchiveSecrets(archiveWithSecrets(), "right");
  assert.throws(() => decryptArchiveSecrets(enc, "wrong"), PasswordError);
});

test("encrypt does not mutate the input archive", () => {
  const archive = archiveWithSecrets();
  encryptArchiveSecrets(archive, "pw");
  assert.equal(archive.items[0].children[0].authBasic.password, "s3cr3t");
  assert.equal(archive.secretsMode, undefined);
});
