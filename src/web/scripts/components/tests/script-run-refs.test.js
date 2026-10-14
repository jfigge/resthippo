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
