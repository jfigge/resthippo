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

/**
 * components/tests/script-run-refs.test.js
 *
 * Characterises the static `hippo.run("…")` literal scan that tells the renderer
 * which requests to pre-execute before a script runs.
 */
"use strict";

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { extractScriptRunNames } from "../script-run-refs.js";

describe("extractScriptRunNames", () => {
  it("finds a double-quoted literal name", () => {
    assert.deepEqual(extractScriptRunNames(`hippo.run("Login")`), ["Login"]);
  });

  it("accepts single quotes and backticks (without interpolation)", () => {
    assert.deepEqual(extractScriptRunNames(`hippo.run('Login')`), ["Login"]);
    assert.deepEqual(extractScriptRunNames("hippo.run(`Login`)"), ["Login"]);
  });

  it("tolerates whitespace around the dots and paren", () => {
    assert.deepEqual(extractScriptRunNames(`hippo . run ( "A" )`), ["A"]);
  });

  it("collects multiple distinct names in first-seen order, deduped", () => {
    const code = `
      const a = hippo.run("Login");
      hippo.run("Refresh");
      hippo.run("Login");`;
    assert.deepEqual(extractScriptRunNames(code), ["Login", "Refresh"]);
  });

  it("unescapes a backslash-escaped quote in the name", () => {
    assert.deepEqual(extractScriptRunNames(`hippo.run("Say \\"hi\\"")`), [
      'Say "hi"',
    ]);
  });

  it("ignores a dynamic (non-literal) argument", () => {
    assert.deepEqual(extractScriptRunNames("hippo.run(name)"), []);
    assert.deepEqual(extractScriptRunNames("hippo.run(`${name}`)"), []);
  });

  it("does not match an unrelated .run() call", () => {
    assert.deepEqual(extractScriptRunNames(`other.run("X")`), []);
  });

  it("returns [] for empty / non-string input", () => {
    assert.deepEqual(extractScriptRunNames(""), []);
    assert.deepEqual(extractScriptRunNames(null), []);
    assert.deepEqual(extractScriptRunNames(undefined), []);
  });
});
