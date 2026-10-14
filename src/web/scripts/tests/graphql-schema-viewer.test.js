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
 * tests/graphql-schema-viewer.test.js
 *
 * GraphQLSchemaViewer renders a server-supplied SDL string as syntax-highlighted
 * HTML — the one untrusted-data sink in the viewer. This guards that the SDL is
 * always escaped (via Prism.highlight, or the escapeHtml fallback when the
 * grammar is absent) so a hostile schema can never inject live DOM.
 *
 * jsdom-setup MUST be imported first: it installs the DOM globals + i18n catalog
 * and the Prism vendor bundle dereferences `Element` at module-load.
 */

"use strict";

import "./jsdom-setup.js";

import { test } from "node:test";
import assert from "node:assert/strict";

import { GraphQLSchemaViewer } from "../components/graphql-schema-viewer.js";

test("GraphQLSchemaViewer: hostile SDL is escaped, never rendered as live HTML", () => {
  // `</code>` would break out of the <code> block if unescaped; the img/script
  // would then be live nodes.
  const hostile =
    "type Query { ok: String }\n" +
    '# </code><img src=x onerror="boom()"><script>boom()</script>';
  const el = new GraphQLSchemaViewer({ sdl: hostile }).element;

  const code = el.querySelector("code");
  assert.ok(code, "code block rendered");
  // No injected live nodes anywhere in the viewer.
  assert.equal(el.querySelector("img"), null, "img must not be a live node");
  assert.equal(
    el.querySelector("script"),
    null,
    "script must not be a live node",
  );
  // The hostile markup survives as escaped TEXT, proving it was neutralized.
  assert.match(code.textContent, /<img src=x onerror=/);
  assert.match(code.textContent, /<script>boom\(\)<\/script>/);
});

test("GraphQLSchemaViewer: empty / missing SDL renders an empty code block, no throw", () => {
  const el = new GraphQLSchemaViewer({}).element;
  const code = el.querySelector("code");
  assert.ok(code);
  assert.equal(code.textContent, "");
});
