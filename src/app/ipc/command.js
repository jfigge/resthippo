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
 * ipc/command.js — Command request IPC (Feature 70).
 *
 * Runs local command-line programs for the Command request type. The renderer
 * resolves `{{variables}}` per token and hands over the executable, the argument
 * array, the (resolved) Environment-tab rows and stdin; main merges those rows
 * over the Settings → Commands base environment (never the host env), resolves
 * the executable against that PATH and spawns it via net/command-runner.js.
 *
 * Channels:
 *   command:execute         run to completion → HTTP-shaped result
 *   command:cancel          stop a running command (SIGTERM → SIGKILL / taskkill /T)
 *   command:resolve         does an executable resolve on the effective PATH?
 *   command:defaults        the platform-default base environment rows
 *   command:approval:check  is this request's command template approved?
 *   command:approval:grant  approve it (after the user confirmed)
 *
 * Every handler refuses under the Mac App Store sandbox (the renderer hides the
 * feature there too — this is defence in depth).
 */
"use strict";

const crypto = require("crypto");
const { CommandRunner } = require("../net/command-runner");
const { buildProcessEnv, defaultBaseEnv } = require("../net/command-env");
const { CommandApprovals } = require("../store/command-approvals");
const { isMas } = require("../store-build");

const UNAVAILABLE = {
  name: "Unavailable",
  message: "Command requests are not available in this build.",
};

/**
 * Stable hash of a request's UNRESOLVED command template — what the user
 * approves. Covers the command line, the env rows and stdin, so any edit asks
 * again while new variable values do not.
 * @param {{ commandLine?: string, commandEnv?: object[], commandStdin?: string }} t
 */
function templateHash(t = {}) {
  const env = (Array.isArray(t.commandEnv) ? t.commandEnv : [])
    .filter(
      (r) => r && r.enabled !== false && String(r.name ?? r.key ?? "").trim(),
    )
    .map((r) => [String(r.name ?? r.key).trim(), String(r.value ?? "")]);
  const canonical = JSON.stringify([
    String(t.commandLine ?? "").trim(),
    env,
    String(t.commandStdin ?? ""),
  ]);
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/**
 * @param {object} deps
 * @param {Electron.IpcMain} deps.ipcMain
 * @param {Electron.App} deps.app
 * @param {() => object} deps.getStores
 * @param {import("../net/body-spill").SpillRegistry} deps.spillRegistry
 * @param {CommandRunner} [deps.runner]          injectable for tests
 * @param {CommandApprovals} [deps.approvals]    injectable for tests
 * @param {() => boolean} [deps.unavailable]     defaults to isMas
 */
function registerCommandIPC({
  ipcMain,
  app,
  getStores,
  spillRegistry,
  runner,
  approvals,
  unavailable = isMas,
}) {
  const paths = () => getStores().paths();
  const run =
    runner ??
    new CommandRunner({
      spillRegistry,
      cacheDir: () => paths().responseCacheDir(),
    });
  let approvalStore = approvals ?? null;
  const getApprovals = () =>
    (approvalStore ??= new CommandApprovals(paths().commandApprovalsPath()));

  /** The user's base env rows (null → platform defaults). */
  const baseRows = () => {
    try {
      const rows = getStores().collectionStore().getManifest()
        ?.settings?.commandBaseEnv;
      return Array.isArray(rows) ? rows : null;
    } catch {
      return null;
    }
  };

  ipcMain.handle("command:execute", async (event, payload = {}) => {
    if (unavailable()) {
      return { status: 0, kind: "command", error: UNAVAILABLE };
    }
    const { id, requestId, template } = payload;
    if (!getApprovals().isApproved(requestId, templateHash(template))) {
      return {
        status: 0,
        kind: "command",
        error: {
          name: "CommandNotApproved",
          message: "This command has not been approved to run.",
        },
      };
    }
    const env = buildProcessEnv(baseRows(), payload.env);
    return run.run(String(id || crypto.randomUUID()), {
      executable: payload.executable,
      args: Array.isArray(payload.args) ? payload.args : [],
      env,
      stdin: payload.stdin,
      timeoutMs: Number(payload.timeoutMs) || 0,
      outputType: payload.outputType,
      senderId: event.sender?.id,
    });
  });

  ipcMain.handle("command:cancel", (_event, { id } = {}) => {
    if (unavailable()) return { ok: false, reason: "unavailable" };
    return run.cancel(id);
  });

  ipcMain.handle("command:resolve", (_event, { executable, env } = {}) => {
    if (unavailable()) return { found: false, path: null };
    const p = run.resolve(executable, buildProcessEnv(baseRows(), env));
    return { found: !!p, path: p };
  });

  ipcMain.handle("command:defaults", () => {
    if (unavailable()) return { rows: [], platform: process.platform };
    return { rows: defaultBaseEnv(), platform: process.platform };
  });

  ipcMain.handle(
    "command:approval:check",
    (_event, { requestId, template } = {}) => {
      if (unavailable()) return { approved: false };
      return {
        approved: getApprovals().isApproved(requestId, templateHash(template)),
      };
    },
  );

  ipcMain.handle(
    "command:approval:grant",
    (_event, { requestId, template } = {}) => {
      if (unavailable()) return { ok: false, reason: "unavailable" };
      try {
        return { ok: getApprovals().grant(requestId, templateHash(template)) };
      } catch (err) {
        return { ok: false, reason: "error", message: err.message };
      }
    },
  );

  // ── Lifecycle cleanup — never leave a process running past its renderer ────
  app.on("web-contents-created", (_e, contents) => {
    const drop = () => run.cancelForSender(contents.id);
    contents.on("did-navigate", drop);
    contents.on("render-process-gone", drop);
    contents.on("destroyed", drop);
  });
  app.on("before-quit", () => run.cancelAll());
}

module.exports = { registerCommandIPC, templateHash };
