/**
 * backup.js — Whole-workspace export / import ("Backup").
 *
 * Bundles every collection, environment, and the global manifest (which carries
 * application settings) into a single portable `wurl-backup` envelope, and
 * restores such an envelope onto a profile.
 *
 * Envelope shape:
 *   {
 *     kind: "wurl-backup",
 *     schemaVersion: <int>,        // reuses the Feature 01 schema envelope
 *     exportedAt: <ISO-8601>,
 *     secretsIncluded: <boolean>,  // legacy flag: true for machine OR password
 *     secretsMode: "none"|"machine"|"password",
 *     manifest:     { ...collections/index.json },
 *     environments: { ...environments/index.json } | null,
 *     collections: [
 *       { id, metadata: {...}, tree: {...}, requests: [ {...}, ... ] }
 *     ]
 *   }
 *
 * Secret handling (security-critical) — three modes, applied uniformly across
 * all six secret locations (request auth fields, settings proxy URL +
 * credentials, and the four variable scopes: collection metadata, folder-tree
 * nodes, global vars, per-environment vars):
 *   - "none" (default): every secret is blanked via crypto.redact* before it
 *     leaves the machine, so nothing sensitive is ever written in plaintext.
 *     Variable rows keep their `secure` flag but lose their value.
 *   - "machine": the on-disk keystore ciphertext is kept verbatim. It is bound
 *     to the originating machine's OS keystore and will NOT decrypt elsewhere —
 *     hence "this machine only".
 *   - "password": secrets are re-encrypted under a user-supplied password into
 *     portable `encp:v2:` ciphertext (PBKDF2 + AES-256-GCM). Such a backup is
 *     fully portable; on import the password decrypts the secrets, which are
 *     then re-encrypted to the destination machine's keystore.
 *
 * History and response payloads are intentionally out of scope: a backup
 * captures the reproducible workspace (collections + environments + settings),
 * not the execution log.
 *
 * All reads here operate on the RAW on-disk files (no decryption) so ciphertext
 * is preserved for the machine-only path; redaction is applied explicitly.
 */
"use strict";

const path = require("path");

const io = require("./io");
const {
  redactRequest,
  redactSettings,
  redactVariables,
  exportRequestSecrets,
  exportSettingsSecrets,
  exportVariableSecrets,
  importRequestSecrets,
  importSettingsSecrets,
  importVariableSecrets,
  encryptRequest,
  encryptSettings,
  encryptVariables,
} = require("./crypto");
const { CURRENT_SCHEMA_VERSION } = require("./migrations");

const BACKUP_KIND = "wurl-backup";

// Secret-handling modes for a backup. Recorded on the envelope as `secretsMode`
// (with the legacy boolean `secretsIncluded` kept in sync for older readers):
//   "none"     — secrets redacted (blanked); safe to share.
//   "machine"  — keystore ciphertext kept verbatim; only restores on THIS machine.
//   "password" — secrets re-encrypted under a user password (portable encp:v2:).
const SECRETS_NONE = "none";
const SECRETS_MACHINE = "machine";
const SECRETS_PASSWORD = "password";

class BackupStore {
  /**
   * @param {import('./paths').Paths}    paths
   * @param {import('./resolver').Resolver} resolver
   */
  constructor(paths, resolver) {
    this._paths = paths;
    this._resolver = resolver;
  }

  // ── Export ────────────────────────────────────────────────────────────────

