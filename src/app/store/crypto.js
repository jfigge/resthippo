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

const PREFIX = "enc:v1:";

/**
 * Tagged error thrown when an encrypted value cannot be turned back into
 * plaintext — either because the OS keystore is unavailable for data that was
 * marked encrypted, or because safeStorage.decryptString() threw (corrupted
 * blob, keystore/profile mismatch, rotated key).
 *
 * It deliberately carries NO secret material — only a machine-readable
 * `reason` — so it is safe to log and to surface to the renderer.
 */
class DecryptError extends Error {
  /** @param {"encryption-unavailable"|"decrypt-failed"} reason */
  constructor(reason) {
    super(`decrypt failed: ${reason}`);
    this.name = "DecryptError";
    this.reason = reason;
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
 *
 * Values without the "enc:v1:" prefix are returned as-is — this allows reading
 * plaintext files written by older versions of the application (happy-path API
 * is unchanged for callers that already succeed).
 *
 * When a value IS marked encrypted but cannot be recovered — the keystore is
 * unavailable, or decryptString() throws — this throws a {@link DecryptError}
 * instead of silently passing the ciphertext (or a blank) through. Callers that
 * want a non-fatal signal catch DecryptError; see decryptRequest /
 * decryptSettings, which collect failures into a `_decryptErrors` marker.
 *
 * @param {string} value
 * @returns {string}
 * @throws {DecryptError} when an encrypted value cannot be decrypted
 */
function decryptString(value) {
  if (!isEncrypted(value)) return value;
  if (!isAvailable()) throw new DecryptError("encryption-unavailable");
  const buf = Buffer.from(value.slice(PREFIX.length), "base64");
  try {
    return _safeStorage.decryptString(buf);
  } catch {
    throw new DecryptError("decrypt-failed");
  }
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
function encryptRequest(obj) {
  const out = _applyToRequest(obj, encryptString);
  // The `_decryptErrors` marker is a read-side artifact (see decryptRequest);
  // it must never be persisted.
  if (out && typeof out === "object" && "_decryptErrors" in out) {
    delete out._decryptErrors;
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

/** Encrypt the proxyUrl field in a settings object before writing to disk. */
function encryptSettings(settings) {
  if (!settings || typeof settings !== "object") return settings;
  const out = { ...settings };
  if (out.proxyUrl !== undefined) out.proxyUrl = encryptString(out.proxyUrl);
  // The `_decryptErrors` marker is a read-side artifact; never persist it.
  if ("_decryptErrors" in out) delete out._decryptErrors;
  return out;
}

/**
 * Decrypt the proxyUrl field in a settings object after reading from disk.
 *
 * Mirrors decryptRequest: a proxyUrl that fails to decrypt is blanked and the
 * failure recorded on `_decryptErrors`, with one structured warning logged,
 * rather than passing stale ciphertext through.
 */
function decryptSettings(settings) {
  if (!settings || typeof settings !== "object") return settings;
  const out = { ...settings };
  if (out.proxyUrl !== undefined) {
    try {
      out.proxyUrl = decryptString(out.proxyUrl);
    } catch (err) {
      if (!(err instanceof DecryptError)) throw err;
      out.proxyUrl = "";
      out._decryptErrors = ["proxyUrl"];
      _logDecryptFailure("settings", null, ["proxyUrl"], err.reason);
    }
  }
  return out;
}

/** Blank out the proxyUrl secret field in a settings object. */
function redactSettings(settings) {
  if (!settings || typeof settings !== "object") return settings;
  const out = { ...settings };
  if (out.proxyUrl !== undefined) out.proxyUrl = "";
  return out;
}

module.exports = {
  DecryptError,
  _setSafeStorage,
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
};
