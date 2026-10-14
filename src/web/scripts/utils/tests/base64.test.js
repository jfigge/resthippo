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
 * base64.test.js — UTF-8-safe base64 for the renderer. Basic-auth (RFC 7617)
 * and OAuth secrets can be Unicode, which the platform btoa rejects; this
 * helper must encode the UTF-8 bytes instead of throwing.
 *
 * Run with:  node --test src/web/scripts/utils/tests/base64.test.js
 */
"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import { utf8ToBase64 } from "../base64.js";

test("ASCII output is byte-identical to btoa / Buffer base64", () => {
  assert.equal(
    utf8ToBase64("user:pass"),
    Buffer.from("user:pass", "utf8").toString("base64"),
  );
});

test("multi-byte input does not throw and encodes the UTF-8 bytes", () => {
  const s = "ü:påss 日本語";
  let out;
  assert.doesNotThrow(() => {
    out = utf8ToBase64(s);
  });
  assert.equal(out, Buffer.from(s, "utf8").toString("base64"));
});

test("empty string encodes to empty", () => {
  assert.equal(utf8ToBase64(""), "");
});
