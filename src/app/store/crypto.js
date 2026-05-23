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
} catch { /* not running inside Electron */ }

const PREFIX = "enc:v1:";

/** Returns true when OS-level encryption is available and functional. */
function isAvailable() {
  return _safeStorage !== null && _safeStorage.isEncryptionAvailable();
}

/** Returns true when `value` was produced by encryptString(). */
function isEncrypted(value) {
  return typeof value === "string" && value.startsWith(PREFIX);
}

/**
 * Encrypt a plaintext secret using the OS keystore.
 * Returns `plaintext` unchanged when encryption is unavailable or the value is
 * already encrypted (idempotent).
 *
 * @param {string} plaintext
 * @returns {string}
 */
function encryptString(plaintext) {
  if (!plaintext || !isAvailable() || isEncrypted(plaintext)) return plaintext;
  const buf = _safeStorage.encryptString(plaintext);
  return PREFIX + buf.toString("base64");
}

/**
 * Decrypt a value produced by encryptString().
 * Values without the "enc:v1:" prefix are returned as-is — this allows
 * reading plaintext files written by older versions of the application.
 * Returns the ciphertext as-is if decryption fails (e.g. key changed).
 *
 * @param {string} value
 * @returns {string}
 */
function decryptString(value) {
  if (!isEncrypted(value)) return value;
  if (!isAvailable()) return value;
  const buf = Buffer.from(value.slice(PREFIX.length), "base64");
  try {
    return _safeStorage.decryptString(buf);
  } catch {
    return value;
  }
}

// ── Request-level helpers ─────────────────────────────────────────────────────

/**
 * All secret fields inside a request object, expressed as [parentKey, fieldKey]
 * tuples so the same path list drives both encrypt and decrypt.
 */
const REQUEST_SECRET_PATHS = [
  ["authBasic",  "password"],
  ["authBearer", "token"],
  ["authOAuth2", "clientSecret"],
  ["authOAuth2", "token"],
  ["authOAuth2", "refreshToken"],
  ["authOAuth2", "username"],
  ["authOAuth2", "password"],
  ["authAwsIam", "accessKeyId"],
  ["authAwsIam", "secretAccessKey"],
  ["authAwsIam", "sessionToken"],
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
function encryptRequest(obj) { return _applyToRequest(obj, encryptString); }

/** Decrypt all secret fields in a request object after reading from disk. */
function decryptRequest(obj) { return _applyToRequest(obj, decryptString); }

// ── Settings-level helpers ────────────────────────────────────────────────────

/** Encrypt the proxyUrl field in a settings object before writing to disk. */
function encryptSettings(settings) {
  if (!settings || typeof settings !== "object") return settings;
  const out = { ...settings };
  if (out.proxyUrl !== undefined) out.proxyUrl = encryptString(out.proxyUrl);
  return out;
}

/** Decrypt the proxyUrl field in a settings object after reading from disk. */
function decryptSettings(settings) {
  if (!settings || typeof settings !== "object") return settings;
  const out = { ...settings };
  if (out.proxyUrl !== undefined) out.proxyUrl = decryptString(out.proxyUrl);
  return out;
}

module.exports = {
  isAvailable,
  isEncrypted,
  encryptString,
  decryptString,
  encryptRequest,
  decryptRequest,
  encryptSettings,
  decryptSettings,
};
