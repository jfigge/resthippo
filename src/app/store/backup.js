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
 *     secretsIncluded: <boolean>,  // true only for a "this machine only" export
 *     manifest:     { ...collections/index.json },
 *     environments: { ...environments/index.json } | null,
 *     collections: [
 *       { id, metadata: {...}, tree: {...}, requests: [ {...}, ... ] }
 *     ]
 *   }
 *
 * Secret handling (security-critical):
 *   - By default secrets are EXCLUDED. Every secret field (request auth fields,
 *     settings.proxyUrl) is blanked via crypto.redact* before it leaves the
 *     machine, so nothing sensitive is ever written to a backup in plaintext.
 *   - An explicit `includeSecrets` export keeps the on-disk keystore ciphertext
 *     verbatim. That ciphertext is bound to the originating machine's OS keystore
 *     and will NOT decrypt elsewhere — hence "this machine only".
 *
 * History and response payloads are intentionally out of scope: a backup
 * captures the reproducible workspace (collections + environments + settings),
 * not the execution log.
 *
 * All reads here operate on the RAW on-disk files (no decryption) so ciphertext
 * is preserved for the machine-only path; redaction is applied explicitly.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const io = require("./io");
const { redactRequest, redactSettings } = require("./crypto");
const { CURRENT_SCHEMA_VERSION } = require("./migrations");

const BACKUP_KIND = "wurl-backup";

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
   * @param {object} [opts]
   * @param {boolean} [opts.includeSecrets] Keep keystore ciphertext (machine-only). Default false.
   * @param {string}  [opts.exportedAt]     ISO timestamp to stamp. Defaults to now.
   * @returns {object} The backup envelope.
   */
  exportAll(opts = {}) {
    const includeSecrets = opts.includeSecrets === true;
    const exportedAt = opts.exportedAt ?? new Date().toISOString();

    const manifest = this._readManifest(includeSecrets);
    const environments = io.readJSON(this._paths.environmentsPath());

    const collections = [];
    for (const id of this._listCollectionIds()) {
      const metadata = io.readJSON(this._paths.metadataPath(id));
      if (metadata === null) continue; // not a real collection dir
      const tree = io.readJSON(this._paths.treePath(id)) ?? { children: [] };
      const requests = this._readRequests(id, includeSecrets);
      collections.push({ id, metadata, tree, requests });
    }

    return {
      kind: BACKUP_KIND,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      exportedAt,
      secretsIncluded: includeSecrets,
      manifest,
      environments,
      collections,
    };
  }

  // ── Import ──────────────────────────────────────────────────────────────────

  /**
   * Restore a `wurl-backup` envelope onto this profile.
   *
   * @param {object} envelope          Parsed backup document.
   * @param {object} [opts]
   * @param {"merge"|"replace"} [opts.mode] "replace" wipes existing collections +
   *   environments first; "merge" overlays the backup onto current data. Default "merge".
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
    const collections = Array.isArray(envelope.collections)
      ? envelope.collections
      : [];

    if (mode === "replace") {
      this._rmDir(this._paths.collectionsDir());
      this._rmDir(this._paths.environmentsDir());
    }

    // ── Manifest (collections list + settings) ──
    const manifest = this._mergeManifest(envelope.manifest, mode);
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
    let requestCount = 0;
    for (const coll of collections) {
      if (!coll || typeof coll !== "object" || !coll.id) continue;
      const id = coll.id;
      io.validateID(id, "collectionId");
      io.ensureDir(this._paths.collectionDir(id));
      io.ensureDir(this._paths.requestsDir(id));

      io.writeJSON(
        this._paths.metadataPath(id),
        coll.metadata ?? { id, variables: {} },
      );
      io.writeJSON(this._paths.treePath(id), coll.tree ?? { children: [] });

      for (const req of Array.isArray(coll.requests) ? coll.requests : []) {
        if (!req || typeof req !== "object" || !req.id) continue;
        try {
          io.validateID(req.id, "requestId");
        } catch {
          continue;
        }
        io.writeJSON(this._paths.requestPath(id, req.id), req);
        requestCount += 1;
      }
    }

    // New request→collection mappings are now on disk.
    this._resolver.invalidate();

    return { collections: collections.length, requests: requestCount, mode };
  }

  // ── Private: export helpers ───────────────────────────────────────────────

  /** Read the raw manifest, redacting settings secrets unless includeSecrets. */
  _readManifest(includeSecrets) {
    const manifest = io.readJSON(this._paths.manifestPath());
    if (manifest === null) return null;
    if (!includeSecrets && manifest.settings) {
      return { ...manifest, settings: redactSettings(manifest.settings) };
    }
    return manifest;
  }

  /** Read every raw request file in a collection, redacting secrets by default. */
  _readRequests(collId, includeSecrets) {
    const dir = this._paths.requestsDir(collId);
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const requests = [];
    for (const name of names) {
      if (!name.endsWith(".json") || io.isTempFileName(name)) continue;
      const req = io.readJSON(path.join(dir, name));
      if (req === null) continue;
      requests.push(includeSecrets ? req : redactRequest(req));
    }
    return requests;
  }

  /** List immediate sub-directory names under collections/ (skips index.json). */
  _listCollectionIds() {
    let entries;
    try {
      entries = fs.readdirSync(this._paths.collectionsDir(), {
        withFileTypes: true,
      });
    } catch {
      return [];
    }
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  }

  // ── Private: import helpers ───────────────────────────────────────────────

  /**
   * Compute the manifest to persist. In replace mode the backup manifest wins
   * outright; in merge mode the collections lists are unioned by id while the
   * existing settings / active selection are preserved.
   */
  _mergeManifest(incoming, mode) {
    if (!incoming || typeof incoming !== "object") return null;
    if (mode === "replace") return incoming;

    const current = io.readJSON(this._paths.manifestPath());
    if (!current || typeof current !== "object") return incoming;

    const byId = new Map();
    for (const c of current.collections ?? []) if (c && c.id) byId.set(c.id, c);
    for (const c of incoming.collections ?? [])
      if (c && c.id) byId.set(c.id, c);

    return {
      ...current,
      collections: [...byId.values()],
      settings: { ...(incoming.settings ?? {}), ...(current.settings ?? {}) },
    };
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
      globalVariables: {
        ...(incoming.globalVariables ?? {}),
        ...(current.globalVariables ?? {}),
      },
      environments: [...byId.values()],
    };
  }

  /** Recursively remove a directory if it exists (best-effort). */
  _rmDir(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { BackupStore, BACKUP_KIND };

/** @param {string} message @returns {Error} */
function _invalidBackup(message) {
  const err = new Error(`invalid backup: ${message}`);
  err.code = "INVALID_BACKUP";
  return err;
}
