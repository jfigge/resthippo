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

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveExecutable,
  isBatchFile,
  buildBatchInvocation,
  escapeCmdArgument,
} = require("../command-resolve.js");

/** A fake executable probe over a fixed set of paths. */
const fakeFs = (paths) => {
  const set = new Set(paths);
  return (p) => set.has(p);
};

describe("resolveExecutable (POSIX)", () => {
  const opts = (files) => ({
    platform: "darwin",
    pathValue: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    isExecutable: fakeFs(files),
  });

  it("finds a bare name on the first PATH entry that has it", () => {
    const r = resolveExecutable(
      "jq",
      opts(["/usr/local/bin/jq", "/usr/bin/jq"]),
    );
    assert.equal(r, "/usr/local/bin/jq");
  });

  it("returns null when the name is on no PATH entry", () => {
    assert.equal(resolveExecutable("nosuch", opts(["/bin/ls"])), null);
  });

  it("checks an absolute path directly, ignoring PATH", () => {
    const o = { ...opts(["/tools/gns"]), pathValue: "" };
    assert.equal(resolveExecutable("/tools/gns", o), "/tools/gns");
    assert.equal(resolveExecutable("/tools/missing", o), null);
  });

  it("resolves a relative name with a separator against cwd", () => {
    const o = { ...opts(["/home/me/bin/tool"]), cwd: "/home/me" };
    assert.equal(resolveExecutable("bin/tool", o), "/home/me/bin/tool");
  });

  it("treats blank input as not found", () => {
    assert.equal(resolveExecutable("  ", opts([])), null);
  });
});

describe("resolveExecutable (Windows)", () => {
  const opts = (files) => ({
    platform: "win32",
    pathValue: "C:\\Windows\\System32;C:\\Program Files\\Azure\\wbin",
    pathext: ".COM;.EXE;.BAT;.CMD",
    isExecutable: fakeFs(files),
  });

  it("tries each PATHEXT extension for a bare name (az → az.cmd)", () => {
    const r = resolveExecutable(
      "az",
      opts(["C:\\Program Files\\Azure\\wbin\\az.cmd"]),
    );
    assert.equal(r, "C:\\Program Files\\Azure\\wbin\\az.cmd");
  });

  it("prefers an earlier PATHEXT entry in the same directory", () => {
    const r = resolveExecutable(
      "tool",
      opts([
        "C:\\Windows\\System32\\tool.exe",
        "C:\\Windows\\System32\\tool.cmd",
      ]),
    );
    assert.equal(r, "C:\\Windows\\System32\\tool.exe");
  });

  it("uses a name that already carries an extension as given", () => {
    const r = resolveExecutable(
      "az.cmd",
      opts(["C:\\Program Files\\Azure\\wbin\\az.cmd"]),
    );
    assert.equal(r, "C:\\Program Files\\Azure\\wbin\\az.cmd");
  });

  it("accepts a full path with backslashes", () => {
    const r = resolveExecutable(
      "C:\\tools\\gns.exe",
      opts(["C:\\tools\\gns.exe"]),
    );
    assert.equal(r, "C:\\tools\\gns.exe");
  });

  it("adds PATHEXT to a full path without an extension", () => {
    const r = resolveExecutable("C:\\tools\\gns", opts(["C:\\tools\\gns.bat"]));
    assert.equal(r, "C:\\tools\\gns.bat");
  });

  it("tolerates quoted PATH entries", () => {
    const o = {
      ...opts(["C:\\Program Files\\X\\x.exe"]),
      pathValue: '"C:\\Program Files\\X"',
    };
    assert.equal(resolveExecutable("x", o), "C:\\Program Files\\X\\x.exe");
  });
});

describe("Windows batch invocation", () => {
  it("detects .cmd / .bat case-insensitively", () => {
    assert.ok(isBatchFile("C:\\a\\az.CMD"));
    assert.ok(isBatchFile("run.bat"));
    assert.ok(!isBatchFile("run.exe"));
  });

  it("runs the batch file through cmd.exe by absolute path", () => {
    const inv = buildBatchInvocation("C:\\a\\az.cmd", ["login"], "C:\\Windows");
    assert.equal(inv.command, "C:\\Windows\\System32\\cmd.exe");
    assert.deepEqual(inv.args.slice(0, 3), ["/d", "/s", "/c"]);
    assert.equal(inv.windowsVerbatimArguments, true);
    assert.match(inv.args[3], /^".*"$/);
  });

  it("escapes cmd metacharacters so they reach the script literally", () => {
    const a = escapeCmdArgument("a&b|c");
    assert.ok(!/[^^]&/.test(a), "every & is ^-escaped");
    assert.ok(a.includes("^&") && a.includes("^|"));
  });

  it("escapes embedded quotes", () => {
    assert.ok(escapeCmdArgument('say "hi"').includes('\\^"hi\\^"'));
  });
});
