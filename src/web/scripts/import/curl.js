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

"use strict";

import {
  buildAuth,
  noBody,
  rawBody,
  rawBodyFromMime,
  formBody,
  authFromHeaderValue,
  splitUrlQuery,
  parseUrlencodedRows,
  requestName,
} from "./shape.js";

/**
 * import/curl.js
 *
 * Parse a raw `curl` command — as produced by a browser's "Copy as cURL", an
 * API doc, or written by hand — into a Rest Hippo collection holding the single
 * request it describes. Unlike the file importers this takes a pasted string,
 * but it returns the same `{ collection, variables, warnings }` shape so the
 * import flow in `app.js` appends it as a new collection identically.
 *
 * Scope: the flags people actually copy/paste — `-X/--request`, `-H/--header`,
 * `-d/--data*` (`--data`, `--data-raw`, `--data-ascii`, `--data-binary`,
 * `--data-urlencode`), `-F/--form`, `-u/--user`, `-b/--cookie`, `-A`, `-e`,
 * `-G/--get`, `-I/--head`, `--url`, and a bare URL — plus quoting and `\`
 * line-continuations. Boolean flags it doesn't model (`-L`, `-k`, `-s`, …) are
 * skipped harmlessly; an unknown value-bearing flag is reported via `warnings`.
 *
 * Like the other importers, only a fatal problem (no URL at all) throws; every
 * lossy-but-recoverable conversion is reported through `warnings`.
 */

// Short flags that consume a value — either the remainder of the cluster
// (`-HAccept: …`) or the next token (`-H 'Accept: …'`). Every other short flag
// is treated as a boolean and either handled (`-G`, `-I`) or skipped.
const SHORT_WITH_VALUE = new Set(["X", "H", "d", "F", "u", "b", "A", "e"]);

/**
 * Tokenize a shell-ish curl command, honouring single quotes (literal),
 * double quotes (with `\"`, `\\`, `\$`, `` \` `` and line-continuation escapes),
 * `$'…'` ANSI-C quoting, bare `\` escapes, and `\`-newline continuations.
 *
 * @param {string} input
 * @returns {string[]} argv-style tokens
 */
export function tokenizeCurl(input) {
  const tokens = [];
  const text = input ?? "";
  const n = text.length;
  let cur = "";
  let started = false; // tracks an empty-but-present token (e.g. `-d ''`)
  let i = 0;

  const flush = () => {
    if (started) {
      tokens.push(cur);
      cur = "";
      started = false;
    }
  };

  while (i < n) {
    const c = text[i];

    if (c === "\\") {
      const next = text[i + 1];
      if (next === "\n") {
        i += 2;
        continue; // line continuation
      }
      if (next === "\r" && text[i + 2] === "\n") {
        i += 3;
        continue;
      }
      if (next === undefined) {
        i += 1;
        continue;
      }
      cur += next;
      started = true;
      i += 2;
      continue;
    }

    if (c === "'") {
      started = true;
      i += 1;
      while (i < n && text[i] !== "'") {
        cur += text[i];
        i += 1;
      }
      i += 1; // closing quote (or EOF)
      continue;
    }

    if (c === '"') {
      started = true;
      i += 1;
      while (i < n && text[i] !== '"') {
        if (text[i] === "\\") {
          const nx = text[i + 1];
          if (nx === '"' || nx === "\\" || nx === "$" || nx === "`") {
            cur += nx;
            i += 2;
            continue;
          }
          if (nx === "\n") {
            i += 2;
            continue;
          }
        }
        cur += text[i];
        i += 1;
      }
      i += 1;
      continue;
    }

    if (c === "$" && text[i + 1] === "'") {
      // ANSI-C quoting: $'…' with the common backslash escapes.
      started = true;
      i += 2;
      const ESC = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"' };
      while (i < n && text[i] !== "'") {
        if (text[i] === "\\" && text[i + 1] !== undefined) {
          const nx = text[i + 1];
          cur += nx in ESC ? ESC[nx] : nx;
          i += 2;
          continue;
        }
        cur += text[i];
        i += 1;
      }
      i += 1;
      continue;
    }

    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      flush();
      i += 1;
      continue;
    }

    cur += c;
    started = true;
    i += 1;
  }

  flush();
  return tokens;
}

/** Split a `Name: value` header line into `{ name, value }` (value trimmed). */
function splitHeaderLine(line) {
  const idx = (line ?? "").indexOf(":");
  if (idx < 0) return { name: (line ?? "").trim(), value: "" };
  return {
    name: line.slice(0, idx).trim(),
    value: line.slice(idx + 1).trim(),
  };
}

/**
 * Resolve a `-d`/`--data*` payload to a canonical body. An explicit
 * `Content-Type` header decides the raw language / form encoding; with none,
 * curl's default is form-urlencoded, so a payload shaped like `a=1&b=2` is read
 * as form fields and anything else is kept as raw text (so JSON pasted without a
 * header isn't mangled into one bogus field).
 */
