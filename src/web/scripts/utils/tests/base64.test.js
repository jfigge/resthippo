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
