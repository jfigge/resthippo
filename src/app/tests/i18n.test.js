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
 * tests/i18n.test.js
 *
 * Tests the main-process locale resolver (app/i18n.js) against the real bundled
 * catalogs under web/locales. The renderer cannot read files or the OS locale,
 * so this module is the single place that decides which catalog the app speaks;
 * an off-by-one in the resolution order (persisted preference → OS locale →
 * English) would ship the wrong language with no other signal.
 *
 * Pins:
 *   • an explicit preference wins and loads its catalog;
 *   • "system" / absent preference resolves from the OS locale;
 *   • a language with no shipped catalog falls back to English (active + messages);
 *   • the English fallback catalog is always returned alongside the active one;
 *   • readCatalog rejects anything that isn't a bare language subtag (path-safety).
 *
 * Run with:   node --test tests/i18n.test.js
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadCatalog, readCatalog } = require("../i18n");

test("loadCatalog: an explicit preference loads that locale's catalog", () => {
  const r = loadCatalog({ requested: "es", systemLocale: "en-US" });
  assert.equal(r.active, "es");
  assert.equal(r.lang, "es");
  assert.equal(r.requested, "es");
  assert.equal(r.messages.common.cancel, "Cancelar");
  // The English catalog is always carried as the fallback.
  assert.equal(r.fallback.common.cancel, "Cancel");
});

test("loadCatalog: English preference returns the English catalog", () => {
  const r = loadCatalog({ requested: "en", systemLocale: "es-ES" });
  assert.equal(r.active, "en");
  assert.equal(r.lang, "en");
  assert.equal(r.messages.common.cancel, "Cancel");
});

test("loadCatalog: 'system' resolves from the OS locale (region-qualified)", () => {
  const r = loadCatalog({ requested: "system", systemLocale: "es-419" });
  assert.equal(r.lang, "es");
  assert.equal(r.messages.common.cancel, "Cancelar");
});

test("loadCatalog: an undefined preference behaves like 'system'", () => {
  const r = loadCatalog({ systemLocale: "es-ES" });
  assert.equal(r.requested, "system");
  assert.equal(r.lang, "es");
});

test("loadCatalog: a language with no catalog falls back to English", () => {
  // ko (Korean) ships no catalog, so it must fall back to English.
  const r = loadCatalog({ requested: "system", systemLocale: "ko-KR" });
  assert.equal(r.active, "en");
  assert.equal(r.lang, "en");
  assert.equal(r.messages.common.cancel, "Cancel");
  // system is still reported verbatim for diagnostics.
  assert.equal(r.system, "ko-KR");
});

test("loadCatalog: an unknown explicit locale falls back to English", () => {
  const r = loadCatalog({ requested: "zz", systemLocale: "en-US" });
  assert.equal(r.active, "en");
  assert.equal(r.messages.common.cancel, "Cancel");
});

test("loadCatalog: tolerates a missing systemLocale", () => {
  const r = loadCatalog({});
  assert.equal(r.active, "en");
  assert.equal(r.lang, "en");
});

test("readCatalog: loads a bundled catalog by subtag", () => {
  assert.equal(readCatalog("en").common.cancel, "Cancel");
  assert.equal(readCatalog("es").common.cancel, "Cancelar");
});

test("readCatalog: rejects non-subtag input (path traversal safety)", () => {
  assert.equal(readCatalog("../../package"), null);
  assert.equal(readCatalog("en/../en"), null);
  assert.equal(readCatalog(""), null);
  assert.equal(readCatalog(null), null);
  assert.equal(readCatalog("english-long"), null);
});

// ── Catalog completeness ──────────────────────────────────────────────────────
// en.json is the reference superset; every shipped locale must cover every one of
// its leaf keys so no string silently falls back to English. A plural object
// (only CLDR-category keys) counts as a single leaf, so a locale whose language
// has fewer plural forms than English is still complete.

const PLURAL_CATEGORIES = ["zero", "one", "two", "few", "many", "other"];
const isPluralLeaf = (v) =>
  v &&
  typeof v === "object" &&
  Object.keys(v).length > 0 &&
  Object.keys(v).every((k) => PLURAL_CATEGORIES.includes(k));

