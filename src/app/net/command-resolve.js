/*
 * Copyright 2026 Jason Figge
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This file is part of Rest Hippo.
 *
 * Rest Hippo is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option) any later
 * version.
 *
 * Rest Hippo is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR
 * A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with
 * Rest Hippo. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * net/command-resolve.js — executable lookup + Windows batch-file invocation
 * for Command requests (Feature 70).
 *
 * Commands are spawned directly (`shell: false`) with an environment built only
 * from Rest Hippo's own settings/variables, so the app resolves the executable
 * against *that* PATH itself rather than inheriting the host's lookup.
 *
 * Pure apart from the injected `isExecutable` probe (defaults to an fs check),
 * so every platform's rules are testable on any host.
 */
"use strict";

const fs = require("fs");
const nodePath = require("path");

/** Default Windows executable extensions when PATHEXT is absent. */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/**
 * Default executable probe: a regular file that (on POSIX) carries an execute
 * bit for this process. Windows has no execute bit — existence is enough.
 * @param {string} p
 * @param {string} platform
 */
function defaultIsExecutable(p, platform) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (platform === "win32") return true;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The path flavour (separators, isAbsolute, join) for a platform. */
function pathFor(platform) {
  return platform === "win32" ? nodePath.win32 : nodePath.posix;
}

/** PATH list separator for a platform. */
function pathDelimiter(platform) {
  return platform === "win32" ? ";" : ":";
}

/** True when `name` names a location (has a separator) rather than a bare program. */
function hasSeparator(name, platform) {
  return platform === "win32" ? /[\\/]/.test(name) : name.includes("/");
}

/** Lower-cased PATHEXT entries, each with a leading dot. */
function pathExtList(pathext) {
  return String(pathext || DEFAULT_PATHEXT)
    .split(";")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .map((e) => (e.startsWith(".") ? e : `.${e}`));
}

/**
 * Candidate file names for `base` on Windows: the name as given when it already
 * carries a PATHEXT extension, otherwise `base + ext` for each PATHEXT entry
 * (so `az` finds `az.cmd`). Elsewhere just the name itself.
 */
function candidateNames(base, platform, pathext) {
  if (platform !== "win32") return [base];
  const exts = pathExtList(pathext);
  const ext = nodePath.win32.extname(base).toLowerCase();
  if (ext && exts.includes(ext)) return [base];
  return exts.map((e) => base + e);
}

/**
 * Resolve an executable name to an absolute path.
 *
 * - A name containing a path separator (absolute, or relative to `cwd`) is
 *   checked directly — the PATH is not consulted.
 * - A bare name is searched in each PATH entry, in order.
 * - On Windows a name without a PATHEXT extension tries each extension.
 *
 * @param {string} name
 * @param {object} opts
 * @param {string} [opts.pathValue]  the PATH value (platform list separator)
 * @param {string} [opts.platform]   process.platform flavour
 * @param {string} [opts.pathext]    Windows PATHEXT
 * @param {string} [opts.cwd]        base for relative names with a separator
 * @param {(p: string, platform: string) => boolean} [opts.isExecutable]
 * @returns {string|null} absolute path, or null when not found
 */
function resolveExecutable(
  name,
  {
    pathValue = "",
    platform = process.platform,
    pathext,
    cwd,
    isExecutable = defaultIsExecutable,
  } = {},
) {
  const raw = String(name ?? "").trim();
  if (!raw) return null;
  const P = pathFor(platform);

  if (hasSeparator(raw, platform) || P.isAbsolute(raw)) {
    const base = P.isAbsolute(raw) ? raw : P.resolve(cwd || P.sep, raw);
    for (const cand of candidateNames(base, platform, pathext)) {
      if (isExecutable(cand, platform)) return cand;
    }
    return null;
  }

  const dirs = String(pathValue || "")
    .split(pathDelimiter(platform))
    .map((d) => d.trim().replace(/^"(.*)"$/, "$1")) // Windows allows quoted entries
    .filter(Boolean);
  for (const dir of dirs) {
    for (const cand of candidateNames(raw, platform, pathext)) {
      const full = P.join(dir, cand);
      if (isExecutable(full, platform)) return full;
    }
  }
  return null;
}

/** True for a Windows batch script, which cannot be spawned without cmd.exe. */
function isBatchFile(file) {
  return /\.(cmd|bat)$/i.test(String(file || ""));
}

// cmd.exe metacharacters, escaped with ^ (algorithm after cross-spawn /
// https://qntm.org/cmd).
const CMD_META_RE = /([()\][%!^"`<>&|;, *?])/g;

/** Escape the batch file path for a `cmd /s /c "…"` line. */
function escapeCmdCommand(file) {
  return String(file).replace(CMD_META_RE, "^$1");
}

/**
 * Quote one argument for a `cmd /s /c "…"` line: CRT-style quoting (double any
 * backslashes that precede a quote or the end, escape quotes), wrap in quotes,
 * then ^-escape every cmd metacharacter so `&`, `|`, `%` … reach the script
 * literally instead of being interpreted by cmd.exe.
 */
function escapeCmdArgument(arg) {
  let a = String(arg);
  a = a.replace(/(\\*)"/g, '$1$1\\"');
  a = a.replace(/(\\*)$/, "$1$1");
  a = `"${a}"`;
  return a.replace(CMD_META_RE, "^$1");
}

/**
 * Build the spawn invocation for a Windows `.cmd` / `.bat` file. Node refuses to
 * spawn these with `shell: false` (EINVAL, CVE-2024-27980), so we run them
 * through cmd.exe explicitly — by absolute path, never via the user's PATH —
 * with every argument escaped and `windowsVerbatimArguments` so Node doesn't
 * re-quote the line.
 *
 * @param {string} file       resolved absolute path of the batch file
 * @param {string[]} args
 * @param {string} systemRoot e.g. C:\Windows
 * @returns {{ command: string, args: string[], windowsVerbatimArguments: true }}
 */
function buildBatchInvocation(file, args, systemRoot) {
  const root = systemRoot || "C:\\Windows";
  const cmdExe = nodePath.win32.join(root, "System32", "cmd.exe");
  const line = [escapeCmdCommand(file), ...args.map(escapeCmdArgument)].join(
    " ",
  );
  return {
    command: cmdExe,
    args: ["/d", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

module.exports = {
  DEFAULT_PATHEXT,
  resolveExecutable,
  isBatchFile,
  buildBatchInvocation,
  escapeCmdArgument,
  pathDelimiter,
};
