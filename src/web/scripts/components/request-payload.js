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

/**
 * Assemble the native request payload from a resolved request spec.
 *
 * @param {object} spec
 *   @param {string}  spec.method        HTTP method (default "GET")
 *   @param {string}  spec.urlBase       base URL, already resolved + (optionally) encoded
 *   @param {Array}   spec.params        [{ enabled, name, value }] query params
 *   @param {Array}   spec.headers       [{ enabled, name, value }] header rows
 *   @param {boolean} spec.authEnabled   truthy = apply auth (caller normalises its own default)
 *   @param {string}  spec.authType      "none"|"basic"|"bearer"|"apikey"|"digest"|"ntlm"|"aws-iam"|"oauth2"
 *   @param {object}  spec.authBasic     { username, password }
 *   @param {object}  spec.authBearer    { token }
 *   @param {object}  spec.authApiKey    { name, value, addTo }
 *   @param {object}  spec.authDigest    { username, password }
 *   @param {object}  spec.authNtlm      { username, password, domain, workstation }
 *   @param {object}  spec.authAwsIam    { accessKeyId, secretAccessKey, region, service, sessionToken }
 *   @param {string}  spec.bodyType      "json"|"yaml"|"xml"|"text"|"form-urlencoded"|"form-data"|"file"|"no-body"
 *   @param {string}  spec.bodyText      raw text for text-ish body types
 *   @param {Array}   spec.bodyFormRows  [{ enabled, name, value }] form fields
 *   @param {object}  spec.bodyFile      { path, type } for the "file" body type, or null
 * @param {(s: string) => Promise<string>} rv  async variable resolver
 * @returns {Promise<{finalUrl, headers, body, bodyFilePath, awsIam, authDigest, authNtlm}>}
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
      // oauth2: handled by the caller (interactive token acquisition).
    }
  }

  // ── 4. Body — serialise to a plain string (or file path) ───────────────────
  // GET and HEAD must not carry a body. All body types serialise to a plain
  // string (or null) so they can cross the native layer (Electron IPC / Go dev
  // server), which can't receive FormData, URLSearchParams, or File objects.
  let body = null;
  let bodyFilePath = null;
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
        const boundary = `----WurlBoundary${Date.now()}`;
        const rows = (spec.bodyFormRows ?? []).filter(
          (r) => r.enabled && (r.name ?? "").trim(),
        );
        if (rows.length > 0) {
          const parts = (
            await Promise.all(
              rows.map(
                async (r) =>
                  `--${boundary}\r\nContent-Disposition: form-data; name="${await rv(r.name)}"\r\n\r\n${await rv(r.value)}`,
              ),
            )
          ).join("\r\n");
          body = `${parts}\r\n--${boundary}--`;
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
    awsIam,
    authDigest,
    authNtlm,
  };
}
