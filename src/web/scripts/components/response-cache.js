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
 * components/response-cache.js — the last-response cache app.js keeps so a
 * request's most recent body / headers / status can be re-shown when its tab is
 * reselected without re-firing the request.
 *
 * Extracted from three scattered module-level maps in app.js (`_responseCache`,
 * `_responseHeaders`, `_responseStatus`) so the caching rule — seed under BOTH
 * the request id and its name, so a reference stored either way resolves — lives
 * in one importable, testable place. The three maps are exposed as public fields
 * so callers that read them by reference (the request-editor context) keep the
 * exact same sharing semantics they had before.
 */

"use strict";

export class ResponseCache {
  /** Cached response bodies, keyed by request id AND name. */
  bodies = {};
  /** Cached response header maps, keyed by request id AND name. */
  headers = {};
  /** Cached response statuses, keyed by request id AND name. */
  statuses = {};

  /**
   * Seed the caches for a request under both its id and its name, so a
   * reference stored either way resolves. `ref` is anything carrying {id, name}
   * (a tree node or a resolveRequestRef() result). Missing keys are skipped.
   *
   * @param {{id?: string, name?: string}|null|undefined} ref
   * @param {*} body
   * @param {*} headers
   * @param {*} status
   */
  set(ref, body, headers, status) {
    for (const key of [ref?.id, ref?.name]) {
      if (!key) continue;
      this.bodies[key] = body;
      this.headers[key] = headers;
      this.statuses[key] = status;
    }
  }
}