  /**
   * Build a `wurl-backup` envelope for the entire workspace.
   *
   * Secrets live in six places — request auth fields, settings proxy URL +
   * credentials, collection-scope variables (metadata), folder-scope variables (tree nodes),
   * global variables and per-environment variables — and ALL of them are run
   * through the same `mode` transform so no secret leaves the machine in a form
   * the chosen mode forbids.
   *
   * @param {object} [opts]
   * @param {"none"|"machine"|"password"} [opts.mode] Secret-handling mode. Defaults
   *   to "machine" when `includeSecrets` is true, else "none".
   * @param {boolean} [opts.includeSecrets] Legacy alias for mode:"machine". Default false.
   * @param {string}  [opts.password]   Required when mode is "password".
   * @param {string}  [opts.exportedAt] ISO timestamp to stamp. Defaults to now.
   * @returns {object} The backup envelope.
   */
  exportAll(opts = {}) {
    const mode = _resolveExportMode(opts);
    const password = opts.password;
    if (mode === SECRETS_PASSWORD && !password) {
      throw new Error("a password is required for a password-protected backup");
    }
    const exportedAt = opts.exportedAt ?? new Date().toISOString();

    const manifest = this._readManifest(mode, password);
    const environments = _exportEnvironments(
      io.readJSON(this._paths.environmentsPath()),
      mode,
      password,
    );

    const collections = [];
    for (const id of this._listCollectionIds()) {
      let metadata = io.readJSON(this._paths.metadataPath(id));
      if (metadata === null) continue; // not a real collection dir
      metadata = _exportMetadata(metadata, mode, password);
      const rawTree = io.readJSON(this._paths.treePath(id)) ?? { children: [] };
      const requests = this._readRequests(id, mode, password);
      // When the on-disk tree is empty but request files exist, reconstruct a
      // flat folder so the backup is self-consistent and restores without loss.
      const reqIds = requests.map((r) => r.id).filter(Boolean);
      const tree = _exportTree(
        _ensureTreeHasRequests(id, rawTree, reqIds),
        mode,
        password,
      );
      collections.push({ id, metadata, tree, requests });
    }

    return {
      kind: BACKUP_KIND,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      exportedAt,
      secretsIncluded: mode !== SECRETS_NONE,
      secretsMode: mode,
      manifest,
      environments,
      collections,
    };
  }

  // ── Import ──────────────────────────────────────────────────────────────────

  /**
   * Restore a `wurl-backup` envelope onto this profile.
   *
   * When the envelope was exported in "password" mode its secrets are portable
   * ciphertext (encp:v2:). They are decrypted with `opts.password` and then
   * RE-ENCRYPTED to this machine's local keystore before being written, so the
   * profile never holds password ciphertext or plaintext at rest. With no (or a
   * wrong) password the values clear out while the `secure` flag is preserved.
   * A wrong password throws PasswordError, which the caller surfaces for retry.
   *
   * @param {object} envelope          Parsed backup document.
   * @param {object} [opts]
   * @param {"merge"|"replace"} [opts.mode] "replace" wipes existing collections +
   *   environments first; "merge" overlays the backup onto current data. Default "merge".
   * @param {string} [opts.password]   Required to recover secrets from a password backup.
   * @returns {{ collections: number, requests: number, mode: string }}
   */
  importAll(envelope, opts = {}) {
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
      throw _invalidBackup("backup is not an object");
    }
    if (envelope.kind !== BACKUP_KIND) {
      throw _invalidBackup(`unrecognised backup kind: ${envelope.kind}`);
    }
    const mode = opts.mode === "replace" ? "replace" : "merge";

    // A password-protected backup carries portable ciphertext; localize it to
    // this machine's keystore up front so the rest of the write path is uniform.
    const secretsMode =
      envelope.secretsMode ??
      (envelope.secretsIncluded ? SECRETS_MACHINE : SECRETS_NONE);
    if (secretsMode === SECRETS_PASSWORD) {
      envelope = _localizeEnvelope(envelope, opts.password);
    }

    const collections = Array.isArray(envelope.collections)
      ? envelope.collections
      : [];

    if (mode === "replace") {
      io.remove(this._paths.collectionsDir());
      io.remove(this._paths.environmentsDir());
    }

    // ── Name-based ID mapping (merge mode only) ───────────────────────────────
    // In merge mode, a backup collection that does not match any existing
    // collection by ID but DOES match one by name should be merged into that
    // existing slot rather than creating a duplicate.  The map is keyed by the
    // backup collection's ID and values the effective (current) ID to use for
    // writing files and for the manifest entry.
    const idMap =
      mode === "merge" ? this._buildNameIdMap(envelope.manifest) : new Map();

    // ── Manifest (collections list + settings) ──
    const manifest = this._mergeManifest(envelope.manifest, mode, idMap);
    if (manifest) {
      io.ensureDir(this._paths.collectionsDir());
      io.writeJSON(this._paths.manifestPath(), manifest);
    }

