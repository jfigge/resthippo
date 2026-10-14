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
 * tests/event-registry.test.js
 *
 * Keeps the `hippo:*` global-event registry honest. CLAUDE.md requires the live
 * registry (names + payloads) at the top of initEventBus() in app.js to stay
 * current — but a comment can't enforce itself, and it had already drifted
 * (two dispatched events were undocumented). This guard scans every renderer
 * source file AND the preload bridge for an event that is actually dispatched
 * (`new CustomEvent("hippo:…")`) and fails when one is missing from the registry
 * comment, so a new event can't ship undocumented.
 *
 * Direction is dispatch ⊆ documented: every event some code emits must be in the
 * registry. (Listener-only names dispatched from the main process all arrive via
 * preload, which is scanned too.)
 *
 * Run with:  node --test src/web/scripts/tests/event-registry.test.js
 */

"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.dirname(TESTS_DIR); // src/web/scripts
const APP_JS = path.join(SCRIPTS_DIR, "app.js");
const PRELOAD_JS = path.join(SCRIPTS_DIR, "..", "..", "app", "preload.js");

const SKIP_DIRS = new Set(["vendor", "tests", "node_modules"]);
const DISPATCH_RE = /new CustomEvent\(\s*["']hippo:([a-z-]+)["']/g;

/** Recursively collect every non-test, non-vendor *.js file under `dir`. */
function jsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name))
        out.push(...jsFiles(path.join(dir, entry.name)));
    } else if (entry.name.endsWith(".js")) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/** The short names of every `hippo:*` event dispatched across the given files. */
function dispatchedEvents(files) {
  const names = new Map(); // name → first file that dispatches it (for diagnostics)
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(DISPATCH_RE)) {
      if (!names.has(m[1])) names.set(m[1], path.relative(SCRIPTS_DIR, file));
    }
  }
  return names;
}

/** Extract the registry comment block (header line → its closing full-width rule). */
function registryBlock() {
  const src = fs.readFileSync(APP_JS, "utf8");
  const headerIdx = src.indexOf("hippo:* global event registry");
  assert.ok(headerIdx >= 0, "registry comment header not found in app.js");
  const bodyStart = src.indexOf("\n", headerIdx) + 1;
  const body = src.slice(bodyStart);
  const close = body.search(/\/\/\s*─{20,}/); // closing full-width rule
  return close >= 0 ? body.slice(0, close) : body;
}

test("every dispatched hippo:* event is documented in the registry", () => {
  const block = registryBlock();
  const dispatched = dispatchedEvents([...jsFiles(SCRIPTS_DIR), PRELOAD_JS]);

  const undocumented = [];
  for (const [name, file] of dispatched) {
    // Whole-token match so `request-error` ≠ a substring of a longer name.
    const re = new RegExp(`(?<![\\w-])${name}(?![\\w-])`);
    if (!re.test(block)) undocumented.push(`${name}  (dispatched in ${file})`);
  }

  assert.deepEqual(
    undocumented,
    [],
    `These hippo:* events are dispatched but missing from the registry comment ` +
      `at the top of initEventBus() in app.js — add them:\n  ` +
      undocumented.join("\n  "),
  );
});

test("the registry block parses and is non-trivial", () => {
  const block = registryBlock();
  assert.ok(
    block.length > 500,
    "registry block looks too small — parsing broke?",
  );
});
