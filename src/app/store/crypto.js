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
 * crypto.js — Encryption helpers for secrets at rest.
 *
 * Uses Electron's safeStorage API so the encryption key lives entirely inside
 * the OS keystore — it never materialises in JavaScript:
 *   - macOS  → Keychain Services
 *   - Windows → DPAPI (Credential Manager)
 *   - Linux  → libsecret / kwallet
 *
 * All encrypt/decrypt calls run in the Electron main process; the renderer only
 * ever sends and receives plaintext values over IPC.
 *
 * Encrypted values are stored as base64 strings prefixed with "enc:v1:" so they
 * are self-identifying.  A value without the prefix is treated as plaintext,
 * enabling transparent migration of existing (unencrypted) installations.
 *
 * When safeStorage is unavailable — test environments, or Linux without a
 * running secret-service daemon — all functions are no-ops that return their
 * input unchanged.
 */
"use strict";

// safeStorage is only present inside an Electron main process.
// Guard against unit-test / Go dev-server environments where Electron is absent.
let _safeStorage = null;
try {
  const electron = require("electron");
  _safeStorage = electron.safeStorage ?? null;
} catch {
  /* not running inside Electron */
}

const nodeCrypto = require("crypto");

// ── At-rest ciphertext families (self-identifying prefixes) ───────────────────
// Each secret value on disk carries a prefix naming the backend that sealed it,
// so decryption can dispatch on the value alone and MIXED prefixes (e.g. during a
// mode-switch migration) all decrypt as long as the needed key is loaded.
//   enc:v1:   OS keystore  (Electron safeStorage — macOS Keychain / DPAPI / libsecret)
//   enck:v1:  app key      (random key in a 0600 file under userData; AES-256-GCM)
//   encm:v1:  master pass   (key derived from a user passphrase; AES-256-GCM; session-cached)
// (The encp:v1/v2: portable/backup family further down is SEPARATE — it is decrypted
//  only via decryptWithPassword(value, password) and never reaches decryptString.)
const PREFIX = "enc:v1:"; // os-keychain (unchanged)
const PREFIX_APPKEY = "enck:v1:";
const PREFIX_MASTER = "encm:v1:";
const AT_REST_PREFIXES = [PREFIX, PREFIX_APPKEY, PREFIX_MASTER];

// AES-256-GCM wire constants, shared by the app-key/master at-rest families and
// the password-based portable family below.
const IV_LEN = 12; // GCM standard nonce length
const TAG_LEN = 16;
const KEY_LEN = 32; // 256-bit key

// ── Active backend — set once at bootstrap via configure() (see stores.js) ─────
// The default "os-keychain" preserves historical behaviour for any caller that
// never calls configure() (e.g. the unit tests, which run in no-op mode).
let _activeMode = "os-keychain";
let _appKey = null; // Buffer(32) when app-key mode is active
let _masterKey = null; // Buffer(32) when a master-password session is unlocked

/**
 * Configure the active at-rest backend and its keys. Called once at startup
 * (the Stores constructor) BEFORE the first decrypt, and again by the
 * mode-switch / unlock IPC. Any omitted field is left unchanged.
 * @param {{mode?:string, appKey?:Buffer|null, masterKey?:Buffer|null}} opts
 */
function configure({ mode, appKey, masterKey } = {}) {
  if (mode !== undefined) _activeMode = mode;
  if (appKey !== undefined) _appKey = appKey;
  if (masterKey !== undefined) _masterKey = masterKey;
}

/** The active at-rest mode: "os-keychain" | "app-key" | "master-password". */
function getMode() {
  return _activeMode;
}

/** Load (or clear, with null) the in-memory master key for the session. */
function setMasterKey(key) {
  _masterKey = key;
}

/** Drop the in-memory master key — secrets become unreadable until re-unlocked. */
function lock() {
  _masterKey = null;
}

/** True when in master-password mode with no key loaded (secrets unreadable). */
function isLocked() {
  return _activeMode === "master-password" && _masterKey === null;
}

/** The at-rest prefix a given backend produces. */
function _prefixFor(backend) {
  switch (backend) {
    case "os-keychain":
      return PREFIX;
    case "app-key":
      return PREFIX_APPKEY;
    case "master-password":
      return PREFIX_MASTER;
    default:
      throw new Error(`unknown secret-storage backend: ${backend}`);
  }
}

