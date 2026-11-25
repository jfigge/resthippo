/*
 * Copyright 2026 Jason Figge
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This file is part of Rest Hippo.
 *
 * Rest Hippo is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option) any later
 * version.
 *
 * Rest Hippo is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR
 * A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with
 * Rest Hippo. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * net/body-spill.js — large-body spill-to-disk, shared by every engine that
 * produces a response body (HTTP, Command).
 *
 * Bodies below RESPONSE_SPILL_THRESHOLD stay fully in memory. Above it, the
 * bytes stream to a temp file under `response-cache/` and only a small preview
 * crosses IPC; the renderer redeems the opaque ref for the full body (or saves
 * it to disk) via `http:body:get` / `http:body:save`.
 *
 *   • SpillRegistry  — bounded LRU of ref → { path, size, contentType, isBinary }.
 *                      One instance is created in main.js and injected into both
 *                      the HTTP engine and the command IPC so refs from either
 *                      are redeemable through the same channels.
 *   • SpillCollector — accumulates a byte stream, switching to a temp file once
 *                      the threshold is crossed (used by the command runner).
 */
"use strict";

const fs = require("fs");
const io = require("../store/io");

/** Spill bodies larger than this (bytes) to disk instead of buffering. */
const RESPONSE_SPILL_THRESHOLD = 8 * 1024 * 1024; // 8 MB
/** Preview kept in memory / sent to the renderer for a spilled response. */
const RESPONSE_PREVIEW_BYTES = 256 * 1024; // 256 KB
/** Most-recent spilled bodies retained before the oldest is evicted. */
const SPILL_REGISTRY_MAX = 20;

class SpillRegistry {
  /** @type {Map<string, {path:string,size:number,contentType:string,isBinary:boolean}>} */
  #entries = new Map();
  #max;

  /** @param {{ max?: number }} [opts] */
  constructor({ max = SPILL_REGISTRY_MAX } = {}) {
    this.#max = max;
  }

  /**
   * Register a spilled body and return an opaque ref the renderer can redeem.
   * Evicts (and unlinks) the oldest entry once the registry is full — Map
   * preserves insertion order, so the first key is the least-recently spilled.
   * @param {{ path: string, size: number, contentType: string, isBinary: boolean }} entry
   * @returns {string} ref
   */
  register(entry) {
    const ref = io.newUUID();
    this.#entries.set(ref, entry);
    while (this.#entries.size > this.#max) {
      const oldestRef = this.#entries.keys().next().value;
      const old = this.#entries.get(oldestRef);
      this.#entries.delete(oldestRef);
      // Already gone (manual delete or startup GC) is fine — best-effort.
      io.remove(old.path);
    }
    return ref;
  }

  /** @returns {{path:string,size:number,contentType:string,isBinary:boolean}|undefined} */
  get(ref) {
    return this.#entries.get(ref);
  }

  get size() {
    return this.#entries.size;
  }
}

/**
 * Collects a byte stream in memory until it crosses `threshold`, then spills
 * everything (and every later chunk) to a temp file in `dir`. A bounded preview
 * of the first `previewBytes` is always kept.
 */
class SpillCollector {
  #dir;
  #threshold;
  #previewBytes;
  #memChunks = [];
  #previewChunks = [];
  #previewLen = 0;
  #total = 0;
  #stream = null;
  #path = null;
  #error = null;

  /**
   * @param {{ dir: () => string, threshold?: number, previewBytes?: number }} opts
   *   `dir` is a thunk so the cache directory is only resolved (and created)
   *   when a spill actually happens.
   */
  constructor({
    dir,
    threshold = RESPONSE_SPILL_THRESHOLD,
    previewBytes = RESPONSE_PREVIEW_BYTES,
  }) {
    this.#dir = dir;
    this.#threshold = threshold;
    this.#previewBytes = previewBytes;
  }

  get total() {
    return this.#total;
  }

  get spilled() {
    return this.#stream !== null;
  }

  /**
   * Append a chunk. Returns false when the disk write buffer is full — the
   * caller should pause its source and resume on `onceDrain`.
   * @param {Buffer} chunk
   * @returns {boolean}
   */
  write(chunk) {
    this.#total += chunk.length;
    if (this.#previewLen < this.#previewBytes) {
      const remaining = this.#previewBytes - this.#previewLen;
      const slice =
        chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      this.#previewChunks.push(slice);
      this.#previewLen += slice.length;
    }
    if (this.#stream) {
      return this.#error ? true : this.#stream.write(chunk);
    }
    this.#memChunks.push(chunk);
    if (this.#total > this.#threshold) {
      try {
        const dir = this.#dir();
        io.ensureDir(dir);
        this.#path = io.newTempPath(dir, "response");
        this.#stream = fs.createWriteStream(this.#path);
        this.#stream.on("error", (err) => {
          this.#error = err;
        });
        for (const c of this.#memChunks) this.#stream.write(c);
      } catch (err) {
        this.#error = err;
      }
      this.#memChunks = []; // release the buffered body
    }
    return true;
  }

  /** Invoke `fn` once the spill stream drains (no-op when not spilling). */
  onceDrain(fn) {
    if (this.#stream) this.#stream.once("drain", fn);
    else fn();
  }

  /**
   * Finish collecting.
   * @returns {Promise<{ buffer: Buffer|null, preview: Buffer, total: number,
   *   path: string|null, error: Error|null }>}
   *   `buffer` is the full body when it never spilled; otherwise null and
   *   `path` names the temp file (or `error` explains why the spill failed —
   *   the temp file is then already removed).
   */
  finish() {
    const preview = Buffer.concat(this.#previewChunks);
    if (!this.#stream) {
      return Promise.resolve({
        buffer: Buffer.concat(this.#memChunks),
        preview,
        total: this.#total,
        path: null,
        error: null,
      });
    }
    return new Promise((resolve) => {
      this.#stream.end(() => {
        if (this.#error) io.remove(this.#path);
        resolve({
          buffer: null,
          preview,
          total: this.#total,
          path: this.#error ? null : this.#path,
          error: this.#error,
        });
      });
    });
  }

  /** Abandon the collection, removing any temp file. */
  discard() {
    if (this.#stream) {
      const p = this.#path;
      this.#stream.end(() => io.remove(p));
    }
    this.#memChunks = [];
  }
}

module.exports = {
  RESPONSE_SPILL_THRESHOLD,
  RESPONSE_PREVIEW_BYTES,
  SPILL_REGISTRY_MAX,
  SpillRegistry,
  SpillCollector,
};
