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

const { SpillRegistry, SpillCollector } = require("../body-spill.js");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hippo-spill-"));

describe("SpillCollector", () => {
  it("keeps small bodies in memory", async () => {
    const c = new SpillCollector({ dir: tmp, threshold: 100 });
    c.write(Buffer.from("hello "));
    c.write(Buffer.from("world"));
    const r = await c.finish();
    assert.equal(r.buffer.toString(), "hello world");
    assert.equal(r.path, null);
    assert.equal(r.total, 11);
  });

  it("spills past the threshold and keeps a bounded preview", async () => {
    const dir = tmp();
    const c = new SpillCollector({
      dir: () => dir,
      threshold: 10,
      previewBytes: 4,
    });
    c.write(Buffer.from("0123456789"));
    c.write(Buffer.from("abcdef"));
    const r = await c.finish();
    assert.equal(r.buffer, null);
    assert.equal(r.preview.toString(), "0123");
    assert.equal(fs.readFileSync(r.path, "utf8"), "0123456789abcdef");
    assert.equal(r.total, 16);
  });
});

describe("SpillRegistry", () => {
  it("evicts (and unlinks) the oldest entry past its cap", () => {
    const dir = tmp();
    const reg = new SpillRegistry({ max: 2 });
    const files = [1, 2, 3].map((i) => {
      const p = path.join(dir, `f${i}`);
      fs.writeFileSync(p, "x");
      return p;
    });
    const refs = files.map((p) =>
      reg.register({ path: p, size: 1, contentType: "", isBinary: false }),
    );
    assert.equal(reg.size, 2);
    assert.equal(reg.get(refs[0]), undefined);
    assert.ok(!fs.existsSync(files[0]));
    assert.equal(reg.get(refs[2]).path, files[2]);
  });
});