/** AES-256-GCM seal → iv(12)|tag(16)|ct (the caller supplies the key). */
function _aesGcmEncrypt(plaintext, key) {
  const iv = nodeCrypto.randomBytes(IV_LEN);
  const cipher = nodeCrypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

/** AES-256-GCM open of an iv|tag|ct blob (throws on a short blob or bad tag). */
function _aesGcmDecrypt(blob, key) {
  if (!Buffer.isBuffer(blob) || blob.length < IV_LEN + TAG_LEN) {
    throw new Error("malformed");
  }
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = blob.subarray(IV_LEN + TAG_LEN);
  const decipher = nodeCrypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString(
    "utf8",
  );
}

/** Derive a 256-bit key from a password + salt (PBKDF2-HMAC-SHA256). */
function deriveKey(password, salt, iterations) {
  return nodeCrypto.pbkdf2Sync(password, salt, iterations, KEY_LEN, "sha256");
}

/**
 * Tagged error thrown when an encrypted value cannot be turned back into
 * plaintext — either because the OS keystore is unavailable for data that was
 * marked encrypted, because safeStorage.decryptString() threw (corrupted
 * blob, keystore/profile mismatch, rotated key), or because a master-password
 * session is locked ("locked").
 *
 * It deliberately carries NO secret material — only a machine-readable code —
 * so it is safe to log and to surface to the renderer.
 *
 * `.code` is the project-wide error discriminator (see io.js / backup.js and the
 * "Main-process error conventions" note in main.js). `.reason` is a retained
 * alias holding the same value, kept for back-compat with existing callers, unit
 * tests, and the per-entry `decryptError` marker recorded by decryptVariables.
 */
class DecryptError extends Error {
  /** @param {"encryption-unavailable"|"decrypt-failed"|"locked"} reason */
  constructor(reason) {
    super(`decrypt failed: ${reason}`);
    this.name = "DecryptError";
    this.code = reason;
    this.reason = reason; // back-compat alias for .code
  }
}

/**
 * Test seam: replace the captured safeStorage handle.
 *
 * Production code never calls this — only the unit tests use it to inject a
 * mock so the decrypt-failure branch can be exercised in a plain Node.js
 * environment where Electron (and a real keystore) is absent. Pass `null` to
 * restore the no-op / unavailable state.
 *
 * @param {{isEncryptionAvailable:Function,encryptString:Function,decryptString:Function}|null} mock
 */
function _setSafeStorage(mock) {
  _safeStorage = mock;
}

/** Returns true when OS-level encryption is available and functional. */
function isAvailable() {
  return _safeStorage !== null && _safeStorage.isEncryptionAvailable();
}

/**
 * Returns true when `value` is at-rest ciphertext from ANY keystore backend
 * (os-keychain `enc:`, app-key `enck:`, or master-password `encm:`). Used by the
 * decrypt + anti-clobber paths, so it MUST recognise all three families — a guard
 * that only knew `enc:v1:` would wipe app-key / master-password secrets on save.
 * (The portable `encp:` family is deliberately NOT included here.)
 */
function isEncrypted(value) {
  return (
    typeof value === "string" &&
    AT_REST_PREFIXES.some((p) => value.startsWith(p))
  );
}

/**
 * Encrypt a plaintext secret using the OS keystore.
 * Returns `plaintext` unchanged when encryption is unavailable or the value is
 * already encrypted (idempotent).
 *
 * @param {string} plaintext
 * @returns {string}
 */
let _warnedUnavailable = false;

/**
 * Seal an already-plaintext value under an EXPLICIT backend (no prefix-detection
 * / decrypt-first — callers pass plaintext). The single sealing chokepoint shared
 * by encryptString (active mode) and reencryptValue (migration target).
 * @param {string} plain
 * @param {string} backend
 * @returns {string}
 */
function _rawEncryptTo(plain, backend) {
  switch (backend) {
    case "os-keychain": {
      if (!isAvailable()) {
        // SECURITY: keystore unavailable → this secret is about to be written as
        // cleartext (no prefix). Surface once per process so a silent
        // plaintext-at-rest downgrade doesn't go unnoticed (e.g. Linux without a
        // Secret Service / libsecret provider running).
        if (!_warnedUnavailable) {
          _warnedUnavailable = true;
          console.warn(
            "[crypto] OS keystore unavailable — secrets are being stored UNENCRYPTED " +
              "on disk. On Linux, ensure a Secret Service provider (e.g. gnome-keyring) is running.",
          );
        }
        return plain;
      }
      return PREFIX + _safeStorage.encryptString(plain).toString("base64");
    }
    case "app-key": {
      // The app key is generated at bootstrap whenever app-key mode is active, so
      // a missing key here is a configuration bug, not a normal state.
      if (!_appKey) throw new DecryptError("decrypt-failed");
      return PREFIX_APPKEY + _aesGcmEncrypt(plain, _appKey).toString("base64");
    }
    case "master-password": {
      // A locked session cannot seal new secrets. The renderer disables secret
      // inputs while locked; this throw is the safety valve if one slips through
      // (it fails the write loudly rather than storing plaintext).
      if (!_masterKey) throw new DecryptError("locked");
      return (
        PREFIX_MASTER + _aesGcmEncrypt(plain, _masterKey).toString("base64")
      );
    }
    default:
      throw new Error(`unknown secret-storage backend: ${backend}`);
  }
}

/**
 * Encrypt a plaintext secret under the ACTIVE backend.
 * Returns `plaintext` unchanged when it is empty or already at-rest ciphertext
 * (idempotent — under any backend prefix). Migration must NOT route through this
 * (it short-circuits on a foreign prefix); use {@link reencryptValue} instead.
 *
 * @param {string} plaintext
 * @returns {string}
 */
function encryptString(plaintext) {
  if (!plaintext || isEncrypted(plaintext)) return plaintext;
  return _rawEncryptTo(plaintext, _activeMode);
}

/**
 * Decrypt an at-rest value by DISPATCHING ON ITS PREFIX — so values sealed under
 * any backend decrypt as long as that backend's key is loaded (this is what makes
 * a mixed-prefix mode-switch migration safe).
 *
 * Values with no at-rest prefix are returned as-is (plaintext written by older
 * versions). A value that IS marked encrypted but cannot be recovered throws a
 * {@link DecryptError}: `encryption-unavailable` (keystore absent),
 * `decrypt-failed` (bad blob / app-key missing), or `locked` (master-password
 * session not unlocked). Callers wanting a non-fatal signal catch it; see
 * decryptRequest / decryptSettings / decryptVariables.
 *
 * @param {string} value
 * @returns {string}
 * @throws {DecryptError}
 */
function _decryptAny(value) {
  if (typeof value !== "string") return value;
  if (value.startsWith(PREFIX)) {
    if (!isAvailable()) throw new DecryptError("encryption-unavailable");
    const buf = Buffer.from(value.slice(PREFIX.length), "base64");
    try {
      return _safeStorage.decryptString(buf);
    } catch {
      throw new DecryptError("decrypt-failed");
    }
  }
  if (value.startsWith(PREFIX_APPKEY)) {
    if (!_appKey) throw new DecryptError("decrypt-failed");
    try {
      return _aesGcmDecrypt(
        Buffer.from(value.slice(PREFIX_APPKEY.length), "base64"),
        _appKey,
      );
    } catch {
      throw new DecryptError("decrypt-failed");
    }
  }
  if (value.startsWith(PREFIX_MASTER)) {
    if (!_masterKey) throw new DecryptError("locked");
    try {
      return _aesGcmDecrypt(
        Buffer.from(value.slice(PREFIX_MASTER.length), "base64"),
        _masterKey,
      );
    } catch {
      throw new DecryptError("decrypt-failed");
    }
  }
  return value; // plaintext passthrough
}

// Public name kept for every existing call site.
const decryptString = _decryptAny;

/**
 * Re-encrypt one secret value to a TARGET backend for a mode-switch migration.
 * Decrypts the current value (via prefix dispatch — requires the old backend's
 * key) then seals it under `targetBackend`. Idempotent: a value already under the
 * target prefix is returned unchanged, so a re-run after a crash converts only the
 * stragglers. Plaintext (no prefix) is sealed directly.
 *
 * IMPORTANT: this is the ONLY correct way to migrate — encryptString() would
 * short-circuit on a foreign at-rest prefix and pass the old ciphertext through.
 *
 * @param {string} value
 * @param {string} targetBackend
 * @returns {string}
 * @throws {DecryptError} when the current value cannot be decrypted
 */
function reencryptValue(value, targetBackend) {
  if (!value || typeof value !== "string") return value;
  if (value.startsWith(_prefixFor(targetBackend))) return value; // already converted
  const plain = isEncrypted(value) ? _decryptAny(value) : value;
  if (!plain) return plain;
  return _rawEncryptTo(plain, targetBackend);
}

/**
 * Emit a single structured warning line for a decrypt failure.
 *
 * SECURITY: never includes decrypted secret contents — only the owning object
 * kind, an optional id, the field paths that failed, and the machine reason.
 *
 * @param {string} kind   e.g. "request" | "settings"
 * @param {string|null} id  owning object id, when known
 * @param {string[]} fields  failed field paths (e.g. "authBasic.password")
 * @param {string} reason  DecryptError.reason
 */
function _logDecryptFailure(kind, id, fields, reason) {
  console.warn(
    `[crypto] decrypt failed kind=${kind} id=${id ?? "-"} fields=${fields.join(",")} reason=${reason}`,
  );
}

// ── Request-level helpers ─────────────────────────────────────────────────────

/**
 * All secret fields inside a request object, expressed as [parentKey, fieldKey]
 * tuples so the same path list drives both encrypt and decrypt.
 */
const REQUEST_SECRET_PATHS = [
  ["authBasic", "password"],
  ["authBearer", "token"],
  ["authApiKey", "value"],
  ["authDigest", "password"],
  ["authNtlm", "password"],
  ["authOAuth2", "clientSecret"],
  ["authOAuth2", "token"],
  ["authOAuth2", "refreshToken"],
  ["authOAuth2", "username"],
  ["authOAuth2", "password"],
  ["authOAuth2", "subjectToken"],
  ["authOAuth2", "actorToken"],
  ["authAwsIam", "accessKeyId"],
  ["authAwsIam", "secretAccessKey"],
  ["authAwsIam", "sessionToken"],
  ["authOAuth1", "consumerSecret"],
  ["authOAuth1", "token"],
  ["authOAuth1", "tokenSecret"],
];

function _applyToRequest(obj, fn) {
  if (!obj || typeof obj !== "object") return obj;
  const out = { ...obj };
  for (const [parent, field] of REQUEST_SECRET_PATHS) {
    const sub = out[parent];
    if (sub && typeof sub === "object" && sub[field] !== undefined) {
      out[parent] = { ...sub, [field]: fn(sub[field]) };
    }
  }
  return out;
}

/** Encrypt all secret fields in a request object before writing to disk. */
function encryptRequest(obj) {
  const out = _applyToRequest(obj, encryptString);
  // The `_decryptErrors` / `_decryptReason` markers are read-side artifacts (see
  // decryptRequest); they must never be persisted.
  if (out && typeof out === "object") {
    if ("_decryptErrors" in out) delete out._decryptErrors;
    if ("_decryptReason" in out) delete out._decryptReason;
  }
  return out;
}

/**
 * Decrypt all secret fields in a request object after reading from disk.
 *
 * A field that fails to decrypt is set to "" (so it never surfaces as stale
 * ciphertext) and its path is recorded on an (enumerable, so it survives
 * structured-clone IPC to the renderer) `_decryptErrors` array attached to the
 * returned object. The caller can use that marker to show
 * an inline "couldn't decrypt — re-enter" state and, critically, to avoid
 * clobbering the still-recoverable ciphertext on the next save. A single
 * structured warning is logged per request. The original object is never
 * mutated. Requests with no secrets / no failures are returned unchanged in
 * shape (no marker), keeping the happy path intact.
 */
function decryptRequest(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const out = { ...obj };
  const errors = [];
  let lastReason = null;
  for (const [parent, field] of REQUEST_SECRET_PATHS) {
    const sub = out[parent];
    if (sub && typeof sub === "object" && sub[field] !== undefined) {
      try {
        out[parent] = { ...sub, [field]: decryptString(sub[field]) };
      } catch (err) {
        if (!(err instanceof DecryptError)) throw err;
        out[parent] = { ...sub, [field]: "" };
        errors.push(`${parent}.${field}`);
        lastReason = err.reason;
      }
    }
  }
  if (errors.length) {
    out._decryptErrors = errors;
    // `_decryptReason` lets the renderer tell a locked master-password session
    // ("Unlock to view") apart from a genuine decrypt failure ("re-enter").
    out._decryptReason = lastReason;
    _logDecryptFailure("request", obj.id, errors, lastReason);
  }
  return out;
}

/**
 * Blank out every secret field in a request object.
 *
 * Used when exporting a backup without secrets: secret values are replaced with
 * the empty string regardless of whether they were stored as plaintext or
 * keystore ciphertext, so nothing sensitive can leak out of this machine.
 */
function redactRequest(obj) {
  return _applyToRequest(obj, () => "");
}

// ── Settings-level helpers ────────────────────────────────────────────────────

/**
 * Secret fields inside the settings object. The proxy connection string and its
 * separate credentials are all encrypted at rest (and redacted on export); the
 * one list drives encrypt/decrypt/redact/portable so they never drift.
 */
const SETTINGS_SECRET_KEYS = ["proxyUrl", "proxyUsername", "proxyPassword"];

/**
 * The mTLS client-certificate list (`settings.clientCerts`) is an array of
 * `{ host, format, certPath, keyPath, pfxPath, passphrase }` entries. Only the
 * per-entry `passphrase` is sensitive — the file PATHS are not secrets (the
 * bytes live on disk and are read by the main process at send time). One helper
 * maps a transform over every entry's passphrase so encrypt/redact/portable all
 * stay in lockstep; decrypt needs its own try/catch branch (below) to record
 * failures, so it does not use this.
 *
 * @param {Array} list  settings.clientCerts
 * @param {(v: string) => string} fn
 * @returns {Array}
 */
function _mapClientCertPassphrases(list, fn) {
  if (!Array.isArray(list)) return list;
  return list.map((entry) => {
    if (!entry || typeof entry !== "object" || entry.passphrase === undefined) {
      return entry;
    }
    return { ...entry, passphrase: fn(entry.passphrase) };
  });
}

/** Encrypt every secret settings field before writing to disk. */
function encryptSettings(settings) {
  if (!settings || typeof settings !== "object") return settings;
  const out = { ...settings };
  for (const key of SETTINGS_SECRET_KEYS) {
    if (out[key] !== undefined) out[key] = encryptString(out[key]);
  }
  if (Array.isArray(out.clientCerts)) {
    out.clientCerts = _mapClientCertPassphrases(out.clientCerts, encryptString);
  }
  // The `_decryptErrors` / `_decryptReason` markers are read-side artifacts;
  // never persist them.
  if ("_decryptErrors" in out) delete out._decryptErrors;
  if ("_decryptReason" in out) delete out._decryptReason;
  return out;
}

/**
 * Decrypt every secret settings field after reading from disk.
 *
 * Mirrors decryptRequest: a field that fails to decrypt is blanked and its key
 * recorded on `_decryptErrors`, with one structured warning logged, rather than
 * passing stale ciphertext through.
 */
function decryptSettings(settings) {
  if (!settings || typeof settings !== "object") return settings;
  const out = { ...settings };
  const errors = [];
  let lastReason = null;
  for (const key of SETTINGS_SECRET_KEYS) {
    if (out[key] === undefined) continue;
    try {
      out[key] = decryptString(out[key]);
    } catch (err) {
      if (!(err instanceof DecryptError)) throw err;
      out[key] = "";
      errors.push(key);
      lastReason = err.reason;
    }
  }
  if (Array.isArray(out.clientCerts)) {
    out.clientCerts = out.clientCerts.map((entry, i) => {
      if (
        !entry ||
        typeof entry !== "object" ||
        entry.passphrase === undefined
      ) {
        return entry;
      }
      try {
        return { ...entry, passphrase: decryptString(entry.passphrase) };
      } catch (err) {
        if (!(err instanceof DecryptError)) throw err;
        errors.push(`clientCerts[${i}].passphrase`);
        lastReason = err.reason;
        return { ...entry, passphrase: "" };
      }
    });
  }
  if (errors.length) {
    out._decryptErrors = errors;
    out._decryptReason = lastReason;
    _logDecryptFailure("settings", null, errors, lastReason);
  }
  return out;
}

/**
 * Re-encryption clobber guard for settings secrets (the manifest twin of the
 * request/variable guards).
 *
 * `saveManifest` has no patch model, so an unrelated settings change (e.g. a theme
 * tweak) made while a secret could not be decrypted on read — a locked
 * master-password session, or a transient keystore failure — would re-encrypt the
 * blanked value and destroy the still-recoverable on-disk ciphertext. This
 * restores the on-disk ciphertext for any secret key the caller left blank
 * BECAUSE it failed to decrypt (flagged via `incoming._decryptErrors`) or because
 * the session is currently locked. A blank the user typed intentionally while the
 * secret WAS readable is honoured (it won't be flagged and the session isn't
 * locked).
 *
 * @param {object} encrypted  freshly encrypted settings (from encryptSettings)
 * @param {object} incoming   settings as received from the caller (carries markers)
 * @param {object} existing   current on-disk settings (ciphertext)
 * @returns {object}
 */
function restoreUndecryptableSettings(encrypted, incoming, existing) {
  if (!encrypted || typeof encrypted !== "object") return encrypted;
  if (!existing || typeof existing !== "object") return encrypted;
  const flagged = new Set(
    Array.isArray(incoming?._decryptErrors) ? incoming._decryptErrors : [],
  );
  const locked = isLocked();
  const protect = (key, value) =>
    (value === "" || value == null) && (locked || flagged.has(key));
  const out = { ...encrypted };
  for (const key of SETTINGS_SECRET_KEYS) {
    if (protect(key, incoming?.[key]) && isEncrypted(existing[key])) {
      out[key] = existing[key];
    }
  }
  if (Array.isArray(out.clientCerts) && Array.isArray(existing.clientCerts)) {
    out.clientCerts = out.clientCerts.map((entry, i) => {
      if (!entry || typeof entry !== "object") return entry;
      const inc = Array.isArray(incoming?.clientCerts)
        ? incoming.clientCerts[i]
        : null;
      const ex = existing.clientCerts[i];
      if (
        protect(`clientCerts[${i}].passphrase`, inc?.passphrase) &&
        ex &&
        isEncrypted(ex.passphrase)
      ) {
        return { ...entry, passphrase: ex.passphrase };
      }
      return entry;
    });
  }
  return out;
}

/** Blank out every secret settings field. */
function redactSettings(settings) {
  if (!settings || typeof settings !== "object") return settings;
  const out = { ...settings };
  for (const key of SETTINGS_SECRET_KEYS) {
    if (out[key] !== undefined) out[key] = "";
  }
  if (Array.isArray(out.clientCerts)) {
    out.clientCerts = _mapClientCertPassphrases(out.clientCerts, () => "");
  }
  return out;
}

// ── Variable-list helpers ─────────────────────────────────────────────────────
//
// Variables use the canonical array shape [{ name, value, secure }]. Only the
// value of an entry with `secure: true` is sensitive; non-secure entries pass
// through untouched.
//
// IMPORTANT shape note: requests/settings carry their decrypt-failure marker on
// the container object (`_decryptErrors`). Variables are an ARRAY, and extra
// non-index properties on an array do NOT survive structured-clone IPC or JSON.
// So a per-entry `decryptError` field is recorded on the failing entry object
// instead, which round-trips to the renderer intact.

/** Encrypt the value of every secure variable before writing to disk. */
function encryptVariables(list) {
  if (!Array.isArray(list)) return list;
  return list.map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    const out = { ...entry };
    // The `decryptError` marker is a read-side artifact; never persist it.
    if ("decryptError" in out) delete out.decryptError;
    if (entry.secure) out.value = encryptString(entry.value);
    return out;
  });
}

