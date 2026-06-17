/**
 * request-payload.js — Shared HTTP request-payload assembly
 *
 * Both the interactive editor (RequestEditor.#sendRequest) and the dependency
 * prefetcher (app.js _executeRequestNode) turn a request's fields into the
 * { url, headers, body, … } shape the native HTTP layer forwards. The work —
 * query-param encoding, header resolution, the auth transforms that reduce to a
 * static header / query value (basic, bearer, apikey) or a pass-through
 * credential bag the main process consumes (digest, ntlm, aws-iam), and body
 * serialisation for every body type — is identical between the two and lives
 * here so it can't drift.
 *
 * NOT handled here (left to the caller):
 *   • Resolving and (optionally) percent-encoding the base URL. Pass the final
 *     base in `spec.urlBase`. The editor percent-encodes via encodeBaseUrl();
 *     the prefetcher intentionally does not — keeping that policy with the
 *     caller is the whole reason urlBase is an input rather than computed here.
 *   • OAuth2. Its token acquisition is interactive (popups, live DOM reads,
 *     cancel/abort, error CustomEvents) and cannot be a pure value transform.
 *     The editor runs that flow itself and injects the Authorization header.
 */

"use strict";

import { extractOperationName } from "./graphql-schema.js";

/** Body-type → Content-Type for the text-ish body kinds. */
export const BODY_CONTENT_TYPES = {
  json: "application/json",
  yaml: "application/x-yaml",
  xml: "application/xml",
  text: "text/plain",
};

/** HTTP methods that must never carry a request body. */
export const NO_BODY_METHODS = new Set(["GET", "HEAD"]);

/** Percent-encode the domain and path of a resolved URL. */
export function encodeBaseUrl(url) {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

/** Basename of a filesystem path (handles both "/" and "\" separators). */
function baseName(p) {
  return (p ?? "").split(/[\\/]/).pop() ?? "";
}

// ── Path parameters ──────────────────────────────────────────────────────────
// Path tokens are `:name` (only when preceded by "/", so URL scheme, ports, and
// userinfo are excluded) or `{name}` (single braces). `{{var}}` variable pills
// are matched first and skipped so they're never treated as path tokens. One
// pattern drives detection, substitution, and (in the editor) the Path Params
// table, so the three can't drift.

/** Fresh global matcher for path tokens (fresh object ⇒ no shared lastIndex state). */
function pathParamRe() {
  return /\{\{[^}]*\}\}|(?<=\/):([A-Za-z_]\w*)|\{([A-Za-z_]\w*)\}/g;
}

/**
 * Detect path-parameter tokens in a URL template, in order, de-duped by name.
 * @param {string} url
 * @returns {{ name: string, style: ":" | "{}" }[]}
 */
export function detectPathParams(url) {
  const out = [];
  const seen = new Set();
  if (!url) return out;
  for (const m of url.matchAll(pathParamRe())) {
    if (m[0].startsWith("{{")) continue; // variable pill — not a path token
    const name = m[1] ?? m[2];
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, style: m[1] != null ? ":" : "{}" });
  }
  return out;
}

/**
 * Substitute path tokens whose name is present in `valueMap`. Variable pills
 * (`{{…}}`) pass through untouched; tokens with no map entry are left literal.
 * Pure and synchronous so codegen (sync) and the async send path share it.
 * @param {string} url
 * @param {Map<string, string>} valueMap  name → already-encoded value
 * @returns {string}
 */
export function applyPathParams(url, valueMap) {
  if (!url || !valueMap || valueMap.size === 0) return url;
  return url.replace(pathParamRe(), (full, colonName, braceName) => {
    if (full.startsWith("{{")) return full;
    const name = colonName ?? braceName;
    return valueMap.has(name) ? valueMap.get(name) : full;
  });
}

/**
 * Resolve each path-param row's value (through `rv`) and percent-encode it as a
 * path segment, keyed by trimmed name. Rows with a blank name are skipped.
 * @param {{ name: string, value: string }[]} pathParams
 * @param {(s: string) => Promise<string>} rv
 * @returns {Promise<Map<string, string>>}
 */
export async function resolvePathParamValues(pathParams, rv) {
  const map = new Map();
  for (const p of pathParams ?? []) {
    const name = (p.name ?? "").trim();
    if (!name) continue;
    map.set(name, encodeURIComponent(await rv(p.value ?? "")));
  }
  return map;
}