    // ── Environments ──
    const environments = this._mergeEnvironments(envelope.environments, mode);
    if (environments) {
      io.ensureDir(this._paths.environmentsDir());
      io.writeJSON(this._paths.environmentsPath(), environments);
    }

    // ── Per-collection files ──
    // In merge mode, only write collections that are listed in the backup's own
    // manifest.  The exportAll filesystem scan can pick up orphaned collection
    // directories on the source machine that were never registered in its manifest;
    // those should not be silently promoted to named collections on the destination.
    const allowedBackupIds = _manifestCollectionIds(envelope.manifest);

    let requestCount = 0;
    for (const coll of collections) {
      if (!coll || typeof coll !== "object" || !coll.id) continue;
      if (
        mode === "merge" &&
        allowedBackupIds !== null &&
        !allowedBackupIds.has(coll.id)
      )
        continue;

      // Apply the name-based mapping so data lands in the correct collection slot.
      const id = idMap.get(coll.id) ?? coll.id;
      io.validateID(id, "collectionId");
      io.ensureDir(this._paths.collectionDir(id));
      io.ensureDir(this._paths.requestsDir(id));

      const rawMeta = coll.metadata ?? { id, variables: [] };
      io.writeJSON(
        this._paths.metadataPath(id),
        rawMeta.id !== id ? { ...rawMeta, id } : rawMeta,
      );

      // Write requests first so their IDs are available for tree recovery below.
      const writtenReqIds = [];
      for (const req of Array.isArray(coll.requests) ? coll.requests : []) {
        if (!req || typeof req !== "object" || !req.id) continue;
        try {
          io.validateID(req.id, "requestId");
        } catch {
          continue;
        }
        io.writeJSON(this._paths.requestPath(id, req.id), req);
        writtenReqIds.push(req.id);
        requestCount += 1;
      }

      // Write tree. When the backup tree is empty but requests were restored,
      // build a minimal flat folder so the requests are visible after import
      // instead of being silently inaccessible.
      io.writeJSON(
        this._paths.treePath(id),
        _ensureTreeHasRequests(id, coll.tree, writtenReqIds),
      );
    }

    // New request→collection mappings are now on disk.
    this._resolver.invalidate();

