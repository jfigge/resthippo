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

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isBinaryContentType,
  looksBinary,
  binaryExtensionFor,
  charsetOf,
  decodeText,
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

test("charsetOf extracts the charset parameter (lowercased, unquoted)", () => {
  assert.equal(charsetOf("text/html; charset=ISO-8859-1"), "iso-8859-1");
  assert.equal(charsetOf('text/plain; charset="UTF-8"'), "utf-8");
  assert.equal(charsetOf("application/json; charset=shift_jis"), "shift_jis");
  assert.equal(charsetOf("text/plain"), "");
  assert.equal(charsetOf(""), "");
  assert.equal(charsetOf(undefined), "");
});

test("decodeText honours the Content-Type charset", () => {
  // "café" — 0xE9 is a valid ISO-8859-1 'é' but an invalid lone UTF-8 byte.
  const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9]);
  assert.equal(decodeText(latin1, "text/plain; charset=iso-8859-1"), "café");
  // Naive UTF-8 would have produced a replacement char — prove the difference.
  assert.notEqual(latin1.toString("utf8"), "café");

  // "テスト" in Shift_JIS.
  const sjis = Buffer.from([0x83, 0x65, 0x83, 0x58, 0x83, 0x67]);
  assert.equal(
    decodeText(sjis, "application/json; charset=shift_jis"),
    "テスト",
  );

  // UTF-16LE.
  assert.equal(
    decodeText(Buffer.from("hi", "utf16le"), "text/plain; charset=utf-16le"),
    "hi",
  );
});

test("decodeText defaults to UTF-8 and tolerates a bogus charset", () => {
  const utf8 = Buffer.from("héllo", "utf8");
  assert.equal(decodeText(utf8, "application/json"), "héllo"); // no charset
  assert.equal(decodeText(utf8, "application/json; charset=utf-8"), "héllo");
  // Unknown label must not throw — fall back to UTF-8.
  assert.equal(
    decodeText(utf8, "text/plain; charset=no-such-charset"),
    "héllo",
  );
});
