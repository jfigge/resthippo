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
 * secret-storage.js — Owns the selectable secret-storage backend: its config
 * file, the app-key file, master-password key derivation/verification, and the
 * mode-switch re-encryption migration.
 *
 * Three at-rest backends exist (see crypto.js for the ciphertext families):
 *   - "app-key"          a random 256-bit key in a 0600 file (no OS prompt; DEFAULT
 *                        for fresh installs). enck:v1:
 *   - "os-keychain"      Electron safeStorage (macOS Keychain / DPAPI / libsecret).
 *                        enc:v1: — historical behaviour.
 *   - "master-password"  key derived from a user passphrase, cached in memory for
 *                        the session; secrets locked until unlocked. encm:v1:
 *
 * The active mode is recorded in an UNENCRYPTED config file
 * (`secret-storage.json`) read at bootstrap BEFORE any decrypt, so resolving the
 * mode never touches the keystore (and so never triggers the keychain prompt).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const nodeCrypto = require("crypto");
const io = require("./io");
const crypto = require("./crypto");

const CONFIG_VERSION = 1;
const MODES = ["app-key", "os-keychain", "master-password"];
const DEFAULT_MODE = "app-key";

// A fixed constant sealed under the master key; decrypting it back proves the
// entered password is correct (the GCM tag does the verification). Never secret.
const VERIFIER_PLAINTEXT = "resthippo:secret-storage:verifier:v1";
const MASTER_SALT_LEN = 16;

class SecretStorage {
  /**
   * @param {import('./paths').Paths} paths
   */
  constructor(paths) {
    this._paths = paths;
  }

  // ── Config file ───────────────────────────────────────────────────────────

  /** Read the secret-storage config, or null if it doesn't exist yet. */
  readConfig() {
    const raw = io.readJSON(this._paths.secretStorageConfigPath());
    if (!raw || typeof raw !== "object" || !MODES.includes(raw.mode))
      return null;
    return raw;
  }

  /** Atomically persist the secret-storage config. */
  writeConfig(config) {
    io.writeJSON(this._paths.secretStorageConfigPath(), {
      version: CONFIG_VERSION,
      ...config,
    });
  }

  // ── App key (0600 file) ──────────────────────────────────────────────────