/**
 * Decrypt the value of every secure variable after reading from disk.
 *
 * Mirrors decryptRequest: a value that fails to decrypt is blanked and the
 * failure recorded on a per-entry `decryptError` field (so it survives
 * structured-clone IPC to the renderer), rather than passing stale ciphertext
 * through. A single structured warning is logged for the whole list. The input
 * is never mutated. A list with no secrets / no failures round-trips unchanged.
 *
 * @param {Array} list   canonical variable array
 * @param {string} [kind] log context, e.g. "globalVariables" | "environment"
 * @param {string|null} [id] owning object id, when known
 */
function decryptVariables(list, kind = "variables", id = null) {
  if (!Array.isArray(list)) return list;
  const failed = [];
  let lastReason = null;
  const out = list.map((entry) => {
    if (!entry || typeof entry !== "object" || !isEncrypted(entry.value)) {
      return entry;
    }
    try {
      return { ...entry, value: decryptString(entry.value) };
    } catch (err) {
      if (!(err instanceof DecryptError)) throw err;
      failed.push(entry.name);
      lastReason = err.reason;
      return { ...entry, value: "", decryptError: err.reason };
    }
  });
  if (failed.length) _logDecryptFailure(kind, id, failed, lastReason);
  return out;
}

/** Blank out the value of every secure variable (export without secrets). */
function redactVariables(list) {
  if (!Array.isArray(list)) return list;
  return list.map((entry) => {
    if (!entry || typeof entry !== "object" || !entry.secure) return entry;
    return { ...entry, value: "" };
  });
}

