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
const nodeCrypto = require("crypto");
const io = require("./io");
const crypto = require("./crypto");

const CONFIG_VERSION = 1;
const MODES = ["app-key", "os-keychain", "master-password"];
const DEFAULT_MODE = "app-key";

/**
 * Raised when the app-key file exists on disk but does not hold a valid 32-byte
 * key (truncated, externally edited, partially written). We MUST NOT treat this
 * as "absent" and mint a fresh key over it — doing so orphans every `enck:`
 * secret in the workspace irrecoverably. Callers surface this as a recovery
 * prompt instead.
 */
class AppKeyCorruptError extends Error {
  constructor(keyPath) {
    super(
      `App-key file at ${keyPath} exists but is not a valid 32-byte key; ` +
        `refusing to regenerate it (that would orphan all stored secrets). ` +
        `Restore the file from a backup or remove it deliberately to reset.`,
    );
    this.name = "AppKeyCorruptError";
    this.code = "APP_KEY_CORRUPT";
    this.keyPath = keyPath;
  }
}

/**
 * Pick the backend for a fresh install with no existing managed ciphertext.
 *
 * On Windows, Electron safeStorage is backed by DPAPI — real, user-bound at-rest
 * protection with NO prompt — whereas the app-key file's 0600 mode is a no-op
 * there (any local-user process can read it). So when the keystore is available
 * on Windows, os-keychain is the better PROMPTLESS default. Everywhere else keep
 * app-key: macOS os-keychain shows a Keychain prompt, and Linux may have no
 * Secret Service provider, so the no-prompt file is the safer default there.
 *
 * Pure (platform + availability in, mode out) so it is unit-testable without
 * touching process.platform.
 *
 * @param {string} platform           process.platform
 * @param {boolean} keystoreAvailable crypto.isAvailable()
 * @returns {string} a MODES value
 */
function defaultModeFor(platform, keystoreAvailable) {
  if (platform === "win32" && keystoreAvailable) return "os-keychain";
  return DEFAULT_MODE;
}

