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

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  tokenize,
  parseCommandLine,
  quoteArg,
  setArgs,
  setExecutable,
} from "../command-line.js";

const vals = (line, p) => tokenize(line, p).map((t) => t.value);

test("splits on whitespace", () => {
  assert.deepEqual(vals("gns  token   --json"), ["gns", "token", "--json"]);
  assert.deepEqual(vals("   "), []);
});

test("single and double quotes group a token", () => {
  assert.deepEqual(vals(`echo 'a b' "c d"`), ["echo", "a b", "c d"]);
  assert.deepEqual(vals(`x --name="John Smith"`), ["x", "--name=John Smith"]);
  assert.deepEqual(vals(`x ''`), ["x", ""]);
});

test("escapes inside double quotes", () => {
  assert.deepEqual(vals(`x "say \\"hi\\""`), ["x", 'say "hi"']);
  assert.deepEqual(vals(`x "a\\\\b"`), ["x", "a\\b"]);
});

test("POSIX backslash escapes outside quotes", () => {
  assert.deepEqual(vals("x a\\ b"), ["x", "a b"]);
});

test("Windows backslashes are literal (paths)", () => {
  assert.deepEqual(vals("C:\\tools\\az.cmd login", "win32"), [
    "C:\\tools\\az.cmd",
    "login",
  ]);
  assert.deepEqual(vals(`x "C:\\Program Files\\a"`, "win32"), [
    "x",
    "C:\\Program Files\\a",
  ]);
});

test("{{…}} pills are opaque", () => {
  assert.deepEqual(vals(`gns --at {{now("ISO 8601")}} {{token}}`), [
    "gns",
    "--at",
    '{{now("ISO 8601")}}',
    "{{token}}",
  ]);
  assert.deepEqual(vals(`x "pre {{a b}} post"`), ["x", "pre {{a b}} post"]);
});

test("unterminated quotes take the rest of the line", () => {
  assert.deepEqual(vals(`x "a b`), ["x", "a b"]);
  assert.deepEqual(vals(`x 'a b`), ["x", "a b"]);
});

test("token spans cover the raw text", () => {
  const line = `a 'b c' d`;
  const t = tokenize(line);
  assert.equal(line.slice(t[1].start, t[1].end), "'b c'");
});

test("parseCommandLine", () => {
  assert.deepEqual(parseCommandLine("az account get-access-token"), {
    executable: "az",
    args: ["account", "get-access-token"],
  });
  assert.deepEqual(parseCommandLine(""), { executable: "", args: [] });
});

test("quoteArg round-trips through tokenize", () => {
  for (const p of ["darwin", "win32"]) {
    for (const v of [
      "plain",
      "a b",
      "it's",
      'say "hi"',
      "",
      '{{now("ISO")}}',
      "x {{y}}",
      'it\'s "both"',
    ]) {
      const q = quoteArg(v, p);
      assert.deepEqual(vals(`exe ${q}`, p), ["exe", v], `${p}: ${v} → ${q}`);
    }
  }
  assert.equal(quoteArg("plain"), "plain");
  assert.equal(quoteArg('{{now("ISO")}}'), '{{now("ISO")}}');
});

test("POSIX backslash values are quoted so they survive", () => {
  const q = quoteArg("a\\b");
  assert.deepEqual(vals(`e ${q}`), ["e", "a\\b"]);
});

test("setArgs edits one argument and preserves the others' quoting", () => {
  const line = `gns token --name="John Smith"  -v`;
  assert.equal(
    setArgs(line, ["token", "--name=John Smith", "-q"]),
    `gns token --name="John Smith"  -q`,
  );
});

test("setArgs adds, removes and reorders", () => {
  assert.equal(setArgs("gns token", ["token", "--json"]), "gns token --json");
  assert.equal(setArgs("gns token --json", ["token"]), "gns token");
  assert.equal(setArgs("gns 'a b' c", ["c", "a b"]), "gns c 'a b'");
  assert.equal(setArgs("", ["x"]), "x");
});

test("setExecutable replaces only token 0", () => {
  assert.equal(setExecutable("gns  token", "/opt/gns"), "/opt/gns  token");
  assert.equal(setExecutable("", "gns"), "gns");
});
