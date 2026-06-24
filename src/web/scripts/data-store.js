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
 * data-store.js — Persistence layer for the Rest Hippo data document.
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
 *   Electron:      window.hippo.store  (new IPC channels via preload.js)
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
  theme: "grey-dark",
  fontSize: 13,
  fontFamily: "inter",
  // UI language: "system" follows the OS locale; otherwise a shipped locale tag
  // (e.g. "en", "es"). Resolved to a catalog at startup by the main process; see
  // src/app/i18n.js and src/web/scripts/i18n.js.
  locale: "system",
  layout: 2,
  timeout: 30000,
  followRedirects: true,
  verifySsl: true,
  // When an application/x-ndjson response is received, consume it live (line by
  // line) instead of buffering the whole body (Feature 33). Off by default so a
  // finite NDJSON document keeps the rich buffered viewer; live feeds opt in.
  streamNdjson: false,
  // Request-editor tab visibility. Each toggle both hides its tab and gates its
  // logic: Captures off → tab hidden AND capture rules don't run after a
  // response; Scripts off → tab hidden AND pre-request/after-response scripts
  // don't execute. Notes off → tab hidden (no execution side effects). Captures
  // and Scripts default off (opt-in power features); Notes defaults on.
  showCapturesTab: false,
  showScriptsTab: false,
  // Tests tab (Feature 29): off → tab hidden AND no-code assertions don't run
  // after a response. Opt-in power feature, like Captures/Scripts.
  showTestsTab: false,
  showNotesTab: true,
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
  // mTLS / custom-trust (Certificates settings panel). Applied per-host in the
  // main process at send time; the renderer only stores the configuration.
  //   clientCerts — [{ id, host, format:"pem"|"pfx", certPath, keyPath,
  //                     pfxPath, passphrase }]; passphrase encrypted at rest.
  //   caCerts     — custom CA bundle file paths, trusted IN ADDITION to the
  //                 system roots (so a privately-signed host validates with
  //                 verification still on).
  //   tlsInsecureHosts — NO_PROXY-style host list whose TLS verification is
  //                 skipped, so one self-signed host can be trusted without
  //                 flipping the global verifySsl setting.
  clientCerts: [],
  caCerts: [],
  tlsInsecureHosts: "",
  // Request retry policy (applied in the main process around the whole
  // redirect/auth chain). Disabled by default so existing behaviour is unchanged.
  retryEnabled: false,
  retryMaxAttempts: 3,
  retryBackoffMs: 500,
  retryBackoffMultiplier: 2,
  retryMaxDelayMs: 10000,
  retryOnConnectionError: false,
  retryOnTimeout: false,
  // Opt-in: also retry POST/PATCH (non-idempotent methods) on a network failure.
  // Off by default so a lost-response write isn't silently re-sent / duplicated.
  retryNonIdempotent: false,
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
  // Line-number gutter in the Styled response body (foldable JSON/XML/YAML/
  // HTML/CSS/JS). On by default to mirror the request body; toggled from the
  // body context menu.
  responseBodyLineNumbers: true,
  // Fold gutter + carets in the Styled response body (same MIME types). On by
  // default; toggled from the body context menu.
  responseBodyCodeFolding: true,
  oauth2Advanced: false,
  historyCount: 5,
  customThemes: [],
  // Quick-access: favorited requests (any order) and the most-recently-used
  // list (newest-first, capped). Both span every collection, so each entry is
  // { collectionId, requestId, name, method }. showRecents toggles the Recents
  // tab; the list itself is always tracked.
  favorites: [],
  recents: [],
  showRecents: false,
  // Send command type (Feature: scheduled sends). A global default applied to
  // every request's Send button: "immediate" fires now, "delayed" fires once
  // after sendDelayMs, "interval" fires after sendIntervalMs then repeats on
  // every completion. Durations are in milliseconds; edited from the Send
  // button's type dropdown (see RequestEditor).
  sendType: "immediate",
  sendDelayMs: 5000,
  sendIntervalMs: 10000,
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
    window.hippo != null &&
    typeof window.hippo.store?.manifest?.get === "function"
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
  return v != null && typeof v === "object" && v.__hippoError === true;
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
 *   • the main process returns a `{ __hippoError }` envelope.
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
    () => window.hippo.store.manifest.get(),
    () => httpJson("/api/collections"),
    { version: 2, collections: [], activeCollectionId: null, settings: {} },
  );
}

