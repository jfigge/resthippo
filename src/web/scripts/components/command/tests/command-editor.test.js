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
 * command-editor.test.js — Command requests (Feature 70) in the real
 * RequestEditor (jsdom): the command layout + tabs, command line ⇄ Arguments
 * sync, the red Stop, the executable PATH check, MAS gating, and the
 * `hippo:send-command` descriptor (per-token resolution — a variable with
 * spaces stays ONE argument).
 */

"use strict";

import { resetDom } from "../../../tests/jsdom-setup.js";

import { test } from "node:test";
import assert from "node:assert/strict";

import { RequestEditor } from "../../request-editor.js";
import { EXE_CHECK_DEBOUNCE_MS } from "../command-editor.js";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function mount({ hippo, vars = {} } = {}) {
  const window = resetDom();
  const calls = { resolve: [], grant: [] };
  window.hippo = hippo ?? {
    isElectron: true,
    isMas: false,
    platform: "darwin",
    command: {
      resolve: async (a) => {
        calls.resolve.push(a);
        return a.executable === "gns"
          ? { found: true, path: "/opt/homebrew/bin/gns" }
          : { found: false, path: null };
      },
      defaults: async () => ({ rows: [{ key: "PATH", value: "/bin" }] }),
      approval: {
        grant: async (a) => {
          calls.grant.push(a);
          return { ok: true };
        },
        check: async () => ({ approved: true }),
      },
    },
  };
  const editor = new RequestEditor();
  document.body.appendChild(editor.element);
  editor.setVariableContext({
    environmentVariables: vars,
    globalVariables: {},
    folderChain: [],
  });
  return { window, editor, calls };
}

const cmdNode = (over = {}) => ({
  id: "c1",
  protocol: "command",
  commandLine: "gns token --name 'John Smith'",
  commandEnv: [{ id: "e1", name: "REGION", value: "eu", enabled: true }],
  commandStdin: "",
  commandOutputType: "json",
  ...over,
});

const tabIds = (el) =>
  [...el.querySelectorAll(".req-tab-btn")].map((b) => b.dataset.tab);

test("a command request renders the command layout and tabs", () => {
  const { editor } = mount();
  editor.load(cmdNode());
  const el = editor.element;
  assert.deepEqual(tabIds(el).slice(0, 3), ["args", "env", "stdin"]);
  assert.ok(!tabIds(el).includes("params"));
  const btn = el.querySelector(".req-send-btn");
  assert.equal(btn.dataset.method, "cmd");
  assert.match(btn.textContent, /Execute/);
  assert.ok(el.querySelector(".req-method-select--cmd"));
  // Switching back to HTTP restores the REST layout.
  editor.load({ id: "h1", method: "GET", url: "https://x" });
  assert.ok(tabIds(el).includes("params"));
  assert.equal(el.querySelector(".req-send-btn").dataset.method, "get");
});

test("the Arguments tab mirrors the parsed command line", () => {
  const { editor } = mount();
  editor.load(cmdNode());
  const rows = editor.element.querySelectorAll(
    "#req-tab-args .params-row .cmd-arg-value",
  );
  assert.deepEqual(
    [...rows].map((r) => r.textContent),
    ["token", "--name", "John Smith"],
  );
});

test("deleting an argument rewrites the command line, keeping other quoting", async () => {
  const { window, editor } = mount();
  editor.load(cmdNode({ commandLine: "gns token -v --name 'John Smith'" }));
  const updates = [];
  window.addEventListener("hippo:request-updated", (e) =>
    updates.push(e.detail),
  );
  const rows = editor.element.querySelectorAll("#req-tab-args .params-row");
  // Two-click delete confirm on the 2nd argument ("-v").
  const del = rows[1].querySelector(".params-delete-btn");
  del.click();
  del.click();
  const last = updates.filter((u) => "commandLine" in u).at(-1);
  assert.equal(last?.commandLine, "gns token --name 'John Smith'");
});