/** Collect dotted leaf-key paths from a catalog (skips _meta; plurals are leaves). */
function leafKeys(obj, prefix = "") {
  return Object.entries(obj).flatMap(([k, v]) => {
    if (k === "_meta") return [];
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !isPluralLeaf(v)) return leafKeys(v, key);
    return [key];
  });
}

const COMPLETE_LOCALES = ["de", "es", "fr", "it", "ja", "zh"];

test("every complete locale covers all en.json keys (no silent English fallback)", () => {
  const enKeys = new Set(leafKeys(readCatalog("en")));
  for (const loc of COMPLETE_LOCALES) {
    const cat = readCatalog(loc);
    assert.ok(cat, `${loc}.json is present and parses`);
    const have = new Set(leafKeys(cat));
    const missing = [...enKeys].filter((k) => !have.has(k));
    const extra = [...have].filter((k) => !enKeys.has(k));
    assert.deepEqual(
      missing,
      [],
      `${loc}.json missing keys: ${missing.join(", ")}`,
    );
    assert.deepEqual(
      extra,
      [],
      `${loc}.json has keys absent from en.json: ${extra.join(", ")}`,
    );
  }
});

test("interpolation + plural placeholders survive translation (spot checks)", () => {
  // The four highest-traffic interpolated strings, named explicitly so a failure
  // reads as "this sentence lost its {name}" rather than as a key path. The
  // exhaustive per-key version is the next test; this one stays because it says
  // WHICH strings matter most if both ever fail together.
  for (const loc of [...COMPLETE_LOCALES, "en"]) {
    const cat = readCatalog(loc);
    assert.match(cat.collections.delete.message, /\{name\}/, `${loc}: {name}`);
    assert.match(
      cat.notifications.actionFailed,
      /\{label\}/,
      `${loc}: {label}`,
    );
    assert.match(
      cat.notifications.actionFailedDetail,
      /\{label\}.*\{message\}/,
      `${loc}: {label}+{message}`,
    );
    const plural = cat.cookies.count;
    const form = plural.other ?? plural.one;
    assert.match(form, /\{count\}/, `${loc}: {count} in cookies.count`);
  }
});

// ── The stronger catalog checks (ported from Chip Hippo) ─────────────────────
// The coverage test above catches a MISSING key, which is the loudest failure.
// These three catch the quiet ones: a translation that kept the key but lost its
// placeholder, changed a plural into a flat string, or is simply blank. Each
// renders as a gap, a dead count, or nothing at all — and none of them shows up
// as an absent key.

/** Collect [dottedKey, leafValue] pairs (plurals count as one leaf). */
function leafEntries(obj, prefix = "") {
  return Object.entries(obj).flatMap(([k, v]) => {
    if (!prefix && k === "_meta") return [];
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !isPluralLeaf(v)) {
      return leafEntries(v, key);
    }
    return [[key, v]];
  });
}

/** The `{placeholder}` names in a leaf (string or plural object), sorted. */
function placeholdersOf(value) {
  const texts =
    typeof value === "string" ? [value] : Object.values(value ?? {});
  const found = new Set();
  for (const s of texts) {
    for (const m of String(s).matchAll(/\{(\w+)\}/g)) found.add(m[1]);
  }
  return [...found].sort();
}

test("every translation preserves its key's {placeholders}", () => {
  const en = leafEntries(readCatalog("en"));
  for (const loc of COMPLETE_LOCALES) {
    const cat = new Map(leafEntries(readCatalog(loc)));
    const wrong = [];
    for (const [key, enValue] of en) {
      const want = placeholdersOf(enValue);
      const got = placeholdersOf(cat.get(key));
      if (want.join(",") !== got.join(",")) {
        wrong.push(`${key}: expected {${want}}, got {${got}}`);
      }
    }
    assert.deepEqual(
      wrong,
      [],
      `${loc}.json changes the placeholders of ${wrong.length} key(s) — each ` +
        `would render as a literal gap:\n  ${wrong.join("\n  ")}`,
    );
  }
});

