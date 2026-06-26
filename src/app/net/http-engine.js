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
 * http-engine.js — the outgoing HTTP/HTTPS request engine + its IPC surface.
 *
 * Extracted verbatim from main.js (the former initHttpIPC IIFE). Owns the actual
 * network execution in the main process so the sandboxed renderer never touches
 * the socket: the request engine (doRequest / executeWithRetries with redirect,
 * digest/NTLM 401 challenge-response, retry, timing and cookie-jar handling),
 * large-response spill-to-disk, live SSE/NDJSON streaming, and the
 * http:execute / http:body:* / http:stream:* IPC handlers.
 *
 * Everything network-related it needs it requires directly; the handful of
 * main-process collaborators (Electron ipcMain/app/dialog, the main window, the
 * stores accessor and the safeCall logging wrapper) are injected by main.js via
 * registerHttpEngine() so this module stays loadable under plain node — which is
 * what lets net/tests/http-engine.test.js characterize it against a local server.
 */
"use strict";

const http = require("http");
const https = require("https");
const tls = require("tls");
const fs = require("fs");
const zlib = require("zlib");
const { Readable } = require("stream");
const { StringDecoder } = require("string_decoder");
const { URL } = require("url");

const io = require("../store/io");
const {
  isBinaryContentType,
  looksBinary,
  decodeText,
} = require("../http-content-type");
const aws4 = require("aws4");
const {
  withProxyCredentials,
  hostBypassesProxy,
  makeProxyAgent,
} = require("./proxy");
const {
  selectClientCert,
  hostSkipsTlsVerify,
  loadClientCertMaterial,
  loadCaBundle,
} = require("./tls");
const {
  normalizeRetry,
  retryReason,
  retryDelay,
  isIdempotentMethod,
} = require("./retry");
const { computeTiming, formatTiming } = require("./timing");
const {
  SseParser,
  LineBuffer,
  isEventStream,
  isNdjson,
  MAX_STREAM_ITEM_BYTES,
} = require("./sse");
const {
  parseChallenge,
  selectDigestChallenge,
  buildAuthorization: buildDigestAuthorization,
} = require("../auth/digest");
const {
  createType1Message,
  selectNtlmChallenge,
  decodeType2Message,
  createType3Message,
} = require("../auth/ntlm");
const {
  buildAuthorizationHeader: buildOAuth1Header,
} = require("../auth/oauth1");

// Header names whose values are credentials / session material. Their values are
// masked in the verbose console so a token or cookie never reaches the persisted
// history log in plaintext (the request store encrypts these same fields), and
// they are dropped from a request that redirects to a different origin so a
// redirect can't replay the user's credentials to another host.
const CREDENTIAL_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
]);

/** Mask a credential header value for the verbose console; pass others through. */
function redactHeader(name, value) {
  return CREDENTIAL_HEADERS.has(name.toLowerCase()) ? "<redacted>" : value;
}

// Mirror Node's own header validation (checkInvalidHeaderChar / checkIsHttpToken)
// so a malformed header fails gracefully with a precise message instead of
// letting http.request() throw a raw `TypeError [ERR_INVALID_CHAR]` (which the
// async `req.on("error")` handler can't catch — see findInvalidHeader's use
// below). The classic trigger is a Cookie/Authorization VALUE carrying a
// character HTTP forbids: a line break, a control char, or any char above
// U+00FF (smart quotes, en/em dashes, ellipsis, emoji pasted from a document).
const HEADER_VALUE_INVALID = /[^\t\x20-\x7e\x80-\xff]/; // ctrl chars + > U+00FF
const HEADER_NAME_TOKEN = /^[\^_`a-zA-Z\-0-9!#$%&'*+.|~]+$/; // RFC 7230 token

/**
 * Return `{ code, message }` for the first header Node would reject (bad name,
 * undefined value, or an invalid character in a value), or null when every
 * header is wire-legal. Array values are checked element-by-element, matching
 * how http.request() validates multi-value headers.
 */
function findInvalidHeader(headers) {
  for (const [name, raw] of Object.entries(headers || {})) {
    if (!HEADER_NAME_TOKEN.test(name))
      return {
        code: "ERR_INVALID_HTTP_TOKEN",
        message: `Header name "${name}" contains characters not allowed in an HTTP header name.`,
      };
    for (const v of Array.isArray(raw) ? raw : [raw]) {
      if (v === undefined)
        return {
          code: "ERR_HTTP_INVALID_HEADER_VALUE",
          message: `Header "${name}" has no value.`,
        };
      const m = HEADER_VALUE_INVALID.exec(String(v));
      if (m) {
        const cp = m[0]
          .codePointAt(0)
          .toString(16)
          .toUpperCase()
          .padStart(4, "0");
        return {
          code: "ERR_INVALID_CHAR",
          message: `Header "${name}" has an invalid character (U+${cp}) in its value — HTTP header values can't contain line breaks, control characters, or characters above U+00FF.`,
        };
      }
    }
  }
  return null;
}

/**
 * A zlib transform that reverses a response's Content-Encoding, or null when the
 * body is not compressed (identity / absent / an encoding we don't handle, which
 * is passed through untouched). Node's raw http/https — unlike fetch/undici —
 * never auto-decompresses, so without this a gzip'd JSON/HTML body reaches the
 * renderer as high-entropy bytes that looksBinary() flags as binary and base64s
 * into an unreadable blob. gzip and br cover essentially every real server;
 * deflate uses the zlib-wrapped form (raw, header-less deflate is not detected).
 *
 * @param {string} encoding  response content-encoding header value, lowercased
 * @returns {import('stream').Transform | null}
 */
function createDecompressor(encoding) {
  switch (encoding) {
    case "gzip":
    case "x-gzip":
      return zlib.createGunzip();
    case "br":
      return zlib.createBrotliDecompress();
    case "deflate":
      return zlib.createInflate();
    default:
      return null;
  }
}

/**
 * Register the HTTP execute / body / stream IPC handlers and start the engine.
 * @param {object} deps
 * @param {object} deps.ipcMain      Electron ipcMain (handle)
 * @param {object} deps.app          Electron app (web-contents-created cleanup)
 * @param {object} deps.dialog       Electron dialog (Save-as for spilled bodies)
 * @param {() => object|null} deps.getMainWin  current main BrowserWindow (dialog parent)
 * @param {() => object} deps.getStores        stores accessor (cookie jar, TLS settings)
 * @param {Function} deps.safeCall   logging-guarded call wrapper from main.js
 */
