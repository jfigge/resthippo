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

// cli-launcher.js — install/remove a `hippo` shell command so users can launch
// Rest Hippo from a terminal (the equivalent of VS Code's "Install 'code'
// command in PATH"). The mechanism is platform-specific:
//
//   • macOS  — write a tiny /bin/sh launcher that runs `open -b <bundleId>`, so
//              it survives the app being moved and reuses the running instance.
//   • Linux  — write a /bin/sh launcher that execs the real binary (APPIMAGE for
//              AppImage builds, whose execPath is a throwaway mount point).
//   • Windows— write a hippo.cmd shim and add its directory to the per-user PATH
//              (HKCU\Environment) via PowerShell, which broadcasts the change so
//              new shells pick it up.
//
// On macOS/Linux the shim goes in /usr/local/bin when that is writable (so it is
// already on PATH), otherwise ~/.local/bin (reported back so the UI can tell the
// user to add it to PATH if necessary).
//
// Everything is gated on app.isPackaged: in a dev run process.execPath is the
// Electron binary and no bundle is registered, so a shim would launch the wrong
// thing — install() refuses and status() reports `available: false`.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { app } = require("electron");
const { execFile } = require("child_process");

// The command users type. Also the shim filename (plus `.cmd` on Windows).
const COMMAND_NAME = "hippo";

// macOS bundle identifier — keep in lockstep with build.appId in package.json.
const BUNDLE_ID = "com.resthippo.app";

const USR_LOCAL_BIN = "/usr/local/bin";

/**
 * The on-disk executable the shim should launch. For an AppImage the mounted
 * process.execPath is a temporary path that vanishes on exit; the APPIMAGE env
 * var holds the real, stable image location.
 * @returns {string}
 */
function appExecutable() {
  return process.env.APPIMAGE || process.execPath;
}

/** Whether `dir` exists and is writable by the current user. */
function isWritableDir(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Whether `dir` is one of the entries in the current PATH. */
function isOnPath(dir) {
  const parts = (process.env.PATH || "").split(path.delimiter);
  return parts.includes(dir);
}

// ── macOS / Linux ────────────────────────────────────────────────────────────

/** The two locations a Unix shim may live, in preference order. */
function unixShimCandidates() {
  return [
    path.join(USR_LOCAL_BIN, COMMAND_NAME),
    path.join(os.homedir(), ".local", "bin", COMMAND_NAME),
  ];
}

/** Where a fresh Unix install should write the shim. */
function unixTargetDir() {
  if (isWritableDir(USR_LOCAL_BIN)) return { dir: USR_LOCAL_BIN, onPath: true };
  const local = path.join(os.homedir(), ".local", "bin");
  return { dir: local, onPath: isOnPath(local) };
}

/** Single-quote a string for safe embedding in a /bin/sh script. */
function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/** The /bin/sh launcher contents for the current platform. */
function unixScript() {
  const header =
    "#!/bin/sh\n" +
    "# Rest Hippo command-line launcher (managed by Rest Hippo — safe to delete)\n";
  if (process.platform === "darwin")
    return `${header}exec open -b ${BUNDLE_ID} --args "$@"\n`;
  return `${header}exec ${shQuote(appExecutable())} "$@"\n`;
}

function installUnix() {
  const { dir, onPath } = unixTargetDir();
  const shim = path.join(dir, COMMAND_NAME);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(shim, unixScript(), { mode: 0o755 });
    fs.chmodSync(shim, 0o755); // ensure the exec bit even if the file pre-existed
    return { ok: true, path: shim, onPath };
  } catch (err) {
    const reason = err && err.code === "EACCES" ? "permission" : "error";
    return { ok: false, reason, path: shim, message: err && err.message };
  }
}

function uninstallUnix() {
  let removed = false;
  for (const shim of unixShimCandidates()) {
    try {
      if (fs.existsSync(shim)) {
        fs.unlinkSync(shim);
        removed = true;
      }
    } catch (err) {
      const reason = err && err.code === "EACCES" ? "permission" : "error";
      return { ok: false, reason, message: err && err.message };
    }
  }
  return { ok: true, removed };
}

