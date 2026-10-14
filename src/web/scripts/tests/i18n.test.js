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
 * tests/i18n.test.js
 *
 * Unit tests for the renderer's internationalization layer (i18n.js) — the seam
 * every user-facing string passes through. These pin the contract components and
 * the catalogs rely on:
 *   • dotted-key lookup against a nested catalog;
 *   • {name} interpolation, with unknown placeholders left intact;
 *   • resolution order: active catalog → English fallback → the key itself
 *     (so an un-translated or un-migrated string never throws or blanks);
 *   • plural selection via Intl.PluralRules from a CLDR-category object;
 *   • locale-aware number/date formatting;
 *   • applyCatalog reflecting the active language onto <html lang>.
 *
 * The pure lookup/format surface is driven directly via applyCatalog() with
 * fixtures — no IPC and no Electron, mirroring how data-store.test.js stubs the
 * transport. jsdom is imported only so applyCatalog can set document lang.
 *
 * Run with:   node --test tests/i18n.test.js
 */

"use strict";

// Installs a jsdom document so applyCatalog can reflect <html lang>.
import "./jsdom-setup.js";

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  t,
  formatNumber,
  formatDate,
  getLocale,
  getLang,
  applyCatalog,
} from "../i18n.js";

// ── Fixtures ────────────────────────────────────────────────────────────────
// `es` is deliberately partial: it omits `items` and `only.en` so those exercise
// the English fallback path.
const en = {
  common: { cancel: "Cancel" },
  greeting: "Hello {name}",
  items: { one: "{count} item", other: "{count} items" },
  group: { nested: "leaf" },
  only: { en: "English only" },
};
const es = {
  common: { cancel: "Cancelar" },
  greeting: "Hola {name}",
};

function useEs() {
  applyCatalog({ active: "es", lang: "es", messages: es, fallback: en });
}
function useEn() {
  applyCatalog({ active: "en", lang: "en", messages: en, fallback: en });
}

// ── Lookup + interpolation ──────────────────────────────────────────────────

test("t(): resolves a dotted key against the active nested catalog", () => {
  useEs();
  assert.equal(t("common.cancel"), "Cancelar");
});

test("t(): interpolates {name} placeholders", () => {
  useEs();
  assert.equal(t("greeting", { name: "Ada" }), "Hola Ada");
});

test("t(): leaves unmatched placeholders intact", () => {
  useEn();
  // greeting expects {name}; with no params the placeholder is preserved.
  assert.equal(t("greeting"), "Hello {name}");
});

// ── Fallback chain ────────────────────────────────────────────────────────────

test("t(): falls back to the English catalog for a key missing in the active locale", () => {
  useEs(); // es has no `only.en`
  assert.equal(t("only.en"), "English only");
});

test("t(): falls back to the key itself when absent from both catalogs", () => {
  useEs();
  assert.equal(t("does.not.exist"), "does.not.exist");
});

test("t(): returns the key for a group node with no plural count", () => {
  useEn();
  // `group` is an object (not a leaf) and no numeric count was passed.
  assert.equal(t("group"), "group");
});

// ── Plurals ─────────────────────────────────────────────────────────────────

test("t(): selects the plural form via a numeric count", () => {
  useEn();
  assert.equal(t("items", { count: 1 }), "1 item");
  assert.equal(t("items", { count: 5 }), "5 items");
});

test("t(): plural lookup also follows the English fallback", () => {
  useEs(); // es omits `items` → resolved from en, then pluralized
  assert.equal(t("items", { count: 1 }), "1 item");
  assert.equal(t("items", { count: 2 }), "2 items");
});

// ── Format helpers ────────────────────────────────────────────────────────────

test("formatNumber(): groups digits for the active locale", () => {
  useEn();
  assert.equal(formatNumber(1234.5), "1,234.5");
});

test("formatDate(): returns '' for an invalid date and a non-empty string otherwise", () => {
  useEn();
  assert.equal(formatDate("not-a-date"), "");
  assert.equal(formatDate(NaN), "");
  assert.ok(formatDate(0).length > 0, "epoch formats to a non-empty string");
});

// ── Active-locale state ─────────────────────────────────────────────────────

test("applyCatalog(): exposes the active locale + language and sets <html lang>", () => {
  useEs();
  assert.equal(getLocale(), "es");
  assert.equal(getLang(), "es");
  assert.equal(document.documentElement.lang, "es");

  useEn();
  assert.equal(getLang(), "en");
  assert.equal(document.documentElement.lang, "en");
});

test("applyCatalog(): derives lang from a region-qualified tag and defaults safely", () => {
  applyCatalog({ active: "en-GB", messages: en, fallback: en });
  assert.equal(getLang(), "en");

  applyCatalog({});
  assert.equal(getLocale(), "en");
  assert.equal(t("anything"), "anything"); // empty catalog → key passthrough
});
