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
const fs = require("fs");
const os = require("os");
const path = require("path");

const { CommandApprovals } = require("../command-approvals.js");
const { templateHash } = require("../../ipc/command.js");

const file = () =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hippo-appr-")), "a.json");

describe("CommandApprovals", () => {
  it("approves only the granted hash, and persists", () => {
    const f = file();
    const a = new CommandApprovals(f);
    assert.equal(a.isApproved("r1", "h1"), false);
    a.grant("r1", "h1");
    assert.equal(a.isApproved("r1", "h1"), true);
    assert.equal(a.isApproved("r1", "h2"), false);
    assert.equal(new CommandApprovals(f).isApproved("r1", "h1"), true);
  });

  it("a changed hash replaces the old approval", () => {
    const a = new CommandApprovals(file());
    a.grant("r1", "h1");
    a.grant("r1", "h2");
    assert.equal(a.isApproved("r1", "h1"), false);
    assert.equal(a.isApproved("r1", "h2"), true);
  });

  it("revoke forgets an approval", () => {
    const a = new CommandApprovals(file());
    a.grant("r1", "h1");
    assert.equal(a.revoke("r1"), true);
    assert.equal(a.isApproved("r1", "h1"), false);
  });

  it("a corrupt file fails closed", () => {
    const f = file();
    fs.writeFileSync(f, "{nope");
    assert.equal(new CommandApprovals(f).isApproved("r1", "h1"), false);
  });
});

describe("templateHash", () => {
  it("changes when the command line, env or stdin changes", () => {
    const base = { commandLine: "gns token", commandEnv: [], commandStdin: "" };
    const h = templateHash(base);
    assert.equal(h, templateHash({ ...base }));
    assert.notEqual(h, templateHash({ ...base, commandLine: "gns token -v" }));
    assert.notEqual(
      h,
      templateHash({ ...base, commandEnv: [{ key: "A", value: "1" }] }),
    );
    assert.notEqual(h, templateHash({ ...base, commandStdin: "x" }));
  });

  it("ignores disabled env rows and surrounding whitespace", () => {
    const h = templateHash({ commandLine: "a", commandEnv: [] });
    assert.equal(
      h,
      templateHash({
        commandLine: " a ",
        commandEnv: [{ key: "X", value: "1", enabled: false }],
      }),
    );
  });
});