// ── Windows ──────────────────────────────────────────────────────────────────

/** The per-user directory holding the hippo.cmd shim (stable across updates). */
function winBinDir() {
  return path.join(app.getPath("userData"), "bin");
}

function winShimPath() {
  return path.join(winBinDir(), `${COMMAND_NAME}.cmd`);
}

/** Single-quote a string for safe embedding in a PowerShell -Command script. */
function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/** Run a PowerShell script, resolving true on exit code 0 and false otherwise. */
function runPowerShell(script) {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
      ],
      (err) => resolve(!err),
    );
  });
}

/** Add `dir` to the per-user PATH if absent; resolves whether it is now present. */
function winAddToUserPath(dir) {
  const script = `
    $d = ${psQuote(dir)}
    $p = [Environment]::GetEnvironmentVariable('Path','User')
    if ($null -eq $p) { $p = '' }
    $parts = $p -split ';' | Where-Object { $_ -ne '' }
    if ($parts -notcontains $d) {
      [Environment]::SetEnvironmentVariable('Path', ((@($parts) + $d) -join ';'), 'User')
    }`;
  return runPowerShell(script);
}

/** Remove `dir` from the per-user PATH. */
function winRemoveFromUserPath(dir) {
  const script = `
    $d = ${psQuote(dir)}
    $p = [Environment]::GetEnvironmentVariable('Path','User')
    if ($null -ne $p) {
      $parts = $p -split ';' | Where-Object { $_ -ne '' -and $_ -ne $d }
      [Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')
    }`;
  return runPowerShell(script);
}

async function installWindows() {
  const dir = winBinDir();
  const shim = winShimPath();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const content = `@echo off\r\nstart "" "${appExecutable()}" %*\r\n`;
    fs.writeFileSync(shim, content);
  } catch (err) {
    const reason = err && err.code === "EACCES" ? "permission" : "error";
    return { ok: false, reason, path: shim, message: err && err.message };
  }
  const onPath = await winAddToUserPath(dir);
  return { ok: true, path: shim, onPath };
}

async function uninstallWindows() {
  const shim = winShimPath();
  try {
    if (fs.existsSync(shim)) fs.unlinkSync(shim);
  } catch (err) {
    return { ok: false, reason: "error", message: err && err.message };
  }
  await winRemoveFromUserPath(winBinDir());
  return { ok: true, removed: true };
}

// ── Public API (called from the cli:* IPC handlers in main.js) ─────────────────

/**
 * Whether the launcher can be installed (packaged build on a supported OS) and
 * whether the shim is currently present.
 * @returns {{ available: boolean, installed: boolean, platform: string, target: string|null }}
 */
function status() {
  const platform = process.platform;
  const supported =
    platform === "darwin" || platform === "linux" || platform === "win32";
  let installed = false;
  let target = null;
  try {
    if (platform === "win32") {
      installed = fs.existsSync(winShimPath());
      target = winShimPath();
    } else if (supported) {
      installed = unixShimCandidates().some((p) => fs.existsSync(p));
      target = path.join(unixTargetDir().dir, COMMAND_NAME);
    }
  } catch {
    /* treat any probe failure as "not installed" */
  }
  return {
    available: supported && app.isPackaged,
    installed,
    platform,
    target,
  };
}

/**
 * Create the shim so `hippo` launches Rest Hippo from a terminal.
 * @returns {Promise<{ ok: boolean, reason?: string, path?: string, onPath?: boolean, message?: string }>}
 */
async function install() {
  if (!app.isPackaged) return { ok: false, reason: "dev" };
  if (process.platform === "win32") return installWindows();
  if (process.platform === "darwin" || process.platform === "linux")
    return installUnix();
  return { ok: false, reason: "unsupported" };
}

/**
 * Remove the shim previously created by install().
 * @returns {Promise<{ ok: boolean, reason?: string, removed?: boolean, message?: string }>}
 */
async function uninstall() {
  if (process.platform === "win32") return uninstallWindows();
  if (process.platform === "darwin" || process.platform === "linux")
    return uninstallUnix();
  return { ok: false, reason: "unsupported" };
}

module.exports = { status, install, uninstall };
