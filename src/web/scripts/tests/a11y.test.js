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
 * tests/a11y.test.js
 *
 * Accessibility (WCAG) regression gate. Runs axe-core over the app's primary
 * surfaces — the static index.html shell plus the three live renderer panels
 * (RequestEditor, ResponseViewer, TreeView) rendered under jsdom — and fails when
 * a NEW violation appears. Part of `make test`, so CI and the pre-commit hook
 * both catch a11y regressions before they ship.
 *
 * Scope & rule set — axe runs the wcag2a/wcag2aa/wcag21a/wcag21aa + best-practice
 * tags. Two rules are turned off because the headless harness can't judge them
 * honestly:
 *   • `color-contrast` — needs a real layout/paint engine; jsdom's
 *     getComputedStyle returns no resolved colors, so axe can only mark it
 *     "incomplete" (and noisily tries to spin up a <canvas>). Contrast is instead
 *     governed by the design tokens in styles/theme.css, which carry explicit
 *     `prefers-contrast: more` and `forced-colors: active` handling. If you want
 *     a real contrast pass, run axe in the live app over CDP (see e2e/).
 *   • `region` — a page-level "content must live in a landmark" rule. It stays ON
 *     for the full-page index.html scan, but is OFF for the isolated component
 *     subtree scans: in the real app each panel is mounted inside a landmark
 *     (`#panel-*` carry role="region" in index.html), which the isolated scan
 *     can't see.
 *
 * Ratchet, not a wall — mirrors no-hardcoded-strings.test.js. The repo carries
 * pre-existing a11y debt, enumerated in `a11y.baseline.json` (each entry a
 * `surface :: ruleId :: target` string). The test fails when:
 *   • a violation appears that is NOT in the baseline → a NEW regression: fix it;
 *   • a baseline entry no longer appears → it was fixed: drop it so the baseline
 *     can only shrink.
 * The baseline is meant to trend to empty. After an intentional change, or once a
 * debt item is fixed, regenerate it:
 *     UPDATE_A11Y_BASELINE=1 node --test src/web/scripts/tests/a11y.test.js
 *
 * Run with:   node --test src/web/scripts/tests/a11y.test.js
 */

"use strict";

// MUST precede the component imports (the Prism bundle reads `Element` on load),
// and it installs the en catalog so t()-built labels resolve to real text.
import { resetDom } from "./jsdom-setup.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import axe from "axe-core";

import { RequestEditor } from "../components/request-editor.js";
import { ResponseViewer } from "../components/response-viewer.js";
import { TreeView } from "../components/tree-view.js";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.dirname(TESTS_DIR);
const WEB_DIR = path.dirname(SCRIPTS_DIR);
const BASELINE_FILE = path.join(TESTS_DIR, "a11y.baseline.json");

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

// See the header note. color-contrast is off everywhere (no layout engine);
// region is off only for the isolated component subtrees.
const PAGE_RULES = { "color-contrast": { enabled: false } };
const COMPONENT_RULES = {
  "color-contrast": { enabled: false },
  region: { enabled: false },
};

/** Inject the axe library into a jsdom window once, return its `axe`. */
function injectAxe(window) {
  if (!window.axe) {
    // axe touches <canvas>.getContext() for some colour utilities even with
    // color-contrast off; jsdom has no canvas and would log a "Not implemented"
    // warning per run. Stub getContext to null (axe tolerates it) to keep the
    // `make test` output clean.
    if (window.HTMLCanvasElement) {
      window.HTMLCanvasElement.prototype.getContext = () => null;
    }
    window.eval(axe.source);
  }
  return window.axe;
}

/** Run axe within `window` over `node`; resolve to its violations array. */
async function runAxe(window, node, rules) {
  const ax = injectAxe(window);
  const results = await ax.run(node, {
    resultTypes: ["violations"],
    runOnly: { type: "tag", values: AXE_TAGS },
    rules,
  });
  return results.violations;
}

/** Flatten violations into stable ratchet keys: "surface :: ruleId :: target". */
function keysFrom(surface, violations) {
  const keys = [];
  for (const v of violations) {
    for (const n of v.nodes) {
      keys.push(`${surface} :: ${v.id} :: ${n.target.join(" ")}`);
    }
  }
  return keys;
}

// ── Surface scanners ──────────────────────────────────────────────────────────
// Each renders one surface and returns its violation keys. The component scanners
// share the global jsdom window (resetDom rebinds it), so they must run
// SEQUENTIALLY — a parallel run would clobber each other's document.

/** The hand-authored app shell, parsed without running its scripts. */
async function scanStaticShell() {
  const html = fs.readFileSync(path.join(WEB_DIR, "index.html"), "utf8");
  const dom = new JSDOM(html, {
    url: "http://localhost/",
    runScripts: "outside-only",
  });
  const keys = keysFrom(
    "index.html",
    await runAxe(dom.window, dom.window.document, PAGE_RULES),
  );
  dom.window.close();
  return keys;
}

async function scanRequestEditor() {
  const window = resetDom();
  window.hippo = { isElectron: false };
  const editor = new RequestEditor();
  document.body.appendChild(editor.element);
  editor.setVariableContext({ collectionVariables: {}, folderChain: [] });
  editor.load({
    id: "r",
    method: "GET",
    url: "https://api.example.com",
    params: [],
  });
  return keysFrom(
    "RequestEditor",
    await runAxe(window, document.body, COMPONENT_RULES),
  );
}

async function scanResponseViewer() {
  const window = resetDom();
  window.hippo = { isElectron: false };
  const viewer = new ResponseViewer();
  document.body.appendChild(viewer.element);
  return keysFrom(
    "ResponseViewer",
    await runAxe(window, document.body, COMPONENT_RULES),
  );
}

async function scanTreeView() {
  const window = resetDom();
  window.hippo = { isElectron: false };
  const tree = new TreeView();
  document.body.appendChild(tree.element);
  return keysFrom(
    "TreeView",
    await runAxe(window, document.body, COMPONENT_RULES),
  );
}

test("no new axe-core accessibility violations (ratchet against baseline)", async () => {
  const current = [];
  current.push(...(await scanStaticShell()));
  current.push(...(await scanRequestEditor()));
  current.push(...(await scanResponseViewer()));
  current.push(...(await scanTreeView()));
  current.sort();

  if (process.env.UPDATE_A11Y_BASELINE) {
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(current, null, 2) + "\n");
    return;
  }

  const baseline = new Set(JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8")));
  const currentSet = new Set(current);
  const unexpected = current.filter((v) => !baseline.has(v));
  const stale = [...baseline].filter((v) => !currentSet.has(v)).sort();

  assert.deepEqual(
    unexpected,
    [],
    `New accessibility violations detected by axe-core (fix them; if a change is ` +
      `intentional, regenerate the baseline with UPDATE_A11Y_BASELINE=1):\n  ` +
      unexpected.join("\n  "),
  );
  assert.deepEqual(
    stale,
    [],
    `Baseline a11y violations no longer present — they were fixed. Drop them from ` +
      `the baseline (UPDATE_A11Y_BASELINE=1) so it can only shrink:\n  ` +
      stale.join("\n  "),
  );
});