/**
 * Re-encryption clobber guard for variable lists (the array twin of the request
 * store's anti-clobber logic).
 *
 * When a secure value failed to decrypt on read, decryptVariables blanked it and
 * tagged the entry with `decryptError`. If the renderer saves the list back
 * unchanged, encryptVariables would re-encrypt that blank and destroy the
 * still-recoverable on-disk ciphertext. This restores the original ciphertext
 * for any entry that the caller left blank because it had failed to decrypt and
 * the user did not re-enter — so a transient keystore failure can never wipe a
 * secret.
 *
 * @param {Array} encrypted  freshly encrypted list (from encryptVariables)
 * @param {Array} incoming   the list as received from the caller (carries markers)
 * @param {Array} existing   the current on-disk list (ciphertext)
 * @returns {Array} a new list with recoverable ciphertext restored
 */
function restoreUndecryptableVariables(encrypted, incoming, existing) {
  if (!Array.isArray(encrypted)) return encrypted;
  const incomingByName = new Map();
  for (const e of Array.isArray(incoming) ? incoming : []) {
    if (e && typeof e === "object" && e.name != null) {
      incomingByName.set(e.name, e);
    }
  }
  const existingByName = new Map();
  for (const e of Array.isArray(existing) ? existing : []) {
    if (e && typeof e === "object" && e.name != null) {
      existingByName.set(e.name, e);
    }
  }
  const locked = isLocked();
  return encrypted.map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    const inc = incomingByName.get(entry.name);
    if (!inc) return entry;
    // Guard entries the caller left blank that were either flagged as a failed
    // read OR blanked because a master-password session is currently locked.
    const blank = inc.value === "" || inc.value == null;
    if (!blank || !(inc.decryptError || locked)) return entry;
    const original = existingByName.get(entry.name);
    if (!original || !isEncrypted(original.value)) return entry;
    return { ...entry, value: original.value };
  });
}