test("an unknown executable is highlighted red after the typing pause", async () => {
  const { editor, calls } = mount();
  editor.load(cmdNode({ commandLine: "nosuchtool --x" }));
  await tick(20);
  const input = editor.element.querySelector(".cmd-line-input");
  assert.ok(calls.resolve.length >= 1);
  assert.ok(input.classList.contains("cmd-line-input--unresolved"));
  editor.load(cmdNode());
  await tick(20);
  const input2 = editor.element.querySelector(".cmd-line-input");
  assert.ok(!input2.classList.contains("cmd-line-input--unresolved"));
  assert.ok(EXE_CHECK_DEBOUNCE_MS >= 1000 && EXE_CHECK_DEBOUNCE_MS <= 2000);
});

test("Execute dispatches a per-token resolved descriptor", async () => {
  const { window, editor } = mount({ vars: { who: "Jane Q Public" } });
  editor.load(
    cmdNode({
      commandLine: "gns token --name {{who}}",
      commandEnv: [{ id: "e1", name: "WHO", value: "{{who}}", enabled: true }],
      commandTimeoutMs: 5000,
    }),
  );
  const got = new Promise((resolve) =>
    window.addEventListener("hippo:send-command", (e) => resolve(e.detail)),
  );
  editor.element.querySelector(".req-send-btn").click();
  const { requestId, descriptor } = await got;
  assert.equal(requestId, "c1");
  assert.equal(descriptor.executable, "gns");
  assert.deepEqual(descriptor.args, ["token", "--name", "Jane Q Public"]);
  assert.deepEqual(descriptor.env, [
    { key: "WHO", value: "Jane Q Public", enabled: true },
  ]);
  assert.equal(descriptor.outputType, "json");
  assert.equal(descriptor.timeoutMs, 5000);
  // The approved template is the UNRESOLVED one.
  assert.equal(descriptor.template.commandLine, "gns token --name {{who}}");
});

test("in flight, the Execute button becomes a red Stop (cmd colour key)", () => {
  const { window, editor } = mount();
  editor.load(cmdNode());
  window.dispatchEvent(
    new window.CustomEvent("hippo:request-loading", {
      detail: { requestId: "c1" },
    }),
  );
  const btn = editor.element.querySelector(".req-send-btn");
  assert.ok(btn.classList.contains("req-send-btn--cancel"));
  assert.equal(btn.dataset.method, "cmd");
});

test("with a timeout, the Stop button shows a countdown", () => {
  const { window, editor } = mount();
  editor.load(cmdNode({ commandTimeoutMs: 10000 }));
  window.dispatchEvent(
    new window.CustomEvent("hippo:request-loading", {
      detail: { requestId: "c1" },
    }),
  );
  const btn = editor.element.querySelector(".req-send-btn");
  assert.ok(btn.classList.contains("req-send-btn--timeout"));
  assert.match(btn.textContent, /10/);
  window.dispatchEvent(
    new window.CustomEvent("hippo:request-error", {
      detail: { requestId: "c1" },
    }),
  );
  assert.ok(!btn.classList.contains("req-send-btn--timeout"));
});

test("editing the command line approves the new template (debounced)", async () => {
  const { editor, calls } = mount();
  editor.load(cmdNode());
  // Let any approval timer armed by an earlier test (they share the global
  // window) drain, then confirm loading alone never approves.
  await tick(700);
  calls.grant.length = 0;
  await tick(700);
  assert.equal(calls.grant.length, 0, "loading never approves");
  // Arguments-tab add → re-serialises the line and approves it.
  editor.element.querySelector("#req-tab-args .params-toolbar-btn").click();
  await tick(700);
  assert.equal(calls.grant.length, 1);
  assert.equal(calls.grant[0].requestId, "c1");
  assert.equal(
    calls.grant[0].template.commandLine,
    "gns token --name 'John Smith' ''",
  );
});

test("under MAS the Execute button is disabled with a notice", () => {
  const { editor } = mount({
    hippo: { isElectron: true, isMas: true, platform: "darwin" },
  });
  editor.load(cmdNode());
  assert.equal(editor.element.querySelector(".req-send-btn").disabled, true);
  assert.ok(editor.element.querySelector(".cmd-unavailable"));
});
