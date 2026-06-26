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
 * header-suggestions.js — the standard-header "supported header lists" and the
 * two combo-box dropdowns that drive the header-name / header-value autocomplete.
 *
 * Extracted verbatim from RequestEditor so the request Headers editor and the
 * collection-level Headers editor (headers-editor.js) share ONE source of truth
 * for the suggestion dictionary and the dropdown mechanism. The dropdown
 * singletons are module-private (one shared pair app-wide is fine — the request
 * editor lives in the main pane while the collection editor is a modal popup, so
 * they are never both editing headers at once).
 */

"use strict";

import { AutocompleteDropdown } from "./kv-editor-shared.js";
import { t } from "../i18n.js";

// Standard HTTP request headers offered in the header-name combo box.
// Custom values are always accepted too (free-text input).
export const STANDARD_HEADERS_DICT = {
  Accept: [
    "*/*",
    "application/json",
    "application/yaml",
    "application/xml",
    "application/xhtml+xml",
    "text/html",
    "text/plain",
    "text/css",
    "text/xml",
    "text/yaml",
    "text/javascript",
    "image/png",
    "image/jpeg",
    "image/webp",
    "multipart/form-data",
  ],

  "Accept-Charset": ["utf-8", "iso-8859-1", "*"],

  "Accept-Encoding": ["gzip", "deflate", "br", "compress", "identity", "*"],

  "Accept-Language": ["en-US", "en", "fr", "de", "es", "zh-CN", "ja", "*"],

  Authorization: [
    "Basic <base64(username:password)>",
    "Bearer <token>",
    "Digest <credentials>",
    "NTLM <base64(message)>",
    "Negotiate <token>",
    "OAuth <token>",
    "AWS4-HMAC-SHA256 Credential=<credential>, SignedHeaders=<headers>, Signature=<signature>",
  ],

  "Cache-Control": [
    "no-cache",
    "no-store",
    "max-age=<seconds>",
    "max-stale=<seconds>",
    "min-fresh=<seconds>",
    "must-revalidate",
    "proxy-revalidate",
    "public",
    "private",
    "immutable",
    "only-if-cached",
  ],

  Connection: ["keep-alive", "close", "Upgrade"],

  "Content-Encoding": ["gzip", "compress", "deflate", "br", "identity"],

  "Content-Length": ["<number>"],

  "Content-MD5": ["<base64-md5>"],

  "Content-Type": [
    "application/json",
    "application/xml",
    "application/x-www-form-urlencoded",
    "multipart/form-data",
    "text/plain",
    "text/html",
    "text/css",
    "text/csv",
    "application/octet-stream",
    "image/png",
    "image/jpeg",
  ],

  Cookie: ["<name>=<value>", "<name>=<value>; <name2>=<value2>"],

  Date: ["Tue, 15 Nov 1994 08:12:31 GMT"],

  DNT: ["0", "1"],

  Expect: ["100-continue"],

  Forwarded: [
    "for=<client-ip>",
    "for=<client-ip>;proto=https",
    "for=<client-ip>;host=<host>",
    "by=<proxy-id>",
  ],

  From: ["<email@example.com>"],

  Host: ["<hostname>", "<hostname>:<port>"],

  "If-Match": ['"<etag>"', "*"],

  "If-Modified-Since": ["Tue, 15 Nov 1994 08:12:31 GMT"],

  "If-None-Match": ['"<etag>"', "*"],

  "If-Range": ['"<etag>"', "Tue, 15 Nov 1994 08:12:31 GMT"],

  "If-Unmodified-Since": ["Tue, 15 Nov 1994 08:12:31 GMT"],

  "Max-Forwards": ["<number>"],

  Origin: ["https://example.com", "null"],

  Pragma: ["no-cache"],

  "Proxy-Authorization": [
    "Basic <base64(username:password)>",
    "Bearer <token>",
    "Digest <credentials>",
    "NTLM <base64(message)>",
    "Negotiate <token>",
  ],

  Range: ["bytes=0-499", "bytes=500-999", "bytes=-500", "bytes=9500-"],

  Referer: ["https://example.com/page"],

  TE: ["trailers", "compress", "deflate", "gzip"],

  Trailer: ["Content-MD5", "ETag"],

  "Transfer-Encoding": ["chunked", "compress", "deflate", "gzip", "identity"],

  Upgrade: ["websocket", "h2c", "TLS/1.0"],

  "User-Agent": [
    "Mozilla/5.0",
    "RestHippo/<version>",
    "PostmanRuntime/<version>",
    "python-requests/<version>",
    "Go/<version>",
  ],

  Via: ["1.1 vegur", "1.0 proxy", "HTTP/1.1 proxy.example.com"],

  Warning: [
    "110 Response is stale",
    "111 Revalidation failed",
    "199 Miscellaneous warning",
  ],

  "X-Api-Key": [],

  "X-Auth-Token": ["<token>"],

  "X-Csrf-Token": ["<token>"],

  "X-Forwarded-For": ["<client-ip>", "<client-ip>, <proxy-ip>"],

  "X-Forwarded-Host": ["<hostname>"],

  "X-Forwarded-Proto": ["http", "https"],

  "X-Request-Id": ["<uuid>"],

  "X-Requested-With": ["XMLHttpRequest"],
};

