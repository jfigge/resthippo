/**
 * data-store.js — Persistence layer for the wurl data document.
 *
 * The on-disk format is a single JSON file:
 *   { "version": 1, "collections": [...], "settings": { ... } }
 *
 * An in-memory document cache ensures that concurrent saves of collections
 * and settings never overwrite each other's keys.
 *
 * Environment detection:
 *   Electron (prod or --dev):  window.wurl.collections is exposed by preload.js
 *                               → uses ipcRenderer.invoke for main-process file I/O
 *                               → macOS:   ~/Library/Application Support/wurl/collections.json
 *                               → Linux:   ~/.config/wurl/collections.json
 *                               → Windows: %APPDATA%\wurl\collections.json
 *
 *   Go dev server (browser):   window.wurl is undefined
 *                               → uses fetch() against /api/collections REST endpoints
 *                               → file lives at <workspace>/data/collections.json
 */

"use strict";

/** Canonical default settings — merged over whatever is stored on disk. */
export const DEFAULT_SETTINGS = {
  theme:           "mocha",
  fontSize:        13,
  timeout:         30000,
  followRedirects: true,
  verifySsl:       true,
  proxyEnabled:    false,
  proxyUrl:        "",
  // Splitter positions in pixels (saved/restored across sessions)
  splitterNav:    240,   // --col-nav  (nav panel width, also used as height in portrait)
  splitterRes:    340,   // --col-res  (response panel width in landscape)
  splitterRowRes: 320,   // --row-res  (response panel height in between/portrait)
  // Editor preferences
  listHeaders:    true,  // show standard-header suggestions in the Headers tab
  showUrlPreview: true,  // show the URL-with-params preview bar in the Params tab
};

// ── In-memory document cache ──────────────────────────────────────────────────
// Keeping the full doc in memory prevents concurrent saves (collections vs
// settings) from clobbering each other's keys.
let _doc = {
  version:     1,
  collections: [],
  settings:    { ...DEFAULT_SETTINGS },
};

// ── Environment detection ─────────────────────────────────────────────────────

function isElectron() {
  return (
    typeof window !== "undefined" &&
    window.wurl != null &&
    typeof window.wurl.collections?.load === "function"
  );
}

// ── Internal write ────────────────────────────────────────────────────────────

async function _persist() {
  try {
    if (isElectron()) {
      await window.wurl.collections.save(_doc);
      return;
    }
    await fetch("/api/collections", {
      method:  "PUT",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(_doc),
    });
  } catch (err) {
    console.warn("[data-store] save failed:", err.message);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Load the full data document from persistent storage on startup.
 * Populates the in-memory cache and returns { collections, settings }.
 * Returns safe defaults on first run or on any error.
 *
 * @returns {Promise<{ collections: object[], settings: object }>}
 */
export async function loadAll() {
  try {
    let raw;
    if (isElectron()) {
      raw = await window.wurl.collections.load();
    } else {
      const res = await fetch("/api/collections");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      raw = await res.json();
    }

    _doc = {
      version:     raw.version ?? 1,
      collections: Array.isArray(raw.collections) ? raw.collections : [],
      settings:    { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
    };
  } catch (err) {
    console.warn("[data-store] load failed:", err.message);
    _doc = { version: 1, collections: [], settings: { ...DEFAULT_SETTINGS } };
  }

  return { collections: _doc.collections, settings: _doc.settings };
}

/**
 * Persist an updated collections array.
 * Merges into the cached document, then atomically writes the full document.
 *
 * @param {object[]} items  - Full collections array as returned by TreeView.getItems()
 * @returns {Promise<void>}
 */
export async function saveCollections(items) {
  _doc = { ..._doc, collections: items };
  await _persist();
}

/**
 * Persist updated settings.
 * Merges into the cached document, then atomically writes the full document.
 *
 * @param {object} settings  - Plain settings object (see DEFAULT_SETTINGS for shape)
 * @returns {Promise<void>}
 */
export async function saveSettings(settings) {
  _doc = { ..._doc, settings };
  await _persist();
}