// ── Password-based portable encryption (encp:v2:, reads legacy encp:v1:) ──────
//
// The keystore helpers above bind ciphertext to one machine's OS keystore, so an
// "enc:v1:" value cannot be restored elsewhere. For a PORTABLE backup that still
// carries secrets, each value is re-encrypted under a key derived from a user
// password (PBKDF2-HMAC-SHA256) and sealed with AES-256-GCM. Such values are
// tagged "encp:v<n>:" so they are self-identifying and distinct from the keystore
// family.
//
// Wire format (base64 after the prefix):
//   encp:v2:  iterations(4, uint32 BE) | salt(16) | iv(12) | tag(16) | ct
//   encp:v1:  salt(16) | iv(12) | tag(16) | ct                 (legacy, decrypt-only)
//
// Embedding the PBKDF2 iteration count in v2 makes the work factor tunable: the
// cost can be raised over time and every existing backup still decrypts, because
// each blob records the count it was sealed with. v1 blobs (no embedded count)
// predate this and are decrypted at the fixed legacy cost. Each value still
// embeds its own salt + iv, so it is independently decryptable with the password
// alone — no envelope-level state.

const PASSWORD_PREFIX_V1 = "encp:v1:"; // legacy: fixed iteration count, decrypt-only
const PASSWORD_PREFIX_V2 = "encp:v2:"; // current: iteration count embedded in the blob
const PBKDF2_ITERATIONS = 210000; // cost for new blobs (OWASP 2023 floor for PBKDF2-HMAC-SHA256)
const LEGACY_V1_ITERATIONS = 210000; // the fixed cost every encp:v1: blob was sealed with
// Upper bound on a blob's embedded iteration count. The count is read and used to
// derive the key BEFORE the GCM tag can be verified, so an untrusted backup could
// otherwise force an unbounded PBKDF2 run (CPU DoS). This bounds the work.
const MAX_PBKDF2_ITERATIONS = 10_000_000;
const ITER_LEN = 4; // uint32 BE iteration count (v2 only)
const SALT_LEN = 16;
// (nodeCrypto, IV_LEN, TAG_LEN, KEY_LEN and the AES-GCM primitives are defined
//  once at the top of the module and shared with the at-rest families.)

