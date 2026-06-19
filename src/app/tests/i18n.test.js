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

test("interpolation + plural placeholders survive translation", () => {
  // {name}/{label}/{message} must be preserved verbatim; CJK plural leaves keep
  // {count}. A dropped placeholder would render a literal gap to the user.
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
