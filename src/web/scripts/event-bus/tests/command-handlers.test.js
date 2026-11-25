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
 * command-handlers.test.js — the interactive Execute path for Command requests
 * (Feature 70): result → hippo:response-received (exit code as status, stdout
 * as body, stderr alongside), spawn failure → hippo:request-error with a
 * command hint, the approval dialog for an unapproved template, and in-flight
 * registration so hippo:cancel-request can kill the process.
 */
"use strict";

import { resetDom } from "../../tests/jsdom-setup.js";

import { test } from "node:test";
import assert from "node:assert/strict";

import { installCommandHandlers } from "../command-handlers.js";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function setup({ result, approved = true } = {}) {
  const window = resetDom();
  const calls = { execute: [], grant: [], cancel: [], recents: [] };
  window.hippo = {
    isElectron: true,
    command: {
      execute: async (d) => {
        calls.execute.push(d);
        if (result instanceof Promise) return result;
        return result;
      },
      cancel: async (a) => {
        calls.cancel.push(a);
        return { ok: true };
      },
      approval: {
        check: async () => ({ approved }),
        grant: async (a) => {
          calls.grant.push(a);
          return { ok: true };
        },
      },
    },
  };
  const inFlightExecs = new Set();
  const node = { id: "c1", name: "GNS token", type: "request" };
  installCommandHandlers({
    getSelectedNode: () => node,
    findRequestNode: () => node,
    inFlightExecs,
    bumpRecents: (n) => calls.recents.push(n.id),
    buildHint: () => "",
  });
  const events = [];
  for (const name of ["request-loading", "response-received", "request-error"])
    window.addEventListener(`hippo:${name}`, (e) =>
      events.push({ name, detail: e.detail }),
    );
  const send = () =>
    window.dispatchEvent(
      new window.CustomEvent("hippo:send-command", {
        detail: {
          requestId: "c1",
          descriptor: {
            requestId: "c1",
            executable: "gns",
            args: ["token"],
            env: [],
            stdin: "",
            timeoutMs: 0,
            outputType: "json",
            template: {
              commandLine: "gns token",
              commandEnv: [],
              commandStdin: "",
            },
            commandLine: "gns token",
          },
          variables: [],
        },
      }),
    );
  return { window, calls, events, inFlightExecs, send };
}

test("a finished command becomes a response with exit status + stderr", async () => {
  const { calls, events, send } = setup({
    result: {
      status: 0,
      statusText: "",
      headers: { "content-type": "application/json" },
      body: '{"token":"abc"}',
      stderr: "warn",
      elapsed: 12,
      size: 15,
      consoleLog: [],
      kind: "command",
    },
  });
  send();
  await tick(10);
  assert.equal(calls.execute.length, 1);
  assert.equal(calls.execute[0].executable, "gns");
  assert.deepEqual(calls.recents, ["c1"]);
  const loading = events.find((e) => e.name === "request-loading");
  assert.equal(loading.detail.requestId, "c1");
  const res = events.find((e) => e.name === "response-received");
  assert.equal(res.detail.status, 0);
  assert.equal(res.detail.kind, "command");
  assert.equal(res.detail.body, '{"token":"abc"}');
  assert.equal(res.detail.stderr, "warn");
  assert.equal(res.detail.request.method, "CMD");
  assert.equal(res.detail.request.url, "gns token");
});

test("a missing executable surfaces as a request error with a PATH hint", async () => {
  const { events, send } = setup({
    result: {
      status: 0,
      kind: "command",
      error: { name: "CommandNotFound", message: "not found" },
    },
  });
  send();
  await tick(10);
  const err = events.find((e) => e.name === "request-error");
  assert.equal(err.detail.name, "CommandNotFound");
  assert.match(err.detail.hint, /PATH/);
});

test("an unapproved template asks first; Run approves and executes", async () => {
  const { calls, events, send } = setup({
    approved: false,
    result: { status: 0, body: "", kind: "command" },
  });
  send();
  await tick(10);
  const dlg = document.querySelector(".popup-confirm");
  assert.ok(dlg, "approval dialog shown");
  assert.match(
    dlg.querySelector(".popup-confirm-detail").textContent,
    /gns token/,
  );
  assert.equal(calls.execute.length, 0, "nothing runs before approval");
  dlg.querySelector("[data-action='confirm']").click();
  await tick(10);
  assert.equal(calls.grant.length, 1);
  assert.equal(calls.execute.length, 1);
  assert.ok(events.some((e) => e.name === "response-received"));
});

test("declining the approval never executes", async () => {
  const { calls, events, send } = setup({ approved: false, result: {} });
  send();
  await tick(10);
  document.querySelector(".popup-confirm [data-action='cancel']").click();
  await tick(10);
  assert.equal(calls.execute.length, 0);
  const err = events.find((e) => e.name === "request-error");
  assert.equal(err.detail.name, "CommandNotApproved");
});

test("a running command is registered for cancellation", async () => {
  let finish;
  const { calls, inFlightExecs, send } = setup({
    result: new Promise((r) => {
      finish = r;
    }),
  });
  send();
  await tick(10);
  assert.equal(inFlightExecs.size, 1);
  const exec = [...inFlightExecs][0];
  exec.cancel();
  assert.equal(calls.cancel.length, 1);
  assert.equal(calls.cancel[0].id, calls.execute[0].id);
  finish({ status: 0, kind: "command", error: { name: "AbortError" } });
  await tick(10);
  assert.equal(inFlightExecs.size, 0);
});
