/**
 * graphql-introspection.js — Run a GraphQL introspection request.
 *
 * Kept separate from graphql-schema.js (pure) and request-editor.js (UI): this
 * is the only piece that touches the native HTTP layer. It mirrors the
 * Electron / dev-server dispatch in app.js (window.wurl.http.execute vs. the
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
 * Execute the introspection POST and return the parsed introspection envelope
 * (`{ data: { __schema } }`). Throws on any failure.
 *
 * @param {object} opts
 * @param {string} opts.url      resolved endpoint URL
 * @param {object} opts.headers  resolved request headers (Content-Type forced)
 * @param {string} opts.body     the JSON-stringified `{ query }` introspection body
 * @param {number} [opts.timeout]
 * @returns {Promise<object>} the parsed introspection JSON
 */
export async function executeIntrospection({
  url,
  headers,
  body,
  timeout = 30000,
}) {
  const desc = {
    method: "POST",
    url,
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
    body,
    timeout,
    followRedirects: true,
    verifySsl: true,
  };

  let result;
  if (window.wurl?.isElectron === true) {
    if (typeof window.wurl?.http?.execute !== "function") {
      throw new Error(
        "window.wurl.http.execute is not available — rebuild the app with the latest preload.js.",
      );
    }
    result = await window.wurl.http.execute(desc);
  } else {
    const res = await fetch("/api/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(desc),
    });
    if (!res.ok) throw new Error(`Execute API returned HTTP ${res.status}.`);
    result = await res.json();
  }

  // Network-level failure — no HTTP response was received.
  if (result?.error && (result.status ?? 0) === 0) {
    throw new Error(
      result.error.message || "Network error during introspection.",
    );
  }

  const status = result?.status ?? 0;
  if (status < 200 || status >= 300) {
    throw new Error(`Introspection failed: HTTP ${status}.`);
  }

  const rawBody = typeof result?.body === "string" ? result.body : "";
  let json;
  try {
    json = JSON.parse(rawBody);
  } catch {
    throw new Error("Introspection response was not valid JSON.");
  }

  if (Array.isArray(json?.errors) && json.errors.length) {
    const msg = json.errors
      .map((e) => e?.message)
      .filter(Boolean)
      .join("; ");
    throw new Error(`GraphQL error: ${msg || "introspection rejected"}.`);
  }

  if (!json?.data?.__schema && !json?.__schema) {
    throw new Error("Introspection response contained no __schema.");
  }

  return json;
}
