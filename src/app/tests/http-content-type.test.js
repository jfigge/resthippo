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
  isBinaryContentType,
  looksBinary,
  binaryExtensionFor,
} = require("../http-content-type.js");

test("isBinaryContentType treats text-like types as text", () => {
  for (const ct of [
    "text/plain",
    "text/html; charset=utf-8",
    "text/csv",
    "application/json",
    "application/ld+json",
    "application/xml",
    "application/yaml",
    "text/javascript",
    "application/x-www-form-urlencoded",
    "image/svg+xml", // SVG is UTF-8 markup
  ]) {
    assert.equal(isBinaryContentType(ct), false, `${ct} should be text`);
  }
});

test("isBinaryContentType flags non-text types as binary", () => {
  for (const ct of [
    "image/png",
    "image/jpeg",
    "application/pdf",
    "application/octet-stream",
    "application/zip",
    "font/woff2",
    "audio/mpeg",
    "video/mp4",
    "application/protobuf",
  ]) {
    assert.equal(isBinaryContentType(ct), true, `${ct} should be binary`);
  }
});

test("isBinaryContentType returns false for an empty/absent content-type", () => {
  assert.equal(isBinaryContentType(""), false);
  assert.equal(isBinaryContentType(null), false);
  assert.equal(isBinaryContentType(undefined), false);
});

test("looksBinary detects NUL bytes and control-heavy data", () => {
  assert.equal(looksBinary(Buffer.from("plain ascii text\n")), false);
  assert.equal(looksBinary(Buffer.from("héllo wörld utf-8")), false);
  assert.equal(looksBinary(Buffer.from([0x00, 0x01, 0x02, 0x03])), true);
  // PNG magic begins with a high byte then "PNG".
  assert.equal(
    looksBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    true,
  );
  assert.equal(looksBinary(Buffer.alloc(0)), false);
});

test("binaryExtensionFor maps known types and falls back to the subtype", () => {
  assert.equal(binaryExtensionFor("image/png"), "png");
  assert.equal(binaryExtensionFor("image/jpeg"), "jpg");
  assert.equal(binaryExtensionFor("application/pdf"), "pdf");
  assert.equal(binaryExtensionFor("application/octet-stream"), "bin");
  // Unknown type → cleaned subtype (strip any "+suffix").
  assert.equal(binaryExtensionFor("application/vnd.foo+bar"), "vndfoo");
  assert.equal(binaryExtensionFor(""), "bin");
});
