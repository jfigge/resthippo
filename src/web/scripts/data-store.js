/**
 * data-store.js — Persistence layer for collections data.
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

/**
 * Returns true when the renderer is running inside Electron and the
 * contextBridge collections API is available.
 */
function isElectron() {
  return (
    typeof window !== "undefined" &&
    window.wurl != null &&
    typeof window.wurl.collections?.load === "function"
  );
}

/**
 * Load the full collections array from persistent storage.
 * Returns an empty array on first run or on any error.
 *
 * @returns {Promise<object[]>}
 */
export async function loadCollections() {
  try {
    if (isElectron()) {
      return await window.wurl.collections.load();
    }

    // Go dev server — same origin, no CORS needed
    const res = await fetch("/api/collections");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return Array.isArray(data.collections) ? data.collections : [];
  } catch (err) {
    console.warn("[data-store] load failed:", err.message);
    return [];
  }
}

/**
 * Persist the full collections array.
 * Writes are fire-and-forget — errors are logged but not re-thrown.
 *
 * @param {object[]} items  - Full collections array as returned by TreeView.getItems()
 * @returns {Promise<void>}
 */
export async function saveCollections(items) {
  try {
    if (isElectron()) {
      await window.wurl.collections.save(items);
      return;
    }

    // Go dev server
    await fetch("/api/collections", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, collections: items }),
    });
  } catch (err) {
    console.warn("[data-store] save failed:", err.message);
  }
}

