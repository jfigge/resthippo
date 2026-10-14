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
 * components/tests/script-autocomplete.test.js
 *
 * Characterises the pure `suggestHippo()` completion model (Feature 25, step 5):
 * which members are offered for a given caret context, and the `from` offset the
 * partial member starts at (used to replace it on accept).
 *
 * Run with:   node --test components/tests/script-autocomplete.test.js
 */
"use strict";

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { suggestHippo } from "../editors/script-autocomplete.js";

const names = (r) => (r ? r.items.map((i) => i.name) : null);

describe("suggestHippo — member access", () => {
  it("offers all hippo members after `hippo.`", () => {
    const r = suggestHippo("hippo.", 6);
    assert.deepEqual(names(r), [
      "variables",
      "request",
      "response",
      "environment",
      "console",
      "run",
    ]);
    assert.equal(r.from, 6);
  });

  it("offers run for the `ru` partial", () => {
    const r = suggestHippo("hippo.ru", 8);
    assert.deepEqual(names(r), ["run"]);
    assert.equal(r.from, 6);
  });

  it("filters by the partial member and reports its start offset", () => {
    const r = suggestHippo("hippo.va", 8);
    assert.deepEqual(names(r), ["variables"]);
    assert.equal(r.from, 6); // 'va' starts at offset 6
  });

  it("descends into hippo.variables", () => {
    assert.deepEqual(names(suggestHippo("hippo.variables.", 16)), [
      "get",
      "set",
    ]);
    assert.deepEqual(names(suggestHippo("hippo.variables.s", 17)), ["set"]);
  });

  it("offers response members (incl. json)", () => {
    assert.deepEqual(names(suggestHippo("hippo.response.", 15)), [
      "status",
      "headers",
      "body",
      "json",
    ]);
  });

  it("works mid-expression", () => {
    const r = suggestHippo("const v = hippo.request.", 24);
    assert.deepEqual(names(r), ["method", "url", "headers", "body"]);
    assert.equal(r.from, 24);
  });
});

describe("suggestHippo — bare identifier", () => {
  it("offers top-level hippo for a ≥2-char prefix", () => {
    const r = suggestHippo("const x = hi", 12);
    assert.deepEqual(names(r), ["hippo"]);
    assert.equal(r.from, 10);
  });

  it("does not offer hippo for a single char or the full word", () => {
    assert.equal(suggestHippo("h", 1), null);
    assert.equal(suggestHippo("hippo", 5), null);
  });
});

describe("suggestHippo — no suggestion", () => {
  it("returns null for an unknown receiver", () => {
    assert.equal(suggestHippo("foo.bar", 7), null);
    assert.equal(suggestHippo("hippo.request.method.", 21), null);
  });

  it("returns null when the partial matches nothing", () => {
    assert.equal(suggestHippo("hippo.zzz", 9), null);
  });

  it("returns null on empty input", () => {
    assert.equal(suggestHippo("", 0), null);
  });
});
