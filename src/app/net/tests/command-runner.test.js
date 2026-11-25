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

"use strict";

// Real spawns of this Node binary (process.execPath) so the tests are
// hermetic and portable — no reliance on /bin/sh or a host PATH.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { CommandRunner, contentTypeFor } = require("../command-runner.js");
const { SpillRegistry } = require("../body-spill.js");

const NODE = process.execPath;
const env = () => ({ PATH: path.dirname(NODE), HOME: os.tmpdir() });
const js = (code) => ["-e", code];

describe("CommandRunner", () => {
  it("maps exit code → status, stdout → body, stderr → stderr", async () => {
    const r = await new CommandRunner().run("a", {
      executable: NODE,
      args: js(
        "process.stdout.write('{\"token\":\"abc\"}');process.stderr.write('warn');process.exit(3)",
      ),
      env: env(),
    });
    assert.equal(r.status, 3);
    assert.equal(r.body, '{"token":"abc"}');
    assert.equal(r.stderr, "warn");
    assert.equal(r.kind, "command");
    assert.equal(r.headers["content-type"], "application/json");
    assert.ok(!r.error);
  });

  it("resolves a bare name against the env PATH", async () => {
    const r = await new CommandRunner().run("b", {
      executable: path.basename(NODE),
      args: js("console.log('ok')"),
      env: env(),
    });
    assert.equal(r.status, 0);
    assert.equal(r.body.trim(), "ok");
  });

  it("reports a missing executable as CommandNotFound (status 0)", async () => {
    const r = await new CommandRunner().run("c", {
      executable: "definitely-not-a-real-command-xyz",
      env: env(),
    });
    assert.equal(r.status, 0);
    assert.equal(r.error.name, "CommandNotFound");
  });

  it("passes arguments verbatim — no shell interpretation", async () => {
    const tricky = ["a b", "$HOME", "`x`", "; rm -rf /", '"q"'];
    const r = await new CommandRunner().run("d", {
      executable: NODE,
      args: [
        "-e",
        "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
        ...tricky,
      ],
      env: env(),
    });
    assert.deepEqual(JSON.parse(r.body), tricky);
  });

  it("pipes stdin into the process", async () => {
    const r = await new CommandRunner().run("e", {
      executable: NODE,
      args: js(
        "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(s.toUpperCase()))",
      ),
      env: env(),
      stdin: "hello",
    });
    assert.equal(r.body, "HELLO");
  });

  it("does not inherit the host environment", async () => {
    process.env.RESTHIPPO_LEAK_MARKER = "leaked";
    try {
      const r = await new CommandRunner().run("f", {
        executable: NODE,
        args: js("process.stdout.write(JSON.stringify(process.env))"),
        env: { ...env(), ONLY_ME: "1" },
      });
      const childEnv = JSON.parse(r.body);
      assert.equal(childEnv.RESTHIPPO_LEAK_MARKER, undefined);
      assert.equal(childEnv.ONLY_ME, "1");
    } finally {
      delete process.env.RESTHIPPO_LEAK_MARKER;
    }
  });

  it("honours an explicit output type", async () => {
    const r = await new CommandRunner().run("g", {
      executable: NODE,
      args: js("process.stdout.write('{\"a\":1}')"),
      env: env(),
      outputType: "text",
    });
    assert.match(r.headers["content-type"], /^text\/plain/);
  });

  it("times out, killing the process", async () => {
    const t0 = Date.now();
    const r = await new CommandRunner().run("h", {
      executable: NODE,
      args: js("setTimeout(()=>{}, 30000)"),
      env: env(),
      timeoutMs: 300,
    });
    assert.equal(r.error.name, "TimeoutError");
    assert.ok(Date.now() - t0 < 5000);
  });

  it(
    "cancel escalates to SIGKILL when SIGTERM is ignored",
    { skip: process.platform === "win32" },
    async () => {
      const runner = new CommandRunner();
      const p = runner.run("i", {
        executable: NODE,
        args: js(
          "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)",
        ),
        env: env(),
      });
      await new Promise((res) => setTimeout(res, 300));
      assert.ok(runner.isRunning("i"));
      const t0 = Date.now();
      assert.deepEqual(runner.cancel("i"), { ok: true });
      const r = await p;
      assert.equal(r.error.name, "AbortError");
      const took = Date.now() - t0;
      assert.ok(took >= 1500 && took < 6000, `killed after grace (${took} ms)`);
      assert.ok(!runner.isRunning("i"));
    },
  );

  it("cancel of an unknown id is a harmless no-op", () => {
    assert.deepEqual(new CommandRunner().cancel("nope"), {
      ok: false,
      reason: "not-found",
    });
  });

  it("spills large stdout to disk and registers a redeemable ref", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hippo-cmd-"));
    const reg = new SpillRegistry();
    const r = await new CommandRunner({
      spillRegistry: reg,
      cacheDir: () => dir,
    }).run("j", {
      executable: NODE,
      args: js("process.stdout.write('x'.repeat(9*1024*1024))"),
      env: env(),
    });
    assert.equal(r.truncated, true);
    assert.equal(r.size, 9 * 1024 * 1024);
    const entry = reg.get(r.bodyRef);
    assert.equal(fs.statSync(entry.path).size, 9 * 1024 * 1024);
  });
});

describe("contentTypeFor", () => {
  const b = (s) => Buffer.from(s);
  it("auto-detects JSON, XML and text", () => {
    assert.equal(
      contentTypeFor("auto", b(' {"a":1}\n'), true),
      "application/json",
    );
    assert.equal(contentTypeFor("auto", b("<a/>"), true), "application/xml");
    assert.match(contentTypeFor("auto", b("token=abc"), true), /^text\/plain/);
    assert.match(contentTypeFor("auto", b("{not json"), true), /^text\/plain/);
  });
  it("flags binary output", () => {
    assert.equal(
      contentTypeFor("auto", Buffer.from([0, 1, 2]), true),
      "application/octet-stream",
    );
  });
});