function bodyFromData(dataText, contentType) {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("x-www-form-urlencoded")) {
    return formBody("form-urlencoded", parseUrlencodedRows(dataText));
  }
  const raw = rawBodyFromMime(ct, dataText);
  if (raw) return raw;
  if (ct) return rawBody("text", dataText);
  if (/^[^=&\s]+=[^&]*(?:&[^=&\s]+=[^&]*)*$/.test(dataText)) {
    return formBody("form-urlencoded", parseUrlencodedRows(dataText));
  }
  return rawBody("text", dataText);
}

/**
 * Transform a `--data-urlencode` argument into a pre-percent-encoded
 * `name=value` (or bare value) token, following curl's rules: curl URL-encodes
 * ONLY the value part, leaving the name literal. Encoding here means the later
 * `&`-join + URLSearchParams parse round-trips the value instead of mis-splitting
 * one that itself contains `&`/`=` (e.g. `q=a&b=c` must stay a single `q` param,
 * not become `q=a` + `b=c`).
 *   name=value → name=<enc(value)>
 *   =value     → <enc(value)>        (no name)
 *   value      → <enc(value)>        (whole arg is the value, no name)
 * The file forms (`@file`, `name@file`) can't be read by the importer; their
 * literal text is encoded as-is (best-effort) rather than silently mis-parsed.
 *
 * @param {string} token
 * @returns {string}
 */
function encodeDataUrlencode(token) {
  const t = token ?? "";
  const eq = t.indexOf("=");
  if (eq === -1) return encodeURIComponent(t);
  const name = t.slice(0, eq);
  const enc = encodeURIComponent(t.slice(eq + 1));
  return name ? `${name}=${enc}` : enc;
}

/**
 * Map a `-F`/`--form` part (`name=value`, `name=@file`, `name=<file`). A file
 * field produces a file row; whether to warn that its path needs re-attaching is
 * decided later, by `warnMissingFormFiles` (it depends on the file existing on
 * disk, which only the main process can check), so this stays pure.
 */
function formPart(part) {
  const eq = (part ?? "").indexOf("=");
  if (eq < 0) return { enabled: true, name: (part ?? "").trim(), value: "" };
  const name = part.slice(0, eq);
  const raw = part.slice(eq + 1);

  // A file field is signalled by curl's `@`/`<` file-read prefix, OR by a
  // `;filename=` attribute — a multipart modifier valid only on file parts, and
  // how Rest Hippo's own cURL export emits file fields (it omits the leading `@`, e.g.
  // `File1=/path;type=application/json;filename=graphql.json`).
  const prefixed = raw.startsWith("@") || raw.startsWith("<");
  const hasFilename = /;\s*filename=/i.test(raw);
  if (prefixed || hasFilename) {
    const spec = prefixed ? raw.slice(1) : raw;
    const semi = spec.indexOf(";");
    const path = semi >= 0 ? spec.slice(0, semi) : spec;
    const typeMatch = spec.match(/;\s*type=([^;]+)/i);
    const contentType = typeMatch ? typeMatch[1].trim() : "";
    return { enabled: true, name, file: { path, contentType } };
  }
  return { enabled: true, name, value: raw };
}

/**
 * Parse a single `curl` command into a Rest Hippo collection of one request.
 *
 * @param {string} text  Raw pasted curl command
 * @returns {{ collection: object,
 *   variables: { name: string, value: string, secure: boolean }[],
 *   warnings: string[] }}
 * @throws {Error} when no URL can be found
 */
