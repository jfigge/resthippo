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
 * script-run-refs.js — static discovery of `hippo.run("…")` calls in a script.
 *
 * The scripting sandbox is a pure-compute, network-isolated worker, so the
 * `hippo.run(name)` API cannot itself fire an HTTP request. Instead the renderer
 * pre-executes any requests a script names BEFORE running it, then hands the
 * results into the sandbox so `hippo.run(name)` resolves synchronously (the same
 * prefetch model the `{{run(...)}}` template function uses).
 *
 * To know what to pre-execute we scan the script source for `hippo.run("Name")`
 * calls whose argument is a STRING LITERAL — exactly mirroring the literal-name
 * requirement of `{{run(...)}}`. A dynamic argument (a variable, a template with
 * `${…}`) can't be discovered statically and is left for `hippo.run` to reject at
 * runtime. This is a deliberately small lexical scan, not a JS parser.
 */
"use strict";

// hippo . run ( "literal" | 'literal' | `literal-without-interpolation`
// Whitespace is tolerated around the dots/paren the way a formatter might leave it.
const RUN_CALL =
  /\bhippo\s*\.\s*run\s*\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`([^`$\\]*)`)/g;

/**
 * Collect the (deduped, in first-seen order) request names referenced by
 * `hippo.run("…")` literal calls in a script.
 * @param {string} code  script source
 * @returns {string[]}   literal request names (empty if none / no string)
 */
export function extractScriptRunNames(code) {
  const src = typeof code === "string" ? code : "";
  if (!src) return [];
  const seen = new Set();
  const out = [];
  let m;
  RUN_CALL.lastIndex = 0;
  while ((m = RUN_CALL.exec(src)) !== null) {
    // Exactly one of the three quote groups matched; the others are undefined.
    const raw = m[1] ?? m[2] ?? m[3] ?? "";
    // Collapse the standard backslash escapes a user might type in a literal
    // (\" \' \\ …) down to the bare character — the actual request name.
    const name = raw.replace(/\\(.)/g, "$1");
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}
