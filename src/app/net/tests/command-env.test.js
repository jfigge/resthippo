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
  defaultBaseEnv,
  buildProcessEnv,
  envGet,
} = require("../command-env.js");

describe("defaultBaseEnv", () => {
  it("macOS: Homebrew-first PATH plus HOME", () => {
    const rows = defaultBaseEnv({ platform: "darwin", home: "/Users/me" });
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    assert.equal(map.PATH, "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
    assert.equal(map.HOME, "/Users/me");
    assert.ok(rows.every((r) => r.enabled));
  });

  it("Linux: standard PATH plus HOME", () => {
    const rows = defaultBaseEnv({ platform: "linux", home: "/home/me" });
    assert.deepEqual(
      rows.map((r) => r.key),
      ["PATH", "HOME"],
    );
  });

  it("Windows: system folders, PATHEXT and profile dirs", () => {
    const rows = defaultBaseEnv({
      platform: "win32",
      home: "C:\\Users\\me",
      hostEnv: { SystemRoot: "D:\\Win" },
    });
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    assert.ok(map.PATH.startsWith("D:\\Win\\System32;D:\\Win"));
    assert.equal(map.SystemRoot, "D:\\Win");
    assert.equal(map.USERPROFILE, "C:\\Users\\me");
    assert.equal(map.APPDATA, "C:\\Users\\me\\AppData\\Roaming");
    assert.ok(map.PATHEXT.includes(".CMD"));
    assert.ok(map.TEMP);
  });

  it("never copies arbitrary host variables", () => {
    const rows = defaultBaseEnv({
      platform: "linux",
      home: "/h",
      hostEnv: { SECRET_TOKEN: "x" },
    });
    assert.ok(!rows.some((r) => r.key === "SECRET_TOKEN"));
  });
});

describe("buildProcessEnv", () => {
  it("uses only the given rows — the host env is never inherited", () => {
    process.env.RESTHIPPO_TEST_MARKER = "leak";
    try {
      const env = buildProcessEnv([{ key: "PATH", value: "/bin" }], [], {
        platform: "linux",
      });
      assert.deepEqual(env, { PATH: "/bin" });
    } finally {
      delete process.env.RESTHIPPO_TEST_MARKER;
    }
  });

  it("request rows override the base", () => {
    const env = buildProcessEnv(
      [
        { key: "PATH", value: "/bin" },
        { key: "HOME", value: "/h" },
      ],
      [
        { key: "PATH", value: "/custom:/bin" },
        { key: "TOKEN", value: "t" },
      ],
      { platform: "darwin" },
    );
    assert.deepEqual(env, { HOME: "/h", PATH: "/custom:/bin", TOKEN: "t" });
  });

  it("skips disabled and blank-key rows", () => {
    const env = buildProcessEnv(
      [
        { key: "A", value: "1", enabled: false },
        { key: " ", value: "x" },
      ],
      [{ key: "B", value: "2" }],
      { platform: "linux" },
    );
    assert.deepEqual(env, { B: "2" });
  });

  it("is case-sensitive on POSIX", () => {
    const env = buildProcessEnv(
      [{ key: "Path", value: "a" }],
      [{ key: "PATH", value: "b" }],
      { platform: "linux" },
    );
    assert.deepEqual(env, { Path: "a", PATH: "b" });
  });

  it("is case-insensitive on Windows (request spelling wins)", () => {
    const env = buildProcessEnv(
      [{ key: "PATH", value: "a" }],
      [{ key: "Path", value: "b" }],
      { platform: "win32" },
    );
    assert.deepEqual(env, { Path: "b" });
    assert.equal(envGet(env, "PATH", "win32"), "b");
  });

  it("null base → platform defaults", () => {
    const env = buildProcessEnv(null, [], { platform: "darwin", home: "/u" });
    assert.equal(env.HOME, "/u");
    assert.ok(env.PATH.includes("/opt/homebrew/bin"));
  });
});