function registerHttpEngine({
  ipcMain,
  app,
  dialog,
  getMainWin,
  getStores,
  safeCall,
}) {
  // ── Large-response spill-to-disk ───────────────────────────────────────────
  //
  // Responses below the threshold stay fully in renderer memory as today. Above
  // it, the body is streamed to a temp file under `response-cache/` (with the
  // socket paused under backpressure so memory stays bounded), and only a small
  // preview crosses to the renderer. The renderer can then fetch the full body
  // or save it straight to disk on demand via `http:body:get` / `http:body:save`.

  /** Spill bodies larger than this (bytes) to disk instead of buffering. */
  const RESPONSE_SPILL_THRESHOLD = 8 * 1024 * 1024; // 8 MB
  /** Preview kept in memory / sent to the renderer for a spilled response. */
  const RESPONSE_PREVIEW_BYTES = 256 * 1024; // 256 KB
  /** Most-recent spilled bodies retained before the oldest is evicted. */
  const SPILL_REGISTRY_MAX = 20;

  /** ref → { path, size, contentType, isBinary } for bodies spilled to disk. */
  const spilledBodies = new Map();

  /**
   * Register a spilled body and return an opaque ref the renderer can redeem.
   * Evicts (and unlinks) the oldest entry once the registry is full — Map
   * preserves insertion order, so the first key is the least-recently spilled.
   * @param {{ path: string, size: number, contentType: string, isBinary: boolean }} entry
   * @returns {string} ref
   */
  function registerSpilledBody(entry) {
    const ref = io.newUUID();
    spilledBodies.set(ref, entry);
    while (spilledBodies.size > SPILL_REGISTRY_MAX) {
      const oldestRef = spilledBodies.keys().next().value;
      const old = spilledBodies.get(oldestRef);
      spilledBodies.delete(oldestRef);
      // Already gone (manual delete or startup GC) is fine — best-effort.
      io.remove(old.path);
    }
    return ref;
  }

  // ── Live streaming responses (Feature 33) ──────────────────────────────────
  //
  // A `text/event-stream` response (or any response on a request the user marked
  // as streaming) is not buffered: its body is forwarded to the renderer as it
  // arrives over the push channels http:stream:data / -end / -error, while a copy
  // is spilled to disk so the full stream can still be saved. The descriptor's
  // `_stream` context (set in the http:execute handler) carries the stream id and
  // the sender; the in-flight request is tracked here so it can be aborted (Stop)
  // and torn down when its renderer goes away.

  /** streamId → { req, senderId, spillPath, spillStream, bytes, events, recent, ended, contentType, aborted } */
  const activeStreams = new Map();

  // ── In-flight non-streaming requests (Stop) ────────────────────────────────
  //
  // A buffered (non-streaming) request runs entirely in the main process: the
  // socket, the download, and any spill-to-disk keep going until the server
  // finishes, even after the renderer has discarded the result. Without a way to
  // reach that socket, the interactive "Stop" could only hide the result, not
  // end the work. We track each interactive send's current leg here so http:abort
  // can destroy it. The renderer mints one id per send (the same id it uses as
  // streamId) and keys the handle by it; doRequest replaces `req` with each
  // redirect/auth/retry leg's ClientRequest, so abort always hits the open one.
  // A request that turns into a live stream is controlled via activeStreams
  // instead and is removed from here when http:execute resolves.
  //
  /** execId → { req, senderId, aborted } */
  const activeRequests = new Map();

  // The renderer writes one Timeline record per streaming run (Feature 33). We
  // keep the last few events here (each event's data capped) and hand them off
  // in the stream end/error payload so that record is bounded in size.
  const STREAM_RECORD_EVENTS = 5;
  const STREAM_RECORD_EVENT_MAX = 2048;

  /** Push to a renderer only while its webContents is still alive. */
  function sendTo(sender, channel, payload) {
    if (sender && !sender.isDestroyed()) {
      sender.send(channel, payload);
    }
  }

  /**
   * Assemble a multipart/form-data body from a { boundary, parts } spec built by
   * the renderer (request-payload.js). Text parts are inlined; file parts are
   * streamed from disk — the bytes are read HERE, in the main process, so only
   * the file path ever crossed IPC. `statSync` lets us set an exact
   * Content-Length while still streaming the bytes (so large files don't buffer).
   *
   * Returns the precomputed byte length plus two consumers: `createStream()` for
   * the normal streamed send, and `toBuffer()` for the rare AWS-SigV4 case that
   * must hash the whole body. Throws (caught by the caller) if a file part can't
   * be stat'd / read — a missing upload file is a hard error, not a silent skip.
   *
   * @param {{ boundary: string, parts: object[] }} multipart
   */
  function buildMultipartBody(multipart) {
    const { boundary } = multipart;
    const CRLF = "\r\n";
    // Strip CR/LF and neutralise quotes in field names/filenames so they can't
    // break out of the Content-Disposition header (RFC 7578 sanitisation).
    const clean = (s) =>
      String(s ?? "").replace(/[\r\n"]/g, (c) => (c === '"' ? "%22" : ""));
    // A part's Content-Type is a header value too: strip CR/LF so a crafted
    // contentType (e.g. from an imported collection) can't inject a header line.
    const cleanHeaderValue = (s) => String(s ?? "").replace(/[\r\n]/g, "");

    const segments = multipart.parts.map((part) => {
      let header = `--${boundary}${CRLF}Content-Disposition: form-data; name="${clean(part.name)}"`;
      if (part.kind === "file") {
        header += `; filename="${clean(part.filename)}"${CRLF}`;
        header += `Content-Type: ${cleanHeaderValue(part.contentType) || "application/octet-stream"}${CRLF}${CRLF}`;
        return {
          header: Buffer.from(header),
          file: part.filePath,
          contentLen: fs.statSync(part.filePath).size,
        };
      }
      header += `${CRLF}${CRLF}`;
      const buf = Buffer.from(part.value ?? "", "utf8");
      return { header: Buffer.from(header), buf, contentLen: buf.length };
    });
    const closing = Buffer.from(`--${boundary}--${CRLF}`);
    const crlfLen = Buffer.byteLength(CRLF);

    let length = closing.length;
    for (const s of segments)
      length += s.header.length + s.contentLen + crlfLen;

    return {
      length,
      createStream() {
        return Readable.from(
          (async function* () {
            for (const s of segments) {
              yield s.header;
              if (s.file) {
                for await (const chunk of fs.createReadStream(s.file))
                  yield chunk;
              } else {
                yield s.buf;
              }
              yield Buffer.from(CRLF);
            }
            yield closing;
          })(),
        );
      },
      toBuffer() {
        const chunks = [];
        for (const s of segments) {
          chunks.push(s.header);
          chunks.push(s.file ? fs.readFileSync(s.file) : s.buf);
          chunks.push(Buffer.from(CRLF));
        }
        chunks.push(closing);
        return Buffer.concat(chunks);
      },
    };
  }

  /** A credential-free, scheme://host[:port] view of a proxy URL for logging. */
  function describeProxy(proxyUrl) {
    try {
      const u = new URL(proxyUrl);
      return `${u.protocol}//${u.host}`;
    } catch {
      return "(invalid proxy URL)";
    }
  }

  /**
   * Resolve the mTLS / custom-trust configuration for an outgoing request from
   * the global settings (Certificates panel), reading and decrypting the
   * manifest in the main process so passphrases never round-trip through the
   * renderer for the send. Reading happens ONCE per http:execute (the result is
   * threaded onto the descriptor as `_tls` and reused across redirect/auth legs),
   * and the custom CA bundle is read here too so the files are loaded a single
   * time per request rather than per leg. Returns null when nothing is
   * configured, leaving Node's default TLS behaviour completely untouched.
   *
   * @param {string[]} consoleLog
   * @returns {{ clientCerts: Array, insecureHosts: string, caBundle: Buffer[]|null }|null}
   */
  function loadTlsConfig(consoleLog) {
    return safeCall(
      "tls config",
      () => {
        const settings =
          getStores().collectionStore().getManifest().settings || {};
        const clientCerts = Array.isArray(settings.clientCerts)
          ? settings.clientCerts
          : [];
        const caPaths = Array.isArray(settings.caCerts)
          ? settings.caCerts.filter(Boolean)
          : [];
        const insecureHosts = settings.tlsInsecureHosts || "";
        if (!clientCerts.length && !caPaths.length && !insecureHosts) {
          return null;
        }
        const caBundle = loadCaBundle(
          caPaths,
          (p) => fs.readFileSync(p),
          tls.rootCertificates,
          (p, err) =>
            consoleLog.push(`* Custom CA load error (${p}): ${err.message}`),
        );
        if (caBundle) {
          consoleLog.push(
            `* Trusting ${caPaths.length} custom CA file(s) in addition to the system roots`,
          );
        }
        return { clientCerts, insecureHosts, caBundle };
      },
      null,
    );
  }

  /**
   * Apply the resolved TLS config to one request leg's options, by host:
   *   • a matching client certificate is presented (mTLS);
   *   • the custom CA bundle is trusted (global, with verification still on);
   *   • a host on the insecure list has verification skipped for that host only.
   * Mutates `options` in place. A configured-but-unreadable client cert is
   * surfaced in the Console rather than silently sending with no identity.
   *
   * @param {object} options
   * @param {string} host
   * @param {number|string} port
   * @param {{ clientCerts: Array, insecureHosts: string, caBundle: Buffer[]|null }} cfg
   * @param {string[]} consoleLog
   */
  function applyTlsOptions(options, host, port, cfg, consoleLog) {
    if (cfg.caBundle) options.ca = cfg.caBundle;

    if (hostSkipsTlsVerify(host, port, cfg.insecureHosts)) {
      options.rejectUnauthorized = false;
      consoleLog.push(
        `* TLS verification skipped for ${host} (matches insecure-hosts list)`,
      );
    }

    const entry = selectClientCert(host, port, cfg.clientCerts);
    if (entry) {
      try {
        Object.assign(
          options,
          loadClientCertMaterial(entry, (p) => fs.readFileSync(p)),
        );
        consoleLog.push(
          `* Presenting client certificate for ${host} (${entry.format === "pfx" ? "PFX" : "PEM"})`,
        );
      } catch (err) {
        consoleLog.push(
          `* Client certificate error for ${host}: ${err.message}`,
        );
      }
    }
  }

  /**
   * Perform one HTTP request leg (no redirect logic here — handled below).
   * Returns a Promise that always resolves (never rejects) with a result object.
   *
   * @param {object}   desc        - Normalised request descriptor
   * @param {string[]} consoleLog  - Mutable array for verbose output lines
   * @param {number}   startTime   - Date.now() at the very start of the call
   * @param {number}   redirects   - How many redirects have been followed so far
   */
  function doRequest(desc, consoleLog, startTime, redirects) {
    const {
      method = "GET",
      url: rawUrl,
      headers = {},
      body = null,
      bodyFilePath = null,
      multipart = null,
      timeout = 30000,
      followRedirects = true,
      verifySsl = true,
      maxRedirects = 10,
      awsIam = null,
      authDigest = null,
      authNtlm = null,
      oauth1 = null,
      proxy = null,
      proxyUsername = "",
      proxyPassword = "",
      proxyBypass = "",
      collectionId = null,
      useCookieJar = true,
    } = desc;

    return new Promise((resolve) => {
      // ── Parse URL ──────────────────────────────────────────────────────────
      let parsed;
      try {
        parsed = new URL(rawUrl);
      } catch (e) {
        consoleLog.push(`* URL parse error: ${e.message}`);
        resolve({
          status: 0,
          statusText: "",
          headers: {},
          cookies: [],
          body: "",
          elapsed: Date.now() - startTime,
          size: 0,
          consoleLog,
          error: { name: "TypeError", message: e.message },
        });
        return;
      }

      const isHttps = parsed.protocol === "https:";
      const lib = isHttps ? https : http;
      const defaultPort = isHttps ? 443 : 80;
      const port = parsed.port ? parseInt(parsed.port, 10) : defaultPort;
      const effectiveMethod = method.toUpperCase();

      // ── NTLM negotiate (MS-NLMP) ──────────────────────────────────────────
      // NTLM is connection-bound: the Type 2 challenge and the Type 3 response
      // MUST travel on ONE keep-alive socket. We drive the handshake by
      // recursion with a dedicated single-socket agent (_ntlmAgent) threaded
      // through both legs so they share the connection. This first entry sends
      // the Type 1 negotiate (no body); the 401 it earns carries Type 2, which
      // the response handler answers with Type 3 + the real body. The agent is
      // destroyed once the whole chain settles, so no keep-alive socket leaks.
      if (
        authNtlm?.username &&
        redirects === 0 &&
        !desc._ntlmNegotiate &&
        !desc._ntlmAuthorized
      ) {
        const ntlmAgent = new lib.Agent({
          keepAlive: true,
          maxSockets: 1,
          maxFreeSockets: 1,
        });
        if (proxy) {
          consoleLog.push(
            "* NTLM handshake bypasses the configured proxy (target-server auth)",
          );
        }
        const negHeaders = { ...headers };
        for (const k of Object.keys(negHeaders)) {
          if (k.toLowerCase() === "authorization") delete negHeaders[k];
        }
        negHeaders.Authorization = createType1Message();
        negHeaders["Content-Length"] = "0"; // negotiate leg carries no body
        doRequest(
          {
            ...desc,
            headers: negHeaders,
            _ntlmNegotiate: true,
            _ntlmAgent: ntlmAgent,
          },
          consoleLog,
          startTime,
          redirects,
        ).then((result) => {
          ntlmAgent.destroy();
          resolve(result);
        });
        return;
      }

      // ── Resolve body ───────────────────────────────────────────────────────
      const reqHeaders = { ...headers };
      let bodyBuffer = null;
      let multipartStream = null; // set when streaming a multipart/form-data body

      // ── Attach matching jar cookies ─────────────────────────────────────────
      // The jar lives in the main process; selectCookies() only returns cookies
      // whose domain/path/secure/expiry match this URL, so cookies are never
      // sent across non-matching domains. A user-set Cookie header is preserved
      // and the jar's cookies are merged in after it.
      if (useCookieJar && collectionId) {
        const jarHeader = safeCall(
          "cookie attach",
          () => getStores().cookieStore().cookieHeaderFor(collectionId, rawUrl),
          "",
        );
        if (jarHeader) {
          const existingKey = Object.keys(reqHeaders).find(
            (k) => k.toLowerCase() === "cookie",
          );
          if (existingKey && reqHeaders[existingKey]) {
            reqHeaders[existingKey] =
              `${reqHeaders[existingKey]}; ${jarHeader}`;
          } else {
            reqHeaders[existingKey || "Cookie"] = jarHeader;
          }
        }
      }

      // Build the outgoing body on every leg except the NTLM negotiate (Type 1)
      // leg, which carries no body. This must NOT be gated on `redirects === 0`:
      // a 307/308 redirect preserves the method and re-supplies body/bodyFilePath/
      // multipart (see the redirect recursion below), so the buffer/stream has to
      // be rebuilt for the new leg or the redirected request ships an empty body
      // (and SigV4/OAuth1/Digest below would then sign/hash nothing). GET-converting
      // redirects (301/302→GET, 303) null those fields, so this block harmlessly
      // falls through for them.
      if (!desc._ntlmNegotiate) {
        if (multipart) {
          let built;
          try {
            built = buildMultipartBody(multipart);
          } catch (e) {
            consoleLog.push(`* Multipart file error: ${e.message}`);
            resolve({
              status: 0,
              statusText: "",
              headers: {},
              cookies: [],
              body: "",
              elapsed: Date.now() - startTime,
              size: 0,
              consoleLog,
              error: { name: "FileError", message: e.message },
            });
            return;
          }
          if (awsIam?.accessKeyId && awsIam?.secretAccessKey) {
            // SigV4 must hash the whole body — buffer it (rare combo).
            consoleLog.push(
              "* AWS SigV4 + multipart: buffering body in memory so it can be signed",
            );
            bodyBuffer = built.toBuffer();
            if (!reqHeaders["Content-Length"])
              reqHeaders["Content-Length"] = String(bodyBuffer.length);
          } else {
            multipartStream = built.createStream();
            if (!reqHeaders["Content-Length"])
              reqHeaders["Content-Length"] = String(built.length);
          }
        } else if (bodyFilePath) {
          try {
            bodyBuffer = fs.readFileSync(bodyFilePath);
            if (!reqHeaders["Content-Length"])
              reqHeaders["Content-Length"] = String(bodyBuffer.length);
          } catch (e) {
            consoleLog.push(`* File read error: ${e.message}`);
          }
        } else if (body) {
          bodyBuffer = Buffer.from(body, "utf8");
          if (!reqHeaders["Content-Length"])
            reqHeaders["Content-Length"] = String(bodyBuffer.length);
        }
      }

      // ── AWS SigV4 signing ─────────────────────────────────────────────────
      if (awsIam?.accessKeyId && awsIam?.secretAccessKey) {
        const signOpts = {
          host: parsed.hostname + (parsed.port ? `:${parsed.port}` : ""),
          path: parsed.pathname + parsed.search,
          method: effectiveMethod,
          headers: { ...reqHeaders },
          service: awsIam.service || undefined,
          region: awsIam.region || undefined,
          // Pass the raw Buffer so the signed payload hash matches the exact
          // bytes written to the wire (req.write(bodyBuffer)). Decoding to UTF-8
          // here would corrupt binary / multipart bodies that aren't UTF-8
          // round-trippable, yielding SignatureDoesNotMatch. aws4 hashes a Buffer
          // via createHash().update(buf), so the bytes are hashed verbatim.
          body: bodyBuffer ?? undefined,
        };
        const creds = {
          accessKeyId: awsIam.accessKeyId,
          secretAccessKey: awsIam.secretAccessKey,
        };
        if (awsIam.sessionToken) creds.sessionToken = awsIam.sessionToken;
        aws4.sign(signOpts, creds);
        Object.assign(reqHeaders, signOpts.headers);
      }

      // ── OAuth 1.0a signing (RFC 5849) ─────────────────────────────────────
      // Like SigV4, OAuth 1.0a is a one-shot signature over the request line +
      // params, computed here where the final method/URL/body are known. For an
      // x-www-form-urlencoded body the body params are part of the signature
      // base string (RFC 5849 §3.4.1.3), so they are parsed back out and passed.
      if (oauth1?.consumerKey) {
        let oauthHeader;
        try {
          let bodyParams = [];
          const ctKey = Object.keys(reqHeaders).find(
            (k) => k.toLowerCase() === "content-type",
          );
          const ct = ctKey ? String(reqHeaders[ctKey]).toLowerCase() : "";
          if (
            ct.includes("application/x-www-form-urlencoded") &&
            bodyBuffer &&
            bodyBuffer.length
          ) {
            bodyParams = [
              ...new URLSearchParams(bodyBuffer.toString("utf8")).entries(),
            ];
          }
          oauthHeader = buildOAuth1Header({
            method: effectiveMethod,
            url: parsed.href,
            consumerKey: oauth1.consumerKey,
            consumerSecret: oauth1.consumerSecret || "",
            token: oauth1.token || "",
            tokenSecret: oauth1.tokenSecret || "",
            signatureMethod: oauth1.signatureMethod || "HMAC-SHA1",
            realm: oauth1.realm || undefined,
            bodyParams,
          });
        } catch (e) {
          // e.g. PLAINTEXT over http:// — refuse rather than leak the secrets.
          consoleLog.push(`* OAuth 1.0a signing error: ${e.message}`);
          resolve({
            status: 0,
            statusText: "",
            headers: {},
            cookies: [],
            body: "",
            elapsed: Date.now() - startTime,
            size: 0,
            consoleLog,
            error: { name: e.name || "Error", message: e.message },
          });
          return;
        }
        if (oauthHeader) reqHeaders["Authorization"] = oauthHeader;
      }

      // ── Outgoing request log ──────────────────────────────────────────────
      // Node's https module speaks HTTP/1.1 by default; ALPN-negotiated HTTP/2
      // would require the http2 module, which this layer does not use.
      const httpVersion = "HTTP/1.1";
      consoleLog.push(
        `> ${effectiveMethod} ${parsed.pathname}${parsed.search} ${httpVersion}`,
      );
      consoleLog.push(
        `> Host: ${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`,
      );
      Object.entries(reqHeaders).forEach(([k, v]) =>
        consoleLog.push(`> ${k}: ${redactHeader(k, v)}`),
      );
      consoleLog.push(">");

      // ── Log request body (if any) with "|" prefix ─────────────────────
      if (bodyBuffer) {
        consoleLog.push("");
        bodyBuffer
          .toString("utf8")
          .split("\n")
          .forEach((line) => consoleLog.push(`| ${line}`));
        consoleLog.push("");
        consoleLog.push("* We are completely uploaded and fine");
      } else if (multipartStream) {
        // The body is streamed (file bytes never buffer), so only summarise it.
        consoleLog.push("");
        consoleLog.push(
          `| [multipart/form-data — ${multipart.parts.length} part(s), streamed from disk]`,
        );
        consoleLog.push("");
        consoleLog.push("* We are completely uploaded and fine");
      }

      // ── Proxy agent selection ───────────────────────────────────────────────
      // Separate (encrypted) credentials are merged into the URL here, never
      // stored inline. Hosts matching the NO_PROXY-style bypass list connect
      // directly. NTLM keeps its own single-socket agent and always bypasses the
      // proxy (the handshake is target-server auth, set up above).
      let proxyAgent = null;
      if (proxy && !desc._ntlmAgent) {
        if (hostBypassesProxy(parsed.hostname, port, proxyBypass)) {
          consoleLog.push(
            `* Bypassing proxy for ${parsed.hostname} (matches no-proxy list)`,
          );
        } else {
          try {
            const effectiveProxyUrl = withProxyCredentials(
              proxy,
              proxyUsername,
              proxyPassword,
            );
            proxyAgent = makeProxyAgent(effectiveProxyUrl, isHttps);
            consoleLog.push(`* Proxying via ${describeProxy(proxy)}`);
          } catch (e) {
            consoleLog.push(`* Invalid proxy configuration: ${e.message}`);
          }
        }
      }

      // ── Make the request ───────────────────────────────────────────────────
      consoleLog.push(`* Trying to resolve host '${parsed.hostname}'...`);
      const options = {
        hostname: parsed.hostname,
        port,
        path: parsed.pathname + parsed.search,
        method: effectiveMethod,
        headers: reqHeaders,
        timeout,
        rejectUnauthorized: verifySsl,
        ...(desc._ntlmAgent
          ? { agent: desc._ntlmAgent }
          : proxyAgent
            ? { agent: proxyAgent }
            : {}),
      };

      // ── Per-host TLS material (mTLS client cert, custom CA, verify override) ─
      // Resolved once per request (desc._tls) and applied by host on every leg,
      // so redirects to another host re-match and OAuth token fetches (which run
      // through this same path) are covered automatically.
      if (isHttps && desc._tls) {
        applyTlsOptions(options, parsed.hostname, port, desc._tls, consoleLog);
      }

      // Per-leg timing marks (absolute ms). The socket handler and the response
      // path below populate the rest; computeTiming turns them into the phase
      // waterfall surfaced on the result. Each recursive leg (redirect / auth)
      // gets its own marks, so the resolved result carries the FINAL leg's
      // breakdown — the connection that produced the response the user sees.
      const t = { start: Date.now() };

      // Validate headers exactly as Node will, before lib.request() does. A bad
      // header (invalid char in a value, malformed name, missing value) makes
      // http.request() throw a SYNCHRONOUS TypeError that the async
      // req.on("error") handler below cannot catch — it would reject this
      // Promise and surface a raw "TypeError [ERR_INVALID_CHAR]" to the user.
      // Fail gracefully instead with the standard status:0 result, naming the
      // offending header and character.
      const badHeader = findInvalidHeader(reqHeaders);
      if (badHeader) {
        consoleLog.push(`* ${badHeader.message}`);
        resolve({
          status: 0,
          statusText: "",
          headers: {},
          cookies: [],
          body: "",
          elapsed: Date.now() - startTime,
          size: 0,
          consoleLog,
          error: {
            name: badHeader.code,
            code: badHeader.code,
            message: badHeader.message,
          },
        });
        return;
      }

      const req = lib.request(options, (res) => {
        // First response byte (headers received) — the TTFB marker.
        t.response = Date.now();
        const code = res.statusCode;
        const phrase = res.statusMessage;

        // ── Redirect handling ────────────────────────────────────────────────
        if (followRedirects && [301, 302, 303, 307, 308].includes(code)) {
          // Capture the redirect's own Set-Cookie (login flows set their session
          // cookie on the 302 before bouncing to the authenticated page).
          captureCookies(useCookieJar, collectionId, rawUrl, res.headers);
          const location = res.headers["location"];
          consoleLog.push(`< ${httpVersion} ${code} ${phrase}`);
          Object.entries(res.headers).forEach(([k, v]) => {
            const vals = Array.isArray(v) ? v : [v];
            vals.forEach((vi) =>
              consoleLog.push(`< ${k}: ${redactHeader(k, vi)}`),
            );
          });
          consoleLog.push("<");
          consoleLog.push("");

          if (!location) {
            consoleLog.push("* Redirect missing Location header — stopping");
            res.resume();
            resolve({
              status: code,
              statusText: phrase,
              headers: flatHeaders(res.headers),
              cookies: extractCookies(res.headers),
              body: "",
              elapsed: Date.now() - startTime,
              size: 0,
              consoleLog,
            });
            return;
          }
          if (redirects >= maxRedirects) {
            consoleLog.push(`* Too many redirects (max ${maxRedirects})`);
            res.resume();
            resolve({
              status: code,
              statusText: phrase,
              headers: flatHeaders(res.headers),
              cookies: extractCookies(res.headers),
              body: "",
              elapsed: Date.now() - startTime,
              size: 0,
              consoleLog,
              error: {
                name: "RedirectError",
                message: `Too many redirects (max ${maxRedirects})`,
              },
            });
            return;
          }

          let redirectUrl;
          try {
            redirectUrl = new URL(location, rawUrl).toString();
          } catch {
            redirectUrl = location;
          }

          // HTTP 303 → always GET; POST 301/302 → GET (browser convention)
          const newMethod =
            code === 303 ||
            ([301, 302].includes(code) && effectiveMethod === "POST")
              ? "GET"
              : effectiveMethod;

          consoleLog.push(
            `* Issue another request to this URL: '${redirectUrl}'`,
          );
          if (newMethod !== effectiveMethod) {
            consoleLog.push(`* Switch to ${newMethod}`);
          }
          res.resume(); // drain the redirect body

          let crossOrigin = false;
          try {
            crossOrigin = new URL(redirectUrl).origin !== parsed.origin;
          } catch {
            // Unparseable redirect URL — treat as same-origin; the next leg's own
            // URL parse will surface the error.
          }

          // Cross-origin redirect: drop credential-bearing request headers so a
          // redirect to another host can't replay the user's Authorization /
          // Cookie (mirrors browsers / curl). The cookie jar is re-applied per
          // host on the next leg, so only a user-set header is at risk here.
          let redirectHeaders = headers;
          if (crossOrigin) {
            redirectHeaders = Object.fromEntries(
              Object.entries(headers).filter(
                ([k]) => !CREDENTIAL_HEADERS.has(k.toLowerCase()),
              ),
            );
            consoleLog.push(
              "* Crossing origins — dropping Authorization/Cookie for the redirect",
            );
          }

          // A 307/308 preserves the method AND body. On a cross-origin redirect
          // we drop that body too — mirroring the credential-header stripping —
          // so a hostile redirect can't replay a sensitive POST/PUT body to an
          // attacker-controlled host. (GET redirects never carry a body.)
          const keepBody = newMethod !== "GET" && !crossOrigin;
          if (newMethod !== "GET" && crossOrigin) {
            consoleLog.push(
              "* Crossing origins — dropping the request body for the redirect",
            );
          }

          doRequest(
            {
              ...desc,
              headers: redirectHeaders,
              method: newMethod,
              url: redirectUrl,
              body: keepBody ? body : null,
              bodyFilePath: keepBody ? bodyFilePath : null,
              multipart: keepBody ? multipart : null,
            },
            consoleLog,
            startTime,
            redirects + 1,
          ).then(resolve);
          return;
        }

        // ── Digest auth challenge (RFC 2617 / RFC 7616) ──────────────────────
        // Digest is not connection-bound — the nonce travels in this 401's
        // WWW-Authenticate header — so we answer it as a one-shot retry that
        // recomputes the Authorization header and re-sends. The _digestRetried
        // guard stops a loop when the credentials themselves are wrong (the
        // second 401 falls through to be surfaced normally). The challenge is
        // read from res.rawHeaders so a value containing commas survives intact.
        if (code === 401 && authDigest?.username && !desc._digestRetried) {
          const challenge = parseChallenge(
            selectDigestChallenge(
              rawHeaderValues(res.rawHeaders, "www-authenticate"),
            ),
          );
          const digestHeader = challenge
            ? buildDigestAuthorization({
                method: effectiveMethod,
                uri: parsed.pathname + parsed.search,
                username: authDigest.username,
                password: authDigest.password || "",
                challenge,
                entityBody: bodyBuffer,
              })
            : null;
          if (digestHeader) {
            consoleLog.push(`< ${httpVersion} ${code} ${phrase}`);
            Object.entries(res.headers).forEach(([k, v]) => {
              const vals = Array.isArray(v) ? v : [v];
              vals.forEach((vi) =>
                consoleLog.push(`< ${k}: ${redactHeader(k, vi)}`),
              );
            });
            consoleLog.push("<");
            consoleLog.push("");
            consoleLog.push(
              "* Server requested Digest auth — re-sending with credentials",
            );
            // Some servers pin the nonce to a session cookie set on the 401.
            captureCookies(useCookieJar, collectionId, rawUrl, res.headers);
            res.resume(); // drain the challenge body

            // Rebuild from the ORIGINAL desc headers (not reqHeaders) so the
            // recursion re-merges the cookie jar once; replace any stale
            // Authorization with the freshly computed Digest credential.
            const retryHeaders = { ...headers };
            for (const k of Object.keys(retryHeaders)) {
              if (k.toLowerCase() === "authorization") delete retryHeaders[k];
            }
            retryHeaders.Authorization = digestHeader;

            doRequest(
              { ...desc, headers: retryHeaders, _digestRetried: true },
              consoleLog,
              startTime,
              redirects,
            ).then(resolve);
            return;
          }
          // Unsatisfiable challenge (no Digest offer, missing realm/nonce, or an
          // algorithm we don't implement): fall through and surface the 401.
        }

        // ── NTLM challenge → response (MS-NLMP) ──────────────────────────────
        // The negotiate (Type 1) leg always earns a 401 carrying the Type 2
        // challenge in WWW-Authenticate. We read it from rawHeaders (a blob
        // contains '=' padding), compute Type 3, and re-send on the SAME pinned
        // socket (_ntlmAgent) — this leg carries the real request body. The
        // _ntlmAuthorized flag stops a loop: a second 401 (bad credentials)
        // falls through and is surfaced normally. If the server omits a Type 2
        // blob we also fall through and surface the 401.
        if (code === 401 && desc._ntlmNegotiate && authNtlm?.username) {
          const type2b64 = selectNtlmChallenge(
            rawHeaderValues(res.rawHeaders, "www-authenticate"),
          );
          const type2 = type2b64 ? decodeType2Message(type2b64) : null;
          if (type2) {
            consoleLog.push(`< ${httpVersion} ${code} ${phrase}`);
            Object.entries(res.headers).forEach(([k, v]) => {
              const vals = Array.isArray(v) ? v : [v];
              vals.forEach((vi) =>
                consoleLog.push(`< ${k}: ${redactHeader(k, vi)}`),
              );
            });
            consoleLog.push("<");
            consoleLog.push("");
            consoleLog.push(
              "* Server sent NTLM challenge — answering on the same connection",
            );
            captureCookies(useCookieJar, collectionId, rawUrl, res.headers);
            res.resume(); // drain the challenge body; keep the socket alive

            const type3 = createType3Message({
              type2,
              username: authNtlm.username,
              password: authNtlm.password || "",
              domain: authNtlm.domain || "",
              workstation: authNtlm.workstation || "",
            });

            // Rebuild from the ORIGINAL headers so the cookie jar re-merges
            // once and the negotiate leg's Content-Length:0 is dropped; the
            // body (suppressed on the negotiate leg) is sent on this leg.
            const authHeaders = { ...headers };
            for (const k of Object.keys(authHeaders)) {
              if (k.toLowerCase() === "authorization") delete authHeaders[k];
            }
            authHeaders.Authorization = type3;

            doRequest(
              {
                ...desc,
                headers: authHeaders,
                _ntlmNegotiate: false,
                _ntlmAuthorized: true,
              },
              consoleLog,
              startTime,
              redirects,
            ).then(resolve);
            return;
          }
          // No usable Type 2 challenge — fall through and surface the 401.
        }

        // ── Streaming response (Feature 33) ──────────────────────────────────
        // When the caller opted in (interactive send) and this final 2xx is a
        // text/event-stream — or an application/x-ndjson and the global
        // streamNdjson setting is on — forward the body live over the
        // http:stream:* push channels instead of buffering it. Non-2xx responses
        // always buffer so error pages and the retry layer are unaffected.
        const streamCtx = desc._stream;
        const streamContentType = res.headers["content-type"] || "";
        if (
          streamCtx &&
          code >= 200 &&
          code < 300 &&
          (isEventStream(streamContentType) ||
            (streamCtx.streamNdjson && isNdjson(streamContentType)))
        ) {
          const { id: streamId, sender } = streamCtx;
          const sse = isEventStream(streamContentType);
          const decoder = new StringDecoder("utf8");
          const parser = sse ? new SseParser() : new LineBuffer();

          // Disable the idle socket timeout — a long-lived or sparsely-emitting
          // stream (SSE keep-alives, an idle LLM) must not be killed mid-stream.
          // The user's Stop (req.destroy) and renderer teardown end it instead.
          req.setTimeout(0);

          consoleLog.push(`< ${httpVersion} ${code} ${phrase}`);
          Object.entries(res.headers).forEach(([k, v]) => {
            const vals = Array.isArray(v) ? v : [v];
            vals.forEach((vi) =>
              consoleLog.push(`< ${k}: ${redactHeader(k, vi)}`),
            );
          });
          consoleLog.push("<");
          consoleLog.push("");
          consoleLog.push(
            sse
              ? "* text/event-stream — forwarding Server-Sent Events live"
              : "* Streaming response body live (chunked)",
          );

          // Login flows can set a session cookie on the streaming response too.
          captureCookies(useCookieJar, collectionId, rawUrl, res.headers);

          // Mirror the raw bytes to a temp file so the full stream can be saved
          // on demand, even while it is still running (http:stream:save) or after
          // it ends (the bodyRef redeemed via http:body:save).
          let spillStream = null;
          let spillPath = null;
          let spillError = null;
          try {
            const cacheDir = getStores().paths().responseCacheDir();
            io.ensureDir(cacheDir);
            spillPath = io.newTempPath(cacheDir, "stream");
            spillStream = fs.createWriteStream(spillPath);
            spillStream.on("error", (err) => {
              spillError = err;
            });
          } catch (err) {
            spillError = err;
          }

          const entry = {
            req,
            senderId: sender.id,
            spillPath,
            spillStream,
            bytes: 0,
            events: 0,
            recent: [], // last STREAM_RECORD_EVENTS items, for the Timeline record
            ended: false,
            aborted: false,
            contentType: streamContentType,
          };
          activeStreams.set(streamId, entry);

          // Cap a stored event's data so the (persisted) Timeline record can't be
          // bloated by one huge frame; the full stream still lives in the spill.
          const capData = (s) => {
            const str = String(s ?? "");
            return str.length > STREAM_RECORD_EVENT_MAX
              ? str.slice(0, STREAM_RECORD_EVENT_MAX)
              : str;
          };

          // Bound what crosses IPC live to the renderer. The parser already caps
          // its own buffers, so this is a final defensive cap (and the only one
          // that bounds an NDJSON line, which the parser may surface up to one
          // socket-chunk over the limit). An SSE event already carries its own
          // `truncated` flag from the parser; {...item} forwards it for free.
          const capStreamItem = (s) => {
            const str = String(s ?? "");
            return str.length > MAX_STREAM_ITEM_BYTES
              ? str.slice(0, MAX_STREAM_ITEM_BYTES)
              : str;
          };

          let index = 0;
          const emitItem = (item) => {
            entry.events += 1;
            const ts = Date.now();
            sendTo(sender, "http:stream:data", {
              streamId,
              kind: sse ? "event" : "line",
              index: index++,
              ts,
              ...(sse
                ? { event: { ...item, data: capStreamItem(item.data) } }
                : { data: capStreamItem(item) }),
              totalBytes: entry.bytes,
              count: entry.events,
            });
            // Retain the last few events (data capped) for the Timeline record.
            entry.recent.push(
              sse
                ? {
                    kind: "event",
                    ts,
                    event: {
                      event: item.event,
                      data: capData(item.data),
                      id: item.id,
                    },
                  }
                : { kind: "line", ts, data: capData(item) },
            );
            if (entry.recent.length > STREAM_RECORD_EVENTS)
              entry.recent.shift();
          };
          const pump = (text) => {
            for (const item of parser.feed(text)) emitItem(item);
          };

          res.on("data", (chunk) => {
            entry.bytes += chunk.length;
            if (spillStream && !spillError) {
              // Pause the socket when the write buffer fills, resume on drain —
              // keeps disk-spill memory bounded for a fast producer.
              if (!spillStream.write(chunk)) {
                res.pause();
                spillStream.once("drain", () => res.resume());
              }
            }
            const text = decoder.write(chunk);
            if (text) pump(text);
          });

          const finalize = ({ aborted = false, error = null } = {}) => {
            if (entry.ended) return;
            entry.ended = true;
            // On a clean end, flush any buffered tail bytes / partial final line.
            if (!aborted && !error) {
              try {
                const tail = decoder.end();
                if (tail) pump(tail);
                for (const item of parser.flush()) emitItem(item);
              } catch {
                // best-effort — a decode/parse error at EOF is non-fatal
              }
            }
            const done = () => {
              let bodyRef = null;
              if (!spillError && entry.bytes > 0 && spillPath) {
                bodyRef = registerSpilledBody({
                  path: spillPath,
                  size: entry.bytes,
                  contentType: streamContentType,
                  isBinary: false,
                });
              } else if (spillPath) {
                io.remove(spillPath);
              }
              activeStreams.delete(streamId);
              const base = {
                streamId,
                ts: Date.now(),
                totalBytes: entry.bytes,
                eventCount: entry.events,
                elapsed: Date.now() - startTime,
                status: code,
                bodyRef,
                // Last few events, for the renderer's Timeline record (Feature 33).
                lastEvents: entry.recent,
              };
              if (error && !aborted) {
                sendTo(sender, "http:stream:error", {
                  ...base,
                  name: error.name || "StreamError",
                  message: error.message || String(error),
                });
              } else {
                sendTo(sender, "http:stream:end", { ...base, aborted });
              }
            };
            if (spillStream) spillStream.end(done);
            else done();
          };

          res.on("end", () => finalize({}));
          res.on("error", (err) =>
            finalize({ aborted: entry.aborted, error: err }),
          );
          // Safety net: an abort (req.destroy) or socket teardown closes the
          // response without an "end"; finalize is idempotent so a "close" after
          // a normal "end" is a no-op.
          res.on("close", () => finalize({ aborted: true }));

          // Resolve the http:execute promise NOW with a streaming marker so the
          // renderer switches to live mode; the body keeps flowing over the push
          // channels above.
          resolve({
            status: code,
            statusText: phrase,
            headers: flatHeaders(res.headers),
            cookies: extractCookies(res.headers),
            body: "",
            elapsed: Date.now() - startTime,
            size: 0,
            consoleLog,
            encoding: "utf8",
            streaming: true,
            streamId,
            sse,
            contentType: streamContentType,
          });
          return;
        }

        // ── Buffered-NDJSON hint (Feature 33) ────────────────────────────────
        // We chose not to stream (the global streamNdjson setting is off) but the
        // body is application/x-ndjson, so it buffers — a never-ending feed would
        // just spin. Signal the renderer now, at headers-time, so it can show a
        // "streaming is off" hint while the request runs; that hint is dropped the
        // moment the buffered response (or an error) lands.
        if (
          streamCtx &&
          !streamCtx.streamNdjson &&
          isNdjson(streamContentType)
        ) {
          sendTo(streamCtx.sender, "http:stream:hint", {
            streamId: streamCtx.id,
          });
        }

        // ── Normal response ──────────────────────────────────────────────────
        // Buffer in memory until the body crosses RESPONSE_SPILL_THRESHOLD; from
        // there it streams to a temp file so a multi-hundred-MB payload never
        // lands whole in renderer memory.
        const previewChunks = []; // bounded to RESPONSE_PREVIEW_BYTES
        let previewLen = 0;
        let memChunks = []; // full body, until/unless we spill
        let total = 0;
        let spillStream = null; // fs.WriteStream once the threshold is crossed
        let spillPath = null;
        let spillError = null;

        // Reverse any Content-Encoding so everything below (preview, spill,
        // looksBinary, the UTF-8/base64 decode) operates on the real payload
        // rather than compressed bytes. The original Content-Encoding/-Length
        // headers are left intact so the viewer still shows what the server sent.
        const contentEncoding = String(res.headers["content-encoding"] || "")
          .trim()
          .toLowerCase();
        const decompressor = createDecompressor(contentEncoding);
        const bodyStream = decompressor || res;
        if (decompressor) {
          consoleLog.push(`* Decompressing ${contentEncoding} response body`);
          // .pipe() does not forward errors, so bind the two streams for mutual
          // teardown: a socket error destroys the decompressor, and a decode
          // error (corrupt body) destroys the socket. Without the second leg the
          // loser of that race can emit an unhandled 'error' on a later tick and
          // crash the process. The failure is surfaced once, via bodyStream's
          // "error" handler below; res.destroy() with no arg closes it cleanly.
          res.on("error", (err) => decompressor.destroy(err));
          decompressor.on("error", () => res.destroy());
          res.pipe(decompressor);
        }

        const appendPreview = (chunk) => {
          if (previewLen >= RESPONSE_PREVIEW_BYTES) return;
          const remaining = RESPONSE_PREVIEW_BYTES - previewLen;
          const slice =
            chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
          previewChunks.push(slice);
          previewLen += slice.length;
        };

        bodyStream.on("data", (chunk) => {
          total += chunk.length;
          appendPreview(chunk);

          if (spillStream) {
            // Pause the source when the write buffer fills, resume on drain —
            // keeps memory bounded regardless of how fast the peer sends.
            if (!spillStream.write(chunk)) {
              bodyStream.pause();
              spillStream.once("drain", () => bodyStream.resume());
            }
            return;
          }

          memChunks.push(chunk);
          if (total > RESPONSE_SPILL_THRESHOLD) {
            try {
              const cacheDir = getStores().paths().responseCacheDir();
              io.ensureDir(cacheDir);
              spillPath = io.newTempPath(cacheDir, "response");
              spillStream = fs.createWriteStream(spillPath);
              spillStream.on("error", (err) => {
                spillError = err;
              });
              for (const c of memChunks) spillStream.write(c);
            } catch (err) {
              spillError = err;
            }
            memChunks = []; // release the buffered body
          }
        });

        bodyStream.on("end", () => {
          t.end = Date.now();
          const elapsed = Date.now() - startTime;

          consoleLog.push(`< ${httpVersion} ${code} ${phrase}`);
          Object.entries(res.headers).forEach(([k, v]) => {
            const vals = Array.isArray(v) ? v : [v];
            vals.forEach((vi) =>
              consoleLog.push(`< ${k}: ${redactHeader(k, vi)}`),
            );
          });
          consoleLog.push("<");
          consoleLog.push("");
          consoleLog.push(`* Received ${total} B total`);
          consoleLog.push(
            `* Connection to host ${parsed.hostname} left intact`,
          );

          // Per-phase timing waterfall (DNS/TCP/TLS/TTFB/download) appended to
          // the verbose Console log; absent phases (plain HTTP, reused sockets)
          // are skipped. Persisted with consoleLog, so it replays from history.
          for (const line of formatTiming(computeTiming(t, { isHttps }))) {
            consoleLog.push(line);
          }

          captureCookies(useCookieJar, collectionId, rawUrl, res.headers);

          const base = {
            status: code,
            statusText: phrase,
            headers: flatHeaders(res.headers),
            cookies: extractCookies(res.headers),
            elapsed,
            consoleLog,
          };

          const respContentType = res.headers["content-type"] || "";

          if (!spillStream) {
            // Small response — fully in memory. Text is decoded per the
            // Content-Type charset, then crosses IPC as a (UTF-8) string; binary
            // is carried as base64 so non-text bytes survive intact.
            const rawBody = Buffer.concat(memChunks);
            const binary =
              isBinaryContentType(respContentType) ||
              (!respContentType && looksBinary(rawBody));
            resolve({
              ...base,
              body: binary
                ? rawBody.toString("base64")
                : decodeText(rawBody, respContentType),
              encoding: binary ? "base64" : "utf8",
              size: total,
            });
            return;
          }

          // Spilled response — finish the temp file, then hand back a preview
          // plus a ref the renderer can redeem for the full body on demand. The
          // temp file holds the raw bytes; for binary, the preview is base64 so
          // the renderer's hex/image view receives intact bytes.
          const previewBuf = Buffer.concat(previewChunks);
          const binary =
            isBinaryContentType(respContentType) ||
            (!respContentType && looksBinary(previewBuf));
          const previewBody = binary
            ? previewBuf.toString("base64")
            : decodeText(previewBuf, respContentType);
          const previewEncoding = binary ? "base64" : "utf8";
          spillStream.end(() => {
            if (spillError) {
              io.remove(spillPath);
              consoleLog.push(
                `* Failed to buffer full response to disk: ${spillError.message}`,
              );
              resolve({
                ...base,
                body: previewBody,
                encoding: previewEncoding,
                size: total,
                truncated: true,
                fullSize: total,
                error: { name: "SpillError", message: spillError.message },
              });
              return;
            }
            const bodyRef = registerSpilledBody({
              path: spillPath,
              size: total,
              contentType: respContentType,
              isBinary: binary,
            });
            consoleLog.push(
              `* Response exceeded ${RESPONSE_SPILL_THRESHOLD} B — buffered to disk; previewing first ${previewLen} B`,
            );
            resolve({
              ...base,
              body: previewBody,
              encoding: previewEncoding,
              size: total,
              truncated: true,
              bodyRef,
              fullSize: total,
            });
          });
        });

        // Errors from the source socket OR the decompressor (e.g. a corrupt gzip
        // body) land here; when decompressing, res errors are forwarded above via
        // decompressor.destroy() so this single handler covers both.
        bodyStream.on("error", (err) => {
          const elapsed = Date.now() - startTime;
          consoleLog.push(`* Stream error: ${err.message}`);
          if (spillStream) {
            try {
              spillStream.destroy();
            } catch {
              // best-effort
            }
            io.remove(spillPath);
          }
          resolve({
            status: code,
            statusText: phrase,
            headers: {},
            cookies: [],
            body: "",
            elapsed,
            size: 0,
            consoleLog,
            error: { name: "StreamError", message: err.message },
          });
        });
      });

      req.on("socket", (socket) => {
        t.socket = Date.now();
        // ── DNS resolution ──────────────────────────────────────────────────
        socket.on("lookup", (err, address, _family, hostname) => {
          t.lookup = Date.now();
          if (err) {
            consoleLog.push(
              `* Could not resolve host '${hostname}': ${err.message}`,
            );
          } else {
            consoleLog.push(`* Resolved '${hostname}' → ${address}`);
            consoleLog.push(`* Trying ${address}:${port}...`);
          }
        });

        // ── TCP connection established ───────────────────────────────────────
        socket.on("connect", () => {
          t.connect = Date.now();
          const remoteAddr = socket.remoteAddress;
          const remotePort = socket.remotePort;
          consoleLog.push(
            `* Connected to ${parsed.hostname} (${remoteAddr}) port ${remotePort}`,
          );
          if (isHttps) {
            consoleLog.push(
              `* Performing TLS handshake with '${parsed.hostname}'...`,
            );
          }
        });

        // ── TLS handshake complete (HTTPS only) ─────────────────────────────
        if (isHttps) {
          socket.on("secureConnect", () => {
            t.secure = Date.now();
            const protocol = socket.getProtocol();
            const cipher = socket.getCipher();
            consoleLog.push(
              `* SSL connection using ${protocol} / ${cipher.standardName || cipher.name}`,
            );
            const alpn = socket.alpnProtocol;
            if (alpn && alpn !== false) {
              consoleLog.push(`* ALPN: server accepted '${alpn}'`);
            }
          });
        }
      });

      req.on("timeout", () => {
        consoleLog.push(`* Timed out after ${timeout}ms`);
        // Tag with a code so the retry layer can tell a timeout apart from a
        // plain connection error (result.error.code carries err.code; .name is
        // kept as the renderer-facing label).
        req.destroy(
          Object.assign(new Error(`Request timed out after ${timeout}ms`), {
            code: "ETIMEDOUT",
          }),
        );
      });

      req.on("error", (err) => {
        const elapsed = Date.now() - startTime;
        consoleLog.push(`* ${err.message}`);
        resolve({
          status: 0,
          statusText: "",
          headers: {},
          cookies: [],
          body: "",
          elapsed,
          size: 0,
          consoleLog,
          error: {
            // `.name` is the renderer-facing label; `.code` is the canonical
            // discriminator the retry layer classifies on (see net/retry.js).
            name: err.code || err.name || "NetworkError",
            code: err.code || err.name || "NetworkError",
            message: err.message,
          },
        });
      });

      // Expose this leg's ClientRequest for Stop (http:abort). The handle is
      // threaded on the descriptor by the http:execute handler and shared across
      // every recursive leg (redirect / digest-NTLM challenge / retry), so each
      // leg overwrites `req` and abort always destroys the socket that is open.
      // If Stop already arrived in the gap between legs — after the previous
      // leg's req settled but before this one's socket existed — tear this one
      // down at once; req's "error" handler resolves the promise.
      if (desc._handle) {
        desc._handle.req = req;
        if (desc._handle.aborted) {
          req.destroy(
            Object.assign(new Error("Request aborted"), { code: "ABORTED" }),
          );
        }
      }

      if (multipartStream) {
        // pipe() ends the request when the stream finishes; a read error on a
        // file part aborts the request, surfacing through req's "error" handler.
        multipartStream.on("error", (e) => {
          consoleLog.push(`* Multipart stream error: ${e.message}`);
          req.destroy(e);
        });
        multipartStream.pipe(req);
      } else {
        if (bodyBuffer) req.write(bodyBuffer);
        req.end();
      }
    });
  }

  /** Promise-based delay used between retry attempts. */
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Run a request under the configured retry policy. doRequest already follows
   * one whole redirect/auth chain per call, so a retry re-runs that entire chain
   * from scratch. Retries fire on connection errors, timeouts, and opted-in
   * status codes with exponential backoff; every attempt and wait is surfaced in
   * the Console. With no policy this is a single attempt, identical to before.
   *
   * @param {object}   descriptor
   * @param {string[]} consoleLog
   * @param {number}   startTime
   */
  async function executeWithRetries(descriptor, consoleLog, startTime) {
    const policy = normalizeRetry(descriptor.retry);
    const maxAttempts = policy ? policy.maxAttempts : 1;

    let attempt = 0;
    let result;
    while (attempt < maxAttempts) {
      attempt++;
      if (attempt > 1) {
        consoleLog.push(`* Attempt ${attempt} of ${maxAttempts}`);
      }
      try {
        result = await doRequest(descriptor, consoleLog, startTime, 0);
      } catch (e) {
        // Version-proof safety net: doRequest's Promise executor rejects if a
        // synchronous throw escapes (e.g. http.request() rejecting a header on
        // some future Node that findInvalidHeader didn't anticipate). Convert
        // it to the standard status:0 error result so the renderer never sees a
        // raw TypeError.
        consoleLog.push(`* ${e.message}`);
        result = {
          status: 0,
          statusText: "",
          headers: {},
          cookies: [],
          body: "",
          elapsed: Date.now() - startTime,
          size: 0,
          consoleLog,
          error: {
            name: e.code || e.name || "RequestError",
            code: e.code || e.name || "RequestError",
            message: e.message,
          },
        };
      }

      // A user Stop (http:abort) destroyed the socket — that surfaces as a
      // connection error, which the retry policy would otherwise treat as
      // retryable. Stop means stop: don't start another attempt.
      if (descriptor._handle?.aborted) break;
      if (!policy || attempt >= maxAttempts) break;
      const reason = retryReason(result, policy, descriptor.method);
      if (!reason) {
        // If a retry was suppressed purely by the idempotency gate, say so —
        // otherwise a user who enabled network-error retries is left wondering
        // why their POST wasn't retried.
        if (
          result.status === 0 &&
          result.error &&
          !policy.retryNonIdempotent &&
          !isIdempotentMethod(descriptor.method) &&
          (policy.onConnectionError || policy.onTimeout)
        ) {
          consoleLog.push(
            `* Not retrying ${descriptor.method} after a network error — the ` +
              `method is not idempotent (enable "Retry POST/PATCH on network ` +
              `errors" to override)`,
          );
        }
        break;
      }

      const delay = retryDelay(policy, attempt, result, Date.now());
      consoleLog.push(
        `* Request failed (${reason}); retrying in ${delay}ms ` +
          `(attempt ${attempt + 1}/${maxAttempts})`,
      );
      await sleep(delay);
    }

    if (attempt > 1) {
      consoleLog.push(`* Finished after ${attempt} attempt(s)`);
      result.attempts = attempt;
    }
    return result;
  }

  /** Flatten Node's multi-value header object into a plain key→string map. */
  function flatHeaders(hdrs) {
    const out = {};
    Object.entries(hdrs).forEach(([k, v]) => {
      out[k] = Array.isArray(v) ? v.join(", ") : v;
    });
    return out;
  }

  /**
   * Collect every value for header `name` (case-insensitive) from Node's
   * `res.rawHeaders` flat [name, value, name, value, …] array. Unlike the
   * joined `res.headers` map, this keeps duplicate WWW-Authenticate challenges
   * separate, so a Digest challenge that itself contains commas is not
   * corrupted by header folding.
   *
   * @param {string[]} rawHeaders  res.rawHeaders
   * @param {string} name          header name to match
   * @returns {string[]}
   */
  function rawHeaderValues(rawHeaders, name) {
    const out = [];
    if (!Array.isArray(rawHeaders)) return out;
    const target = name.toLowerCase();
    for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
      if (String(rawHeaders[i]).toLowerCase() === target) {
        out.push(rawHeaders[i + 1]);
      }
    }
    return out;
  }

  /** Extract Set-Cookie header values as a string array. */
  function extractCookies(hdrs) {
    const sc = hdrs["set-cookie"];
    return Array.isArray(sc) ? sc : sc ? [sc] : [];
  }

  /**
   * Persist any Set-Cookie headers from a response into the collection's jar.
   * No-op when the jar is bypassed, no collection is in scope, or there are no
   * cookies. Called for both terminal and intermediate (redirect) responses so
   * login→redirect flows capture their session cookie. Storage lives entirely
   * in the main process; cross-domain cookies are rejected by cookie-jar.js.
   *
   * @param {boolean} useCookieJar   per-request jar toggle
   * @param {string|null} collectionId
   * @param {string} url             the URL this response came from
   * @param {object} resHeaders      Node response headers
   */
  function captureCookies(useCookieJar, collectionId, url, resHeaders) {
    if (!useCookieJar || !collectionId) return;
    const lines = extractCookies(resHeaders);
    if (lines.length === 0) return;
    safeCall("cookie capture", () => {
      getStores().cookieStore().captureSetCookies(collectionId, url, lines);
    });
  }

  // ── IPC handler ─────────────────────────────────────────────────────────────
  ipcMain.handle("http:execute", async (event, descriptor) => {
    const consoleLog = [];
    const startTime = Date.now();
    const _timeout = descriptor.timeout || 30000;
    consoleLog.push(`* Preparing request to ${descriptor.url}`);
    consoleLog.push(`* Current time is ${new Date().toISOString()}`);
    consoleLog.push(`* Enable automatic URL encoding`);
    consoleLog.push(`* Using default HTTP version`);
    consoleLog.push(`* Enable timeout of ${_timeout}ms`);
    consoleLog.push(
      descriptor.verifySsl === false
        ? `* Disable SSL validation`
        : `* Enable SSL validation`,
    );
    console.log("[http:execute] →", descriptor.method, descriptor.url);
    // Resolve per-host TLS material once (mTLS client certs, custom CA, verify
    // overrides). Threaded onto the descriptor so every redirect/auth leg reuses
    // it; null when nothing is configured, leaving default behaviour unchanged.
    descriptor._tls = loadTlsConfig(consoleLog);
    // Streaming context (Feature 33): only interactive sends set streamCapable,
    // so folder runs and dependency prefetches never switch to live streaming.
    // text/event-stream always auto-streams; application/x-ndjson streams only
    // when streamNdjson (the global "Stream NDJSON responses live" setting) is on.
    if (descriptor.streamCapable === true) {
      descriptor._stream = {
        id: descriptor.streamId || io.newUUID(),
        streamNdjson: descriptor.streamNdjson === true,
        sender: event.sender,
      };
    }
    // Track interactive sends so the Stop button (http:abort) can destroy the
    // in-flight socket. Keyed by the renderer's per-send id (its streamId). A
    // send that becomes a live stream switches to activeStreams control; the
    // `finally` below drops this handle the moment http:execute resolves (which,
    // for a stream, is at the streaming marker — so abort then routes through
    // http:stream:abort, not here).
    const execId =
      descriptor.streamCapable === true ? descriptor.streamId || null : null;
    if (execId) {
      descriptor._handle = {
        req: null,
        senderId: event.sender.id,
        aborted: false,
      };
      activeRequests.set(execId, descriptor._handle);
    }
    try {
      const result = await executeWithRetries(
        descriptor,
        consoleLog,
        startTime,
      );
      console.log(
        "[http:execute] ←",
        result.status,
        result.statusText,
        `${result.elapsed}ms`,
      );
      return result;
    } catch (err) {
      console.error("[http:execute] unexpected error:", err);
      consoleLog.push(`* Unexpected error: ${err.message}`);
      return {
        status: 0,
        statusText: "",
        headers: {},
        cookies: [],
        body: "",
        elapsed: Date.now() - startTime,
        size: 0,
        consoleLog,
        error: { name: err.name || "Error", message: err.message },
      };
    } finally {
      // Stop tracking once the request settles (or, for a stream, once it hands
      // off to activeStreams at the streaming marker). Abort after this point is
      // a harmless no-op (buffered: nothing to stop; stream: http:stream:abort).
      if (execId) activeRequests.delete(execId);
    }
  });

  // Redeem a spill ref for the full response body (user-initiated "View full").
  ipcMain.handle("http:body:get", async (_event, ref) => {
    const entry = spilledBodies.get(ref);
    if (!entry) {
      return {
        error: {
          name: "NotFound",
          message: "The full response is no longer cached.",
        },
      };
    }
    try {
      const buf = await fs.promises.readFile(entry.path);
      return {
        body: entry.isBinary
          ? buf.toString("base64")
          : decodeText(buf, entry.contentType),
        encoding: entry.isBinary ? "base64" : "utf8",
        size: entry.size,
        contentType: entry.contentType,
      };
    } catch (err) {
      return { error: { name: "ReadError", message: err.message } };
    }
  });

  // Copy a spilled response body straight to a user-chosen file — the full
  // payload never travels back through the renderer.
  ipcMain.handle("http:body:save", async (_event, { ref, filename } = {}) => {
    const entry = spilledBodies.get(ref);
    if (!entry) return { ok: false, reason: "not-found" };
    const result = await dialog.showSaveDialog(getMainWin() ?? undefined, {
      defaultPath: filename || "response.bin",
    });
    if (result.canceled || !result.filePath) {
      return { ok: false, reason: "canceled" };
    }
    try {
      await fs.promises.copyFile(entry.path, result.filePath);
      return { ok: true, path: result.filePath };
    } catch (err) {
      return { ok: false, reason: "error", message: err.message };
    }
  });

  // Abort an in-flight buffered (non-streaming) request — the interactive Stop
  // button. The renderer settles its own UI synchronously and discards the late
  // result; this destroys the actual socket so the download (and any spill to
  // disk) stop server-side instead of running to completion. Keyed by the same
  // id the renderer minted for the send (its streamId). Idempotent and safe when
  // the request already finished (entry gone), became a live stream (handed off
  // to http:stream:abort), or hasn't opened its socket yet (req null — the
  // aborted flag makes the next leg tear down the moment it connects).
  ipcMain.handle("http:abort", (_event, { streamId } = {}) => {
    const entry = activeRequests.get(streamId);
    if (!entry) return { ok: false, reason: "not-found" };
    entry.aborted = true;
    try {
      entry.req?.destroy(
        Object.assign(new Error("Request aborted"), { code: "ABORTED" }),
      );
    } catch {
      // already torn down — the leg's error/close handler resolves the promise
    }
    return { ok: true };
  });

  // ── Live-stream control (Feature 33) ───────────────────────────────────────

  // Stop a live stream — destroys the underlying request, which finalizes the
  // stream (an http:stream:end with aborted:true is pushed to the renderer).
  ipcMain.handle("http:stream:abort", (_event, { streamId } = {}) => {
    const entry = activeStreams.get(streamId);
    if (!entry) return { ok: false, reason: "not-found" };
    entry.aborted = true;
    try {
      entry.req.destroy();
    } catch {
      // already torn down — finalize will still run via the close/error handler
    }
    return { ok: true };
  });

  // Save the bytes received so far on a STILL-RUNNING stream. Once a stream
  // ends it registers a spill bodyRef, after which the renderer saves via the
  // existing http:body:save instead.
  ipcMain.handle(
    "http:stream:save",
    async (_event, { streamId, filename } = {}) => {
      const entry = activeStreams.get(streamId);
      if (!entry || !entry.spillPath) return { ok: false, reason: "not-found" };
      const result = await dialog.showSaveDialog(getMainWin() ?? undefined, {
        defaultPath: filename || "stream.txt",
      });
      if (result.canceled || !result.filePath) {
        return { ok: false, reason: "canceled" };
      }
      try {
        await fs.promises.copyFile(entry.spillPath, result.filePath);
        return { ok: true, path: result.filePath };
      } catch (err) {
        return { ok: false, reason: "error", message: err.message };
      }
    },
  );

  // ── Lifecycle cleanup — never leak a live stream past its renderer ─────────
  // A reload (did-navigate) or a destroyed/crashed webContents aborts every
  // stream that renderer owned; finalize unlinks the spill file.
  app.on("web-contents-created", (_e, contents) => {
    const drop = () => {
      for (const entry of activeStreams.values()) {
        if (entry.senderId === contents.id) {
          entry.aborted = true;
          try {
            entry.req.destroy();
          } catch {
            // best-effort
          }
        }
      }
      // Buffered requests owned by the gone renderer: same hazard (a large
      // download would otherwise run to completion against a dead listener).
      for (const entry of activeRequests.values()) {
        if (entry.senderId === contents.id) {
          entry.aborted = true;
          try {
            entry.req?.destroy();
          } catch {
            // best-effort
          }
        }
      }
    };
    contents.on("did-navigate", drop);
    contents.on("render-process-gone", drop);
    contents.on("destroyed", drop);
  });
}

module.exports = { registerHttpEngine };
