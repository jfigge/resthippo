"use strict";

/**
 * i18n.js — Lightweight internationalization layer for the renderer.
 *
 * The single seam every user-facing string passes through. Components call
 * `t("area.component.label")` instead of hardcoding English; the active locale's
 * catalog is resolved once at startup and held in module state, so `t()` is a
 * synchronous lookup thereafter.
 *
 * Loading model
 * -------------
 * The renderer is sandboxed and is served two ways — file:// (packaged / `make
 * debug`) and http:// (Go dev server) — so it cannot read catalog files itself.
 * The Electron main process owns all filesystem I/O and the OS locale
 * (`app.getLocale()`), so it resolves the active locale (persisted override →
 * system locale → English) and returns the ready-to-use catalog over IPC
 * (`window.wurl.i18n.load`). `init()` awaits that once, before any component
 * renders. A plain-browser dev context (no preload) falls back to fetching the
 * bundled JSON over http.
 *
 * Catalog shape
 * -------------
 * Catalogs are bundled JSON grouped by area; keys are dotted paths resolved
 * against the nested object (`t("settings.nav.appearance")` → catalog.settings
 * .nav.appearance). A missing key falls back to the English catalog, then to the
 * key itself, so an un-migrated or un-translated string never throws or blanks.
 *
 * Conventions
 * -----------
 *   • Key convention: `area.component.label` (lowerCamel leaf).
 *   • Interpolation: `{name}` placeholders, filled from the params object.
 *   • Plurals: a leaf may be an object of CLDR categories ({ one, other, … });
 *     pass a numeric `count` param and the right form is selected via
 *     Intl.PluralRules for the active locale.
 *   • NEVER call t() at module top-level — the catalog is not loaded until
 *     init() runs. Call it inside render methods / functions only.
 *
 * Usage:
 *   import { t, formatNumber, formatDate } from "./i18n.js";
 *   button.textContent = t("common.cancel");
 *   label.textContent = t("history.entries", { count: n });   // "5 entries"
 */

// ── Module state ──────────────────────────────────────────────────────────────

/** @type {string} active locale tag (e.g. "en", "es", "en-US") */
let _active = "en";
/** @type {string} primary language subtag, mirrored to <html lang> */
let _lang = "en";
/** @type {object} active locale catalog (nested by area) */
let _messages = {};
/** @type {object} English catalog — always the fallback for missing keys */
let _fallback = {};
/** @type {Intl.PluralRules|null} lazily built for the active locale */
let _pluralRules = null;

// ── Lookup + interpolation ──────────────────────────────────────────────────

/**
 * Resolve a dotted key against a nested catalog object.
 * @param {object} catalog
 * @param {string} key
 * @returns {string|object|undefined}
 */
function _lookup(catalog, key) {
  if (!catalog) return undefined;
  // Fast path: a key stored verbatim (flat catalogs / leaf at the top level).
  if (Object.prototype.hasOwnProperty.call(catalog, key)) return catalog[key];
  let node = catalog;
  for (const part of key.split(".")) {
    if (node == null || typeof node !== "object") return undefined;
    node = node[part];
  }
  return node;
}

/**
 * Replace `{name}` placeholders with values from params. Unmatched placeholders
 * are left intact so a missing param is visible rather than silently dropped.
 * @param {string} str
 * @param {object} [params]
 * @returns {string}
 */
function _interpolate(str, params) {
  if (!params) return str;
  return str.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name)
      ? String(params[name])
      : match,
  );
}

/**
 * CLDR plural category for a count under the active locale.
 * @param {number} count
 * @returns {string} "zero"|"one"|"two"|"few"|"many"|"other"
 */
