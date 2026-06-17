/**
 * diagnostics.js — Build a self-contained diagnostics bundle for bug reports.
 *
 * The main process owns the persistent log (logger.js); this module turns the
 * app/build/runtime metadata plus the rotated log files into a single plain-text
 * report a user can save from Help → Export Diagnostics and attach to an issue.
 *
 * It is a pure string builder with no Electron / filesystem dependency so it can
 * be unit-tested directly: main.js injects the app info and the already-read log
 * contents. A single .txt (rather than a zip) keeps the export dependency-free
 * and trivially readable; rotated files are concatenated with labelled headers.
 *
 * SECRETS: the report contains only what the logger already holds (see the
 * secrets note in logger.js) and non-sensitive runtime metadata — never secret
 * values. Do not pass secret material in `app`.
 */
"use strict";

/**
 * @param {object} opts
 * @param {Record<string, string|number>} [opts.app]  App / build / runtime metadata.
 * @param {Array<{ name: string, content: string }>} [opts.logs]  Log files, oldest first.
 * @param {string} [opts.generatedAt]  ISO timestamp stamped into the header.
 * @returns {string} The full report text (ends with a trailing newline).
 */
function buildReport({ app = {}, logs = [], generatedAt } = {}) {
  const lines = [];
  lines.push("Rest Hippo diagnostics report");
  lines.push("=======================");
  if (generatedAt) lines.push(`generated: ${generatedAt}`);
  for (const [key, value] of Object.entries(app)) {
    lines.push(`${key}: ${value}`);
  }

  lines.push("");
  lines.push("--- logs ---");
  if (!logs.length) {
    lines.push("(no log files found)");
  } else {
    for (const { name, content } of logs) {
      lines.push("");
      lines.push(`----- ${name} -----`);
      const trimmed =
        typeof content === "string" ? content.replace(/\n+$/, "") : "";
      lines.push(trimmed.length ? trimmed : "(empty)");
    }
  }

  return lines.join("\n") + "\n";
}

module.exports = { buildReport };