test("a plural key is a plural object in every locale, with an `other` form", () => {
  const en = leafEntries(readCatalog("en"));
  for (const loc of COMPLETE_LOCALES) {
    const cat = new Map(leafEntries(readCatalog(loc)));
    const wrong = [];
    for (const [key, enValue] of en) {
      const value = cat.get(key);
      const enPlural = isPluralLeaf(enValue);
      const trPlural = isPluralLeaf(value);
      if (enPlural && !trPlural) wrong.push(`${key}: not a plural object`);
      if (!enPlural && trPlural) wrong.push(`${key}: unexpectedly plural`);
      // `other` is the only category every language has, so it is the one that
      // must always be present — it is what an unmatched count falls back to.
      if (enPlural && trPlural && !value.other) {
        wrong.push(`${key}: a plural object with no "other" form`);
      }
    }
    assert.deepEqual(wrong, [], `${loc}.json: ${wrong.join("; ")}`);
  }
});

test("no catalog carries an empty or non-string value", () => {
  // A blank value passes a "does the key exist" check and renders as nothing —
  // a button with no label.
  for (const loc of [...COMPLETE_LOCALES, "en"]) {
    const bad = [];
    for (const [key, value] of leafEntries(readCatalog(loc))) {
      const texts = isPluralLeaf(value) ? Object.values(value) : [value];
      for (const s of texts) {
        if (typeof s !== "string")
          bad.push(`${key}: ${typeof s}, not a string`);
        else if (s.trim() === "") bad.push(`${key}: empty`);
      }
    }
    assert.deepEqual(bad, [], `${loc}.json: ${bad.join("; ")}`);
  }
});

// ── Every key the source asks for exists ────────────────────────────────────
// The check none of the above can be: `t("some.key")` with no such entry renders
// the literal text `some.key` on screen. Nothing else notices — the catalogs are
// consistent with each other, they just have no entry for what the code wants.

const fs = require("fs");
const path = require("path");

const SCRIPTS_DIR = path.join(__dirname, "..", "..", "web", "scripts");
const SCAN_SKIP_DIRS = new Set(["tests", "vendor"]);

function walkScripts(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      return SCAN_SKIP_DIRS.has(e.name) ? [] : walkScripts(p);
    }
    return e.name.endsWith(".js") ? [p] : [];
  });
}

test("every literal t() key in the renderer exists in en.json", () => {
  const enKeys = new Set(leafEntries(readCatalog("en")).map(([k]) => k));
  // The string has to be the WHOLE first argument — hence the trailing `[,)]`
  // and the key ending in a word character. Both are what keeps
  // `t("layout.option." + n)` (settings-popup.js builds a key that way) from
  // being reported as the missing key `layout.option.`, which it is not.
  const re = /\bt\(\s*"([a-z][A-Za-z0-9.\-_]*[A-Za-z0-9])"\s*[,)]/g;
  const used = new Map();
  for (const file of walkScripts(SCRIPTS_DIR)) {
    const rel = path.relative(SCRIPTS_DIR, file);
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      // Skip comments, so a JSDoc example is not read as a call site.
      if (
        trimmed.startsWith("*") ||
        trimmed.startsWith("//") ||
        trimmed.startsWith("/*")
      ) {
        continue;
      }
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line))) {
        if (!used.has(m[1])) used.set(m[1], new Set());
        used.get(m[1]).add(rel);
      }
    }
  }
  assert.ok(used.size > 100, `expected many call sites, found ${used.size}`);
  const unknown = [...used.entries()]
    .filter(([key]) => !enKeys.has(key))
    .map(([key, files]) => `${key}  (${[...files].sort().join(", ")})`)
    .sort();
  assert.deepEqual(
    unknown,
    [],
    `${unknown.length} key(s) are asked for but absent from en.json — each ` +
      `would render as its own dotted key on screen:\n  ${unknown.join("\n  ")}`,
  );
});
