/**
 * logger.js — Persistent rotating log for the Electron main process.
 *
 * Diagnostics in a packaged app can't live only in stdout/stderr: a user who
 * hits a decrypt failure, a failed backup-restore, or a write error has nothing
 * to attach to a bug report. This module mirrors every main-process `console.*`
 * call (and explicit lifecycle/error events) to a rotating file under the
 * platform user-data directory, while still printing to the original console so
 * `make debug` behaves exactly as before.
 *
 * Design choices that keep it dependency-free and crash-safe:
 *   - A small numbered rotation (`main.log` → `main.1.log` → …) bounds disk use
 *     without an external log library; the newest activity is always in
 *     `main.log`.
 *   - Writes are synchronous `appendFileSync` (O_APPEND). On POSIX a single
 *     append is atomic, so an interleaved write from another process can't tear
 *     a line, and nothing is lost in a buffer when the process is killed.
 *   - Logging never throws. A write failure is reported through the ORIGINAL
 *     console.error captured before install(), so it can't recurse through the
 *     patched console.
 *
 * SECRETS: this logger only persists what `console.*` already prints plus the
 * name/message/stack of Error objects. The main process never console-logs
 * secret values (the verbose request dump with auth headers goes to the
 * renderer's in-memory console array, not stdout), and crypto.js errors are
 * secret-free by construction — so routing console output here introduces no new
 * secret exposure. Do not log raw secret values through it.
 */
"use strict";

const fs = require("fs");
const path = require("path");

/** Severity ordering — a message below the configured threshold is dropped. */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/** Default per-file size cap before rotation (1 MB). */
const DEFAULT_MAX_BYTES = 1024 * 1024;

/** Default number of files retained (`main.log` + DEFAULT_MAX_FILES-1 rotated). */
const DEFAULT_MAX_FILES = 5;

/** Console methods that are teed to the log, mapped to a log level. */
const CONSOLE_LEVEL = {
  log: "info",
  info: "info",
  warn: "warn",
  error: "error",
  debug: "debug",
};

/**
 * Render one argument to a log-friendly string. Errors expand to
 * name/message/stack (never the offending value); objects are JSON-encoded with
 * a circular-reference fallback; everything else stringifies plainly.
 * @param {*} arg
 * @returns {string}
 */
