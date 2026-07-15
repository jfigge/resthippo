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
