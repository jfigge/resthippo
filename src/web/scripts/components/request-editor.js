/**
 * request-editor.js — Request definition panel component
 */

"use strict";

import {
  parse as parseYaml,
  stringify as stringifyYaml,
} from "../vendor/yaml.js";
import { VariablePillEditor } from "./variable-pill-editor.js";
import {
  resolveStringAsync,
  collectTemplateVariables,
  tokenize,
  parseFunctionCall,
  isFunctionCall,
} from "./variable-resolver.js";
import { PopupManager } from "../popup-manager.js";
import Prism from "../vendor/prism.js";
import { oauthExecutor } from "../auth/oauth-executor.js";

// Per-row data delete uses a trash-can glyph (matches .params-delete-btn rows
// throughout the app). Entity/dialog [X] glyphs are separate.
const ICON_TRASH = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
  aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`;

// Standard HTTP request headers offered in the header-name combo box.
// Custom values are always accepted too (free-text input).
const STANDARD_HEADERS_DICT = {
  Accept: [
    "*/*",
    "application/json",
    "application/xhtml+xml",
    "text/html",
    "text/plain",
    "text/css",
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
    "wurl/<version>",
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

/** Lazily create + cache the shared autocomplete dropdown in the document. */
let _hdrAcDropdown = null; // the floating listbox div
let _hdrAcActiveInput = null; // which input currently owns the dropdown
let _hdrAcActiveIdx = -1; // keyboard-focused item index (-1 = none)
let _hdrAcBlurTimer = null; // pending blur-hide timer (cancelled on re-focus)
let _hdrAcOnSelect = null; // optional callback(headerName) fired when a name item is confirmed

// ── Header-value suggestions dropdown ─────────────────────────────────────────
let _hdrValDropdown = null; // the floating value listbox div
let _hdrValActiveEl = null; // which valueEditor.element currently owns the dropdown
let _hdrValActiveIdx = -1; // keyboard-focused item index (-1 = none)
let _hdrValBlurTimer = null; // pending blur-hide timer
let _hdrValOnSelect = null; // callback(selectedValue) fired when a value is picked

function _ensureHdrDropdown() {
  if (_hdrAcDropdown) return _hdrAcDropdown;
  _hdrAcDropdown = document.createElement("div");
  _hdrAcDropdown.className = "hdr-autocomplete";
  _hdrAcDropdown.setAttribute("role", "listbox");
  _hdrAcDropdown.setAttribute("aria-label", "Header suggestions");
  document.body.appendChild(_hdrAcDropdown);

  // Hide when anything outside the input+dropdown is clicked
  document.addEventListener(
    "mousedown",
    (e) => {
      if (
        _hdrAcActiveInput &&
        !_hdrAcActiveInput.contains(e.target) &&
        !_hdrAcDropdown.contains(e.target)
      ) {
        _hideHdrDropdown();
      }
    },
    true,
  );

  return _hdrAcDropdown;
}

function _showHdrDropdown(input, onSelect) {
  // Cancel any pending blur-hide so rapid blur→focus doesn't flash the dropdown
  if (_hdrAcBlurTimer !== null) {
    clearTimeout(_hdrAcBlurTimer);
    _hdrAcBlurTimer = null;
  }

  // Store the on-select callback so the keyboard-accept path can fire it too.
  _hdrAcOnSelect = onSelect ?? null;

  const dl = _ensureHdrDropdown();
  const query = input.value.toLowerCase().trim();
  const allHeaders = Object.keys(STANDARD_HEADERS_DICT);
  const matches = query
    ? allHeaders.filter((h) => h.toLowerCase().includes(query))
    : allHeaders;

  if (matches.length === 0) {
    _hideHdrDropdown();
    return;
  }

  dl.innerHTML = "";
  _hdrAcActiveIdx = -1;

  matches.forEach((h, i) => {
    const item = document.createElement("div");
    item.className = "hdr-autocomplete__item";
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", "false");
    item.dataset.idx = String(i);
    item.textContent = h;

    // mousedown (not click) so we fire before the input's blur
    item.addEventListener("mousedown", (e) => {
      e.preventDefault();
      input.value = h;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      _hideHdrDropdown();
      input.focus();
      _hdrAcOnSelect?.(h);
    });
    dl.appendChild(item);
  });

  // Position directly below the input
  const rect = input.getBoundingClientRect();
  dl.style.left = `${rect.left + window.scrollX}px`;
  dl.style.top = `${rect.bottom + window.scrollY + 2}px`;
  dl.style.width = `${rect.width}px`;
  dl.classList.add("hdr-autocomplete--visible");
  _hdrAcActiveInput = input;
}

function _hideHdrDropdown() {
  _hdrAcBlurTimer = null;
  if (_hdrAcDropdown) {
    _hdrAcDropdown.classList.remove("hdr-autocomplete--visible");
    _hdrAcDropdown.innerHTML = "";
  }
  _hdrAcActiveInput = null;
  _hdrAcActiveIdx = -1;
}

/** Move keyboard focus within the dropdown; wraps around. */
function _hdrDropdownNavigate(dir) {
  if (!_hdrAcDropdown) return;
  const items = [..._hdrAcDropdown.querySelectorAll(".hdr-autocomplete__item")];
  if (!items.length) return;

  items[_hdrAcActiveIdx]?.classList.remove("hdr-autocomplete__item--active");
  items[_hdrAcActiveIdx]?.setAttribute("aria-selected", "false");

  _hdrAcActiveIdx = (_hdrAcActiveIdx + dir + items.length) % items.length;

  const active = items[_hdrAcActiveIdx];
  active.classList.add("hdr-autocomplete__item--active");
  active.setAttribute("aria-selected", "true");
  active.scrollIntoView({ block: "nearest" });
}

/** Accept the currently keyboard-focused item, if any. */
function _hdrDropdownAccept(input) {
  if (!_hdrAcDropdown || _hdrAcActiveIdx < 0) return false;
  const items = _hdrAcDropdown.querySelectorAll(".hdr-autocomplete__item");
  const active = items[_hdrAcActiveIdx];
  if (!active) return false;
  input.value = active.textContent;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  _hideHdrDropdown();
  _hdrAcOnSelect?.(input.value);
  return true;
}

// ── Header-value suggestions dropdown ─────────────────────────────────────────

/** Lazily create the value-suggestions dropdown div and attach global dismiss. */
function _ensureHdrValDropdown() {
  if (_hdrValDropdown) return _hdrValDropdown;
  _hdrValDropdown = document.createElement("div");
  _hdrValDropdown.className = "hdr-autocomplete hdr-val-autocomplete";
  _hdrValDropdown.setAttribute("role", "listbox");
  _hdrValDropdown.setAttribute("aria-label", "Header value suggestions");
  document.body.appendChild(_hdrValDropdown);

  // Dismiss when the user clicks outside both the anchor element and the dropdown.
  document.addEventListener(
    "mousedown",
    (e) => {
      if (
        _hdrValActiveEl &&
        !_hdrValActiveEl.contains(e.target) &&
        !_hdrValDropdown.contains(e.target)
      ) {
        _hideHdrValDropdown();
      }
    },
    true,
  );

  return _hdrValDropdown;
}

/**
 * Populate and show the value-suggestions dropdown below `anchorEl`.
 *
 * @param {HTMLElement} anchorEl  The value editor element to anchor below.
 * @param {string[]}    values    Candidate values from STANDARD_HEADERS_DICT.
 * @param {Function}    onSelect  Called with the chosen value string.
 */
function _showHdrValDropdown(anchorEl, values, onSelect) {
  if (_hdrValBlurTimer !== null) {
    clearTimeout(_hdrValBlurTimer);
    _hdrValBlurTimer = null;
  }
  if (!values || values.length === 0) {
    _hideHdrValDropdown();
    return;
  }

  _hdrValOnSelect = onSelect ?? null;

  const dl = _ensureHdrValDropdown();
  dl.innerHTML = "";
  _hdrValActiveIdx = -1;

  values.forEach((v, i) => {
    const item = document.createElement("div");
    item.className = "hdr-autocomplete__item";
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", "false");
    item.dataset.idx = String(i);
    item.textContent = v;

    item.addEventListener("mousedown", (e) => {
      e.preventDefault(); // keep focus on the value editor
      _hideHdrValDropdown();
      _hdrValOnSelect?.(v);
      anchorEl.focus();
    });
    dl.appendChild(item);
  });

  const rect = anchorEl.getBoundingClientRect();
  dl.style.left = `${rect.left + window.scrollX}px`;
  dl.style.top = `${rect.bottom + window.scrollY + 2}px`;
  // At least as wide as the anchor, or 220 px — values can be long.
  dl.style.width = `${Math.max(rect.width, 220)}px`;
  dl.classList.add("hdr-autocomplete--visible");
  _hdrValActiveEl = anchorEl;
}

function _hideHdrValDropdown() {
  _hdrValBlurTimer = null;
  if (_hdrValDropdown) {
    _hdrValDropdown.classList.remove("hdr-autocomplete--visible");
    _hdrValDropdown.innerHTML = "";
  }
  _hdrValActiveEl = null;
  _hdrValActiveIdx = -1;
}

/** Move keyboard focus within the value dropdown; wraps around. */
function _hdrValDropdownNavigate(dir) {
  if (!_hdrValDropdown) return;
  const items = [
    ..._hdrValDropdown.querySelectorAll(".hdr-autocomplete__item"),
  ];
  if (!items.length) return;

  items[_hdrValActiveIdx]?.classList.remove("hdr-autocomplete__item--active");
  items[_hdrValActiveIdx]?.setAttribute("aria-selected", "false");

  _hdrValActiveIdx = (_hdrValActiveIdx + dir + items.length) % items.length;

  const active = items[_hdrValActiveIdx];
  active.classList.add("hdr-autocomplete__item--active");
  active.setAttribute("aria-selected", "true");
  active.scrollIntoView({ block: "nearest" });
}

/** Accept the currently keyboard-focused value item, if any. */
function _hdrValDropdownAccept() {
  if (!_hdrValDropdown || _hdrValActiveIdx < 0) return false;
  const items = _hdrValDropdown.querySelectorAll(".hdr-autocomplete__item");
  const active = items[_hdrValActiveIdx];
  if (!active) return false;
  _hideHdrValDropdown();
  _hdrValOnSelect?.(active.textContent);
  return true;
}

/** Returns true if the value-suggestions dropdown is currently visible. */
function _hdrValDropdownVisible() {
  return !!_hdrValDropdown?.classList.contains("hdr-autocomplete--visible");
}

// ── Scope suggestions dropdown ────────────────────────────────────────────────
// Reuses the same .hdr-autocomplete CSS classes as the header dropdowns.
// The list is populated from DEFAULT_SCOPES; the user can always type freely.

const DEFAULT_SCOPES = ["openid", "email", "profile"];

const OAUTH2_ADVANCED_KEYS = new Set([
  "responseType",
  "state",
  "credentials",
  "audience",
  "resource",
  "origin",
  "headerPrefix",
]);

let _scopeDropdown = null;
let _scopeActiveEl = null;
let _scopeActiveIdx = -1;
let _scopeBlurTimer = null;

function _ensureScopeDropdown() {
  if (_scopeDropdown) return _scopeDropdown;
  _scopeDropdown = document.createElement("div");
  _scopeDropdown.className = "hdr-autocomplete scope-autocomplete";
  _scopeDropdown.setAttribute("role", "listbox");
  _scopeDropdown.setAttribute("aria-label", "Scope suggestions");
  document.body.appendChild(_scopeDropdown);

  document.addEventListener(
    "mousedown",
    (e) => {
      if (
        _scopeActiveEl &&
        !_scopeActiveEl.contains(e.target) &&
        !_scopeDropdown.contains(e.target)
      ) {
        _hideScopeDropdown();
      }
    },
    true,
  );

  return _scopeDropdown;
}

/**
 * Show / refresh the scope suggestion dropdown below `input`.
 * `onSelect(picked, currentWord)` is called when the user picks an item.
 * `scopeList` defaults to DEFAULT_SCOPES but can be overridden with OIDC-discovered scopes.
 */
function _showScopeDropdown(input, onSelect, scopeList = DEFAULT_SCOPES) {
  if (_scopeBlurTimer !== null) {
    clearTimeout(_scopeBlurTimer);
    _scopeBlurTimer = null;
  }

  const dl = _ensureScopeDropdown();
  const fullVal = input.value;

  // The "current word" is the token after the last space
  const lastSpace = fullVal.lastIndexOf(" ");
  const currentWord = lastSpace === -1 ? fullVal : fullVal.slice(lastSpace + 1);

  // Scopes the user has already fully typed (everything except the current partial word)
  const selected = new Set(
    fullVal.split(/\s+/).filter((s) => s && s !== currentWord),
  );

  // Suggestions: match current word prefix, not already selected
  const matches = scopeList.filter(
    (s) =>
      s.toLowerCase().startsWith(currentWord.toLowerCase()) && !selected.has(s),
  );

  if (matches.length === 0) {
    _hideScopeDropdown();
    return;
  }

  dl.innerHTML = "";
  _scopeActiveIdx = -1;

  matches.forEach((s) => {
    const item = document.createElement("div");
    item.className = "hdr-autocomplete__item";
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", "false");
    item.textContent = s;

    item.addEventListener("mousedown", (e) => {
      e.preventDefault();
      _hideScopeDropdown();
      onSelect(s, currentWord);
      input.focus();
    });
    dl.appendChild(item);
  });

  const rect = input.getBoundingClientRect();
  dl.style.left = `${rect.left + window.scrollX}px`;
  dl.style.top = `${rect.bottom + window.scrollY + 2}px`;
  dl.style.width = `${rect.width}px`;
  dl.classList.add("hdr-autocomplete--visible");
  _scopeActiveEl = input;
}

function _hideScopeDropdown() {
  _scopeBlurTimer = null;
  if (_scopeDropdown) {
    _scopeDropdown.classList.remove("hdr-autocomplete--visible");
    _scopeDropdown.innerHTML = "";
  }
  _scopeActiveEl = null;
  _scopeActiveIdx = -1;
}

function _scopeDropdownNavigate(dir) {
  if (!_scopeDropdown) return;
  const items = [..._scopeDropdown.querySelectorAll(".hdr-autocomplete__item")];
  if (!items.length) return;

  items[_scopeActiveIdx]?.classList.remove("hdr-autocomplete__item--active");
  items[_scopeActiveIdx]?.setAttribute("aria-selected", "false");

  _scopeActiveIdx = (_scopeActiveIdx + dir + items.length) % items.length;

  const active = items[_scopeActiveIdx];
  active.classList.add("hdr-autocomplete__item--active");
  active.setAttribute("aria-selected", "true");
  active.scrollIntoView({ block: "nearest" });
}

function _scopeDropdownAccept(input, onSelect) {
  if (!_scopeDropdown || _scopeActiveIdx < 0) return false;
  const items = _scopeDropdown.querySelectorAll(".hdr-autocomplete__item");
  const active = items[_scopeActiveIdx];
  if (!active) return false;
  const fullVal = input.value;
  const lastSpace = fullVal.lastIndexOf(" ");
  const currentWord = lastSpace === -1 ? fullVal : fullVal.slice(lastSpace + 1);
  _hideScopeDropdown();
  onSelect(active.textContent, currentWord);
  return true;
}

const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
];

const TABS = [
  { id: "params", label: "Params" },
  { id: "headers", label: "Headers" },
  { id: "body", label: "Body" },
  { id: "auth", label: "Auth" },
  { id: "notes", label: "Notes" },
];

// ── Backend-routed HTTP helper ─────────────────────────────────────────────────
/**
 * Perform a GET request through the same backend routing used for normal
 * wurl requests, bypassing the renderer's CORS enforcement.
 *
 * • Electron  → window.wurl.http.execute  (IPC → main process Node.js http)
 * • Dev-server → POST /api/execute        (Go server makes the outgoing call)
 *
 * Resolves with the parsed JSON body on success.
 * Rejects with an Error whose message describes the problem on failure.
 *
 * @param {string} url
 * @returns {Promise<object>}
 */
async function _fetchJson(url) {
  const desc = { method: "GET", url, followRedirects: true, verifySsl: true };

  let result;
  if (typeof window.wurl?.http?.execute === "function") {
    // ── Electron path ──────────────────────────────────────────────────────
    result = await window.wurl.http.execute(desc);
  } else {
    // ── Go dev-server path ─────────────────────────────────────────────────
    const res = await fetch("/api/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(desc),
    });
    result = await res.json();
  }

  if (result?.error) {
    const msg =
      typeof result.error === "object"
        ? (result.error.message ?? JSON.stringify(result.error))
        : result.error;
    throw new Error(msg);
  }

  const status = result?.status ?? 0;
  if (status < 200 || status >= 300) {
    throw new Error(
      `Server returned HTTP ${status} ${result?.statusText ?? ""}`.trimEnd(),
    );
  }

  try {
    return JSON.parse(result.body ?? "");
  } catch {
    throw new Error("Response was not valid JSON");
  }
}

/** Percent-encode the domain and path of a resolved URL. */
function _encodeBaseUrl(url) {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

function _extractResponseFunctionRefs(templates) {
  const RESPONSE_FNS = new Set([
    "response",
    "responseHeader",
    "responseStatus",
  ]);
  const map = new Map();
  for (const tpl of templates) {
    if (!tpl) continue;
    for (const tok of tokenize(tpl)) {
      if (tok.type !== "variable") continue;
      if (!isFunctionCall(tok.content)) continue;
      const parsed = parseFunctionCall(tok.content);
      if (!parsed || !RESPONSE_FNS.has(parsed.name)) continue;
      const reqName = parsed.rawArgs[0] ?? "";
      if (!reqName) continue;
      const modeArgIdx = parsed.name === "responseStatus" ? 1 : 2;
      const rawMode = parsed.rawArgs[modeArgIdx] ?? "";
      const mode =
        rawMode === "Run immediately before"
          ? "run-immediately"
          : "use-last-result";
      if (!map.has(reqName) || mode === "run-immediately") {
        map.set(reqName, mode);
      }
    }
  }
  return [...map.entries()].map(([name, mode]) => ({ name, mode }));
}

export class RequestEditor {
  /** @type {HTMLElement} */
  #el;
  #method = "GET";
  #url = "";
  #activeTab = "params";
  #currentNodeId = null;

  // Params state
  #params = []; // [{ id, name, value, enabled }]
  #paramsListEl = null;
  #urlPreviewEnabled = true; // toggled by "Show URL" checkbox
  #urlPreviewEl = null; // the preview bar element
  #urlPreviewInputEl = null; // the read-only input inside it
  #urlPreviewSeq = 0; // generation counter — guards against stale async results
  // Drag state
  #dragSrcId = null; // id of the param being dragged
  #dragInsideList = false;
  #dragDropHandled = false;
  #paramPhantomEl = null; // placeholder shown while dragging
  #docDragOverHandler = null;

  // Headers state
  #headers = []; // [{ id, name, value, enabled }]
  #headersListEl = null;
  #headerSuggestionsEnabled = true; // toggled by "List Headers" checkbox

  // Auth state
  #authType = "none";
  #authEnabled = true;
  #authBasic = { username: "", password: "" };
  #authBearer = { token: "" };
  #authOAuth2 = {
    grantType: "client_credentials",
    clientType: "confidential", // authorization_code only: "confidential" | "public"
    clientId: "",
    clientSecret: "",
    accessTokenUrl: "",
    authUrl: "",
    scope: "",
    token: "",
    refreshToken: "", // stored refresh token
    expiresAt: null, // ms timestamp when stored token expires (null = unknown)
    // Advanced fields
    state: "",
    credentials: "header", // "header" | "body"
    headerPrefix: "",
    audience: "",
    resource: "",
    origin: "",
    redirectUri: "", // OAuth redirect URI (default handled by executor)
    responseType: "access_token", // implicit only: "access_token" | "id_token" | "both"
    username: "", // resource owner password only
    password: "", // resource owner password only
    discoveredIssuer: "", // last issuer URL used for discovery — pre-fills dialog
    discoveredScopes: null, // string[] from last successful discovery, or null = DEFAULT_SCOPES
  };
  #authAwsIam = {
    accessKeyId: "",
    secretAccessKey: "",
    region: "",
    service: "",
    sessionToken: "",
  };
  // Secret field paths (e.g. "authBasic.password") whose stored ciphertext could
  // not be decrypted on load — the main process flags these via `_decryptErrors`.
  // Used to render an inline "couldn't decrypt — re-enter" notice on the field.
  #decryptErrors = new Set();
  #authContentEl = null;
  #authTypeBarEl = null;
  #discoverBtnEl = null;
  #authBulkEl = null; // the label wrapping the Bulk Editor checkbox
  #authBulkCheckEl = null; // the checkbox input itself
  #authBulkMode = false; // true while bulk textarea is shown
  #authEnabledLabelEl = null; // the label wrapping the Enabled checkbox

  // OAuth 2.0 advanced-fields toggle — persisted in app settings
  #oauth2Advanced = false;

  // Notes state
  #notes = "";
  #notesEl = null; // the <textarea> inside the Notes tab pane

  // Body state
  #bodyType = "no-body";
  #bodyContentEl = null;
  #bodyTypeBarEl = null; // the bar holding the type selector (+ optional Prettify)
  #bodyFormRows = []; // shared for form-data AND form-urlencoded
  #bodyText = ""; // shared for json, yaml, xml, and plain text
  #bodyFilePath = ""; // path/name of selected file (display)
  #bodyFileObject = null; // actual File object reference for sending
  // Body form drag state (one active form editor at a time)
  #bfListEl = null;
  #bfPhantom = null;
  #bfDragSrcId = null;
  #bfDragInside = false;
  #bfDropHandled = false;
  #bfActiveType = null;
  #bfDocHandler = null;
  #hdrDragSrcId = null;
  #hdrDragInsideList = false;
  #hdrDragDropHandled = false;
  #headerPhantomEl = null;
  #hdrDocDragOverHandler = null;

  // Params bulk editor
  #paramsBulkMode = false;
  #paramsBulkEl = null; // <textarea> shown in bulk mode
  #paramsKvWrapEl = null; // div wrapping col-headers + list
  #paramsAddBtnEl = null; // hidden in bulk mode
  #paramsDelAllBtnEl = null; // hidden in bulk mode

  // Headers bulk editor
  #headersBulkMode = false;
  #headersBulkEl = null;
  #headersKvWrapEl = null;
  #headersAddBtnEl = null;
  #headersDelAllBtnEl = null;
  #listHdrSpacerEl = null; // spacer before "List Headers" toggle
  #listHdrLabelEl = null; // "List Headers" toggle label

  // Body form bulk editor
  #bodyFormBulkMode = false;
  #bodyFormBulkEl = null;
  #bodyFormBulkCheckEl = null;
  #bodyFormKvWrapEl = null;
  #bodyFormAddBtnEl = null;
  #bodyFormDelAllBtnEl = null;
  #bodyFormToolbarGroupEl = null;
  _bodyFormDeleteAllCleanup = null;

  // Global "Remove Headers" setting — applied to body-form column label row
  #removeHeaders = false;

  #requestInFlight = false;

  // ── Variable pill editor support ───────────────────────────────────────────
  /** Current variable resolution context: { envVariables, folderChain, … } */
  #variableContext = null;
  /** Callback returning request items for function popup request-picker params. */
  #getItems = () => [];
  /** Async callback invoked before send to ensure cross-request response caches are loaded. */
  #ensureResponseCaches = null;

  /** Pill editor for the URL bar (single instance, never replaced). */
  #urlPillEditor = null;
  /** All active pill editors in the params list (cleared on each re-render). */
  #paramPillEditors = [];
  /** All active pill editors in the headers list (cleared on each re-render). */
  #headerPillEditors = [];
  /** All active pill editors in the body-form list (cleared on each re-render). */
  #bodyFormPillEditors = [];
  /** All active pill editors in the auth form (cleared on each re-render). */
  #authPillEditors = [];

  constructor() {
    this.#el = document.createElement("div");
    this.#el.className = "request-editor";

    this.#renderUrlBar();
    this.#renderTabStrip();
    this.#renderTabContent();
  }

  /** Root DOM element — pass to Panel.mount(). */
  get element() {
    return this.#el;
  }

  // ── URL bar ─────────────────────────────────────────────────────────────
  #renderUrlBar() {
    const bar = document.createElement("div");
    bar.className = "req-url-bar";

    // Method selector
    const methodLabel = document.createElement("span");
    methodLabel.className = "req-method-select__label";
    methodLabel.textContent = this.#method;

    const methodSel = document.createElement("button");
    methodSel.className = "req-method-select";
    methodSel.setAttribute("aria-label", "HTTP Method");
    methodSel.setAttribute("aria-haspopup", "listbox");
    methodSel.type = "button";
    methodSel.dataset.method = this.#method.toLowerCase();
    // Tooltip names the method when the button shows a glyph instead of text.
    if (document.documentElement.classList.contains("show-method-icons")) {
      methodSel.title = this.#method;
    }
    methodSel.appendChild(methodLabel);
    methodSel.insertAdjacentHTML(
      "beforeend",
      `<svg class="req-method-select__chevron" viewBox="0 0 6 4" fill="currentColor" aria-hidden="true"><path d="M0 0 6 0 3 4Z"/></svg>`,
    );

    let _methodMenu = null;
    let _methodMenuHandler = null;

    const _closeMethodMenu = () => {
      if (!_methodMenu) return;
      _methodMenu.remove();
      _methodMenu = null;
      if (_methodMenuHandler) {
        document.removeEventListener("mousedown", _methodMenuHandler, {
          capture: true,
        });
        _methodMenuHandler = null;
      }
    };

    methodSel.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      if (_methodMenu) {
        _closeMethodMenu();
        return;
      }

      const menu = document.createElement("div");
      menu.className = "req-method-menu";
      menu.setAttribute("role", "listbox");
      menu.setAttribute("aria-label", "HTTP Method");
      menu.addEventListener("mousedown", (ev) => ev.preventDefault());

      const _CHECK = `<svg class="req-method-menu__check-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`;

      HTTP_METHODS.forEach((m) => {
        const item = document.createElement("div");
        item.className = "req-method-menu__item";
        item.setAttribute("role", "option");
        item.setAttribute("aria-selected", String(m === this.#method));
        item.dataset.method = m.toLowerCase();
        // In icon mode the row shows a glyph, so name it via a tooltip.
        if (document.documentElement.classList.contains("show-method-icons"))
          item.title = m;
        if (m === this.#method)
          item.classList.add("req-method-menu__item--selected");
        item.innerHTML = `<span class="req-method-menu__item-check" aria-hidden="true">${_CHECK}</span><span class="req-method-menu__item-label">${m}</span>`;
        item.addEventListener("mousedown", (ev) => {
          ev.preventDefault();
          this.#method = m;
          methodLabel.textContent = m;
          methodSel.dataset.method = m.toLowerCase();
          if (this._sendBtn) this._sendBtn.dataset.method = m.toLowerCase();
          _closeMethodMenu();
          this.#dispatchRequestUpdated();
        });
        menu.appendChild(item);
      });

      const sep = document.createElement("div");
      sep.className = "req-method-menu__separator";
      menu.appendChild(sep);

      const isCustom = !HTTP_METHODS.includes(this.#method);
      const customRow = document.createElement("div");
      customRow.className = "req-method-menu__custom-row";
      customRow.innerHTML = `<span class="req-method-menu__item-check" aria-hidden="true">${_CHECK}</span>`;
      if (isCustom) customRow.classList.add("req-method-menu__item--selected");

      const customInput = document.createElement("input");
      customInput.className = "req-method-menu__custom-input";
      customInput.type = "text";
      // size=1 keeps the input from dictating the menu's max-content width;
      // flex:1 then grows it to fill the width set by the widest method row.
      customInput.size = 1;
      customInput.placeholder = "Custom…";
      customInput.setAttribute("aria-label", "Custom HTTP method");
      if (!HTTP_METHODS.includes(this.#method))
        customInput.value = this.#method;
      customInput.addEventListener("input", () => {
        customInput.value = customInput.value.toUpperCase();
      });
      customInput.addEventListener("mousedown", (ev) => ev.stopPropagation());
      customInput.addEventListener("keydown", (ev) => {
        if (ev.key !== "Enter") return;
        const m = customInput.value.trim().toUpperCase();
        if (!m) return;
        this.#method = m;
        methodLabel.textContent = m;
        methodSel.dataset.method = m.toLowerCase();
        if (document.documentElement.classList.contains("show-method-icons")) {
          methodSel.title = m;
        } else {
          methodSel.removeAttribute("title");
        }
        if (this._sendBtn) this._sendBtn.dataset.method = m.toLowerCase();
        _closeMethodMenu();
        this.#dispatchRequestUpdated();
      });
      customRow.appendChild(customInput);
      menu.appendChild(customRow);

      const r = methodSel.getBoundingClientRect();
      menu.style.cssText = `left:${r.left}px; top:${r.bottom + 4}px;`;
      document.body.appendChild(menu);
      _methodMenu = menu;

      _methodMenuHandler = (ev) => {
        if (
          !menu.contains(ev.target) &&
          ev.target !== methodSel &&
          !methodSel.contains(ev.target)
        ) {
          _closeMethodMenu();
        }
      };
      document.addEventListener("mousedown", _methodMenuHandler, {
        capture: true,
      });
    });

    // URL pill editor — replaces the plain <input type="url">
    const urlEditor = new VariablePillEditor({
      placeholder: "https://api.example.com/endpoint",
      ariaLabel: "Request URL",
      className: "req-url-input",
      getContext: () => this.#variableContext,
      getItems: () => this.#getItems(),
      ensureResponseCaches: (names) => this.#ensureResponseCaches?.(names),
      onInput: (v) => {
        this.#url = v.trim();
        this.#dispatchRequestUpdated();
        this.#updateUrlPreview();
      },
      onEnter: () => this.#sendRequest(),
    });
    this.#urlPillEditor = urlEditor;

    // Send / Cancel button. Whether the collection's cookie jar is attached to
    // each request is governed per-collection via the Collections editor's
    // "Send cookies" checkbox (not a per-request toggle here).
    const sendGroup = document.createElement("div");
    sendGroup.className = "req-send-group";

    const sendBtn = document.createElement("button");
    sendBtn.className = "req-send-btn";
    sendBtn.dataset.method = this.#method.toLowerCase();
    sendBtn.textContent = "Send";
    sendBtn.setAttribute("aria-label", "Send request");
    sendBtn.addEventListener("click", () => {
      if (this.#requestInFlight) {
        window.dispatchEvent(new CustomEvent("wurl:cancel-request"));
      } else {
        this.#sendRequest();
      }
    });

    // Track in-flight state to toggle the button
    window.addEventListener("wurl:request-loading", () => {
      this.#requestInFlight = true;
      sendBtn.textContent = "Stop";
      sendBtn.setAttribute("aria-label", "Stop request");
      sendBtn.classList.add("req-send-btn--cancel");
    });
    const resetSendBtn = () => {
      this.#requestInFlight = false;
      sendBtn.textContent = "Send";
      sendBtn.setAttribute("aria-label", "Send request");
      sendBtn.classList.remove("req-send-btn--cancel");
    };
    window.addEventListener("wurl:response-received", resetSendBtn);
    window.addEventListener("wurl:request-error", resetSendBtn);

    sendGroup.appendChild(sendBtn);

    bar.appendChild(methodSel);
    bar.appendChild(urlEditor.element);
    bar.appendChild(sendGroup);
    this.#el.appendChild(bar);

    this._methodSel = methodSel;
    this._methodSelLabel = methodLabel;
    this._sendBtn = sendBtn;
    // Keep _urlInput as a compatibility shim pointing at the editor's element
    // so any external code that reads _urlInput.focus() still works.
    this._urlInput = urlEditor.element;
  }

  // ── Tab strip ────────────────────────────────────────────────────────────
  #renderTabStrip() {
    const strip = document.createElement("div");
    strip.className = "req-tab-strip";
    strip.setAttribute("role", "tablist");

    TABS.forEach((tab) => {
      const btn = document.createElement("button");
      btn.className = "req-tab-btn";
      btn.textContent = tab.label;
      btn.dataset.tab = tab.id;
      btn.setAttribute("role", "tab");
      btn.setAttribute(
        "aria-selected",
        tab.id === this.#activeTab ? "true" : "false",
      );
      btn.setAttribute("aria-controls", `req-tab-${tab.id}`);
      if (tab.id === this.#activeTab) btn.classList.add("req-tab-btn--active");
      btn.addEventListener("click", () => this.#switchTab(tab.id));
      strip.appendChild(btn);
    });

    this.#el.appendChild(strip);
    this._tabStrip = strip;
  }

  // ── Tab content panels ───────────────────────────────────────────────────
  #renderTabContent() {
    const content = document.createElement("div");
    content.className = "req-tab-content";

    TABS.forEach((tab) => {
      const pane = document.createElement("div");
      pane.className = "req-tab-pane";
      pane.id = `req-tab-${tab.id}`;
      pane.setAttribute("role", "tabpanel");
      pane.hidden = tab.id !== this.#activeTab;
      pane.appendChild(this.#buildTabPane(tab.id));
      content.appendChild(pane);
    });

    this.#el.appendChild(content);
    this._tabContent = content;
  }

  #buildTabPane(tabId) {
    if (tabId === "params") return this.#buildParamsEditor();
    if (tabId === "headers") return this.#buildHeadersEditor();
    if (tabId === "body") return this.#buildBodyEditor();
    if (tabId === "auth") return this.#buildAuthEditor();
    if (tabId === "notes") return this.#buildNotesEditor();
    return document.createElement("div");
  }

  // ── Notes editor ──────────────────────────────────────────────────────────
  #buildNotesEditor() {
    const container = document.createElement("div");
    container.className = "params-editor notes-editor";

    const ta = document.createElement("textarea");
    ta.className = "body-text-editor notes-textarea";
    ta.placeholder = "Add freeform notes about this request…";
    ta.spellcheck = true;
    ta.value = this.#notes;
    ta.setAttribute("aria-label", "Request notes");

    ta.addEventListener("input", () => {
      this.#notes = ta.value;
      this.#dispatchNotesUpdated();
    });

    this.#notesEl = ta;
    container.appendChild(ta);
    return container;
  }

  #dispatchNotesUpdated() {
    if (!this.#currentNodeId) return;
    window.dispatchEvent(
      new CustomEvent("wurl:request-updated", {
        detail: { id: this.#currentNodeId, notes: this.#notes },
        bubbles: true,
      }),
    );
  }

  // ── Auth editor ───────────────────────────────────────────────────────────
  #buildAuthEditor() {
    const container = document.createElement("div");
    container.className = "params-editor";

    // ── Type selector bar ─────────────────────────────────────────────────
    const typeBar = document.createElement("div");
    typeBar.className = "params-toolbar body-type-bar";
    this.#authTypeBarEl = typeBar;

    const typeSelect = document.createElement("select");
    typeSelect.className = "body-type-select";
    typeSelect.id = "auth-type-select";
    typeSelect.setAttribute("aria-label", "Auth type");
    typeSelect.innerHTML = `
      <optgroup label="Auth Types">
        <option value="basic">Basic</option>
        <option value="oauth2">OAuth 2.0</option>
        <option value="aws-iam">AWS IAM</option>
        <option value="bearer">Bearer Token</option>
      </optgroup>
      <optgroup label="Other">
        <option value="none">None</option>
      </optgroup>
    `;
    typeSelect.value = this.#authType;
    typeSelect.addEventListener("change", () => {
      this.#authType = typeSelect.value;
      if (this.#discoverBtnEl)
        this.#discoverBtnEl.hidden = this.#authType !== "oauth2";
      if (this.#authBulkEl)
        this.#authBulkEl.classList.toggle(
          "is-hidden",
          this.#authType === "none",
        );
      if (this.#authEnabledLabelEl)
        this.#authEnabledLabelEl.classList.toggle(
          "is-hidden",
          this.#authType === "none",
        );
      this.#renderAuthContent();
      this.#dispatchAuthUpdated();
    });

    typeBar.appendChild(typeSelect);

    // ── Bulk Editor toggle — shown for all auth types except None ─────────
    const bulkLabel = document.createElement("label");
    bulkLabel.className = "params-toolbar-toggle-label";
    bulkLabel.title = "Toggle bulk text editor";
    const bulkCheck = document.createElement("input");
    bulkCheck.type = "checkbox";
    bulkCheck.className = "params-toolbar-toggle";
    bulkCheck.checked = this.#authBulkMode;
    bulkCheck.addEventListener("change", () => {
      this.#authBulkMode = bulkCheck.checked;
      this.#renderAuthContent();
    });
    bulkLabel.appendChild(bulkCheck);
    bulkLabel.append(" Bulk Editor");
    bulkLabel.classList.toggle("is-hidden", this.#authType === "none");
    this.#authBulkEl = bulkLabel;
    this.#authBulkCheckEl = bulkCheck;
    typeBar.appendChild(bulkLabel);

    // ── Enabled toggle — floated right ────────────────────────────────────
    const spacer = document.createElement("span");
    spacer.style.flex = "1";
    typeBar.appendChild(spacer);

    // ── Discover button — shown only for OAuth 2.0 ────────────────────────
    const discoverBtn = document.createElement("button");
    discoverBtn.type = "button";
    discoverBtn.className = "params-delete-all-btn auth-discover-btn";
    discoverBtn.textContent = "Discover";
    discoverBtn.title =
      "Discover OAuth 2.0 endpoints from an OpenID Connect issuer URL";
    discoverBtn.hidden = this.#authType !== "oauth2";
    this.#discoverBtnEl = discoverBtn;
    discoverBtn.addEventListener("click", () => {
      this.#showIssuerDialog();
    });
    typeBar.appendChild(discoverBtn);

    const enabledLabel = document.createElement("label");
    enabledLabel.className = "params-toolbar-toggle-label";
    enabledLabel.title = "Enable or disable authentication for this request";

    const enabledCheck = document.createElement("input");
    enabledCheck.type = "checkbox";
    enabledCheck.className = "params-toolbar-toggle";
    enabledCheck.id = "auth-enabled-check";
    enabledCheck.checked = this.#authEnabled;
    enabledCheck.addEventListener("change", () => {
      this.#authEnabled = enabledCheck.checked;
      this.#authContentEl?.classList.toggle(
        "auth-content--disabled",
        !this.#authEnabled,
      );
      this.#dispatchAuthUpdated();
    });

    enabledLabel.appendChild(enabledCheck);
    enabledLabel.append(" Enabled");
    enabledLabel.classList.toggle("is-hidden", this.#authType === "none");
    this.#authEnabledLabelEl = enabledLabel;
    typeBar.appendChild(enabledLabel);

    container.appendChild(typeBar);

    // ── Content area ──────────────────────────────────────────────────────
    const content = document.createElement("div");
    content.className = "body-content";
    if (!this.#authEnabled) content.classList.add("auth-content--disabled");
    this.#authContentEl = content;
    container.appendChild(content);

    this.#renderAuthContent();
    return container;
  }

  /** Re-render the auth content area to match #authType / #authBulkMode. */
  #renderAuthContent() {
    const el = this.#authContentEl;
    if (!el) return;
    for (const ed of this.#authPillEditors) ed.destroy?.();
    this.#authPillEditors = [];
    el.innerHTML = "";
    if (this.#authBulkMode && this.#authType !== "none") {
      return this.#renderAuthBulkEditor(el);
    }
    switch (this.#authType) {
      case "none":
        return this.#renderAuthNone(el);
      case "basic":
        return this.#renderAuthBasic(el);
      case "bearer":
        return this.#renderAuthBearer(el);
      case "oauth2":
        return this.#renderAuthOAuth2(el);
      case "aws-iam":
        return this.#renderAuthAwsIam(el);
    }
  }

  // ── Bulk editor ───────────────────────────────────────────────────────────

  /**
   * Return the ordered list of { key, value } pairs for the current auth type,
   * mirroring exactly what the form fields expose (including grant-type-dependent
   * OAuth 2.0 fields and advanced fields when the advanced toggle is on).
   */
  #getAuthFields() {
    switch (this.#authType) {
      case "basic":
        return [
          { key: "username", value: this.#authBasic.username },
          { key: "password", value: this.#authBasic.password },
        ];

      case "bearer":
        return [{ key: "token", value: this.#authBearer.token }];

      case "aws-iam":
        return [
          { key: "accessKeyId", value: this.#authAwsIam.accessKeyId },
          { key: "secretAccessKey", value: this.#authAwsIam.secretAccessKey },
          { key: "region", value: this.#authAwsIam.region },
          { key: "service", value: this.#authAwsIam.service },
          { key: "sessionToken", value: this.#authAwsIam.sessionToken },
        ];

      case "oauth2": {
        const g = this.#authOAuth2.grantType ?? "client_credentials";
        const isPublic =
          g === "authorization_code" &&
          this.#authOAuth2.clientType === "public";
        const fields = [{ key: "grantType", value: g }];

        if (g === "authorization_code") {
          fields.push({
            key: "clientType",
            value: this.#authOAuth2.clientType ?? "confidential",
          });
        }
        fields.push({ key: "clientId", value: this.#authOAuth2.clientId });
        if (g !== "implicit" && !isPublic) {
          fields.push({
            key: "clientSecret",
            value: this.#authOAuth2.clientSecret,
          });
        }
        if (g !== "implicit") {
          fields.push({
            key: "accessTokenUrl",
            value: this.#authOAuth2.accessTokenUrl,
          });
        }
        if (["authorization_code", "implicit"].includes(g)) {
          fields.push({ key: "authUrl", value: this.#authOAuth2.authUrl });
        }
        if (["authorization_code", "implicit"].includes(g)) {
          fields.push({
            key: "redirectUri",
            value: this.#authOAuth2.redirectUri ?? "",
          });
        }
        if (g === "password") {
          fields.push({
            key: "username",
            value: this.#authOAuth2.username ?? "",
          });
          fields.push({
            key: "password",
            value: this.#authOAuth2.password ?? "",
          });
        }
        fields.push({ key: "scope", value: this.#authOAuth2.scope });

        if (this.#oauth2Advanced) {
          if (g === "implicit") {
            fields.push({
              key: "responseType",
              value: this.#authOAuth2.responseType ?? "access_token",
            });
          }
          if (["authorization_code", "implicit"].includes(g)) {
            fields.push({ key: "state", value: this.#authOAuth2.state ?? "" });
          }
          if (
            ["authorization_code", "password", "client_credentials"].includes(g)
          ) {
            fields.push({
              key: "credentials",
              value: this.#authOAuth2.credentials ?? "header",
            });
          }
          fields.push({
            key: "audience",
            value: this.#authOAuth2.audience ?? "",
          });
          if (["authorization_code", "client_credentials"].includes(g)) {
            fields.push({
              key: "resource",
              value: this.#authOAuth2.resource ?? "",
            });
          }
          if (g === "authorization_code") {
            fields.push({
              key: "origin",
              value: this.#authOAuth2.origin ?? "",
            });
          }
          fields.push({
            key: "headerPrefix",
            value: this.#authOAuth2.headerPrefix ?? "",
          });
        }
        return fields;
      }

      default:
        return [];
    }
  }

  /** Render the bulk-edit textarea, pre-populated from the current auth state. */
  #renderAuthBulkEditor(el) {
    const ta = document.createElement("textarea");
    ta.className = "body-text-editor auth-bulk-textarea";
    ta.spellcheck = false;
    ta.value = this.#getAuthFields()
      .map(({ key, value }) => `${key}: ${value}`)
      .join("\n");

    ta.addEventListener("input", () => this.#updateAuthFromText(ta.value));

    el.appendChild(ta);
  }

  /**
   * Parse bulk-editor text and sync values into the auth model.
   * Lines that don't match a known key for the current auth type are silently
   * skipped — the unrecognised text stays in the textarea but has no effect.
   * @param {string} text
   */
  #updateAuthFromText(text) {
    const validKeys = new Set(this.#getAuthFields().map((f) => f.key));
    if (this.#authType === "oauth2") {
      for (const k of OAUTH2_ADVANCED_KEYS) validKeys.add(k);
    }

    for (const raw of text.split("\n")) {
      const colon = raw.indexOf(":");
      if (colon === -1) continue;
      const key = raw.slice(0, colon).trim();
      const value = raw.slice(colon + 1); // preserve leading space the user typed
      const v = value.startsWith(" ") ? value.slice(1) : value.trimStart();

      if (!validKeys.has(key)) continue;

      switch (this.#authType) {
        case "basic":
          if (key === "username") this.#authBasic.username = v;
          if (key === "password") this.#authBasic.password = v;
          break;
        case "bearer":
          if (key === "token") this.#authBearer.token = v;
          break;
        case "aws-iam":
          if (key in this.#authAwsIam) this.#authAwsIam[key] = v;
          break;
        case "oauth2":
          this.#authOAuth2[key] = v;
          break;
      }
    }
    this.#dispatchAuthUpdated();
  }

  // ── None ──────────────────────────────────────────────────────────────────
  #renderAuthNone(el) {
    const msg = document.createElement("div");
    msg.className = "params-empty";
    msg.textContent = "No authentication will be sent with this request.";
    el.appendChild(msg);
  }

  // ── Basic ─────────────────────────────────────────────────────────────────
  #renderAuthBasic(el) {
    const form = document.createElement("div");
    form.className = "auth-form";

    form.appendChild(
      this.#buildAuthPillField("Username", {
        placeholder: "Username",
        value: this.#authBasic.username,
        onInput: (v) => {
          this.#authBasic.username = v;
          this.#dispatchAuthUpdated();
        },
      }),
    );

    form.appendChild(
      this.#buildAuthPillField("Password", {
        placeholder: "Password",
        value: this.#authBasic.password,
        decryptPath: "authBasic.password",
        onInput: (v) => {
          this.#authBasic.password = v;
          this.#dispatchAuthUpdated();
        },
      }),
    );

    el.appendChild(form);
  }

  // ── Bearer Token ──────────────────────────────────────────────────────────
  #renderAuthBearer(el) {
    const form = document.createElement("div");
    form.className = "auth-form";

    form.appendChild(
      this.#buildAuthPillField("Token", {
        placeholder: "Enter your bearer token…",
        value: this.#authBearer.token,
        decryptPath: "authBearer.token",
        onInput: (v) => {
          this.#authBearer.token = v;
          this.#dispatchAuthUpdated();
        },
        hint: "Sent as: Authorization: Bearer <token>",
      }),
    );

    el.appendChild(form);
  }

  // ── OAuth 2.0 ─────────────────────────────────────────────────────────────
  #renderAuthOAuth2(el) {
    const form = document.createElement("div");
    form.className = "auth-form";

    // ── Grant Type ────────────────────────────────────────────────────────
    const allGrantTypes = [
      { value: "authorization_code", label: "Authorization Code" },
      { value: "client_credentials", label: "Client Credentials" },
      { value: "password", label: "Resource Owner Password" },
      { value: "implicit", label: "Implicit" },
    ];
    form.appendChild(
      this.#buildAuthFieldSelect("Grant Type", {
        options: allGrantTypes,
        value: this.#authOAuth2.grantType,
        ariaLabel: "Grant type",
        onInput: (v) => {
          this.#authOAuth2.grantType = v;
          this.#renderAuthContent();
          this.#dispatchAuthUpdated();
        },
      }),
    );

    // ── Client Type (authorization_code only) — between Grant Type and Client ID
    if (this.#authOAuth2.grantType === "authorization_code") {
      // Omit PKCE option if the server explicitly does not support it
      const clientTypeOptions = [
        { value: "confidential", label: "Confidential Client" },
        { value: "public", label: "Public Client (PKCE)" },
      ];
      form.appendChild(
        this.#buildAuthFieldSelect("Client Type", {
          options: clientTypeOptions,
          value: this.#authOAuth2.clientType ?? "confidential",
          ariaLabel: "Client type",
          onInput: (v) => {
            this.#authOAuth2.clientType = v;
            this.#renderAuthContent();
            this.#dispatchAuthUpdated();
          },
        }),
      );
    }

    // ── Client ID (all grant types) ────────────────────────────────────────
    form.appendChild(
      this.#buildAuthPillField("Client ID", {
        placeholder: "Client ID",
        value: this.#authOAuth2.clientId,
        onInput: (v) => {
          this.#authOAuth2.clientId = v;
          this.#dispatchAuthUpdated();
        },
      }),
    );

    // ── Client Secret — hidden for implicit; also hidden when Public Client is selected
    const isPublicClient =
      this.#authOAuth2.grantType === "authorization_code" &&
      this.#authOAuth2.clientType === "public";
    if (this.#authOAuth2.grantType !== "implicit" && !isPublicClient) {
      form.appendChild(
        this.#buildAuthPillField("Client Secret", {
          placeholder: "Client Secret",
          value: this.#authOAuth2.clientSecret,
          decryptPath: "authOAuth2.clientSecret",
          onInput: (v) => {
            this.#authOAuth2.clientSecret = v;
            this.#dispatchAuthUpdated();
          },
        }),
      );
    }

    // ── Access Token URL (not shown for implicit) ──────────────────────────
    if (this.#authOAuth2.grantType !== "implicit") {
      form.appendChild(
        this.#buildAuthPillField("Access Token URL", {
          placeholder: "https://example.com/oauth/token",
          value: this.#authOAuth2.accessTokenUrl,
          onInput: (v) => {
            this.#authOAuth2.accessTokenUrl = v;
            this.#dispatchAuthUpdated();
          },
        }),
      );
    }

    // ── Auth URL (authorization_code and implicit only) ────────────────────
    if (
      ["authorization_code", "implicit"].includes(this.#authOAuth2.grantType)
    ) {
      form.appendChild(
        this.#buildAuthPillField("Auth URL", {
          placeholder: "https://example.com/oauth/authorize",
          value: this.#authOAuth2.authUrl,
          onInput: (v) => {
            this.#authOAuth2.authUrl = v;
            this.#dispatchAuthUpdated();
          },
        }),
      );
    }

    // ── Redirect URI (authorization_code and implicit only) ───────────────
    if (
      ["authorization_code", "implicit"].includes(this.#authOAuth2.grantType)
    ) {
      form.appendChild(
        this.#buildAuthPillField("Redirect URI", {
          placeholder: "http://localhost:7777/oauth/callback",
          value: this.#authOAuth2.redirectUri ?? "",
          onInput: (v) => {
            this.#authOAuth2.redirectUri = v;
            this.#dispatchAuthUpdated();
          },
          hint: "Callback URL registered with your OAuth provider (intercepted by wurl)",
        }),
      );
    }

    // ── Username / Password (resource owner password only) ─────────────────
    if (this.#authOAuth2.grantType === "password") {
      form.appendChild(
        this.#buildAuthPillField("Username", {
          placeholder: "Username",
          value: this.#authOAuth2.username ?? "",
          decryptPath: "authOAuth2.username",
          onInput: (v) => {
            this.#authOAuth2.username = v;
            this.#dispatchAuthUpdated();
          },
        }),
      );
      form.appendChild(
        this.#buildAuthPillField("Password", {
          placeholder: "Password",
          value: this.#authOAuth2.password ?? "",
          decryptPath: "authOAuth2.password",
          onInput: (v) => {
            this.#authOAuth2.password = v;
            this.#dispatchAuthUpdated();
          },
        }),
      );
    }

    // ── Scope (combo-box with suggestions) ────────────────────────────────
    form.appendChild(
      this.#buildAuthScopeField({
        value: this.#authOAuth2.scope,
        onInput: (v) => {
          this.#authOAuth2.scope = v;
          this.#dispatchAuthUpdated();
        },
        scopeList: this.#authOAuth2.discoveredScopes ?? DEFAULT_SCOPES,
      }),
    );

    // ── Advanced toggle (matches every other app toggle) ──────────────────────
    const advRow = document.createElement("div");
    advRow.className = "auth-field--advanced-toggle";

    const advLabel = document.createElement("label");
    advLabel.className = "params-toolbar-toggle-label";

    const advCheck = document.createElement("input");
    advCheck.type = "checkbox";
    advCheck.id = "oauth2-advanced-toggle";
    advCheck.className = "params-toolbar-toggle";
    advCheck.checked = this.#oauth2Advanced;
    advCheck.setAttribute("aria-label", "Show advanced OAuth 2.0 options");
    advCheck.addEventListener("change", () => {
      this.#oauth2Advanced = advCheck.checked;
      this.#renderAuthContent();
    });

    advLabel.appendChild(advCheck);
    advLabel.append(" Advanced");
    advRow.appendChild(advLabel);
    form.appendChild(advRow);

    // ── Advanced fields (only when toggle is on) ───────────────────────────
    if (this.#oauth2Advanced) {
      const grant = this.#authOAuth2.grantType;

      // Response Type — implicit only
      if (grant === "implicit") {
        form.appendChild(
          this.#buildAuthFieldSelect("Response Type", {
            options: [
              { value: "access_token", label: "Access token" },
              { value: "id_token", label: "Id token" },
              { value: "both", label: "Both" },
            ],
            value: this.#authOAuth2.responseType ?? "access_token",
            ariaLabel: "Response type",
            onInput: (v) => {
              this.#authOAuth2.responseType = v;
              this.#dispatchAuthUpdated();
            },
          }),
        );
      }

      // State — authorization_code, implicit
      if (["authorization_code", "implicit"].includes(grant)) {
        form.appendChild(
          this.#buildAuthPillField("State", {
            placeholder: "Random string for CSRF protection",
            value: this.#authOAuth2.state ?? "",
            onInput: (v) => {
              this.#authOAuth2.state = v;
              this.#dispatchAuthUpdated();
            },
          }),
        );
      }

      // Credentials — authorization_code, password, client_credentials
      if (
        ["authorization_code", "password", "client_credentials"].includes(grant)
      ) {
        form.appendChild(
          this.#buildAuthFieldSelect("Credentials", {
            options: [
              { value: "header", label: "As basic auth header" },
              { value: "body", label: "In request body" },
            ],
            value: this.#authOAuth2.credentials ?? "header",
            ariaLabel: "Credentials transmission method",
            onInput: (v) => {
              this.#authOAuth2.credentials = v;
              this.#dispatchAuthUpdated();
            },
          }),
        );
      }

      // Audience — all grant types
      form.appendChild(
        this.#buildAuthPillField("Audience", {
          placeholder: "https://api.example.com",
          value: this.#authOAuth2.audience ?? "",
          onInput: (v) => {
            this.#authOAuth2.audience = v;
            this.#dispatchAuthUpdated();
          },
        }),
      );

      // Resource — authorization_code, client_credentials
      if (["authorization_code", "client_credentials"].includes(grant)) {
        form.appendChild(
          this.#buildAuthPillField("Resource", {
            placeholder: "https://resource.example.com",
            value: this.#authOAuth2.resource ?? "",
            onInput: (v) => {
              this.#authOAuth2.resource = v;
              this.#dispatchAuthUpdated();
            },
          }),
        );
      }

      // Origin — authorization_code only
      if (grant === "authorization_code") {
        form.appendChild(
          this.#buildAuthPillField("Origin", {
            placeholder: "https://app.example.com",
            value: this.#authOAuth2.origin ?? "",
            onInput: (v) => {
              this.#authOAuth2.origin = v;
              this.#dispatchAuthUpdated();
            },
          }),
        );
      }

      // Header Prefix — all grant types, kept last so its hint text sits at the bottom
      form.appendChild(
        this.#buildAuthPillField("Header Prefix", {
          placeholder: "Bearer",
          value: this.#authOAuth2.headerPrefix ?? "",
          onInput: (v) => {
            this.#authOAuth2.headerPrefix = v;
            this.#dispatchAuthUpdated();
          },
          hint: "Overrides the default 'Bearer' token prefix in the Authorization header",
        }),
      );
    }

    // ── Current access token display ───────────────────────────────────────
    if (this.#authOAuth2.token) {
      const tokenSection = document.createElement("div");
      tokenSection.className = "auth-section-title";
      tokenSection.textContent = "Current Access Token";
      form.appendChild(tokenSection);

      const tokenDisplay = document.createElement("div");
      tokenDisplay.className = "auth-token-display";
      const tokenValue = document.createElement("span");
      tokenValue.className = "auth-token-value";
      tokenValue.textContent = this.#authOAuth2.token;

      // ── Button column: Clear Token + Clear Session stacked ─────────────
      const tokenBtnGroup = document.createElement("div");
      tokenBtnGroup.className = "auth-token-btn-group";

      const clearBtn = document.createElement("button");
      clearBtn.type = "button";
      clearBtn.className = "body-file-reset-btn";
      clearBtn.textContent = "Clear Token";
      clearBtn.addEventListener("click", () => {
        this.#authOAuth2.token = "";
        this.#authOAuth2.refreshToken = "";
        this.#authOAuth2.expiresAt = null;
        // Also clear from executor cache
        oauthExecutor.clearToken(this.#authOAuth2);
        this.#renderAuthContent();
        this.#dispatchAuthUpdated();
      });

      const clearSessionBtn = document.createElement("button");
      clearSessionBtn.type = "button";
      clearSessionBtn.className = "body-file-reset-btn";
      clearSessionBtn.textContent = "Clear Session";
      clearSessionBtn.title =
        "Clear stored token and — in Electron — erase all session cookies and browser storage " +
        "so the next login flow starts fresh.";
      clearSessionBtn.addEventListener("click", async () => {
        // Clear token state and executor cache
        this.#authOAuth2.token = "";
        this.#authOAuth2.refreshToken = "";
        this.#authOAuth2.expiresAt = null;
        oauthExecutor.clearToken(this.#authOAuth2);

        // Clear Electron session (cookies, localStorage, cache, …)
        if (typeof window.wurl?.oauth?.clearSession === "function") {
          clearSessionBtn.disabled = true;
          clearSessionBtn.textContent = "Clearing…";
          try {
            await window.wurl.oauth.clearSession();
          } catch (err) {
            console.warn("[oauth] clearSession failed:", err.message);
          }
        }

        if (!this.#authContentEl?.contains(clearSessionBtn)) return;
        this.#renderAuthContent();
        this.#dispatchAuthUpdated();
      });

      tokenBtnGroup.appendChild(clearBtn);
      tokenBtnGroup.appendChild(clearSessionBtn);

      tokenDisplay.appendChild(tokenValue);
      tokenDisplay.appendChild(tokenBtnGroup);
      form.appendChild(tokenDisplay);

      // Expiry info (if available)
      if (this.#authOAuth2.expiresAt) {
        const expiryEl = document.createElement("div");
        expiryEl.className = "auth-field__hint";
        const remaining = Math.max(
          0,
          Math.floor((this.#authOAuth2.expiresAt - Date.now()) / 1000),
        );
        if (remaining > 0) {
          expiryEl.textContent = `Expires in ~${remaining}s`;
        } else {
          expiryEl.textContent = "⚠ Token may be expired";
          expiryEl.style.color = "var(--color-error, #f38ba8)";
        }
        form.appendChild(expiryEl);
      }
    }

    // ── Get Token button ───────────────────────────────────────────────────
    const getTokenRow = document.createElement("div");
    getTokenRow.className = "auth-get-token-row";

    const getTokenBtn = document.createElement("button");
    getTokenBtn.type = "button";
    getTokenBtn.className = "params-delete-all-btn auth-get-token-btn";
    getTokenBtn.textContent = this.#authOAuth2.token
      ? "Refresh Token"
      : "Get Token";
    getTokenBtn.title =
      "Acquire an OAuth 2.0 access token using the configured settings";

    const tokenStatusEl = document.createElement("span");
    tokenStatusEl.className = "auth-token-status";

    getTokenBtn.addEventListener("click", async () => {
      const tokenNodeId = this.#currentNodeId;
      getTokenBtn.disabled = true;
      getTokenBtn.textContent = "Fetching…";
      tokenStatusEl.textContent = "";
      tokenStatusEl.className = "auth-token-status";

      try {
        const result = await oauthExecutor.forceRefresh({
          ...this.#authOAuth2,
        });
        if (this.#currentNodeId !== tokenNodeId) return;

        if (result.success && result.accessToken) {
          this.#authOAuth2.token = result.accessToken;
          this.#authOAuth2.refreshToken = result.refreshToken ?? "";
          this.#authOAuth2.expiresAt = result.expiresAt ?? null;
          tokenStatusEl.textContent = "✓ Token acquired";
          tokenStatusEl.className = "auth-token-status auth-token-status--ok";
        } else {
          const msg =
            result.error?.description ?? result.error?.code ?? "Unknown error";
          tokenStatusEl.textContent = `✗ ${msg}`;
          tokenStatusEl.className =
            "auth-token-status auth-token-status--error";
        }
      } catch (err) {
        tokenStatusEl.textContent = `✗ ${err.message}`;
        tokenStatusEl.className = "auth-token-status auth-token-status--error";
      } finally {
        getTokenBtn.disabled = false;
        getTokenBtn.textContent = this.#authOAuth2.token
          ? "Refresh Token"
          : "Get Token";
      }

      this.#renderAuthContent();
      this.#dispatchAuthUpdated();
    });

    getTokenRow.appendChild(getTokenBtn);
    getTokenRow.appendChild(tokenStatusEl);
    form.appendChild(getTokenRow);

    el.appendChild(form);
  }

  // ── AWS IAM ───────────────────────────────────────────────────────────────
  #renderAuthAwsIam(el) {
    const form = document.createElement("div");
    form.className = "auth-form";

    form.appendChild(
      this.#buildAuthPillField("Access Key ID", {
        placeholder: "AKIAIOSFODNN7EXAMPLE",
        value: this.#authAwsIam.accessKeyId,
        decryptPath: "authAwsIam.accessKeyId",
        onInput: (v) => {
          this.#authAwsIam.accessKeyId = v;
          this.#dispatchAuthUpdated();
        },
      }),
    );

    form.appendChild(
      this.#buildAuthPillField("Secret Access Key", {
        placeholder: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        value: this.#authAwsIam.secretAccessKey,
        decryptPath: "authAwsIam.secretAccessKey",
        onInput: (v) => {
          this.#authAwsIam.secretAccessKey = v;
          this.#dispatchAuthUpdated();
        },
      }),
    );

    form.appendChild(
      this.#buildAuthPillField("Region", {
        placeholder: "us-east-1",
        value: this.#authAwsIam.region,
        onInput: (v) => {
          this.#authAwsIam.region = v;
          this.#dispatchAuthUpdated();
        },
      }),
    );

    form.appendChild(
      this.#buildAuthPillField("Service", {
        placeholder: "execute-api",
        value: this.#authAwsIam.service,
        onInput: (v) => {
          this.#authAwsIam.service = v;
          this.#dispatchAuthUpdated();
        },
      }),
    );

    form.appendChild(
      this.#buildAuthPillField("Session Token", {
        placeholder: "Optional — for temporary / STS credentials",
        value: this.#authAwsIam.sessionToken,
        decryptPath: "authAwsIam.sessionToken",
        onInput: (v) => {
          this.#authAwsIam.sessionToken = v;
          this.#dispatchAuthUpdated();
        },
      }),
    );

    el.appendChild(form);
  }

  // ── Auth field helpers ─────────────────────────────────────────────────────
  /**
   * Build a standard labeled input row for use inside an auth-form.
   * @param {string} label
   * @param {string} inputType  e.g. "text" | "url"
   * @param {{ placeholder?, value?, onInput?, hint? }} opts
   */
  #buildAuthField(
    label,
    inputType,
    { placeholder = "", value = "", onInput, hint } = {},
  ) {
    const wrapper = document.createElement("div");
    wrapper.className = "auth-field";

    const lbl = document.createElement("label");
    lbl.className = "auth-field__label";
    lbl.textContent = label;

    const input = document.createElement("input");
    input.type = inputType;
    input.className = "auth-field__input";
    input.placeholder = placeholder;
    input.value = value;
    // Generate a descriptive name so password managers don't mistake these for
    // login credentials.  The "wurl-auth-" prefix makes the purpose unambiguous.
    input.name = `wurl-auth-${label.toLowerCase().replace(/\s+/g, "-")}`;
    input.setAttribute("autocomplete", "off");
    input.setAttribute("aria-label", label);
    if (onInput) input.addEventListener("input", () => onInput(input.value));

    wrapper.appendChild(lbl);
    wrapper.appendChild(input);

    if (hint) {
      const hintEl = document.createElement("span");
      hintEl.className = "auth-field__hint";
      hintEl.textContent = hint;
      wrapper.appendChild(hintEl);
    }

    return wrapper;
  }

  /**
   * Build a labeled auth field whose value is a VariablePillEditor so the user
   * can reference environment variables and functions inline.
   * @param {string} label
   * @param {{ placeholder?, value?, onInput?, hint? }} opts
   */
  #buildAuthPillField(
    label,
    { placeholder = "", value = "", onInput, hint, decryptPath } = {},
  ) {
    const wrapper = document.createElement("div");
    wrapper.className = "auth-field";

    const failedDecrypt = decryptPath && this.#decryptErrors.has(decryptPath);
    if (failedDecrypt) wrapper.classList.add("auth-field--decrypt-error");

    const lbl = document.createElement("label");
    lbl.className = "auth-field__label";
    lbl.textContent = label;

    const editor = new VariablePillEditor({
      placeholder,
      ariaLabel: label,
      className: "auth-field__input",
      getContext: () => this.#variableContext,
      getItems: () => this.#getItems(),
      ensureResponseCaches: (names) => this.#ensureResponseCaches?.(names),
      onInput: onInput ?? (() => {}),
    });
    editor.setValue(value ?? "");
    this.#authPillEditors.push(editor);

    wrapper.appendChild(lbl);
    wrapper.appendChild(editor.element);

    if (hint) {
      const hintEl = document.createElement("span");
      hintEl.className = "auth-field__hint";
      hintEl.textContent = hint;
      wrapper.appendChild(hintEl);
    }

    if (failedDecrypt) {
      const warnEl = document.createElement("span");
      warnEl.className = "auth-field__decrypt-warning";
      warnEl.textContent =
        "Couldn't decrypt — re-enter this value to restore it.";
      wrapper.appendChild(warnEl);
    }

    return wrapper;
  }

  /**
   * Build a labeled password input with a show/hide toggle button.
   * @param {string} label
   * @param {{ placeholder?, value?, onInput? }} opts
   */
  #buildAuthFieldPassword(
    label,
    { placeholder = "", value = "", onInput } = {},
  ) {
    const wrapper = document.createElement("div");
    wrapper.className = "auth-field";

    const lbl = document.createElement("label");
    lbl.className = "auth-field__label";
    lbl.textContent = label;

    const inputWrap = document.createElement("div");
    inputWrap.className = "auth-pwd-wrapper";

    const input = document.createElement("input");
    input.type = "password";
    input.className = "auth-field__input";
    input.placeholder = placeholder;
    input.value = value;
    // Descriptive name prevents password managers from treating this as a login
    // credential field.  "new-password" is the only autocomplete value Chrome
    // reliably respects to suppress the save-credentials popup for non-login fields.
    input.name = `wurl-auth-${label.toLowerCase().replace(/\s+/g, "-")}`;
    input.setAttribute("autocomplete", "new-password");
    input.setAttribute("aria-label", label);
    if (onInput) input.addEventListener("input", () => onInput(input.value));

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "auth-pwd-toggle";
    toggle.textContent = "Show";
    toggle.title = "Toggle visibility";
    toggle.addEventListener("click", () => {
      const hidden = input.type === "password";
      input.type = hidden ? "text" : "password";
      toggle.textContent = hidden ? "Hide" : "Show";
    });

    inputWrap.appendChild(input);
    inputWrap.appendChild(toggle);
    wrapper.appendChild(lbl);
    wrapper.appendChild(inputWrap);

    return wrapper;
  }

  /**
   * Build the Scope field: a free-text input with a suggestive dropdown.
   * - On focus / input: shows matching scopes from scopeList (OIDC-discovered or
   *   DEFAULT_SCOPES fallback) not already present in the value.
   * - Typing a space re-opens the dropdown so the user can pick the next scope.
   * - Arrow keys navigate, Enter / click selects, Escape dismisses.
   * - The user can always type freely; the dropdown is advisory only.
   *
   * @param {{ value?: string, onInput?: (v:string)=>void, scopeList?: string[] }} opts
   */
  #buildAuthScopeField({
    value = "",
    onInput,
    scopeList = DEFAULT_SCOPES,
  } = {}) {
    const wrapper = document.createElement("div");
    wrapper.className = "auth-field";

    const lbl = document.createElement("label");
    lbl.className = "auth-field__label";
    lbl.textContent = "Scope";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "auth-field__input";
    input.placeholder = "openid email profile";
    input.value = value;
    input.name = "wurl-auth-scope";
    input.setAttribute("autocomplete", "off");
    input.setAttribute("aria-label", "Scope");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-haspopup", "listbox");

    // Called when a suggestion is picked — replaces the current partial word
    // with the selected scope and appends a trailing space for the next token.
    const onSelect = (picked, _currentWord) => {
      const full = input.value;
      const lastSpace = full.lastIndexOf(" ");
      const prefix = lastSpace === -1 ? "" : full.slice(0, lastSpace + 1);
      input.value = `${prefix}${picked} `;
      onInput?.(input.value.trim());
      // Re-open immediately so the user can pick another scope
      _showScopeDropdown(input, onSelect, scopeList);
    };

    input.addEventListener("focus", () =>
      _showScopeDropdown(input, onSelect, scopeList),
    );

    input.addEventListener("input", () => {
      onInput?.(input.value.trim());
      _showScopeDropdown(input, onSelect, scopeList);
    });

    input.addEventListener("blur", () => {
      _scopeBlurTimer = setTimeout(_hideScopeDropdown, 150);
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        _scopeDropdownNavigate(+1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        _scopeDropdownNavigate(-1);
        return;
      }
      if (e.key === "Escape") {
        _hideScopeDropdown();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        _scopeDropdownAccept(input, onSelect);
      }
    });

    const hint = document.createElement("span");
    hint.className = "auth-field__hint";
    hint.textContent =
      "Space-separated list of requested scopes — type or pick from the list";

    wrapper.appendChild(lbl);
    wrapper.appendChild(input);
    wrapper.appendChild(hint);
    return wrapper;
  }

  /**
   * Build a labeled <select> row for use inside an auth-form.
   * @param {string} label
   * @param {{ options: {value:string,label:string}[], value?, ariaLabel?, onInput? }} opts
   */
  #buildAuthFieldSelect(
    label,
    { options = [], value = "", ariaLabel, onInput } = {},
  ) {
    const wrapper = document.createElement("div");
    wrapper.className = "auth-field";

    const lbl = document.createElement("label");
    lbl.className = "auth-field__label";
    lbl.textContent = label;

    const sel = document.createElement("select");
    sel.className = "auth-field__input auth-field__select";
    if (ariaLabel) sel.setAttribute("aria-label", ariaLabel);
    options.forEach(({ value: v, label: l }) => {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = l;
      sel.appendChild(opt);
    });
    sel.value = value;
    if (onInput) sel.addEventListener("change", () => onInput(sel.value));

    wrapper.appendChild(lbl);
    wrapper.appendChild(sel);
    return wrapper;
  }

  #dispatchAuthUpdated() {
    if (!this.#currentNodeId) return;
    // Exclude runtime-only token fields — acquired tokens must not be persisted.
    const {
      token: _t,
      refreshToken: _rt,
      expiresAt: _ea,
      ...oauth2Persisted
    } = this.#authOAuth2;
    window.dispatchEvent(
      new CustomEvent("wurl:request-updated", {
        detail: {
          id: this.#currentNodeId,
          authEnabled: this.#authEnabled,
          authType: this.#authType,
          authBasic: { ...this.#authBasic },
          authBearer: { ...this.#authBearer },
          authOAuth2: oauth2Persisted,
          authAwsIam: { ...this.#authAwsIam },
        },
        bubbles: true,
      }),
    );
  }

  // ── Issuer URL dialog ─────────────────────────────────────────────────────
  /**
   * Show a dialog that prompts the user for an OpenID Connect issuer URL.
   * Fetches the well-known discovery document inline and displays any error
   * inside the dialog so the user can correct the URL and try again.
   *
   * Dismiss paths:
   *   • Escape key, clicking outside (mask), ✕ button, or Cancel → close with no action
   *   • Enter key or "Discover" button → fetch; on success apply config; on failure show inline error
   */
  #showIssuerDialog() {
    const dlg = document.createElement("div");
    dlg.className = "popup popup-discover-issuer";
    dlg.setAttribute("role", "dialog");
    dlg.setAttribute("aria-modal", "true");
    dlg.setAttribute("aria-label", "Discover OpenID Configuration");

    dlg.innerHTML = `
      <div class="popup-header">
        <span class="popup-title">Discover OpenID Configuration</span>
        <button class="popup-close" aria-label="Close" data-action="close" title="Close"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button>
      </div>
      <div class="popup-body discover-dialog-body">
        <p class="discover-dialog-desc">
          Enter the issuer URL to fetch the OpenID Connect discovery document
          (<code>.well-known/openid-configuration</code>). Supported endpoints,
          grant types, PKCE support, and available scopes will be applied automatically.
        </p>
        <label class="discover-dialog-label" for="discover-issuer-input">Issuer URL</label>
        <input
          id="discover-issuer-input"
          type="url"
          class="discover-dialog-input"
          placeholder="https://login.example.com"
          autocomplete="off"
          spellcheck="false"
          aria-label="Issuer URL"
          value="${(this.#authOAuth2.discoveredIssuer ?? "").replace(/"/g, "&quot;")}"
        />
        <p class="discover-dialog-error" aria-live="polite" hidden></p>
      </div>
      <div class="popup-footer">
        <button class="popup-btn popup-btn--secondary" data-action="cancel">Cancel</button>
        <button class="popup-btn popup-btn--primary"   data-action="discover">Discover</button>
      </div>
    `;

    const urlInput = dlg.querySelector("#discover-issuer-input");
    const errorEl = dlg.querySelector(".discover-dialog-error");
    const discoverEl = dlg.querySelector("[data-action='discover']");

    const dismiss = () => {
      document.removeEventListener("keydown", onDocKey);
      PopupManager.close();
    };

    const escHtml = (s) =>
      String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    const showError = (msg) => {
      errorEl.innerHTML = msg;
      errorEl.hidden = false;
      discoverEl.disabled = false;
      discoverEl.textContent = "Discover";
      urlInput.focus();
    };

    const doDiscover = async () => {
      const raw = urlInput.value.trim();
      if (!raw) {
        showError("Please enter an issuer URL.");
        return;
      }

      // Capture which request started the discovery — used to guard
      // against applying results to a different request if the user
      // switched selections while the fetch was in flight.
      const targetNodeId = this.#currentNodeId;

      errorEl.hidden = true;
      discoverEl.disabled = true;
      discoverEl.textContent = "Fetching…";

      const base = raw.replace(/\/+$/, "");
      const discoveryUrl = `${base}/.well-known/openid-configuration`;

      let config;
      try {
        config = await _fetchJson(discoveryUrl);
      } catch (err) {
        showError(
          `Could not fetch <code>${escHtml(discoveryUrl)}</code><br>${escHtml(err.message)}`,
        );
        // Clear any previously stored discovery data so stale scopes/issuer
        // from a prior successful lookup don't linger after a failed re-discover.
        if (this.#currentNodeId === targetNodeId) {
          this.#authOAuth2.discoveredIssuer = "";
          this.#authOAuth2.discoveredScopes = null;
          this.#renderAuthContent();
          this.#dispatchAuthUpdated();
        }
        return;
      }

      dismiss();
      this.#applyOidcDiscovery(base, config, targetNodeId);
    };

    function onDocKey(e) {
      if (e.key === "Escape") {
        e.preventDefault();
        dismiss();
      }
    }
    document.addEventListener("keydown", onDocKey);

    dlg
      .querySelector("[data-action='close']")
      .addEventListener("click", dismiss);
    dlg
      .querySelector("[data-action='cancel']")
      .addEventListener("click", dismiss);
    discoverEl.addEventListener("click", doDiscover);

    urlInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        doDiscover();
      }
    });

    PopupManager.open({
      element: dlg,
      onMaskClick: dismiss,
    });

    // Focus the input and place cursor at end
    requestAnimationFrame(() => {
      urlInput.focus();
      urlInput.setSelectionRange(urlInput.value.length, urlInput.value.length);
    });
  }

  // ── OIDC Discovery ────────────────────────────────────────────────────────
  /**
   * Apply a pre-fetched OpenID Connect discovery document directly to the
   * auth form fields.  Nothing is persisted beyond the normal field values
   * (authUrl, accessTokenUrl, grantType, clientType) that are already saved
   * as part of the request.
   *
   * The `targetNodeId` guard ensures results are only applied if the user
   * hasn't switched to a different request while the fetch was in flight.
   *
   * @param {string} _issuerBase   The normalised issuer URL
   * @param {object} config        The parsed discovery document
   * @param {string} targetNodeId  The node ID that initiated the discovery
   */
  #applyOidcDiscovery(_issuerBase, config, targetNodeId) {
    // Guard: if the user switched to a different request during the async
    // fetch, do not apply the results to the now-active request.
    if (this.#currentNodeId !== targetNodeId) return;

    // ── Remember the issuer URL so the dialog pre-fills next time ──────────
    this.#authOAuth2.discoveredIssuer = _issuerBase;

    // ── Scopes — replace autocomplete suggestions with discovered list ─────
    this.#authOAuth2.discoveredScopes =
      Array.isArray(config.scopes_supported) &&
      config.scopes_supported.length > 0
        ? config.scopes_supported
        : null;

    // ── Endpoints ──────────────────────────────────────────────────────────
    if (config.authorization_endpoint) {
      this.#authOAuth2.authUrl = config.authorization_endpoint;
    }
    if (config.token_endpoint) {
      this.#authOAuth2.accessTokenUrl = config.token_endpoint;
    }

    // ── Grant type — switch away from unsupported types ────────────────────
    const ALL_GRANT_VALUES = [
      "authorization_code",
      "client_credentials",
      "password",
      "implicit",
    ];
    if (
      Array.isArray(config.grant_types_supported) &&
      config.grant_types_supported.length > 0
    ) {
      const serverSupported = new Set(config.grant_types_supported);
      if (!serverSupported.has(this.#authOAuth2.grantType)) {
        const first = ALL_GRANT_VALUES.find((g) => serverSupported.has(g));
        if (first) this.#authOAuth2.grantType = first;
      }
    }

    // ── PKCE — revert to confidential if server doesn't support it ─────────
    const pkceOk =
      Array.isArray(config.code_challenge_methods_supported) &&
      config.code_challenge_methods_supported.length > 0;
    if (!pkceOk && this.#authOAuth2.clientType === "public") {
      this.#authOAuth2.clientType = "confidential";
    }

    // ── Re-render and save ─────────────────────────────────────────────────
    this.#renderAuthContent();
    this.#dispatchAuthUpdated();
  }

  // ── Body editor ──────────────────────────────────────────────────────────
  #buildBodyEditor() {
    const container = document.createElement("div");
    container.className = "params-editor";

    // ── Type selector bar (also hosts the Prettify button when relevant) ──
    const typeBar = document.createElement("div");
    typeBar.className = "params-toolbar body-type-bar";
    this.#bodyTypeBarEl = typeBar;

    const typeSelect = document.createElement("select");
    typeSelect.className = "body-type-select";
    typeSelect.id = "body-type-select";
    typeSelect.setAttribute("aria-label", "Body type");
    typeSelect.innerHTML = `
      <optgroup label="Structured">
        <option value="form-data">Form Data</option>
        <option value="form-urlencoded">Form URL Encoded</option>
      </optgroup>
      <optgroup label="Text">
        <option value="json">JSON</option>
        <option value="yaml">YAML</option>
        <option value="xml">XML</option>
        <option value="text">Plain Text</option>
      </optgroup>
      <optgroup label="Other">
        <option value="file">File</option>
        <option value="no-body" selected>No Body</option>
      </optgroup>
    `;
    typeSelect.value = this.#bodyType;
    typeSelect.addEventListener("change", () => {
      this.#bodyType = typeSelect.value;
      this.#renderBodyContent();
      this.#dispatchBodyUpdated();
    });

    typeBar.appendChild(typeSelect);

    // ── Form toolbar (Bulk Editor toggle + Add + Delete All) ─────────────
    // Appended to typeBar; shown only when body type is form-data or form-urlencoded
    const formToolbarGroup = document.createElement("span");
    formToolbarGroup.className = "body-form-toolbar-group is-hidden";
    this.#bodyFormToolbarGroupEl = formToolbarGroup;

    const bfBulkLabel = document.createElement("label");
    bfBulkLabel.className = "params-toolbar-toggle-label";
    bfBulkLabel.title =
      "Toggle between bulk text editor and key/value row editor";
    const bfBulkCheck = document.createElement("input");
    bfBulkCheck.type = "checkbox";
    bfBulkCheck.className = "params-toolbar-toggle";
    bfBulkCheck.checked = this.#bodyFormBulkMode;
    bfBulkCheck.addEventListener("change", () =>
      this.#handleBodyFormBulkToggle(bfBulkCheck.checked),
    );
    bfBulkLabel.appendChild(bfBulkCheck);
    bfBulkLabel.append(" Bulk Editor");
    this.#bodyFormBulkCheckEl = bfBulkCheck;

    const addBtn = document.createElement("button");
    addBtn.className = "icon-btn params-toolbar-btn";
    addBtn.title = "Add field";
    addBtn.setAttribute("aria-label", "Add field");
    addBtn.innerHTML = `<span class="icon">＋</span>`;
    addBtn.addEventListener("click", () => {
      this.#bodyFormRows.push({
        id: crypto.randomUUID(),
        name: "",
        value: "",
        enabled: true,
      });
      this.#renderBodyContent();
      this.#dispatchBodyUpdated();
    });

    const delAllBtn = document.createElement("button");
    delAllBtn.className =
      "params-toolbar-btn params-toolbar-btn--danger params-delete-all-btn";
    delAllBtn.title = "Delete all fields";
    delAllBtn.textContent = "Delete All";

    this._bodyFormDeleteAllCleanup = this.#wireDeleteAllConfirm(
      delAllBtn,
      () => this.#bodyFormRows.length,
      () => {
        this.#bodyFormRows = [];
        this.#renderBodyContent();
        this.#dispatchBodyUpdated();
      },
    );

    this.#bodyFormAddBtnEl = addBtn;
    this.#bodyFormDelAllBtnEl = delAllBtn;

    formToolbarGroup.appendChild(bfBulkLabel);
    formToolbarGroup.appendChild(addBtn);
    formToolbarGroup.appendChild(delAllBtn);
    typeBar.appendChild(formToolbarGroup);

    container.appendChild(typeBar);

    // ── Content area ─────────────────────────────────────────────────────
    const content = document.createElement("div");
    content.className = "body-content";
    this.#bodyContentEl = content;
    container.appendChild(content);

    this.#renderBodyContent();
    return container;
  }

  /** Render the body content area to match the current #bodyType. */
  #renderBodyContent() {
    const el = this.#bodyContentEl;
    if (!el) return;
    el.innerHTML = "";
    // Tear down stale pill editors before discarding their references — each
    // attaches a document-level selectionchange listener that would otherwise
    // outlive the DOM and accumulate on every re-render.
    for (const ed of this.#bodyFormPillEditors) ed.destroy?.();
    this.#bodyFormPillEditors = [];
    // Remove any Prettify button / validation badge left over from a previous text type
    this.#bodyTypeBarEl?.querySelector(".body-prettify-btn")?.remove();
    this.#bodyTypeBarEl?.querySelector(".body-validate-badge")?.remove();
    // Reset body form drag state whenever we switch panels
    this.#bfListEl = this.#bfPhantom = null;
    this.#bfDragSrcId = null;
    // Cancel any in-progress delete-all confirm before the UI is rebuilt
    this._bodyFormDeleteAllCleanup?.();
    // Show / hide the form toolbar based on body type
    const isFormType =
      this.#bodyType === "form-data" || this.#bodyType === "form-urlencoded";
    if (this.#bodyFormToolbarGroupEl) {
      this.#bodyFormToolbarGroupEl.classList.toggle("is-hidden", !isFormType);
      if (isFormType && this.#bodyFormBulkCheckEl) {
        this.#bodyFormBulkCheckEl.checked = this.#bodyFormBulkMode;
      }
    }
    // Reset body form bulk refs (will be reassigned by #renderBodyForm if applicable)
    this.#bodyFormBulkEl = this.#bodyFormKvWrapEl = null;

    switch (this.#bodyType) {
      case "no-body":
        return this.#renderBodyNone(el);
      case "form-data":
      case "form-urlencoded":
        return this.#renderBodyForm(el, this.#bodyType);
      case "json":
        return this.#renderBodyText(el, "json", true);
      case "yaml":
        return this.#renderBodyText(el, "yaml", true);
      case "xml":
        return this.#renderBodyText(el, "xml", true);
      case "text":
        return this.#renderBodyText(el, "text", false);
      case "file":
        return this.#renderBodyFile(el);
    }
  }

  // ── No body ───────────────────────────────────────────────────────────────
  #renderBodyNone(el) {
    const msg = document.createElement("div");
    msg.className = "params-empty";
    msg.textContent = "No body will be sent with this request.";
    el.appendChild(msg);
  }

  // ── Form key-value editor (form-data / form-urlencoded) ───────────────────
  #renderBodyForm(el, type) {
    const rows = this.#bodyFormRows;

    // ── Bulk mode textarea ────────────────────────────────────────────────
    const bfBulkTa = document.createElement("textarea");
    bfBulkTa.className = "body-text-editor";
    bfBulkTa.placeholder = "name=value\nfield1=foo\nfield2=bar\n# disabled=row";
    bfBulkTa.spellcheck = false;
    bfBulkTa.setAttribute("aria-label", "Form fields bulk editor");
    bfBulkTa.value = this.#kvRowsToText(this.#bodyFormRows);
    bfBulkTa.addEventListener("input", () => {
      this.#bodyFormRows = this.#textToKvRows(bfBulkTa.value);
      this.#dispatchBodyUpdated();
    });
    this.#bodyFormBulkEl = bfBulkTa;
    el.appendChild(bfBulkTa);

    // ── KV wrap (column headers + list) ──────────────────────────────────
    const bfKvWrap = document.createElement("div");
    bfKvWrap.style.cssText =
      "display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden";
    this.#bodyFormKvWrapEl = bfKvWrap;

    // Column headers
    const hdr = document.createElement("div");
    hdr.className = "params-header-row";
    hdr.innerHTML = `
      <span class="params-col-handle"></span>
      <span class="params-col-enabled"></span>
      <span class="params-col-name">Name</span>
      <span class="params-col-value">Value</span>
      <span class="params-col-delete"></span>`;
    bfKvWrap.appendChild(hdr);

    // Phantom + list
    const phantom = document.createElement("div");
    phantom.className = "params-drop-phantom";
    phantom.setAttribute("aria-hidden", "true");
    this.#bfPhantom = phantom;
    this.#bfActiveType = type;

    const list = document.createElement("div");
    list.className = "params-list";
    this.#bfListEl = list;

    list.addEventListener("dragover", (e) => {
      if (this.#bfDragSrcId) e.preventDefault();
    });
    list.addEventListener("drop", (e) => {
      e.preventDefault();
      if (!this.#bfDragSrcId) return;
      this.#bfDropHandled = true;
      const allCh = [...list.children];
      const phIdx = allCh.indexOf(phantom);
      if (phIdx === -1) {
        this.#cancelBfDrag();
        this.#finalizeBfDrag();
        return;
      }
      const insertBefore = allCh
        .slice(0, phIdx)
        .filter((c) => c.classList.contains("params-row")).length;
      const srcIdx = rows.findIndex((r) => r.id === this.#bfDragSrcId);
      if (srcIdx !== -1) {
        const [moved] = rows.splice(srcIdx, 1);
        rows.splice(
          insertBefore > srcIdx ? insertBefore - 1 : insertBefore,
          0,
          moved,
        );
        this.#renderBodyContent();
        this.#dispatchBodyUpdated();
      }
      this.#finalizeBfDrag();
    });

    if (!rows.length) {
      const empty = document.createElement("div");
      empty.className = "params-empty";
      empty.textContent = "No fields — click  +  to add one.";
      list.appendChild(empty);
    } else {
      rows.forEach((row) => list.appendChild(this.#buildBfRow(row, rows)));
    }

    bfKvWrap.appendChild(list);
    el.appendChild(bfKvWrap);

    this.#applyBodyFormBulkMode();
    this.#applyBodyFormHeaderRow();
  }

  #buildBfRow(row, rows) {
    const div = document.createElement("div");
    div.className = "params-row";
    div.dataset.id = row.id;
    div.draggable = true;
    if (!row.enabled) div.classList.add("params-row--disabled");

    // Drag handle
    const handle = document.createElement("span");
    handle.className = "params-drag-handle";
    handle.setAttribute("aria-hidden", "true");
    handle.innerHTML = `<svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor">
      <circle cx="3" cy="3"  r="1.4"/><circle cx="7" cy="3"  r="1.4"/>
      <circle cx="3" cy="8"  r="1.4"/><circle cx="7" cy="8"  r="1.4"/>
      <circle cx="3" cy="13" r="1.4"/><circle cx="7" cy="13" r="1.4"/>
    </svg>`;

    // Checkbox
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "params-checkbox";
    cb.checked = row.enabled;
    cb.addEventListener("change", () => {
      row.enabled = cb.checked;
      div.classList.toggle("params-row--disabled", !row.enabled);
      this.#dispatchBodyUpdated();
    });

    // Name pill editor
    const getCtx = () => this.#variableContext;
    const getItms = () => this.#getItems();
    const nameEditor = new VariablePillEditor({
      placeholder: "Name",
      ariaLabel: "Field name",
      className: "params-name",
      getContext: getCtx,
      getItems: getItms,
      ensureResponseCaches: (names) => this.#ensureResponseCaches?.(names),
      onInput: (v) => {
        row.name = v;
        this.#dispatchBodyUpdated();
      },
      onEnter: () => {
        rows.push({
          id: crypto.randomUUID(),
          name: "",
          value: "",
          enabled: true,
        });
        this.#renderBodyContent();
        this.#dispatchBodyUpdated();
      },
    });
    nameEditor.setValue(row.name);
    this.#bodyFormPillEditors.push(nameEditor);

    // Value pill editor
    const valueEditor = new VariablePillEditor({
      placeholder: "Value",
      ariaLabel: "Field value",
      className: "params-value",
      getContext: getCtx,
      getItems: getItms,
      ensureResponseCaches: (names) => this.#ensureResponseCaches?.(names),
      onInput: (v) => {
        row.value = v;
        this.#dispatchBodyUpdated();
      },
      onEnter: () => {
        rows.push({
          id: crypto.randomUUID(),
          name: "",
          value: "",
          enabled: true,
        });
        this.#renderBodyContent();
        this.#dispatchBodyUpdated();
      },
    });
    valueEditor.setValue(row.value);
    this.#bodyFormPillEditors.push(valueEditor);

    // Delete
    const delBtn = document.createElement("button");
    delBtn.className = "icon-btn params-delete-btn";
    delBtn.title = "Delete field";
    delBtn.setAttribute("aria-label", "Delete field");
    delBtn.innerHTML = ICON_TRASH;
    delBtn.addEventListener("click", () => {
      this.#bodyFormRows = rows.filter((r) => r.id !== row.id);
      this.#renderBodyContent();
      this.#dispatchBodyUpdated();
    });

    // Drag events
    div.addEventListener("dragstart", (e) => {
      if (this.#bfDragSrcId) this.#finalizeBfDrag();
      this.#bfDragSrcId = row.id;
      this.#bfDropHandled = false;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", row.id);
      requestAnimationFrame(() => {
        this.#bfDragInside = true;
        div.parentElement?.insertBefore(this.#bfPhantom, div);
        div.style.display = "none";
      });
      this.#bfDocHandler = (ev) => {
        if (!this.#bfDragSrcId) return;
        const inside = this.#bfListEl?.contains(ev.target);
        if (!inside && this.#bfDragInside) {
          this.#bfDragInside = false;
          this.#bfPhantom?.remove();
          this.#bfListEl
            ?.querySelector(`[data-id="${this.#bfDragSrcId}"]`)
            ?.style.removeProperty("display");
        } else if (inside && !this.#bfDragInside) {
          this.#bfDragInside = true;
        }
      };
      document.addEventListener("dragover", this.#bfDocHandler);
    });
    div.addEventListener("dragover", (e) => {
      if (!this.#bfDragSrcId || this.#bfDragSrcId === row.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const rect = div.getBoundingClientRect();
      const after = (e.clientY - rect.top) / rect.height >= 0.5;
      const ph = this.#bfPhantom;
      const draggedEl = this.#bfListEl?.querySelector(
        `[data-id="${this.#bfDragSrcId}"]`,
      );
      if (draggedEl?.style.display !== "none") draggedEl.style.display = "none";
      const sibling = after ? div.nextSibling : div;
      if (ph.nextSibling !== sibling && ph !== sibling)
        div.parentElement?.insertBefore(ph, sibling);
    });
    div.addEventListener("dragend", () => {
      if (!this.#bfDropHandled) this.#cancelBfDrag();
      this.#finalizeBfDrag();
    });

    div.appendChild(handle);
    div.appendChild(cb);
    div.appendChild(nameEditor.element);
    div.appendChild(valueEditor.element);
    div.appendChild(delBtn);
    return div;
  }

  #cancelBfDrag() {
    this.#bfPhantom?.remove();
    this.#renderBodyContent();
  }
  #finalizeBfDrag() {
    if (this.#bfDocHandler) {
      document.removeEventListener("dragover", this.#bfDocHandler);
      this.#bfDocHandler = null;
    }
    this.#bfDragSrcId = null;
    this.#bfDragInside = false;
    this.#bfDropHandled = false;
  }

  // ── Text editor (JSON / YAML / XML / Plain Text) ──────────────────────────
  #renderBodyText(el, type, canPrettify) {
    const ta = document.createElement("textarea");
    ta.className = canPrettify
      ? "body-text-editor body-text-editor--overlay"
      : "body-text-editor";
    ta.value = this.#bodyText;
    ta.placeholder = `Enter ${type === "text" ? "plain text" : type.toUpperCase()} body here…`;
    ta.spellcheck = false;
    ta.setAttribute("aria-label", `${type} body`);

    // For JSON / YAML / XML: wrap textarea + syntax-highlight overlay
    let codeEl = null;
    if (canPrettify) {
      const wrap = document.createElement("div");
      wrap.className = "body-editor-wrap";

      const pre = document.createElement("pre");
      pre.className = "body-editor-pre";
      pre.setAttribute("aria-hidden", "true");
      codeEl = document.createElement("code");
      codeEl.className = `language-${type === "yaml" ? "yaml" : type === "xml" ? "markup" : "json"}`;
      pre.appendChild(codeEl);
      wrap.appendChild(pre);
      wrap.appendChild(ta);
      el.appendChild(wrap);

      // Keep scroll positions in sync
      ta.addEventListener("scroll", () => {
        pre.scrollTop = ta.scrollTop;
        pre.scrollLeft = ta.scrollLeft;
      });

      // Initial highlight
      this.#syncHighlight(ta, codeEl, type);
    } else {
      el.appendChild(ta);
    }

    // ── Inline validation (JSON / YAML / XML) ─────────────────────────────
    const canValidate = canPrettify && type !== "text";
    let validateBadge = null;
    let prettyBtnRef = null;
    let validateTimer = null;
    const VALIDATE_MS = 400;

    const applyValidity = (state /* "valid" | "invalid" | null */) => {
      if (prettyBtnRef) prettyBtnRef.disabled = state === "invalid";
      if (!validateBadge) return;
      validateBadge.dataset.state = state ?? "";
      if (state === "valid") {
        validateBadge.textContent = "✓ valid";
        validateBadge.title = `${type.toUpperCase()} is valid`;
      } else if (state === "invalid") {
        validateBadge.textContent = "✗ invalid";
        validateBadge.title = `${type.toUpperCase()} has a syntax error`;
      } else {
        validateBadge.textContent = "";
        validateBadge.title = "";
      }
    };

    const scheduleValidation = () => {
      clearTimeout(validateTimer);
      validateTimer = setTimeout(() => {
        const text = ta.value;
        if (!text.trim()) {
          applyValidity(null);
          return;
        }
        applyValidity(this.#validate(type, text) ? "valid" : "invalid");
      }, VALIDATE_MS);
    };

    ta.addEventListener("input", () => {
      this.#bodyText = ta.value;
      this.#dispatchBodyUpdated();
      if (canValidate) scheduleValidation();
      if (codeEl) this.#syncHighlight(ta, codeEl, type);
    });

    // Inject badge + Prettify button into the type selector bar
    if (canPrettify && this.#bodyTypeBarEl) {
      // Validation badge (appears between the type select and the Prettify btn)
      validateBadge = document.createElement("span");
      validateBadge.className = "body-validate-badge";
      validateBadge.setAttribute("aria-live", "polite");
      validateBadge.dataset.state = "";
      this.#bodyTypeBarEl.appendChild(validateBadge);

      // Prettify button
      const prettyBtn = document.createElement("button");
      prettyBtnRef = prettyBtn;
      prettyBtn.className =
        "params-toolbar-btn params-delete-all-btn body-prettify-btn";
      prettyBtn.title = `Prettify ${type.toUpperCase()}`;
      prettyBtn.textContent = "Prettify";
      prettyBtn.addEventListener("click", () => {
        const prettified = this.#prettify(type, ta.value);
        ta.value = prettified;
        this.#bodyText = prettified;
        this.#dispatchBodyUpdated();
        if (codeEl) this.#syncHighlight(ta, codeEl, type);
        // Immediate re-validate after prettifying (no debounce needed)
        if (canValidate) {
          applyValidity(
            ta.value.trim()
              ? this.#validate(type, ta.value)
                ? "valid"
                : "invalid"
              : null,
          );
        }
      });
      this.#bodyTypeBarEl.appendChild(prettyBtn);

      // Validate any pre-loaded content immediately on render
      if (canValidate && ta.value.trim()) {
        applyValidity(this.#validate(type, ta.value) ? "valid" : "invalid");
      }
    }
  }

  /** Validate body text for a given type. Returns true = valid, false = invalid. */
  #validate(type, text) {
    if (!text.trim()) return null;
    try {
      if (type === "json") {
        JSON.parse(text);
        return true;
      }
      if (type === "yaml") {
        parseYaml(text);
        return true;
      }
      if (type === "xml") {
        const doc = new DOMParser().parseFromString(text, "application/xml");
        return !doc.querySelector("parsererror");
      }
    } catch {
      /* fall through */
    }
    return false;
  }

  /** Prettify the given text for a body type. */
  #prettify(type, text) {
    if (!text.trim()) return text;
    try {
      if (type === "json") {
        return JSON.stringify(JSON.parse(text), null, 2);
      }
      if (type === "xml") {
        // Use DOMParser then a simple indent pass
        const doc = new DOMParser().parseFromString(text, "application/xml");
        if (doc.querySelector("parsererror")) return text;
        const raw = new XMLSerializer()
          .serializeToString(doc)
          .replace(/>\s*</g, ">\n<");
        let indent = 0;
        return raw
          .split("\n")
          .map((line) => {
            const trimmed = line.trim();
            if (!trimmed) return "";
            if (trimmed.startsWith("</")) indent = Math.max(0, indent - 1);
            const out = "  ".repeat(indent) + trimmed;
            if (
              !trimmed.startsWith("</") &&
              !trimmed.startsWith("<?") &&
              !trimmed.endsWith("/>") &&
              !trimmed.includes("</")
            )
              indent++;
            return out;
          })
          .filter((l) => l !== "")
          .join("\n");
      }
      if (type === "yaml") {
        return stringifyYaml(parseYaml(text));
      }
    } catch {
      /* invalid — return unchanged */
    }
    return text;
  }

  /**
   * Synchronise the Prism syntax-highlight overlay with the textarea content.
   * @param {HTMLTextAreaElement} ta
   * @param {HTMLElement}         codeEl  — the <code> element inside the overlay <pre>
   * @param {string}              type    — "json" | "yaml" | "xml"
   */
  #syncHighlight(ta, codeEl, type) {
    const text = ta.value;
    if (!text) {
      codeEl.innerHTML = "";
      return;
    }
    const lang = type === "yaml" ? "yaml" : type === "xml" ? "markup" : "json";
    try {
      // Prism.highlight returns an HTML string with token spans.
      // We append a trailing newline so the pre always has the same height as
      // the textarea (a trailing \n in a <pre> is ignored by the browser).
      codeEl.innerHTML =
        Prism.highlight(
          text,
          Prism.languages[lang] ?? Prism.languages.plaintext,
          lang,
        ) + "\n";
    } catch {
      // If Prism doesn't have the grammar fall back to escaped plain text
      codeEl.textContent = text;
    }
    // Keep the pre's scroll position in sync with the textarea
    if (codeEl.parentElement) {
      codeEl.parentElement.scrollTop = ta.scrollTop;
      codeEl.parentElement.scrollLeft = ta.scrollLeft;
    }
  }

  // ── File picker ───────────────────────────────────────────────────────────
  #renderBodyFile(el) {
    const showPicker = () => {
      if (this.#bodyFilePath) {
        this.#renderFileChosen(el);
      } else {
        this.#renderFileDropZone(el);
      }
    };
    showPicker();
  }

  #renderFileDropZone(el) {
    el.innerHTML = "";
    const zone = document.createElement("div");
    zone.className = "body-file-zone";

    const icon = document.createElement("div");
    icon.className = "body-file-zone__icon";
    icon.innerHTML = `<svg width="40" height="40" viewBox="0 0 40 40" fill="none"
        stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <rect x="6" y="4" width="28" height="32" rx="3"/>
      <polyline points="24,4 24,14 34,14"/>
      <line x1="14" y1="22" x2="26" y2="22"/>
      <line x1="14" y1="28" x2="22" y2="28"/>
    </svg>`;

    const label = document.createElement("p");
    label.className = "body-file-zone__label";
    label.textContent = "Drop a file here";

    const sub = document.createElement("p");
    sub.className = "body-file-zone__sub";
    sub.textContent = "or";

    const browseBtn = document.createElement("button");
    browseBtn.className = "body-file-browse-btn";
    browseBtn.textContent = "Browse…";

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.style.display = "none";
    fileInput.addEventListener("change", () => {
      const f = fileInput.files?.[0];
      if (!f) return;
      this.#bodyFilePath = f.path || f.name; // Electron exposes .path
      this.#bodyFileObject = f;
      this.#renderFileChosen(el);
      this.#dispatchBodyUpdated();
    });

    browseBtn.addEventListener("click", () => fileInput.click());

    // Drag-and-drop
    zone.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      zone.classList.add("body-file-zone--over");
    });
    zone.addEventListener("dragleave", (e) => {
      if (!zone.contains(e.relatedTarget))
        zone.classList.remove("body-file-zone--over");
    });
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      zone.classList.remove("body-file-zone--over");
      const f = e.dataTransfer.files?.[0];
      if (!f) return;
      this.#bodyFilePath = f.path || f.webkitRelativePath || f.name;
      this.#bodyFileObject = f;
      this.#renderFileChosen(el);
      this.#dispatchBodyUpdated();
    });

    zone.appendChild(icon);
    zone.appendChild(label);
    zone.appendChild(sub);
    zone.appendChild(browseBtn);
    zone.appendChild(fileInput);
    el.appendChild(zone);
  }

  #renderFileChosen(el) {
    el.innerHTML = "";
    const chosen = document.createElement("div");
    chosen.className = "body-file-chosen";

    const pathIcon = document.createElement("span");
    pathIcon.className = "body-file-chosen__icon";
    pathIcon.innerHTML = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none"
        stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
      <rect x="3" y="2" width="14" height="16" rx="2"/>
      <line x1="7" y1="7" x2="13" y2="7"/>
      <line x1="7" y1="10" x2="13" y2="10"/>
      <line x1="7" y1="13" x2="11" y2="13"/>
    </svg>`;

    const pathText = document.createElement("span");
    pathText.className = "body-file-chosen__path";
    pathText.title = this.#bodyFilePath;
    pathText.textContent = this.#bodyFilePath;

    const resetBtn = document.createElement("button");
    resetBtn.className = "body-file-reset-btn";
    resetBtn.textContent = "Reset";
    resetBtn.title = "Remove selected file";
    resetBtn.addEventListener("click", () => {
      this.#bodyFilePath = "";
      this.#bodyFileObject = null;
      this.#renderFileDropZone(el);
      this.#dispatchBodyUpdated();
    });

    chosen.appendChild(pathIcon);
    chosen.appendChild(pathText);
    chosen.appendChild(resetBtn);
    el.appendChild(chosen);
  }

  #dispatchBodyUpdated() {
    if (!this.#currentNodeId) return;
    window.dispatchEvent(
      new CustomEvent("wurl:request-updated", {
        detail: {
          id: this.#currentNodeId,
          bodyType: this.#bodyType,
          bodyFormRows: [...this.#bodyFormRows],
          bodyText: this.#bodyText,
          bodyFilePath: this.#bodyFilePath,
        },
        bubbles: true,
      }),
    );
  }

  // ── Params editor ────────────────────────────────────────────────────────
  #buildParamsEditor() {
    const container = document.createElement("div");
    container.className = "params-editor";

    // ── Toolbar ──────────────────────────────────────────────────────────
    const toolbar = document.createElement("div");
    toolbar.className = "params-toolbar";

    // ── Bulk Editor toggle — leftmost in toolbar ──────────────────────────
    const pBulkLabel = document.createElement("label");
    pBulkLabel.className = "params-toolbar-toggle-label";
    pBulkLabel.title =
      "Toggle between bulk text editor and key/value row editor";
    const pBulkCheck = document.createElement("input");
    pBulkCheck.type = "checkbox";
    pBulkCheck.className = "params-toolbar-toggle";
    pBulkCheck.checked = this.#paramsBulkMode;
    pBulkCheck.addEventListener("change", () =>
      this.#handleParamsBulkToggle(pBulkCheck.checked),
    );
    pBulkLabel.appendChild(pBulkCheck);
    pBulkLabel.append(" Bulk Editor");
    toolbar.appendChild(pBulkLabel);

    const addBtn = document.createElement("button");
    addBtn.className = "icon-btn params-toolbar-btn";
    addBtn.title = "Add parameter";
    addBtn.setAttribute("aria-label", "Add parameter");
    addBtn.innerHTML = `<span class="icon">＋</span>`;
    addBtn.addEventListener("click", () => this.#addParam());

    const deleteAllBtn = document.createElement("button");
    deleteAllBtn.className =
      "params-toolbar-btn params-toolbar-btn--danger params-delete-all-btn";
    deleteAllBtn.title = "Delete all parameters";
    deleteAllBtn.setAttribute("aria-label", "Delete all parameters");
    deleteAllBtn.textContent = "Delete All";

    // Inline confirm: first click → "Confirm?"; second click → delete all.
    // Escape or clicking outside the button cancels.
    this._paramsDeleteAllCleanup = this.#wireDeleteAllConfirm(
      deleteAllBtn,
      () => this.#params.length,
      () => this.#deleteAllParams(),
    );

    toolbar.appendChild(addBtn);
    toolbar.appendChild(deleteAllBtn);
    this.#paramsAddBtnEl = addBtn;
    this.#paramsDelAllBtnEl = deleteAllBtn;

    // Spacer pushes the Show URL toggle to the right
    const showUrlSpacer = document.createElement("span");
    showUrlSpacer.style.flex = "1";
    toolbar.appendChild(showUrlSpacer);

    // ── "Show URL" toggle — right side ───────────────────────────────────
    const showUrlLabel = document.createElement("label");
    showUrlLabel.className = "params-toolbar-toggle-label";
    showUrlLabel.title = "Show or hide the URL preview bar";

    const showUrlCheck = document.createElement("input");
    showUrlCheck.type = "checkbox";
    showUrlCheck.id = "url-preview-toggle";
    showUrlCheck.className = "params-toolbar-toggle";
    showUrlCheck.checked = this.#urlPreviewEnabled;
    showUrlCheck.addEventListener("change", () => {
      this.#urlPreviewEnabled = showUrlCheck.checked;
      this.#updateUrlPreview();
      window.dispatchEvent(
        new CustomEvent("wurl:editor-setting-changed", {
          detail: { showUrlPreview: showUrlCheck.checked },
          bubbles: true,
        }),
      );
    });

    showUrlLabel.appendChild(showUrlCheck);
    showUrlLabel.append("Show URL Preview");
    toolbar.appendChild(showUrlLabel);

    container.appendChild(toolbar);

    // ── URL preview bar (below toolbar, above column headers) ─────────────
    container.appendChild(this.#buildUrlPreviewBar());

    // ── Bulk mode textarea ────────────────────────────────────────────────
    const pBulkTa = document.createElement("textarea");
    pBulkTa.className = "body-text-editor";
    pBulkTa.placeholder = "name=value\nparam1=foo\nparam2=bar\n# disabled=row";
    pBulkTa.spellcheck = false;
    pBulkTa.setAttribute("aria-label", "Parameters bulk editor");
    pBulkTa.addEventListener("input", () => {
      this.#params = this.#textToKvRows(pBulkTa.value);
      this.#updateUrlPreview();
      this.#dispatchParamsUpdated();
    });
    this.#paramsBulkEl = pBulkTa;
    container.appendChild(pBulkTa);

    // ── KV wrap (column headers + list) ──────────────────────────────────
    const pKvWrap = document.createElement("div");
    pKvWrap.style.cssText =
      "display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden";
    this.#paramsKvWrapEl = pKvWrap;

    // ── Column headers ───────────────────────────────────────────────────
    const headers = document.createElement("div");
    headers.className = "params-header-row";
    headers.innerHTML = `
      <span class="params-col-handle"></span>
      <span class="params-col-enabled"></span>
      <span class="params-col-name">Name</span>
      <span class="params-col-value">Value</span>
      <span class="params-col-delete"></span>`;
    pKvWrap.appendChild(headers);

    // ── List ─────────────────────────────────────────────────────────────
    const list = document.createElement("div");
    list.className = "params-list";
    this.#paramsListEl = list;

    // Phantom placeholder shown at the drop target while dragging
    this.#paramPhantomEl = document.createElement("div");
    this.#paramPhantomEl.className = "params-drop-phantom";
    this.#paramPhantomEl.setAttribute("aria-hidden", "true");

    // Container-level drop — commit the reorder
    list.addEventListener("dragover", (e) => {
      if (this.#dragSrcId) e.preventDefault();
    });
    list.addEventListener("drop", (e) => {
      e.preventDefault();
      if (!this.#dragSrcId) return;
      this.#dragDropHandled = true;
      const ph = this.#paramPhantomEl;
      // Find the index of the phantom to know where to insert
      const allChildren = [...list.children];
      const phantomIdx = allChildren.indexOf(ph);
      if (phantomIdx === -1) {
        this.#cancelParamDrag();
        this.#finalizeParamDrag();
        return;
      }
      // Count only param rows before the phantom
      const insertBefore = allChildren
        .slice(0, phantomIdx)
        .filter((el) => el.classList.contains("params-row")).length;
      const srcIdx = this.#params.findIndex((p) => p.id === this.#dragSrcId);
      if (srcIdx !== -1) {
        const [moved] = this.#params.splice(srcIdx, 1);
        const target = insertBefore > srcIdx ? insertBefore - 1 : insertBefore;
        this.#params.splice(target, 0, moved);
        this.#renderParamsList();
        this.#dispatchParamsUpdated();
      }
      this.#finalizeParamDrag();
    });

    pKvWrap.appendChild(list);
    container.appendChild(pKvWrap);

    this.#applyParamsBulkMode();
    this.#renderParamsList();
    return container;
  }

  // ── Headers editor ──────────────────────────────────────────────────
  #buildHeadersEditor() {
    const container = document.createElement("div");
    container.className = "params-editor";

    // ── Toolbar ──────────────────────────────────────────────────────────
    const toolbar = document.createElement("div");
    toolbar.className = "params-toolbar";

    // ── Bulk Editor toggle — leftmost in toolbar ──────────────────────────
    const hBulkLabel = document.createElement("label");
    hBulkLabel.className = "params-toolbar-toggle-label";
    hBulkLabel.title =
      "Toggle between bulk text editor and key/value row editor";
    const hBulkCheck = document.createElement("input");
    hBulkCheck.type = "checkbox";
    hBulkCheck.className = "params-toolbar-toggle";
    hBulkCheck.checked = this.#headersBulkMode;
    hBulkCheck.addEventListener("change", () =>
      this.#handleHeadersBulkToggle(hBulkCheck.checked),
    );
    hBulkLabel.appendChild(hBulkCheck);
    hBulkLabel.append(" Bulk Editor");
    toolbar.appendChild(hBulkLabel);

    const addBtn = document.createElement("button");
    addBtn.className = "icon-btn params-toolbar-btn";
    addBtn.title = "Add header";
    addBtn.setAttribute("aria-label", "Add header");
    addBtn.innerHTML = `<span class="icon">＋</span>`;
    addBtn.addEventListener("click", () => this.#addHeader());

    const deleteAllBtn = document.createElement("button");
    deleteAllBtn.className =
      "params-toolbar-btn params-toolbar-btn--danger params-delete-all-btn";
    deleteAllBtn.title = "Delete all headers";
    deleteAllBtn.setAttribute("aria-label", "Delete all headers");
    deleteAllBtn.textContent = "Delete All";

    // Inline confirm: first click → "Confirm?"; second click → delete all.
    // Escape or clicking outside the button cancels.
    this._headersDeleteAllCleanup = this.#wireDeleteAllConfirm(
      deleteAllBtn,
      () => this.#headers.length,
      () => this.#deleteAllHeaders(),
    );

    toolbar.appendChild(addBtn);
    toolbar.appendChild(deleteAllBtn);
    this.#headersAddBtnEl = addBtn;
    this.#headersDelAllBtnEl = deleteAllBtn;

    // ── "List Headers" toggle — pushed to the right ───────────────────────
    const spacer = document.createElement("span");
    spacer.style.flex = "1";
    toolbar.appendChild(spacer);
    this.#listHdrSpacerEl = spacer;

    const listHdrLabel = document.createElement("label");
    listHdrLabel.className = "params-toolbar-toggle-label";
    listHdrLabel.title =
      "Show standard header suggestions when editing the header name";

    const listHdrCheck = document.createElement("input");
    listHdrCheck.type = "checkbox";
    listHdrCheck.id = "list-headers-toggle";
    listHdrCheck.checked = this.#headerSuggestionsEnabled;
    listHdrCheck.className = "params-toolbar-toggle";
    listHdrCheck.addEventListener("change", () => {
      this.#headerSuggestionsEnabled = listHdrCheck.checked;
      if (!listHdrCheck.checked) _hideHdrDropdown();
      // Persist the preference into settings
      window.dispatchEvent(
        new CustomEvent("wurl:editor-setting-changed", {
          detail: { listHeaders: listHdrCheck.checked },
          bubbles: true,
        }),
      );
    });

    listHdrLabel.appendChild(listHdrCheck);
    listHdrLabel.append(" List Headers");
    toolbar.appendChild(listHdrLabel);
    this.#listHdrLabelEl = listHdrLabel;

    container.appendChild(toolbar);

    // ── Bulk mode textarea ────────────────────────────────────────────────
    const hBulkTa = document.createElement("textarea");
    hBulkTa.className = "body-text-editor";
    hBulkTa.placeholder =
      "Header-Name: value\nContent-Type: application/json\nAuthorization: Bearer token\n# X-Disabled: skipped";
    hBulkTa.spellcheck = false;
    hBulkTa.setAttribute("aria-label", "Headers bulk editor");
    hBulkTa.addEventListener("input", () => {
      this.#headers = this.#textToHeaderRows(hBulkTa.value);
      this.#dispatchHeadersUpdated();
    });
    this.#headersBulkEl = hBulkTa;
    container.appendChild(hBulkTa);

    // ── KV wrap (column headers + list) ──────────────────────────────────
    const hKvWrap = document.createElement("div");
    hKvWrap.style.cssText =
      "display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden";
    this.#headersKvWrapEl = hKvWrap;

    // ── Column headers ───────────────────────────────────────────────────
    const colHeaders = document.createElement("div");
    colHeaders.className = "params-header-row";
    colHeaders.innerHTML = `
      <span class="params-col-handle"></span>
      <span class="params-col-enabled"></span>
      <span class="params-col-name">Header</span>
      <span class="params-col-value">Value</span>
      <span class="params-col-delete"></span>`;
    hKvWrap.appendChild(colHeaders);

    // ── List ─────────────────────────────────────────────────────────────
    const list = document.createElement("div");
    list.className = "params-list";
    this.#headersListEl = list;

    // Phantom placeholder shown at the drop target while dragging
    this.#headerPhantomEl = document.createElement("div");
    this.#headerPhantomEl.className = "params-drop-phantom";
    this.#headerPhantomEl.setAttribute("aria-hidden", "true");

    // Container-level drop — commit the reorder
    list.addEventListener("dragover", (e) => {
      if (this.#hdrDragSrcId) e.preventDefault();
    });
    list.addEventListener("drop", (e) => {
      e.preventDefault();
      if (!this.#hdrDragSrcId) return;
      this.#hdrDragDropHandled = true;
      const ph = this.#headerPhantomEl;
      const allChildren = [...list.children];
      const phantomIdx = allChildren.indexOf(ph);
      if (phantomIdx === -1) {
        this.#cancelHeaderDrag();
        this.#finalizeHeaderDrag();
        return;
      }
      const insertBefore = allChildren
        .slice(0, phantomIdx)
        .filter((el) => el.classList.contains("params-row")).length;
      const srcIdx = this.#headers.findIndex(
        (h) => h.id === this.#hdrDragSrcId,
      );
      if (srcIdx !== -1) {
        const [moved] = this.#headers.splice(srcIdx, 1);
        const target = insertBefore > srcIdx ? insertBefore - 1 : insertBefore;
        this.#headers.splice(target, 0, moved);
        this.#renderHeadersList();
        this.#dispatchHeadersUpdated();
      }
      this.#finalizeHeaderDrag();
    });

    hKvWrap.appendChild(list);
    container.appendChild(hKvWrap);

    this.#applyHeadersBulkMode();
    this.#renderHeadersList();
    return container;
  }

  #addHeader() {
    this.#headers.push({
      id: crypto.randomUUID(),
      name: "",
      value: "",
      enabled: true,
    });
    this.#renderHeadersList();
    const rows = this.#headersListEl?.querySelectorAll(".params-row") ?? [];
    if (rows.length)
      rows[rows.length - 1].querySelector(".params-name")?.focus();
    this.#dispatchHeadersUpdated();
  }

  #deleteAllHeaders() {
    if (this.#headers.length === 0) return;
    this.#headers = [];
    this.#renderHeadersList();
    this.#dispatchHeadersUpdated();
  }

  #deleteHeader(id) {
    this.#headers = this.#headers.filter((h) => h.id !== id);
    this.#renderHeadersList();
    this.#dispatchHeadersUpdated();
  }

  #renderHeadersList() {
    if (!this.#headersListEl) return;
    // Tear down stale pill editors before discarding their references — each
    // one holds a document-level selectionchange listener that would otherwise
    // outlive the DOM row it was attached to.
    for (const ed of this.#headerPillEditors) ed.destroy?.();
    this.#headerPillEditors = [];

    // In bulk mode just keep the textarea in sync
    if (this.#headersBulkMode) {
      if (this.#headersBulkEl)
        this.#headersBulkEl.value = this.#headerRowsToText(this.#headers);
      return;
    }

    this.#headersListEl.innerHTML = "";

    if (this.#headers.length === 0) {
      const empty = document.createElement("div");
      empty.className = "params-empty";
      empty.textContent = "No headers — click  +  to add one.";
      this.#headersListEl.appendChild(empty);
      return;
    }

    this.#headers.forEach((header, index) => {
      this.#headersListEl.appendChild(this.#buildHeaderRow(header, index));
    });
  }

  #buildHeaderRow(header, index) {
    const row = document.createElement("div");
    row.className = "params-row";
    row.dataset.id = header.id;
    row.dataset.index = String(index);
    row.draggable = true;
    if (!header.enabled) row.classList.add("params-row--disabled");

    // ── Drag handle ──────────────────────────────────────────────────────
    const handle = document.createElement("span");
    handle.className = "params-drag-handle";
    handle.setAttribute("aria-hidden", "true");
    handle.title = "Drag to reorder";
    handle.innerHTML = `<svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor">
      <circle cx="3" cy="3"  r="1.4"/><circle cx="7" cy="3"  r="1.4"/>
      <circle cx="3" cy="8"  r="1.4"/><circle cx="7" cy="8"  r="1.4"/>
      <circle cx="3" cy="13" r="1.4"/><circle cx="7" cy="13" r="1.4"/>
    </svg>`;

    // ── Enabled checkbox ─────────────────────────────────────────────────
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "params-checkbox";
    checkbox.checked = header.enabled;
    checkbox.title = header.enabled ? "Disable header" : "Enable header";
    checkbox.setAttribute("aria-label", "Enable header");
    checkbox.addEventListener("change", () => {
      header.enabled = checkbox.checked;
      checkbox.title = header.enabled ? "Disable header" : "Enable header";
      row.classList.toggle("params-row--disabled", !header.enabled);
      this.#dispatchHeadersUpdated();
    });

    // ── Forward references for the value-dropdown callbacks ───────────────
    // Both are assigned after valueEditor is created (below) so the closures
    // can safely reference valueEditor without a TDZ error.
    let _onValueSelected = null;
    let _onNameConfirmed = null;

    // ── Header name combo box ─────────────────────────────────────────────
    const headerInput = document.createElement("input");
    headerInput.type = "text";
    headerInput.className = "params-input params-name";
    headerInput.placeholder = "Header";
    headerInput.value = header.name;
    headerInput.setAttribute("aria-label", "Header name");
    headerInput.setAttribute("autocomplete", "off");
    headerInput.addEventListener("focus", () => {
      if (this.#headerSuggestionsEnabled)
        _showHdrDropdown(headerInput, (name) => _onNameConfirmed?.(name));
    });
    headerInput.addEventListener("input", () => {
      header.name = headerInput.value;
      this.#dispatchHeadersUpdated();
      if (this.#headerSuggestionsEnabled)
        _showHdrDropdown(headerInput, (name) => _onNameConfirmed?.(name));
    });
    headerInput.addEventListener("blur", () => {
      // Store the timer ID so focus can cancel it if the user clicks back quickly
      _hdrAcBlurTimer = setTimeout(_hideHdrDropdown, 150);
    });
    headerInput.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        _hdrDropdownNavigate(+1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        _hdrDropdownNavigate(-1);
        return;
      }
      if (e.key === "Escape") {
        _hideHdrDropdown();
        return;
      }
      if (e.key === " " && e.ctrlKey) {
        // Ctrl+Space: open the name-suggestions dropdown even when listHeaders is off.
        e.preventDefault();
        _showHdrDropdown(headerInput, (name) =>
          _onNameConfirmed?.(name, { force: true }),
        );
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (!_hdrDropdownAccept(headerInput)) this.#addHeader();
      }
    });

    // ── Value input ─────────────────────────────────────────────────────
    const valueEditor = new VariablePillEditor({
      placeholder: "Value",
      ariaLabel: "Header value",
      className: "params-value",
      getContext: () => this.#variableContext,
      getItems: () => this.#getItems(),
      ensureResponseCaches: (names) => this.#ensureResponseCaches?.(names),
      onInput: (v) => {
        header.value = v;
        this.#dispatchHeadersUpdated();
        // Re-open value suggestions when the user types a trailing comma,
        // allowing them to build a comma-separated multi-value header.
        if (this.#headerSuggestionsEnabled && v.trimEnd().endsWith(",")) {
          _onNameConfirmed?.(headerInput.value);
        }
      },
      onEnter: () => this.#addHeader(),
    });
    valueEditor.setValue(header.value);
    this.#headerPillEditors.push(valueEditor);

    // ── Post-creation: wire value-dropdown callbacks ──────────────────────
    // _onValueSelected: inserts the picked value, appending after a trailing
    // comma if one is already present (allows multi-value headers).
    _onValueSelected = (picked) => {
      const current = valueEditor.getValue().trimEnd();
      const newVal = current.endsWith(",")
        ? `${current} ${picked}`
        : current === ""
          ? picked
          : `${current}, ${picked}`;
      valueEditor.setValue(newVal);
      header.value = newVal;
      this.#dispatchHeadersUpdated();
      // Re-open the dropdown so the user can keep appending values
      // (they will naturally see it because the value now ends with something
      // that is NOT a comma, so it won't auto-reopen — that's intentional).
      valueEditor.focus();
    };

    // _onNameConfirmed: called when a header name is finalised (click or kbd).
    // Looks up the dict entry and, if values exist, shows the value dropdown.
    _onNameConfirmed = (name, { force = false } = {}) => {
      if (!this.#headerSuggestionsEnabled && !force) return;
      const values = STANDARD_HEADERS_DICT[name] ?? [];
      if (values.length === 0) {
        _hideHdrValDropdown();
        return;
      }
      _showHdrValDropdown(valueEditor.element, values, _onValueSelected);
    };

    // Dismiss value dropdown when the value editor loses focus (with a short
    // delay so mousedown on a dropdown item can fire first).
    valueEditor.element.addEventListener("blur", () => {
      _hdrValBlurTimer = setTimeout(_hideHdrValDropdown, 150);
    });

    // Keyboard navigation for the value dropdown (capture phase so we intercept
    // before VariablePillEditor's own bubble-phase keydown handler).
    valueEditor.element.addEventListener(
      "keydown",
      (e) => {
        // Ctrl+Space: open value suggestions regardless of the listHeaders setting.
        if (e.key === " " && e.ctrlKey) {
          e.preventDefault();
          _onNameConfirmed?.(headerInput.value, { force: true });
          return;
        }
        if (!_hdrValDropdownVisible()) return;
        if (e.key === "ArrowDown") {
          e.preventDefault();
          _hdrValDropdownNavigate(+1);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          _hdrValDropdownNavigate(-1);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          _hideHdrValDropdown();
          return;
        }
        if (e.key === "Enter" && _hdrValActiveIdx >= 0) {
          // Prevent VariablePillEditor's Enter handler from adding a new header row.
          e.preventDefault();
          e.stopPropagation();
          _hdrValDropdownAccept();
        }
      },
      true /* capture — fires before VariablePillEditor's bubble-phase listener */,
    );

    // ── Delete button ────────────────────────────────────────────────────
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "icon-btn params-delete-btn";
    deleteBtn.title = "Delete header";
    deleteBtn.setAttribute("aria-label", "Delete header");
    deleteBtn.innerHTML = ICON_TRASH;
    deleteBtn.addEventListener("click", () => this.#deleteHeader(header.id));

    // ── HTML5 drag-and-drop reordering (phantom pattern) ─────────────────
    row.addEventListener("dragstart", (e) => {
      this.#hdrDragSrcId = header.id;
      this.#hdrDragDropHandled = false;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", header.id);

      requestAnimationFrame(() => {
        this.#hdrDragInsideList = true;
        row.parentElement?.insertBefore(this.#headerPhantomEl, row);
        row.style.display = "none";
      });

      this.#hdrDocDragOverHandler = (ev) => {
        if (!this.#hdrDragSrcId || !this.#headersListEl) return;
        const inside = this.#headersListEl.contains(ev.target);
        if (!inside && this.#hdrDragInsideList) {
          this.#hdrDragInsideList = false;
          this.#headerPhantomEl.remove();
          const draggedRow = this.#headersListEl.querySelector(
            `[data-id="${this.#hdrDragSrcId}"]`,
          );
          if (draggedRow) draggedRow.style.display = "";
        } else if (inside && !this.#hdrDragInsideList) {
          this.#hdrDragInsideList = true;
        }
      };
      document.addEventListener("dragover", this.#hdrDocDragOverHandler);
    });

    row.addEventListener("dragover", (e) => {
      if (!this.#hdrDragSrcId || this.#hdrDragSrcId === header.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";

      const rect = row.getBoundingClientRect();
      const after = (e.clientY - rect.top) / rect.height >= 0.5;
      const ph = this.#headerPhantomEl;

      const draggedRow = this.#headersListEl.querySelector(
        `[data-id="${this.#hdrDragSrcId}"]`,
      );
      if (draggedRow && draggedRow.style.display !== "none")
        draggedRow.style.display = "none";

      const sibling = after ? row.nextSibling : row;
      if (ph.nextSibling !== sibling && ph !== sibling) {
        row.parentElement?.insertBefore(ph, sibling);
      }
    });

    row.addEventListener("dragend", () => {
      if (!this.#hdrDragDropHandled) this.#cancelHeaderDrag();
      this.#finalizeHeaderDrag();
    });

    row.appendChild(handle);
    row.appendChild(checkbox);
    row.appendChild(headerInput);
    row.appendChild(valueEditor.element);
    row.appendChild(deleteBtn);
    return row;
  }

  /** Cancel a header drag: remove phantom and re-render. */
  #cancelHeaderDrag() {
    this.#headerPhantomEl.remove();
    this.#renderHeadersList();
  }

  /** Clean up all header drag state and remove the document-level listener. */
  #finalizeHeaderDrag() {
    if (this.#hdrDocDragOverHandler) {
      document.removeEventListener("dragover", this.#hdrDocDragOverHandler);
      this.#hdrDocDragOverHandler = null;
    }
    this.#hdrDragSrcId = null;
    this.#hdrDragInsideList = false;
    this.#hdrDragDropHandled = false;
  }

  #addParam() {
    this.#params.push({
      id: crypto.randomUUID(),
      name: "",
      value: "",
      enabled: true,
    });
    this.#renderParamsList();
    const rows = this.#paramsListEl?.querySelectorAll(".params-row") ?? [];
    if (rows.length)
      rows[rows.length - 1].querySelector(".params-name")?.focus();
    this.#dispatchParamsUpdated();
  }

  #deleteAllParams() {
    if (this.#params.length === 0) return;
    this.#params = [];
    this.#renderParamsList();
    this.#dispatchParamsUpdated();
  }

  #deleteParam(id) {
    this.#params = this.#params.filter((p) => p.id !== id);
    this.#renderParamsList();
    this.#dispatchParamsUpdated();
  }

  #renderParamsList() {
    if (!this.#paramsListEl) return;
    // Tear down stale pill editors before discarding their references — each
    // one holds a document-level selectionchange listener that would otherwise
    // outlive the DOM row it was attached to.
    for (const ed of this.#paramPillEditors) ed.destroy?.();
    this.#paramPillEditors = [];

    // In bulk mode just keep the textarea in sync and update the URL preview
    if (this.#paramsBulkMode) {
      if (this.#paramsBulkEl)
        this.#paramsBulkEl.value = this.#kvRowsToText(this.#params);
      this.#updateUrlPreview();
      return;
    }

    this.#paramsListEl.innerHTML = "";

    if (this.#params.length === 0) {
      const empty = document.createElement("div");
      empty.className = "params-empty";
      empty.textContent = "No parameters — click  +  to add one.";
      this.#paramsListEl.appendChild(empty);
      this.#updateUrlPreview();
      return;
    }

    this.#params.forEach((param, index) => {
      this.#paramsListEl.appendChild(this.#buildParamRow(param, index));
    });
    this.#updateUrlPreview();
  }

  // ── URL preview helpers ──────────────────────────────────────────────────

  /**
   * Build the one-time URL preview bar DOM element (read-only input + Copy button).
   * Stored in #urlPreviewEl / #urlPreviewInputEl for later updates.
   */
  #buildUrlPreviewBar() {
    const bar = document.createElement("div");
    bar.className = "params-url-preview";

    const input = document.createElement("input");
    input.type = "text";
    input.readOnly = true;
    input.className = "params-url-preview__input";
    input.placeholder = "Enter a URL above to preview it here";
    input.setAttribute("aria-label", "Request URL with query parameters");
    input.tabIndex = -1;

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "params-url-preview__copy-btn";
    copyBtn.textContent = "Copy";
    copyBtn.title = "Copy URL to clipboard";
    copyBtn.setAttribute("aria-label", "Copy URL to clipboard");
    copyBtn.addEventListener("click", () => {
      const text = input.value;
      if (!text) return;
      navigator.clipboard.writeText(text).then(() => {
        copyBtn.textContent = "Copied!";
        setTimeout(() => {
          copyBtn.textContent = "Copy";
        }, 1500);
      });
    });

    bar.appendChild(input);
    bar.appendChild(copyBtn);

    this.#urlPreviewEl = bar;
    this.#urlPreviewInputEl = input;
    this.#updateUrlPreview();
    return bar;
  }

  /** Assemble the URL string with enabled query parameters appended. */
  async #buildPreviewUrl() {
    const ctx = this.#variableContext;

    const urlParts = await Promise.all(
      tokenize(this.#url ?? "").map(async (tok) => {
        if (tok.type === "text") return tok.content;
        const raw = `{{${tok.content}}}`;
        return resolveStringAsync(raw, ctx);
      }),
    );
    const base = _encodeBaseUrl(urlParts.join(""));

    const enabled = this.#params.filter((p) => p.enabled && p.name.trim());
    if (!enabled.length) return base;
    const pairs = await Promise.all(
      enabled.map(async (p) => {
        const name = await resolveStringAsync(p.name, ctx);
        const value = await resolveStringAsync(p.value, ctx);
        return `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
      }),
    );
    const qs = pairs.join("&");
    return base + (base.includes("?") ? "&" : "?") + qs;
  }

  /** Refresh the preview bar's visibility and text content. */
  async #updateUrlPreview() {
    if (!this.#urlPreviewEl) return;
    const seq = ++this.#urlPreviewSeq;
    this.#urlPreviewEl.classList.toggle(
      "params-url-preview--hidden",
      !this.#urlPreviewEnabled,
    );
    if (this.#urlPreviewInputEl) {
      const url = await this.#buildPreviewUrl();
      if (seq === this.#urlPreviewSeq) this.#urlPreviewInputEl.value = url;
    }
  }

  #buildParamRow(param, index) {
    const row = document.createElement("div");
    row.className = "params-row";
    row.dataset.id = param.id;
    row.dataset.index = String(index);
    row.draggable = true;
    if (!param.enabled) row.classList.add("params-row--disabled");

    // ── Drag handle ──────────────────────────────────────────────────────
    const handle = document.createElement("span");
    handle.className = "params-drag-handle";
    handle.setAttribute("aria-hidden", "true");
    handle.title = "Drag to reorder";
    handle.innerHTML = `<svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor">
      <circle cx="3" cy="3"  r="1.4"/><circle cx="7" cy="3"  r="1.4"/>
      <circle cx="3" cy="8"  r="1.4"/><circle cx="7" cy="8"  r="1.4"/>
      <circle cx="3" cy="13" r="1.4"/><circle cx="7" cy="13" r="1.4"/>
    </svg>`;

    // ── Enabled checkbox ─────────────────────────────────────────────────
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "params-checkbox";
    checkbox.checked = param.enabled;
    checkbox.title = param.enabled ? "Disable parameter" : "Enable parameter";
    checkbox.setAttribute("aria-label", "Enable parameter");
    checkbox.addEventListener("change", () => {
      param.enabled = checkbox.checked;
      checkbox.title = param.enabled ? "Disable parameter" : "Enable parameter";
      row.classList.toggle("params-row--disabled", !param.enabled);
      this.#updateUrlPreview();
      this.#dispatchParamsUpdated();
    });

    // ── Name pill editor ─────────────────────────────────────────────────
    const getCtx = () => this.#variableContext;
    const getItms = () => this.#getItems();
    const nameEditor = new VariablePillEditor({
      placeholder: "Name",
      ariaLabel: "Parameter name",
      className: "params-name",
      getContext: getCtx,
      getItems: getItms,
      ensureResponseCaches: (names) => this.#ensureResponseCaches?.(names),
      onInput: (v) => {
        param.name = v;
        this.#updateUrlPreview();
        this.#dispatchParamsUpdated();
      },
      onEnter: () => this.#addParam(),
    });
    nameEditor.setValue(param.name);
    this.#paramPillEditors.push(nameEditor);

    // ── Value pill editor ─────────────────────────────────────────────────
    const valueEditor = new VariablePillEditor({
      placeholder: "Value",
      ariaLabel: "Parameter value",
      className: "params-value",
      getContext: getCtx,
      getItems: getItms,
      ensureResponseCaches: (names) => this.#ensureResponseCaches?.(names),
      onInput: (v) => {
        param.value = v;
        this.#updateUrlPreview();
        this.#dispatchParamsUpdated();
      },
      onEnter: () => this.#addParam(),
    });
    valueEditor.setValue(param.value);
    this.#paramPillEditors.push(valueEditor);

    // ── Delete button ────────────────────────────────────────────────────
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "icon-btn params-delete-btn";
    deleteBtn.title = "Delete parameter";
    deleteBtn.setAttribute("aria-label", "Delete parameter");
    deleteBtn.innerHTML = ICON_TRASH;
    deleteBtn.addEventListener("click", () => this.#deleteParam(param.id));

    // ── HTML5 drag-and-drop reordering (phantom pattern) ─────────────────

    row.addEventListener("dragstart", (e) => {
      this.#dragSrcId = param.id;
      this.#dragDropHandled = false;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", param.id);

      requestAnimationFrame(() => {
        this.#dragInsideList = true;
        row.parentElement?.insertBefore(this.#paramPhantomEl, row);
        row.style.display = "none";
      });

      this.#docDragOverHandler = (ev) => {
        if (!this.#dragSrcId || !this.#paramsListEl) return;
        const inside = this.#paramsListEl.contains(ev.target);
        if (!inside && this.#dragInsideList) {
          this.#dragInsideList = false;
          this.#paramPhantomEl.remove();
          const draggedRow = this.#paramsListEl.querySelector(
            `[data-id="${this.#dragSrcId}"]`,
          );
          if (draggedRow) draggedRow.style.display = "";
        } else if (inside && !this.#dragInsideList) {
          this.#dragInsideList = true;
        }
      };
      document.addEventListener("dragover", this.#docDragOverHandler);
    });

    row.addEventListener("dragover", (e) => {
      if (!this.#dragSrcId || this.#dragSrcId === param.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";

      const rect = row.getBoundingClientRect();
      const after = (e.clientY - rect.top) / rect.height >= 0.5;
      const ph = this.#paramPhantomEl;

      const draggedRow = this.#paramsListEl.querySelector(
        `[data-id="${this.#dragSrcId}"]`,
      );
      if (draggedRow && draggedRow.style.display !== "none")
        draggedRow.style.display = "none";

      const sibling = after ? row.nextSibling : row;
      if (ph.nextSibling !== sibling && ph !== sibling) {
        row.parentElement?.insertBefore(ph, sibling);
      }
    });

    row.addEventListener("dragend", () => {
      if (!this.#dragDropHandled) this.#cancelParamDrag();
      this.#finalizeParamDrag();
    });

    row.appendChild(handle);
    row.appendChild(checkbox);
    row.appendChild(nameEditor.element);
    row.appendChild(valueEditor.element);
    row.appendChild(deleteBtn);
    return row;
  }

  /** Cancel a drag: remove phantom and re-render from unchanged #params. */
  #cancelParamDrag() {
    this.#paramPhantomEl.remove();
    this.#renderParamsList();
  }

  /** Clean up all drag state and remove the document-level listener. */
  #finalizeParamDrag() {
    if (this.#docDragOverHandler) {
      document.removeEventListener("dragover", this.#docDragOverHandler);
      this.#docDragOverHandler = null;
    }
    this.#dragSrcId = null;
    this.#dragInsideList = false;
    this.#dragDropHandled = false;
  }

  // ── Shared UI helpers ─────────────────────────────────────────────────────

  /**
   * Wire up the standard two-click inline-confirm pattern on a "Delete All"
   * button.  First click turns it amber and shows "Confirm?"; second click
   * runs `onDelete`.  Escape or clicking outside cancels.
   *
   * Returns a cancel function (store it so node-switches can reset the button).
   *
   * @param {HTMLButtonElement} btn
   * @param {() => number}      getCount   — called to guard against empty list
   * @param {() => void}        onDelete   — called on confirmed second click
   * @returns {() => void} cancel function
   */
  #wireDeleteAllConfirm(btn, getCount, onDelete) {
    let cleanupConfirm = null;

    const enterConfirm = () => {
      btn.textContent = "Confirm?";
      btn.classList.remove("params-toolbar-btn--danger");
      btn.classList.add("params-toolbar-btn--confirming");

      const restore = () => {
        btn.textContent = "Delete All";
        btn.classList.remove("params-toolbar-btn--confirming");
        btn.classList.add("params-toolbar-btn--danger");
        document.removeEventListener("keydown", onEsc, true);
        document.removeEventListener("mousedown", onOutside, true);
        cleanupConfirm = null;
      };

      const onEsc = (e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          restore();
        }
      };
      const onOutside = (e) => {
        if (!btn.contains(e.target)) restore();
      };

      document.addEventListener("keydown", onEsc, true);
      document.addEventListener("mousedown", onOutside, true);
      cleanupConfirm = restore;
    };

    btn.addEventListener("click", () => {
      if (!getCount()) return;
      if (cleanupConfirm) {
        cleanupConfirm();
        onDelete();
      } else enterConfirm();
    });

    return () => cleanupConfirm?.();
  }

  /**
   * Toggle a bulk-editor's textarea/kv-wrap and KV-only toolbar buttons.
   * @param {boolean}          bulk
   * @param {HTMLElement|null} textareaEl
   * @param {HTMLElement|null} kvWrapEl
   * @param {HTMLElement|null} addBtnEl
   * @param {HTMLElement|null} delAllBtnEl
   */
  #applyBulkMode(bulk, textareaEl, kvWrapEl, addBtnEl, delAllBtnEl) {
    if (textareaEl) textareaEl.style.display = bulk ? "" : "none";
    if (kvWrapEl) kvWrapEl.style.display = bulk ? "none" : "";
    if (addBtnEl) addBtnEl.style.display = bulk ? "none" : "";
    if (delAllBtnEl) delAllBtnEl.style.display = bulk ? "none" : "";
  }

  // ── Bulk editor shared utilities ─────────────────────────────────────────

  /**
   * Serialise an array of { name, value, enabled } rows to  name=value  text.
   * Disabled rows are prefixed with "# " so the enabled state survives a
   * round-trip through the bulk editor.
   */
  #kvRowsToText(rows) {
    return rows
      .map((r) => `${r.enabled ? "" : "# "}${r.name}=${r.value}`)
      .join("\n");
  }

  /**
   * Serialise header rows to  Name: value  text (standard HTTP format).
   * Disabled rows are prefixed with "# ".
   */
  #headerRowsToText(rows) {
    return rows
      .map((r) => `${r.enabled ? "" : "# "}${r.name}: ${r.value}`)
      .join("\n");
  }

  /**
   * Parse  name=value  bulk text into an array of row objects.
   * Lines prefixed with "# " are parsed as disabled rows; all others are enabled.
   * Lines with no '=' are treated as name-only rows with an empty value.
   */
  #textToKvRows(text) {
    const out = [];
    for (const line of text.split("\n")) {
      let trimmed = line.trim();
      if (!trimmed) continue;
      const disabled = trimmed.startsWith("# ");
      if (disabled) trimmed = trimmed.slice(2).trim();
      if (!trimmed) continue;
      const eqIdx = trimmed.indexOf("=");
      const name = eqIdx === -1 ? trimmed : trimmed.slice(0, eqIdx).trim();
      const value = eqIdx === -1 ? "" : trimmed.slice(eqIdx + 1);
      if (name)
        out.push({ id: crypto.randomUUID(), name, value, enabled: !disabled });
    }
    return out;
  }

  /**
   * Parse  Header-Name: value  OR  Header-Name=value  lines into header rows.
   * Supports both colon-separated (natural HTTP format) and equals-separated.
   * Lines prefixed with "# " are parsed as disabled rows; all others are enabled.
   */
  #textToHeaderRows(text) {
    const out = [];
    for (const line of text.split("\n")) {
      let trimmed = line.trim();
      if (!trimmed) continue;
      const disabled = trimmed.startsWith("# ");
      if (disabled) trimmed = trimmed.slice(2).trim();
      if (!trimmed) continue;
      // Prefer colon separator for headers, fall back to equals
      const colonIdx = trimmed.indexOf(":");
      const eqIdx = trimmed.indexOf("=");
      let name, value;
      if (colonIdx !== -1 && (eqIdx === -1 || colonIdx < eqIdx)) {
        name = trimmed.slice(0, colonIdx).trim();
        value = trimmed.slice(colonIdx + 1).trim();
      } else if (eqIdx !== -1) {
        name = trimmed.slice(0, eqIdx).trim();
        value = trimmed.slice(eqIdx + 1);
      } else {
        name = trimmed;
        value = "";
      }
      if (name)
        out.push({ id: crypto.randomUUID(), name, value, enabled: !disabled });
    }
    return out;
  }

  // ── Params bulk editor ────────────────────────────────────────────────────

  #handleParamsBulkToggle(nowBulk) {
    if (nowBulk && !this.#paramsBulkMode) {
      // KV → Bulk: serialise current rows into the textarea
      if (this.#paramsBulkEl)
        this.#paramsBulkEl.value = this.#kvRowsToText(this.#params);
    } else if (!nowBulk && this.#paramsBulkMode) {
      // Bulk → KV: parse textarea back to rows
      if (this.#paramsBulkEl)
        this.#params = this.#textToKvRows(this.#paramsBulkEl.value);
    }
    this.#paramsBulkMode = nowBulk;
    this.#applyParamsBulkMode();
    if (!nowBulk) this.#renderParamsList();
    this.#updateUrlPreview();
    this.#dispatchParamsUpdated();
  }

  #applyParamsBulkMode() {
    const bulk = this.#paramsBulkMode;
    if (this.#paramsBulkEl)
      this.#paramsBulkEl.style.display = bulk ? "" : "none";
    if (this.#paramsKvWrapEl)
      this.#paramsKvWrapEl.style.display = bulk ? "none" : "";
    if (this.#paramsAddBtnEl)
      this.#paramsAddBtnEl.style.display = bulk ? "none" : "";
    if (this.#paramsDelAllBtnEl)
      this.#paramsDelAllBtnEl.style.display = bulk ? "none" : "";
  }

  // ── Headers bulk editor ───────────────────────────────────────────────────

  #handleHeadersBulkToggle(nowBulk) {
    if (nowBulk && !this.#headersBulkMode) {
      if (this.#headersBulkEl)
        this.#headersBulkEl.value = this.#headerRowsToText(this.#headers);
    } else if (!nowBulk && this.#headersBulkMode) {
      if (this.#headersBulkEl)
        this.#headers = this.#textToHeaderRows(this.#headersBulkEl.value);
    }
    this.#headersBulkMode = nowBulk;
    this.#applyHeadersBulkMode();
    if (!nowBulk) this.#renderHeadersList();
    this.#dispatchHeadersUpdated();
  }

  #applyHeadersBulkMode() {
    const bulk = this.#headersBulkMode;
    if (this.#headersBulkEl)
      this.#headersBulkEl.style.display = bulk ? "" : "none";
    if (this.#headersKvWrapEl)
      this.#headersKvWrapEl.style.display = bulk ? "none" : "";
    if (this.#headersAddBtnEl)
      this.#headersAddBtnEl.style.display = bulk ? "none" : "";
    if (this.#headersDelAllBtnEl)
      this.#headersDelAllBtnEl.style.display = bulk ? "none" : "";
    // Hide the "List Headers" toggle (and its spacer) in bulk mode
    if (this.#listHdrSpacerEl)
      this.#listHdrSpacerEl.style.display = bulk ? "none" : "";
    if (this.#listHdrLabelEl)
      this.#listHdrLabelEl.style.display = bulk ? "none" : "";
    // Hide the autocomplete dropdown when entering bulk mode
    if (bulk) _hideHdrDropdown();
  }

  // ── Body form bulk editor ─────────────────────────────────────────────────

  #handleBodyFormBulkToggle(nowBulk) {
    if (nowBulk && !this.#bodyFormBulkMode) {
      if (this.#bodyFormBulkEl)
        this.#bodyFormBulkEl.value = this.#kvRowsToText(this.#bodyFormRows);
    } else if (!nowBulk && this.#bodyFormBulkMode) {
      if (this.#bodyFormBulkEl)
        this.#bodyFormRows = this.#textToKvRows(this.#bodyFormBulkEl.value);
    }
    this.#bodyFormBulkMode = nowBulk;
    this.#applyBodyFormBulkMode();
    if (!nowBulk) {
      // Tear down stale pill editors before rebuilding the KV list — each one
      // holds a document-level selectionchange listener that must be detached.
      for (const ed of this.#bodyFormPillEditors) ed.destroy?.();
      this.#bodyFormPillEditors = [];
      // Re-render the KV list so it reflects any edits made in bulk mode
      if (this.#bfListEl) {
        this.#bfListEl.innerHTML = "";
        if (!this.#bodyFormRows.length) {
          const empty = document.createElement("div");
          empty.className = "params-empty";
          empty.textContent = "No fields — click  +  to add one.";
          this.#bfListEl.appendChild(empty);
        } else {
          this.#bodyFormRows.forEach((row) =>
            this.#bfListEl.appendChild(
              this.#buildBfRow(row, this.#bodyFormRows),
            ),
          );
        }
      }
    }
    this.#dispatchBodyUpdated();
  }

  #applyBodyFormBulkMode() {
    this.#applyBulkMode(
      this.#bodyFormBulkMode,
      this.#bodyFormBulkEl,
      this.#bodyFormKvWrapEl,
      this.#bodyFormAddBtnEl,
      this.#bodyFormDelAllBtnEl,
    );
  }

  // ── Tab switching ─────────────────────────────────────────────────────────
  #switchTab(tabId) {
    this.#activeTab = tabId;
    this._tabStrip.querySelectorAll(".req-tab-btn").forEach((btn) => {
      const active = btn.dataset.tab === tabId;
      btn.classList.toggle("req-tab-btn--active", active);
      btn.setAttribute("aria-selected", String(active));
    });
    this._tabContent.querySelectorAll(".req-tab-pane").forEach((pane) => {
      pane.hidden = pane.id !== `req-tab-${tabId}`;
    });
  }

  // ── Event dispatch ────────────────────────────────────────────────────────
  #dispatchRequestUpdated() {
    if (!this.#currentNodeId) return;
    window.dispatchEvent(
      new CustomEvent("wurl:request-updated", {
        detail: {
          id: this.#currentNodeId,
          method: this.#method,
          url: this.#url,
        },
        bubbles: true,
      }),
    );
  }

  #dispatchParamsUpdated() {
    if (!this.#currentNodeId) return;
    window.dispatchEvent(
      new CustomEvent("wurl:request-updated", {
        detail: {
          id: this.#currentNodeId,
          params: this.#params.map((p) => ({ ...p })),
        },
        bubbles: true,
      }),
    );
  }

  #dispatchHeadersUpdated() {
    if (!this.#currentNodeId) return;
    window.dispatchEvent(
      new CustomEvent("wurl:request-updated", {
        detail: {
          id: this.#currentNodeId,
          headers: this.#headers.map((h) => ({ ...h })),
        },
        bubbles: true,
      }),
    );
  }

  // ── Send ─────────────────────────────────────────────────────────────────
  async #sendRequest(force = false) {
    const rawUrl = this.#urlPillEditor.getValue().trim();
    if (!rawUrl) {
      this.#urlPillEditor.focus();
      return;
    }

    // ── 0. Safety flush — if a bulk textarea is active, parse its current
    //       content now so in-progress edits (e.g. uncommitted IME) are
    //       captured even if the `input` event hasn't fired yet.
    if (this.#paramsBulkMode && this.#paramsBulkEl)
      this.#params = this.#textToKvRows(this.#paramsBulkEl.value);
    if (this.#headersBulkMode && this.#headersBulkEl)
      this.#headers = this.#textToHeaderRows(this.#headersBulkEl.value);
    if (this.#bodyFormBulkMode && this.#bodyFormBulkEl)
      this.#bodyFormRows = this.#textToKvRows(this.#bodyFormBulkEl.value);

    // ── Variable resolver helper ──────────────────────────────────────────
    // Resolve {{varName}} tokens using the current variable context so that
    // the actual HTTP request (and cURL output) use concrete values, not
    // template placeholders.
    const ctx = this.#variableContext;
    const rv = (s) => resolveStringAsync(s, ctx);

    // ── Variable pre-flight check ─────────────────────────────────────────
    // Before sending, collect every {{varName}} token from all request fields
    // and check whether each one resolves.  If any are unresolved and the
    // user hasn't already confirmed they want to proceed, show a warning
    // popup that lists all variables (resolved in success colour, unresolved
    // as "?" in error colour) with Cancel / Send Anyway options.
    if (!force) {
      const allVars = collectTemplateVariables(
        this.#gatherRequestTemplates(),
        ctx,
      );
      const badCount = allVars.filter((v) => !v.found).length;
      if (badCount > 0) {
        PopupManager.warnVariables({
          variables: allVars,
          actionLabel: "Send Anyway",
          onAction: () => this.#sendRequest(true),
        });
        return;
      }
    }

    // Preload response caches for any cross-request references before resolution
    if (this.#ensureResponseCaches) {
      const refs = _extractResponseFunctionRefs(this.#gatherRequestTemplates());
      if (refs.length)
        await this.#ensureResponseCaches(refs, this.#variableContext);
    }

    const baseUrl = _encodeBaseUrl(await rv(rawUrl));

    // ── 1. URL — append enabled, non-blank query parameters ──────────────
    const enabledParams = this.#params.filter(
      (p) => p.enabled && p.name.trim(),
    );
    let finalUrl = baseUrl;
    if (enabledParams.length) {
      const qs = (
        await Promise.all(
          enabledParams.map(
            async (p) =>
              `${encodeURIComponent(await rv(p.name))}=${encodeURIComponent(await rv(p.value))}`,
          ),
        )
      ).join("&");
      finalUrl += (baseUrl.includes("?") ? "&" : "?") + qs;
    }

    // ── 2. Headers — start with all enabled, non-blank request headers ────
    const headers = {};
    for (const h of this.#headers.filter((h) => h.enabled && h.name.trim())) {
      headers[(await rv(h.name)).trim()] = await rv(h.value);
    }

    // ── 3. Auth — inject Authorization (or other) headers if enabled ──────
    let awsIam = null;
    if (this.#authEnabled && this.#authType !== "none") {
      switch (this.#authType) {
        case "basic": {
          const username = await rv(this.#authBasic.username ?? "");
          const password = await rv(this.#authBasic.password ?? "");
          if (username || password) {
            headers["Authorization"] =
              `Basic ${btoa(`${username}:${password}`)}`;
          }
          break;
        }
        case "bearer":
          if (this.#authBearer.token)
            headers["Authorization"] =
              `Bearer ${await rv(this.#authBearer.token)}`;
          break;
        case "oauth2": {
          // ── User-supplied Authorization header wins ──────────────────────
          // If the user explicitly added a non-blank Authorization header in
          // the Headers tab, respect that value and skip all token acquisition.
          const _userAuthKey = Object.keys(headers).find(
            (k) => k.toLowerCase() === "authorization",
          );
          if (_userAuthKey && headers[_userAuthKey]?.trim()) break;

          // ── Signal loading while the OAuth flow runs ─────────────────────
          // This turns the Send button into "Stop" immediately so the user
          // can cancel a long-running popup before the request fires.
          window.dispatchEvent(new CustomEvent("wurl:request-loading"));

          // ── Acquire token (cache → refresh → full flow) ──────────────────
          let _oauthResult;
          try {
            _oauthResult = await oauthExecutor.acquireToken({
              ...this.#authOAuth2,
            });
          } catch (err) {
            window.dispatchEvent(
              new CustomEvent("wurl:request-error", {
                detail: {
                  request: {
                    method: this.#method,
                    url: finalUrl,
                    headers: {},
                    body: null,
                  },
                  name: "OAuthError",
                  message: err?.message ?? String(err),
                  hint: "OAuth token acquisition failed before the request could be sent.",
                  elapsed: 0,
                  consoleLog: [`* OAuth error: ${err?.message ?? err}`],
                },
              }),
            );
            return;
          }

          // ── Guard: user clicked Stop while the popup / token request was in flight ──
          if (!this.#requestInFlight) return;

          // ── Handle flow failure ──────────────────────────────────────────
          if (!_oauthResult.success || !_oauthResult.accessToken) {
            const _errCode = _oauthResult.error?.code ?? "OAuthError";
            const _errMsg = _oauthResult.error?.description ?? _errCode;
            window.dispatchEvent(
              new CustomEvent("wurl:request-error", {
                detail: {
                  request: {
                    method: this.#method,
                    url: finalUrl,
                    headers: {},
                    body: null,
                  },
                  name: _errCode,
                  message: _errMsg,
                  hint: "OAuth token acquisition failed. Check your OAuth configuration in the Auth tab.",
                  elapsed: 0,
                  consoleLog: [`* OAuth ${_errCode}: ${_errMsg}`],
                },
              }),
            );
            return;
          }

          // ── Inject bearer token ──────────────────────────────────────────
          // Read the prefix from the live DOM input (name="wurl-auth-header-prefix")
          // first — this covers any value typed but not yet committed to state —
          // then fall back to the in-memory state, then to the "Bearer" default.
          const _prefixEl = this.#el.querySelector(
            '[name="wurl-auth-header-prefix"]',
          );
          const _prefix =
            _prefixEl?.value?.trim() ||
            this.#authOAuth2.headerPrefix?.trim() ||
            "Bearer";
          headers["Authorization"] = `${_prefix} ${_oauthResult.accessToken}`;

          // Keep local auth state in sync (token display + expiry badge).
          this.#authOAuth2.token = _oauthResult.accessToken;
          this.#authOAuth2.refreshToken =
            _oauthResult.refreshToken ?? this.#authOAuth2.refreshToken ?? "";
          this.#authOAuth2.expiresAt =
            _oauthResult.expiresAt ?? this.#authOAuth2.expiresAt;
          this.#renderAuthContent();
          this.#dispatchAuthUpdated();
          break;
        }
        case "aws-iam": {
          awsIam = {
            accessKeyId: await rv(this.#authAwsIam.accessKeyId ?? ""),
            secretAccessKey: await rv(this.#authAwsIam.secretAccessKey ?? ""),
            region: await rv(this.#authAwsIam.region ?? ""),
            service: await rv(this.#authAwsIam.service ?? ""),
            sessionToken: await rv(this.#authAwsIam.sessionToken ?? ""),
          };
          break;
        }
      }
    }

    // ── 4. Body — build based on the selected body type ───────────────────
    // GET and HEAD must not carry a body.
    // All body types are serialised to a plain string (or null) so they can
    // be forwarded to the native layer (Electron IPC / Go dev server) which
    // cannot receive FormData, URLSearchParams, or File objects directly.
    const noBodyMethods = new Set(["GET", "HEAD"]);
    let body = null; // string | null
    let bodyFilePath = null; // absolute path for the "file" body type (Electron only)

    if (!noBodyMethods.has(this.#method)) {
      switch (this.#bodyType) {
        case "form-data": {
          // Build a multipart/form-data body manually so we get a plain string.
          const boundary = `----WurlBoundary${Date.now()}`;
          const enabled = this.#bodyFormRows.filter(
            (r) => r.enabled && r.name.trim(),
          );
          if (enabled.length > 0) {
            const parts = (
              await Promise.all(
                enabled.map(
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
        case "form-urlencoded": {
          const sp = new URLSearchParams();
          for (const r of this.#bodyFormRows.filter(
            (r) => r.enabled && r.name.trim(),
          )) {
            sp.append(await rv(r.name), await rv(r.value));
          }
          body = sp.toString();
          if (!headers["Content-Type"])
            headers["Content-Type"] = "application/x-www-form-urlencoded";
          break;
        }
        case "json":
          if (this.#bodyText.trim()) {
            body = await rv(this.#bodyText);
            if (!headers["Content-Type"])
              headers["Content-Type"] = "application/json";
          }
          break;
        case "yaml":
          if (this.#bodyText.trim()) {
            body = await rv(this.#bodyText);
            if (!headers["Content-Type"])
              headers["Content-Type"] = "application/x-yaml";
          }
          break;
        case "xml":
          if (this.#bodyText.trim()) {
            body = await rv(this.#bodyText);
            if (!headers["Content-Type"])
              headers["Content-Type"] = "application/xml";
          }
          break;
        case "text":
          if (this.#bodyText.trim()) {
            body = await rv(this.#bodyText);
            if (!headers["Content-Type"])
              headers["Content-Type"] = "text/plain";
          }
          break;
        case "file":
          if (this.#bodyFileObject) {
            // Electron exposes the real filesystem path via File.path.
            // In a plain browser context this will be undefined/empty.
            bodyFilePath = this.#bodyFileObject.path ?? "";
            if (!headers["Content-Type"])
              headers["Content-Type"] =
                this.#bodyFileObject.type || "application/octet-stream";
          }
          break;
        default:
          break; // "no-body" — leave body as null
      }
    }

    window.dispatchEvent(
      new CustomEvent("wurl:send-request", {
        detail: {
          method: this.#method,
          url: finalUrl,
          headers,
          body,
          bodyFilePath,
          awsIam,
        },
        bubbles: true,
      }),
    );
  }

  /**
   * Collect all template strings from the current request state so every
   * {{varName}} token can be checked before execution.
   * @returns {string[]}
   */
  #gatherRequestTemplates() {
    const t = [this.#urlPillEditor.getValue() ?? ""];
    for (const p of this.#params) {
      if (p.enabled) {
        t.push(p.name ?? "", p.value ?? "");
      }
    }
    for (const h of this.#headers) {
      if (h.enabled) {
        t.push(h.name ?? "", h.value ?? "");
      }
    }
    if (this.#authEnabled && this.#authType !== "none") {
      t.push(this.#authBasic?.username ?? "", this.#authBasic?.password ?? "");
      t.push(this.#authBearer?.token ?? "");
      t.push(this.#authOAuth2?.token ?? "");
    }
    // Only scan fields that will actually be sent — avoids false-positive
    // warnings for inactive body data retained while switching body types.
    const noBodyMethods = new Set(["GET", "HEAD"]);
    if (!noBodyMethods.has(this.#method)) {
      switch (this.#bodyType) {
        case "json":
        case "yaml":
        case "xml":
        case "text":
          t.push(this.#bodyText ?? "");
          break;
        case "form-data":
        case "form-urlencoded":
          for (const r of this.#bodyFormRows) {
            if (r.enabled) {
              t.push(r.name ?? "", r.value ?? "");
            }
          }
          break;
        default:
          break; // "no-body" / "file" — nothing to scan
      }
    }
    return t.filter(Boolean);
  }

  /**
   * Update the variable resolution context used by all active pill editors.
   * Call this whenever the selected request, collection, or folder variables
   * change so that pills are re-validated immediately.
   *
   * @param {{ envVariables?: object, folderChain?: object[] } | null} context
   */
  setVariableContext(context) {
    this.#variableContext = context;
    const allEditors = [
      this.#urlPillEditor,
      ...this.#paramPillEditors,
      ...this.#headerPillEditors,
      ...this.#bodyFormPillEditors,
      ...this.#authPillEditors,
    ].filter(Boolean);
    for (const editor of allEditors) {
      editor.revalidate();
    }
    this.#updateUrlPreview();
  }

  /** Set the callback used by function-pill popups to populate request-picker params. */
  setGetItems(fn) {
    this.#getItems = fn ?? (() => []);
  }

  /** Set the async hook called before send to preload response caches for referenced requests. */
  setEnsureResponseCaches(fn) {
    this.#ensureResponseCaches = fn ?? null;
  }

  /**
   * Apply persisted settings to the editor UI.
   * Called on startup after settings are loaded from disk.
   * @param {object} settings
   */
  applySettings(settings) {
    if (settings.listHeaders != null) {
      this.#headerSuggestionsEnabled = !!settings.listHeaders;
      // Sync the specific List Headers checkbox by ID
      const cb = this.#el.querySelector("#list-headers-toggle");
      if (cb) cb.checked = this.#headerSuggestionsEnabled;
      if (!this.#headerSuggestionsEnabled) _hideHdrDropdown();
    }
    if (settings.showUrlPreview != null) {
      this.#urlPreviewEnabled = !!settings.showUrlPreview;
      // Sync the Show URL checkbox by ID
      const cb = this.#el.querySelector("#url-preview-toggle");
      if (cb) cb.checked = this.#urlPreviewEnabled;
      this.#updateUrlPreview();
    }
    if (settings.removeHeaders != null) {
      this.#removeHeaders = !!settings.removeHeaders;
      this.#applyBodyFormHeaderRow();
    }
  }

  /** Show/hide the body-form column-label row to match the removeHeaders setting. */
  #applyBodyFormHeaderRow() {
    const hdr = this.#bodyFormKvWrapEl?.querySelector(".params-header-row");
    if (hdr) hdr.style.display = this.#removeHeaders ? "none" : "";
  }

  /**
   * Populate the editor from a saved request node.
   * @param {object} node
   */
  load(node) {
    this.#currentNodeId = node.id ?? null;
    this.#decryptErrors = new Set(
      Array.isArray(node._decryptErrors) ? node._decryptErrors : [],
    );

    // Cancel any in-progress inline confirm on the Delete All buttons.
    this._paramsDeleteAllCleanup?.();
    this._headersDeleteAllCleanup?.();
    this._bodyFormDeleteAllCleanup?.();

    if (node.method) {
      this.#method = node.method;
      this._methodSelLabel.textContent = node.method;
      this._methodSel.dataset.method = node.method.toLowerCase();
      this._sendBtn.dataset.method = node.method.toLowerCase();
    }

    const url = node.url ?? "";
    this.#url = url;
    this.#urlPillEditor.setValue(url);

    // Params
    this.#params = Array.isArray(node.params)
      ? node.params.map((p) => ({
          id: p.id ?? crypto.randomUUID(),
          name: p.name ?? "",
          value: p.value ?? "",
          enabled: p.enabled ?? true,
        }))
      : [];
    this.#renderParamsList();

    // Headers
    this.#headers = Array.isArray(node.headers)
      ? node.headers.map((h) => ({
          id: h.id ?? crypto.randomUUID(),
          name: h.name ?? "",
          value: h.value ?? "",
          enabled: h.enabled ?? true,
        }))
      : [];
    this.#renderHeadersList();

    // Body
    this.#bodyType = node.bodyType ?? "no-body";
    // Form rows — new unified format first, then legacy per-type fallbacks
    if (Array.isArray(node.bodyFormRows)) {
      this.#bodyFormRows = node.bodyFormRows.map((r) => ({
        id: r.id ?? crypto.randomUUID(),
        name: r.name ?? "",
        value: r.value ?? "",
        enabled: r.enabled ?? true,
      }));
    } else if (Array.isArray(node.bodyFormData)) {
      this.#bodyFormRows = node.bodyFormData.map((r) => ({
        id: r.id ?? crypto.randomUUID(),
        name: r.name ?? "",
        value: r.value ?? "",
        enabled: r.enabled ?? true,
      }));
    } else if (Array.isArray(node.bodyFormUrlEncoded)) {
      this.#bodyFormRows = node.bodyFormUrlEncoded.map((r) => ({
        id: r.id ?? crypto.randomUUID(),
        name: r.name ?? "",
        value: r.value ?? "",
        enabled: r.enabled ?? true,
      }));
    } else {
      this.#bodyFormRows = [];
    }
    // Text body — new unified format first, then legacy per-type dict
    if (node.bodyText != null) {
      this.#bodyText = node.bodyText;
    } else if (node.bodyTexts) {
      // Legacy: prefer the text stored for the current body type, then the first non-empty entry
      const bt = node.bodyTexts;
      this.#bodyText =
        bt[this.#bodyType] ?? bt.json ?? bt.yaml ?? bt.xml ?? bt.text ?? "";
    } else {
      this.#bodyText = "";
    }
    this.#bodyFilePath = node.bodyFilePath ?? "";
    this.#bodyFileObject = null;
    // Sync the select element if the body tab has been built
    const sel = this.#el.querySelector(".body-type-select");
    if (sel) sel.value = this.#bodyType;
    this.#renderBodyContent();

    // Auth
    this.#authType = node.authType ?? "none";
    this.#authEnabled = node.authEnabled ?? true;
    this.#authBasic = { username: "", password: "", ...(node.authBasic ?? {}) };
    this.#authBearer = { token: "", ...(node.authBearer ?? {}) };
    // Merge saved fields — default advanced fields to empty string / known defaults.
    // OIDC discovery fields are restored from the persisted node data so previously
    // discovered configurations survive a request reload.
    // Runtime-only token fields (token, refreshToken, expiresAt) are intentionally
    // excluded from the spread so previously-persisted tokens are never restored.
    {
      const {
        token: _t,
        refreshToken: _rt,
        expiresAt: _ea,
        ...savedOAuth2
      } = node.authOAuth2 ?? {};
      this.#authOAuth2 = {
        grantType: "client_credentials",
        clientType: "confidential",
        clientId: "",
        clientSecret: "",
        accessTokenUrl: "",
        authUrl: "",
        scope: "",
        token: "",
        refreshToken: "",
        expiresAt: null,
        state: "",
        credentials: "header",
        headerPrefix: "",
        audience: "",
        resource: "",
        origin: "",
        redirectUri: "",
        responseType: "access_token",
        username: "",
        password: "",
        discoveredIssuer: "",
        discoveredScopes: null,
        ...savedOAuth2,
      };
    }
    this.#authAwsIam = {
      accessKeyId: "",
      secretAccessKey: "",
      region: "",
      service: "",
      sessionToken: "",
      ...(node.authAwsIam ?? {}),
    };
    const authSel = this.#el.querySelector("#auth-type-select");
    if (authSel) authSel.value = this.#authType;
    const authEnabledCheck = this.#el.querySelector("#auth-enabled-check");
    if (authEnabledCheck) authEnabledCheck.checked = this.#authEnabled;
    this.#authContentEl?.classList.toggle(
      "auth-content--disabled",
      !this.#authEnabled,
    );
    // Sync Discover button, bulk-edit toggle, and enabled toggle visibility to match the restored auth type
    if (this.#discoverBtnEl)
      this.#discoverBtnEl.hidden = this.#authType !== "oauth2";
    if (this.#authBulkEl)
      this.#authBulkEl.classList.toggle("is-hidden", this.#authType === "none");
    if (this.#authEnabledLabelEl)
      this.#authEnabledLabelEl.classList.toggle(
        "is-hidden",
        this.#authType === "none",
      );
    this.#renderAuthContent();

    // Notes
    this.#notes = node.notes ?? "";
    if (this.#notesEl) this.#notesEl.value = this.#notes;
  }

  /**
   * Restore the request editor from a history snapshot (bulk-edit string format).
   * Converts the serialized strings back into structured arrays/objects and
   * delegates to load().
   * @param {object} snapshot
   */
  loadSnapshot(snapshot) {
    if (!snapshot) return;

    const node = {
      id: snapshot.id,
      method: snapshot.method ?? "GET",
      url: snapshot.url ?? "",
      params: this.#textToKvRows(snapshot.params ?? ""),
      headers: this.#textToHeaderRows(snapshot.headers ?? ""),
      authType: snapshot.authType ?? "none",
      authEnabled: snapshot.authEnabled ?? true,
      bodyType: snapshot.bodyType ?? "no-body",
      notes: snapshot.notes ?? "",
    };

    const kv = this.#parseBulkKVColon(snapshot.auth ?? "");
    if (node.authType === "basic") {
      node.authBasic = {
        username: kv.username ?? "",
        password: kv.password ?? "",
      };
    } else if (node.authType === "bearer") {
      node.authBearer = { token: kv.token ?? "" };
    } else if (node.authType === "oauth2") {
      node.authOAuth2 = {
        grantType: kv.grantType ?? "client_credentials",
        clientType: kv.clientType ?? "confidential",
        clientId: kv.clientId ?? "",
        clientSecret: kv.clientSecret ?? "",
        accessTokenUrl: kv.accessTokenUrl ?? "",
        authUrl: kv.authUrl ?? "",
        username: kv.username ?? "",
        password: kv.password ?? "",
        scope: kv.scope ?? "",
        responseType: kv.responseType ?? "",
        redirectUri: kv.redirectUri ?? "",
        state: kv.state ?? "",
        credentials: kv.credentials ?? "",
        audience: kv.audience ?? "",
        resource: kv.resource ?? "",
        origin: kv.origin ?? "",
        headerPrefix: kv.headerPrefix ?? "",
      };
    } else if (node.authType === "aws-iam") {
      node.authAwsIam = {
        accessKeyId: kv.accessKeyId ?? "",
        secretAccessKey: kv.secretAccessKey ?? "",
        region: kv.region ?? "",
        service: kv.service ?? "",
        sessionToken: kv.sessionToken ?? "",
      };
    }

    if (node.bodyType === "form-data" || node.bodyType === "form-urlencoded") {
      node.bodyFormRows = this.#textToKvRows(snapshot.body ?? "");
    } else if (node.bodyType === "file") {
      node.bodyFilePath = snapshot.body ?? "";
    } else {
      node.bodyText = snapshot.body ?? "";
    }

    this.load(node);
    return node;
  }

  /** Parse  key: value  lines into a plain object (used by loadSnapshot). */
  #parseBulkKVColon(text) {
    const out = {};
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const colon = t.indexOf(":");
      if (colon === -1) continue;
      const key = t.slice(0, colon).trim();
      const value = t.slice(colon + 1).trim();
      if (key) out[key] = value;
    }
    return out;
  }
}
