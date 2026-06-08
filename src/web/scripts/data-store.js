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
 *
 *   Environments + cookies (Electron-only authoritative writes → boolean):
 *     saveEnvironments(data)
 *     upsertCookie(collectionId, cookie)
 *     deleteCookie(collectionId, ident)
 *     clearCookies(collectionId)
 */

"use strict";

/** Canonical default settings — merged over whatever is stored on disk. */
const DEFAULT_SETTINGS = {
  theme: "mocha",
  fontSize: 13,
  fontFamily: "inter",
  layout: 2,
  timeout: 30000,
  followRedirects: true,
  verifySsl: true,
  proxyEnabled: false,
  proxyUrl: "",
  // Separate proxy credentials (encrypted at rest) and a NO_PROXY-style bypass
  // list. The proxy *type* (HTTP/HTTPS vs SOCKS) is derived from proxyUrl's
  // scheme (e.g. socks5://host:1080) in the main process. Credentials are only
  // sent when proxyAuthEnabled is on (off by default, like Postman's Proxy Auth).
  proxyAuthEnabled: false,
  proxyUsername: "",
  proxyPassword: "",
  proxyBypass: "",
  // Request retry policy (applied in the main process around the whole
  // redirect/auth chain). Disabled by default so existing behaviour is unchanged.
  retryEnabled: false,
  retryMaxAttempts: 3,
  retryBackoffMs: 500,
  retryBackoffMultiplier: 2,
  retryMaxDelayMs: 10000,
  retryOnConnectionError: true,
  retryOnTimeout: true,
  retryStatusCodes: "",
  splitterNav: 240,
  splitterRes: 340,
  splitterRowRes: 320,
  // GraphQL Query/Variables split position. The orientation is derived from the
  // app layout (not persisted); these two fractions are the Variables pane's
  // share of the container per orientation, or null to use the default flex ratio.
  graphqlVarsFractionColumn: null,
  graphqlVarsFractionRow: null,
  // Code folding in the GraphQL Query/Variables editors (gutter carets). On by
  // default; toggled from Appearance settings or each editor's context menu.
  editorFolding: true,
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
  // Quick-access: favorited requests (any order) and the most-recently-used
  // list (newest-first, capped). Both span every collection, so each entry is
  // { collectionId, requestId, name, method }. showRecents toggles the Recents
  // tab; the list itself is always tracked.
  favorites: [],
  recents: [],
  showRecents: true,
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
 * Run a *read* operation across either transport with silent degradation.
 * Executes `electronFn` under Electron, otherwise `httpFn`; on any thrown error
 * logs a warning tagged with `label` and resolves to `fallback`.
 *
 * Reads degrade quietly by design: a failed load falls back to an empty/default
 * value and the UI keeps working. The failure is still logged. Writes use
 * {@link storeWrite} instead, which never fails silently.
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

// ── Write-failure surfacing ─────────────────────────────────────────────────
// Writes (create/update/delete/save) must NEVER fail silently — a persistent
// write failure is silent data loss. data-store stays DOM-free and unit-testable,
// so rather than import the toast surface directly it exposes an injectable sink
// the renderer wires to Notifications at startup. With no sink registered (tests,
// dev-server headless) failures still log via console.error.

/** @type {((info: { label: string, message: string }) => void) | null} */
let _onWriteError = null;

/**
 * Register the callback invoked whenever a write fails. The renderer points this
 * at the Notifications toast surface (see app.js); leaving it unset keeps write
 * failures log-only, which is the behaviour the test suite relies on.
 * @param {(info: { label: string, message: string }) => void | null} fn
 */
export function setWriteErrorHandler(fn) {
  _onWriteError = typeof fn === "function" ? fn : null;
}

/**
 * The main process catches store-handler throws in safeCallWrite() and returns a
 * discriminable envelope (rather than a look-alike success fallback) so the
 * renderer can tell a real failure from a real result. Detect it here.
 * @param {*} v
 * @returns {boolean}
 */
function isErrorEnvelope(v) {
  return v != null && typeof v === "object" && v.__wurlError === true;
}

/** Log a write failure and route it to the registered sink (if any). */
function _reportWriteError(label, message) {
  const text = String(message ?? "Unknown error");
  console.error(`[data-store] ${label} failed:`, text);
  if (_onWriteError) _onWriteError({ label, message: text });
}

/**
 * Run a *write* operation across either transport. Unlike {@link storeCall}, a
 * write failure is never swallowed: it is logged AND raised to the write-error
 * sink so the user sees it. Failure is detected two ways —
 *   • the transport throws (IPC channel broken / fetch network error), or
 *   • the main process returns a `{ __wurlError }` envelope.
 *
 * @param {string}           label       User-facing action label (e.g. "Save settings")
 * @param {() => Promise<*>} electronFn  Electron (IPC) transport path
 * @param {() => Promise<*>} httpFn      Go dev-server (fetch) transport path
 * @returns {Promise<boolean>}  true when the write succeeded
 */
async function storeWrite(label, electronFn, httpFn) {
  try {
    const result = await (isElectron() ? electronFn() : httpFn());
    if (isErrorEnvelope(result)) {
      _reportWriteError(label, result.message);
      return false;
    }
    return true;
  } catch (err) {
    _reportWriteError(label, err.message);
    return false;
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

/**
 * Issue a write (PUT/DELETE) over the dev-server transport, throwing on a
 * non-OK status so {@link storeWrite} treats a 4xx/5xx as the failure it is —
 * `fetch` only rejects on a network error, not on an HTTP error status.
 * @param {string} url
 * @param {RequestInit} [opts]
 * @returns {Promise<Response>}
 */
async function httpWrite(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
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

async function _persistManifest(label = "Save changes") {
  return storeWrite(
    label,
    () => window.wurl.store.manifest.save(_manifest),
    () =>
      httpWrite("/api/collections", {
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

async function _saveEnvFile(collectionId, items, variables = {}, label) {
  const blob = { version: 1, collections: items, variables };
  return storeWrite(
    label ?? "Save collection",
    () => window.wurl.store.env.save(collectionId, blob),
    () =>
      httpWrite(`/api/env?id=${encodeURIComponent(collectionId)}`, {
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
  if (!_activeCollectionId) return true; // nothing to persist is not a failure
  _activeItems = items;
  return _saveEnvFile(
    _activeCollectionId,
    items,
    _activeVariables,
    "Save collection",
  );
}

/**
 * Persist updated settings into the manifest.
 * @param {object} settings
 */
export async function saveSettings(settings) {
  _manifest = { ..._manifest, settings };
  return _persistManifest("Save settings");
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
  return _persistManifest("Save collections");
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
  return _saveEnvFile(collectionId, items, vars, "Save collection");
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
    await _saveEnvFile(
      _activeCollectionId,
      _activeItems,
      variables,
      "Save variables",
    );
  } else {
    const { items } = await _loadEnvFile(collectionId);
    await _saveEnvFile(collectionId, items, variables, "Save variables");
  }
}

/**
 * Permanently delete a request.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteRequest(id) {
  // Best-effort reclamation: the tree (source of truth) was already updated and
  // saved loudly via saveCollections. A failed unlink — including ENOENT for a
  // file that is already gone — is not user-actionable data loss, and this is
  // called in a per-id loop on folder deletes, so it degrades quietly (log only)
  // rather than raising a toast (or a toast per request).
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
  // Best-effort reclamation AFTER the authoritative saveManifest already removed
  // the collection from the manifest; a failed directory cleanup is not data loss
  // the user can act on, so it degrades quietly (see deleteRequest).
  return storeCall(
    `deleteCollection(${id})`,
    () => window.wurl.store.collections.delete(id),
    () =>
      fetch(`/api/collections/${encodeURIComponent(id)}`, { method: "DELETE" }),
  );
}

// ── Public: request history API ───────────────────────────────────────────────
// History reads AND writes both use the quiet storeCall() path (log + fallback),
// not storeWrite(). History is best-effort, auto-captured telemetry recorded on
// every send/purge — surfacing a toast for each failure would nag the user on a
// loop, and a lost history entry is not the user-authored data loss that
// storeWrite() exists to make visible. Failures are still logged.

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

// ── Public: environment variables API ─────────────────────────────────────────
// Global + named environment variables (distinct from per-collection variables).
// These are authoritative writes, so they use the loud storeWrite() path: a
// failure both logs and raises the write-error sink (toast). Electron-only —
// there is no Go dev-server endpoint, so the dev-server path is a resolving no-op
// treated as success, mirroring trimHistory().

/**
 * Persist the full environments document (global + named variables).
 * @param {object} data  { version, globalVariables, activeEnvironmentId, environments }
 * @returns {Promise<boolean>}  true when the write succeeded
 */
export async function saveEnvironments(data) {
  return storeWrite(
    "Save environments",
    () => window.wurl.store.environments.save(data),
    () => {},
  );
}

// ── Public: cookie jar API ────────────────────────────────────────────────────
// Per-collection persistent cookie jar, edited from the cookie-manager UI. Like
// environments these are authoritative, loud writes and Electron-only (the
// dev-server path is a resolving no-op).

/**
 * Create or update a single cookie in a collection's jar.
 * @param {string} collectionId
 * @param {object} cookie
 * @returns {Promise<boolean>}  true when the write succeeded
 */
export async function upsertCookie(collectionId, cookie) {
  return storeWrite(
    "Save cookie",
    () => window.wurl.store.cookies.upsert(collectionId, cookie),
    () => {},
  );
}

/**
 * Delete a single cookie (identified by {name, domain, path}) from a jar.
 * @param {string} collectionId
 * @param {{name:string, domain:string, path:string}} ident
 * @returns {Promise<boolean>}  true when the write succeeded
 */
export async function deleteCookie(collectionId, ident) {
  return storeWrite(
    "Delete cookie",
    () => window.wurl.store.cookies.delete(collectionId, ident),
    () => {},
  );
}

/**
 * Remove every cookie stored for a collection.
 * @param {string} collectionId
 * @returns {Promise<boolean>}  true when the write succeeded
 */
export async function clearCookies(collectionId) {
  return storeWrite(
    "Clear cookies",
    () => window.wurl.store.cookies.clear(collectionId),
    () => {},
  );
}
