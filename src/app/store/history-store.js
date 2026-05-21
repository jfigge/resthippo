/**
 * history-store.js — Request execution history with lazy-loaded response payloads.
 *
 * Layout:
 *   collections/<collId>/history/<reqId>/<histId>.json   ← lightweight entry metadata
 *   collections/<collId>/responses/<reqId>/<histId>.json ← full response payload
 *
 * Separation of metadata from response bodies keeps list operations fast
 * regardless of how large the response bodies are.
 *
 * Pagination is cursor-based: the cursor is the opaque ID of the last entry
 * already consumed. An empty cursor starts from the most recent entry.
 */
"use strict";

const fs   = require("fs");
const path = require("path");
const { readJSON, writeJSON, ensureDir, validateID, newUUID, notFoundError } = require("./io");

/** Maximum allowed page size. */
const MAX_LIMIT = 100;
/** Default page size when caller omits limit. */
const DEFAULT_LIMIT = 20;

class HistoryStore {
  /**
   * @param {import('./paths').Paths}       paths
   * @param {import('./resolver').Resolver} resolver
   */
  constructor(paths, resolver) {
    this._paths    = paths;
    this._resolver = resolver;
  }

  // ── List (paginated) ────────────────────────────────────────────────────────

  /**
   * Return a cursor-paginated page of history entries for `requestId`,
   * ordered newest-first.
   *
   * @param {string} requestId
   * @param {object} [options]
   * @param {number} [options.limit=20]   Max entries per page (1–100)
   * @param {string} [options.cursor=""]  Opaque cursor from a previous page's nextCursor
   * @returns {{ items: object[], nextCursor: string }}
   */
  listHistory(requestId, options = {}) {
    validateID(requestId, "requestId");
    const collId = this._resolver.resolve(requestId);

    const limit  = Math.min(MAX_LIMIT, Math.max(1, options.limit ?? DEFAULT_LIMIT));
    const cursor = options.cursor ?? "";

    const histDir = this._paths.historyDir(collId, requestId);
    if (!fs.existsSync(histDir)) {
      return { items: [], nextCursor: "" };
    }

    // Load all entry files.
    let files;
    try {
      files = fs.readdirSync(histDir).filter(f => f.endsWith(".json"));
    } catch {
      return { items: [], nextCursor: "" };
    }

    const entries = [];
    for (const file of files) {
      const data = readJSON(path.join(histDir, file));
      if (data !== null) entries.push(data);
    }

    // Sort newest-first by timestamp (ISO strings compare lexicographically).
    entries.sort((a, b) => {
      const ta = a.timestamp ?? "";
      const tb = b.timestamp ?? "";
      return tb > ta ? 1 : tb < ta ? -1 : 0;
    });

    // Apply cursor: skip everything up to and including the cursor entry.
    let startIdx = 0;
    if (cursor) {
      const idx = entries.findIndex(e => e.id === cursor);
      startIdx  = idx >= 0 ? idx + 1 : 0;
    }

    const page = entries.slice(startIdx, startIdx + limit);

    // nextCursor = ID of the last item in this page (empty = no more pages).
    let nextCursor = "";
    if (startIdx + limit < entries.length && page.length > 0) {
      nextCursor = page[page.length - 1].id;
    }

    return { items: page, nextCursor };
  }

  // ── Add ─────────────────────────────────────────────────────────────────────

  /**
   * Record a new execution.
   * Assigns `id` and `timestamp` if they are absent.
   * The response payload is written before the entry metadata so that, on a
   * crash between the two writes, only an orphaned response file exists
   * (invisible to list operations).
   *
   * @param {string} requestId
   * @param {object} entry     Execution metadata: { status, durationMs, responseSize, … }
   * @param {object} [response] Full response: { headers, body, contentType, … }
   * @returns {object}         The entry as stored (with id + timestamp assigned)
   */
  addHistory(requestId, entry, response) {
    validateID(requestId, "requestId");
    const collId = this._resolver.resolve(requestId);

    if (!entry.id)        entry = { ...entry, id: newUUID() };
    if (!entry.timestamp) entry = { ...entry, timestamp: new Date().toISOString() };
    entry = { ...entry, requestId };
    validateID(entry.id, "historyId");

    // Write response first (so the entry never references a missing response).
    if (response) {
      ensureDir(this._paths.responsesDir(collId, requestId));
      writeJSON(this._paths.responsePath(collId, requestId, entry.id), {
        ...response,
        historyId: entry.id,
        requestId,
      });
    }

    ensureDir(this._paths.historyDir(collId, requestId));
    writeJSON(this._paths.historyEntryPath(collId, requestId, entry.id), entry);

    return entry;
  }

  // ── Get response (lazy) ─────────────────────────────────────────────────────

  /**
   * Retrieve the full response payload for one history entry.
   *
   * @param {string} requestId
   * @param {string} historyId
   * @returns {object} Response payload
   * @throws code="NOT_FOUND"
   */
  getHistoryResponse(requestId, historyId) {
    validateID(requestId, "requestId");
    validateID(historyId,  "historyId");
    const collId = this._resolver.resolve(requestId);
    const data   = readJSON(this._paths.responsePath(collId, requestId, historyId));
    if (data === null) {
      throw notFoundError(`history response not found: ${historyId}`);
    }
    return data;
  }
}

module.exports = { HistoryStore };

