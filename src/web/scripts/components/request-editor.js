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
 * request-editor.js — Request definition panel component
 */

"use strict";

import {
  VariablePillEditor,
  getPickerDebounceMs,
} from "./variable-pill-editor.js";
import { PillCodeEditor } from "./pill-code-editor.js";
import {
  resolveStringAsync,
  collectTemplateVariables,
  tokenize,
  parseFunctionCall,
  isFunctionCall,
} from "./variable-resolver.js";
import { PopupManager } from "../popup-manager.js";
import { Notifications } from "../notifications.js";
import { icon } from "../icons.js";
import { t } from "../i18n.js";
import { bindingDisplay } from "../keymap.js";
import { oauthExecutor } from "../auth/oauth-executor.js";
import { resolveOAuth2Config } from "../auth/utils/resolve-config.js";
import {
  buildRequestPayload,
  encodeBaseUrl,
  detectPathParams,
  applyPathParams,
  resolvePathParamValues,
} from "./request-payload.js";
import { INTROSPECTION_QUERY } from "./graphql-schema.js";
import { executeIntrospection } from "./graphql-introspection.js";
import { GraphQLBodyEditor } from "./graphql-body-editor.js";
import { RequestAuthEditor } from "./request-auth-editor.js";
import { NotesEditor } from "./editors/notes-editor.js";
import { CapturesEditor } from "./editors/captures-editor.js";
import { ScriptsEditor } from "./editors/scripts-editor.js";
import { BodyEditor } from "./editors/body-editor.js";
import {
  DragReorderController,
  AutocompleteDropdown,
  buildToolbarToggle,
  buildKvRow,
  wireDeleteAllConfirm,
  applyBulkMode,
  kvRowsToText,
  headerRowsToText,
  textToKvRows,
  textToHeaderRows,
  disposePillEditors,
} from "./kv-editor-shared.js";

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

// AutocompleteDropdown (the shared combo-box mechanism) now lives in
// ./kv-editor-shared.js and is imported above; the two singletons below drive
// the header-name and header-value combo inputs. (The scope and API-key combo
// dropdowns live with the auth editor in ./request-auth-editor.js.)

// Two dropdown instances — one per combo input. _hdrAcOnSelect / _hdrValOnSelect
// hold the active name/value callbacks for the keyboard-accept paths.
const _hdrAc = new AutocompleteDropdown(
  "hdr-autocomplete",
  "Header suggestions",
);
let _hdrAcOnSelect = null;
const _hdrVal = new AutocompleteDropdown(
  "hdr-autocomplete hdr-val-autocomplete",
  "Header value suggestions",
);
let _hdrValOnSelect = null;

// ── Header-name suggestions dropdown ──────────────────────────────────────────

function _showHdrDropdown(input, onSelect) {
  // Store the on-select callback so the keyboard-accept path can fire it too.
  _hdrAcOnSelect = onSelect ?? null;

  const query = input.value.toLowerCase().trim();
  const allHeaders = Object.keys(STANDARD_HEADERS_DICT);
  const matches = query
    ? allHeaders.filter((h) => h.toLowerCase().includes(query))
    : allHeaders;

  _hdrAc.show(input, matches, (h) => {
    input.value = h;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    _hdrAc.hide();
    input.focus();
    _hdrAcOnSelect?.(h);
  });
}

