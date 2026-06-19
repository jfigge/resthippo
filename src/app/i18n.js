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

// i18n.js — Main-process locale resolver + catalog reader.
"use strict";

/**
 * The renderer is sandboxed and cannot read files, and it is served from both
 * file:// and http:// — so the main process (which owns all filesystem I/O and
 * the OS locale) resolves the active locale and hands the renderer a ready-to-use
 * catalog over the `i18n:load` IPC channel.
 *
 * Resolution order for the active locale:
 *   1. the persisted preference (settings.locale), unless it is "system"
 *   2. otherwise the OS locale (app.getLocale(), e.g. "en-US")
 *   3. falling back to English when no catalog ships for the chosen language
 *
 * Catalogs are bundled JSON under src/web/locales (shipped via electron-builder's
 * "web/**" glob). The English catalog is always returned as the fallback so the
 * renderer can fill missing keys regardless of the active locale.
 */

const fs = require("fs");
const path = require("path");

/** Bundled catalog directory — resolved relative to this file (app/ → web/). */
const LOCALES_DIR = path.join(__dirname, "..", "web", "locales");

/**
 * Read and parse the catalog for a primary language subtag (e.g. "en", "es").
 * The subtag is validated against a strict pattern before being used in a path,
 * so a malformed locale can never escape LOCALES_DIR.
 * @param {string} lang
 * @returns {object|null} parsed catalog, or null when absent / unreadable
 */
function readCatalog(lang) {
  if (typeof lang !== "string" || !/^[a-z]{2,3}$/i.test(lang)) return null;
  try {
    return JSON.parse(
      fs.readFileSync(
        path.join(LOCALES_DIR, `${lang.toLowerCase()}.json`),
        "utf8",
      ),
    );
  } catch {
    return null;
  }
}

/**
 * Resolve the active locale and load its catalog plus the English fallback.
 * Always returns a usable payload, even when every read fails (empty catalogs).
 *
 * @param {{ requested?: string, systemLocale?: string }} [opts]
 *   requested     — settings.locale: "system" | a locale tag | undefined
 *   systemLocale  — app.getLocale(), e.g. "en-US"
 * @returns {{ requested: string, system: string, active: string, lang: string,
 *             messages: object, fallback: object }}
 */
function loadCatalog({ requested, systemLocale } = {}) {
  const en = readCatalog("en") || {};
  const system = String(systemLocale || "en");

  // Step 1–2: choose the desired locale tag.
  const desired =
    requested && requested !== "system" ? String(requested) : system;
  const lang = (desired.split("-")[0] || "en").toLowerCase();

  // Step 3: load it, falling back to English when no catalog ships.
  let active = desired;
  let messages = en;
  if (lang !== "en") {
    const loc = readCatalog(lang);
    if (loc) {
      messages = loc;
    } else {
      active = "en"; // no catalog for this language → English
    }
  }

  return {
    requested: requested || "system",
    system,
    active,
    lang: (active.split("-")[0] || "en").toLowerCase(),
    messages,
    fallback: en,
  };
}

/**
 * Resolve a dotted key against a loaded catalog payload (from loadCatalog),
 * following the same active → English-fallback → literal chain the renderer's
 * t() uses. For the few user-facing strings the main process renders itself
 * (the native Cut/Copy/Paste/Select All edit menu), which can't reach the
 * renderer's t().
 * @param {{ messages: object, fallback: object }} cat
 * @param {string} key       dotted key, e.g. "menu.cut"
 * @param {string} fallback  literal returned if the key is absent everywhere
 * @returns {string}
 */
function label(cat, key, fallback) {
  const pick = (obj) => {
    let node = obj;
    for (const part of key.split(".")) {
      if (node == null) return undefined;
      node = node[part];
    }
    return typeof node === "string" ? node : undefined;
  };
  return pick(cat?.messages) ?? pick(cat?.fallback) ?? fallback;
}

module.exports = { loadCatalog, readCatalog, LOCALES_DIR, label };
