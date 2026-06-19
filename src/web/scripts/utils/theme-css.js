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
 * utils/theme-css.js — build the CSS for a custom theme SAFELY.
 *
 * A custom theme's `vars` and `colorScheme` can arrive from an imported backup /
 * archive, i.e. untrusted input. Concatenating those values straight into a
 * `<style>` rule lets a value containing `}` break out of the rule and inject
 * arbitrary CSS app-wide (UI spoofing, hiding chrome, or exfiltration via
 * attribute selectors + `url()`). This module validates every key and value so
 * the produced rule cannot be escaped, and never emits a declaration it cannot
 * vouch for.
 *
 * Legitimate themes use `--color-*` custom-property keys and simple color
 * values (`#1e1e2e`, `rgb(...)`, `hsl(...)`); the theme editor itself validates
 * colour input as 6-hex. The guards below admit those and reject anything that
 * could alter CSS structure or fetch a URL.
 */

"use strict";

/** A valid CSS custom-property name: `--` followed by word chars / hyphens. */
const THEME_KEY_RE = /^--[\w-]+$/;

/**
 * Sequences a theme value must NOT contain. Any of these could end the
 * declaration or rule early (`;` `{` `}`), start an at-rule (`@`), open an
 * HTML/comment context (`<` `>` block comments), escape via backslash, or
 * trigger a network fetch (`url(`). `rgb(` / `hsl(` remain allowed — only
 * `url(` is singled out. With `;`/`{`/`}` excluded a value cannot break out of
 * its declaration or the rule, so no further declarations or selectors can be
 * injected.
 */
const THEME_VALUE_BAD = /[{}<>;@\\]|url\(|\/\*|\*\//i;

/**
 * @param {unknown} v
 * @returns {boolean} true when `v` is a string safe to drop into a CSS value.
 */
export function isSafeThemeValue(v) {
  return typeof v === "string" && v.length <= 256 && !THEME_VALUE_BAD.test(v);
}

/**
 * Build the `:root[data-theme="custom"] { … }` rule text for a custom theme,
 * dropping any key/value that fails validation. The result is always a single,
 * well-formed rule that cannot be escaped by its inputs.
 *
 * @param {{ colorScheme?: string, vars?: Record<string,string> }} theme
 * @returns {string} CSS rule text
 */
export function buildCustomThemeCss(theme) {
  // color-scheme is a normal property (not a custom prop), so constrain it to
  // the only two valid keywords rather than trusting the stored value.
  const scheme = theme?.colorScheme === "light" ? "light" : "dark";
  const lines = [`  color-scheme: ${scheme};`];
  for (const [k, v] of Object.entries(theme?.vars ?? {})) {
    if (typeof k === "string" && THEME_KEY_RE.test(k) && isSafeThemeValue(v)) {
      lines.push(`  ${k}: ${v};`);
    }
  }
  return `:root[data-theme="custom"] {\n${lines.join("\n")}\n}`;
}
