/**
 * tests/no-hardcoded-strings.test.js
 *
 * The guardrail the i18n completeness gate can't be. `i18n.test.js` proves every
 * key already in the catalog is translated in every locale — but it is blind to
 * a user-facing string that never entered the catalog at all. This test is the
 * complement: it scans renderer source for display literals that bypass the
 * `t()` seam (CLAUDE.md: "never hardcode display text, placeholder, title, or
 * aria-label literals in new code"), so a fresh leak fails CI instead of
 * silently shipping English to every locale.
 *
 * Scope — the literal forms a component uses to put text on screen:
 *   • `el.textContent = "…"` / `.innerText = "…"`
 *   • `el.title = "…"` / `.placeholder = "…"` / `.ariaLabel = "…"`
 *   • `setAttribute("aria-label" | "title" | "placeholder", "…")`
 *   • `aria-label="…"` / `title="…"` / `placeholder="…"` inside HTML templates
 *   • UI-bearing object properties — `label:`/`text:`/`title:`/`hint:`/
 *     `placeholder:`/`ariaLabel:`/`desc:`/`description:`/`message:`/`tooltip:` —
 *     which is how field-builder helpers receive display text as a variable
 *     (`buildField("Username", …)` → `el.textContent = label`), invisible to the
 *     assignment rules above
 *   • `Notifications.error/warning/info/success/notify("…")` toast text
 *   • static text nodes / `<option>` labels in HTML templates (`>Cancel</…`),
 *     anchored on the closing `</` so JS comparisons never match
 *   • positional label args to this app's UI-builder helpers (`mkTab(id,
 *     "Requests")`, `#buildAuthFieldSelect(…)`, …) — a curated list, since the
 *     label rides a parameter the helper assigns with `el.textContent = label`
 * A line ending in an open `=` or `(` is joined onto the next before scanning,
 * so a label wrapped for length (`hint.textContent =\n  "…"`) is not a blind
 * spot. A literal counts only when it starts with an ASCII letter, so `${t("…")}`
 * interpolations (the correct form) and symbol/number values are ignored.
 * Property names that carry data not display text (`value:`, `key:`,
 * `className:`, `name:`) are deliberately excluded to keep new matches real, as
 * are the proper nouns in `INTENTIONAL` (format/font/theme names shown verbatim
 * in every locale).
 *
 * Ratchet, not a wall. The repo carries pre-existing debt, enumerated in
 * `no-hardcoded-strings.baseline.json` (keyed `relPath::literal`). The test
 * fails when:
 *   • a literal appears that is NOT in the baseline → a NEW leak: localize it;
 *   • a baseline entry no longer appears → it was fixed: drop it so the baseline
 *     can only shrink.
 * The baseline is meant to trend to empty as components are localized. After an
 * intentional change, regenerate it:
 *     UPDATE_HARDCODED_BASELINE=1 node --test tests/no-hardcoded-strings.test.js
 *
 * Run with:   node --test tests/no-hardcoded-strings.test.js
 */

"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.dirname(TESTS_DIR);
const BASELINE_FILE = path.join(
  TESTS_DIR,
  "no-hardcoded-strings.baseline.json",
);

// A literal value is `"…"` or `'…'` whose first char is an ASCII letter — which
// excludes `${t(…)}` interpolations (start with `$`) and symbol/number values.
const makeRe = (prefix, first = "A-Za-z") =>
  new RegExp(prefix + `(?:"([${first}][^"]*)"|'([${first}][^']*)')`, "g");

const RULES = [
  // ── Direct assignment / attribute forms ──────────────────────────────────
  makeRe(`\\.(?:textContent|innerText)\\s*=\\s*`),
  makeRe(`\\.(?:title|placeholder|ariaLabel)\\s*=\\s*`),
  makeRe(
    `setAttribute\\(\\s*["'](?:aria-label|title|placeholder)["']\\s*,\\s*`,
  ),
  makeRe(`(?:aria-label|title|placeholder)=`),
  // ── Helper-built / config forms (widened) ────────────────────────────────
  // UI-bearing object properties — a label/hint/etc. handed to a field-builder
  // helper, which then sets `el.textContent = label` from a *variable* the
  // assignment rules above can't see. The curated property-name list is the
  // precision mechanism (value names like `value:`/`key:`/`className:` carry
  // data, not display text, and are deliberately excluded).
  // An uppercase start is required here (unlike the assignment rules) so data
  // values that ride these property names — `true`/`false`, `text/plain`,
  // lowercase enum tokens — don't register; genuine UI labels are capital-start.
  makeRe(
    `\\b(?:label|text|title|hint|placeholder|ariaLabel|desc|description|message|tooltip)\\s*:\\s*`,
    "A-Z",
  ),
  // Toast text passed straight to a Notifications.* call.
  makeRe(`Notifications\\.(?:error|warning|info|success|notify)\\(\\s*`, "A-Z"),
  // Static text node / <option> label inside an HTML template literal
  // (`>Cancel</button>`, `<option>Header</option>`). Anchored on the closing
  // `</` so JS comparison operators (`a > B && c < D`) never match; a leading
  // capital excludes both `${…}` interpolations and lowercase technical tokens.
  />\s*([A-Z][^<>{}$]*?)\s*<\//g,
  // Positional display-label args to this app's UI-builder helpers — a label
  // passed by position rather than as `label:`, which the helper then assigns
  // via `el.textContent = label` (invisible to the rules above). Curated to the
  // codebase's builders so unrelated calls don't register; `[^)]*?` skips a
  // leading lowercase id arg (`mkTab("requests", "Requests")`), capital-start
  // keeps it to genuine labels.
  makeRe(
    `(?:mkTab|buildToolbarToggle|#buildAuthPillField|#buildAuthFieldSelect|#buildAuthScopeField|#appendDetailSection|#buildCaptureSelect)\\([^)]*?`,
    "A-Z",
  ),
];