/**
 * Tagged error for password-based decryption failures. Like {@link DecryptError}
 * it carries only a machine-readable code, never secret material, so it is safe
 * to log and surface. `.code` is the canonical discriminator; `.reason` mirrors
 * it for back-compat (see DecryptError above).
 */
class PasswordError extends Error {
  /** @param {"bad-password"|"malformed"} reason */
  constructor(reason) {
    super(`password decrypt failed: ${reason}`);
    this.name = "PasswordError";
    this.code = reason;
    this.reason = reason; // back-compat alias for .code
  }
}

/** Returns true when `value` was produced by encryptWithPassword() (any version). */
function isPasswordEncrypted(value) {
  return (
    typeof value === "string" &&
    (value.startsWith(PASSWORD_PREFIX_V2) ||
      value.startsWith(PASSWORD_PREFIX_V1))
  );
}

/**
 * Encrypt a plaintext secret under a user password (portable, machine-independent).
 *
 * Empty / falsy input is returned unchanged; an already-portable value is returned
 * unchanged (idempotent). Each call derives a fresh key from a random salt.
 *
 * @param {string} plaintext
 * @param {string} password
 * @returns {string} "encp:v2:"-tagged base64 blob
 * @throws {PasswordError} when no password is supplied
 */
function encryptWithPassword(plaintext, password) {
  if (!plaintext) return plaintext;
  if (isPasswordEncrypted(plaintext)) return plaintext;
  if (typeof password !== "string" || password.length === 0) {
    throw new PasswordError("malformed");
  }
  const iterations = PBKDF2_ITERATIONS;
  const salt = nodeCrypto.randomBytes(SALT_LEN);
  const key = deriveKey(password, salt, iterations);
  // _aesGcmEncrypt yields iv|tag|ct — exactly the tail of the v2 wire format.
  const body = _aesGcmEncrypt(plaintext, key);
  // v2 prepends the iteration count so the cost is tunable without breaking
  // already-written backups (each blob decrypts at the count it records).
  const iterBuf = Buffer.alloc(ITER_LEN);
  iterBuf.writeUInt32BE(iterations, 0);
  return (
    PASSWORD_PREFIX_V2 + Buffer.concat([iterBuf, salt, body]).toString("base64")
  );
}