function formatArg(arg) {
  if (arg instanceof Error) {
    return arg.stack
      ? `${arg.name}: ${arg.message}\n${arg.stack}`
      : `${arg.name}: ${arg.message}`;
  }
  if (typeof arg === "string") return arg;
  if (arg === undefined) return "undefined";
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

/**
 * Create a logger writing to `dir`. The directory is created lazily on first
 * write so constructing a logger is side-effect-free (and safe in tests).
 *
 * @param {object} opts
 * @param {string} opts.dir            Directory the log files live in.
 * @param {string} [opts.fileName]     Current log file name (default "main.log").
 * @param {number} [opts.maxBytes]     Size cap per file before rotation.
 * @param {number} [opts.maxFiles]     Total files retained (current + rotated).
 * @param {keyof LEVELS} [opts.level]  Minimum level written (default "info").
 * @returns {{
 *   debug: Function, info: Function, warn: Function, error: Function,
 *   install: Function, uninstall: Function,
 *   dir: () => string, currentPath: () => string,
 *   listFiles: () => string[], readFiles: () => Array<{name:string,content:string}>,
 * }}
 */
function createLogger({
  dir,
  fileName = "main.log",
  maxBytes = DEFAULT_MAX_BYTES,
  maxFiles = DEFAULT_MAX_FILES,
  level = "info",
} = {}) {
  const ext = path.extname(fileName); // ".log"
  const stem = path.basename(fileName, ext); // "main"
  const minLevel = LEVELS[level] ?? LEVELS.info;

  // Original console methods, captured at install() so internal error reporting
  // never recurses through the patched console. Seeded with the real one so a
  // pre-install write failure still surfaces somewhere.
  let origConsole = { error: console.error };
  let installed = false;
  let originals = null;

  /** Absolute path of the live (current) log file. */
  function currentPath() {
    return path.join(dir, fileName);
  }

  /** Absolute path of rotated file N (1 = most recently rotated). */
  function rotatedPath(n) {
    return path.join(dir, `${stem}.${n}${ext}`);
  }

  /**
   * Shift the rotation chain so the current file can start fresh:
   * drop the oldest, then `main.(n-1).log → main.n.log`, then `main.log →
   * main.1.log`. Best-effort: a rename/unlink failure leaves the chain intact
   * and the next append simply grows the current file past the cap.
   */
  function rotate() {
    try {
      fs.rmSync(rotatedPath(maxFiles - 1), { force: true });
    } catch {
      /* nothing to drop */
    }
    for (let n = maxFiles - 1; n >= 2; n--) {
      try {
        fs.renameSync(rotatedPath(n - 1), rotatedPath(n));
      } catch {
        /* that slot was empty */
      }
    }
    try {
      fs.renameSync(currentPath(), rotatedPath(1));
    } catch {
      /* current file may not exist yet */
    }
  }

  /**
   * Core writer. Formats the line, rotates if it would overflow the current
   * file, and appends. Never throws.
   * @param {keyof LEVELS} levelName
   * @param {string} scope  short tag, e.g. "console" | "uncaughtException"
   * @param {*[]} parts     message parts (joined with spaces)
   */
  function write(levelName, scope, parts) {
    if ((LEVELS[levelName] ?? 0) < minLevel) return;
    const message = parts.map(formatArg).join(" ");
    const line = `${new Date().toISOString()} [${levelName}]${
      scope ? ` [${scope}]` : ""
    } ${message}\n`;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const full = currentPath();
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {
        size = 0; // file does not exist yet
      }
      // Rotate when a non-empty file would exceed the cap; a single line larger
      // than the cap is still written (to its own fresh file) rather than lost.
      if (size > 0 && size + Buffer.byteLength(line) > maxBytes) {
        rotate();
      }
      fs.appendFileSync(full, line);
    } catch (err) {
      origConsole.error("[logger] write failed:", err && err.message);
    }
  }

  /**
   * Tee `console.*` to the log while preserving the original output, so every
   * existing main-process diagnostic line is persisted with no call-site
   * changes. Idempotent. The original is always called first so stdout/stderr
   * ordering is unchanged even if the file write fails.
   */
  function install() {
    if (installed) return;
    originals = {};
    for (const name of Object.keys(CONSOLE_LEVEL)) {
      // Store the raw reference (Node's console methods are pre-bound, so they
      // are safe to call detached) so uninstall() restores exact identity.
      originals[name] =
        typeof console[name] === "function" ? console[name] : () => {};
    }
    origConsole = originals;
    for (const [name, lvl] of Object.entries(CONSOLE_LEVEL)) {
      console[name] = (...args) => {
        try {
          originals[name](...args);
        } finally {
          write(lvl, "console", args);
        }
      };
    }
    installed = true;
  }

  /** Restore the original console methods. */
  function uninstall() {
    if (!installed || !originals) return;
    for (const name of Object.keys(CONSOLE_LEVEL)) {
      console[name] = originals[name];
    }
    installed = false;
  }

  /**
   * The existing log files in rotation order (current first, then oldest last):
   * [main.log, main.1.log, …]. Missing slots are skipped.
   * @returns {string[]}
   */
  function listFiles() {
    const out = [];
    if (fs.existsSync(currentPath())) out.push(currentPath());
    for (let n = 1; n <= maxFiles - 1; n++) {
      if (fs.existsSync(rotatedPath(n))) out.push(rotatedPath(n));
    }
    return out;
  }

  /**
   * Read every log file for a diagnostics bundle, oldest first so the bundle
   * reads top-to-bottom in chronological order. An unreadable file contributes
   * an empty string rather than aborting the bundle.
   * @returns {Array<{ name: string, content: string }>}
   */
  function readFiles() {
    return listFiles()
      .reverse()
      .map((p) => {
        let content = "";
        try {
          content = fs.readFileSync(p, "utf8");
        } catch {
          content = "";
        }
        return { name: path.basename(p), content };
      });
  }

  return {
    debug: (scope, ...parts) => write("debug", scope, parts),
    info: (scope, ...parts) => write("info", scope, parts),
    warn: (scope, ...parts) => write("warn", scope, parts),
    error: (scope, ...parts) => write("error", scope, parts),
    install,
    uninstall,
    dir: () => dir,
    currentPath,
    listFiles,
    readFiles,
  };
}

module.exports = { createLogger, formatArg, LEVELS };