  /** Read the app-key bytes (Buffer), or null when the key file is absent. */
  readAppKey() {
    try {
      const b64 = fs.readFileSync(this._paths.secretKeyPath(), "utf8").trim();
      const key = Buffer.from(b64, "base64");
      return key.length === 32 ? key : null;
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
  }

  /**
   * Return the app key, generating + persisting a fresh one if absent.
   *
   * The key file is written 0600 and explicitly chmod'd — io.atomicWrite can't
   * guarantee the mode (it opens with the default 0666 & ~umask), so this uses a
   * dedicated write. On Windows the mode is a no-op; the app-key file has no real
   * OS protection there (that's what os-keychain/DPAPI is for) — documented in the
   * Security help text.
   */
  ensureAppKey() {
    const existing = this.readAppKey();
    if (existing) return existing;
    const key = nodeCrypto.randomBytes(32);
    const keyPath = this._paths.secretKeyPath();
    io.ensureDir(path.dirname(keyPath));
    fs.writeFileSync(keyPath, key.toString("base64"), { mode: 0o600 });
    try {
      fs.chmodSync(keyPath, 0o600); // the open-time mode is masked by umask
    } catch {
      /* best-effort (e.g. Windows) */
    }
    return key;
  }

  /**
   * Remove the app-key file. Called after switching AWAY from app-key mode — by
   * then every secret has been re-encrypted under the new backend, so the device
   * key protects nothing in the live store and shouldn't linger on disk.
   * Best-effort + idempotent (a missing file is fine).
   */
  deleteAppKey() {
    io.remove(this._paths.secretKeyPath());
  }

  // ── Master password ───────────────────────────────────────────────────────

  /**
   * Derive a master key for a NEW password, returning the key plus the kdf + a
   * verifier token to persist. (Mode is flipped separately, after migration.)
   * @param {string} password
   * @returns {{ key: Buffer, kdf: {salt:string, iterations:number}, verifier: string }}
   */
  prepareMasterPassword(password) {
    const salt = nodeCrypto.randomBytes(MASTER_SALT_LEN);
    const iterations = crypto.PBKDF2_ITERATIONS;
    const key = crypto.deriveKey(password, salt, iterations);
    const verifier = crypto._aesGcmEncrypt(VERIFIER_PLAINTEXT, key);
    return {
      key,
      kdf: { salt: salt.toString("base64"), iterations },
      verifier: verifier.toString("base64"),
    };
  }

  /**
   * Verify a password against a stored kdf + verifier, returning the derived key
   * on success or null on a wrong password / malformed config.
   * @param {string} password
   * @param {object} config  a config carrying { kdf, verifier }
   * @returns {Buffer|null}
   */
  verifyMasterPassword(password, config) {
    if (!config || !config.kdf || !config.verifier) return null;
    try {
      const salt = Buffer.from(config.kdf.salt, "base64");
      const key = crypto.deriveKey(password, salt, config.kdf.iterations);
      const got = crypto._aesGcmDecrypt(
        Buffer.from(config.verifier, "base64"),
        key,
      );
      return got === VERIFIER_PLAINTEXT ? key : null;
    } catch {
      return null; // bad password (GCM tag) or malformed verifier
    }
  }

  // ── Bootstrap (called once at startup, before any decrypt) ────────────────

  /**
   * Resolve the active mode + keys and configure crypto, BEFORE any store reads.
   *
   * On a fresh config (first run after this feature, or a new install) the mode is
   * INFERRED from existing on-disk ciphertext — os-keychain when any `enc:v1:`
   * value is found (preserving an existing keychain user's behaviour), else
   * app-key (the no-prompt default) — and persisted so it never re-scans.
   *
   * In master-password mode the key is NOT loaded here (the session starts
   * locked); the renderer prompts to unlock.
   *
   * @returns {{mode:string, locked:boolean}}
   */
  bootstrap() {
    let config = this.readConfig();
    if (!config) config = this._inferAndPersist();

    const mode = config.mode;
    let appKey = null;
    if (mode === "app-key") appKey = this.ensureAppKey();
    // master-password: leave the key null → starts locked until the user unlocks.

    crypto.configure({ mode, appKey, masterKey: null });
    return { mode, locked: crypto.isLocked() };
  }

  /** Probe on-disk ciphertext to infer the pre-existing mode, then persist it. */
  _inferAndPersist() {
    const mode = this._inferMode();
    if (mode === "app-key") this.ensureAppKey();
    const config = { mode };
    this.writeConfig(config);
    return config;
  }

  /**
   * Infer the mode for an install with no config: "os-keychain" if any `enc:v1:`
   * keystore ciphertext exists anywhere, else "app-key". Pure string-prefix
   * checks — never calls decryptString, so this NEVER triggers a keychain prompt.
   * Scans cheap→expensive and short-circuits on the first hit.
   */
  _inferMode() {
    const hasKeychainCiphertext = (value) =>
      typeof value === "string" && value.startsWith("enc:v1:");

    // 1) Manifest settings (read first at startup anyway).
    const manifest = io.readJSON(this._paths.manifestPath());
    if (
      this._settingsHasKeychainSecret(manifest?.settings, hasKeychainCiphertext)
    ) {
      return "os-keychain";
    }
    // 2) Environments (global + per-env variables).
    const envs = io.readJSON(this._paths.environmentsPath());
    if (this._envsHaveKeychainSecret(envs, hasKeychainCiphertext)) {
      return "os-keychain";
    }
    // 3) Per-collection metadata + tree + request files.
    for (const collId of this._listCollectionIds()) {
      const meta = io.readJSON(this._paths.metadataPath(collId));
      if (
        this._varsHaveKeychainSecret(meta?.variables, hasKeychainCiphertext)
      ) {
        return "os-keychain";
      }
      const tree = io.readJSON(this._paths.treePath(collId));
      if (this._treeHasKeychainSecret(tree?.children, hasKeychainCiphertext)) {
        return "os-keychain";
      }
      for (const reqId of this._listRequestIds(collId)) {
        const req = io.readJSON(this._paths.requestPath(collId, reqId));
        if (this._requestHasKeychainSecret(req, hasKeychainCiphertext)) {
          return "os-keychain";
        }
      }
    }
    return DEFAULT_MODE;
  }

  // ── Migration (re-encrypt every secret to a target backend) ───────────────

  /**
   * Re-encrypt every at-rest secret to `targetBackend`.
   *
   * Two passes for crash safety + non-destructive failure handling:
   *   1) VALIDATE — read every secret-bearing file and decrypt every secret value
   *      under the CURRENT backend. Any value that can't be decrypted is recorded;
   *      if there is ANY failure the migration ABORTS having written nothing, so
   *      the old data stays intact and readable. (Decrypting the keychain values
   *      here also coalesces the macOS prompt into one preflight.)
   *   2) CONVERT — only when pass 1 was clean: re-encrypt every value to the
   *      target (via crypto.reencryptValue, which decrypts-then-seals) and write
   *      each file. A crash mid-convert is recoverable: prefix dispatch keeps
   *      every value readable and re-running the migration converts the stragglers.
   *
   * The caller flips the mode in `secret-storage.json` only AFTER this resolves
   * { ok: true } — that write is the atomicity anchor.
   *
   * @param {string} targetBackend  "app-key" | "os-keychain" | "master-password"
   * @returns {{ ok: boolean, failures: Array<{file:string, reason:string}> }}
   */
  reencryptAll(targetBackend) {
    const files = this._secretFiles();

    // Pass 1 — validate decryptability under the current backend.
    const failures = [];
    for (const f of files) {
      const doc = io.readJSON(f.path);
      if (!doc) continue;
      for (const value of f.collect(doc)) {
        if (!crypto.isEncrypted(value)) continue;
        try {
          crypto.reencryptValue(value, targetBackend); // decrypt-then-seal (discarded)
        } catch (err) {
          failures.push({ file: f.label, reason: err?.code || "error" });
        }
      }
    }
    if (failures.length) return { ok: false, failures };

    // Pass 2 — convert + write. (Pass 1 proved every value decrypts, so these
    // reencryptValue calls won't throw.)
    for (const f of files) {
      const doc = io.readJSON(f.path);
      if (!doc) continue;
      const next = f.transform(doc, (v) =>
        crypto.reencryptValue(v, targetBackend),
      );
      io.writeJSON(f.path, next);
    }
    return { ok: true, failures: [] };
  }

  /**
   * The full set of secret-bearing files with, for each, a `collect` (yield every
   * secret value) and a `transform` (map a fn over every secret value) helper.
   * Scoped to live stores ONLY — never history/responses/cookies/archives.
   */
  _secretFiles() {
    const files = [];
    files.push({
      path: this._paths.manifestPath(),
      label: "manifest",
      collect: (doc) => collectSettings(doc.settings),
      transform: (doc, fn) => ({
        ...doc,
        settings: mapSettings(doc.settings, fn),
      }),
    });
    files.push({
      path: this._paths.environmentsPath(),
      label: "environments",
      collect: (doc) => collectEnvironments(doc),
      transform: (doc, fn) => mapEnvironments(doc, fn),
    });
    for (const collId of this._listCollectionIds()) {
      files.push({
        path: this._paths.metadataPath(collId),
        label: `metadata/${collId}`,
        collect: (doc) => collectVariables(doc.variables),
        transform: (doc, fn) => ({
          ...doc,
          variables: mapVariables(doc.variables, fn),
        }),
      });
      files.push({
        path: this._paths.treePath(collId),
        label: `tree/${collId}`,
        collect: (doc) => collectTree(doc.children),
        transform: (doc, fn) => ({
          ...doc,
          children: mapTree(doc.children, fn),
        }),
      });
      for (const reqId of this._listRequestIds(collId)) {
        files.push({
          path: this._paths.requestPath(collId, reqId),
          label: `request/${collId}/${reqId}`,
          collect: (doc) => collectRequest(doc),
          transform: (doc, fn) => mapRequest(doc, fn),
        });
      }
    }
    return files;
  }

  // ── Filesystem helpers ────────────────────────────────────────────────────

  _listCollectionIds() {
    return io
      .listDir(this._paths.collectionsDir(), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => io.isValidID(name));
  }

  _listRequestIds(collId) {
    return io
      .listDir(this._paths.requestsDir(collId))
      .filter((name) => name.endsWith(".json") && !io.isTempFileName(name))
      .map((name) => name.slice(0, -".json".length));
  }

  // ── Inference probes (string-prefix only) ─────────────────────────────────

  _settingsHasKeychainSecret(settings, isHit) {
    if (!settings || typeof settings !== "object") return false;
    return collectSettings(settings).some(isHit);
  }
  _envsHaveKeychainSecret(envs, isHit) {
    return collectEnvironments(envs ?? {}).some(isHit);
  }
  _varsHaveKeychainSecret(vars, isHit) {
    return collectVariables(vars).some(isHit);
  }
  _treeHasKeychainSecret(children, isHit) {
    return collectTree(children).some(isHit);
  }
  _requestHasKeychainSecret(req, isHit) {
    if (!req || typeof req !== "object") return false;
    return collectRequest(req).some(isHit);
  }
}

// ── Pure shape helpers (collect every secret value / map a fn over them) ──────
//
// `collect` returns the secret values for the validate pass; `map` returns a new
// document with `fn` applied to each. They share the same per-shape taxonomy so
// the two passes can never drift.

const { REQUEST_SECRET_PATHS, SETTINGS_SECRET_KEYS } = crypto;

function collectSettings(settings) {
  if (!settings || typeof settings !== "object") return [];
  const out = [];
  for (const key of SETTINGS_SECRET_KEYS) {
    if (settings[key] !== undefined) out.push(settings[key]);
  }
  if (Array.isArray(settings.clientCerts)) {
    for (const c of settings.clientCerts) {
      if (c && typeof c === "object" && c.passphrase !== undefined) {
        out.push(c.passphrase);
      }
    }
  }
  return out;
}

function mapSettings(settings, fn) {
  if (!settings || typeof settings !== "object") return settings;
  const out = { ...settings };
  for (const key of SETTINGS_SECRET_KEYS) {
    if (out[key] !== undefined) out[key] = fn(out[key]);
  }
  if (Array.isArray(out.clientCerts)) {
    out.clientCerts = out.clientCerts.map((c) =>
      c && typeof c === "object" && c.passphrase !== undefined
        ? { ...c, passphrase: fn(c.passphrase) }
        : c,
    );
  }
  return out;
}

// Variables are [{ name, value, secure }] — only `secure` entries hold a secret.
function collectVariables(vars) {
  if (!Array.isArray(vars)) return [];
  return vars
    .filter((v) => v && typeof v === "object" && v.secure)
    .map((v) => v.value);
}

function mapVariables(vars, fn) {
  if (!Array.isArray(vars)) return vars;
  return vars.map((v) =>
    v && typeof v === "object" && v.secure ? { ...v, value: fn(v.value) } : v,
  );
}

function collectEnvironments(doc) {
  const out = collectVariables(doc?.globalVariables);
  if (Array.isArray(doc?.environments)) {
    for (const env of doc.environments) {
      out.push(...collectVariables(env?.variables));
    }
  }
  return out;
}

function mapEnvironments(doc, fn) {
  return {
    ...doc,
    globalVariables: mapVariables(doc.globalVariables, fn),
    environments: Array.isArray(doc.environments)
      ? doc.environments.map((env) =>
          env && typeof env === "object"
            ? { ...env, variables: mapVariables(env.variables, fn) }
            : env,
        )
      : doc.environments,
  };
}

// Tree folder nodes carry `variables`; recurse children.
function collectTree(nodes) {
  const out = [];
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!node || typeof node !== "object") continue;
    out.push(...collectVariables(node.variables));
    out.push(...collectTree(node.children));
  }
  return out;
}

function mapTree(nodes, fn) {
  if (!Array.isArray(nodes)) return nodes;
  return nodes.map((node) => {
    if (!node || typeof node !== "object") return node;
    return {
      ...node,
      ...(node.variables !== undefined
        ? { variables: mapVariables(node.variables, fn) }
        : {}),
      ...(node.children !== undefined
        ? { children: mapTree(node.children, fn) }
        : {}),
    };
  });
}

function collectRequest(req) {
  if (!req || typeof req !== "object") return [];
  const out = [];
  for (const [parent, field] of REQUEST_SECRET_PATHS) {
    const sub = req[parent];
    if (sub && typeof sub === "object" && sub[field] !== undefined) {
      out.push(sub[field]);
    }
  }
  return out;
}

function mapRequest(req, fn) {
  if (!req || typeof req !== "object") return req;
  const out = { ...req };
  for (const [parent, field] of REQUEST_SECRET_PATHS) {
    const sub = out[parent];
    if (sub && typeof sub === "object" && sub[field] !== undefined) {
      out[parent] = { ...sub, [field]: fn(sub[field]) };
    }
  }
  return out;
}

module.exports = { SecretStorage, MODES, DEFAULT_MODE };
