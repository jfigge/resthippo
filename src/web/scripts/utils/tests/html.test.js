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
 * html.test.js — the HTML-escaping helpers. escapeHtml is the default innerHTML
 * injection guard (imported request names / URLs are rendered through it), so
 * it must neutralise every attribute-breakout character; the minimal
 * escapeHtmlText / escapeHtmlAttr serialisers stay context-specific.
 *
 * Run with:  node --test src/web/scripts/utils/tests/html.test.js
 */
"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import { escapeHtml, escapeHtmlText, escapeHtmlAttr } from "../html.js";

test("escapeHtmlText escapes &, <, > (text-node context) and leaves quotes", () => {
  assert.equal(
    escapeHtmlText(`a & b < c > d "q" 'a'`),
    `a &amp; b &lt; c &gt; d "q" 'a'`,
  );
});

test('escapeHtmlAttr escapes & and " (double-quoted attr) and leaves <>', () => {
  assert.equal(escapeHtmlAttr(`x & "y" <z>`), `x &amp; &quot;y&quot; <z>`);
});

test("escapeHtml escapes the full five-char superset including the apostrophe", () => {
  assert.equal(escapeHtml(`& < > " '`), `&amp; &lt; &gt; &quot; &#39;`);
});

test("escapeHtml neutralises a single-quoted-attribute breakout payload", () => {
  const evil = `' onmouseover='alert(1)`;
  const escaped = escapeHtml(evil);
  assert.ok(!escaped.includes("'"), "no raw apostrophe survives");
  assert.equal(escaped, `&#39; onmouseover=&#39;alert(1)`);
});

test("null / undefined coerce to an empty string", () => {
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
  assert.equal(escapeHtmlText(null), "");
  assert.equal(escapeHtmlAttr(undefined), "");
});

test("non-string values are coerced via String()", () => {
  assert.equal(escapeHtml(42), "42");
  assert.equal(escapeHtml(true), "true");
});
