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
 * graphql-introspection.js — Run a GraphQL introspection request.
 *
 * Kept separate from graphql-schema.js (pure) and request-editor.js (UI): this
 * is the only piece that touches the native HTTP layer. It mirrors the
 * Electron / dev-server dispatch in app.js (window.hippo.http.execute vs. the
 * /api/execute proxy) but stays isolated so a "Fetch schema" click never writes
 * history or repaints the response viewer.
 *
 * The caller (the editor) assembles { url, headers, body } via the shared
 * buildRequestPayload() so the request's own auth/headers apply; this function
 * just executes and validates the response, throwing a descriptive Error on
 * every failure path (network, non-2xx, invalid JSON, GraphQL `errors`, missing
 * __schema) so the editor can surface it rather than fail silently.
 */

"use strict";

/**
 * Build an introspection failure Error. This module touches no UI and keeps the
 * `t()` seam out, so the English text becomes the Error's `.message` (used for
 * logs / fallback) while `i18nKey` (+ optional `i18nParams`) lets the calling UI
 * localize it at the catch site.
 *
 * @param {string} message  English fallback
 * @param {string} i18nKey  dotted catalog key
 * @param {object} [i18nParams]  interpolation params for the key
 */
function introspectionError(message, i18nKey, i18nParams) {
  return Object.assign(new Error(message), { i18nKey, i18nParams });
}

/**
 * Execute the introspection POST and return the parsed introspection envelope
 * (`{ data: { __schema } }`). Throws on any failure.
 *
 * @param {object} opts
 * @param {string} opts.url      resolved endpoint URL
 * @param {object} opts.headers  resolved request headers (Content-Type forced)
 * @param {string} opts.body     the JSON-stringified `{ query }` introspection body
 * @param {number} [opts.timeout]
 * @param {boolean} [opts.verifySsl=true]       honor the user's SSL-verification
 *   setting so a self-signed endpoint that the user can already send to can also
 *   be introspected.
 * @param {boolean} [opts.followRedirects=true]
 * @returns {Promise<object>} the parsed introspection JSON
 */
export async function executeIntrospection({
  url,
  headers,
  body,
  timeout = 30000,
  verifySsl = true,
  followRedirects = true,
}) {
  const desc = {
    method: "POST",
    url,
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
    body,
    timeout,
    followRedirects,
    verifySsl,
  };

  let result;
  if (window.hippo?.isElectron === true) {
    if (typeof window.hippo?.http?.execute !== "function") {
      throw introspectionError(
        "window.hippo.http.execute is not available — rebuild the app with the latest preload.js.",
        "request.graphql.errExecuteUnavailable",
      );
    }
    result = await window.hippo.http.execute(desc);
  } else {
    const res = await fetch("/api/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(desc),
    });
    if (!res.ok)
      throw introspectionError(
        `Execute API returned HTTP ${res.status}.`,
        "request.graphql.errExecuteApi",
        { status: res.status },
      );
    result = await res.json();
  }

  // Network-level failure — no HTTP response was received. A real transport
  // message (from the engine) is more useful than the generic key, so prefer it.
  if (result?.error && (result.status ?? 0) === 0) {
    throw introspectionError(
      result.error.message || "Network error during introspection.",
      result.error.message ? undefined : "request.graphql.errNetwork",
    );
  }

  const status = result?.status ?? 0;
  if (status < 200 || status >= 300) {
    throw introspectionError(
      `Introspection failed: HTTP ${status}.`,
      "request.graphql.errHttp",
      { status },
    );
  }

  const rawBody = typeof result?.body === "string" ? result.body : "";
  let json;
  try {
    json = JSON.parse(rawBody);
  } catch {
    throw introspectionError(
      "Introspection response was not valid JSON.",
      "request.graphql.errNotJson",
    );
  }

  if (Array.isArray(json?.errors) && json.errors.length) {
    const msg = json.errors
      .map((e) => e?.message)
      .filter(Boolean)
      .join("; ");
    throw introspectionError(
      `GraphQL error: ${msg || "introspection rejected"}.`,
      msg ? "request.graphql.errGraphql" : "request.graphql.errGraphqlRejected",
      msg ? { message: msg } : undefined,
    );
  }

  if (!json?.data?.__schema && !json?.__schema) {
    throw introspectionError(
      "Introspection response contained no __schema.",
      "request.graphql.errNoSchema",
    );
  }

  return json;
}
