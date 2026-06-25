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

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "resign-update-metadata.mjs");

const sha512 = (buf) => createHash("sha512").update(buf).digest("base64");
const run = (dir) => execFileSync("node", [SCRIPT, dir], { encoding: "utf8" });
const sandbox = () => mkdtempSync(join(tmpdir(), "resign-test-"));

// Pull "sha512: VALUE" / "size: VALUE" leaves out of the rewritten manifest.
const valuesOf = (yml, key) =>
  yml
    .split("\n")
    .filter((l) => new RegExp(`^\\s*${key}:`).test(l))
    .map((l) => l.replace(new RegExp(`^\\s*${key}:\\s*`), "").trim());

test("recomputes sha512/size for every referenced file and the top-level path", () => {
  const dir = sandbox();
  try {
    const x64 = Buffer.from("SIGNED-x64-installer-bytes");
    const arm = Buffer.from("SIGNED-arm64-bytes-longer-than-x64");
    writeFileSync(join(dir, "App-Setup-1.0.0-x64.exe"), x64);
    writeFileSync(join(dir, "App-Setup-1.0.0-arm64.exe"), arm);

    writeFileSync(
      join(dir, "latest.yml"),
      [
        "version: 1.0.0",
        "files:",
        "  - url: App-Setup-1.0.0-x64.exe",
        "    sha512: WRONG-x64==",
        "    size: 11111",
        "    blockMapSize: 999",
        "  - url: App-Setup-1.0.0-arm64.exe",
        "    sha512: WRONG-arm64==",
        "    size: 22222",
        "    blockMapSize: 888",
        "path: App-Setup-1.0.0-x64.exe",
        "sha512: WRONG-x64==",
        "releaseDate: '2026-06-25T00:00:00.000Z'",
        "",
      ].join("\n"),
    );

    run(dir);
    const out = readFileSync(join(dir, "latest.yml"), "utf8");

    // Both per-file entries plus the top-level mirror of x64 → three sha lines.
    assert.deepEqual(valuesOf(out, "sha512"), [sha512(x64), sha512(arm), sha512(x64)]);
    assert.deepEqual(valuesOf(out, "size"), [String(x64.length), String(arm.length)]);

    // blockMapSize hints are dropped, and untouched scalars are preserved.
    assert.ok(!/blockMapSize/.test(out), "blockMapSize lines should be removed");
    assert.ok(/^version: 1\.0\.0$/m.test(out), "unrelated lines stay intact");
    assert.ok(/releaseDate: '2026-06-25/.test(out));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deletes stale *.blockmap sidecars", () => {
  const dir = sandbox();
  try {
    writeFileSync(join(dir, "App-Setup-1.0.0-x64.exe"), Buffer.from("x"));
    writeFileSync(join(dir, "App-Setup-1.0.0-x64.exe.blockmap"), Buffer.from("stale"));
    writeFileSync(
      join(dir, "latest.yml"),
      "files:\n  - url: App-Setup-1.0.0-x64.exe\n    sha512: x==\n    size: 1\npath: App-Setup-1.0.0-x64.exe\nsha512: x==\n",
    );

    run(dir);

    assert.ok(
      !readdirSync(dir).some((f) => f.endsWith(".blockmap")),
      "no .blockmap files should remain",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a dir with no manifest still cleans blockmaps and does not throw", () => {
  const dir = sandbox();
  try {
    writeFileSync(join(dir, "orphan.exe.blockmap"), Buffer.from("stale"));
    assert.doesNotThrow(() => run(dir));
    assert.ok(!readdirSync(dir).some((f) => f.endsWith(".blockmap")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing dist directory exits non-zero", () => {
  const dir = join(sandbox(), "does-not-exist");
  assert.throws(() => run(dir));
});

test("references to files absent on disk are left untouched (not zeroed)", () => {
  const dir = sandbox();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "latest.yml"),
      "files:\n  - url: ghost.exe\n    sha512: KEEP==\n    size: 42\npath: ghost.exe\nsha512: KEEP==\n",
    );

    run(dir);
    const out = readFileSync(join(dir, "latest.yml"), "utf8");

    assert.deepEqual(valuesOf(out, "sha512"), ["KEEP==", "KEEP=="]);
    assert.deepEqual(valuesOf(out, "size"), ["42"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