function _pluralCategory(count) {
  try {
    if (!_pluralRules) _pluralRules = new Intl.PluralRules(_active);
    return _pluralRules.select(count);
  } catch {
    return count === 1 ? "one" : "other";
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Translate a key with optional interpolation / pluralization.
 *
 * Resolution order: active catalog → English fallback → the key itself.
 * If the resolved value is an object of CLDR plural categories and a numeric
 * `count` param is supplied, the matching form is selected and interpolated.
 *
 * @param {string} key            dotted catalog key (e.g. "common.cancel")
 * @param {object} [params]       interpolation values; numeric `count` enables plurals
 * @returns {string}
 */
export function t(key, params) {
  let msg = _lookup(_messages, key);
  if (msg === undefined) msg = _lookup(_fallback, key);
  if (msg === undefined) return key;

  if (msg && typeof msg === "object") {
    if (params && typeof params.count === "number") {
      const cat = _pluralCategory(params.count);
      msg = msg[cat] ?? msg.other ?? msg.one;
      if (msg === undefined) return key;
    } else {
      // A group node, not a leaf string — nothing renderable.
      return key;
    }
  }
  return _interpolate(String(msg), params);
}

/**
 * Locale-aware number formatting (thin Intl.NumberFormat wrapper).
 * @param {number} value
 * @param {Intl.NumberFormatOptions} [opts]
 * @returns {string}
 */
export function formatNumber(value, opts) {
  try {
    return new Intl.NumberFormat(_active, opts).format(value);
  } catch {
    return String(value);
  }
}

/**
 * Locale-aware date/time formatting (thin Intl.DateTimeFormat wrapper).
 * @param {Date|number|string} value
 * @param {Intl.DateTimeFormatOptions} [opts]
 * @returns {string} "" for an invalid date
 */
export function formatDate(
  value,
  opts = { dateStyle: "medium", timeStyle: "short" },
) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(_active, opts).format(d);
  } catch {
    return d.toLocaleString();
  }
}

/** @returns {string} active locale tag */
export function getLocale() {
  return _active;
}

/** @returns {string} active primary language subtag */
export function getLang() {
  return _lang;
}

/**
 * Apply a resolved catalog payload to module state. Exposed for testing and for
 * init(); also reflects the active language onto <html lang> when a document is
 * present.
 * @param {{ active?: string, lang?: string, messages?: object, fallback?: object }} [payload]
 */
export function applyCatalog({ active, lang, messages, fallback } = {}) {
  _active = active || "en";
  _lang = lang || _active.split("-")[0] || "en";
  _messages = messages || {};
  _fallback = fallback || _messages || {};
  _pluralRules = null;
  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.lang = _lang;
  }
}

/**
 * Locale choices for the settings picker. "system" follows the OS locale; the
 * rest map to a shipped catalog. Native language names are intentionally not
 * translated (they read the same in every UI language).
 */
export const LOCALE_OPTIONS = [
  { value: "system", labelKey: "settings.appearance.languageSystem" },
  { value: "en", label: "English" },
  { value: "de", label: "Deutsch" },
  { value: "es", label: "Español" },
  { value: "fr", label: "Français" },
  { value: "it", label: "Italiano" },
  { value: "ja", label: "日本語" },
  { value: "zh", label: "中文（简体）" },
];

/**
 * Resolve and apply the active catalog. Call once, before any component renders.
 * Prefers the Electron IPC bridge (covers file:// and http:// under Electron);
 * falls back to fetching bundled JSON in a plain-browser dev context.
 * @returns {Promise<string>} the active locale tag
 */
export async function init() {
  let payload = null;
  try {
    if (typeof window !== "undefined" && window.wurl?.i18n?.load) {
      payload = await window.wurl.i18n.load();
    }
  } catch (err) {
    console.warn("[i18n] catalog load over IPC failed:", err?.message);
  }
  if (!payload) payload = await _fetchFallback();
  applyCatalog(payload);
  return _active;
}

/**
 * Plain-browser fallback: fetch the bundled catalog over http. Never reached
 * under Electron (the IPC path handles file:// and http there). Degrades to an
 * empty catalog — t() then returns keys — if fetch is unavailable or fails.
 * @returns {Promise<object>}
 */
async function _fetchFallback() {
  const empty = { active: "en", lang: "en", messages: {}, fallback: {} };
  if (typeof fetch !== "function") return empty;
  try {
    const navLang =
      (typeof navigator !== "undefined" && navigator.language) || "en";
    const lang = navLang.split("-")[0];
    const en = await fetch("locales/en.json").then((r) =>
      r.ok ? r.json() : {},
    );
    let messages = en;
    let active = "en";
    if (lang !== "en") {
      const loc = await fetch(`locales/${lang}.json`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      if (loc) {
        messages = loc;
        active = lang;
      }
    }
    return { active, lang: active, messages, fallback: en };
  } catch {
    return empty;
  }
}