/**
 * Assemble the native request payload from a resolved request spec.
 *
 * @param {object} spec
 *   @param {string}  spec.method        HTTP method (default "GET")
 *   @param {string}  spec.urlBase       base URL, already resolved + (optionally) encoded
 *   @param {Array}   spec.params        [{ enabled, name, value }] query params
 *   @param {Array}   spec.headers       [{ enabled, name, value }] header rows
 *   @param {boolean} spec.authEnabled   truthy = apply auth (caller normalises its own default)
 *   @param {string}  spec.authType      "none"|"basic"|"bearer"|"apikey"|"digest"|"ntlm"|"aws-iam"|"oauth1"|"oauth2"
 *   @param {object}  spec.authBasic     { username, password }
 *   @param {object}  spec.authBearer    { token }
 *   @param {object}  spec.authApiKey    { name, value, addTo }
 *   @param {object}  spec.authDigest    { username, password }
 *   @param {object}  spec.authNtlm      { username, password, domain, workstation }
 *   @param {object}  spec.authAwsIam    { accessKeyId, secretAccessKey, region, service, sessionToken }
 *   @param {object}  spec.authOAuth1    { consumerKey, consumerSecret, token, tokenSecret, signatureMethod, realm }
 *   @param {string}  spec.bodyType      "json"|"yaml"|"xml"|"text"|"graphql"|"form-urlencoded"|"form-data"|"file"|"no-body"
 *   @param {string}  spec.bodyText      raw text for text-ish body types
 *   @param {object}  spec.bodyGraphql   { query, variables } for the "graphql" body type;
 *                                       serialised to a `{ query, variables, operationName }` JSON POST
 *   @param {Array}   spec.bodyFormRows  [{ enabled, name, value, kind?, filePath?, fileName?, contentType? }]
 *                                       form fields; a `kind:"file"` row carries a file path instead of value
 *   @param {object}  spec.bodyFile      { path, type } for the "file" body type, or null
 * @param {(s: string) => Promise<string>} rv  async variable resolver
 * @returns {Promise<{finalUrl, headers, body, bodyFilePath, multipart, awsIam, authDigest, authNtlm, oauth1}>}
 *   `multipart` (or null) is a { boundary, parts[] } spec the main process streams when a form-data body
 *   contains file fields; the file bytes are read in main (only paths cross IPC).
 */
