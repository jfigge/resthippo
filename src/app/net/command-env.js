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
 * net/command-env.js — the process environment for Command requests
 * (Feature 70).
 *
 * The host `process.env` is NEVER inherited. A command's environment is built
 * from exactly two sources, both visible to the user:
 *
 *   1. the base environment from Settings → Commands (`settings.commandBaseEnv`,
 *      `null` = these platform defaults), and
 *   2. the request's own Environment tab rows, which override the base.
 *
 * The platform defaults read a handful of OS locations (home, Windows system
 * folders) once, to *prefill* the editable list — they are shown in Settings so
 * nothing is passed that the user can't see.
 */
"use strict";

const os = require("os");
const nodePath = require("path");
const { DEFAULT_PATHEXT } = require("./command-resolve");

/** Default PATH per platform (macOS lists Homebrew on both architectures). */
function defaultPath(platform, systemRoot) {
  if (platform === "darwin") {
    return "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
  }
  if (platform === "win32") {
    const r = systemRoot || "C:\\Windows";
    return [
      `${r}\\System32`,
      r,
      `${r}\\System32\\Wbem`,
      `${r}\\System32\\WindowsPowerShell\\v1.0`,
    ].join(";");
  }
  return "/usr/local/bin:/usr/bin:/bin";
}

/**
 * The platform-default base environment, as editable `[{ key, value, enabled }]`
 * rows (the same shape as a request's Environment tab).
 *
 * @param {object} [opts]
 * @param {string} [opts.platform]  defaults to process.platform
 * @param {string} [opts.home]      defaults to os.homedir()
 * @param {Record<string,string|undefined>} [opts.hostEnv] host env, read ONLY
 *   to prefill Windows system folders (defaults to process.env)
 * @returns {{ key: string, value: string, enabled: boolean }[]}
 */
function defaultBaseEnv({
  platform = process.platform,
  home = os.homedir(),
  hostEnv = process.env,
} = {}) {
  const row = (key, value) => ({
    key,
    value: String(value ?? ""),
    enabled: true,
  });
  if (platform === "win32") {
    const W = nodePath.win32;
    const root = hostEnv.SystemRoot || hostEnv.SYSTEMROOT || "C:\\Windows";
    return [
      row("PATH", defaultPath("win32", root)),
      row("PATHEXT", DEFAULT_PATHEXT),
      row("SystemRoot", root),
      row("USERPROFILE", home),
      row("APPDATA", hostEnv.APPDATA || W.join(home, "AppData", "Roaming")),
      row(
        "LOCALAPPDATA",
        hostEnv.LOCALAPPDATA || W.join(home, "AppData", "Local"),
      ),
      row("TEMP", hostEnv.TEMP || W.join(home, "AppData", "Local", "Temp")),
    ];
  }
  return [row("PATH", defaultPath(platform)), row("HOME", home)];
}

/** True for a usable row: enabled and with a non-blank key. */
function isActiveRow(r) {
  return (
    r && r.enabled !== false && String(r.key ?? r.name ?? "").trim() !== ""
  );
}

/**
 * Merge the base rows and the request rows into a plain env object. Later rows
 * win; request rows are applied after the base. On Windows env names are
 * case-insensitive, so `Path` in a request replaces the base `PATH` (the
 * request's spelling is kept).
 *
 * @param {{key:string,value:string,enabled?:boolean}[]|null|undefined} baseRows
 *   `null`/`undefined` → platform defaults
 * @param {{key:string,value:string,enabled?:boolean}[]} [requestRows]
 * @param {object} [opts]
 * @param {string} [opts.platform]
 * @returns {Record<string,string>}
 */
function buildProcessEnv(baseRows, requestRows = [], opts = {}) {
  const platform = opts.platform ?? process.platform;
  const base = Array.isArray(baseRows)
    ? baseRows
    : defaultBaseEnv({ platform, ...opts });
  const fold = platform === "win32";
  /** normalised key → [actualKey, value] */
  const merged = new Map();
  for (const r of [...base, ...(requestRows || [])]) {
    if (!isActiveRow(r)) continue;
    const key = String(r.key ?? r.name).trim();
    const norm = fold ? key.toUpperCase() : key;
    merged.delete(norm); // re-insert so the winner keeps the later position
    merged.set(norm, [key, String(r.value ?? "")]);
  }
  const env = Object.create(null);
  for (const [key, value] of merged.values()) env[key] = value;
  return { ...env };
}

/** Case-aware env lookup (Windows names are case-insensitive). */
function envGet(env, name, platform = process.platform) {
  if (platform !== "win32") return env[name];
  const want = name.toUpperCase();
  for (const k of Object.keys(env)) if (k.toUpperCase() === want) return env[k];
  return undefined;
}

module.exports = { defaultBaseEnv, defaultPath, buildProcessEnv, envGet };