// A fixed constant sealed under the master key; decrypting it back proves the
// entered password is correct (the GCM tag does the verification). Never secret.
const VERIFIER_PLAINTEXT = "resthippo:secret-storage:verifier:v1";

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

  /**
   * Read the app-key bytes (Buffer), or null when the key file is genuinely
   * absent (ENOENT). If the file EXISTS but is not a valid 32-byte key, throw
   * {@link AppKeyCorruptError} rather than returning null — collapsing
   * "absent" and "corrupt" to null is what let ensureAppKey() silently mint a
   * fresh key over a damaged file and orphan every secret.
   */
  readAppKey() {
    const keyPath = this._paths.secretKeyPath();
    let b64;
    try {
      b64 = fs.readFileSync(keyPath, "utf8").trim();
    } catch (err) {
      if (err.code === "ENOENT") return null; // truly absent — safe to mint
      throw err; // I/O error — surface it, don't guess "absent"
    }
    const key = Buffer.from(b64, "base64");
    if (key.length !== 32) throw new AppKeyCorruptError(keyPath);
    return key;
  }

  /**
   * Return the app key, generating + persisting a fresh one only if genuinely
   * absent. If the key file exists but is corrupt, readAppKey() throws
   * {@link AppKeyCorruptError} and we propagate it — regenerating would orphan
   * every stored secret.
   *
   * The key is written durably via io.atomicWrite (tmp → fsync → rename →
   * fsync-dir) so a crash/ENOSPC mid-write can't leave a truncated key that the
   * next launch would see as corrupt; the 0600 mode is applied with an explicit
   * chmod after the rename (atomicWrite opens the temp with 0666 & ~umask). On
   * Windows the mode is a no-op; the app-key file has no real OS protection
   * there (that's what os-keychain/DPAPI is for) — documented in the Security
   * help text.
   */
  ensureAppKey() {
    const existing = this.readAppKey(); // throws on present-but-corrupt
    if (existing) return existing;
    const key = nodeCrypto.randomBytes(32);
    const keyPath = this._paths.secretKeyPath();
    io.atomicWrite(keyPath, key.toString("base64"));
    try {
      fs.chmodSync(keyPath, 0o600); // atomicWrite's temp opens 0666 & ~umask
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
   * verifier token to persist. Uses a memory-hard scrypt kdf (crypto.newMasterKdf)
   * — existing passwords keep their stored PBKDF2 descriptor and still verify via
   * crypto.deriveMasterKey. (Mode is flipped separately, after migration.)
   * @param {string} password
   * @returns {{ key: Buffer, kdf: object, verifier: string }}
   */
  prepareMasterPassword(password) {
    const kdf = crypto.newMasterKdf();
    const key = crypto.deriveMasterKey(password, kdf);
    const verifier = crypto._aesGcmEncrypt(VERIFIER_PLAINTEXT, key);
    return { key, kdf, verifier: verifier.toString("base64") };
  }

  /**
   * Verify a password against a stored kdf + verifier, returning the derived key
   * on success or null on a wrong password / malformed config. Dispatches on the
   * stored kdf (scrypt for new configs, PBKDF2 for legacy ones), so both remain
   * verifiable.
   * @param {string} password
   * @param {object} config  a config carrying { kdf, verifier }
   * @returns {Buffer|null}
   */
  verifyMasterPassword(password, config) {
    if (!config || !config.kdf || !config.verifier) return null;
    try {
      const key = crypto.deriveMasterKey(password, config.kdf);
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
   * On a fresh config (first run after this feature, or a lost config file) the
   * mode is INFERRED from existing on-disk ciphertext by family, in
   * recovery-priority order — master-password (`encm:`) → os-keychain (`enc:v1:`)
   * → app-key (`enck:`), else app-key (the no-prompt default) — and persisted so
   * it never re-scans. Probing master-password first is what prevents a lost
   * config from minting a fresh app key over unlock-only secrets (see
   * `_inferMode`).
   *
   * In master-password mode the key is NOT loaded here (the session starts
   * locked); the renderer prompts to unlock.
   *
   * @returns {{mode:string, locked:boolean}}
   */
  bootstrap() {
    let config = this.readConfig();
    if (!config) config = this._inferAndPersist();

    // Finish a mode-switch migration that a crash interrupted between converting
    // the secret files and flipping the mode (see markMigration/resumeMigration).
    // The no-password directions (app-key ↔ os-keychain) complete here, silently;
    // a direction involving master-password is deferred to the unlock prompt
    // below, since sealing/decrypting encm: needs the passphrase.
    const marker = this._migrationOf(config);
    if (marker && !this._markerNeedsPassword(marker)) {
      try {
        this.resumeMigration({});
      } catch (err) {
        console.warn(`[secret-storage] auto-resume failed: ${err?.message}`);
      }
      config = this.readConfig() || config; // refresh: mode flipped, marker cleared
    }

    // A still-pending master-password migration boots LOCKED in master-password
    // mode so the renderer prompts for the passphrase; the unlock handler then
    // calls resumeMigration() to finish it. config carries the kdf + verifier
    // (written by markMigration) needed to verify that passphrase.
    const pending = this._migrationOf(config);
    const mode =
      pending && this._markerNeedsPassword(pending)
        ? "master-password"
        : config.mode;

    let appKey = mode === "app-key" ? this.ensureAppKey() : null;
    // While any migration is still pending, also load the app key (if present)
    // so values already converted to enck: stay readable even in a mode that
    // wouldn't otherwise load it. (enc:v1: rides the always-present keystore;
    // encm: intentionally stays locked until the unlock above.)
    if (pending && appKey === null) appKey = this.readAppKey();

    crypto.configure({ mode, appKey, masterKey: null });
    return { mode, locked: crypto.isLocked() };
  }

  // ── In-flight migration marker + crash resume ─────────────────────────────

  /** The validated in-flight migration marker { from, to }, or null. */
  _migrationOf(config) {
    const m = config && config.migration;
    if (!m || typeof m !== "object") return null;
    if (!MODES.includes(m.from) || !MODES.includes(m.to) || m.from === m.to) {
      return null;
    }
    return { from: m.from, to: m.to };
  }

  _markerNeedsPassword(marker) {
    return marker.from === "master-password" || marker.to === "master-password";
  }

  /** The pending migration { from, to } for this profile, or null. */
  pendingMigration() {
    return this._migrationOf(this.readConfig());
  }

  /**
   * Durably record an in-flight mode switch BEFORE any file is converted, so a
   * crash mid-convert is finished automatically on next launch. The active mode
   * stays `from` (the still-readable backend); `extra` persists the target's key
   * material when needed (kdf + verifier for master-password). Any kdf/verifier
   * the CURRENT config already holds (a `master-password → …` migration) is
   * preserved so the from-side ciphertext stays unlockable during resume. The
   * marker is dropped by the final mode flip (a writeConfig with no `migration`).
   *
   * @param {string} from
   * @param {string} to
   * @param {object} [extra]
   */
  markMigration(from, to, extra = {}) {
    const config = this.readConfig() || {};
    const preserved = {};
    if (config.kdf) preserved.kdf = config.kdf;
    if (config.verifier) preserved.verifier = config.verifier;
    this.writeConfig({
      ...preserved,
      ...extra,
      mode: from,
      migration: { from, to },
    });
  }

  /**
   * Drop a migration marker without converting anything — used when a migration
   * aborts during its pre-convert validation (nothing was written, so the marker
   * is spurious). Keeps the mode and any master key material intact.
   */
  clearMigration() {
    const config = this.readConfig();
    if (!config || !config.migration) return;
    const { migration: _drop, ...rest } = config;
    this.writeConfig(rest);
  }

  /**
   * Finish an interrupted mode-switch migration recorded by markMigration().
   * reencryptAll() is idempotent (already-converted values are skipped), so this
   * converts only the stragglers and flips the mode — the same tail as the
   * happy-path secret-storage:set-mode handler. Returns one of:
   *   { status: "none" }                    no marker → nothing to do
   *   { status: "needs-unlock", from, to }  marker involves master-password but
   *                                         no masterKey was supplied — the caller
   *                                         must prompt then re-call
   *   { status: "failed", failures }        a value couldn't be decrypted; the
   *                                         marker is left in place for a retry
   *   { status: "resumed", from, to }       completed; mode flipped, marker gone
   *
   * @param {{ masterKey?: Buffer|null }} [opts]
   */
  resumeMigration({ masterKey = null } = {}) {
    const config = this.readConfig();
    const marker = this._migrationOf(config);
    if (!marker) return { status: "none" };
    const { from, to } = marker;
    if (this._markerNeedsPassword(marker) && !masterKey) {
      return { status: "needs-unlock", from, to };
    }

    // Load every key needed to READ the `from` ciphertext and SEAL to `to`. The
    // app-key file still exists (deleteAppKey runs only after a completed flip).
    const appKey =
      from === "app-key" || to === "app-key"
        ? this.ensureAppKey()
        : this.readAppKey();
    crypto.configure({ mode: from, appKey, masterKey });

    const result = this.reencryptAll(to);
    if (!result.ok) return { status: "failed", failures: result.failures };

    // Flip the mode LAST (drops the marker) and reconfigure the live backend.
    if (to === "master-password") {
      this.writeConfig({
        mode: to,
        kdf: config.kdf,
        verifier: config.verifier,
      });
      crypto.configure({ mode: to, appKey: null, masterKey });
    } else if (to === "app-key") {
      this.writeConfig({ mode: to });
      crypto.configure({
        mode: to,
        appKey: this.readAppKey(),
        masterKey: null,
      });
    } else {
      this.writeConfig({ mode: to });
      crypto.configure({ mode: to, appKey: null, masterKey: null });
    }
    if (to !== "app-key") this.deleteAppKey();
    return { status: "resumed", from, to };
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
   * Infer the mode for an install with no config file. The config records which
   * backend the at-rest ciphertext was sealed with; if it is lost we must NOT
   * guess a mode that orphans that ciphertext. The unrecoverable case is
   * master-password data (`encm:`): defaulting to app-key would mint a fresh
   * random key, and because the user would never be prompted to enter the
   * passphrase the GCM-sealed secrets could never be unlocked again. So probe
   * every managed ciphertext family in recovery-priority order —
   * master-password first (it alone is unrecoverable if mis-inferred; inferring
   * it merely starts the session locked and prompts to unlock), then
   * os-keychain (`enc:v1:`), then app-key (`enck:`) — and fall back to the
   * no-prompt default ONLY when no managed ciphertext exists at all. Pure
   * string-prefix checks: never calls decryptString, so this never triggers a
   * keychain prompt.
   */
  _inferMode() {
    const startsWith = (prefix) => (value) =>
      typeof value === "string" && value.startsWith(prefix);

    if (this._anyCiphertext(startsWith("encm:"))) return "master-password";
    if (this._anyCiphertext(startsWith("enc:v1:"))) return "os-keychain";
    if (this._anyCiphertext(startsWith("enck:"))) return "app-key";
    return defaultModeFor(process.platform, crypto.isAvailable());
  }

  /**
   * Whether ANY at-rest secret value across the live stores satisfies `isHit`.
   * Scans manifest settings, environments, and each collection's metadata / tree
   * / request files cheap→expensive, short-circuiting on the first hit. Called
   * once per ciphertext family on the rare no-config path (so a file may be read
   * a few times there); never on the warm path.
   *
   * @param {(value: string) => boolean} isHit
   */
  _anyCiphertext(isHit) {
    // 1) Manifest settings (read first at startup anyway).
    const manifest = io.readJSON(this._paths.manifestPath());
    if (this._settingsHasSealedSecret(manifest?.settings, isHit)) return true;
    // 2) Environments (global + per-env variables).
    const envs = io.readJSON(this._paths.environmentsPath());
    if (this._envsHaveSealedSecret(envs, isHit)) return true;
    // 3) Per-collection metadata + tree + request files.
    for (const collId of this._listCollectionIds()) {
      const meta = io.readJSON(this._paths.metadataPath(collId));
      if (this._varsHaveSealedSecret(meta?.variables, isHit)) return true;
      const tree = io.readJSON(this._paths.treePath(collId));
      if (this._treeHasSealedSecret(tree?.children, isHit)) return true;
      for (const reqId of this._listRequestIds(collId)) {
        const req = io.readJSON(this._paths.requestPath(collId, reqId));
        if (this._requestHasSealedSecret(req, isHit)) return true;
      }
    }
    return false;
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
   *      every value readable and re-running converts the stragglers (idempotent).
   *
   * The caller (set-mode) brackets this with markMigration() before and the mode
   * flip after — so a crash between the two is auto-finished on the next launch
   * by resumeMigration() (driven from bootstrap / the unlock handler), not left
   * for the user to re-run by hand. The mode flip is the atomicity anchor.
   *
   * @param {string} targetBackend  "app-key" | "os-keychain" | "master-password"
   * @returns {{ ok: boolean, failures: Array<{file:string, reason:string}> }}
   */
  reencryptAll(targetBackend) {
    const files = this._secretFiles();

    // Pass 1 — validate decryptability under the current backend. Cache each
    // parsed doc: validation only reads, so pass 2 can reuse it instead of
    // re-reading every file off disk.
    const failures = [];
    const docs = new Map(); // f.path → parsed doc (unchanged by validation)
    for (const f of files) {
      const doc = io.readJSON(f.path);
      if (!doc) continue;
      docs.set(f.path, doc);
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
    // reencryptValue calls won't throw.) Skip the write when the transform
    // changed nothing: files with no secrets (or an idempotent no-op) serialize
    // identically, while re-sealing a real secret always changes its ciphertext,
    // so any file that actually holds secrets is still rewritten.
    for (const f of files) {
      const doc = docs.get(f.path);
      if (!doc) continue;
      const next = f.transform(doc, (v) =>
        crypto.reencryptValue(v, targetBackend),
      );
      if (JSON.stringify(next) === JSON.stringify(doc)) continue;
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

  // ── Inference probes (string-prefix only; predicate-driven per family) ─────

  _settingsHasSealedSecret(settings, isHit) {
    if (!settings || typeof settings !== "object") return false;
    return collectSettings(settings).some(isHit);
  }
  _envsHaveSealedSecret(envs, isHit) {
    return collectEnvironments(envs ?? {}).some(isHit);
  }
  _varsHaveSealedSecret(vars, isHit) {
    return collectVariables(vars).some(isHit);
  }
  _treeHasSealedSecret(children, isHit) {
    return collectTree(children).some(isHit);
  }
  _requestHasSealedSecret(req, isHit) {
    if (!req || typeof req !== "object") return false;
    return collectRequest(req).some(isHit);
  }
}

// ── Pure shape helpers (collect every secret value / map a fn over them) ──────
//
// `collect` returns the secret values for the validate pass; `map` returns a new
// document with `fn` applied to each. They share the same per-shape taxonomy so
// the two passes can never drift.

const { REQUEST_SECRET_PATHS, SETTINGS_SECRET_KEYS, secureNamesOf } = crypto;

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

// A folder's secret profile overrides (`profileValues[pid][name]`) are secrets
// exactly when `name` is `secure` in the folder's own variables. Only those
// values are collected / mapped — mirroring collectVariables / mapVariables, with
// `secureNames` derived from the sibling variable list (secure/name are plaintext
// even on the raw-on-disk node, so this holds pre-decrypt).
function collectProfileValues(profileValues, secureNames) {
  if (!profileValues || typeof profileValues !== "object") return [];
  const out = [];
  for (const map of Object.values(profileValues)) {
    if (!map || typeof map !== "object") continue;
    for (const [name, value] of Object.entries(map)) {
      if (secureNames.has(name)) out.push(value);
    }
  }
  return out;
}

function mapProfileValues(profileValues, fn, secureNames) {
  if (!profileValues || typeof profileValues !== "object") return profileValues;
  const out = {};
  for (const [pid, map] of Object.entries(profileValues)) {
    if (!map || typeof map !== "object") {
      out[pid] = map;
      continue;
    }
    const conv = {};
    for (const [name, value] of Object.entries(map)) {
      conv[name] = secureNames.has(name) ? fn(value) : value;
    }
    out[pid] = conv;
  }
  return out;
}

// Tree folder nodes carry `variables` + `profileValues` secrets; recurse children.
function collectTree(nodes) {
  const out = [];
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!node || typeof node !== "object") continue;
    out.push(...collectVariables(node.variables));
    out.push(
      ...collectProfileValues(
        node.profileValues,
        secureNamesOf(node.variables),
      ),
    );
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
      ...(node.profileValues !== undefined
        ? {
            profileValues: mapProfileValues(
              node.profileValues,
              fn,
              secureNamesOf(node.variables),
            ),
          }
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

module.exports = {
  SecretStorage,
  MODES,
  DEFAULT_MODE,
  defaultModeFor,
  AppKeyCorruptError,
};