/**
 * Decrypt a value produced by encryptWithPassword().
 *
 * Values without an "encp:v<n>:" prefix are returned unchanged. Both the current
 * v2 format (embedded iteration count) and legacy v1 (fixed count) are accepted.
 * A structurally malformed blob throws PasswordError("malformed"); a wrong
 * password (GCM auth failure) throws PasswordError("bad-password").
 *
 * @param {string} value
 * @param {string} password
 * @returns {string} plaintext
 * @throws {PasswordError}
 */
function decryptWithPassword(value, password) {
  if (!isPasswordEncrypted(value)) return value;
  if (typeof password !== "string" || password.length === 0) {
    throw new PasswordError("bad-password");
  }
  const isV2 = value.startsWith(PASSWORD_PREFIX_V2);
  // Both prefixes are the same length; slice off whichever one matched.
  const prefix = isV2 ? PASSWORD_PREFIX_V2 : PASSWORD_PREFIX_V1;
  const blob = Buffer.from(value.slice(prefix.length), "base64");

  let iterations;
  let offset;
  if (isV2) {
    if (blob.length < ITER_LEN + SALT_LEN + IV_LEN + TAG_LEN) {
      throw new PasswordError("malformed");
    }
    iterations = blob.readUInt32BE(0);
    // The count drives PBKDF2 before the tag is checked, so reject implausible
    // values (untrusted backup) rather than letting them dictate the work.
    if (iterations < 1 || iterations > MAX_PBKDF2_ITERATIONS) {
      throw new PasswordError("malformed");
    }
    offset = ITER_LEN;
  } else {
    if (blob.length < SALT_LEN + IV_LEN + TAG_LEN) {
      throw new PasswordError("malformed");
    }
    iterations = LEGACY_V1_ITERATIONS;
    offset = 0;
  }

  const salt = blob.subarray(offset, offset + SALT_LEN);
  // The remainder is iv|tag|ct — exactly what _aesGcmDecrypt expects.
  const body = blob.subarray(offset + SALT_LEN);
  const key = deriveKey(password, salt, iterations);
  try {
    return _aesGcmDecrypt(body, key);
  } catch {
    throw new PasswordError("bad-password");
  }
}

// ── Portable (password) export / import transforms ────────────────────────────
//
// These bridge the two ciphertext families for a backup. On export a secret is
// taken from its at-rest form — keystore "enc:v1:", or plaintext when the
// keystore was unavailable at write time — to portable "encp:v1:". On import a
// secret is either decrypted back to plaintext (password supplied) or CLEARED to
// "" (no password); clearing keeps the surrounding structure (e.g. a variable's
// `secure` flag) while dropping only the value.

