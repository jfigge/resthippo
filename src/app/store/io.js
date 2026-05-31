/**
 * io.js — Low-level filesystem primitives for the Electron storage layer.
 *
 * All writes use a write-to-tmp-then-rename pattern for atomicity.
 * Path sanitisation helpers prevent directory traversal.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { migrate } = require("./migrations");

// ── Directory helpers ─────────────────────────────────────────────────────────

/**
 * Ensure a directory (and parents) exist.
 * @param {string} dir
 */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// ── Atomic write ──────────────────────────────────────────────────────────────

/**
 * Atomically write `data` to `filePath` using a temp-then-rename strategy.
 * @param {string} filePath
 * @param {string|Buffer} data
 */
function atomicWrite(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmpPath = filePath + "." + randomUUID() + ".tmp";
  try {
    fs.writeFileSync(tmpPath, data, "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

// ── JSON helpers ──────────────────────────────────────────────────────────────

/**
 * Write `obj` as pretty-printed JSON to `filePath`, atomically.
 *
 * Object documents are stamped with the current schema version before writing
 * (see migrations.js); arrays and non-objects are written unchanged.
 * @param {string} filePath
 * @param {*} obj
 */
function writeJSON(filePath, obj) {
  atomicWrite(filePath, JSON.stringify(migrate(obj), null, 2));
}

/**
 * Read and parse JSON from `filePath`.
 *
 * Object documents are run forward through any pending schema migrations and
 * stamped with the current schema version in memory (the upgraded form is
 * persisted lazily on the next save, not eagerly rewritten here).
 * Returns `null` silently if the file does not exist.
 * @param {string} filePath
 * @returns {*}
 */
function readJSON(filePath) {
  try {
    return migrate(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

// ── ID validation ─────────────────────────────────────────────────────────────

/**
 * Forbidden character pattern for storage IDs.
 * Disallows path separators, angle brackets, control characters, etc.
 */
const FORBIDDEN_ID_RE = /[/\\<>:"|?*\x00-\x1f]/;

/**
 * Validate that `id` is safe to use as a filename component.
 * Throws an error (code "INVALID_ID") on failure.
 *
 * @param {string} id
 * @param {string} [label] - context label for error messages
 */
function validateID(id, label = "id") {
  if (!id || typeof id !== "string") {
    const err = new Error(`invalid ${label}: must be a non-empty string`);
    err.code = "INVALID_ID";
    throw err;
  }
  if (id === "." || id === ".." || FORBIDDEN_ID_RE.test(id)) {
    const err = new Error(`invalid ${label}: contains forbidden characters`);
    err.code = "INVALID_ID";
    throw err;
  }
}

// ── UUID ──────────────────────────────────────────────────────────────────────

/** @returns {string} A new UUIDv4 string. */
function newUUID() {
  return randomUUID();
}

// ── Not-found error factory ───────────────────────────────────────────────────

/**
 * Create a "not found" error for the given resource.
 * @param {string} message
 * @returns {Error}
 */
function notFoundError(message) {
  const err = new Error(message);
  err.code = "NOT_FOUND";
  return err;
}

module.exports = {
  ensureDir,
  atomicWrite,
  writeJSON,
  readJSON,
  validateID,
  newUUID,
  notFoundError,
};