// Two dropdown instances — one per combo input. The aria-labels are passed as
// resolver functions so they localise at first show() (the i18n catalog is not
// loaded when this module first evaluates). hdrAcOnSelect / hdrValOnSelect hold
// the active name/value callbacks for the keyboard-accept paths.
export const hdrAc = new AutocompleteDropdown("hdr-autocomplete", () =>
  t("request.headers.suggestionsAria"),
);
let _hdrAcOnSelect = null;
export const hdrVal = new AutocompleteDropdown(
  "hdr-autocomplete hdr-val-autocomplete",
  () => t("request.headers.valueSuggestionsAria"),
);
let _hdrValOnSelect = null;

// ── Header-name suggestions dropdown ──────────────────────────────────────────

export function showHdrDropdown(input, onSelect) {
  // Store the on-select callback so the keyboard-accept path can fire it too.
  _hdrAcOnSelect = onSelect ?? null;

  const query = input.value.toLowerCase().trim();
  const allHeaders = Object.keys(STANDARD_HEADERS_DICT);
  const matches = query
    ? allHeaders.filter((h) => h.toLowerCase().includes(query))
    : allHeaders;

  hdrAc.show(input, matches, (h) => {
    input.value = h;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    hdrAc.hide();
    input.focus();
    _hdrAcOnSelect?.(h);
  });
}

/** Accept the currently keyboard-focused item, if any. */
export function hdrDropdownAccept(input) {
  const label = hdrAc.activeLabel();
  if (label === null) return false;
  input.value = label;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  hdrAc.hide();
  _hdrAcOnSelect?.(input.value);
  return true;
}

// ── Header-value suggestions dropdown ─────────────────────────────────────────

/**
 * Populate and show the value-suggestions dropdown below `anchorEl`.
 *
 * @param {HTMLElement} anchorEl  The value editor element to anchor below.
 * @param {string[]}    values    Candidate values from STANDARD_HEADERS_DICT.
 * @param {Function}    onSelect  Called with the chosen value string.
 */
export function showHdrValDropdown(anchorEl, values, onSelect) {
  _hdrValOnSelect = onSelect ?? null;
  hdrVal.show(
    anchorEl,
    values,
    (v) => {
      hdrVal.hide();
      _hdrValOnSelect?.(v);
      anchorEl.focus();
    },
    { minWidth: 220 },
  );
}

/** Accept the currently keyboard-focused value item, if any. */
export function hdrValDropdownAccept() {
  const label = hdrVal.activeLabel();
  if (label === null) return false;
  hdrVal.hide();
  _hdrValOnSelect?.(label);
  return true;
}

/** Returns true if the value-suggestions dropdown is currently visible. */
export function hdrValDropdownVisible() {
  return hdrVal.visible;
}
