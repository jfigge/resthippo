/**
 * data-store.js — Persistence layer for the wurl data document.
 *
 * Storage layout (v2):
 *
 *   collections.json   — manifest:
 *     { version: 2, environments: [{id, name}], activeEnvironmentId, settings }
 *
 *   <envId>.json       — per-environment data:
 *     { version: 1, collections: [...], variables: {...} }
 *
 * Migration from v1:
 *   If collections.json has version:1 (old { collections:[...], settings:{} } format),
 *   the existing collections are moved into a "<newUUID>.json" file and the manifest
 *   is rewritten as v2 with a single default environment named "COLLECTIONS".
 *
 * Environment detection:
 *   Electron: window.wurl.collections / window.wurl.env exposed by preload.js
 *   Go dev server: fetch() against /api/collections and /api/env?id=
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
  splitterNav:    240,
  splitterRes:    340,
  splitterRowRes: 320,
  listHeaders:       true,
  showUrlPreview:    true,
  varsBulkEditor:    true,
  selectedRequestId: null,
};

// ── In-memory manifest cache ──────────────────────────────────────────────────
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

/** Cached variables for the active environment — preserved across saveCollections() calls. */
let _activeEnvVariables = {};

// ── Environment detection ─────────────────────────────────────────────────────

function isElectron() {
  return (
    typeof window !== "undefined" &&
    window.wurl != null &&
    typeof window.wurl.collections?.load === "function"
  );
}

// ── Low-level manifest I/O ────────────────────────────────────────────────────

async function _persistManifest() {
  try {
    if (isElectron()) {
      await window.wurl.collections.save(_manifest);
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

async function _loadEnvFile(envId) {
  try {
    if (isElectron()) {
      const raw = await window.wurl.env.load(envId);
      return {
        collections: Array.isArray(raw?.collections) ? raw.collections : [],
        variables:   (raw?.variables && typeof raw.variables === "object") ? raw.variables : {},
      };
    }
    const res = await fetch(`/api/env?id=${encodeURIComponent(envId)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
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
      await window.wurl.env.save(envId, { version: 1, collections, variables });
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

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Load the full application state on startup.
 * Performs v1→v2 migration if the stored file is in the old format.
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
    let raw;
    if (isElectron()) {
      raw = await window.wurl.collections.load();
    } else {
      const res = await fetch("/api/collections");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      raw = await res.json();
    }

    // ── v1 → v2 migration ───────────────────────────────────────────────────
    // Old format: { version:1, collections:[...], settings:{...} }
    if ((raw.version ?? 1) < 2 && Array.isArray(raw.collections)) {
      const defaultId  = crypto.randomUUID();
      const defaultEnv = { id: defaultId, name: "COLLECTIONS" };

      // Persist the old collections under their new per-env file
      await _saveEnvFile(defaultId, raw.collections, {});

      _manifest = {
        version:             2,
        environments:        [defaultEnv],
        activeEnvironmentId: defaultId,
        settings:            { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
      };
      await _persistManifest();

      _activeEnvId        = defaultId;
      _activeEnvCollections = raw.collections;
      _activeEnvVariables = {};
      return {
        environments:        _manifest.environments,
        activeEnvironmentId: _activeEnvId,
        settings:            _manifest.settings,
        collections:         raw.collections,
        variables:           {},
      };
    }

    // ── Normal v2 load ──────────────────────────────────────────────────────
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
    _activeEnvId         = activeId;

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
  // Strip any `variables` fields — those live in per-env files, not the manifest
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
 * Load the collections and variables for a specific environment (used when switching envs).
 * When loading the currently active environment, the in-memory caches are updated
 * so subsequent saveCollections() / saveEnvVariables() calls are non-destructive.
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
 * Save collections for a specific environment (used when cloning / switching).
 * When `variables` is omitted and the env is the currently active one, the
 * in-memory variable cache is used so existing variables are preserved.
 * @param {string}   envId
 * @param {object[]} collections
 * @param {object}   [variables]  — omit to preserve cached variables for the active env
 */
export async function saveEnvCollections(envId, collections, variables) {
  const vars = variables !== undefined
    ? variables
    : (envId === _activeEnvId ? _activeEnvVariables : {});
  if (envId === _activeEnvId) {
    _activeEnvCollections = collections;
  }
  return _saveEnvFile(envId, collections, vars);
}

/**
 * Update the in-memory active environment ID so that subsequent
 * saveCollections() calls write to the correct file.
 * Callers should follow this with a loadEnvCollections() call and manually
 * update the caches via subsequent saves if needed.
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
 * Variables are stored in the environment's own <envId>.json file alongside
 * its collections, not in the manifest.
 *
 * @param {string} envId
 * @param {object} variables  — plain key/value object, e.g. { baseUrl: "…" }
 */
export async function saveEnvVariables(envId, variables) {
  if (envId === _activeEnvId) {
    // Update cache so subsequent saveCollections() calls don't overwrite variables
    _activeEnvVariables = variables;
    await _saveEnvFile(_activeEnvId, _activeEnvCollections, variables);
  } else {
    // For non-active envs: load current collections first, then re-save with updated variables
    const { collections } = await _loadEnvFile(envId);
    await _saveEnvFile(envId, collections, variables);
  }
}