async function _persistManifest(label = "Save changes") {
  return storeWrite(
    label,
    () => window.hippo.store.manifest.save(_manifest),
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

async function _loadCollectionFile(collectionId) {
  const normalize = (raw) => ({
    items: Array.isArray(raw?.collections) ? raw.collections : [],
    variables:
      raw?.variables && typeof raw.variables === "object" ? raw.variables : {},
  });
  return storeCall(
    `env load (${collectionId})`,
    async () =>
      normalize(await window.hippo.store.collections.get(collectionId)),
    async () =>
      normalize(
        await httpJson(`/api/env?id=${encodeURIComponent(collectionId)}`),
      ),
    { items: [], variables: {} },
  );
}

async function _saveCollectionFile(collectionId, items, variables = {}, label) {
  const blob = { version: 1, collections: items, variables };
  return storeWrite(
    label ?? "Save collection",
    () => window.hippo.store.collections.save(collectionId, blob),
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
    let seededDefault = false;
    if (collections.length === 0) {
      const defaultId = crypto.randomUUID();
      collections = [{ id: defaultId, name: "COLLECTIONS" }];
      activeId = defaultId;
      seededDefault = true;
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

    // Persist a freshly-seeded default immediately so its random id is stable
    // across restarts. Without this the manifest stays empty until some later
    // action (a settings change, a collection rename) happens to write it; if the
    // user instead imports into the in-memory default and quits, the next launch
    // reads the still-empty manifest, seeds ANOTHER default with a new id, and
    // the imported collection's directory is orphaned — leaving duplicate request
    // files the resolver then flags. Only the genuine first-run seed is persisted
    // here; the catch branch below must NOT (a transient manifest-read failure
    // would otherwise clobber a real manifest with an empty default).
    if (seededDefault) await _persistManifest("Seed default collection");

    const { items, variables } = await _loadCollectionFile(activeId);
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
  return _saveCollectionFile(
    _activeCollectionId,
    items,
    _activeVariables,
    "Save collection",
  );
}

/**
 * Persist a single request's edited fields granularly — only that request's file
 * is rewritten (with its undecryptable secrets preserved by the main-side clobber
 * guard), instead of re-encrypting the whole collection. The patch must be the
 * *partial* set of changed fields (the hippo:request-updated detail), not the full
 * node, so the clobber guard can tell an untouched auth block from a deliberate
 * overwrite.
 *
 * Electron only — the Go dev-server has no granular endpoint. Returns true on
 * success; false on any failure (e.g. a brand-new request not yet on disk, or a
 * non-Electron host) so the caller can fall back to a full saveCollections(),
 * which both creates the file and surfaces a genuine write failure loudly.
 *
 * @param {string} id
 * @param {object} patch  partial request fields
 * @returns {Promise<boolean>} whether the granular write succeeded
 */
export async function updateRequest(id, patch) {
  if (!isElectron()) return false;
  try {
    await window.hippo.store.requests.update(id, patch);
    return true;
  } catch (err) {
    console.warn(
      `[data-store] updateRequest(${id}) failed:`,
      err?.message ?? err,
    );
    return false;
  }
}

/**
 * Keep the active-collection items mirror in step with the renderer's tree after
 * a granular request edit (which does not itself touch the cache). Without this a
 * later saveCollectionVariables() — which re-pairs the cached items with new
 * variables and does a full write — would clobber the granular edits with a stale
 * snapshot. In-memory only; no persistence.
 *
 * @param {object[]} items
 */
export function setActiveItems(items) {
  _activeItems = items;
}

/**
 * Mirror updated collection-level variables into the in-memory active-collection
 * cache, WITHOUT persisting (saveCollectionData writes the disk blob but does not
 * touch this cache). Without this, a later full saveCollections() — which re-pairs
 * the cached items with `_activeVariables` — would write a stale variable snapshot
 * and clobber freshly-merged variables (e.g. just after a Rest Hippo v1 import).
 * In-memory only; no persistence.
 *
 * @param {object} variables  canonical variable array (or legacy map)
 */
export function setActiveVariables(variables) {
  _activeVariables = variables;
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
  const data = await _loadCollectionFile(collectionId);
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
    const existing = await _loadCollectionFile(collectionId);
    vars = existing?.variables ?? {};
  }
  if (collectionId === _activeCollectionId) {
    _activeItems = items;
  }
  return _saveCollectionFile(collectionId, items, vars, "Save collection");
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
    return _saveCollectionFile(
      _activeCollectionId,
      _activeItems,
      variables,
      "Save variables",
    );
  }
  const { items } = await _loadCollectionFile(collectionId);
  return _saveCollectionFile(collectionId, items, variables, "Save variables");
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
    () => window.hippo.store.requests.delete(id),
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
    () => window.hippo.store.collections.delete(id),
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
    () => window.hippo.store.history.list(requestId, options),
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
    () => window.hippo.store.history.add(requestId, entry, response),
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
    () => window.hippo.store.history.getResponse(requestId, historyId),
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
    () => window.hippo.store.history.delete(requestId, historyId),
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
    () => window.hippo.store.history.clear(requestId),
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
    () => window.hippo.store.history.trim(maxEntries),
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
    () => window.hippo.store.environments.save(data),
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
    () => window.hippo.store.cookies.upsert(collectionId, cookie),
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
    () => window.hippo.store.cookies.delete(collectionId, ident),
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
    () => window.hippo.store.cookies.clear(collectionId),
    () => {},
  );
}
