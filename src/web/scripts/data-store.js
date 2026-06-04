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
  theme: "mocha",
  fontSize: 13,
  fontFamily: "inter",
  layout: 1,
  timeout: 30000,
  followRedirects: true,
  verifySsl: true,
  proxyEnabled: false,
  proxyUrl: "",
  splitterNav: 240,
  splitterRes: 340,
  splitterRowRes: 320,
  listHeaders: true,
  showUrlPreview: true,
  varsBulkEditor: true,
  selectedRequestIds: {},
  responseBodyRenderMode: "styled",
  methodIcons: false,
  wrapResponseText: true,
  oauth2Advanced: false,
  historyCount: 5,
  customThemes: [],
};

// ── In-memory caches ──────────────────────────────────────────────────────────

let _manifest = {
  version: 2,
  collections: [],
  activeCollectionId: null,
  settings: { ...DEFAULT_SETTINGS },
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

/**
 * Run a store operation across either transport with uniform error handling.
 * Executes `electronFn` under Electron, otherwise `httpFn`; on any thrown error
 * logs a warning tagged with `label` and resolves to `fallback`.
 *
 * @template T
 * @param {string}          label       Identifier used in the warning message
 * @param {() => Promise<T>} electronFn  Electron (IPC) transport path
 * @param {() => Promise<T>} httpFn      Go dev-server (fetch) transport path
 * @param {T}               [fallback]   Value returned when the operation fails
 * @returns {Promise<T>}
 */
async function storeCall(label, electronFn, httpFn, fallback) {
  try {
    return await (isElectron() ? electronFn() : httpFn());
  } catch (err) {
    console.warn(`[data-store] ${label} failed:`, err.message);
    return fallback;
  }
}

/**
 * Fetch a URL and parse a JSON body, throwing on a non-OK status.
 * @param {string} url
 * @param {RequestInit} [opts]
 * @returns {Promise<any>}
 */
async function httpJson(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Low-level manifest I/O ────────────────────────────────────────────────────

async function _loadManifest() {
  return storeCall(
    "manifest load",
    () => window.wurl.store.manifest.get(),
    () => httpJson("/api/collections"),
    { version: 2, collections: [], activeCollectionId: null, settings: {} },
  );
}

async function _persistManifest() {
  return storeCall(
    "manifest save",
    () => window.wurl.store.manifest.save(_manifest),
    () =>
      fetch("/api/collections", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(_manifest),
      }),
  );
}

// ── Low-level per-collection I/O ──────────────────────────────────────────────
// The "env blob" shape is: { version: 1, collections: [...], variables: {...} }
// It is assembled from / decomposed into the new per-file layout transparently.

async function _loadEnvFile(collectionId) {
  const normalize = (raw) => ({
    items: Array.isArray(raw?.collections) ? raw.collections : [],
    variables:
      raw?.variables && typeof raw.variables === "object" ? raw.variables : {},
  });
  return storeCall(
    `env load (${collectionId})`,
    async () => normalize(await window.wurl.store.env.get(collectionId)),
    async () =>
      normalize(
        await httpJson(`/api/env?id=${encodeURIComponent(collectionId)}`),
      ),
    { items: [], variables: {} },
  );
}

async function _saveEnvFile(collectionId, items, variables = {}) {
  const blob = { version: 1, collections: items, variables };
  return storeCall(
    `env save (${collectionId})`,
    () => window.wurl.store.env.save(collectionId, blob),
    () =>
      fetch(`/api/env?id=${encodeURIComponent(collectionId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(blob),
      }),
  );
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
      : Array.isArray(raw.environments)
        ? raw.environments
        : [];
    let activeId = raw.activeCollectionId ?? raw.activeEnvironmentId ?? null;

    // Seed a default collection on true first-run (empty manifest)
    if (collections.length === 0) {
      const defaultId = crypto.randomUUID();
      collections = [{ id: defaultId, name: "COLLECTIONS" }];
      activeId = defaultId;
    }

    // Guard: activeId must reference a real collection
    if (!collections.find((c) => c.id === activeId)) {
      activeId = collections[0].id;
    }

    // Normalize the per-collection "send cookies" flag (default on). Persisted
    // in the manifest alongside id/name; consulted on each request send.
    collections = collections.map((c) => ({
      ...c,
      sendCookies: c.sendCookies !== false,
    }));

    _manifest = {
      version: 2,
      collections,
      activeCollectionId: activeId,
      settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
    };
    _activeCollectionId = activeId;

    const { items, variables } = await _loadEnvFile(activeId);
    _activeItems = items;
    _activeVariables = variables;

    return {
      collections: _manifest.collections,
      activeCollectionId: _activeCollectionId,
      settings: _manifest.settings,
      items,
      variables,
    };
  } catch (err) {
    console.warn("[data-store] load failed:", err.message);
    const defaultId = crypto.randomUUID();
    _manifest = {
      version: 2,
      collections: [{ id: defaultId, name: "COLLECTIONS" }],
      activeCollectionId: defaultId,
      settings: { ...DEFAULT_SETTINGS },
    };
    _activeCollectionId = defaultId;
    _activeItems = [];
    _activeVariables = {};
    return {
      collections: _manifest.collections,
      activeCollectionId: _activeCollectionId,
      settings: _manifest.settings,
      items: [],
      variables: {},
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
export async function saveManifest({
  collections,
  activeCollectionId,
  settings,
}) {
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
    _activeItems = data.items;
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
  _activeItems = [];
  _activeVariables = {};
  _manifest = { ..._manifest, activeCollectionId: collectionId };
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
  return storeCall(
    `deleteRequest(${id})`,
    () => window.wurl.store.requests.delete(id),
    () =>
      fetch(`/api/requests/${encodeURIComponent(id)}`, { method: "DELETE" }),
  );
}

/**
 * Permanently delete a collection's backing storage (requests, history,
 * responses, cookies, metadata). The caller updates the manifest separately via
 * saveManifest; this only reclaims the on-disk directory.
 *
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteCollection(id) {
  return storeCall(
    `deleteCollection(${id})`,
    () => window.wurl.store.collections.delete(id),
    () =>
      fetch(`/api/collections/${encodeURIComponent(id)}`, { method: "DELETE" }),
  );
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
  return storeCall(
    `listHistory(${requestId})`,
    () => window.wurl.store.history.list(requestId, options),
    () => {
      const params = new URLSearchParams();
      if (options.limit) params.set("limit", String(options.limit));
      if (options.cursor) params.set("cursor", options.cursor);
      const qs = params.toString() ? `?${params}` : "";
      return httpJson(
        `/api/requests/${encodeURIComponent(requestId)}/history${qs}`,
      );
    },
    { items: [], nextCursor: "" },
  );
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
  return storeCall(
    `addHistory(${requestId})`,
    () => window.wurl.store.history.add(requestId, entry, response),
    () =>
      httpJson(`/api/requests/${encodeURIComponent(requestId)}/history`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(response ? { ...entry, response } : entry),
      }),
    null,
  );
}

/**
 * Lazy-load the full response payload for a history entry.
 *
 * @param {string} requestId
 * @param {string} historyId
 * @returns {Promise<object|null>}
 */
export async function getHistoryResponse(requestId, historyId) {
  return storeCall(
    `getHistoryResponse(${requestId}, ${historyId})`,
    () => window.wurl.store.history.getResponse(requestId, historyId),
    async () => {
      const res = await fetch(
        `/api/requests/${encodeURIComponent(requestId)}/history/${encodeURIComponent(historyId)}/response`,
      );
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    null,
  );
}

/**
 * Permanently delete a single history entry and its response payload.
 *
 * @param {string} requestId
 * @param {string} historyId
 * @returns {Promise<void>}
 */
export async function deleteHistory(requestId, historyId) {
  return storeCall(
    `deleteHistory(${requestId}, ${historyId})`,
    () => window.wurl.store.history.delete(requestId, historyId),
    () =>
      fetch(
        `/api/requests/${encodeURIComponent(requestId)}/history/${encodeURIComponent(historyId)}`,
        { method: "DELETE" },
      ),
  );
}

/**
 * Permanently delete ALL history entries and response payloads for a request.
 *
 * @param {string} requestId
 * @returns {Promise<void>}
 */
export async function clearHistory(requestId) {
  return storeCall(
    `clearHistory(${requestId})`,
    () => window.wurl.store.history.clear(requestId),
    () =>
      fetch(`/api/requests/${encodeURIComponent(requestId)}/history`, {
        method: "DELETE",
      }),
  );
}

/**
 * Trim all persisted history across every request to at most maxEntries per request.
 * Covers requests whose history has never been loaded into the renderer's memory.
 *
 * @param {number} maxEntries
 * @returns {Promise<void>}
 */
export async function trimHistory(maxEntries) {
  return storeCall(
    `trimHistory(${maxEntries})`,
    () => window.wurl.store.history.trim(maxEntries),
    // No Go dev-server equivalent — history trimming is a main-process concern.
    () => {},
  );
}