    return { collections: collections.length, requests: requestCount, mode };
  }

  // ── Private: export helpers ───────────────────────────────────────────────

  /** Read the raw manifest, transforming settings secrets per `mode`. */
  _readManifest(mode, password) {
    const manifest = io.readJSON(this._paths.manifestPath());
    if (manifest === null) return null;
    if (manifest.settings) {
      return {
        ...manifest,
        settings: _exportSettings(manifest.settings, mode, password),
      };
    }
    return manifest;
  }

  /** Read every raw request file in a collection, transforming secrets per `mode`. */
  _readRequests(collId, mode, password) {
    const dir = this._paths.requestsDir(collId);
    const requests = [];
    for (const name of io.listDir(dir)) {
      if (!name.endsWith(".json") || io.isTempFileName(name)) continue;
      const req = io.readJSON(path.join(dir, name));
      if (req === null) continue;
      requests.push(_exportRequest(req, mode, password));
    }
    return requests;
  }

  /** List immediate sub-directory names under collections/ (skips index.json). */
  _listCollectionIds() {
    return io
      .listDir(this._paths.collectionsDir(), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  }

  // ── Private: import helpers ───────────────────────────────────────────────

  /**
   * Compute the manifest to persist. In replace mode the backup manifest wins
   * outright; in merge mode the collections lists are unioned by id while the
   * existing settings / active selection are preserved.
   *
   * `idMap` carries name-based remappings (backup ID → existing ID) computed by
   * `_buildNameIdMap`. A backup collection whose ID appears as a key in `idMap`
   * is already represented in the destination manifest under a different ID, so
   * its incoming entry is skipped — the existing entry takes priority.
   *
   * Both `incoming.collections` and the legacy `incoming.environments` key are
   * checked so that older backups (before the field was renamed) are handled
   * correctly. The same fallback applies to the on-disk `current` manifest.
   */
  _mergeManifest(incoming, mode, idMap = new Map()) {
    if (!incoming || typeof incoming !== "object") return null;
    if (mode === "replace") return incoming;

    const current = io.readJSON(this._paths.manifestPath());
    if (!current || typeof current !== "object") return incoming;

    const byId = new Map();
    for (const c of current.collections ?? current.environments ?? [])
      if (c && c.id) byId.set(c.id, c);
    for (const c of incoming.collections ?? incoming.environments ?? []) {
      if (!c || !c.id) continue;
      // Skip collections that were remapped to an existing entry by name: the
      // current entry already in byId is the canonical one to keep.
      if (idMap.has(c.id)) continue;
      byId.set(c.id, c);
    }

    return {
      ...current,
      collections: [...byId.values()],
      settings: { ...(incoming.settings ?? {}), ...(current.settings ?? {}) },
    };
  }

  /**
   * Build a backup-ID → existing-ID map for collections that match an existing
   * collection by name but not by ID.  Used in merge mode so that a backup's
   * "My API" collection is restored into the existing "My API" slot rather than
   * creating a duplicate with a different ID.
   *
   * @param {object|null} incomingManifest  The backup's manifest (envelope.manifest).
   * @returns {Map<string,string>}  backupId → effectiveId
   */
  _buildNameIdMap(incomingManifest) {
    const map = new Map();
    if (!incomingManifest || typeof incomingManifest !== "object") return map;

    const current = io.readJSON(this._paths.manifestPath());
    if (!current || typeof current !== "object") return map;

    // Build name → current-ID lookup and a set of current IDs (for fast lookup).
    const currentByName = new Map();
    const currentIds = new Set();
    for (const c of current.collections ?? current.environments ?? []) {
      if (c && c.id) {
        currentIds.add(c.id);
        if (c.name) currentByName.set(c.name, c.id);
      }
    }

    for (const c of incomingManifest.collections ??
      incomingManifest.environments ??
      []) {
      if (!c || !c.id) continue;
      if (currentIds.has(c.id)) continue; // ID already matches — no remapping needed
      if (c.name && currentByName.has(c.name)) {
        map.set(c.id, currentByName.get(c.name));
      }
    }

    return map;
  }

  /**
   * Compute the environments document to persist. Replace takes the backup as-is;
   * merge unions the named environments by id and keeps existing globals/active.
   */
  _mergeEnvironments(incoming, mode) {
    if (!incoming || typeof incoming !== "object") return null;
    if (mode === "replace") return incoming;

    const current = io.readJSON(this._paths.environmentsPath());
    if (!current || typeof current !== "object") return incoming;

    const byId = new Map();
    for (const e of current.environments ?? [])
      if (e && e.id) byId.set(e.id, e);
    for (const e of incoming.environments ?? [])
      if (e && e.id) byId.set(e.id, e);

    return {
      ...current,
      globalVariables: _mergeVarLists(
        incoming.globalVariables,
        current.globalVariables,
      ),
      environments: [...byId.values()],
    };
  }
}

module.exports = {
  BackupStore,
  BACKUP_KIND,
  SECRETS_NONE,
  SECRETS_MACHINE,
  SECRETS_PASSWORD,
};

/**
 * Return the Set of collection IDs listed in `manifest` (checking both the
 * current `collections` key and the legacy `environments` key), or `null` when
 * `manifest` is absent. A `null` return means "no manifest available — allow
 * all"; an empty Set means "manifest present but lists nothing".
 * @param {object|null|undefined} manifest
 * @returns {Set<string>|null}
 */
function _manifestCollectionIds(manifest) {
  if (!manifest || typeof manifest !== "object") return null;
  const ids = new Set();
  for (const key of ["collections", "environments"]) {
    for (const c of manifest[key] ?? []) {
      if (c && c.id) ids.add(c.id);
    }
  }
  return ids;
}

/**
 * Return a tree suitable for writing. When the incoming tree has no children
 * but there are restored request IDs, build a minimal single-folder tree so
 * the requests are visible after import rather than silently inaccessible.
 * When the tree already has content it is returned unchanged.
 *
 * The recovery folder uses the collection ID as both its id and name, matching
 * the layout RequestStore.createRequest produces for a brand-new collection.
 *
 * @param {string}   collId
 * @param {object}   [tree]
 * @param {string[]} reqIds  IDs of requests that were successfully written
 * @returns {object}
 */
