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
 * cookie-store.js — Per-collection persistent cookie jar.
 *
 * Stores cookies captured from `Set-Cookie` response headers and computes the
 * `Cookie` header to attach to outgoing requests. One jar per collection, on
 * disk at collections/<collectionId>/cookies.json with the standard atomic-write
 * + schema-versioning machinery (see io.js / Feature 01).
 *
 * SECURITY / SCOPE (features/09-cookie-jar.md):
 *   - All cookie storage and attachment logic lives in the main process; the
 *     renderer only ever views/edits the jar over IPC.
 *   - Cookies are never sent across non-matching domains — the domain/path/
 *     secure/expiry rules in cookie-jar.js gate every attachment.
 *
 * The RFC-6265 semantics (parsing, matching, expiry) live in the dependency-free
 * cookie-jar.js so they can be unit-tested in isolation; this class only adds
 * persistence and per-collection scoping.
 */
"use strict";

const { readJSON, writeJSON, ensureDir, validateID } = require("./io");
const jar = require("./cookie-jar");

const DEFAULT_JAR = Object.freeze({ cookies: [] });

class CookieStore {
  /**
   * @param {import('./paths').Paths} paths
   */
  constructor(paths) {
    this._paths = paths;
  }

  /**
   * Current epoch ms. Isolated as a method so tests can stub it deterministically.
   * @returns {number}
   */
  _now() {
    return Date.now();
  }

  /**
   * Read the raw jar document for a collection, returning a fresh default when
   * the file does not exist yet. Does not prune — see {@link listCookies}.
   * @param {string} collectionId
   * @returns {{cookies:object[]}}
   */
  _readJar(collectionId) {
    validateID(collectionId, "collectionId");
    const data = readJSON(this._paths.cookiesPath(collectionId));
    if (!data || !Array.isArray(data.cookies))
      return { ...DEFAULT_JAR, cookies: [] };
    return data;
  }

  /**
   * Persist the jar document for a collection (atomic + schema-stamped).
   * @param {string} collectionId
   * @param {object[]} cookies
   */
  _writeJar(collectionId, cookies) {
    validateID(collectionId, "collectionId");
    ensureDir(this._paths.collectionDir(collectionId));
    writeJSON(this._paths.cookiesPath(collectionId), { cookies });
  }

  /**
   * List the live (non-expired) cookies in a collection's jar, pruning expired
   * entries from disk as a side effect so the manager UI never shows stale rows.
   * @param {string} collectionId
   * @returns {object[]}
   */
  listCookies(collectionId) {
    const now = this._now();
    const data = this._readJar(collectionId);
    const live = jar.pruneExpired(data.cookies, now);
    if (live.length !== data.cookies.length) this._writeJar(collectionId, live);
    return live;
  }

  /**
   * Capture `Set-Cookie` header values from a response into the jar.
   *
   * Each raw header line is normalised against the request URL (default
   * domain/path, host-only flag, Max-Age vs Expires) and upserted; cross-domain
   * and unparseable cookies are dropped by cookie-jar.js. No-ops when there are
   * no cookies to store.
   *
   * @param {string} collectionId
   * @param {string} requestUrl  the URL the response came from
   * @param {string[]} setCookieLines  raw Set-Cookie header values
   */
  captureSetCookies(collectionId, requestUrl, setCookieLines) {
    if (!Array.isArray(setCookieLines) || setCookieLines.length === 0) return;
    const now = this._now();
    const data = this._readJar(collectionId);
    let cookies = jar.pruneExpired(data.cookies, now);
    let changed = false;
    for (const line of setCookieLines) {
      const cookie = jar.cookieFromSetCookie(line, requestUrl, now);
      if (!cookie) continue;
      cookies = jar.upsertCookie(cookies, cookie, now);
      changed = true;
    }
    if (changed || cookies.length !== data.cookies.length) {
      this._writeJar(collectionId, cookies);
    }
  }

  /**
   * Compute the `Cookie` request-header value for an outgoing request, selecting
   * only cookies whose domain/path/secure/expiry match the target URL.
   * @param {string} collectionId
   * @param {string} requestUrl
   * @returns {string} header value, or "" when no cookies match
   */
  cookieHeaderFor(collectionId, requestUrl) {
    const now = this._now();
    const data = this._readJar(collectionId);
    const matching = jar.selectCookies(data.cookies, requestUrl, now);
    return jar.serializeCookieHeader(matching);
  }

  /**
   * Replace one cookie's value/attributes or insert it, identified by
   * name+domain+path. Used by the manager's edit action.
   * @param {string} collectionId
   * @param {object} cookie  a full jar entry
   */
  upsertCookie(collectionId, cookie) {
    const now = this._now();
    const data = this._readJar(collectionId);
    const next = jar.upsertCookie(
      data.cookies,
      { creation: now, ...cookie },
      now,
    );
    this._writeJar(collectionId, next);
  }

  /**
   * Delete a single cookie identified by name+domain+path.
   * @param {string} collectionId
   * @param {{name:string,domain:string,path:string}} ident
   */
  deleteCookie(collectionId, ident) {
    const data = this._readJar(collectionId);
    const next = data.cookies.filter((c) => !jar.sameIdentity(c, ident));
    this._writeJar(collectionId, next);
  }

  /**
   * Remove every cookie in a collection's jar. Takes effect immediately — the
   * next request to any host sends nothing.
   * @param {string} collectionId
   */
  clearJar(collectionId) {
    this._writeJar(collectionId, []);
  }
}

module.exports = { CookieStore };