/**
 * Take one at-rest secret to its portable (password-encrypted) form. Keystore
 * ciphertext is decrypted on this machine first. An unrecoverable keystore value
 * (DecryptError) is dropped to "" so a portable backup never carries
 * machine-bound ciphertext that nothing could ever read.
 */
function _toPortable(value, password) {
  if (!value) return value;
  if (isPasswordEncrypted(value)) return value;
  let plain = value;
  if (isEncrypted(value)) {
    try {
      plain = decryptString(value);
    } catch (err) {
      if (err instanceof DecryptError) return "";
      throw err;
    }
  }
  return encryptWithPassword(plain, password);
}

/**
 * Reverse of {@link _toPortable} for import. With a password, portable ciphertext
 * is decrypted to plaintext; without one it is cleared to "". Non-portable values
 * (plaintext) pass through unchanged.
 */
function _fromPortable(value, password) {
  if (!isPasswordEncrypted(value)) return value;
  if (!password) return "";
  return decryptWithPassword(value, password);
}

/** Re-encrypt a request's secret fields under a password for a portable export. */
function exportRequestSecrets(obj, password) {
  return _applyToRequest(obj, (v) => _toPortable(v, password));
}

/** Decrypt (password) or clear (no password) a request's portable secrets on import. */
function importRequestSecrets(obj, password) {
  return _applyToRequest(obj, (v) => _fromPortable(v, password));
}

/** Re-encrypt the settings secret fields under a password for a portable export. */
function exportSettingsSecrets(settings, password) {
  if (!settings || typeof settings !== "object") return settings;
  const out = { ...settings };
  for (const key of SETTINGS_SECRET_KEYS) {
    if (out[key] !== undefined) out[key] = _toPortable(out[key], password);
  }
  if (Array.isArray(out.clientCerts)) {
    out.clientCerts = _mapClientCertPassphrases(out.clientCerts, (v) =>
      _toPortable(v, password),
    );
  }
  return out;
}

/** Decrypt (password) or clear (no password) the settings secret fields on import. */
function importSettingsSecrets(settings, password) {
  if (!settings || typeof settings !== "object") return settings;
  const out = { ...settings };
  for (const key of SETTINGS_SECRET_KEYS) {
    if (out[key] !== undefined) out[key] = _fromPortable(out[key], password);
  }
  if (Array.isArray(out.clientCerts)) {
    out.clientCerts = _mapClientCertPassphrases(out.clientCerts, (v) =>
      _fromPortable(v, password),
    );
  }
  return out;
}

/** Re-encrypt every secure variable's value under a password for a portable export. */
function exportVariableSecrets(list, password) {
  if (!Array.isArray(list)) return list;
  return list.map((entry) => {
    if (!entry || typeof entry !== "object" || !entry.secure) return entry;
    const out = { ...entry, value: _toPortable(entry.value, password) };
    // The `decryptError` marker is a read-side artifact; never let it escape.
    if ("decryptError" in out) delete out.decryptError;
    return out;
  });
}

/**
 * Decrypt (password) or clear (no password) every secure variable's value on
 * import. Without a password the entry keeps `secure: true` but its value is
 * blanked — the secret simply has to be re-entered.
 */
function importVariableSecrets(list, password) {
  if (!Array.isArray(list)) return list;
  return list.map((entry) => {
    if (!entry || typeof entry !== "object" || !entry.secure) return entry;
    return { ...entry, value: _fromPortable(entry.value, password) };
  });
}

module.exports = {
  DecryptError,
  PasswordError,
  // The set of request sub-fields treated as secrets (parent/field pairs). Shared
  // so other modules (e.g. the collection-archive exporter) can detect whether a
  // request carries a secret without re-encoding the taxonomy.
  REQUEST_SECRET_PATHS,
  SETTINGS_SECRET_KEYS,
  _setSafeStorage,
  // Multi-backend configuration + session state (set at bootstrap / by IPC).
  configure,
  getMode,
  setMasterKey,
  lock,
  isLocked,
  // Low-level primitives reused by the secret-storage module (key file, verifier).
  PBKDF2_ITERATIONS,
  deriveKey,
  _aesGcmEncrypt,
  _aesGcmDecrypt,
  // Migration: re-encrypt one value to an explicit target backend (NOT encryptString).
  reencryptValue,
  isPasswordEncrypted,
  encryptWithPassword,
  decryptWithPassword,
  exportRequestSecrets,
  importRequestSecrets,
  exportSettingsSecrets,
  importSettingsSecrets,
  exportVariableSecrets,
  importVariableSecrets,
  isAvailable,
  isEncrypted,
  encryptString,
  decryptString,
  encryptRequest,
  decryptRequest,
  redactRequest,
  encryptSettings,
  decryptSettings,
  redactSettings,
  encryptVariables,
  decryptVariables,
  redactVariables,
  restoreUndecryptableVariables,
  restoreUndecryptableSettings,
};