/** Accept the currently keyboard-focused item, if any. */
function _hdrDropdownAccept(input) {
  const label = _hdrAc.activeLabel();
  if (label === null) return false;
  input.value = label;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  _hdrAc.hide();
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
function _showHdrValDropdown(anchorEl, values, onSelect) {
  _hdrValOnSelect = onSelect ?? null;
  _hdrVal.show(
    anchorEl,
    values,
    (v) => {
      _hdrVal.hide();
      _hdrValOnSelect?.(v);
      anchorEl.focus();
    },
    { minWidth: 220 },
  );
}

/** Accept the currently keyboard-focused value item, if any. */
function _hdrValDropdownAccept() {
  const label = _hdrVal.activeLabel();
  if (label === null) return false;
  _hdrVal.hide();
  _hdrValOnSelect?.(label);
  return true;
}

/** Returns true if the value-suggestions dropdown is currently visible. */
function _hdrValDropdownVisible() {
  return _hdrVal.visible;
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

// Tab labels resolve from the i18n catalog at render time (see #renderTabStrip);
// labelKey, not a literal, because these arrays are built at module load — before
// the catalog is ready.
const TABS = [
  { id: "params", labelKey: "request.tab.params" },
  { id: "headers", labelKey: "request.tab.headers" },
  { id: "body", labelKey: "request.tab.body" },
  { id: "auth", labelKey: "request.tab.auth" },
  { id: "captures", labelKey: "request.tab.captures" },
  { id: "scripts", labelKey: "request.tab.scripts" },
  { id: "notes", labelKey: "request.tab.notes" },
];

// Tabs for a WebSocket request (Feature 32): the Body tab is replaced by the
// Message composer. Params/Headers/Auth apply to the handshake; Notes are shared.
const WS_TABS = [
  { id: "params", labelKey: "request.tab.params" },
  { id: "headers", labelKey: "request.tab.headers" },
  { id: "message", labelKey: "request.tab.message" },
  { id: "auth", labelKey: "request.tab.auth" },
  { id: "captures", labelKey: "request.tab.captures" },
  { id: "notes", labelKey: "request.tab.notes" },
];

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

// DragReorderController (the shared phantom-placeholder drag-to-reorder
// machinery used by params, headers, and the body-form rows) now lives in
// ./kv-editor-shared.js and is imported above.

// ── Pre-request scripting helpers (Feature 25) ───────────────────────────
// Pure adapters between the editor's internal request shape (KV rows, scoped
// variable maps) and the flat { method, url, headers, body } / scope-map view
// the sandboxed `hippo.*` API exposes. Kept module-level so they stay testable.

/** Enabled, named KV rows → a plain `{ name: value }` object (last wins). */
function headerRowsToObject(rows) {
  const out = {};
  for (const r of rows ?? []) {
    if (r && r.enabled !== false && (r.name ?? "").trim() !== "")
      out[r.name] = r.value ?? "";
  }
  return out;
}

/**
 * Apply a script's mutated headers object back onto the editor's KV rows:
 * upsert by case-insensitive name, append unseen names. Operates on a copy —
 * the editor's own `#headers` is never mutated by a send. (Header deletion from
 * a script is not supported in v1.)
 */
function applyHeaderPatch(rows, patchObj) {
  const next = (rows ?? []).map((r) => ({ ...r }));
  for (const [name, value] of Object.entries(patchObj ?? {})) {
    const i = next.findIndex(
      (r) => (r.name ?? "").toLowerCase() === name.toLowerCase(),
    );
    if (i >= 0) {
      next[i].value = value == null ? "" : String(value);
      next[i].enabled = true;
    } else {
      next.push({
        id: crypto.randomUUID(),
        name,
        value: value == null ? "" : String(value),
        enabled: true,
      });
    }
  }
  return next;
}

/** Flatten a resolver folder chain to one map, nearest-folder-wins. */
function flattenFolderChain(folderChain) {
  const out = {};
  const chain = Array.isArray(folderChain) ? folderChain : [];
  for (let i = chain.length - 1; i >= 0; i--) {
    Object.assign(out, chain[i]?.variables ?? {});
  }
  return out;
}

/**
 * Return a shallow-cloned variable context with the script's writes merged into
 * the matching scope maps, so a {{var}} a pre-request script set resolves for
 * the current send. The editor's live context is left untouched.
 */
function augmentVariableContext(ctx, writes) {
  if (!ctx || !Array.isArray(writes) || writes.length === 0) return ctx;
  const next = {
    ...ctx,
    globalVariables: { ...(ctx.globalVariables ?? {}) },
    environmentVariables: { ...(ctx.environmentVariables ?? {}) },
    collectionVariables: { ...(ctx.collectionVariables ?? {}) },
  };
  const target = {
    global: next.globalVariables,
    environment: next.environmentVariables,
    collection: next.collectionVariables,
  };
  for (const w of writes) {
    if (target[w.scope]) target[w.scope][w.name] = w.value;
  }
  return next;
}

export class RequestEditor {
  /** @type {HTMLElement} */
  #el;
  #method = "GET";
  #url = "";
  #activeTab = "params";
  #currentNodeId = null;
  /** Pre-request / after-response script source (Feature 25). */
  #preRequestScript = "";
  #afterResponseScript = "";
  /** Whether the pre-request script runs (the send path reads this gate). */
  #preRequestScriptEnabled = true;
  /**
   * Caches the pre-request script result for a single send so a "Send anyway"
   * retry (which re-enters #sendRequest with force=true) does not run the
   * script twice. Keyed by the request id; cleared after dispatch and on load.
   */
  #preScriptCache = null;

  // Structural element refs, cached after the #render* builders run.
  #methodSel = null; // method-selector trigger button
  #methodSelLabel = null; // label span inside the method selector
  #sendBtn = null; // HTTP send button (in-flight toggle target)
  #urlInput = null; // the URL editor's element
  #tabStrip = null; // tab-button strip
  #tabContent = null; // tab-pane container

  // Params state
  #params = []; // [{ id, name, value, enabled }]
  // Path params (Feature 49) — derived from `:name`/`{name}` tokens in the URL,
  // rendered below the query params in the same table. [{ id, name, value, style }].
  #pathParams = [];
  #paramsListEl = null;
  #urlPreviewEnabled = true; // toggled by "Show URL" checkbox
  #urlPreviewEl = null; // the preview bar element
  #urlPreviewInputEl = null; // the read-only input inside it
  #urlPreviewSeq = 0; // generation counter — guards against stale async results
  // Drag-to-reorder (phantom-placeholder pattern; see DragReorderController)
  #paramsDrag = new DragReorderController({
    getItems: () => this.#params,
    render: () => this.#renderParamsList(),
    dispatch: () => this.#dispatchParamsUpdated(),
  });

  // Headers state
  #headers = []; // [{ id, name, value, enabled }]
  #headersListEl = null;
  #headerSuggestionsEnabled = true; // toggled by "List Headers" checkbox
  #headersDrag = new DragReorderController({
    getItems: () => this.#headers,
    render: () => this.#renderHeadersList(),
    dispatch: () => this.#dispatchHeadersUpdated(),
  });

  // Auth — owned by the RequestAuthEditor sub-component (see #auth).
  /** @type {RequestAuthEditor} */
  #auth;

  // Notes tab — delegated to a sub-editor that owns the value + textarea.
  #notesEditor = new NotesEditor({
    onChange: () => this.#dispatchNotesUpdated(),
  });

  // Captures tab (Feature 03) — post-response rules, delegated to a sub-editor
  // that owns the rule list + its DOM.
  #capturesEditor = new CapturesEditor({
    onChange: () => this.#dispatchCapturesUpdated(),
  });

  // Scripts tab (Feature 25) — pre-request / after-response JS panes, delegated
  // to a sub-editor that owns the two sources. It builds its code panes through
  // the shared factory so they register for disposal + view-setting sync.
  #scriptsEditor = new ScriptsEditor({
    makeCodeEditor: (opts) => this.#makeCodeEditor(opts),
    onChange: () => this.#dispatchScriptsUpdated(),
  });

  // GraphQL body (Feature 34) — the Query + Variables composer, schema fetch,
  // autocomplete, validation and split layout are owned by GraphQLBodyEditor.
  // RequestEditor injects the request-coupled pieces: the shared code-editor
  // factory (so the Query/Variables panes register in #codeEditors and follow
  // view-setting changes / disposal), the app layout (for split orientation),
  // setting persistence, the body-changed hook, the introspection-debounce, and
  // the introspection fetch (POSTed with the current URL/params/headers/auth).
  // Everything else is delegated: setValue/getValue/reset/onLayoutChanged/
  // setVarsFraction/setRemoveHeaders, plus mount/unmount per body re-render.
  #graphql = new GraphQLBodyEditor({
    makeCodeEditor: (opts) => this.#makeCodeEditor(opts),
    getLayout: () => {
      const v = Number(document.getElementById("app-main")?.dataset.layout);
      return v >= 1 && v <= 4 ? v : 2;
    },
    persistSetting: (detail) => this.#persistGqlSetting(detail),
    onChange: () => this.#dispatchBodyUpdated(),
    fetchIntrospection: () => this.#fetchIntrospection(),
    getPickerDebounceMs: () => getPickerDebounceMs(),
  });
  // PillCodeEditor view preferences — global, persisted (via
  // hippo:editor-setting-changed), and shared by every code editor (body text,
  // GraphQL Query/Variables, WebSocket message). Each editor's right-click menu
  // toggles one of these and fires `pce:setting-change`; #makeCodeEditor mirrors
  // the change onto all live editors and persists it. `folding` keeps the legacy
  // `editorFolding` settings key for backward compatibility.
  #editorView = {
    wrap: false,
    lineNumbers: true,
    folding: true,
    highlight: true,
  };
  // Live PillCodeEditor instances, so a view-setting change applies to all of
  // them at once and they can be torn down (destroy()) on re-render.
  #codeEditors = new Set();

  // Body tab — delegated to a sub-editor that owns the body state + DOM (every
  // body type except the request-coupled GraphQL introspection fetch, which
  // stays in #fetchIntrospection and is injected). The GraphQL composer instance
  // is shared: this editor mounts/unmounts it for rendering, while
  // load()/payload/applySettings drive its value + settings directly.
  #bodyEditor = new BodyEditor({
    onChange: () => this.#dispatchBodyUpdated(),
    makeCodeEditor: (opts) => this.#makeCodeEditor(opts),
    disposeCodeEditors: () => this.#disposeCodeEditors(),
    graphql: this.#graphql,
    getItems: () => this.#getItems(),
    ensureResponseCaches: (names) => this.#ensureResponseCaches?.(names),
  });

  // WebSocket state (Feature 32) — `protocol` distinguishes a ws request from an
  // HTTP one and selects the layout (WS pill + Message tab vs method + Body).
  // The live connection lives in the main process / app.js; the editor tracks
  // only enough to label the Connect button and enable the composer's Send.
  #protocol = "http"; // "http" | "websocket"
  #renderedProtocol = "http"; // protocol the current DOM was built for
  #wsMessage = ""; // last composed message (persisted)
  #wsMessageFormat = "text"; // "text" | "json" (persisted)
  #wsSubprotocols = ""; // comma-separated handshake subprotocols (persisted)
  #wsState = "idle"; // idle|connecting|open|closing|closed|error (session-only)
  #wsMessageEl = null; // composer PillCodeEditor instance
  #wsSubprotoEl = null; // subprotocols <input>
  #wsSendBtn = null; // composer Send button
  #wsConnectBtn = null; // url-bar Connect/Disconnect button
  #syncWsFormatButtons = null; // refreshes the Text/JSON toggle from state

  // Params bulk editor
  #paramsBulkMode = false;
  #paramsBulkEl = null; // <textarea> shown in bulk mode
  #paramsKvWrapEl = null; // div wrapping col-headers + list
  #paramsAddBtnEl = null; // hidden in bulk mode
  #paramsDelAllBtnEl = null; // hidden in bulk mode
  #paramsDeleteAllCleanup = null; // teardown for the params delete-all confirm

  // Headers bulk editor
  #headersBulkMode = false;
  #headersBulkEl = null;
  #headersKvWrapEl = null;
  #headersAddBtnEl = null;
  #headersDelAllBtnEl = null;
  #listHdrSpacerEl = null; // spacer before "List Headers" toggle
  #listHdrLabelEl = null; // "List Headers" toggle label
  #headersDeleteAllCleanup = null; // teardown for the headers delete-all confirm

  // Global "Remove Headers" setting — forwarded to the body + GraphQL editors.
  #removeHeaders = false;

  // IDs of requests currently in flight. Requests run concurrently, so the
  // Send/Stop button reflects only the request loaded in the editor.
  #inFlightIds = new Set();

  // requestId → streamId for in-flight live streams (Feature 33). A streaming
  // response keeps its request "in flight" (the Send button stays Stop) until the
  // stream ends; the streamId lets a Stop click abort that stream.
  #streamingReqs = new Map();

  // ── Variable pill editor support ───────────────────────────────────────────
  /** Current variable resolution context: { collectionVariables, folderChain, … } */
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

  constructor() {
    this.#el = document.createElement("div");
    this.#el.className = "request-editor";

    // The Auth tab is owned by a dedicated sub-component. Construct it before
    // #renderTabContent() so #buildTabPane("auth") can mount its element.
    this.#auth = new RequestAuthEditor({
      getContext: () => this.#variableContext,
      getItems: () => this.#getItems(),
      ensureResponseCaches: (names) => this.#ensureResponseCaches?.(names),
      getCurrentNodeId: () => this.#currentNodeId,
    });

    this.#renderUrlBar();
    this.#renderTabStrip();
    this.#renderTabContent();

    // Reflect the active WebSocket connection's state (dispatched by app.js for
    // the selected request) on the Connect button and the composer's Send button.
    window.addEventListener("hippo:ws-state", (e) => {
      this.#applyWsState(e.detail?.state ?? "idle");
    });

    // HTTP send-button in-flight toggle. Registered once here (not in
    // #renderUrlBar, which can re-run on a protocol switch) and operating on the
    // current this.#sendBtn, so no listeners leak across rebuilds. No-op in
    // WebSocket mode, which has a Connect button driven by #applyWsState instead.
    // Each lifecycle event carries the requestId it belongs to (requests run
    // concurrently); events without one — history replays — fall back to the
    // loaded request, matching the pre-concurrency reset behavior.
    window.addEventListener("hippo:request-loading", (e) => {
      this.#inFlightIds.add(e.detail?.requestId ?? this.#currentNodeId);
      this.#applySendButtonState();
    });
    const settleSendBtn = (e) => {
      const rid = e.detail?.requestId ?? this.#currentNodeId;
      this.#inFlightIds.delete(rid);
      this.#streamingReqs.delete(rid);
      this.#applySendButtonState();
    };
    // A live streaming response (Feature 33) keeps its request in flight: the body
    // arrives over hippo:stream-* and the Send button stays "Stop" until the stream
    // actually ends. Record the streamId so a Stop click can abort that stream;
    // settle on hippo:stream-end/-error instead of on the streaming marker.
    window.addEventListener("hippo:response-received", (e) => {
      if (e.detail?.streaming === true) {
        const rid = e.detail?.requestId ?? this.#currentNodeId;
        if (e.detail?.streamId) this.#streamingReqs.set(rid, e.detail.streamId);
        this.#applySendButtonState();
      } else {
        settleSendBtn(e);
      }
    });
    window.addEventListener("hippo:request-error", settleSendBtn);
    const settleStream = (e) => {
      const sid = e.detail?.streamId;
      if (sid == null) return;
      for (const [rid, s] of this.#streamingReqs) {
        if (s !== sid) continue;
        this.#streamingReqs.delete(rid);
        this.#inFlightIds.delete(rid);
      }
      this.#applySendButtonState();
    };
    window.addEventListener("hippo:stream-end", settleStream);
    window.addEventListener("hippo:stream-error", settleStream);

    // The GraphQL Query/Variables split orientation tracks the app layout: the
    // side-by-side layout stacks the panes, wider layouts place them side by
    // side. The editor re-applies in place when mounted, else stores it for next
    // mount.
    window.addEventListener("hippo:layout-changed", (e) => {
      this.#graphql.onLayoutChanged(e.detail?.layout);
    });
  }

  /** Root DOM element — pass to Panel.mount(). */
  get element() {
    return this.#el;
  }

  /**
   * Move keyboard focus to the active URL editor (HTTP or WebSocket — whichever
   * the current protocol rendered). Driven by the ⌘/Ctrl+L shortcut.
   */
  focusUrl() {
    this.#urlPillEditor?.focus();
  }

  /** True when the request currently loaded in the editor is in flight. */
  #currentRequestInFlight() {
    return this.#inFlightIds.has(this.#currentNodeId);
  }

  /**
   * Sync the Send/Stop button with the in-flight state of the LOADED request.
   * Called on lifecycle events and on load(), so switching to a running
   * request shows Stop and switching to an idle one shows Send.
   */
  #applySendButtonState() {
    const b = this.#sendBtn;
    if (!b || this.#protocol === "websocket") return;
    if (this.#currentRequestInFlight()) {
      b.textContent = t("request.stop");
      b.setAttribute("aria-label", t("request.stopAria"));
      b.classList.add("req-send-btn--cancel");
    } else {
      b.textContent = t("request.send");
      b.setAttribute("aria-label", t("request.sendAria"));
      b.classList.remove("req-send-btn--cancel");
    }
  }

  // ── URL bar ─────────────────────────────────────────────────────────────
  #renderUrlBar() {
    if (this.#protocol === "websocket") {
      this.#renderWsUrlBar();
      return;
    }
    const bar = document.createElement("div");
    bar.className = "req-url-bar";

    // Method selector
    const methodLabel = document.createElement("span");
    methodLabel.className = "req-method-select-label";
    methodLabel.textContent = this.#method;

    const methodSel = document.createElement("button");
    methodSel.className = "req-method-select";
    methodSel.setAttribute("aria-label", t("request.method.aria"));
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
      icon("caret", { size: null, className: "req-method-select-chevron" }),
    );

    let _methodMenu = null;
    // Drops the stale reference when PopupManager closes the menu by any path
    // (item select, custom Enter, mask click, window resize) — all fire
    // hippo:popup-closed — so the next trigger click re-opens.
    const _onMethodMenuClosed = () => {
      _methodMenu = null;
    };
    const _closeMethodMenu = () => {
      if (!_methodMenu) return;
      // PopupManager.close() fires hippo:popup-closed → _onMethodMenuClosed.
      PopupManager.close();
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
      menu.setAttribute("aria-label", t("request.method.aria"));
      menu.addEventListener("mousedown", (ev) => ev.preventDefault());

      const _CHECK = icon("check", {
        size: 12,
        className: "req-method-menu-check-icon",
      });

      HTTP_METHODS.forEach((m) => {
        const item = document.createElement("div");
        item.className = "req-method-menu-item";
        item.setAttribute("role", "option");
        item.setAttribute("aria-selected", String(m === this.#method));
        item.dataset.method = m.toLowerCase();
        // In icon mode the row shows a glyph, so name it via a tooltip.
        if (document.documentElement.classList.contains("show-method-icons"))
          item.title = m;
        if (m === this.#method)
          item.classList.add("req-method-menu-item--selected");
        item.innerHTML = `<span class="req-method-menu-item-check" aria-hidden="true">${_CHECK}</span><span class="req-method-menu-item-label">${m}</span>`;
        item.addEventListener("mousedown", (ev) => {
          ev.preventDefault();
          this.#method = m;
          methodLabel.textContent = m;
          methodSel.dataset.method = m.toLowerCase();
          if (this.#sendBtn) this.#sendBtn.dataset.method = m.toLowerCase();
          _closeMethodMenu();
          this.#dispatchRequestUpdated();
        });
        menu.appendChild(item);
      });

      const sep = document.createElement("div");
      sep.className = "req-method-menu-separator";
      menu.appendChild(sep);

      const isCustom = !HTTP_METHODS.includes(this.#method);
      const customRow = document.createElement("div");
      customRow.className = "req-method-menu-custom-row";
      customRow.innerHTML = `<span class="req-method-menu-item-check" aria-hidden="true">${_CHECK}</span>`;
      if (isCustom) customRow.classList.add("req-method-menu-item--selected");

      const customInput = document.createElement("input");
      customInput.className = "req-method-menu-custom-input";
      customInput.type = "text";
      // size=1 keeps the input from dictating the menu's max-content width;
      // flex:1 then grows it to fill the width set by the widest method row.
      customInput.size = 1;
      customInput.placeholder = t("request.method.customPlaceholder");
      customInput.setAttribute("aria-label", t("request.method.customAria"));
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
        if (this.#sendBtn) this.#sendBtn.dataset.method = m.toLowerCase();
        _closeMethodMenu();
        this.#dispatchRequestUpdated();
      });
      customRow.appendChild(customInput);
      menu.appendChild(customRow);

      const r = methodSel.getBoundingClientRect();
      PopupManager.openMenu(menu, r.left, r.bottom + 4);
      _methodMenu = menu;

      // openMenu owns the click-capturing mask (replacing the old bespoke
      // outside-click handler) and fires hippo:popup-opened. A mask click or
      // window resize closes via PopupManager and fires hippo:popup-closed —
      // listen once to drop our reference (see _onMethodMenuClosed).
      window.addEventListener("hippo:popup-closed", _onMethodMenuClosed, {
        once: true,
      });
    });

    // URL pill editor — replaces the plain <input type="url">
    const urlEditor = new VariablePillEditor({
      placeholder: "https://api.example.com/endpoint",
      ariaLabel: t("request.url.aria"),
      className: "req-url-input",
      getContext: () => this.#variableContext,
      getItems: () => this.#getItems(),
      ensureResponseCaches: (names) => this.#ensureResponseCaches?.(names),
      onInput: (v) => {
        this.#url = v.trim();
        // Re-derive the path-param rows from the URL; re-render the Params list
        // only when the token set actually changed (add/remove/restyle).
        const pathChanged = this.#reconcilePathParamsFromUrl();
        this.#dispatchRequestUpdated();
        if (pathChanged) {
          this.#dispatchPathParamsUpdated();
          this.#renderParamsList();
        }
        this.#updateUrlPreview();
      },
      onEnter: () => this.#sendRequest(),
      onPaste: (text) => this.#maybeHandleCurlPaste(text),
    });
    this.#urlPillEditor = urlEditor;

    // Send / Cancel button. Whether the collection's cookie jar is attached to
    // each request is governed per-collection via the Collections editor's
    // "Send cookies" checkbox (not a per-request toggle here).
    const sendGroup = document.createElement("div");
    sendGroup.className = "req-send-group";

    const sendBtn = document.createElement("button");
    sendBtn.className = "btn req-send-btn";
    sendBtn.dataset.method = this.#method.toLowerCase();
    sendBtn.textContent = t("request.send");
    sendBtn.setAttribute("aria-label", t("request.sendAria"));
    sendBtn.title = t("request.sendTitle", { keys: bindingDisplay("send") });
    sendBtn.addEventListener("click", () => {
      if (this.#currentRequestInFlight()) {
        window.dispatchEvent(
          new CustomEvent("hippo:cancel-request", {
            detail: {
              requestId: this.#currentNodeId,
              // For a live stream, carry its id so the cancel aborts the stream
              // (Feature 33) rather than the already-resolved execution.
              streamId: this.#streamingReqs.get(this.#currentNodeId) ?? null,
            },
          }),
        );
      } else {
        this.#sendRequest();
      }
    });

    // The in-flight toggle (request-loading / response-received / request-error)
    // is registered once in the constructor and targets this.#sendBtn, so a
    // protocol-driven rebuild of the URL bar can't accumulate stale listeners.
    sendGroup.appendChild(sendBtn);

    bar.appendChild(methodSel);
    bar.appendChild(urlEditor.element);
    bar.appendChild(sendGroup);
    this.#el.appendChild(bar);

    this.#methodSel = methodSel;
    this.#methodSelLabel = methodLabel;
    this.#sendBtn = sendBtn;
    // Keep _urlInput as a compatibility shim pointing at the editor's element
    // so any external code that reads _urlInput.focus() still works.
    this.#urlInput = urlEditor.element;
  }

  // ── WebSocket URL bar (Feature 32) ────────────────────────────────────────
  // A static "WS" pill stands in for the HTTP method selector; the Send button
  // becomes a Connect/Disconnect toggle driven by the live connection state.
  #renderWsUrlBar() {
    const bar = document.createElement("div");
    bar.className = "req-url-bar";

    const wsLabel = document.createElement("span");
    wsLabel.className = "req-method-select req-method-select--ws";
    wsLabel.setAttribute("aria-label", t("request.ws.label"));
    const lbl = document.createElement("span");
    lbl.className = "req-method-select-label";
    lbl.textContent = t("request.ws.badge");
    wsLabel.appendChild(lbl);

    const urlEditor = new VariablePillEditor({
      placeholder: "wss://echo.example.com",
      ariaLabel: t("request.ws.urlAria"),
      className: "req-url-input",
      getContext: () => this.#variableContext,
      getItems: () => this.#getItems(),
      ensureResponseCaches: (names) => this.#ensureResponseCaches?.(names),
      onInput: (v) => {
        this.#url = v.trim();
        this.#dispatchRequestUpdated();
      },
      onEnter: () => this.#toggleWsConnection(),
    });
    this.#urlPillEditor = urlEditor;

    const sendGroup = document.createElement("div");
    sendGroup.className = "req-send-group";

    const connectBtn = document.createElement("button");
    connectBtn.type = "button";
    connectBtn.className = "btn req-send-btn";
    connectBtn.dataset.method = "ws";
    connectBtn.textContent = t("request.ws.connect");
    connectBtn.setAttribute("aria-label", t("request.ws.connectAria"));
    connectBtn.addEventListener("click", () => this.#toggleWsConnection());
    this.#wsConnectBtn = connectBtn;
    sendGroup.appendChild(connectBtn);

    bar.append(wsLabel, urlEditor.element, sendGroup);
    this.#el.appendChild(bar);
    this.#urlInput = urlEditor.element;
    // Apply whatever connection state is current so a re-render shows the right label.
    this.#applyWsState(this.#wsState);
  }

  /** Tabs to render for the current protocol. */
  #tabsForProtocol() {
    return this.#protocol === "websocket" ? WS_TABS : TABS;
  }

  /**
   * Rebuild the URL bar, tab strip and tab panes for the current #protocol.
   * Called from load() when a request switches between HTTP and WebSocket so the
   * correct controls render. Field values are repopulated by load() afterwards.
   */
  #rebuildLayout() {
    this.#renderedProtocol = this.#protocol;
    // Tear down PillCodeEditors (body text / GraphQL / WS message) before the
    // DOM is wiped, so their document + ResizeObserver listeners are removed.
    this.#disposeCodeEditors();
    // Drop stale element refs the render methods will reassign.
    this.#methodSel = this.#methodSelLabel = this.#sendBtn = null;
    this.#wsConnectBtn = this.#wsSendBtn = null;
    this.#wsMessageEl = this.#wsSubprotoEl = null;
    this.#syncWsFormatButtons = null;
    // Keep the active tab valid for the new protocol.
    const ids = this.#tabsForProtocol().map((t) => t.id);
    if (!ids.includes(this.#activeTab)) this.#activeTab = ids[0];
    this.#el.innerHTML = "";
    this.#renderUrlBar();
    this.#renderTabStrip();
    this.#renderTabContent();
  }

  // ── WebSocket message composer (Feature 32) ───────────────────────────────
  #buildMessageEditor() {
    const container = document.createElement("div");
    container.className = "params-editor ws-composer";

    const bar = document.createElement("div");
    bar.className = "ws-composer-bar";

    // Text / JSON format toggle — a single icon button (mirroring the
    // form-data type toggle) whose glyph shows the CURRENT format and flips
    // to the other on click. "Aa" = plain text, "{ }" = JSON.
    const fmt = document.createElement("button");
    fmt.type = "button";
    fmt.className = "icon-btn ws-composer-format";
    this.#syncWsFormatButtons = () => {
      const isJson = this.#wsMessageFormat === "json";
      fmt.innerHTML = icon(isJson ? "json" : "text", { size: 14 });
      const label = isJson
        ? t("request.ws.msgFormatToText")
        : t("request.ws.msgFormatToJson");
      fmt.title = label;
      fmt.setAttribute("aria-label", label);
    };
    fmt.addEventListener("click", () => {
      this.#wsMessageFormat =
        this.#wsMessageFormat === "json" ? "text" : "json";
      this.#syncWsFormatButtons();
      // Re-language the editor so highlighting matches the chosen format.
      this.#wsMessageEl?.setLanguage(
        this.#wsMessageFormat === "json" ? "json" : "text",
      );
      this.#dispatchWsFieldUpdate({ wsMessageFormat: this.#wsMessageFormat });
    });
    this.#syncWsFormatButtons();

    const subproto = document.createElement("input");
    subproto.type = "text";
    subproto.className = "ws-composer-subproto";
    subproto.placeholder = t("request.ws.subprotoPlaceholder");
    subproto.value = this.#wsSubprotocols;
    subproto.setAttribute("aria-label", t("request.ws.subprotoAria"));
    subproto.addEventListener("input", () => {
      this.#wsSubprotocols = subproto.value;
      this.#dispatchWsFieldUpdate({ wsSubprotocols: subproto.value });
    });
    this.#wsSubprotoEl = subproto;

    const sendBtn = document.createElement("button");
    sendBtn.type = "button";
    sendBtn.className = "ws-composer-send";
    sendBtn.textContent = t("request.ws.send");
    sendBtn.disabled = this.#wsState !== "open";
    sendBtn.setAttribute("aria-label", t("request.ws.sendAria"));
    sendBtn.addEventListener("click", () => this.#sendWebSocketMessage());
    this.#wsSendBtn = sendBtn;

    bar.append(fmt, subproto, sendBtn);

    // The message body is a PillCodeEditor (text or JSON, per the format toggle).
    // Rich (inline) errors are disabled; the composer has no validity badge.
    const editor = this.#makeCodeEditor({
      language: this.#wsMessageFormat === "json" ? "json" : "text",
      richErrors: false,
      value: this.#wsMessage,
      placeholder: t("request.ws.messagePlaceholder"),
      onInput: (v) => {
        this.#wsMessage = v;
        this.#dispatchWsFieldUpdate({ wsMessage: v });
      },
    });
    editor.element.classList.add("ws-composer-editor");
    // ⌘/Ctrl+Enter sends; capture so we pre-empt the editor's newline insertion.
    editor.element.addEventListener(
      "keydown",
      (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          this.#sendWebSocketMessage();
        }
      },
      true,
    );
    this.#wsMessageEl = editor;

    const hint = document.createElement("div");
    hint.className = "ws-composer-hint";
    hint.textContent = t("request.ws.hint");

    container.append(bar, editor.element, hint);
    return container;
  }

  /** Connect (when idle/closed) or disconnect (when active). */
  #toggleWsConnection() {
    if (this.#wsState === "open" || this.#wsState === "connecting") {
      window.dispatchEvent(
        new CustomEvent("hippo:ws-disconnect", { detail: {}, bubbles: true }),
      );
    } else {
      this.#connectWebSocket();
    }
  }

  /**
   * Resolve the URL + handshake headers (reusing buildRequestPayload so bearer /
   * basic / apikey auth become handshake headers exactly as on the HTTP path)
   * and ask app.js to open the connection.
   */
  async #connectWebSocket() {
    const rawUrl = this.#urlPillEditor.getValue().trim();
    if (!rawUrl) {
      this.#urlPillEditor.focus();
      return;
    }
    const ctx = this.#variableContext;
    const rv = (s) => resolveStringAsync(s, ctx);
    const authModel = this.#auth.getModel();
    let payload;
    try {
      payload = await buildRequestPayload(
        {
          method: "GET",
          urlBase: encodeBaseUrl(await rv(rawUrl)),
          params: this.#params,
          headers: this.#headers,
          authEnabled: authModel.authEnabled,
          authType: authModel.authType,
          authBasic: authModel.authBasic,
          authBearer: authModel.authBearer,
          authApiKey: authModel.authApiKey,
          authDigest: authModel.authDigest,
          authNtlm: authModel.authNtlm,
          authAwsIam: authModel.authAwsIam,
          bodyType: "no-body",
        },
        rv,
      );
    } catch {
      return; // a malformed URL/auth surfaces nothing — leave state untouched
    }
    const subprotocols = (await rv(this.#wsSubprotocols ?? "")).trim();
    window.dispatchEvent(
      new CustomEvent("hippo:ws-connect", {
        detail: {
          url: payload.finalUrl,
          headers: payload.headers,
          subprotocols,
        },
        bubbles: true,
      }),
    );
  }

  /** Resolve {{var}} tokens in the composed message and send it. */
  async #sendWebSocketMessage() {
    if (this.#wsState !== "open") return;
    const raw = this.#wsMessageEl
      ? this.#wsMessageEl.getValue()
      : this.#wsMessage;
    const data = await resolveStringAsync(raw ?? "", this.#variableContext);
    window.dispatchEvent(
      new CustomEvent("hippo:ws-send", { detail: { data }, bubbles: true }),
    );
  }

  /** Reflect a connection-state change on the Connect + Send buttons. */
  #applyWsState(state) {
    this.#wsState = state;
    if (this.#protocol !== "websocket") return;
    if (this.#wsConnectBtn) {
      const open = state === "open";
      const closing = state === "closing";
      this.#wsConnectBtn.textContent = open
        ? t("request.ws.disconnect")
        : state === "connecting"
          ? t("request.ws.connecting")
          : closing
            ? t("request.ws.disconnecting")
            : t("request.ws.connect");
      this.#wsConnectBtn.classList.toggle(
        "req-send-btn--cancel",
        open || closing,
      );
    }
    if (this.#wsSendBtn) this.#wsSendBtn.disabled = state !== "open";
  }

  /** Persist a WebSocket composer field via the shared request-updated channel. */
  #dispatchWsFieldUpdate(partial) {
    if (!this.#currentNodeId) return;
    window.dispatchEvent(
      new CustomEvent("hippo:request-updated", {
        detail: { id: this.#currentNodeId, ...partial },
        bubbles: true,
      }),
    );
  }

  // ── Tab strip ────────────────────────────────────────────────────────────
  #renderTabStrip() {
    const strip = document.createElement("div");
    strip.className = "req-tab-strip";
    strip.setAttribute("role", "tablist");

    this.#tabsForProtocol().forEach((tab) => {
      const btn = document.createElement("button");
      btn.className = "req-tab-btn";
      btn.textContent = t(tab.labelKey);
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
    this.#tabStrip = strip;
  }

  // ── Tab content panels ───────────────────────────────────────────────────
  #renderTabContent() {
    const content = document.createElement("div");
    content.className = "req-tab-content";

    this.#tabsForProtocol().forEach((tab) => {
      const pane = document.createElement("div");
      pane.className = "req-tab-pane";
      pane.id = `req-tab-${tab.id}`;
      pane.setAttribute("role", "tabpanel");
      pane.hidden = tab.id !== this.#activeTab;
      pane.appendChild(this.#buildTabPane(tab.id));
      content.appendChild(pane);
    });

    this.#el.appendChild(content);
    this.#tabContent = content;
  }

  #buildTabPane(tabId) {
    if (tabId === "params") return this.#buildParamsEditor();
    if (tabId === "headers") return this.#buildHeadersEditor();
    if (tabId === "body") return this.#bodyEditor.build();
    if (tabId === "message") return this.#buildMessageEditor();
    if (tabId === "auth") return this.#auth.element;
    if (tabId === "captures") return this.#capturesEditor.build();
    if (tabId === "scripts") return this.#scriptsEditor.build();
    if (tabId === "notes") return this.#notesEditor.build();
    return document.createElement("div");
  }

  #dispatchNotesUpdated() {
    if (!this.#currentNodeId) return;
    window.dispatchEvent(
      new CustomEvent("hippo:request-updated", {
        detail: {
          id: this.#currentNodeId,
          notes: this.#notesEditor.getValue(),
        },
        bubbles: true,
      }),
    );
  }

  #dispatchCapturesUpdated() {
    if (!this.#currentNodeId) return;
    window.dispatchEvent(
      new CustomEvent("hippo:request-updated", {
        detail: {
          id: this.#currentNodeId,
          captures: this.#capturesEditor.getValue(),
        },
        bubbles: true,
      }),
    );
  }

  #dispatchScriptsUpdated() {
    // Mirror the edited source + enable gate onto the instance fields the send
    // path reads (#sendRequest runs #preRequestScript before resolution), then
    // persist scripts, their per-pane enabled flags and the splitter ratio.
    const {
      preRequestScript,
      afterResponseScript,
      preRequestScriptEnabled,
      afterResponseScriptEnabled,
      scriptSplit,
    } = this.#scriptsEditor.getValue();
    this.#preRequestScript = preRequestScript;
    this.#afterResponseScript = afterResponseScript;
    this.#preRequestScriptEnabled = preRequestScriptEnabled;
    this.#preScriptCache = null; // source changed — never reuse a stale run
    if (!this.#currentNodeId) return;
    window.dispatchEvent(
      new CustomEvent("hippo:request-updated", {
        detail: {
          id: this.#currentNodeId,
          preRequestScript,
          afterResponseScript,
          preRequestScriptEnabled,
          afterResponseScriptEnabled,
          scriptSplit,
        },
        bubbles: true,
      }),
    );
  }

  // ── Shared PillCodeEditor factory ─────────────────────────────────────────
  /**
   * Build a PillCodeEditor seeded with the shared view settings and the request's
   * variable context, register it for teardown + cross-editor sync, and wire its
   * right-click `pce:setting-change` so a view toggle (wrap / line numbers /
   * folding / highlight) applies to every live editor and persists globally.
   */
  #makeCodeEditor(opts = {}) {
    const editor = new PillCodeEditor({
      wrap: this.#editorView.wrap,
      lineNumbers: this.#editorView.lineNumbers,
      folding: this.#editorView.folding,
      highlight: this.#editorView.highlight,
      getContext: () => this.#variableContext,
      getItems: () => this.#getItems(),
      ...opts,
    });
    editor.element.classList.add("pce--embedded");
    editor.element.addEventListener("pce:setting-change", (e) => {
      const { key, value } = e.detail ?? {};
      if (!(key in this.#editorView)) return;
      this.#editorView[key] = value;
      const setter = {
        wrap: "setWrap",
        lineNumbers: "setLineNumbers",
        folding: "setFolding",
        highlight: "setHighlight",
      }[key];
      // Mirror the toggle onto every OTHER live editor so the panes stay in sync.
      for (const ed of this.#codeEditors)
        if (ed !== editor && setter) ed[setter](value);
      // Persist globally — `folding` keeps the legacy `editorFolding` key.
      const settingKey = {
        wrap: "editorWrap",
        lineNumbers: "editorLineNumbers",
        folding: "editorFolding",
        highlight: "editorHighlight",
      }[key];
      if (settingKey) this.#persistGqlSetting({ [settingKey]: value });
    });
    this.#codeEditors.add(editor);
    return editor;
  }

  /** Destroy + unregister every live PillCodeEditor (before a re-render). */
  #disposeCodeEditors() {
    for (const ed of this.#codeEditors) ed.destroy();
    this.#codeEditors.clear();
  }

  // ── GraphQL introspection fetch (the request-coupled half of the editor) ──
  /**
   * Run the standard introspection query against the current request URL,
   * reusing the request's own params/headers/auth via buildRequestPayload, and
   * return the raw introspection JSON — or null when there's no URL (surfaced to
   * the user here). GraphQLBodyEditor owns schema caching / badge / validation /
   * error reporting; this performs only the request-coupled fetch, so a thrown
   * network or payload error propagates to the editor's own failure handling.
   */
  async #fetchIntrospection() {
    const rawUrl = this.#urlPillEditor.getValue().trim();
    if (!rawUrl) {
      Notifications.warning(t("request.graphql.noUrlMessage"), {
        title: t("request.url.none"),
      });
      return null;
    }
    const ctx = this.#variableContext;
    const rv = (s) => resolveStringAsync(s, ctx);
    const authModel = this.#auth.getModel();
    const { finalUrl, headers, body } = await buildRequestPayload(
      {
        method: "POST",
        urlBase: encodeBaseUrl(
          applyPathParams(
            await rv(rawUrl),
            await resolvePathParamValues(this.#pathParams, rv),
          ),
        ),
        params: this.#params,
        headers: this.#headers,
        authEnabled: authModel.authEnabled,
        authType: authModel.authType,
        authBasic: authModel.authBasic,
        authBearer: authModel.authBearer,
        authApiKey: authModel.authApiKey,
        authDigest: authModel.authDigest,
        authNtlm: authModel.authNtlm,
        authAwsIam: authModel.authAwsIam,
        bodyType: "graphql",
        bodyGraphql: { query: INTROSPECTION_QUERY, variables: "" },
      },
      rv,
    );
    return executeIntrospection({ url: finalUrl, headers, body });
  }

  #dispatchBodyUpdated() {
    if (!this.#currentNodeId) return;
    const body = this.#bodyEditor.getValue();
    window.dispatchEvent(
      new CustomEvent("hippo:request-updated", {
        detail: {
          id: this.#currentNodeId,
          bodyType: body.bodyType,
          bodyFormRows: body.bodyFormRows,
          bodyText: body.bodyText,
          bodyFilePath: body.bodyFilePath,
          bodyGraphql: this.#graphql.getValue(),
        },
        bubbles: true,
      }),
    );
  }

  /**
   * Surface a pre-send OAuth failure as a hippo:request-error. Both the
   * token-acquisition throw and the unsuccessful-result path share this shape;
   * only name / message / hint / consoleLog vary.
   */
  #dispatchOAuthError(
    requestId,
    finalUrl,
    { name, message, hint, consoleLog },
  ) {
    window.dispatchEvent(
      new CustomEvent("hippo:request-error", {
        detail: {
          requestId,
          request: {
            method: this.#method,
            url: finalUrl,
            headers: {},
            body: null,
          },
          name,
          message,
          hint,
          elapsed: 0,
          consoleLog,
        },
      }),
    );
  }

  /** Delegates to the shared {@link buildToolbarToggle} (see kv-editor-shared.js). */
  #buildToolbarToggle(o) {
    return buildToolbarToggle(o);
  }

  /**
   * Build the shared scaffold for the Params and Headers editors. Both are a
   * `.params-editor` containing a `.params-toolbar` (Bulk Editor toggle, Add,
   * Delete All, a flex spacer, then a caller-supplied right-side toggle), an
   * optional preview bar, a bulk-mode textarea, and a `.params-list` with
   * column headers. Everything that differs (nouns, handlers, the right-side
   * toggle, whether a preview bar exists) is passed in; the caller stores the
   * returned element refs into its own private fields and then calls its
   * apply-bulk-mode / render methods (which read those fields).
   *
   * The body-form editor is intentionally NOT routed through here: its toolbar
   * lives inline in the shared body type-bar and its content is rebuilt on
   * every render, so it shares only the row builder (#buildKvRow) and the
   * toggle helper above — not this scaffold.
   *
   * @param {object} o
   * @param {boolean} o.bulkMode  initial Bulk Editor checked state
   * @param {(checked: boolean) => void} o.onBulkToggle
   * @param {string} o.noun        singular noun ("parameter" / "header")
   * @param {string} o.nounPlural  plural noun ("parameters" / "headers")
   * @param {() => void} o.onAdd        Add-button click handler
   * @param {() => number} o.getCount  current row count (for delete-all confirm)
   * @param {() => void} o.onDeleteAll  delete-all confirmed handler
   * @param {string} o.nameColLabel    name-column header ("Name" / "Header")
   * @param {string} o.bulkPlaceholder bulk textarea placeholder
   * @param {string} o.bulkAriaLabel   bulk textarea aria-label
   * @param {(value: string) => void} o.onBulkInput  bulk textarea input handler
   * @param {DragReorderController} o.drag
   * @param {HTMLElement} o.rightToggle  caller-built right-side toggle label
   * @param {HTMLElement} [o.previewBar] optional bar inserted after the toolbar
   * @returns {{ container: HTMLElement, addBtn: HTMLElement, delAllBtn: HTMLElement, bulkEl: HTMLTextAreaElement, kvWrapEl: HTMLElement, listEl: HTMLElement, spacer: HTMLElement, deleteAllCleanup: () => void }}
   */
  #buildKvEditor(o) {
    const container = document.createElement("div");
    container.className = "params-editor";

    // ── Toolbar ──────────────────────────────────────────────────────────
    const toolbar = document.createElement("div");
    toolbar.className = "params-toolbar";

    // Bulk Editor toggle — leftmost in toolbar
    const { label: bulkLabel } = this.#buildToolbarToggle({
      text: " " + t("kv.bulkEditor"),
      title: t("kv.bulkEditorTitle"),
      checked: o.bulkMode,
      onChange: o.onBulkToggle,
    });
    toolbar.appendChild(bulkLabel);

    const addBtn = document.createElement("button");
    addBtn.className = "icon-btn params-toolbar-btn";
    addBtn.title = t("kv.add", { noun: o.noun });
    addBtn.setAttribute("aria-label", t("kv.add", { noun: o.noun }));
    addBtn.innerHTML = `<span class="icon">${icon("add", { size: 15 })}</span>`;
    addBtn.addEventListener("click", () => o.onAdd());

    const delAllBtn = document.createElement("button");
    delAllBtn.className =
      "params-toolbar-btn params-toolbar-btn--danger params-delete-all-btn";
    delAllBtn.title = t("kv.deleteAllNoun", { noun: o.nounPlural });
    delAllBtn.setAttribute(
      "aria-label",
      t("kv.deleteAllNoun", { noun: o.nounPlural }),
    );
    delAllBtn.textContent = t("kv.deleteAll");

    // Inline confirm: first click → "Confirm?"; second click → delete all.
    // Escape or clicking outside the button cancels.
    const deleteAllCleanup = this.#wireDeleteAllConfirm(
      delAllBtn,
      o.getCount,
      o.onDeleteAll,
    );

    toolbar.appendChild(addBtn);
    toolbar.appendChild(delAllBtn);

    // Spacer pushes the right-side toggle to the far edge
    const spacer = document.createElement("span");
    spacer.style.flex = "1";
    toolbar.appendChild(spacer);

    if (o.rightToggle) toolbar.appendChild(o.rightToggle);

    container.appendChild(toolbar);

    // ── Optional preview bar (params only) ────────────────────────────────
    if (o.previewBar) container.appendChild(o.previewBar);

    // ── Bulk mode textarea ────────────────────────────────────────────────
    const bulkTa = document.createElement("textarea");
    bulkTa.className = "body-text-editor";
    bulkTa.placeholder = o.bulkPlaceholder;
    bulkTa.spellcheck = false;
    bulkTa.setAttribute("aria-label", o.bulkAriaLabel);
    bulkTa.addEventListener("input", () => o.onBulkInput(bulkTa.value));
    container.appendChild(bulkTa);

    // ── KV wrap (column headers + list) ──────────────────────────────────
    const kvWrap = document.createElement("div");
    kvWrap.style.cssText =
      "display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden";

    // ── Column headers ───────────────────────────────────────────────────
    const colHeaders = document.createElement("div");
    colHeaders.className = "params-header-row";
    colHeaders.innerHTML = `
      <span class="params-col-handle"></span>
      <span class="params-col-enabled"></span>
      <span class="params-col-name">${o.nameColLabel}</span>
      <span class="params-col-value">${t("kv.value")}</span>
      <span class="params-col-delete"></span>`;
    kvWrap.appendChild(colHeaders);

    // ── List ─────────────────────────────────────────────────────────────
    const list = document.createElement("div");
    list.className = "params-list";
    o.drag.attach(list);
    kvWrap.appendChild(list);

    container.appendChild(kvWrap);

    return {
      container,
      addBtn,
      delAllBtn,
      bulkEl: bulkTa,
      kvWrapEl: kvWrap,
      listEl: list,
      spacer,
      deleteAllCleanup,
    };
  }

  // ── Params editor ────────────────────────────────────────────────────────
  #buildParamsEditor() {
    // The URL preview bar's visibility is controlled from Settings → Appearance
    // ("Show URL preview"), applied via applySettings(); see #urlPreviewEnabled.
    const {
      container,
      addBtn,
      delAllBtn,
      bulkEl,
      kvWrapEl,
      listEl,
      deleteAllCleanup,
    } = this.#buildKvEditor({
      bulkMode: this.#paramsBulkMode,
      onBulkToggle: (checked) => this.#handleParamsBulkToggle(checked),
      noun: t("request.noun.parameter"),
      nounPlural: t("request.noun.parameters"),
      onAdd: () => this.#addParam(),
      getCount: () => this.#params.length,
      onDeleteAll: () => this.#deleteAllParams(),
      nameColLabel: t("kv.name"),
      bulkPlaceholder: "name=value\nparam1=foo\nparam2=bar\n# disabled=row",
      bulkAriaLabel: t("request.params.bulkAria"),
      onBulkInput: (value) => {
        this.#params = this.#textToKvRows(value);
        this.#updateUrlPreview();
        this.#dispatchParamsUpdated();
      },
      drag: this.#paramsDrag,
      previewBar: this.#buildUrlPreviewBar(),
    });

    this.#paramsAddBtnEl = addBtn;
    this.#paramsDelAllBtnEl = delAllBtn;
    this.#paramsBulkEl = bulkEl;
    this.#paramsKvWrapEl = kvWrapEl;
    this.#paramsListEl = listEl;
    this.#paramsDeleteAllCleanup = deleteAllCleanup;

    this.#applyParamsBulkMode();
    this.#renderParamsList();
    return container;
  }

  // ── Headers editor ──────────────────────────────────────────────────
  #buildHeadersEditor() {
    // Right-side toggle: show standard header-name suggestions
    const { label: listHdrLabel } = this.#buildToolbarToggle({
      text: " " + t("request.headers.listHeaders"),
      title: t("request.headers.suggestTitle"),
      id: "list-headers-toggle",
      checked: this.#headerSuggestionsEnabled,
      onChange: (checked) => {
        this.#headerSuggestionsEnabled = checked;
        if (!checked) _hdrAc.hide();
        // Persist the preference into settings
        window.dispatchEvent(
          new CustomEvent("hippo:editor-setting-changed", {
            detail: { listHeaders: checked },
            bubbles: true,
          }),
        );
      },
    });
    this.#listHdrLabelEl = listHdrLabel;

    const {
      container,
      addBtn,
      delAllBtn,
      bulkEl,
      kvWrapEl,
      listEl,
      spacer,
      deleteAllCleanup,
    } = this.#buildKvEditor({
      bulkMode: this.#headersBulkMode,
      onBulkToggle: (checked) => this.#handleHeadersBulkToggle(checked),
      noun: t("request.noun.header"),
      nounPlural: t("request.noun.headers"),
      onAdd: () => this.#addHeader(),
      getCount: () => this.#headers.length,
      onDeleteAll: () => this.#deleteAllHeaders(),
      nameColLabel: t("kv.header"),
      bulkPlaceholder:
        "Header-Name: value\nContent-Type: application/json\nAuthorization: Bearer token\n# X-Disabled: skipped",
      bulkAriaLabel: t("request.headers.bulkAria"),
      onBulkInput: (value) => {
        this.#headers = this.#textToHeaderRows(value);
        this.#dispatchHeadersUpdated();
      },
      drag: this.#headersDrag,
      rightToggle: listHdrLabel,
    });

    this.#headersAddBtnEl = addBtn;
    this.#headersDelAllBtnEl = delAllBtn;
    this.#headersBulkEl = bulkEl;
    this.#headersKvWrapEl = kvWrapEl;
    this.#headersListEl = listEl;
    this.#listHdrSpacerEl = spacer;
    this.#headersDeleteAllCleanup = deleteAllCleanup;

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

  /** Delegates to the shared {@link disposePillEditors} (see kv-editor-shared.js). */
  #disposePillEditors(editors) {
    return disposePillEditors(editors);
  }

  #renderHeadersList() {
    if (!this.#headersListEl) return;
    this.#disposePillEditors(this.#headerPillEditors);

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
      empty.textContent = t("request.headers.empty");
      this.#headersListEl.appendChild(empty);
      return;
    }

    this.#headers.forEach((header, index) => {
      this.#headersListEl.appendChild(this.#buildHeaderRow(header, index));
    });
  }

  #buildHeaderRow(header, index) {
    // ── Forward references for the value-dropdown callbacks ───────────────
    // Both are assigned after valueEditor is created (below) so the closures
    // can safely reference valueEditor without a TDZ error.
    let _onValueSelected = null;
    let _onNameConfirmed = null;

    // ── Header name combo box ─────────────────────────────────────────────
    const headerInput = document.createElement("input");
    headerInput.type = "text";
    headerInput.className = "params-input params-name";
    headerInput.placeholder = t("kv.header");
    headerInput.value = header.name;
    headerInput.setAttribute("aria-label", t("request.headers.nameAria"));
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
      // Delay the hide so a click on a dropdown item registers first;
      // re-focusing the input cancels the pending hide.
      _hdrAc.scheduleHide();
    });
    headerInput.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        _hdrAc.navigate(+1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        _hdrAc.navigate(-1);
        return;
      }
      if (e.key === "Escape") {
        _hdrAc.hide();
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
      placeholder: t("kv.value"),
      ariaLabel: t("request.headers.valueAria"),
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
        _hdrVal.hide();
        return;
      }
      _showHdrValDropdown(valueEditor.element, values, _onValueSelected);
    };

    // Dismiss value dropdown when the value editor loses focus (with a short
    // delay so mousedown on a dropdown item can fire first).
    valueEditor.element.addEventListener("blur", () => {
      _hdrVal.scheduleHide();
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
          _hdrVal.navigate(+1);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          _hdrVal.navigate(-1);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          _hdrVal.hide();
          return;
        }
        if (e.key === "Enter" && _hdrVal.activeLabel() !== null) {
          // Prevent VariablePillEditor's Enter handler from adding a new header row.
          e.preventDefault();
          e.stopPropagation();
          _hdrValDropdownAccept();
        }
      },
      true /* capture — fires before VariablePillEditor's bubble-phase listener */,
    );

    return this.#buildKvRow({
      item: header,
      index,
      noun: t("request.noun.header"),
      name: headerInput,
      value: valueEditor.element,
      drag: this.#headersDrag,
      onToggle: () => this.#dispatchHeadersUpdated(),
      onDelete: () => this.#deleteHeader(header.id),
    });
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
    this.#disposePillEditors(this.#paramPillEditors);

    // In bulk mode just keep the textarea in sync and update the URL preview
    if (this.#paramsBulkMode) {
      if (this.#paramsBulkEl)
        this.#paramsBulkEl.value = this.#kvRowsToText(this.#params);
      this.#updateUrlPreview();
      return;
    }

    this.#paramsListEl.innerHTML = "";

    const hasPath = this.#pathParams.length > 0;

    if (this.#params.length === 0 && !hasPath) {
      const empty = document.createElement("div");
      empty.className = "params-empty";
      empty.textContent = t("request.params.empty");
      this.#paramsListEl.appendChild(empty);
      this.#updateUrlPreview();
      return;
    }

    // Query params first.
    const queryRows = this.#params.map((param, index) =>
      this.#buildParamRow(param, index),
    );
    // A divider under the last query row separates query from path params —
    // only when path params exist (and there is a query row to draw it on).
    if (hasPath && queryRows.length) {
      queryRows[queryRows.length - 1].classList.add("params-row--section-end");
    }
    queryRows.forEach((row) => this.#paramsListEl.appendChild(row));

    // Path params (URL-derived) appended below, in URL order.
    this.#pathParams.forEach((pp) =>
      this.#paramsListEl.appendChild(this.#buildPathParamRow(pp)),
    );

    this.#updateUrlPreview();
  }

  // ── Path params ────────────────────────────────────────────────────────────

  /**
   * Re-derive `#pathParams` from the URL's `:name`/`{name}` tokens, preserving
   * existing values by name, adding new tokens (empty value), and dropping ones
   * no longer present. Returns true when the token set (names/styles/order)
   * changed, so the caller can avoid a needless re-render on pure value edits.
   */
  #reconcilePathParamsFromUrl() {
    const tokens = detectPathParams(this.#url);
    const sig = (arr) => arr.map((t) => `${t.style}:${t.name}`).join("\n");
    const before = sig(this.#pathParams);
    const byName = new Map(this.#pathParams.map((p) => [p.name, p]));
    this.#pathParams = tokens.map((t) => {
      const existing = byName.get(t.name);
      return existing
        ? { ...existing, style: t.style }
        : { id: crypto.randomUUID(), name: t.name, value: "", style: t.style };
    });
    return sig(this.#pathParams) !== before;
  }

  #buildPathParamRow(pp) {
    // Name — a plain input mapped 1:1 to a URL token (no {{var}} pills here).
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "params-name path-param-name";
    nameInput.value = pp.name;
    nameInput.placeholder = t("request.pathParams.namePlaceholder");
    nameInput.spellcheck = false;
    nameInput.setAttribute("aria-label", t("request.pathParams.nameAria"));
    nameInput.addEventListener("input", () =>
      this.#renamePathParam(pp, nameInput.value),
    );

    // Value — a pill editor (variables/functions + secret reveal, as query values).
    const valueEditor = new VariablePillEditor({
      placeholder: t("kv.value"),
      ariaLabel: t("request.pathParams.valueAria"),
      className: "params-value",
      getContext: () => this.#variableContext,
      getItems: () => this.#getItems(),
      ensureResponseCaches: (names) => this.#ensureResponseCaches?.(names),
      onInput: (v) => {
        pp.value = v;
        this.#updateUrlPreview();
        this.#dispatchPathParamsUpdated();
      },
    });
    valueEditor.setValue(pp.value);
    this.#paramPillEditors.push(valueEditor);

    // Path-param indicator, shown in place of the enable/disable checkbox.
    const statusIcon = document.createElement("span");
    statusIcon.className = "path-param-icon";
    statusIcon.title = t("request.pathParams.label");
    statusIcon.setAttribute("aria-label", t("request.pathParams.label"));
    statusIcon.innerHTML = icon("braces", { size: 14 });

    return this.#buildKvRow({
      item: pp,
      noun: t("request.noun.pathParameter"),
      name: nameInput,
      value: valueEditor.element,
      statusIcon,
      noDrag: true,
      onDelete: () => this.#deletePathParam(pp),
    });
  }

  /** Rename a path param and rewrite the matching URL token(s) to match. */
  #renamePathParam(pp, newName) {
    const oldName = pp.name;
    if (newName === oldName) return;
    // A blank new name is a transient invalid state (it blocks Send) and is NOT
    // written into the URL — doing so would corrupt the token to ":" / "{}".
    if (oldName && newName) {
      this.#url = this.#rewriteUrlToken(this.#url, oldName, newName, pp.style);
      this.#urlPillEditor.setValue(this.#url); // programmatic — does not fire onInput
      this.#dispatchRequestUpdated();
    }
    pp.name = newName;
    this.#updateUrlPreview();
    this.#dispatchPathParamsUpdated();
  }

  /** Delete a path param row and strip its token from the URL. */
  #deletePathParam(pp) {
    this.#pathParams = this.#pathParams.filter((p) => p !== pp);
    if (pp.name) {
      this.#url = this.#stripUrlToken(this.#url, pp.name, pp.style);
      this.#urlPillEditor.setValue(this.#url);
      this.#dispatchRequestUpdated();
    }
    this.#renderParamsList();
    this.#dispatchPathParamsUpdated();
  }

  /** Replace `:old`/`{old}` tokens (of the given style) with the new name, leaving {{vars}} untouched. */
  #rewriteUrlToken(url, oldName, newName, style) {
    return url.replace(
      /\{\{[^}]*\}\}|(?<=\/):([A-Za-z_]\w*)|\{([A-Za-z_]\w*)\}/g,
      (full, colonName, braceName) => {
        if (full.startsWith("{{")) return full;
        const name = colonName ?? braceName;
        const tokenStyle = colonName != null ? ":" : "{}";
        if (name !== oldName || tokenStyle !== style) return full;
        return colonName != null ? `:${newName}` : `{${newName}}`;
      },
    );
  }

  /** Remove `/:name` (colon, with its leading slash) or `{name}` (brace) tokens; {{vars}} untouched. */
  #stripUrlToken(url, name, style) {
    return url.replace(
      /\{\{[^}]*\}\}|\/:([A-Za-z_]\w*)|\{([A-Za-z_]\w*)\}/g,
      (full, colonName, braceName) => {
        if (full.startsWith("{{")) return full;
        if (colonName != null)
          return style === ":" && colonName === name ? "" : full;
        return style === "{}" && braceName === name ? "" : full;
      },
    );
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
    input.className = "params-url-preview-input";
    input.placeholder = t("request.url.previewPlaceholder");
    input.setAttribute("aria-label", t("request.url.previewAria"));
    input.tabIndex = -1;

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "params-url-preview-copy-btn";
    copyBtn.innerHTML = icon("copy", { size: 15 });
    copyBtn.title = t("request.url.copyTitle");
    copyBtn.setAttribute("aria-label", t("request.url.copyTitle"));
    copyBtn.addEventListener("click", async () => {
      // Copy the *unresolved* template: variables/functions stay as `{{name}}`
      // tokens rather than the resolved values shown in the preview bar, so the
      // copied URL is reusable and never leaks resolved secrets.
      const text = await this.#buildPreviewUrl(false);
      if (!text) return;
      await navigator.clipboard.writeText(text);
      copyBtn.innerHTML = icon("check", { size: 15 });
      copyBtn.classList.add("params-url-preview-copy-btn--copied");
      setTimeout(() => {
        copyBtn.innerHTML = icon("copy", { size: 15 });
        copyBtn.classList.remove("params-url-preview-copy-btn--copied");
      }, 1500);
    });

    bar.appendChild(input);
    bar.appendChild(copyBtn);

    this.#urlPreviewEl = bar;
    this.#urlPreviewInputEl = input;
    this.#updateUrlPreview();
    return bar;
  }

  /**
   * Assemble the URL string with enabled query parameters appended.
   * @param {boolean} [resolve=true] when `false`, leave `{{variable}}` /
   *   function tokens literal and skip percent-encoding, yielding a reusable
   *   URL template (used by the Copy button) rather than the resolved preview.
   */
  async #buildPreviewUrl(resolve = true) {
    const ctx = this.#variableContext;
    const rv = (s) =>
      resolve ? resolveStringAsync(s ?? "", ctx) : Promise.resolve(s ?? "");

    const urlParts = await Promise.all(
      tokenize(this.#url ?? "").map(async (tok) => {
        if (tok.type === "text") return tok.content;
        const raw = `{{${tok.content}}}`;
        return resolve ? resolveStringAsync(raw, ctx) : raw;
      }),
    );
    // Substitute path params before percent-encoding so `{id}` braces aren't
    // mangled by encodeBaseUrl (which would otherwise %7B-escape them). In raw
    // mode path values pass through unresolved/unencoded so any `{{var}}` in
    // them survives too.
    const pathValues = new Map();
    for (const p of this.#pathParams ?? []) {
      const name = (p.name ?? "").trim();
      if (!name) continue;
      const v = await rv(p.value);
      pathValues.set(name, resolve ? encodeURIComponent(v) : v);
    }
    const substituted = applyPathParams(urlParts.join(""), pathValues);
    const base = resolve ? encodeBaseUrl(substituted) : substituted;

    const enabled = this.#params.filter((p) => p.enabled && p.name.trim());
    if (!enabled.length) return base;
    const pairs = await Promise.all(
      enabled.map(async (p) => {
        const name = await rv(p.name);
        const value = await rv(p.value);
        return resolve
          ? `${encodeURIComponent(name)}=${encodeURIComponent(value)}`
          : `${name}=${value}`;
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
    // ── Name pill editor ─────────────────────────────────────────────────
    const getCtx = () => this.#variableContext;
    const getItms = () => this.#getItems();
    const nameEditor = new VariablePillEditor({
      placeholder: t("kv.name"),
      ariaLabel: t("request.params.nameAria"),
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
      placeholder: t("kv.value"),
      ariaLabel: t("request.params.valueAria"),
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

    return this.#buildKvRow({
      item: param,
      index,
      noun: t("request.noun.parameter"),
      name: nameEditor.element,
      value: valueEditor.element,
      drag: this.#paramsDrag,
      onToggle: () => {
        this.#updateUrlPreview();
        this.#dispatchParamsUpdated();
      },
      onDelete: () => this.#deleteParam(param.id),
    });
  }

  // ── Shared UI helpers ─────────────────────────────────────────────────────

  /** Delegates to the shared {@link buildKvRow} (see kv-editor-shared.js). */
  #buildKvRow(opts) {
    return buildKvRow(opts);
  }

  /** Delegates to the shared {@link wireDeleteAllConfirm} (see kv-editor-shared.js). */
  #wireDeleteAllConfirm(btn, getCount, onDelete) {
    return wireDeleteAllConfirm(btn, getCount, onDelete);
  }

  /** Delegates to the shared {@link applyBulkMode} (see kv-editor-shared.js). */
  #applyBulkMode(bulk, textareaEl, kvWrapEl, addBtnEl, delAllBtnEl) {
    return applyBulkMode(bulk, textareaEl, kvWrapEl, addBtnEl, delAllBtnEl);
  }

  // ── Bulk editor shared utilities ─────────────────────────────────────────

  /** Delegates to the shared {@link kvRowsToText} (see kv-editor-shared.js). */
  #kvRowsToText(rows) {
    return kvRowsToText(rows);
  }

  /** Delegates to the shared {@link headerRowsToText} (see kv-editor-shared.js). */
  #headerRowsToText(rows) {
    return headerRowsToText(rows);
  }

  /** Delegates to the shared {@link textToKvRows} (see kv-editor-shared.js). */
  #textToKvRows(text) {
    return textToKvRows(text);
  }

  /** Delegates to the shared {@link textToHeaderRows} (see kv-editor-shared.js). */
  #textToHeaderRows(text) {
    return textToHeaderRows(text);
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
    if (bulk) _hdrAc.hide();
  }

  // ── Tab switching ─────────────────────────────────────────────────────────
  #switchTab(tabId) {
    this.#activeTab = tabId;
    this.#tabStrip.querySelectorAll(".req-tab-btn").forEach((btn) => {
      const active = btn.dataset.tab === tabId;
      btn.classList.toggle("req-tab-btn--active", active);
      btn.setAttribute("aria-selected", String(active));
    });
    this.#tabContent.querySelectorAll(".req-tab-pane").forEach((pane) => {
      pane.hidden = pane.id !== `req-tab-${tabId}`;
    });
    // The Scripts editors validate on load while their tab is still hidden,
    // where zero-size rects suppress squiggle rendering; now that the pane has
    // layout, re-render any markers so a stored syntax error shows immediately.
    if (tabId === "scripts") this.#scriptsEditor.onShown();
  }

  /**
   * Paste interceptor for the URL bar: when the pasted text is a cURL command,
   * hand it to app.js (which parses it and rewrites the selected request, with a
   * confirm if the request isn't blank) instead of dropping the raw command into
   * the URL field. Returns true when claimed so the editor skips its own insert.
   *
   * Only the start-of-string `curl` token is checked here — a real URL never
   * begins with it — keeping the decision synchronous; the actual parse +
   * confirm + apply happens asynchronously in app.js.
   */
  #maybeHandleCurlPaste(text) {
    if (!this.#currentNodeId) return false; // nothing selected to rewrite
    if (this.#protocol !== "http") return false; // WebSocket bar: leave as-is
    if (!/^\s*\$?\s*curl[\s\\]/i.test(text)) return false;
    window.dispatchEvent(
      new CustomEvent("hippo:curl-pasted", {
        detail: { id: this.#currentNodeId, text },
        bubbles: true,
      }),
    );
    return true;
  }

  // ── Event dispatch ────────────────────────────────────────────────────────
  #dispatchRequestUpdated() {
    if (!this.#currentNodeId) return;
    window.dispatchEvent(
      new CustomEvent("hippo:request-updated", {
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
      new CustomEvent("hippo:request-updated", {
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
      new CustomEvent("hippo:request-updated", {
        detail: {
          id: this.#currentNodeId,
          headers: this.#headers.map((h) => ({ ...h })),
        },
        bubbles: true,
      }),
    );
  }

  #dispatchPathParamsUpdated() {
    if (!this.#currentNodeId) return;
    // Persist only id/name/value; the token style is re-derived from the URL.
    window.dispatchEvent(
      new CustomEvent("hippo:request-updated", {
        detail: {
          id: this.#currentNodeId,
          pathParams: this.#pathParams.map((p) => ({
            id: p.id,
            name: p.name,
            value: p.value,
          })),
        },
        bubbles: true,
      }),
    );
  }

  // ── Send ─────────────────────────────────────────────────────────────────
  async #sendRequest(force = false) {
    // Capture the id now — the user may load another request while the async
    // steps below (OAuth, cache preload) run, and this send belongs to the
    // request that was loaded when it started.
    const requestId = this.#currentNodeId ?? null;
    const rawUrl = this.#urlPillEditor.getValue().trim();
    if (!rawUrl) {
      this.#urlPillEditor.focus();
      return;
    }

    // ── Path params must all be named — a blank token can't be substituted ──
    if (this.#pathParams.some((p) => !(p.name ?? "").trim())) {
      Notifications.warning(t("request.pathParams.incompleteBody"), {
        title: t("request.pathParams.incomplete"),
      });
      return;
    }

    // ── 0. Safety flush — if a bulk textarea is active, parse its current
    //       content now so in-progress edits (e.g. uncommitted IME) are
    //       captured even if the `input` event hasn't fired yet.
    if (this.#paramsBulkMode && this.#paramsBulkEl)
      this.#params = this.#textToKvRows(this.#paramsBulkEl.value);
    if (this.#headersBulkMode && this.#headersBulkEl)
      this.#headers = this.#textToHeaderRows(this.#headersBulkEl.value);
    this.#bodyEditor.flushBulk();

    // ── Pre-request script (Feature 25) ───────────────────────────────────
    // Runs before resolution (so a variable the script sets is usable by this
    // request) and before the pre-flight check (so a script-provided value
    // isn't flagged as missing). Method/url/headers/body mutations apply to THIS
    // send only — the editor's own fields stay untouched. The result is cached
    // for one send so a "Send anyway" retry doesn't run the script twice.
    let ctx = this.#variableContext;
    let scriptedMethod = this.#method;
    let scriptedRawUrl = rawUrl;
    let scriptedHeaderRows = this.#headers;
    let scriptedBodyText = null; // null → use the editor's body
    const preScriptCode = (this.#preRequestScript ?? "").trim();
    if (preScriptCode && this.#preRequestScriptEnabled !== false) {
      let pre;
      if (force && this.#preScriptCache?.id === requestId) {
        pre = this.#preScriptCache.result;
      } else {
        pre = await this.#runPreRequestScript(preScriptCode, rawUrl, ctx);
        this.#preScriptCache = { id: requestId, result: pre };
      }
      if (pre.aborted) {
        this.#preScriptCache = null;
        return; // error surfaced; never send a half-prepared request
      }
      ctx = pre.ctx;
      if (pre.patch) {
        if (pre.patch.method) scriptedMethod = pre.patch.method;
        if (pre.patch.url != null) scriptedRawUrl = pre.patch.url;
        scriptedHeaderRows = pre.patch.headerRows;
        if (pre.patch.bodyText != null) scriptedBodyText = pre.patch.bodyText;
      }
    }

    // ── Variable resolver helper ──────────────────────────────────────────
    // Resolve {{varName}} tokens using the (possibly script-augmented) context
    // so the actual HTTP request (and cURL output) use concrete values, not
    // template placeholders.
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
          actionLabel: t("request.sendAnyway"),
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

    // ── Build the native request payload ─────────────────────────────────
    // Query-param encoding, header resolution, the auth transforms that reduce
    // to a static header / query value (basic, bearer, apikey) or a pass-through
    // credential bag (digest, ntlm, aws-iam), and body serialisation are shared
    // with the dependency prefetcher (app.js) via buildRequestPayload(). OAuth2
    // is the one auth type that can't be a pure transform — it's interactive —
    // so it runs as a post-step below, after the payload (including any
    // user-supplied headers) already exists.
    const authModel = this.#auth.getModel();
    const bodyVals = this.#bodyEditor.getValue();
    const {
      finalUrl,
      headers,
      body,
      bodyFilePath,
      multipart,
      awsIam,
      authDigest,
      authNtlm,
      oauth1,
    } = await buildRequestPayload(
      {
        method: scriptedMethod,
        // Substitute path params before percent-encoding (so `{id}` survives).
        urlBase: encodeBaseUrl(
          applyPathParams(
            await rv(scriptedRawUrl),
            await resolvePathParamValues(this.#pathParams, rv),
          ),
        ),
        params: this.#params,
        headers: scriptedHeaderRows,
        authEnabled: authModel.authEnabled,
        authType: authModel.authType,
        authBasic: authModel.authBasic,
        authBearer: authModel.authBearer,
        authApiKey: authModel.authApiKey,
        authDigest: authModel.authDigest,
        authNtlm: authModel.authNtlm,
        authAwsIam: authModel.authAwsIam,
        authOAuth1: authModel.authOAuth1,
        bodyType: bodyVals.bodyType,
        bodyText: scriptedBodyText ?? bodyVals.bodyText,
        bodyFormRows: bodyVals.bodyFormRows,
        bodyFile: bodyVals.bodyFile,
        bodyGraphql: this.#graphql.getValue(),
      },
      rv,
    );

    // ── OAuth2 — interactive token acquisition (post-step) ────────────────
    if (authModel.authEnabled && authModel.authType === "oauth2") {
      // ── User-supplied Authorization header wins ──────────────────────────
      // If the user explicitly added a non-blank Authorization header in the
      // Headers tab, respect that value and skip all token acquisition.
      const _userAuthKey = Object.keys(headers).find(
        (k) => k.toLowerCase() === "authorization",
      );
      if (!(_userAuthKey && headers[_userAuthKey]?.trim())) {
        // ── Signal loading while the OAuth flow runs ───────────────────────
        // This turns the Send button into "Stop" immediately so the user can
        // cancel a long-running popup before the request fires.
        window.dispatchEvent(
          new CustomEvent("hippo:request-loading", { detail: { requestId } }),
        );

        // ── Acquire token (cache → refresh → full flow) ────────────────────
        // Resolve {{variables}} in the OAuth config first — unlike the other
        // auth types it bypasses buildRequestPayload(), so without this the
        // token / authorization endpoints would receive literal placeholders.
        let _oauthResult;
        try {
          _oauthResult = await oauthExecutor.acquireToken(
            await resolveOAuth2Config(authModel.authOAuth2, rv),
          );
        } catch (err) {
          this.#dispatchOAuthError(requestId, finalUrl, {
            name: "OAuthError",
            message: err?.message ?? String(err),
            hint: t("request.oauth.failedBefore"),
            consoleLog: [`* OAuth error: ${err?.message ?? err}`],
          });
          return;
        }

        // ── Guard: user clicked Stop while the popup / token request was in flight ──
        if (!this.#inFlightIds.has(requestId)) return;

        // ── Handle flow failure ────────────────────────────────────────────
        if (!_oauthResult.success || !_oauthResult.accessToken) {
          const _errCode = _oauthResult.error?.code ?? "OAuthError";
          const _errMsg = _oauthResult.error?.description ?? _errCode;
          this.#dispatchOAuthError(requestId, finalUrl, {
            name: _errCode,
            message: _errMsg,
            hint: t("request.oauth.failedCheck"),
            consoleLog: [`* OAuth ${_errCode}: ${_errMsg}`],
          });
          return;
        }

        // ── Inject bearer token ──────────────────────────────────────────
        // The prefix comes from in-memory auth state (or the "Bearer" default);
        // resolve any {{variables}} in it too before it goes on the wire, then
        // fall back to "Bearer" if resolution leaves it blank.
        const _prefix =
          (await rv(this.#auth.getOAuth2HeaderPrefix())).trim() || "Bearer";
        headers["Authorization"] = `${_prefix} ${_oauthResult.accessToken}`;

        // Keep local auth state in sync (token display + expiry badge). Pass
        // the id_token too so an implicit "both" response shows its token tabs.
        this.#auth.applyAcquiredToken({
          accessToken: _oauthResult.accessToken,
          idToken: _oauthResult.idToken,
          refreshToken: _oauthResult.refreshToken,
          expiresAt: _oauthResult.expiresAt,
        });
      }
    }

    window.dispatchEvent(
      new CustomEvent("hippo:send-request", {
        detail: {
          requestId,
          method: scriptedMethod,
          url: finalUrl,
          headers,
          body,
          bodyFilePath,
          multipart,
          awsIam,
          authDigest,
          authNtlm,
          oauth1,
        },
        bubbles: true,
      }),
    );

    // This send is committed — drop the cached pre-script result so the next
    // send (or a later "Send anyway") runs the script fresh.
    this.#preScriptCache = null;
  }

  /**
   * Run the pre-request script in the main-process sandbox. Surfaces its result
   * (variable writes + any error) via the global `hippo:script-result` event —
   * app.js persists the writes and shows errors — and returns the augmented
   * variable context plus an ephemeral request patch for this one send. Never
   * throws: an error yields `{ aborted: true }` so the caller cancels the send.
   *
   * @param {string} code    pre-request script source (already trimmed/non-empty)
   * @param {string} rawUrl  raw URL with {{templates}} intact
   * @param {object} ctx     current variable context
   * @returns {Promise<{ctx:object, patch:object|null, aborted:boolean}>}
   */
  async #runPreRequestScript(code, rawUrl, ctx) {
    let res;
    try {
      res = await window.hippo.script.runPre({
        code,
        request: {
          method: this.#method,
          url: rawUrl,
          headers: headerRowsToObject(this.#headers),
          body: this.#bodyEditor.getValue().bodyText ?? "",
        },
        environment: {
          name: ctx?.activeEnvironmentName ?? "",
          variables: ctx?.environmentVariables ?? {},
        },
        variables: {
          global: ctx?.globalVariables ?? {},
          environment: ctx?.environmentVariables ?? {},
          collection: ctx?.collectionVariables ?? {},
          folder: flattenFolderChain(ctx?.folderChain),
        },
      });
    } catch (err) {
      res = {
        error: { name: "InternalError", message: String(err?.message ?? err) },
      };
    }

    window.dispatchEvent(
      new CustomEvent("hippo:script-result", {
        detail: {
          phase: "pre",
          writes: res?.varWrites ?? [],
          error: res?.error ?? null,
          logs: res?.logs ?? [],
        },
      }),
    );

    if (res?.error) return { ctx, patch: null, aborted: true };

    const patch = res?.request
      ? {
          method: res.request.method,
          url: res.request.url,
          headerRows: applyHeaderPatch(this.#headers, res.request.headers),
          bodyText: res.request.body,
        }
      : null;
    return {
      ctx: augmentVariableContext(ctx, res?.varWrites),
      patch,
      aborted: false,
    };
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
    // Path-param values may contain {{var}}/functions; names are plain tokens.
    for (const pp of this.#pathParams) {
      t.push(pp.value ?? "");
    }
    for (const h of this.#headers) {
      if (h.enabled) {
        t.push(h.name ?? "", h.value ?? "");
      }
    }
    t.push(...this.#auth.gatherTemplates());
    // Only scan fields that will actually be sent — avoids false-positive
    // warnings for inactive body data retained while switching body types.
    const noBodyMethods = new Set(["GET", "HEAD"]);
    const body = this.#bodyEditor.getValue();
    if (!noBodyMethods.has(this.#method)) {
      switch (body.bodyType) {
        case "json":
        case "yaml":
        case "xml":
        case "text":
          t.push(body.bodyText ?? "");
          break;
        case "form-data":
        case "form-urlencoded":
          for (const r of body.bodyFormRows) {
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
   * @param {{ collectionVariables?: object, folderChain?: object[] } | null} context
   */
  setVariableContext(context) {
    this.#variableContext = context;
    const allEditors = [
      this.#urlPillEditor,
      ...this.#paramPillEditors,
      ...this.#headerPillEditors,
      ...this.#codeEditors,
    ].filter(Boolean);
    for (const editor of allEditors) {
      editor.revalidate();
    }
    // The body editor owns its own form-row pill editors.
    this.#bodyEditor.setVariableContext(context);
    this.#auth.revalidatePills();
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
      if (!this.#headerSuggestionsEnabled) _hdrAc.hide();
    }
    if (settings.showUrlPreview != null) {
      // Toggled from Settings → Appearance; just reflect it onto the bar.
      this.#urlPreviewEnabled = !!settings.showUrlPreview;
      this.#updateUrlPreview();
    }
    if (settings.removeHeaders != null) {
      this.#removeHeaders = !!settings.removeHeaders;
      this.#bodyEditor.setRemoveHeaders(this.#removeHeaders);
      this.#graphql.setRemoveHeaders(this.#removeHeaders);
    }
    // PillCodeEditor view preferences (folding keeps the legacy `editorFolding`
    // key). Update the shared state and apply live to every on-screen editor
    // (body text, GraphQL Query/Variables, WebSocket message) without a rebuild.
    const applyView = (key, value, setter) => {
      if (value == null) return;
      this.#editorView[key] = !!value;
      for (const ed of this.#codeEditors) ed[setter](!!value);
    };
    applyView("folding", settings.editorFolding, "setFolding");
    applyView("wrap", settings.editorWrap, "setWrap");
    applyView("lineNumbers", settings.editorLineNumbers, "setLineNumbers");
    applyView("highlight", settings.editorHighlight, "setHighlight");

    // GraphQL Variables-pane position (a fraction kept per orientation). The
    // editor applies only the keys that differ from its live state (so unrelated
    // settings changes don't disturb it) and reports whether anything changed; if
    // so and the GraphQL body is on screen, re-render so the restored sizes take
    // effect. The split orientation itself is layout-driven, not a setting.
    let gqlChanged = false;
    if (
      this.#graphql.setVarsFraction(
        "column",
        settings.graphqlVarsFractionColumn,
      )
    )
      gqlChanged = true;
    if (this.#graphql.setVarsFraction("row", settings.graphqlVarsFractionRow))
      gqlChanged = true;
    if (gqlChanged && this.#bodyEditor.getBodyType() === "graphql")
      this.#bodyEditor.renderContent();
  }

  /** Dispatch a settings change so app.js merges + persists it (see app.js). */
  #persistGqlSetting(detail) {
    window.dispatchEvent(
      new CustomEvent("hippo:editor-setting-changed", {
        detail,
        bubbles: true,
      }),
    );
  }

  /**
   * Populate the editor from a saved request node.
   * @param {object} node
   */
  load(node) {
    this.#currentNodeId = node.id ?? null;

    // Cancel any in-progress inline confirm on the Delete All buttons.
    this.#paramsDeleteAllCleanup?.();
    this.#headersDeleteAllCleanup?.();
    this.#bodyEditor.cancelPendingDeleteAll();
    this.#capturesEditor.cancelPendingDeleteAll();

    // Protocol — rebuild the url bar + tabs when switching between HTTP and
    // WebSocket so the right controls (method vs WS, Body vs Message) render.
    this.#protocol = node.protocol === "websocket" ? "websocket" : "http";
    if (this.#protocol !== this.#renderedProtocol) {
      this.#rebuildLayout();
    }

    if (node.method && this.#methodSel) {
      this.#method = node.method;
      this.#methodSelLabel.textContent = node.method;
      this.#methodSel.title = node.method; // keep the icon-mode tooltip in step
      this.#methodSel.dataset.method = node.method.toLowerCase();
      this.#sendBtn.dataset.method = node.method.toLowerCase();
    }

    // Requests run concurrently: the loaded request may already be in flight
    // (Stop) while others run in the background, or idle (Send) while they do.
    this.#applySendButtonState();

    const url = node.url ?? "";
    this.#url = url;
    this.#urlPillEditor.setValue(url);

    // Path params (Feature 49) — the URL is authoritative for which tokens
    // exist; stored values are merged in by name (and any whose token is gone
    // is dropped). Style/order come from the URL.
    {
      const stored = Array.isArray(node.pathParams) ? node.pathParams : [];
      const byName = new Map(stored.map((p) => [p.name, p]));
      this.#pathParams = detectPathParams(url).map((t) => {
        const prev = byName.get(t.name);
        return {
          id: prev?.id ?? crypto.randomUUID(),
          name: t.name,
          value: prev?.value ?? "",
          style: t.style,
        };
      });
    }

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

    // Body — delegated to the sub-editor: it handles the unified + legacy form
    // formats, the GraphQL query/variables value + schema reset, the type-select
    // sync, and the content render (a safe no-op in WebSocket mode).
    this.#bodyEditor.setValue(node);

    // WebSocket composer (Feature 32). The live connection is session-scoped and
    // owned by app.js — every newly loaded request starts disconnected (app.js
    // auto-disconnects the previous one), so reset the displayed state to idle.
    this.#wsMessage = node.wsMessage ?? "";
    this.#wsMessageFormat = node.wsMessageFormat === "json" ? "json" : "text";
    this.#wsSubprotocols = node.wsSubprotocols ?? "";
    if (this.#wsMessageEl) {
      this.#wsMessageEl.setValue(this.#wsMessage);
      this.#wsMessageEl.setLanguage(
        this.#wsMessageFormat === "json" ? "json" : "text",
      );
    }
    if (this.#wsSubprotoEl) this.#wsSubprotoEl.value = this.#wsSubprotocols;
    this.#syncWsFormatButtons?.();
    if (this.#protocol === "websocket") this.#applyWsState("idle");

    // Auth — delegated to the sub-component (reads node._decryptErrors,
    // auth* fields, and syncs its own toolbar controls).
    this.#auth.setModel(node);

    // Notes
    this.#notesEditor.setValue(node.notes ?? "");

    // Captures (Feature 03)
    this.#capturesEditor.setValue(node.captures);

    // Scripts (Feature 25) — round-trip the persisted source, per-pane enable
    // flags and splitter ratio onto the Scripts tab and the instance mirror the
    // send path reads. Drop any stale pre-script cache from the previous request.
    this.#preRequestScript = node.preRequestScript ?? "";
    this.#afterResponseScript = node.afterResponseScript ?? "";
    this.#preRequestScriptEnabled = node.preRequestScriptEnabled !== false;
    this.#preScriptCache = null;
    this.#scriptsEditor.setValue({
      preRequestScript: this.#preRequestScript,
      afterResponseScript: this.#afterResponseScript,
      preRequestScriptEnabled: node.preRequestScriptEnabled,
      afterResponseScriptEnabled: node.afterResponseScriptEnabled,
      scriptSplit: node.scriptSplit,
    });
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
      pathParams: Array.isArray(snapshot.pathParams) ? snapshot.pathParams : [],
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
    } else if (node.authType === "apikey") {
      node.authApiKey = {
        name: kv.name ?? "",
        value: kv.value ?? "",
        addTo: kv.addTo === "query" ? "query" : "header",
      };
    } else if (node.authType === "digest") {
      node.authDigest = {
        username: kv.username ?? "",
        password: kv.password ?? "",
      };
    } else if (node.authType === "ntlm") {
      node.authNtlm = {
        username: kv.username ?? "",
        password: kv.password ?? "",
        domain: kv.domain ?? "",
        workstation: kv.workstation ?? "",
      };
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
    } else if (node.bodyType === "graphql") {
      // GraphQL keeps query + variables structured in the snapshot; fall back to
      // the readable `body` (the query) for older snapshots.
      node.bodyGraphql = snapshot.bodyGraphql ?? {
        query: snapshot.body ?? "",
        variables: "",
      };
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
