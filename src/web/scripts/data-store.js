/**
 * data-store.js — Persistence layer for the wurl data document.
 *
 * Storage layout (new per-file architecture):
 *
 *   collections/index.json          — manifest:
 *     { version: 2, collections: [{id, name}], activeCollectionId, settings }
 *
 *   collections/<collId>/           — per-collection data:
 *     metadata.json                 — { id, variables }
 *     tree.json                     — lightweight nav tree
 *     requests/<reqId>.json         — one file per request
 *     history/<reqId>/<histId>.json — execution metadata
 *     responses/<reqId>/<histId>.json — full response payloads (lazy)
 *
 * Transport detection:
 *   Electron:      window.wurl.store  (new IPC channels via preload.js)
 *   Go dev server: fetch() against /api/*  (Go backend REST APIs)
 *
 * Public API (consumed by app.js and other renderer modules):
 *
 *   Core (manifest + collection blob):
 *     loadAll()                              → startup data
 *     saveCollections(items)                 → persist active collection's item tree
 *     saveSettings(settings)
 *     saveManifest({ collections, activeCollectionId, settings? })
 *     loadCollectionData(collectionId)       → { items, variables }
 *     saveCollectionData(collectionId, items, variables?)
 *     setActiveCollection(collectionId)
 *     saveCollectionVariables(collectionId, variables)
 *
 *   Granular (request + history):
 *     deleteRequest(id)
 *     listHistory(requestId, options?)       → { items, nextCursor }
 *     addHistory(requestId, entry, response?)→ stored entry
 *     getHistoryResponse(requestId, histId)  → response payload
 *     deleteHistory(requestId, histId)       → void
 */

"use strict";

/** Canonical default settings — merged over whatever is stored on disk. */
const DEFAULT_SETTINGS = {
  theme:           "mocha",
  fontSize:        13,
  fontFamily:      "inter",
  layout:          1,
  timeout:         30000,
  followRedirects: true,
  verifySsl:       true,
  proxyEnabled:    false,
  proxyUrl:        "",
  splitterNav:    240,
  splitterRes:    340,
  splitterRowRes: 320,
  listHeaders:       true,
  showUrlPreview:    true,
  varsBulkEditor:    true,
  selectedRequestIds: {},
  responseBodyRenderMode: "styled",
  oauth2Advanced:    false,
  historyCount:      5,
};

// ── In-memory caches ──────────────────────────────────────────────────────────

let _manifest = {
  version:           2,
  collections:       [],
  activeCollectionId: null,
  settings:          { ...DEFAULT_SETTINGS },
};

/** The collection ID currently used by saveCollections(). */
let _activeCollectionId = null;

/** Cached items for the active collection. */
let _activeItems = [];

/** Cached variables for the active collection. */
let _activeVariables = {};

// ── Transport detection ───────────────────────────────────────────────────────

/**
 * Returns true when running inside Electron (new store API surface present).
 * @returns {boolean}
 */
function isElectron() {
  return (
    typeof window !== "undefined" &&
    window.wurl != null &&
    typeof window.wurl.store?.manifest?.get === "function"
  );
}

// ── Low-level manifest I/O ────────────────────────────────────────────────────

async function _loadManifest() {
  try {
    if (isElectron()) return await window.wurl.store.manifest.get();
    const res = await fetch("/api/collections");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn("[data-store] manifest load failed:", err.message);
    return { version: 2, collections: [], activeCollectionId: null, settings: {} };
  }
}

async function _persistManifest() {
  try {
    if (isElectron()) {
      await window.wurl.store.manifest.save(_manifest);
      return;
    }
    await fetch("/api/collections", {
      method:  "PUT",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(_manifest),
    });
  } catch (err) {
    console.warn("[data-store] manifest save failed:", err.message);
  }
}

// ── Low-level per-collection I/O ──────────────────────────────────────────────
// The "env blob" shape is: { version: 1, collections: [...], variables: {...} }
// It is assembled from / decomposed into the new per-file layout transparently.