// Proper nouns shown verbatim in every locale — interchange-format names, font
// names, theme names, and code-generation target names (language / library /
// CLI names like "Python — requests"). Not translatable prose, so they are
// excluded rather than left to sit in the debt baseline (and not given pointless
// verbatim t() keys).
const INTENTIONAL = new Set([
  "Postman v2.1",
  "Insomnia v4",
  "OpenAPI 3",
  "HAR 1.2",
  "Inter",
  "Roboto",
  "SF Pro (macOS)",
  "Segoe UI (Windows)",
  "Ubuntu (Linux)",
  "Grey",
  "Latte",
  "Mocha",
  // code-gen target labels (src/web/scripts/components/code-gen/*.js)
  "JavaScript — fetch",
  "Python — requests",
  "Go — net/http",
  "HTTPie",
]);

// tests/vendor are not product code; export/import are data transformers whose
// `description:`/`label:` strings populate generated files, not the UI.
const SKIP_DIRS = new Set(["tests", "vendor", "export", "import"]);
// Modules excluded by design, each for a declared reason — exclusion is a
// stated decision, not a hiding place:
//   • i18n.js     — holds the LOCALE_OPTIONS native language names, shown
//                   verbatim and never translated.
//   • icons.js    — a glyph registry, not translatable UI prose.
//   • docs-viewer.js — the in-app User Guide is shipped as English-only Markdown
//                   (a product decision; see CLAUDE.md "User Guide" + the docs
//                   screenshot pipeline), so its viewer chrome / contents nav
//                   stays English to match the pages it links to.
// (theme-editor.js — the separate Theme Editor window — is now i18n-wired and
//  fully localized, so it is scanned like any other component.)
const SKIP_FILES = new Set(["i18n.js", "icons.js", "docs-viewer.js"]);

/** Recursively collect .js files under dir, skipping non-product / non-UI code. */
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      out.push(...walk(p));
    } else if (e.name.endsWith(".js") && !SKIP_FILES.has(e.name)) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Scan all renderer source and return a sorted, de-duplicated set of
 * `relPath::literal` violations. De-duped by (file, value) so it survives line
 * moves; a value repeated in a file collapses to one entry.
 * @returns {string[]}
 */
function findViolations() {
  const violations = new Set();
  for (const file of walk(SCRIPTS_DIR)) {
    const rel = path.relative(SCRIPTS_DIR, file);
    const src = fs
      .readFileSync(file, "utf8")
      // Join a line that ends with an open `=` or `(` onto the next, so a label
      // wrapped for length — `hint.textContent =\n  "…"`, `Notifications.error(\n
      // "…")` — is still seen by the line-based rules. Only adds matches the
      // rules would make if the string sat on the prefix's line; the comment
      // skip below still fires because the merged line keeps the prefix's
      // leading `*`/`//`.
      .replace(/([=(])[ \t]*\n[ \t]*/g, "$1 ");
    for (const rawLine of src.split("\n")) {
      // Skip comment lines so JSDoc examples don't register as violations.
      const line = rawLine.trim();
      if (
        line.startsWith("*") ||
        line.startsWith("//") ||
        line.startsWith("/*")
      ) {
        continue;
      }
      for (const re of RULES) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(rawLine))) {
          const value = (m[1] ?? m[2]).trim();
          if (value && !INTENTIONAL.has(value)) {
            violations.add(`${rel}::${value}`);
          }
        }
      }
    }
  }
  return [...violations].sort();
}

test("no new hardcoded user-facing strings bypass the t() seam", () => {
  const current = findViolations();

  if (process.env.UPDATE_HARDCODED_BASELINE) {
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
    `New hardcoded user-facing string(s) — route through t() (or, if truly ` +
      `non-translatable, regenerate the baseline with ` +
      `UPDATE_HARDCODED_BASELINE=1):\n  ${unexpected.join("\n  ")}`,
  );
  assert.deepEqual(
    stale,
    [],
    `Baseline entr(ies) no longer found — these were localized. Shrink the ` +
      `baseline (UPDATE_HARDCODED_BASELINE=1) so it can't grow back:\n  ${stale.join("\n  ")}`,
  );
});