function _ensureTreeHasRequests(collId, tree, reqIds) {
  const base = tree ?? { children: [] };
  if ((base.children ?? []).length > 0 || reqIds.length === 0) return base;
  return {
    ...base,
    children: [
      {
        id: collId,
        type: "folder",
        name: collId,
        variables: [],
        children: reqIds.map((rid) => ({ id: rid, type: "requestRef" })),
      },
    ],
  };
}

/** @param {string} message @returns {Error} */
function _invalidBackup(message) {
  const err = new Error(`invalid backup: ${message}`);
  err.code = "INVALID_BACKUP";
  return err;
}

// ── Export-side per-mode transforms ──────────────────────────────────────────

/**
 * Resolve the secret-handling mode from export options, honouring the legacy
 * `includeSecrets` boolean when `mode` is absent.
 * @param {{mode?: string, includeSecrets?: boolean}} opts
 * @returns {"none"|"machine"|"password"}
 */
function _resolveExportMode(opts) {
  if (
    opts.mode === SECRETS_NONE ||
    opts.mode === SECRETS_MACHINE ||
    opts.mode === SECRETS_PASSWORD
  ) {
    return opts.mode;
  }
  return opts.includeSecrets ? SECRETS_MACHINE : SECRETS_NONE;
}

/** Transform a variable list for export per mode. */
function _exportVarList(list, mode, password) {
  if (!Array.isArray(list)) return list;
  if (mode === SECRETS_NONE) return redactVariables(list);
  if (mode === SECRETS_PASSWORD) return exportVariableSecrets(list, password);
  return list; // machine: keystore ciphertext verbatim
}

/** Transform a settings object for export per mode. */
function _exportSettings(settings, mode, password) {
  if (mode === SECRETS_NONE) return redactSettings(settings);
  if (mode === SECRETS_PASSWORD)
    return exportSettingsSecrets(settings, password);
  return settings;
}

/** Transform a request object for export per mode. */
function _exportRequest(req, mode, password) {
  if (mode === SECRETS_NONE) return redactRequest(req);
  if (mode === SECRETS_PASSWORD) return exportRequestSecrets(req, password);
  return req;
}

/** Transform collection metadata (collection-scope variables) for export. */
function _exportMetadata(metadata, mode, password) {
  if (!metadata || typeof metadata !== "object") return metadata;
  if (!Array.isArray(metadata.variables)) return metadata;
  return {
    ...metadata,
    variables: _exportVarList(metadata.variables, mode, password),
  };
}

/** Transform the environments document (globals + per-env variables) for export. */
function _exportEnvironments(environments, mode, password) {
  if (!environments || typeof environments !== "object") return environments;
  const out = { ...environments };
  if (Array.isArray(environments.globalVariables)) {
    out.globalVariables = _exportVarList(
      environments.globalVariables,
      mode,
      password,
    );
  }
  if (Array.isArray(environments.environments)) {
    out.environments = environments.environments.map((env) =>
      env && Array.isArray(env.variables)
        ? { ...env, variables: _exportVarList(env.variables, mode, password) }
        : env,
    );
  }
  return out;
}

/** Recursively transform folder-scope variables on tree nodes for export. */
function _exportTree(tree, mode, password) {
  if (!tree || typeof tree !== "object") return tree;
  return { ...tree, children: _exportTreeNodes(tree.children, mode, password) };
}

function _exportTreeNodes(nodes, mode, password) {
  if (!Array.isArray(nodes)) return nodes;
  return nodes.map((node) => {
    if (!node || typeof node !== "object") return node;
    const out = { ...node };
    if (Array.isArray(node.variables)) {
      out.variables = _exportVarList(node.variables, mode, password);
    }
    if (Array.isArray(node.children)) {
      out.children = _exportTreeNodes(node.children, mode, password);
    }
    return out;
  });
}

// ── Import-side password localisation ─────────────────────────────────────────

