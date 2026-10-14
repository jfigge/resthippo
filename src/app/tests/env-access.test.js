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

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ENV_ALLOW_PREFIX,
  isAllowedEnvName,
  readEnv,
} = require("../env-access");

test("ENV_ALLOW_PREFIX is the RESTHIPPO_ opt-in prefix", () => {
  assert.equal(ENV_ALLOW_PREFIX, "RESTHIPPO_");
});

test("isAllowedEnvName: only RESTHIPPO_*-prefixed names are allowed", () => {
  assert.equal(isAllowedEnvName("RESTHIPPO_API_KEY"), true);
  assert.equal(isAllowedEnvName("RESTHIPPO_"), true);
  // Sensitive host vars a malicious collection would target are denied:
  assert.equal(isAllowedEnvName("AWS_SECRET_ACCESS_KEY"), false);
  assert.equal(isAllowedEnvName("HOME"), false);
  assert.equal(isAllowedEnvName("PATH"), false);
  // Must be a true leading prefix, not a substring/suffix:
  assert.equal(isAllowedEnvName("MY_RESTHIPPO_KEY"), false);
  // Case-sensitive:
  assert.equal(isAllowedEnvName("resthippo_key"), false);
});

test("isAllowedEnvName: non-string / empty inputs are denied", () => {
  assert.equal(isAllowedEnvName(undefined), false);
  assert.equal(isAllowedEnvName(null), false);
  assert.equal(isAllowedEnvName(""), false);
  assert.equal(isAllowedEnvName(123), false);
  assert.equal(isAllowedEnvName({}), false);
});

test("readEnv: returns the value only for allowed, set names", () => {
  const env = {
    RESTHIPPO_TOKEN: "secret-token",
    RESTHIPPO_EMPTY: "",
    AWS_SECRET_ACCESS_KEY: "do-not-leak",
    HOME: "/home/user",
  };
  assert.equal(readEnv("RESTHIPPO_TOKEN", env), "secret-token");
  assert.equal(readEnv("RESTHIPPO_EMPTY", env), "");
  // Disallowed names never read, even when present in the environment:
  assert.equal(readEnv("AWS_SECRET_ACCESS_KEY", env), "");
  assert.equal(readEnv("HOME", env), "");
  // Allowed but unset:
  assert.equal(readEnv("RESTHIPPO_MISSING", env), "");
});

test("readEnv: coerces to string and never returns undefined", () => {
  const env = { RESTHIPPO_NUM: 42 };
  assert.equal(readEnv("RESTHIPPO_NUM", env), "42");
  assert.equal(readEnv(undefined, env), "");
  assert.equal(readEnv("RESTHIPPO_ABSENT", env), "");
});

test("readEnv: defaults to process.env when no env is passed", () => {
  const KEY = "RESTHIPPO_TEST_ENV_ACCESS";
  process.env[KEY] = "from-process";
  try {
    assert.equal(readEnv(KEY), "from-process");
  } finally {
    delete process.env[KEY];
  }
});
