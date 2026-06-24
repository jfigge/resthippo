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
