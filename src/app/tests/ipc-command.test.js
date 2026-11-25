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
 * ipc-command.test.js — the command:* IPC handlers (Feature 70): execution is
 * refused until the template is approved, approval is keyed by the template
 * hash, the base environment comes from settings (never the host env), and
 * every handler refuses under the Mac App Store sandbox.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { registerCommandIPC } = require("../ipc/command.js");
const { CommandApprovals } = require("../store/command-approvals.js");

function setup({ unavailable = false, settings = {} } = {}) {
  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn) };
  const app = { on: () => {} };
  const runs = [];
  const runner = {
    run: async (id, desc) => {
      runs.push({ id, desc });
      return { status: 0, body: "ok", kind: "command" };
    },
    cancel: () => ({ ok: true }),
    resolve: (exe, env) => (exe === "gns" ? `${env.PATH}/gns` : null),
    cancelForSender: () => {},
    cancelAll: () => {},
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hippo-ipc-cmd-"));
  const approvals = new CommandApprovals(path.join(dir, "a.json"));
  registerCommandIPC({
    ipcMain,
    app,
    getStores: () => ({
      collectionStore: () => ({ getManifest: () => ({ settings }) }),
      paths: () => ({ responseCacheDir: () => dir }),
    }),
    runner,
    approvals,
    unavailable: () => unavailable,
  });
  const call = (ch, arg) => handlers.get(ch)({ sender: { id: 1 } }, arg);
  return { call, runs, handlers };
}

const template = { commandLine: "gns token", commandEnv: [], commandStdin: "" };
const desc = {
  id: "x1",
  requestId: "r1",
  executable: "gns",
  args: ["token"],
  env: [{ key: "TOKEN_ENV", value: "1" }],
  template,
};

test("execute is refused until the template is approved", async () => {
  const { call, runs } = setup({
    settings: { commandBaseEnv: [{ key: "PATH", value: "/bin" }] },
  });
  const refused = await call("command:execute", desc);
  assert.equal(refused.error.name, "CommandNotApproved");
  assert.equal(runs.length, 0);

  assert.deepEqual(
    await call("command:approval:check", { requestId: "r1", template }),
    { approved: false },
  );
  await call("command:approval:grant", { requestId: "r1", template });
  assert.deepEqual(
    await call("command:approval:check", { requestId: "r1", template }),
    { approved: true },
  );

  const ok = await call("command:execute", desc);
  assert.equal(ok.status, 0);
  assert.equal(runs.length, 1);
  // Base env from settings + request rows; nothing from the host.
  assert.deepEqual(runs[0].desc.env, { PATH: "/bin", TOKEN_ENV: "1" });
});

test("a changed template needs approval again", async () => {
  const { call } = setup();
  await call("command:approval:grant", { requestId: "r1", template });
  const changed = { ...template, commandLine: "gns token --all" };
  const r = await call("command:execute", { ...desc, template: changed });
  assert.equal(r.error.name, "CommandNotApproved");
});

test("resolve uses the effective PATH (request rows override settings)", async () => {
  const { call } = setup({
    settings: { commandBaseEnv: [{ key: "PATH", value: "/bin" }] },
  });
  assert.deepEqual(
    await call("command:resolve", { executable: "gns", env: [] }),
    {
      found: true,
      path: "/bin/gns",
    },
  );
  assert.deepEqual(
    await call("command:resolve", {
      executable: "gns",
      env: [{ key: "PATH", value: "/opt" }],
    }),
    { found: true, path: "/opt/gns" },
  );
  assert.equal(
    (await call("command:resolve", { executable: "nope", env: [] })).found,
    false,
  );
});

test("defaults returns editable platform rows", async () => {
  const { call } = setup();
  const r = await call("command:defaults");
  assert.ok(r.rows.some((row) => row.key === "PATH"));
});

test("every handler refuses under the Mac App Store sandbox", async () => {
  const { call, runs } = setup({ unavailable: true });
  assert.equal((await call("command:execute", desc)).error.name, "Unavailable");
  assert.equal(
    (await call("command:resolve", { executable: "gns" })).found,
    false,
  );
  assert.equal(
    (await call("command:approval:grant", { requestId: "r1", template })).ok,
    false,
  );
  assert.equal(runs.length, 0);
});
