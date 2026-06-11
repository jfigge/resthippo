/**
 * tests/no-hardcoded-native-strings.test.js
 *
 * The main-process counterpart to the renderer's no-hardcoded-strings guard.
 * The renderer scanner only reads src/web/scripts, so it is blind to the strings
 * the *main process* renders itself — the native application menu and the OS
 * dialogs (file pickers, message boxes), which can't reach the renderer's t().
 * Those all live in main.js, and they must resolve through the catalog the same
 * way (via the `activeLabels()` → `i18nLabel(cat, key, fallback)` seam) so a
 * non-English user sees the menu bar and dialogs in their language.
 *
 * This test scans main.js for display literals assigned to the native-UI option
 * keys a Menu template / dialog.show* call uses:
 *   • `label:  "…"`               — menu item labels
 *   • `title:  "…"`               — window / dialog titles
 *   • `message:"…"` / `detail:"…"`— message-box body lines
 *   • `buttonLabel:"…"`           — dialog button labels
 *   • `buttons: ["…", …]`         — message-box button arrays
 * A localized call reads `label: m("menu.file", "File")`, so the literal sits as
 * the *fallback argument to m()* (preceded by `, `), not directly after `label:`
 * — invisible to these rules. A regression that drops the m() wrapper puts the
 * literal right after the key again and fails here.
 *
 * Two escape hatches, both narrow and enumerated:
 *   • INTENTIONAL — proper nouns shown verbatim in every locale ("wurl").
 *   • BASELINE    — pre-existing debt that is NOT a native-UI string: structured
 *     `error: { name, message }` payloads returned over IPC and displayed by the
 *     renderer. Those belong to a separate renderer-side error-name → t() mapping,
 *     not the native menu/dialog seam; they are enumerated here so the guard can
 *     still catch a *new* native-UI leak. The set may only shrink (a vanished
 *     entry fails too), so localizing one of them forces its removal.
 *
 * Run with:   node --test tests/no-hardcoded-native-strings.test.js
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const MAIN_FILE = path.join(__dirname, "..", "main.js");

// Native-UI option keys whose value, when a bare string literal, is on-screen text.
const KEY_RE = /\b(?:label|title|message|detail|buttonLabel)\s*:\s*"([^"]+)"/g;
// `buttons: ["OK", …]` — flag the first literal in the array.
const BUTTONS_RE = /\bbuttons\s*:\s*\[\s*"([^"]+)"/g;

// Proper nouns shown verbatim in every locale (the app name).
const INTENTIONAL = new Set(["wurl"]);

// Pre-existing, non-native-UI debt: structured error payloads returned over IPC
// and rendered by the renderer (keyed by their `name`), not by the menu/dialog
// seam. Localize via a renderer error-name → t() mapping, then delete from here.
const BASELINE = new Set([
  "The full response is no longer cached.",
  "complex jq queries require the dev server",
]);

/** Scan main.js and return the sorted set of flagged display literals. */
function findViolations() {
  const src = fs.readFileSync(MAIN_FILE, "utf8");
  const found = new Set();
  for (const rawLine of src.split("\n")) {
    const line = rawLine.trim();
    // Skip comment lines so JSDoc / inline examples don't register.
    if (
      line.startsWith("*") ||
      line.startsWith("//") ||
      line.startsWith("/*")
    ) {
      continue;
    }
    for (const re of [KEY_RE, BUTTONS_RE]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(rawLine))) {
        const value = m[1].trim();
        if (value && !INTENTIONAL.has(value)) found.add(value);
      }
    }
  }
  return [...found].sort();
}

test("native menu / dialog strings resolve through the catalog (no hardcoded English)", () => {
  const current = findViolations();

  const unexpected = current.filter((v) => !BASELINE.has(v));
  const stale = [...BASELINE].filter((v) => !current.includes(v)).sort();

  assert.deepEqual(
    unexpected,
    [],
    `New hardcoded native-UI string(s) in main.js — route through ` +
      `activeLabels()/i18nLabel (m("area.key", "fallback")):\n  ${unexpected.join("\n  ")}`,
  );
  assert.deepEqual(
    stale,
    [],
    `BASELINE entr(ies) no longer found — these were localized. Remove them ` +
      `from BASELINE so it can only shrink:\n  ${stale.join("\n  ")}`,
  );
});
