/**
 * data-store.js — Persistence layer for the wurl data document.
 *
 * Storage layout (new per-file architecture):
 *
 *   collections/index.json          — manifest:
 *     { version: 2, environments: [{id, name}], activeEnvironmentId, settings }
 *
 *   collections/<envId>/            — per-environment data:
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
 *   Core (manifest + environment blob):
 *     loadAll()                              → startup data
 *     saveCollections(items)                 → persist active env's collection tree
 *     saveSettings(settings)
 *     saveManifest({ environments, activeEnvironmentId, settings? })
 *     loadEnvCollections(envId)              → { collections, variables }
 *     saveEnvCollections(envId, collections, variables?)
 *     setActiveEnvironment(envId)
 *     saveEnvVariables(envId, variables)
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
  selectedRequestId: null,
  responseBodyRenderMode: "preview",
  oauth2Advanced:    false,
  historyCount:      5,
};

// ── In-memory caches ──────────────────────────────────────────────────────────

let _manifest = {
  version:             2,
  environments:        [],
  activeEnvironmentId: null,
  settings:            { ...DEFAULT_SETTINGS },
};

/** The environment ID currently used by saveCollections(). */
let _activeEnvId = null;

/** Cached collections for the active environment. */
let _activeEnvCollections = [];

/** Cached variables for the active environment. */
let _activeEnvVariables = {};

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
    return { version: 2, environments: [], activeEnvironmentId: null, settings: {} };
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

// ── Low-level per-environment I/O ─────────────────────────────────────────────
// The "env blob" shape is: { version: 1, collections: [...], variables: {...} }
// It is assembled from / decomposed into the new per-file layout transparently.

async function _loadEnvFile(envId) {
  try {
    let raw;
    if (isElectron()) {
      raw = await window.wurl.store.env.get(envId);
    } else {
      const res = await fetch(`/api/env?id=${encodeURIComponent(envId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      raw = await res.json();
    }
    return {
      collections: Array.isArray(raw?.collections) ? raw.collections : [],
      variables:   (raw?.variables && typeof raw.variables === "object") ? raw.variables : {},
    };
  } catch (err) {
    console.warn(`[data-store] env load failed (${envId}):`, err.message);
    return { collections: [], variables: {} };
  }
}

async function _saveEnvFile(envId, collections, variables = {}) {
  try {
    if (isElectron()) {
      await window.wurl.store.env.save(envId, { version: 1, collections, variables });
      return;
    }
    await fetch(`/api/env?id=${encodeURIComponent(envId)}`, {
      method:  "PUT",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ version: 1, collections, variables }),
    });
  } catch (err) {
    console.warn(`[data-store] env save failed (${envId}):`, err.message);
  }
}

// ── Public: core API ──────────────────────────────────────────────────────────

/**
 * Load the full application state on startup.
 *
 * @returns {Promise<{
 *   environments:        {id:string, name:string}[],
 *   activeEnvironmentId: string,
 *   settings:            object,
 *   collections:         object[],
 *   variables:           object,
 * }>}
 */
export async function loadAll() {
  try {
    const raw = await _loadManifest();

    let environments = Array.isArray(raw.environments) ? raw.environments : [];
    let activeId     = raw.activeEnvironmentId ?? null;

    // Seed a default environment on true first-run (empty manifest)
    if (environments.length === 0) {
      const defaultId  = crypto.randomUUID();
      environments     = [{ id: defaultId, name: "COLLECTIONS" }];
      activeId         = defaultId;
    }

    // Guard: activeId must reference a real environment
    if (!environments.find(e => e.id === activeId)) {
      activeId = environments[0].id;
    }

    _manifest = {
      version:             2,
      environments,
      activeEnvironmentId: activeId,
      settings:            { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
    };
    _activeEnvId = activeId;

    const { collections, variables } = await _loadEnvFile(activeId);
    _activeEnvCollections = collections;
    _activeEnvVariables   = variables;

    return {
      environments:        _manifest.environments,
      activeEnvironmentId: _activeEnvId,
      settings:            _manifest.settings,
      collections,
      variables,
    };
  } catch (err) {
    console.warn("[data-store] load failed:", err.message);
    const defaultId = crypto.randomUUID();
    _manifest = {
      version:             2,
      environments:        [{ id: defaultId, name: "COLLECTIONS" }],
      activeEnvironmentId: defaultId,
      settings:            { ...DEFAULT_SETTINGS },
    };
    _activeEnvId          = defaultId;
    _activeEnvCollections = [];
    _activeEnvVariables   = {};
    return {
      environments:        _manifest.environments,
      activeEnvironmentId: _activeEnvId,
      settings:            _manifest.settings,
      collections:         [],
      variables:           {},
    };
  }
}

/**
 * Persist an updated collections array for the currently active environment.
 * @param {object[]} items
 */
export async function saveCollections(items) {
  if (_activeEnvId) {
    _activeEnvCollections = items;
    await _saveEnvFile(_activeEnvId, items, _activeEnvVariables);
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
 * Persist an updated environments list and/or active environment ID.
 * @param {{ environments: object[], activeEnvironmentId: string, settings?: object }} opts
 */
export async function saveManifest({ environments, activeEnvironmentId, settings }) {
  const cleanEnvs = environments.map(({ variables: _v, ...rest }) => rest);
  _manifest = {
    ..._manifest,
    environments: cleanEnvs,
    activeEnvironmentId,
    ...(settings !== undefined ? { settings } : {}),
  };
  await _persistManifest();
}

/**
 * Load collections and variables for a specific environment.
 * @param {string} envId
 * @returns {Promise<{ collections: object[], variables: object }>}
 */
export async function loadEnvCollections(envId) {
  const data = await _loadEnvFile(envId);
  if (envId === _activeEnvId) {
    _activeEnvCollections = data.collections;
    _activeEnvVariables   = data.variables;
  }
  return data;
}

/**
 * Save collections for a specific environment.
 * @param {string}   envId
 * @param {object[]} collections
 * @param {object}   [variables]
 */
export async function saveEnvCollections(envId, collections, variables) {
  let vars;
  if (variables !== undefined) {
    vars = variables;
  } else if (envId === _activeEnvId) {
    vars = _activeEnvVariables;
  } else {
    // Load existing variables from disk so they are not silently discarded
    const existing = await _loadEnvFile(envId);
    vars = existing?.variables ?? {};
  }
  if (envId === _activeEnvId) {
    _activeEnvCollections = collections;
  }
  return _saveEnvFile(envId, collections, vars);
}

/**
 * Update the in-memory active environment ID.
 * @param {string} envId
 */
export function setActiveEnvironment(envId) {
  _activeEnvId          = envId;
  _activeEnvCollections = [];
  _activeEnvVariables   = {};
  _manifest             = { ..._manifest, activeEnvironmentId: envId };
}

/**
 * Persist key/value variables for a specific environment.
 * @param {string} envId
 * @param {object} variables
 */
export async function saveEnvVariables(envId, variables) {
  if (envId === _activeEnvId) {
    _activeEnvVariables = variables;
    await _saveEnvFile(_activeEnvId, _activeEnvCollections, variables);
  } else {
    const { collections } = await _loadEnvFile(envId);
    await _saveEnvFile(envId, collections, variables);
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
 * @param {{ status, durationMs, responseSize, timestamp?, id? }} entry  Lightweight metadata
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