async function _loadEnvFile(collectionId) {
  try {
    let raw;
    if (isElectron()) {
      raw = await window.wurl.store.env.get(collectionId);
    } else {
      const res = await fetch(`/api/env?id=${encodeURIComponent(collectionId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      raw = await res.json();
    }
    return {
      items:     Array.isArray(raw?.collections) ? raw.collections : [],
      variables: (raw?.variables && typeof raw.variables === "object") ? raw.variables : {},
    };
  } catch (err) {
    console.warn(`[data-store] env load failed (${collectionId}):`, err.message);
    return { items: [], variables: {} };
  }
}

async function _saveEnvFile(collectionId, items, variables = {}) {
  try {
    if (isElectron()) {
      await window.wurl.store.env.save(collectionId, { version: 1, collections: items, variables });
      return;
    }
    await fetch(`/api/env?id=${encodeURIComponent(collectionId)}`, {
      method:  "PUT",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ version: 1, collections: items, variables }),
    });
  } catch (err) {
    console.warn(`[data-store] env save failed (${collectionId}):`, err.message);
  }
}

// ── Public: core API ──────────────────────────────────────────────────────────

/**
 * Load the full application state on startup.
 *
 * @returns {Promise<{
 *   collections:        {id:string, name:string}[],
 *   activeCollectionId: string,
 *   settings:           object,
 *   items:              object[],
 *   variables:          object,
 * }>}
 */
export async function loadAll() {
  try {
    const raw = await _loadManifest();

    // Migration: support both old (environments/activeEnvironmentId) and new keys
    let collections = Array.isArray(raw.collections)
      ? raw.collections
      : (Array.isArray(raw.environments) ? raw.environments : []);
    let activeId = raw.activeCollectionId ?? raw.activeEnvironmentId ?? null;

    // Seed a default collection on true first-run (empty manifest)
    if (collections.length === 0) {
      const defaultId = crypto.randomUUID();
      collections     = [{ id: defaultId, name: "COLLECTIONS" }];
      activeId        = defaultId;
    }

    // Guard: activeId must reference a real collection
    if (!collections.find(c => c.id === activeId)) {
      activeId = collections[0].id;
    }

    _manifest = {
      version:           2,
      collections,
      activeCollectionId: activeId,
      settings:          { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
    };
    _activeCollectionId = activeId;

    const { items, variables } = await _loadEnvFile(activeId);
    _activeItems     = items;
    _activeVariables = variables;

    return {
      collections:        _manifest.collections,
      activeCollectionId: _activeCollectionId,
      settings:           _manifest.settings,
      items,
      variables,
    };
  } catch (err) {
    console.warn("[data-store] load failed:", err.message);
    const defaultId = crypto.randomUUID();
    _manifest = {
      version:           2,
      collections:       [{ id: defaultId, name: "COLLECTIONS" }],
      activeCollectionId: defaultId,
      settings:          { ...DEFAULT_SETTINGS },
    };
    _activeCollectionId = defaultId;
    _activeItems        = [];
    _activeVariables    = {};
    return {
      collections:        _manifest.collections,
      activeCollectionId: _activeCollectionId,
      settings:           _manifest.settings,
      items:              [],
      variables:          {},
    };
  }
}

/**
 * Persist an updated items array for the currently active collection.
 * @param {object[]} items
 */
export async function saveCollections(items) {
  if (_activeCollectionId) {
    _activeItems = items;
    await _saveEnvFile(_activeCollectionId, items, _activeVariables);
  }
}

/**
 * Persist updated settings into the manifest.
 * @param {object} settings
 */
export async function saveSettings(settings) {
  _manifest = { ..._manifest, settings };
  await _persistManifest();
}

/**
 * Persist an updated collections list and/or active collection ID.
 * @param {{ collections: object[], activeCollectionId: string, settings?: object }} opts
 */
export async function saveManifest({ collections, activeCollectionId, settings }) {
  const cleanColls = collections.map(({ variables: _v, ...rest }) => rest);
  _manifest = {
    ..._manifest,
    collections: cleanColls,
    activeCollectionId,
    ...(settings !== undefined ? { settings } : {}),
  };
  await _persistManifest();
}

/**
 * Load items and variables for a specific collection.
 * @param {string} collectionId
 * @returns {Promise<{ items: object[], variables: object }>}
 */
export async function loadCollectionData(collectionId) {
  const data = await _loadEnvFile(collectionId);
  if (collectionId === _activeCollectionId) {
    _activeItems     = data.items;
    _activeVariables = data.variables;
  }
  return data;
}

/**
 * Save items for a specific collection.
 * @param {string}   collectionId
 * @param {object[]} items
 * @param {object}   [variables]
 */
export async function saveCollectionData(collectionId, items, variables) {
  let vars;
  if (variables !== undefined) {
    vars = variables;
  } else if (collectionId === _activeCollectionId) {
    vars = _activeVariables;
  } else {
    // Load existing variables from disk so they are not silently discarded
    const existing = await _loadEnvFile(collectionId);
    vars = existing?.variables ?? {};
  }
  if (collectionId === _activeCollectionId) {
    _activeItems = items;
  }
  return _saveEnvFile(collectionId, items, vars);
}

/**
 * Update the in-memory active collection ID.
 * @param {string} collectionId
 */
export function setActiveCollection(collectionId) {
  _activeCollectionId = collectionId;
  _activeItems        = [];
  _activeVariables    = {};
  _manifest           = { ..._manifest, activeCollectionId: collectionId };
}

/**
 * Persist key/value variables for a specific collection.
 * @param {string} collectionId
 * @param {object} variables
 */
export async function saveCollectionVariables(collectionId, variables) {
  if (collectionId === _activeCollectionId) {
    _activeVariables = variables;
    await _saveEnvFile(_activeCollectionId, _activeItems, variables);
  } else {
    const { items } = await _loadEnvFile(collectionId);
    await _saveEnvFile(collectionId, items, variables);
  }
}

/**
 * Permanently delete a request.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteRequest(id) {
  try {
    if (isElectron()) { await window.wurl.store.requests.delete(id); return; }
    await fetch(`/api/requests/${encodeURIComponent(id)}`, { method: "DELETE" });
  } catch (err) {
    console.warn(`[data-store] deleteRequest(${id}) failed:`, err.message);
  }
}

// ── Public: request history API ───────────────────────────────────────────────

/**
 * Return a cursor-paginated page of history entries for `requestId`, newest-first.
 *
 * @param {string} requestId
 * @param {{ limit?: number, cursor?: string }} [options]
 * @returns {Promise<{ items: object[], nextCursor: string }>}
 */
export async function listHistory(requestId, options = {}) {
  try {
    if (isElectron()) return await window.wurl.store.history.list(requestId, options);
    const params = new URLSearchParams();
    if (options.limit)  params.set("limit",  String(options.limit));
    if (options.cursor) params.set("cursor", options.cursor);
    const qs  = params.toString() ? `?${params}` : "";
    const res = await fetch(`/api/requests/${encodeURIComponent(requestId)}/history${qs}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn(`[data-store] listHistory(${requestId}) failed:`, err.message);
    return { items: [], nextCursor: "" };
  }
}

/**
 * Record a new execution in the request's history.
 *
 * @param {string} requestId
 * @param {{ status, statusText?, elapsed, size, requestUrl?, requestNode?, timestamp?, id? }} entry  Lightweight metadata
 * @param {{ headers, body, contentType? }}                        [response]  Full payload
 * @returns {Promise<object|null>}  Stored entry
 */
export async function addHistory(requestId, entry, response) {
  try {
    if (isElectron()) return await window.wurl.store.history.add(requestId, entry, response);
    const payload = response ? { ...entry, response } : entry;
    const res = await fetch(`/api/requests/${encodeURIComponent(requestId)}/history`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn(`[data-store] addHistory(${requestId}) failed:`, err.message);
    return null;
  }
}

/**
 * Lazy-load the full response payload for a history entry.
 *
 * @param {string} requestId
 * @param {string} historyId
 * @returns {Promise<object|null>}
 */
export async function getHistoryResponse(requestId, historyId) {
  try {
    if (isElectron()) return await window.wurl.store.history.getResponse(requestId, historyId);
    const res = await fetch(
      `/api/requests/${encodeURIComponent(requestId)}/history/${encodeURIComponent(historyId)}/response`,
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn(`[data-store] getHistoryResponse(${requestId}, ${historyId}) failed:`, err.message);
    return null;
  }
}

/**
 * Permanently delete a single history entry and its response payload.
 *
 * @param {string} requestId
 * @param {string} historyId
 * @returns {Promise<void>}
 */
export async function deleteHistory(requestId, historyId) {
  try {
    if (isElectron()) {
      await window.wurl.store.history.delete(requestId, historyId);
      return;
    }
    await fetch(
      `/api/requests/${encodeURIComponent(requestId)}/history/${encodeURIComponent(historyId)}`,
      { method: "DELETE" },
    );
  } catch (err) {
    console.warn(`[data-store] deleteHistory(${requestId}, ${historyId}) failed:`, err.message);
  }
}

/**
 * Trim all persisted history across every request to at most maxEntries per request.
 * Covers requests whose history has never been loaded into the renderer's memory.
 *
 * @param {number} maxEntries
 * @returns {Promise<void>}
 */
export async function trimHistory(maxEntries) {
  try {
    if (isElectron()) {
      await window.wurl.store.history.trim(maxEntries);
      return;
    }
    // No Go dev-server equivalent — history trimming is a main-process concern.
  } catch (err) {
    console.warn(`[data-store] trimHistory(${maxEntries}) failed:`, err.message);
  }
}