export async function buildRequestPayload(spec, rv) {
  const method = spec.method ?? "GET";

  // ── 1. URL — append enabled, non-blank query parameters ────────────────────
  let finalUrl = spec.urlBase ?? "";
  const enabledParams = (spec.params ?? []).filter(
    (p) => p.enabled && (p.name ?? "").trim(),
  );
  if (enabledParams.length) {
    const qs = (
      await Promise.all(
        enabledParams.map(
          async (p) =>
            `${encodeURIComponent(await rv(p.name))}=${encodeURIComponent(await rv(p.value))}`,
        ),
      )
    ).join("&");
    finalUrl += (finalUrl.includes("?") ? "&" : "?") + qs;
  }

  // ── 2. Headers — enabled, non-blank rows ───────────────────────────────────
  const headers = {};
  for (const h of (spec.headers ?? []).filter(
    (h) => h.enabled && (h.name ?? "").trim(),
  )) {
    headers[(await rv(h.name)).trim()] = await rv(h.value);
  }

  // ── 3. Auth — static header / query value, or pass-through credential bag ──
  // Digest and NTLM can't set a header up-front (they need the server's 401
  // challenge), so their credentials are resolved and handed to the native
  // layer, which runs the stateful challenge/response in the main process.
  // OAuth2 is intentionally absent — see the module header.
  let awsIam = null;
  let authDigest = null;
  let authNtlm = null;
  let oauth1 = null;
  if (spec.authEnabled && spec.authType && spec.authType !== "none") {
    switch (spec.authType) {
      case "basic": {
        const username = await rv(spec.authBasic?.username ?? "");
        const password = await rv(spec.authBasic?.password ?? "");
        if (username || password) {
          headers["Authorization"] = `Basic ${btoa(`${username}:${password}`)}`;
        }
        break;
      }
      case "bearer":
        if (spec.authBearer?.token)
          headers["Authorization"] =
            `Bearer ${await rv(spec.authBearer.token)}`;
        break;
      case "apikey": {
        const name = (await rv(spec.authApiKey?.name ?? "")).trim();
        const value = await rv(spec.authApiKey?.value ?? "");
        if (name) {
          if (spec.authApiKey?.addTo === "query") {
            const qs = `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
            finalUrl += (finalUrl.includes("?") ? "&" : "?") + qs;
          } else {
            headers[name] = value;
          }
        }
        break;
      }
      case "digest": {
        const username = await rv(spec.authDigest?.username ?? "");
        if (username) {
          authDigest = {
            username,
            password: await rv(spec.authDigest?.password ?? ""),
          };
        }
        break;
      }
      case "ntlm": {
        const username = await rv(spec.authNtlm?.username ?? "");
        if (username) {
          authNtlm = {
            username,
            password: await rv(spec.authNtlm?.password ?? ""),
            domain: await rv(spec.authNtlm?.domain ?? ""),
            workstation: await rv(spec.authNtlm?.workstation ?? ""),
          };
        }
        break;
      }
      case "aws-iam": {
        awsIam = {
          accessKeyId: await rv(spec.authAwsIam?.accessKeyId ?? ""),
          secretAccessKey: await rv(spec.authAwsIam?.secretAccessKey ?? ""),
          region: await rv(spec.authAwsIam?.region ?? ""),
          service: await rv(spec.authAwsIam?.service ?? ""),
          sessionToken: await rv(spec.authAwsIam?.sessionToken ?? ""),
        };
        break;
      }
      case "oauth1": {
        // OAuth 1.0a signs the request line + params, so — like aws-iam — the
        // credentials are resolved here and handed to the main process, which
        // computes the Authorization: OAuth … signature at send time.
        const consumerKey = (
          await rv(spec.authOAuth1?.consumerKey ?? "")
        ).trim();
        if (consumerKey) {
          oauth1 = {
            consumerKey,
            consumerSecret: await rv(spec.authOAuth1?.consumerSecret ?? ""),
            token: await rv(spec.authOAuth1?.token ?? ""),
            tokenSecret: await rv(spec.authOAuth1?.tokenSecret ?? ""),
            signatureMethod: spec.authOAuth1?.signatureMethod || "HMAC-SHA1",
            realm: (await rv(spec.authOAuth1?.realm ?? "")).trim(),
          };
        }
        break;
      }
      // oauth2: handled by the caller (interactive token acquisition).
    }
  }

  // ── 4. Body — serialise to a plain string (or file path) ───────────────────
  // GET and HEAD must not carry a body. All body types serialise to a plain
  // string (or null) so they can cross the native layer (Electron IPC / Go dev
  // server), which can't receive FormData, URLSearchParams, or File objects.
  let body = null;
  let bodyFilePath = null;
  let multipart = null;
  if (!NO_BODY_METHODS.has(method)) {
    switch (spec.bodyType) {
      case "json":
      case "yaml":
      case "xml":
      case "text":
        if ((spec.bodyText ?? "").trim()) {
          body = await rv(spec.bodyText);
          if (!headers["Content-Type"])
            headers["Content-Type"] = BODY_CONTENT_TYPES[spec.bodyType];
        }
        break;
      case "graphql": {
        // Serialise to the standard GraphQL POST: { query, variables, operationName }.
        // {{var}} tokens resolve in BOTH the query and the variables JSON before
        // assembly. operationName is derived from the query when a named
        // operation is present.
        const query = await rv(spec.bodyGraphql?.query ?? "");
        const varsText = (await rv(spec.bodyGraphql?.variables ?? "")).trim();
        if (query.trim() || varsText) {
          const payload = { query };
          if (varsText) {
            try {
              payload.variables = JSON.parse(varsText);
            } catch {
              // Invalid variables JSON — surfaced by the editor's inline JSON
              // badge; omit rather than send a malformed `variables` field.
            }
          }
          const operationName = extractOperationName(query);
          if (operationName) payload.operationName = operationName;
          body = JSON.stringify(payload);
          if (!headers["Content-Type"])
            headers["Content-Type"] = "application/json";
        }
        break;
      }
      case "form-urlencoded": {
        const sp = new URLSearchParams();
        for (const r of (spec.bodyFormRows ?? []).filter(
          (r) => r.enabled && (r.name ?? "").trim(),
        )) {
          sp.append(await rv(r.name), await rv(r.value));
        }
        body = sp.toString();
        if (!headers["Content-Type"])
          headers["Content-Type"] = "application/x-www-form-urlencoded";
        break;
      }
      case "form-data": {
        const rows = (spec.bodyFormRows ?? []).filter(
          (r) => r.enabled && (r.name ?? "").trim(),
        );
        if (rows.length > 0) {
          const boundary = `----RestHippoBoundary${Date.now()}`;
          if (rows.some((r) => r.kind === "file")) {
            // Mixed text + file parts can't be serialised here — only the file
            // PATH is available in the renderer, not its bytes. Emit a structured
            // spec the main process streams (reading each file's bytes in main).
            multipart = {
              boundary,
              parts: await Promise.all(
                rows.map(async (r) => {
                  if (r.kind === "file") {
                    return {
                      kind: "file",
                      name: await rv(r.name),
                      filePath: r.filePath ?? "",
                      filename: r.fileName || baseName(r.filePath ?? ""),
                      contentType: r.contentType || "",
                    };
                  }
                  return {
                    kind: "text",
                    name: await rv(r.name),
                    value: await rv(r.value),
                  };
                }),
              ),
            };
          } else {
            const parts = (
              await Promise.all(
                rows.map(
                  async (r) =>
                    `--${boundary}\r\nContent-Disposition: form-data; name="${await rv(r.name)}"\r\n\r\n${await rv(r.value)}`,
                ),
              )
            ).join("\r\n");
            body = `${parts}\r\n--${boundary}--`;
          }
          if (!headers["Content-Type"])
            headers["Content-Type"] =
              `multipart/form-data; boundary=${boundary}`;
        }
        break;
      }
      case "file":
        if (spec.bodyFile) {
          // Electron exposes the real filesystem path via File.path.
          // In a plain browser context this will be undefined/empty.
          bodyFilePath = spec.bodyFile.path ?? "";
          if (!headers["Content-Type"])
            headers["Content-Type"] =
              spec.bodyFile.type || "application/octet-stream";
        }
        break;
      default:
        break; // "no-body" — leave body as null
    }
  }

  return {
    finalUrl,
    headers,
    body,
    bodyFilePath,
    multipart,
    awsIam,
    authDigest,
    authNtlm,
    oauth1,
  };
}
