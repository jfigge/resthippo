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

// ── Temp-file naming & in-flight tracking ──────────────────────────────────────

/**
 * Distinctive infix marking write temp files. Real data files never contain it,
 * so the startup GC can match orphans with no risk of deleting real documents.
 */
const TEMP_INFIX = ".wurltmp-";

/** Suffix appended after the unique counter. */
const TEMP_SUFFIX = ".tmp";

/** Matches a temp file name produced by {@link tempPathFor}. */
const TEMP_FILE_RE = /\.wurltmp-\d+\.tmp$/;

/** Process-local monotonic counter keeping concurrent temp names unique. */
let tempCounter = 0;

/** Resolved absolute paths of temp files currently mid-write. */
const activeTempPaths = new Set();

/**
 * Build a unique temp path for an atomic write to `filePath`.
 * @param {string} filePath
 * @returns {string}
 */
function tempPathFor(filePath) {
  tempCounter += 1;
  return `${filePath}${TEMP_INFIX}${tempCounter}${TEMP_SUFFIX}`;
}

/**
 * Build a fresh temp-file path inside `dir` for callers that stream their own
 * content (e.g. spilled HTTP responses). The name carries the same `.wurltmp-`
 * infix as atomic writes, so {@link gcOrphanTempFiles} reaps it on the next
 * startup if the owning session exited before cleaning it up.
 * @param {string} dir Directory the temp file should live in.
 * @param {string} [prefix] Leading label for the file name.
 * @returns {string} Absolute (or `dir`-relative) temp path.
 */
function newTempPath(dir, prefix = "spill") {
  tempCounter += 1;
  return path.join(dir, `${prefix}${TEMP_INFIX}${tempCounter}${TEMP_SUFFIX}`);
}

/**
 * @param {string} name A bare file name (not a full path).
 * @returns {boolean} True if `name` is one of our write temp files.
 */
function isTempFileName(name) {
  return TEMP_FILE_RE.test(name);
}

// ── Atomic write ──────────────────────────────────────────────────────────────

/**
 * Atomically write `data` to `filePath` using a temp-then-rename strategy.
 * @param {string} filePath
 * @param {string|Buffer} data
 */
function atomicWrite(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmpPath = tempPathFor(filePath);
  const tmpKey = path.resolve(tmpPath);
  activeTempPaths.add(tmpKey);
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
  } finally {
    activeTempPaths.delete(tmpKey);
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
  const json = JSON.stringify(migrate(obj), null, 2);
  if (typeof json !== "string") {
    throw new Error(`refusing to write non-serializable JSON to ${filePath}`);
  }
  atomicWrite(filePath, json);
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

// ── Filesystem helpers ──────────────────────────────────────────────────────────

/**
 * Best-effort recursive delete of a file or directory.
 *
 * Never throws: a missing path is a no-op (via `force`), and any other failure
 * is swallowed. This matches the delete call sites it replaces, which all treat
 * removal as fire-and-forget cleanup. Callers that must distinguish "did not
 * exist" from "removed" should not use this helper.
 *
 * @param {string} targetPath File or directory to remove.
 */
function remove(targetPath) {
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
  } catch {
    /* best-effort: a failed cleanup is never fatal */
  }
}

/**
 * List a directory's entries, returning `[]` when it is missing or unreadable.
 *
 * `opts` is forwarded verbatim to fs.readdirSync, so `{ withFileTypes: true }`
 * yields Dirent objects exactly as the underlying call would.
 *
 * @param {string} dir
 * @param {object} [opts] Options forwarded to fs.readdirSync.
 * @returns {string[]|import('fs').Dirent[]}
 */
function listDir(dir, opts) {
  try {
    return fs.readdirSync(dir, opts);
  } catch {
    return []; // missing / unreadable dir — nothing to list
  }
}

/**
 * @param {string} targetPath
 * @returns {boolean} True if the path exists.
 */
function exists(targetPath) {
  return fs.existsSync(targetPath);
}

// ── Orphan temp-file GC ─────────────────────────────────────────────────────────

/**
 * Recursively remove orphaned temp files left behind by a crashed write.
 *
 * A file is removed only if its name matches the temp-file pattern, it is older
 * than `maxAgeMs`, and it is not currently in-flight. Real data files never match
 * the pattern, so they are always left untouched. Best-effort: per-file errors
 * are swallowed and the scan continues.
 *
 * @param {string} dir Root directory to scan.
 * @param {object} [opts]
 * @param {number} [opts.maxAgeMs] Minimum age (ms) before an orphan is deleted. Default 5000.
 * @param {number} [opts.now] Reference timestamp (ms). Defaults to Date.now().
 * @returns {string[]} Absolute paths of the files that were removed.
 */
function gcOrphanTempFiles(dir, opts = {}) {
  const maxAgeMs = opts.maxAgeMs ?? 5000;
  const now = opts.now ?? Date.now();
  const removed = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return removed; // missing / unreadable dir — nothing to collect
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      removed.push(...gcOrphanTempFiles(full, { maxAgeMs, now }));
      continue;
    }
    if (!isTempFileName(entry.name)) continue;
    if (activeTempPaths.has(path.resolve(full))) continue;
    try {
      const stat = fs.statSync(full);
      if (now - stat.mtimeMs < maxAgeMs) continue; // too fresh — may be in flight
      fs.unlinkSync(full);
      removed.push(full);
    } catch {
      /* ignore — already gone or racing with a writer */
    }
  }
  return removed;
}

// ── ID validation ─────────────────────────────────────────────────────────────
//
// Tagged errors in this module advertise their kind on `.code` — the project-wide
// error discriminator (see the "Main-process error conventions" note in main.js).

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
  remove,
  listDir,
  exists,
  gcOrphanTempFiles,
  isTempFileName,
  newTempPath,
  validateID,
  newUUID,
  notFoundError,
};