/**
 * Convert every portable (encp:v2:) secret in a password-mode envelope into this
 * machine's local keystore ciphertext, returning a new envelope. Secrets are
 * decrypted with `password` then re-encrypted via the keystore encrypt* helpers;
 * with no/wrong password the underlying import* helpers clear the value (keeping
 * the `secure` flag) or PasswordError propagates to the caller.
 */
function _localizeEnvelope(envelope, password) {
  const out = { ...envelope };

  if (envelope.manifest && typeof envelope.manifest === "object") {
    const manifest = { ...envelope.manifest };
    if (manifest.settings) {
      manifest.settings = encryptSettings(
        importSettingsSecrets(manifest.settings, password),
      );
    }
    out.manifest = manifest;
  }

  out.environments = _localizeEnvironments(envelope.environments, password);

  if (Array.isArray(envelope.collections)) {
    out.collections = envelope.collections.map((coll) => {
      if (!coll || typeof coll !== "object") return coll;
      const next = { ...coll };
      if (coll.metadata && Array.isArray(coll.metadata.variables)) {
        next.metadata = {
          ...coll.metadata,
          variables: _localizeVarList(coll.metadata.variables, password),
        };
      }
      next.tree = _localizeTree(coll.tree, password);
      if (Array.isArray(coll.requests)) {
        next.requests = coll.requests.map((req) =>
          encryptRequest(importRequestSecrets(req, password)),
        );
      }
      return next;
    });
  }

  return out;
}

function _localizeVarList(list, password) {
  return encryptVariables(importVariableSecrets(list, password));
}

function _localizeEnvironments(environments, password) {
  if (!environments || typeof environments !== "object") return environments;
  const out = { ...environments };
  if (Array.isArray(environments.globalVariables)) {
    out.globalVariables = _localizeVarList(
      environments.globalVariables,
      password,
    );
  }
  if (Array.isArray(environments.environments)) {
    out.environments = environments.environments.map((env) =>
      env && Array.isArray(env.variables)
        ? { ...env, variables: _localizeVarList(env.variables, password) }
        : env,
    );
  }
  return out;
}

function _localizeTree(tree, password) {
  if (!tree || typeof tree !== "object") return tree;
  return { ...tree, children: _localizeTreeNodes(tree.children, password) };
}

function _localizeTreeNodes(nodes, password) {
  if (!Array.isArray(nodes)) return nodes;
  return nodes.map((node) => {
    if (!node || typeof node !== "object") return node;
    const out = { ...node };
    if (Array.isArray(node.variables)) {
      out.variables = _localizeVarList(node.variables, password);
    }
    if (Array.isArray(node.children)) {
      out.children = _localizeTreeNodes(node.children, password);
    }
    return out;
  });
}

/**
 * Coerce a variables collection to the canonical array shape, tolerant of both
 * the array shape ([{name,value,secure}]) and the legacy map shape
 * ({name:value}). This is the main-process twin of the renderer's
 * normalizeVariables() — the two cannot share a module across the IPC boundary.
 * @param {Array|object|null|undefined} input
 * @returns {{ name: string, value: *, secure: boolean }[]}
 */
function _toVarArray(input) {
  if (Array.isArray(input)) {
    const out = [];
    for (const entry of input) {
      if (!entry || typeof entry !== "object") continue;
      const name = String(entry.name ?? "").trim();
      if (!name) continue;
      out.push({ name, value: entry.value ?? "", secure: !!entry.secure });
    }
    return out;
  }
  if (input && typeof input === "object") {
    return Object.entries(input).map(([name, value]) => ({
      name: String(name),
      value,
      secure: false,
    }));
  }
  return [];
}

/**
 * Union two variable lists by name. `current` (the local, on-disk entry) wins on
 * a name conflict, mirroring merge-mode precedence elsewhere in this file.
 * Accepts either shape for each side; always returns the canonical array shape.
 * @param {Array|object|null|undefined} incoming
 * @param {Array|object|null|undefined} current
 * @returns {{ name: string, value: *, secure: boolean }[]}
 */
function _mergeVarLists(incoming, current) {
  const byName = new Map();
  for (const entry of _toVarArray(incoming)) byName.set(entry.name, entry);
  for (const entry of _toVarArray(current)) byName.set(entry.name, entry);
  return [...byName.values()];
}
