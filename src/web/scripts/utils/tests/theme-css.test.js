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
 * theme-css.test.js — the custom-theme CSS builder must be injection-proof, as a
 * custom theme can arrive verbatim from an imported (untrusted) backup.
 *
 * Run with:  node --test src/web/scripts/utils/tests/theme-css.test.js
 */
"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildCustomThemeCss, isSafeThemeValue } from "../theme-css.js";

test("emits valid custom-property declarations for a legitimate theme", () => {
  const css = buildCustomThemeCss({
    colorScheme: "dark",
    vars: {
      "--color-base": "#1e1e2e",
      "--color-accent": "rgb(137, 180, 250)",
    },
  });
  assert.match(css, /^:root\[data-theme="custom"\] \{/);
  assert.match(css, /color-scheme: dark;/);
  assert.match(css, /--color-base: #1e1e2e;/);
  assert.match(css, /--color-accent: rgb\(137, 180, 250\);/);
});

test("a value that tries to break out of the rule is dropped", () => {
  const css = buildCustomThemeCss({
    colorScheme: "dark",
    vars: {
      "--color-base": "red; } body { background: url(https://attacker/leak) }",
      "--ok": "#abcdef",
    },
  });
  // The injected rule never appears; the only "}" is the rule's own closer.
  assert.equal((css.match(/\}/g) || []).length, 1);
  assert.doesNotMatch(css, /attacker/);
  assert.doesNotMatch(css, /url\(/i);
  // The legitimate sibling var is still emitted.
  assert.match(css, /--ok: #abcdef;/);
});

test("drops url() exfiltration, bad keys, and at-rule attempts", () => {
  const css = buildCustomThemeCss({
    colorScheme: "dark",
    vars: {
      "--evil-url": "url(https://attacker/x)",
      "color: red; } html {": "x", // malformed key
      "--at": "@import url(x)",
      "--good": "#123456",
    },
  });
  assert.doesNotMatch(css, /url\(/i);
  assert.doesNotMatch(css, /@import/);
  assert.doesNotMatch(css, /html \{/);
  assert.match(css, /--good: #123456;/);
});

test("constrains color-scheme to light|dark regardless of the stored value", () => {
  assert.match(
    buildCustomThemeCss({ colorScheme: "light", vars: {} }),
    /color-scheme: light;/,
  );
  const injected = buildCustomThemeCss({
    colorScheme: "dark; } * { display: none }",
    vars: {},
  });
  assert.match(injected, /color-scheme: dark;/);
  assert.equal((injected.match(/\}/g) || []).length, 1);
});

test("tolerates a missing/empty theme without throwing", () => {
  assert.match(buildCustomThemeCss({}), /color-scheme: dark;/);
  assert.match(buildCustomThemeCss(null), /color-scheme: dark;/);
  assert.match(buildCustomThemeCss({ vars: null }), /:root\[data-theme/);
});

test("isSafeThemeValue admits colors and rejects structural characters", () => {
  for (const v of ["#1e1e2e", "rgb(1, 2, 3)", "hsl(220, 50%, 60%)", "white"]) {
    assert.equal(isSafeThemeValue(v), true, `${v} should be safe`);
  }
  for (const v of [
    "a}b",
    "x;y",
    "url(z)",
    "a{b",
    "<x>",
    "@media",
    "a\\b",
    5,
    null,
  ]) {
    assert.equal(
      isSafeThemeValue(v),
      false,
      `${JSON.stringify(v)} should be unsafe`,
    );
  }
});