export function parseCurl(text) {
  const tokens = tokenizeCurl(text);

  // Begin after the `curl` token if present (some pastes prefix `$ ` or a full
  // path); otherwise parse from the start so a flags-only paste still works.
  let start = 0;
  const curlIdx = tokens.findIndex(
    (tok) => tok === "curl" || tok.endsWith("/curl"),
  );
  if (curlIdx >= 0) start = curlIdx + 1;

  const warnings = [];
  const headers = [];
  const dataParts = [];
  const formParts = [];
  const urls = [];
  let method = null;
  let user = null;
  let headAuth = null; // auth lifted from an Authorization header
  let useGet = false; // -G/--get: send data as query, not body
  let headOnly = false; // -I/--head

  const addHeader = (line) => {
    const { name, value } = splitHeaderLine(line);
    if (!name) return;
    if (name.toLowerCase() === "authorization") {
      const desc = authFromHeaderValue(value);
      if (desc) {
        headAuth = desc; // surfaced in the Auth tab instead of as a header
        return;
      }
    }
    headers.push({ enabled: true, name, value });
  };

  for (let i = start; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === "" || tok == null) continue;

    if (tok.startsWith("--")) {
      let name = tok;
      let inlineVal = null;
      const eq = tok.indexOf("=");
      if (eq >= 0) {
        name = tok.slice(0, eq);
        inlineVal = tok.slice(eq + 1);
      }
      // Consume a value: the `--flag=value` form, else the next token.
      const value = () => (inlineVal != null ? inlineVal : tokens[++i]);

      switch (name) {
        case "--request":
          method = (value() ?? "").toUpperCase();
          break;
        case "--url":
          urls.push(value() ?? "");
          break;
        case "--header":
          addHeader(value() ?? "");
          break;
        case "--data":
        case "--data-raw":
        case "--data-ascii":
        case "--data-binary":
          dataParts.push(value() ?? "");
          break;
        case "--data-urlencode":
          // curl percent-encodes the value part; do the same so a value with
          // `&`/`=` survives the later urlencoded parse as one field.
          dataParts.push(encodeDataUrlencode(value() ?? ""));
          break;
        case "--form":
          formParts.push(value() ?? "");
          break;
        case "--user":
          user = value() ?? "";
          break;
        case "--cookie":
          addHeader(`Cookie: ${value() ?? ""}`);
          break;
        case "--user-agent":
          addHeader(`User-Agent: ${value() ?? ""}`);
          break;
        case "--referer":
          addHeader(`Referer: ${value() ?? ""}`);
          break;
        case "--get":
          useGet = true;
          break;
        case "--head":
          headOnly = true;
          break;
        // Boolean flags Rest Hippo doesn't model — skip without consuming a value.
        case "--compressed":
        case "--location":
        case "--insecure":
        case "--silent":
        case "--show-error":
        case "--fail":
        case "--verbose":
        case "--globoff":
        case "--http1.1":
        case "--http2":
          break;
        default:
          warnings.push(`Ignored unsupported cURL option "${name}".`);
          break;
      }
      continue;
    }

    if (tok.startsWith("-") && tok.length > 1) {
      // A short-flag cluster: booleans bundle (`-sSL`); the first value-taking
      // flag consumes the rest of the cluster (`-XPOST`) or the next token.
      for (let j = 1; j < tok.length; j++) {
        const f = tok[j];
        if (SHORT_WITH_VALUE.has(f)) {
          const attached = tok.slice(j + 1);
          const val = attached.length ? attached : (tokens[++i] ?? "");
          if (f === "X") method = val.toUpperCase();
          else if (f === "H") addHeader(val);
          else if (f === "d") dataParts.push(val);
          else if (f === "F") formParts.push(val);
          else if (f === "u") user = val;
          else if (f === "b") addHeader(`Cookie: ${val}`);
          else if (f === "A") addHeader(`User-Agent: ${val}`);
          else if (f === "e") addHeader(`Referer: ${val}`);
          break; // the value ends the cluster
        }
        if (f === "G") useGet = true;
        else if (f === "I") headOnly = true;
        // other boolean short flags (-s, -S, -L, -k, …) are ignored
      }
      continue;
    }

    // A bare token is a URL.
    urls.push(tok);
  }

  if (urls.length > 1) {
    warnings.push(
      `Found ${urls.length} URLs; imported the first and skipped the rest.`,
    );
  }
  const rawUrl = urls[0] ?? "";
  if (!rawUrl) {
    // English `.message` is the log/fallback; `.i18nKey` lets the UI catch site
    // localize it (this module stays free of `t()` by convention).
    throw Object.assign(new Error("No URL found in the cURL command."), {
      i18nKey: "app.importErrCurlNoUrl",
    });
  }

  // Method default: explicit -X wins; -I → HEAD; a body → POST; else GET.
  if (!method) {
    if (headOnly) method = "HEAD";
    else if ((dataParts.length || formParts.length) && !useGet) method = "POST";
    else method = "GET";
  }

  const { base, params } = splitUrlQuery(rawUrl);

  // -G sends the accumulated -d payload as query params rather than a body.
  let body = noBody();
  if (useGet && dataParts.length) {
    for (const row of parseUrlencodedRows(dataParts.join("&"))) {
      params.push(row);
    }
  } else if (formParts.length) {
    body = formBody("form-data", formParts.map(formPart));
  } else if (dataParts.length) {
    const ct = headers.find((h) => h.name.toLowerCase() === "content-type");
    body = bodyFromData(dataParts.join("&"), ct?.value);
  }

  // Auth: an Authorization header wins; otherwise `-u user:pass` is basic auth.
  let auth = buildAuth(null);
  if (headAuth) {
    auth = buildAuth(headAuth);
  } else if (user != null) {
    const idx = user.indexOf(":");
    auth = buildAuth({
      type: "basic",
      username: idx >= 0 ? user.slice(0, idx) : user,
      password: idx >= 0 ? user.slice(idx + 1) : "",
    });
  }

  const request = {
    id: crypto.randomUUID(),
    type: "request",
    name: requestName(method, base),
    method,
    url: base,
    params,
    headers,
    notes: "",
    ...body,
    ...auth,
  };

  return {
    collection: {
      id: crypto.randomUUID(),
      type: "collection",
      name: "Imported from cURL",
      variables: [],
      children: [request],
    },
    variables: [],
    warnings,
  };
}
