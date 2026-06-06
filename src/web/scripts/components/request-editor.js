/**
 * request-editor.js — Request definition panel component
 */

"use strict";

import {
  parse as parseYaml,
  stringify as stringifyYaml,
} from "../vendor/yaml.js";
import {
  VariablePillEditor,
  getPickerDebounceMs,
} from "./variable-pill-editor.js";
import {
  resolveStringAsync,
  collectTemplateVariables,
  tokenize,
  parseFunctionCall,
  isFunctionCall,
} from "./variable-resolver.js";
import { PopupManager } from "../popup-manager.js";
import { icon } from "../icons.js";
import Prism from "../vendor/prism.js";
import { oauthExecutor } from "../auth/oauth-executor.js";
import {
  buildRequestPayload,
  encodeBaseUrl,
  detectPathParams,
  applyPathParams,
  resolvePathParamValues,
} from "./request-payload.js";
import {
  INTROSPECTION_QUERY,
  buildSchemaModel,
  suggestAtCursor,
} from "./graphql-schema.js";
import { executeIntrospection } from "./graphql-introspection.js";
import {
  validateGraphQLQuery,
  introspectionToSDL,
} from "./graphql-validate.js";
import { GraphQLSchemaViewer } from "./graphql-schema-viewer.js";
import { caretCoordinates } from "../utils/caret-coords.js";
import { RequestAuthEditor } from "./request-auth-editor.js";
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

// GraphQL query-editor autocomplete (Feature 34). One shared dropdown reused by
// whichever GraphQL query textarea is focused; it anchors at the text caret via
// a tiny fixed-position anchor element (the dropdown machinery anchors below an
// element, so we move this stand-in to the caret before each show()).
const _gqlAc = new AutocompleteDropdown(
  "hdr-autocomplete gql-autocomplete",
  "GraphQL suggestions",
);
// px floor for each GraphQL pane when the splitter is dragged/derived — keeps
// both the Query and Variables panes usable no matter how the container resizes.
const GQL_PANE_MIN = 64;
let _gqlCaretAnchor = null;
function _gqlAnchorAt({ left, top, height }) {
  if (!_gqlCaretAnchor) {
    _gqlCaretAnchor = document.createElement("div");
    _gqlCaretAnchor.className = "gql-caret-anchor";
    _gqlCaretAnchor.setAttribute("aria-hidden", "true");
    document.body.appendChild(_gqlCaretAnchor);
  }
  const s = _gqlCaretAnchor.style;
  s.position = "fixed";
  s.width = "0";
  s.pointerEvents = "none";
  s.left = `${left}px`;
  s.top = `${top}px`;
  s.height = `${height}px`;
  return _gqlCaretAnchor;
}

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

const TABS = [
  { id: "params", label: "Params" },
  { id: "headers", label: "Headers" },
  { id: "body", label: "Body" },
  { id: "auth", label: "Auth" },
  { id: "notes", label: "Notes" },
];

// Tabs for a WebSocket request (Feature 32): the Body tab is replaced by the
// Message composer. Params/Headers/Auth apply to the handshake; Notes are shared.
const WS_TABS = [
  { id: "params", label: "Params" },
  { id: "headers", label: "Headers" },
  { id: "message", label: "Message" },
  { id: "auth", label: "Auth" },
  { id: "notes", label: "Notes" },
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

export class RequestEditor {
  /** @type {HTMLElement} */
  #el;
  #method = "GET";
  #url = "";
  #activeTab = "params";
  #currentNodeId = null;

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
  // GraphQL body (Feature 34) — query + raw-JSON variables text. The introspected
  // schema is cached in-memory per loaded request (reset in load()), never
  // persisted, and drives the query-editor autocomplete.
  #bodyGraphqlQuery = "";
  #bodyGraphqlVariables = "";
  #graphqlSchema = null; // result of buildSchemaModel(), or null until fetched
  #graphqlIntrospection = null; // raw introspection ({ __schema }) for graphql-js validation
  #revalidateGqlQuery = null; // fn() to re-run query validation, or null when not in GraphQL mode
  #graphqlFetching = false; // guards against concurrent "Fetch schema" clicks
  // Code folding in the GraphQL editors — a global, persisted preference toggled
  // from Appearance settings or each editor's right-click menu. #gqlEditors holds
  // the live Query/Variables editor handles so a toggle applies without a rebuild.
  #editorFolding = true;
  #gqlEditors = null;
  // GraphQL Query/Variables split layout — session-level UI prefs (not persisted,
  // not part of the request). #bodyGraphqlFlow is the container flex-direction:
  // "column" = stacked (vertical splitter, drag ↕), "row" = side by side
  // (horizontal splitter, drag ↔), toggled at runtime. #bodyGraphqlVarsSize is
  // the Variables pane's share of the container's main axis as a FRACTION (0..1),
  // kept per orientation; null → use the default flex ratio. Storing a fraction
  // (rather than px) preserves the split's aspect ratio when the window resizes.
  #bodyGraphqlFlow = "row";
  #bodyGraphqlVarsSize = { column: null, row: null };
  // Observes the GraphQL container so the pane sizes re-derive from the fraction
  // on window/panel resize. Recreated per render, disconnected on body re-render.
  #gqlResizeObserver = null;
  // Body-form list element — rebuilt on every render; rows are re-wired through
  // the controller below. The controller owns all transient drag state.
  #bfListEl = null;
  #bfDrag = new DragReorderController({
    getItems: () => this.#bodyFormRows,
    render: () => this.#renderBodyContent(),
    dispatch: () => this.#dispatchBodyUpdated(),
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
  #wsMessageEl = null; // composer <textarea>
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
    window.addEventListener("wurl:ws-state", (e) => {
      this.#applyWsState(e.detail?.state ?? "idle");
    });

    // HTTP send-button in-flight toggle. Registered once here (not in
    // #renderUrlBar, which can re-run on a protocol switch) and operating on the
    // current this._sendBtn, so no listeners leak across rebuilds. No-op in
    // WebSocket mode, which has a Connect button driven by #applyWsState instead.
    window.addEventListener("wurl:request-loading", () => {
      this.#requestInFlight = true;
      const b = this._sendBtn;
      if (!b || this.#protocol === "websocket") return;
      b.textContent = "Stop";
      b.setAttribute("aria-label", "Stop request");
      b.classList.add("req-send-btn--cancel");
    });
    const resetSendBtn = () => {
      this.#requestInFlight = false;
      const b = this._sendBtn;
      if (!b || this.#protocol === "websocket") return;
      b.textContent = "Send";
      b.setAttribute("aria-label", "Send request");
      b.classList.remove("req-send-btn--cancel");
    };
    window.addEventListener("wurl:response-received", resetSendBtn);
    window.addEventListener("wurl:request-error", resetSendBtn);
  }

  /** Root DOM element — pass to Panel.mount(). */
  get element() {
    return this.#el;
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
      icon("caret", { size: null, className: "req-method-select__chevron" }),
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

      const _CHECK = icon("check", {
        size: 12,
        className: "req-method-menu__check-icon",
      });

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

    // The in-flight toggle (request-loading / response-received / request-error)
    // is registered once in the constructor and targets this._sendBtn, so a
    // protocol-driven rebuild of the URL bar can't accumulate stale listeners.
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

  // ── WebSocket URL bar (Feature 32) ────────────────────────────────────────
  // A static "WS" pill stands in for the HTTP method selector; the Send button
  // becomes a Connect/Disconnect toggle driven by the live connection state.
  #renderWsUrlBar() {
    const bar = document.createElement("div");
    bar.className = "req-url-bar";

    const wsLabel = document.createElement("span");
    wsLabel.className = "req-method-select req-method-select--ws";
    wsLabel.setAttribute("aria-label", "WebSocket");
    const lbl = document.createElement("span");
    lbl.className = "req-method-select__label";
    lbl.textContent = "WS";
    wsLabel.appendChild(lbl);

    const urlEditor = new VariablePillEditor({
      placeholder: "wss://echo.example.com",
      ariaLabel: "WebSocket URL",
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
    connectBtn.className = "req-send-btn";
    connectBtn.dataset.method = "ws";
    connectBtn.textContent = "Connect";
    connectBtn.setAttribute("aria-label", "Connect WebSocket");
    connectBtn.addEventListener("click", () => this.#toggleWsConnection());
    this.#wsConnectBtn = connectBtn;
    sendGroup.appendChild(connectBtn);

    bar.append(wsLabel, urlEditor.element, sendGroup);
    this.#el.appendChild(bar);
    this._urlInput = urlEditor.element;
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
    // Drop stale element refs the render methods will reassign.
    this._methodSel = this._methodSelLabel = this._sendBtn = null;
    this.#wsConnectBtn = this.#wsSendBtn = null;
    this.#wsMessageEl = this.#wsSubprotoEl = null;
    this.#syncWsFormatButtons = null;
    this.#bodyContentEl = this.#bodyTypeBarEl = null;
    this.#notesEl = null;
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
    bar.className = "ws-composer__bar";

    // Text / JSON format toggle.
    const fmt = document.createElement("div");
    fmt.className = "ws-composer__format";
    fmt.setAttribute("role", "group");
    fmt.setAttribute("aria-label", "Message format");
    const fmtBtns = {};
    for (const f of ["text", "json"]) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = f === "text" ? "Text" : "JSON";
      b.setAttribute("aria-pressed", String(this.#wsMessageFormat === f));
      b.addEventListener("click", () => {
        this.#wsMessageFormat = f;
        this.#syncWsFormatButtons?.();
        this.#dispatchWsFieldUpdate({ wsMessageFormat: f });
      });
      fmtBtns[f] = b;
      fmt.appendChild(b);
    }
    this.#syncWsFormatButtons = () => {
      for (const k of Object.keys(fmtBtns)) {
        fmtBtns[k].setAttribute(
          "aria-pressed",
          String(k === this.#wsMessageFormat),
        );
      }
    };

    const subproto = document.createElement("input");
    subproto.type = "text";
    subproto.className = "ws-composer__subproto";
    subproto.placeholder = "Subprotocols (optional, comma-separated)";
    subproto.value = this.#wsSubprotocols;
    subproto.setAttribute("aria-label", "WebSocket subprotocols");
    subproto.addEventListener("input", () => {
      this.#wsSubprotocols = subproto.value;
      this.#dispatchWsFieldUpdate({ wsSubprotocols: subproto.value });
    });
    this.#wsSubprotoEl = subproto;

    const sendBtn = document.createElement("button");
    sendBtn.type = "button";
    sendBtn.className = "ws-composer__send";
    sendBtn.textContent = "Send";
    sendBtn.disabled = this.#wsState !== "open";
    sendBtn.setAttribute("aria-label", "Send message");
    sendBtn.addEventListener("click", () => this.#sendWebSocketMessage());
    this.#wsSendBtn = sendBtn;

    bar.append(fmt, subproto, sendBtn);

    const ta = document.createElement("textarea");
    ta.className = "body-text-editor ws-composer__textarea";
    ta.placeholder = "Message to send… (supports {{variables}})";
    ta.spellcheck = false;
    ta.value = this.#wsMessage;
    ta.setAttribute("aria-label", "WebSocket message");
    ta.addEventListener("input", () => {
      this.#wsMessage = ta.value;
      this.#dispatchWsFieldUpdate({ wsMessage: ta.value });
    });
    ta.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        this.#sendWebSocketMessage();
      }
    });
    this.#wsMessageEl = ta;

    const hint = document.createElement("div");
    hint.className = "ws-composer__hint";
    hint.textContent = "Connect first, then send. ⌘/Ctrl+Enter to send.";

    container.append(bar, ta, hint);
    return container;
  }

  /** Connect (when idle/closed) or disconnect (when active). */
  #toggleWsConnection() {
    if (this.#wsState === "open" || this.#wsState === "connecting") {
      window.dispatchEvent(
        new CustomEvent("wurl:ws-disconnect", { detail: {}, bubbles: true }),
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
      new CustomEvent("wurl:ws-connect", {
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
    const raw = this.#wsMessageEl ? this.#wsMessageEl.value : this.#wsMessage;
    const data = await resolveStringAsync(raw ?? "", this.#variableContext);
    window.dispatchEvent(
      new CustomEvent("wurl:ws-send", { detail: { data }, bubbles: true }),
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
        ? "Disconnect"
        : state === "connecting"
          ? "Connecting…"
          : closing
            ? "Disconnecting…"
            : "Connect";
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
      new CustomEvent("wurl:request-updated", {
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
    this._tabContent = content;
  }

  #buildTabPane(tabId) {
    if (tabId === "params") return this.#buildParamsEditor();
    if (tabId === "headers") return this.#buildHeadersEditor();
    if (tabId === "body") return this.#buildBodyEditor();
    if (tabId === "message") return this.#buildMessageEditor();
    if (tabId === "auth") return this.#auth.element;
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
      <optgroup label="GraphQL">
        <option value="graphql">GraphQL</option>
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

    const { label: bfBulkLabel, check: bfBulkCheck } = this.#buildToolbarToggle(
      {
        text: " Bulk Editor",
        title: "Toggle between bulk text editor and key/value row editor",
        checked: this.#bodyFormBulkMode,
        onChange: (checked) => this.#handleBodyFormBulkToggle(checked),
      },
    );
    this.#bodyFormBulkCheckEl = bfBulkCheck;

    const addBtn = document.createElement("button");
    addBtn.className = "icon-btn params-toolbar-btn";
    addBtn.title = "Add field";
    addBtn.setAttribute("aria-label", "Add field");
    addBtn.innerHTML = `<span class="icon">${icon("add", { size: 15 })}</span>`;
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
    this.#disposePillEditors(this.#bodyFormPillEditors);
    // Remove any Prettify button / validation badge left over from a previous text type
    this.#bodyTypeBarEl?.querySelector(".body-prettify-btn")?.remove();
    this.#bodyTypeBarEl?.querySelector(".body-validate-badge")?.remove();
    // Remove any GraphQL fetch-schema button / layout toggle / status badge from
    // a prior render, dismiss a stale query-autocomplete dropdown, and stop
    // observing the old GraphQL container.
    this.#bodyTypeBarEl?.querySelector(".body-graphql-fetch-btn")?.remove();
    this.#bodyTypeBarEl?.querySelector(".body-graphql-flow-btn")?.remove();
    this.#bodyTypeBarEl?.querySelector(".body-graphql-status")?.remove();
    this.#gqlResizeObserver?.disconnect();
    this.#gqlResizeObserver = null;
    this.#revalidateGqlQuery = null; // reassigned by #renderBodyGraphql when applicable
    this.#gqlEditors = null; // reassigned by #renderBodyGraphql when applicable
    _gqlAc.hide();
    // Reset body form drag state whenever we switch panels
    this.#bfListEl = null;
    this.#bfDrag.reset();
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
        return this.#renderBodyForm(el);
      case "json":
        return this.#renderBodyText(el, "json", true);
      case "yaml":
        return this.#renderBodyText(el, "yaml", true);
      case "xml":
        return this.#renderBodyText(el, "xml", true);
      case "text":
        return this.#renderBodyText(el, "text", false);
      case "graphql":
        return this.#renderBodyGraphql(el);
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
  #renderBodyForm(el) {
    const rows = this.#bodyFormRows;

    // ── Bulk mode textarea ────────────────────────────────────────────────
    const bfBulkTa = document.createElement("textarea");
    bfBulkTa.className = "body-text-editor";
    bfBulkTa.placeholder =
      this.#bodyType === "form-data"
        ? "name=value\nfile=@/path/to/file\n# disabled=row"
        : "name=value\nfield1=foo\nfield2=bar\n# disabled=row";
    bfBulkTa.spellcheck = false;
    bfBulkTa.setAttribute("aria-label", "Form fields bulk editor");
    bfBulkTa.value = this.#bodyFormToBulkText();
    bfBulkTa.addEventListener("input", () => {
      this.#bodyFormRows = this.#bodyFormFromBulkText(bfBulkTa.value);
      this.#dispatchBodyUpdated();
    });
    this.#bodyFormBulkEl = bfBulkTa;
    el.appendChild(bfBulkTa);

    // ── KV wrap (column headers + list) ──────────────────────────────────
    const bfKvWrap = document.createElement("div");
    bfKvWrap.style.cssText =
      "display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden";
    // form-data rows carry a Text/File type column → widen the grid via CSS.
    if (this.#bodyType === "form-data") {
      bfKvWrap.classList.add("body-form--with-type");
    }
    this.#bodyFormKvWrapEl = bfKvWrap;

    // Column headers — form-data gets an extra Text/File type column.
    const typeCol =
      this.#bodyType === "form-data"
        ? `<span class="params-col-type"></span>`
        : "";
    const hdr = document.createElement("div");
    hdr.className = "params-header-row";
    hdr.innerHTML = `
      <span class="params-col-handle"></span>
      <span class="params-col-enabled"></span>
      ${typeCol}
      <span class="params-col-name">Name</span>
      <span class="params-col-value">Value</span>
      <span class="params-col-delete"></span>`;
    bfKvWrap.appendChild(hdr);

    // List — drag-to-reorder is wired through the controller, which creates
    // and owns the phantom placeholder. A fresh list is built on every render,
    // so attach() re-runs each time (the old list/listeners are GC'd with it).
    const list = document.createElement("div");
    list.className = "params-list";
    this.#bfListEl = list;
    this.#bfDrag.attach(list);

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
    const getCtx = () => this.#variableContext;
    const getItms = () => this.#getItems();
    // File fields exist only in multipart form-data, never form-urlencoded.
    const allowFile = this.#bodyType === "form-data";
    const addRow = () => {
      rows.push({
        id: crypto.randomUUID(),
        name: "",
        value: "",
        enabled: true,
      });
      this.#renderBodyContent();
      this.#dispatchBodyUpdated();
    };

    // ── Name pill editor (text and file rows alike) ──────────────────────
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
      onEnter: addRow,
    });
    nameEditor.setValue(row.name);
    this.#bodyFormPillEditors.push(nameEditor);

    // ── Value cell: a file picker for file rows, else a value pill editor ─
    let valueEl;
    if (allowFile && row.kind === "file") {
      valueEl = this.#buildBfFileCell(row);
    } else {
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
        onEnter: addRow,
      });
      valueEditor.setValue(row.value);
      this.#bodyFormPillEditors.push(valueEditor);
      valueEl = valueEditor.element;
    }

    // ── Text/File type toggle (form-data only) — an icon button that flips
    //    the field between a text value and a file upload. The glyph shows the
    //    CURRENT kind; the tooltip names it and the action. The whole row is
    //    rebuilt on toggle, so no in-place icon swap is needed here. ─────────
    let leading = null;
    if (allowFile) {
      const isFile = row.kind === "file";
      const typeToggle = document.createElement("button");
      typeToggle.type = "button";
      typeToggle.className = "icon-btn bf-type-toggle";
      typeToggle.innerHTML = icon(isFile ? "file" : "text", { size: 14 });
      const label = isFile
        ? "File field — switch to text"
        : "Text field — switch to file";
      typeToggle.title = label;
      typeToggle.setAttribute("aria-label", label);
      typeToggle.addEventListener("click", () => {
        if (row.kind === "file") {
          row.kind = "text";
          row.filePath = row.fileName = row.contentType = "";
        } else {
          row.kind = "file";
          row.value = ""; // text value is meaningless for a file field
        }
        this.#renderBodyContent();
        this.#dispatchBodyUpdated();
      });
      leading = typeToggle;
    }

    return this.#buildKvRow({
      item: row,
      noun: "field",
      name: nameEditor.element,
      value: valueEl,
      drag: this.#bfDrag,
      leading,
      onToggle: () => this.#dispatchBodyUpdated(),
      onDelete: () => {
        this.#bodyFormRows = rows.filter((r) => r.id !== row.id);
        this.#renderBodyContent();
        this.#dispatchBodyUpdated();
      },
    });
  }

  /**
   * Build the value-cell file picker for a form-data file field. The file's
   * absolute PATH is captured here via window.wurl.getPathForFile (Electron
   * removed File.path in v32); the bytes are read in the main process at send
   * time, so only the path crosses IPC.
   */
  #buildBfFileCell(row) {
    const cell = document.createElement("div");
    cell.className = "params-value bf-file-cell";

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.style.display = "none";
    fileInput.addEventListener("change", () => {
      const f = fileInput.files?.[0];
      if (!f) return;
      row.filePath = window.wurl?.getPathForFile?.(f) || f.path || f.name;
      row.fileName = f.name;
      row.contentType = f.type || "";
      this.#renderBodyContent();
      this.#dispatchBodyUpdated();
    });
    cell.appendChild(fileInput);

    if (row.filePath) {
      const nameSpan = document.createElement("span");
      nameSpan.className = "bf-file-name";
      nameSpan.textContent = row.fileName || row.filePath;
      nameSpan.title = row.filePath;
      cell.appendChild(nameSpan);

      const clearBtn = document.createElement("button");
      clearBtn.className = "icon-btn bf-file-clear";
      clearBtn.title = "Remove file";
      clearBtn.setAttribute("aria-label", "Remove file");
      clearBtn.textContent = "×";
      clearBtn.addEventListener("click", () => {
        row.filePath = row.fileName = row.contentType = "";
        this.#renderBodyContent();
        this.#dispatchBodyUpdated();
      });
      cell.appendChild(clearBtn);
    } else {
      const browseBtn = document.createElement("button");
      browseBtn.className = "bf-file-choose";
      browseBtn.textContent = "Choose file…";
      browseBtn.addEventListener("click", () => fileInput.click());
      cell.appendChild(browseBtn);
    }
    return cell;
  }

  /**
   * Serialize the form rows to bulk text. In form-data a file field uses `=@`
   * as its assignment marker (`name=@<path>`, or `name=@` for an unassigned
   * file) so it is visible and distinguishable from a text field (`name=value`);
   * disabled rows keep the leading `# `. form-urlencoded has no file fields, so
   * it falls back to the plain shared serializer.
   */
  #bodyFormToBulkText() {
    if (this.#bodyType !== "form-data") {
      return this.#kvRowsToText(this.#bodyFormRows);
    }
    return this.#bodyFormRows
      .map((r) => {
        const prefix = r.enabled ? "" : "# ";
        return r.kind === "file"
          ? `${prefix}${r.name}=@${r.filePath ?? ""}`
          : `${prefix}${r.name}=${r.value ?? ""}`;
      })
      .join("\n");
  }

  /**
   * Parse bulk text back into form rows. In form-data, a value beginning with
   * `@` (immediately after the `=`) marks a file field; the rest is its path.
   * File metadata (fileName / contentType) is recovered by matching the path
   * back to an existing file row so a bulk round-trip doesn't lose it.
   */
  #bodyFormFromBulkText(text) {
    if (this.#bodyType !== "form-data") {
      return this.#textToKvRows(text);
    }
    const prevFiles = this.#bodyFormRows.filter((r) => r.kind === "file");
    const out = [];
    for (const line of text.split("\n")) {
      let trimmed = line.trim();
      if (!trimmed) continue;
      const disabled = trimmed.startsWith("# ");
      if (disabled) trimmed = trimmed.slice(2).trim();
      if (!trimmed) continue;
      const eqIdx = trimmed.indexOf("=");
      const name = eqIdx === -1 ? trimmed : trimmed.slice(0, eqIdx).trim();
      if (!name) continue;
      const rhs = eqIdx === -1 ? "" : trimmed.slice(eqIdx + 1);
      if (rhs.startsWith("@")) {
        const filePath = rhs.slice(1);
        const prev = filePath
          ? prevFiles.find((r) => (r.filePath ?? "") === filePath)
          : null;
        out.push({
          id: crypto.randomUUID(),
          name,
          value: "",
          enabled: !disabled,
          kind: "file",
          filePath,
          fileName: prev?.fileName || (filePath.split(/[\\/]/).pop() ?? ""),
          contentType: prev?.contentType ?? "",
        });
      } else {
        out.push({
          id: crypto.randomUUID(),
          name,
          value: rhs,
          enabled: !disabled,
          kind: "text",
        });
      }
    }
    return out;
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
        validateBadge.textContent = "✓ VALID";
        validateBadge.title = `${type.toUpperCase()} is valid`;
      } else if (state === "invalid") {
        validateBadge.textContent = "X INVALID";
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
   * @param {string}              type    — "json" | "yaml" | "xml" | "graphql"
   */
  #syncHighlight(ta, codeEl, type) {
    const text = ta.value;
    if (!text) {
      codeEl.innerHTML = "";
      return;
    }
    const lang =
      { yaml: "yaml", xml: "markup", graphql: "graphql", json: "json" }[type] ??
      "json";
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

  // ── GraphQL editor (Query + Variables) ────────────────────────────────────
  #renderBodyGraphql(el) {
    // Type-bar controls, left to right: a layout toggle, a schema-status icon,
    // and the "Fetch schema" introspection button. The icon is empty until a
    // fetch runs, then shows a green tick on success or a red X on failure; the
    // tick carries the View / Download context menu.
    let statusBadge = null;
    let flowToggleBtn = null;
    if (this.#bodyTypeBarEl) {
      statusBadge = document.createElement("span");
      statusBadge.className = "body-graphql-status";
      statusBadge.setAttribute("aria-live", "polite");
      if (this.#graphqlSchema) this.#markSchemaBadgeLoaded(statusBadge);

      // Right-clicking the green tick offers View / Download of the schema.
      // No-op until a schema is actually loaded (i.e. only on the tick); stop the
      // event from reaching app.js's document-level handler.
      statusBadge.addEventListener("contextmenu", (e) => {
        if (!this.#graphqlIntrospection) return;
        e.preventDefault();
        e.stopPropagation();
        this.#showSchemaContextMenu(e.clientX, e.clientY);
      });

      // Toggle the Query/Variables split between stacked and side by side. The
      // glyph shows the layout it switches TO; applyFlow() (below) keeps it in
      // sync. Listener is wired after the panes exist.
      flowToggleBtn = document.createElement("button");
      flowToggleBtn.type = "button";
      flowToggleBtn.className = "icon-btn body-graphql-flow-btn";
      this.#bodyTypeBarEl.appendChild(flowToggleBtn);

      // Status icon sits between the layout toggle and the Fetch button.
      this.#bodyTypeBarEl.appendChild(statusBadge);

      const fetchBtn = document.createElement("button");
      fetchBtn.className =
        "params-toolbar-btn params-delete-all-btn body-graphql-fetch-btn";
      fetchBtn.textContent = "Fetch schema";
      fetchBtn.title =
        "Run GraphQL introspection against the URL to enable query autocomplete";
      fetchBtn.addEventListener("click", () =>
        this.#fetchGraphqlSchema(statusBadge, fetchBtn),
      );
      this.#bodyTypeBarEl.appendChild(fetchBtn);
    }

    const wrap = document.createElement("div");
    wrap.className = "body-graphql";

    // ── Query pane (GraphQL, with schema-aware autocomplete) ──────────────
    const queryPane = document.createElement("div");
    queryPane.className = "body-graphql-pane body-graphql-pane--query";
    const queryLabel = document.createElement("div");
    queryLabel.className = "body-graphql-pane__label";
    queryLabel.textContent = "Query";
    const queryBadge = document.createElement("span");
    queryBadge.className = "body-validate-badge body-graphql-query-badge";
    queryBadge.setAttribute("aria-live", "polite");
    // Warning (left of the tick/X) shown while no schema is loaded — validation
    // is then syntax-only. Carries its own tooltip, separate from the verdict's.
    const SCHEMA_WARN =
      "Validation is limited until the schema has been fetched";
    const queryWarn = document.createElement("span");
    queryWarn.className = "body-graphql-schema-warn";
    queryWarn.innerHTML = icon("warning", { size: 12 });
    queryWarn.title = SCHEMA_WARN;
    queryWarn.setAttribute("aria-label", SCHEMA_WARN);
    queryWarn.hidden = true;
    const queryStatus = document.createElement("span");
    queryStatus.className = "body-graphql-query-status";
    queryBadge.append(queryWarn, queryStatus);
    queryLabel.appendChild(queryBadge);
    queryPane.appendChild(queryLabel);

    // Live query validation — syntax always; full schema checks once the schema
    // has been fetched. Errors drive both the badge and the editor's inline
    // markers (red underlines + gutter dots).
    const applyQueryValidity = (
      state /* "valid" | "invalid" | null */,
      title,
    ) => {
      queryBadge.dataset.state = state ?? "";
      queryStatus.textContent =
        state === "valid" ? "✓ VALID" : state === "invalid" ? "X INVALID" : "";
      queryStatus.title = title ?? "";
      // Flag limited validation whenever a verdict is shown but no schema loaded.
      queryWarn.hidden = !state || Boolean(this.#graphqlIntrospection);
    };
    const runQueryValidation = (text) => {
      const { errors, schemaChecked } = validateGraphQLQuery(
        text,
        this.#graphqlIntrospection,
      );
      q?.setMarkers(errors);
      if (!text.trim()) {
        applyQueryValidity(null, "");
      } else if (errors.length) {
        const n = errors.length;
        applyQueryValidity(
          "invalid",
          `${n} error${n > 1 ? "s" : ""}:\n` +
            errors
              .map((e) => `  ${e.line}:${e.column}  ${e.message}`)
              .join("\n"),
        );
      } else {
        applyQueryValidity(
          "valid",
          schemaChecked
            ? "Query is valid against the schema"
            : "Query syntax is valid — fetch the schema for full validation",
        );
      }
    };
    let qValidateTimer = null;
    const scheduleQueryValidation = (text) => {
      clearTimeout(qValidateTimer);
      qValidateTimer = setTimeout(() => runQueryValidation(text), 400);
    };

    let q;
    q = this.#buildGqlEditor({
      lang: "graphql",
      value: this.#bodyGraphqlQuery,
      placeholder: "query {\n  …\n}",
      ariaLabel: "GraphQL query",
      onInput: (v, ta, codeEl) => {
        this.#bodyGraphqlQuery = v;
        this.#dispatchBodyUpdated();
        this.#syncHighlight(ta, codeEl, "graphql");
        scheduleQueryValidation(v);
      },
    });
    queryPane.appendChild(q.wrap);
    this.#wireGqlAutocomplete(q.ta, q.codeEl);
    // Exposed so #fetchGraphqlSchema can re-validate once a schema arrives.
    this.#revalidateGqlQuery = () => runQueryValidation(this.#bodyGraphqlQuery);
    wrap.appendChild(queryPane);

    // ── Splitter — drag to resize Query vs Variables ──────────────────────
    // Reuses the app's splitter styling; applyFlow() (below) sets the --v / --h
    // orientation class, cursor, and aria to match the current layout.
    const splitter = document.createElement("div");
    splitter.className = "splitter body-graphql-splitter";
    splitter.setAttribute("role", "separator");
    splitter.setAttribute("aria-label", "Resize the Query and Variables panes");
    splitter.tabIndex = 0;
    wrap.appendChild(splitter);

    // ── Variables pane (JSON, validated) ──────────────────────────────────
    const varsPane = document.createElement("div");
    varsPane.className = "body-graphql-pane body-graphql-pane--vars";
    const varsHeader = document.createElement("div");
    varsHeader.className = "body-graphql-pane__label";
    varsHeader.textContent = "Variables";
    const varsBadge = document.createElement("span");
    varsBadge.className = "body-validate-badge body-graphql-vars-badge";
    varsBadge.setAttribute("aria-live", "polite");
    varsHeader.appendChild(varsBadge);
    varsPane.appendChild(varsHeader);

    const applyVarsValidity = (state /* "valid" | "invalid" | null */) => {
      varsBadge.dataset.state = state ?? "";
      if (state === "valid") {
        varsBadge.textContent = "✓ VALID";
        varsBadge.title = "Variables JSON is valid";
      } else if (state === "invalid") {
        varsBadge.textContent = "X INVALID";
        varsBadge.title = "Variables JSON has a syntax error";
      } else {
        varsBadge.textContent = "";
        varsBadge.title = "";
      }
    };
    let varsTimer = null;
    const scheduleVarsValidation = (text) => {
      clearTimeout(varsTimer);
      varsTimer = setTimeout(() => {
        applyVarsValidity(
          !text.trim()
            ? null
            : this.#validate("json", text)
              ? "valid"
              : "invalid",
        );
      }, 400);
    };

    const v = this.#buildGqlEditor({
      lang: "json",
      value: this.#bodyGraphqlVariables,
      placeholder: '{\n  "key": "value"\n}',
      ariaLabel: "GraphQL variables (JSON)",
      onInput: (val, ta, codeEl) => {
        this.#bodyGraphqlVariables = val;
        this.#dispatchBodyUpdated();
        this.#syncHighlight(ta, codeEl, "json");
        scheduleVarsValidation(val);
      },
    });
    varsPane.appendChild(v.wrap);
    wrap.appendChild(varsPane);

    // Track both editors so a folding toggle (settings / context menu) applies live.
    this.#gqlEditors = [q, v];

    // Apply the current split layout (stacked vs side by side) to the container,
    // splitter, and Variables-pane size, and refresh the toggle button. Switching
    // is in-place — the editors are never rebuilt, so content/focus survive.
    const applyFlow = (flow) => {
      this.#bodyGraphqlFlow = flow;
      const row = flow === "row";
      wrap.classList.toggle("body-graphql--row", row);
      // row flow → vertical splitter bar (col-resize, --h);
      // column flow → horizontal splitter bar (row-resize, --v).
      splitter.classList.toggle("splitter--h", row);
      splitter.classList.toggle("splitter--v", !row);
      splitter.setAttribute(
        "aria-orientation",
        row ? "vertical" : "horizontal",
      );
      this.#applyGqlVarsSize(varsPane, wrap);
      if (flowToggleBtn) {
        // Glyph shows the CURRENT layout (house style, cf. the form-data
        // text/file toggle); the tooltip names the action.
        flowToggleBtn.innerHTML = icon(!row ? "columns" : "rows", { size: 14 });
        const title = row
          ? "Stack the Query and Variables panes (drag to resize ↕)"
          : "Place the Query and Variables panes side by side (drag to resize ↔)";
        flowToggleBtn.title = title;
        flowToggleBtn.setAttribute("aria-label", title);
      }
    };
    if (flowToggleBtn) {
      flowToggleBtn.addEventListener("click", () => {
        const next = this.#bodyGraphqlFlow === "row" ? "column" : "row";
        applyFlow(next);
        this.#persistGqlSetting({ graphqlSplitFlow: next });
      });
    }
    // Attach first so applyFlow() can read real container dimensions, then wire
    // dragging and observe the container so the split keeps its aspect ratio when
    // the window or surrounding panels resize.
    el.appendChild(wrap);
    this.#applyGraphqlHeaderRows();
    applyFlow(this.#bodyGraphqlFlow);
    this.#wireGqlSplitter(splitter, varsPane, wrap);
    this.#gqlResizeObserver?.disconnect();
    if (typeof ResizeObserver !== "undefined") {
      this.#gqlResizeObserver = new ResizeObserver(() =>
        this.#applyGqlVarsSize(varsPane, wrap),
      );
      this.#gqlResizeObserver.observe(wrap);
    }

    // Validate any pre-loaded variables immediately on render.
    if (this.#bodyGraphqlVariables.trim()) {
      applyVarsValidity(
        this.#validate("json", this.#bodyGraphqlVariables)
          ? "valid"
          : "invalid",
      );
    }
    // Validate the pre-loaded query now that the editor is laid out (inline
    // markers need real geometry, so this runs after el.appendChild(wrap)).
    this.#revalidateGqlQuery?.();
  }

  /**
   * Size the Variables pane from the stored fraction of the container's main axis
   * (width when side by side, height when stacked), clamped so neither pane
   * collapses. With no stored fraction the explicit basis is cleared so the CSS
   * flex ratio applies. Re-deriving px from the fraction is what keeps the split's
   * aspect ratio constant as the window/panels resize.
   */
  #applyGqlVarsSize(varsPane, wrap) {
    const frac = this.#bodyGraphqlVarsSize[this.#bodyGraphqlFlow];
    if (frac == null) {
      varsPane.style.flex = "";
      return;
    }
    const total =
      this.#bodyGraphqlFlow === "row" ? wrap.clientWidth : wrap.clientHeight;
    if (total <= 0) return; // not laid out yet — a later resize callback sizes it
    const max = Math.max(GQL_PANE_MIN, total - GQL_PANE_MIN);
    const px = Math.min(max, Math.max(GQL_PANE_MIN, frac * total));
    varsPane.style.flex = `0 0 ${px}px`;
  }

  /**
   * Make the GraphQL splitter draggable (and keyboard-resizable) on whichever
   * axis the current layout uses: vertical drag (↕) when stacked, horizontal
   * drag (↔) when side by side. The Variables pane trails the splitter, so
   * dragging toward the start of the axis (up / left) grows it. The chosen size
   * is applied as a main-axis flex-basis and remembered for the session, per
   * orientation, in #bodyGraphqlVarsSize. This mirrors app.js's makeSplitter but
   * is scoped to this component, since makeSplitter isn't exported.
   */
  #wireGqlSplitter(splitterEl, varsPane, wrap) {
    const isRow = () => this.#bodyGraphqlFlow === "row";
    const apply = (size) => {
      const total = isRow() ? wrap.clientWidth : wrap.clientHeight;
      if (total <= 0) return;
      const max = Math.max(GQL_PANE_MIN, total - GQL_PANE_MIN);
      const clamped = Math.min(max, Math.max(GQL_PANE_MIN, size));
      // Store the share as a fraction so the ratio survives a resize.
      this.#bodyGraphqlVarsSize[this.#bodyGraphqlFlow] = clamped / total;
      varsPane.style.flex = `0 0 ${clamped}px`;
    };
    const pointerPos = (e) => {
      const src = e.touches ? e.touches[0] : e;
      return isRow() ? src.clientX : src.clientY;
    };
    const varsExtent = () => {
      const rect = varsPane.getBoundingClientRect();
      return isRow() ? rect.width : rect.height;
    };

    let dragging = false;
    let start = 0;
    let startSize = 0;

    const onMove = (e) => {
      if (!dragging) return;
      if (e.cancelable) e.preventDefault();
      apply(startSize - (pointerPos(e) - start)); // toward start → grows Variables
    };
    const onEnd = () => {
      if (!dragging) return;
      dragging = false;
      splitterEl.classList.remove("splitter--dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onEnd);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      this.#persistGqlVarsFraction(); // save the final position
    };
    const onStart = (e) => {
      e.preventDefault();
      dragging = true;
      start = pointerPos(e);
      startSize = varsExtent();
      splitterEl.classList.add("splitter--dragging");
      document.body.style.cursor = isRow() ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
    };

    splitterEl.addEventListener("mousedown", (e) => {
      onStart(e);
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onEnd);
    });
    splitterEl.addEventListener(
      "touchstart",
      (e) => {
        onStart(e);
        window.addEventListener("touchmove", onMove, { passive: false });
        window.addEventListener("touchend", onEnd);
      },
      { passive: false },
    );

    // Keyboard resize (the splitter is focusable). Grow key = toward the start of
    // the axis (↑ stacked / ← side by side); the opposite key shrinks Variables.
    splitterEl.addEventListener("keydown", (e) => {
      const growKey = isRow() ? "ArrowLeft" : "ArrowUp";
      const shrinkKey = isRow() ? "ArrowRight" : "ArrowDown";
      if (e.key !== growKey && e.key !== shrinkKey) return;
      e.preventDefault();
      const step = e.shiftKey ? 48 : 16;
      apply(varsExtent() + (e.key === growKey ? step : -step));
      this.#persistGqlVarsFraction();
    });
  }

  /**
   * Build one Prism-overlay editor (textarea + syntax-highlight <pre>) for the
   * GraphQL panes. Mirrors the wrap used by #renderBodyText but without the
   * type-bar Prettify/validate wiring (those differ per pane).
   *
   * Adds indentation-based code folding: a gutter of click-to-toggle carets sits
   * to the left of each pane, and collapsing a block hides its inner lines. A
   * <textarea> can't hide arbitrary line ranges, so while folds are collapsed the
   * textarea shows a reduced "display" text while `fullText` holds the canonical
   * content. Any edit first expands every fold (see the beforeinput handler), so
   * onInput — and therefore the persisted value — always sees the full text.
   * Folding requires one logical line per visual row, so these editors don't wrap.
   */
  #buildGqlEditor({ lang, value, placeholder, ariaLabel, onInput }) {
    const MAX_FOLD_LINES = 5000; // above this, skip folding and behave as plain

    // Folding can be turned off globally (Appearance setting / editor context
    // menu). When off we keep the no-wrap layout (so validation underlines stay
    // aligned) but hide the gutter + carets — the --fold-on class drives that.
    let foldingEnabled = this.#editorFolding !== false;

    const wrap = document.createElement("div");
    wrap.className =
      "body-editor-wrap body-editor-wrap--folding" +
      (foldingEnabled ? " body-editor-wrap--fold-on" : "");

    const pre = document.createElement("pre");
    pre.className = "body-editor-pre";
    pre.setAttribute("aria-hidden", "true");
    const prismLang = lang === "graphql" ? "graphql" : "json";
    const codeEl = document.createElement("code");
    codeEl.className = `language-${prismLang}`;
    pre.appendChild(codeEl);

    // Fold gutter — carets live in `inner`, which is translated to track scroll.
    const gutter = document.createElement("div");
    gutter.className = "body-fold-gutter";
    const gutterInner = document.createElement("div");
    gutterInner.className = "body-fold-gutter__inner";
    gutter.appendChild(gutterInner);

    // Validation marker layer — red underlines, positioned in content coords and
    // translated to track scroll (same trick as the gutter). Sits above the
    // highlight <pre> but below the <textarea>, and never takes pointer events.
    const markers = document.createElement("div");
    markers.className = "body-gql-markers";
    const markersInner = document.createElement("div");
    markersInner.className = "body-gql-markers__inner";
    markers.appendChild(markersInner);

    const ta = document.createElement("textarea");
    ta.className = "body-text-editor body-text-editor--overlay";
    ta.value = value;
    ta.placeholder = placeholder;
    ta.spellcheck = false;
    ta.wrap = "off"; // folding aligns one gutter row per logical line
    ta.setAttribute("aria-label", ariaLabel);

    wrap.appendChild(pre);
    wrap.appendChild(markers);
    wrap.appendChild(gutter);
    wrap.appendChild(ta);

    // ── Fold state ────────────────────────────────────────────────────────
    // `collapsed` holds SOURCE line indices of collapsed openers; `folded` is
    // true while the textarea shows a reduced view (and `fullText` is then the
    // canonical content). When not folded the textarea itself is the source.
    const collapsed = new Set();
    let folded = false;
    let fullText = value;

    // Indentation-based fold ranges (mirrors the response viewer): a line whose
    // next non-blank line is more deeply indented opens a fold that runs until
    // indentation returns to its own depth. foldEnd: openerIdx -> last child idx.
    const computeFoldEnds = (lines) => {
      const foldEnd = new Map();
      if (lines.length > MAX_FOLD_LINES) return foldEnd;
      const indent = lines.map((l) =>
        l.trim() === "" ? null : l.length - l.trimStart().length,
      );
      for (let i = 0; i < lines.length; i++) {
        const depth = indent[i];
        if (depth === null) continue;
        let next = i + 1;
        while (next < lines.length && indent[next] === null) next++;
        if (next < lines.length && indent[next] > depth) {
          let end = i;
          for (
            let k = i + 1;
            k < lines.length && (indent[k] === null || indent[k] > depth);
            k++
          ) {
            if (indent[k] !== null) end = k;
          }
          foldEnd.set(i, end);
        }
      }
      return foldEnd;
    };

    // Resolve fold ranges and the visible "display" lines (collapsed folds'
    // inner lines skipped) from the given canonical text, with a map back to
    // source lines. Callers pass fullText during fold ops and the live textarea
    // value after edits — never inferred, so a reduced display is never mistaken
    // for the source.
    const buildView = (source) => {
      const lines = source.split("\n");
      const foldEnd = computeFoldEnds(lines);
      // Drop collapsed openers that text edits turned into non-openers.
      for (const i of [...collapsed]) if (!foldEnd.has(i)) collapsed.delete(i);

      const displayLines = [];
      const lineMap = []; // displayIdx -> source line idx
      const collapsedRows = new Set(); // display indices that are collapsed openers
      let coverEnd = -1;
      for (let i = 0; i < lines.length; i++) {
        if (i <= coverEnd) continue;
        if (collapsed.has(i)) {
          collapsedRows.add(displayLines.length);
          coverEnd = foldEnd.get(i);
        }
        lineMap.push(i);
        displayLines.push(lines[i]);
      }
      return { source, lines, foldEnd, displayLines, lineMap, collapsedRows };
    };

    // Paint the highlight layer. With no folds defer to the shared whole-blob
    // highlighter (identical to non-folding editors); with folds highlight each
    // visible line and append an elision marker to collapsed openers.
    const highlight = (view) => {
      if (!folded) {
        this.#syncHighlight(ta, codeEl, lang);
        return;
      }
      const grammar = Prism.languages[prismLang] ?? Prism.languages.plaintext;
      codeEl.innerHTML =
        view.displayLines
          .map((line, idx) => {
            const h = Prism.highlight(line, grammar, prismLang);
            return view.collapsedRows.has(idx)
              ? h + '<span class="body-fold-ellipsis"> ⋯</span>'
              : h;
          })
          .join("\n") + "\n";
      pre.scrollTop = ta.scrollTop;
      pre.scrollLeft = ta.scrollLeft;
    };

    // Rebuild the gutter: one row per display line, a caret on each fold opener.
    const renderGutter = (view) => {
      gutterInner.replaceChildren();
      if (!foldingEnabled) return; // no carets when folding is off
      const frag = document.createDocumentFragment();
      view.displayLines.forEach((_, idx) => {
        const row = document.createElement("div");
        row.className = "body-fold-row";
        const src = view.lineMap[idx];
        if (view.foldEnd.has(src)) {
          const isCollapsed = collapsed.has(src);
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "body-fold-toggle";
          btn.classList.toggle("body-fold-toggle--collapsed", isCollapsed);
          btn.setAttribute("aria-expanded", String(!isCollapsed));
          btn.setAttribute("aria-label", isCollapsed ? "Expand" : "Collapse");
          btn.innerHTML = icon("caret", { size: null });
          // Keep textarea focus/selection when clicking the gutter.
          btn.addEventListener("mousedown", (e) => e.preventDefault());
          btn.addEventListener("click", () => toggleFold(src));
          row.appendChild(btn);
        }
        frag.appendChild(row);
      });
      gutterInner.appendChild(frag);
      gutterInner.style.transform = `translateY(${-ta.scrollTop}px)`;
    };

    // setValue rewrites the textarea to the (possibly folded) display text — done
    // when folds change, not after edits (where the textarea is already current).
    const refresh = (source, setValue) => {
      const view = buildView(source);
      if (setValue) {
        const top = ta.scrollTop;
        const left = ta.scrollLeft;
        ta.value = view.displayLines.join("\n");
        ta.scrollTop = top;
        ta.scrollLeft = left;
      }
      renderGutter(view);
      highlight(view);
      renderMarkers();
      return view;
    };

    // Map a caret offset in the display text to the equivalent offset in fullText.
    const displayPosToFull = (pos, view) => {
      const ds = view.displayLines;
      let acc = 0;
      let row = 0;
      for (; row < ds.length; row++) {
        if (pos <= acc + ds[row].length) break;
        acc += ds[row].length + 1; // + newline
      }
      if (row >= ds.length) row = Math.max(0, ds.length - 1);
      const col = Math.max(0, pos - acc);
      const srcLine = view.lineMap[row] ?? 0;
      let fullAcc = 0;
      for (let i = 0; i < srcLine; i++) fullAcc += view.lines[i].length + 1;
      return fullAcc + Math.min(col, view.lines[srcLine]?.length ?? 0);
    };

    // Expand every fold (preserving the caret) before an edit mutates the text,
    // so fullText stays the single source of truth.
    const expandAllForEdit = () => {
      if (!folded) return;
      const view = buildView(fullText);
      const start = displayPosToFull(ta.selectionStart, view);
      const end = displayPosToFull(ta.selectionEnd, view);
      collapsed.clear();
      folded = false;
      ta.value = fullText;
      ta.setSelectionRange(start, end);
      refresh(fullText, false);
    };

    const toggleFold = (src) => {
      if (!foldingEnabled) return;
      if (!folded) fullText = ta.value; // snapshot before the first fold
      if (collapsed.has(src)) collapsed.delete(src);
      else collapsed.add(src);
      folded = collapsed.size > 0;
      refresh(fullText, true);
      ta.focus();
    };

    // Turn folding on/off live. Off: expand any collapsed folds (preserving the
    // caret) so the textarea holds the full text, then hide the gutter/carets;
    // the gutter padding goes away via the --fold-on class while no-wrap stays.
    const setFoldingEnabled = (on) => {
      on = !!on;
      if (on === foldingEnabled) return;
      if (!on && folded) {
        const view = buildView(fullText);
        const start = displayPosToFull(ta.selectionStart, view);
        const end = displayPosToFull(ta.selectionEnd, view);
        collapsed.clear();
        folded = false;
        ta.value = fullText;
        ta.setSelectionRange(start, end);
      }
      foldingEnabled = on;
      wrap.classList.toggle("body-editor-wrap--fold-on", on);
      refresh(ta.value, false); // rebuild gutter + reposition markers for new padding
    };

    // ── Validation markers ────────────────────────────────────────────────────
    // Errors carry full-text {line, column, start, end}. We position underlines
    // in display coordinates (so folds are honoured) and flag the matching gutter
    // row; an error inside a collapsed fold is attributed to its visible opener.
    let markerErrors = [];

    const syncMarkerScroll = () => {
      markersInner.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`;
    };

    const renderMarkers = () => {
      markersInner.replaceChildren();
      for (const row of gutterInner.children) {
        row.classList.remove("body-fold-row--error");
        if (row.dataset.errorTitle) {
          row.removeAttribute("title");
          delete row.dataset.errorTitle;
        }
      }
      if (!markerErrors.length) return;

      const view = buildView(folded ? fullText : ta.value);
      // Cumulative start offset of each display line (for in-line positioning).
      const dispStart = [];
      let acc = 0;
      for (const dl of view.displayLines) {
        dispStart.push(acc);
        acc += dl.length + 1;
      }

      const taRect = ta.getBoundingClientRect();
      const rowMsgs = new Map(); // displayRow -> [message]

      for (const err of markerErrors) {
        const srcLine = Math.max(0, (err.line ?? 1) - 1);
        let displayRow = view.lineMap.indexOf(srcLine);
        let hidden = false;
        if (displayRow === -1) {
          // Inside a collapsed fold — attribute to the covering opener row.
          for (const opener of collapsed) {
            const end = view.foldEnd.get(opener);
            if (end !== undefined && srcLine > opener && srcLine <= end) {
              displayRow = view.lineMap.indexOf(opener);
              hidden = true;
              break;
            }
          }
        }
        if (displayRow === -1) continue;

        if (!rowMsgs.has(displayRow)) rowMsgs.set(displayRow, []);
        rowMsgs
          .get(displayRow)
          .push(`${err.line}:${err.column}  ${err.message}`);
        if (hidden) continue; // can't underline a line that isn't shown

        const col = Math.max(0, (err.column ?? 1) - 1);
        const lineLen = view.lines[srcLine]?.length ?? 0;
        const startDisp = dispStart[displayRow] + col;
        const span = Math.max(1, Math.min(err.end - err.start, lineLen - col));
        const a = caretCoordinates(ta, startDisp);
        const b = caretCoordinates(ta, startDisp + span);
        const u = document.createElement("div");
        u.className = "body-gql-underline";
        u.style.left = `${a.left - taRect.left + ta.scrollLeft}px`;
        u.style.top = `${a.top - taRect.top + ta.scrollTop + a.height - 2}px`;
        u.style.width = `${Math.max(2, b.left - a.left)}px`;
        markersInner.appendChild(u);
      }

      for (const [displayRow, msgs] of rowMsgs) {
        const row = gutterInner.children[displayRow];
        if (!row) continue;
        row.classList.add("body-fold-row--error");
        row.title = msgs.join("\n");
        row.dataset.errorTitle = "1";
      }
      syncMarkerScroll();
    };

    // ── Wiring ──────────────────────────────────────────────────────────────
    ta.addEventListener("scroll", () => {
      pre.scrollTop = ta.scrollTop;
      pre.scrollLeft = ta.scrollLeft;
      gutterInner.style.transform = `translateY(${-ta.scrollTop}px)`;
      syncMarkerScroll();
    });

    // Right-click → edit menu (Cut/Copy/Paste) plus a "Code folding" toggle.
    // stopPropagation pre-empts app.js's generic editable-field menu.
    ta.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.#showEditorContextMenu(e.clientX, e.clientY);
    });

    // Auto-expand before an edit lands. keydown handles the common keyboard case
    // (mutating value+selection here lets the default insertion proceed cleanly);
    // beforeinput is the catch-all for paste / cut / drop / IME. expandAllForEdit
    // is idempotent, so the two firing together is harmless.
    ta.addEventListener("keydown", (e) => {
      if (!folded || e.ctrlKey || e.metaKey || e.altKey) return;
      const edits =
        e.key.length === 1 ||
        e.key === "Enter" ||
        e.key === "Backspace" ||
        e.key === "Delete" ||
        e.key === "Tab";
      if (edits) expandAllForEdit();
    });
    ta.addEventListener("beforeinput", expandAllForEdit);

    ta.addEventListener("input", () => {
      // beforeinput already expanded any folds, so the textarea holds full text.
      folded = false;
      onInput(ta.value, ta, codeEl); // persists + repaints highlight
      renderGutter(buildView(ta.value));
      // Stale markers (offsets shifted by the edit) are cleared now; the debounced
      // validator repaints them via setMarkers once typing pauses.
      markersInner.replaceChildren();
    });

    // The autocomplete-accept path sets ta.value directly (bypassing beforeinput);
    // these let it expand folds before, and resync the gutter after, that edit.
    ta._foldExpand = expandAllForEdit;
    ta._foldSync = () => {
      folded = false;
      renderGutter(buildView(ta.value));
    };

    // Replace the current inline-validation markers and repaint them.
    const setMarkers = (errors) => {
      markerErrors = Array.isArray(errors) ? errors : [];
      renderMarkers();
    };

    refresh(value, true);
    return { wrap, ta, codeEl, setMarkers, setFoldingEnabled };
  }

  /** Wire schema-aware autocomplete (fields / arguments / enum values) onto the query textarea. */
  #wireGqlAutocomplete(ta, codeEl) {
    const showSuggestions = () => {
      if (!this.#graphqlSchema) {
        _gqlAc.hide();
        return;
      }
      const pos = ta.selectionStart ?? ta.value.length;
      const res = suggestAtCursor(ta.value, pos, this.#graphqlSchema);
      if (!res) {
        _gqlAc.hide();
        return;
      }
      const coords = caretCoordinates(ta, pos);
      const anchor = _gqlAnchorAt(coords);
      _gqlAc.show(
        anchor,
        res.items,
        (label) => this.#applyGqlSuggestion(ta, codeEl, label),
        {
          minWidth: 220,
          renderItem: (item, entry) => {
            item.dataset.value = entry.label;
            item.innerHTML = "";
            const name = document.createElement("span");
            name.className = "gql-ac-name";
            name.textContent = entry.label;
            item.appendChild(name);
            if (entry.detail) {
              const detail = document.createElement("span");
              detail.className = "gql-ac-detail";
              detail.textContent = entry.detail;
              item.appendChild(detail);
            }
          },
        },
      );
    };

    // Hold the popup back by the configurable picker-debounce so it doesn't cover
    // the query the instant you type/click. Mirrors the {{ }} picker: while the
    // popup is already open it updates immediately (responsive filtering); while
    // it's hidden, the first appearance waits out the debounce.
    let acTimer = null;
    const cancelRefresh = () => {
      clearTimeout(acTimer);
      acTimer = null;
    };
    const refresh = () => {
      cancelRefresh();
      if (_gqlAc.visible) showSuggestions();
      else acTimer = setTimeout(showSuggestions, getPickerDebounceMs());
    };

    ta.addEventListener("input", refresh);
    ta.addEventListener("click", refresh);
    ta.addEventListener("keyup", (e) => {
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) refresh();
    });
    ta.addEventListener("blur", () => {
      cancelRefresh();
      _gqlAc.scheduleHide();
    });
    ta.addEventListener("keydown", (e) => {
      // Escape also cancels a pending (not-yet-shown) popup.
      if (e.key === "Escape") cancelRefresh();
      if (!_gqlAc.visible) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        _gqlAc.navigate(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        _gqlAc.navigate(-1);
      } else if (e.key === "Escape") {
        e.preventDefault();
        _gqlAc.hide();
      } else if (e.key === "Enter" || e.key === "Tab") {
        const label = _gqlAc.activeLabel();
        if (label !== null) {
          e.preventDefault();
          this.#applyGqlSuggestion(ta, codeEl, label);
        }
      }
    });
  }

  /** Replace the word being typed at the caret with the chosen suggestion. */
  #applyGqlSuggestion(ta, codeEl, label) {
    ta._foldExpand?.(); // accepting a suggestion is an edit — expand folds first
    const pos = ta.selectionStart ?? ta.value.length;
    const before = ta.value.slice(0, pos);
    const m = /[_A-Za-z][_A-Za-z0-9]*$/.exec(before);
    const start = m ? pos - m[0].length : pos;
    ta.value = ta.value.slice(0, start) + label + ta.value.slice(pos);
    const caret = start + label.length;
    ta.setSelectionRange(caret, caret);
    this.#bodyGraphqlQuery = ta.value;
    this.#dispatchBodyUpdated();
    this.#syncHighlight(ta, codeEl, "graphql");
    ta._foldSync?.(); // refresh the fold gutter for the inserted text
    this.#revalidateGqlQuery?.(); // re-validate + repaint markers for the new text
    _gqlAc.hide();
    ta.focus();
  }

  /**
   * Run the standard introspection query against the request URL (reusing the
   * request's own params/headers/auth via buildRequestPayload) and cache the
   * resulting schema for autocomplete. Every failure path is surfaced via a
   * notification + the status badge — never silent.
   */
  async #fetchGraphqlSchema(statusBadge, btn) {
    if (this.#graphqlFetching) return;
    const rawUrl = this.#urlPillEditor.getValue().trim();
    if (!rawUrl) {
      PopupManager.notify({
        title: "No URL",
        message: "Enter the GraphQL endpoint URL before fetching its schema.",
      });
      return;
    }

    this.#graphqlFetching = true;
    if (btn) btn.disabled = true;
    if (statusBadge) {
      statusBadge.dataset.state = "loading";
      statusBadge.innerHTML = "";
      statusBadge.removeAttribute("aria-label");
      statusBadge.title = "Fetching schema…";
    }

    const ctx = this.#variableContext;
    const rv = (s) => resolveStringAsync(s, ctx);
    try {
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
      const json = await executeIntrospection({ url: finalUrl, headers, body });
      const model = buildSchemaModel(json);
      if (!model) throw new Error("Could not parse the introspection schema.");
      this.#graphqlSchema = model;
      // Keep the raw introspection ({ __schema }) so graphql-js can build a real
      // schema for full query validation, then re-validate the live query.
      this.#graphqlIntrospection = json?.data?.__schema
        ? json.data
        : json?.__schema
          ? json
          : null;
      this.#revalidateGqlQuery?.();
      this.#markSchemaBadgeLoaded(statusBadge);
    } catch (err) {
      this.#graphqlSchema = null;
      this.#graphqlIntrospection = null;
      this.#revalidateGqlQuery?.();
      if (statusBadge) {
        statusBadge.dataset.state = "error";
        statusBadge.innerHTML = icon("close", { size: 14 });
        statusBadge.setAttribute("aria-label", "Schema fetch failed");
        statusBadge.title = err?.message ?? "Could not fetch the schema.";
      }
      PopupManager.notify({
        title: "GraphQL introspection failed",
        message: err?.message ?? "Could not fetch the schema.",
      });
    } finally {
      this.#graphqlFetching = false;
      if (btn) btn.disabled = false;
    }
  }

  /**
   * Put the introspection status icon into its "schema loaded" (green tick)
   * state and advertise that it carries a right-click menu (View / Download
   * schema).
   */
  #markSchemaBadgeLoaded(badge) {
    if (!badge || !this.#graphqlSchema) return;
    badge.dataset.state = "ok";
    badge.innerHTML = icon("check", { size: 14 });
    badge.setAttribute("aria-label", "Schema loaded");
    badge.title = `${this.#graphqlSchema.types.size} types available — right-click to view or download the schema`;
  }

  /**
   * Native context menu for the "schema loaded" badge: view the schema in a
   * read-only modal, or save it to a file. Both render the cached introspection
   * as SDL.
   */
  async #showSchemaContextMenu(x, y) {
    const id = await window.wurl?.ui?.contextMenu({
      items: [
        { id: "view", label: "View Schema" },
        { id: "download", label: "Download Schema" },
      ],
      x,
      y,
    });
    if (id === "view") this.#viewGraphqlSchema();
    else if (id === "download") this.#downloadGraphqlSchema();
  }

  /**
   * Right-click menu for a GraphQL editor: the native Cut/Copy/Paste roles plus
   * a "Code folding" checkbox that flips the global setting live.
   */
  async #showEditorContextMenu(x, y) {
    const id = await window.wurl?.ui?.editContextMenu(x, y, [
      { type: "separator" },
      {
        id: "toggle-folding",
        type: "checkbox",
        checked: this.#editorFolding,
        label: "Code folding",
      },
    ]);
    if (id === "toggle-folding") this.#setEditorFolding(!this.#editorFolding);
  }

  /**
   * Set the global editor-folding preference: apply it to the live GraphQL
   * editors and persist it (Appearance settings reflect it on next open).
   */
  #setEditorFolding(on) {
    on = !!on;
    this.#editorFolding = on;
    this.#gqlEditors?.forEach((ed) => ed.setFoldingEnabled(on));
    this.#persistGqlSetting({ editorFolding: on });
  }

  /**
   * Render the cached introspection as SDL, or surface a notification and
   * return null when it cannot be produced.
   */
  #graphqlSchemaSDL() {
    const sdl = introspectionToSDL(this.#graphqlIntrospection);
    if (!sdl) {
      PopupManager.notify({
        title: "Schema unavailable",
        message:
          "The fetched schema could not be rendered. Try fetching it again.",
      });
      return null;
    }
    return sdl;
  }

  /** Open the read-only schema viewer for the loaded schema. */
  #viewGraphqlSchema() {
    const sdl = this.#graphqlSchemaSDL();
    if (!sdl) return;
    GraphQLSchemaViewer.open(sdl, {
      onDownload: () => this.#downloadGraphqlSchema(),
    });
  }

  /** Save the loaded schema to a `.graphql` file via the native save dialog. */
  #downloadGraphqlSchema() {
    const sdl = this.#graphqlSchemaSDL();
    if (!sdl) return;
    window.wurl?.export?.saveFile("schema.graphql", sdl, [
      { name: "GraphQL Schema", extensions: ["graphql", "gql"] },
      { name: "All Files", extensions: ["*"] },
    ]);
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

    const iconEl = document.createElement("div");
    iconEl.className = "body-file-zone__icon";
    iconEl.innerHTML = `<svg width="40" height="40" viewBox="0 0 40 40" fill="none"
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
      // Electron removed File.path in v32; resolve via the preload bridge.
      this.#bodyFilePath = window.wurl?.getPathForFile?.(f) || f.path || f.name;
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
      this.#bodyFilePath =
        window.wurl?.getPathForFile?.(f) ||
        f.path ||
        f.webkitRelativePath ||
        f.name;
      this.#bodyFileObject = f;
      this.#renderFileChosen(el);
      this.#dispatchBodyUpdated();
    });

    zone.appendChild(iconEl);
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
          bodyGraphql: {
            query: this.#bodyGraphqlQuery,
            variables: this.#bodyGraphqlVariables,
          },
        },
        bubbles: true,
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
      text: " Bulk Editor",
      title: "Toggle between bulk text editor and key/value row editor",
      checked: o.bulkMode,
      onChange: o.onBulkToggle,
    });
    toolbar.appendChild(bulkLabel);

    const addBtn = document.createElement("button");
    addBtn.className = "icon-btn params-toolbar-btn";
    addBtn.title = `Add ${o.noun}`;
    addBtn.setAttribute("aria-label", `Add ${o.noun}`);
    addBtn.innerHTML = `<span class="icon">${icon("add", { size: 15 })}</span>`;
    addBtn.addEventListener("click", () => o.onAdd());

    const delAllBtn = document.createElement("button");
    delAllBtn.className =
      "params-toolbar-btn params-toolbar-btn--danger params-delete-all-btn";
    delAllBtn.title = `Delete all ${o.nounPlural}`;
    delAllBtn.setAttribute("aria-label", `Delete all ${o.nounPlural}`);
    delAllBtn.textContent = "Delete All";

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
      <span class="params-col-value">Value</span>
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
    // Right-side toggle: show / hide the URL preview bar
    const { label: showUrlLabel } = this.#buildToolbarToggle({
      text: "Show URL Preview",
      title: "Show or hide the URL preview bar",
      id: "url-preview-toggle",
      checked: this.#urlPreviewEnabled,
      onChange: (checked) => {
        this.#urlPreviewEnabled = checked;
        this.#updateUrlPreview();
        window.dispatchEvent(
          new CustomEvent("wurl:editor-setting-changed", {
            detail: { showUrlPreview: checked },
            bubbles: true,
          }),
        );
      },
    });

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
      noun: "parameter",
      nounPlural: "parameters",
      onAdd: () => this.#addParam(),
      getCount: () => this.#params.length,
      onDeleteAll: () => this.#deleteAllParams(),
      nameColLabel: "Name",
      bulkPlaceholder: "name=value\nparam1=foo\nparam2=bar\n# disabled=row",
      bulkAriaLabel: "Parameters bulk editor",
      onBulkInput: (value) => {
        this.#params = this.#textToKvRows(value);
        this.#updateUrlPreview();
        this.#dispatchParamsUpdated();
      },
      drag: this.#paramsDrag,
      rightToggle: showUrlLabel,
      previewBar: this.#buildUrlPreviewBar(),
    });

    this.#paramsAddBtnEl = addBtn;
    this.#paramsDelAllBtnEl = delAllBtn;
    this.#paramsBulkEl = bulkEl;
    this.#paramsKvWrapEl = kvWrapEl;
    this.#paramsListEl = listEl;
    this._paramsDeleteAllCleanup = deleteAllCleanup;

    this.#applyParamsBulkMode();
    this.#renderParamsList();
    return container;
  }

  // ── Headers editor ──────────────────────────────────────────────────
  #buildHeadersEditor() {
    // Right-side toggle: show standard header-name suggestions
    const { label: listHdrLabel } = this.#buildToolbarToggle({
      text: " List Headers",
      title: "Show standard header suggestions when editing the header name",
      id: "list-headers-toggle",
      checked: this.#headerSuggestionsEnabled,
      onChange: (checked) => {
        this.#headerSuggestionsEnabled = checked;
        if (!checked) _hdrAc.hide();
        // Persist the preference into settings
        window.dispatchEvent(
          new CustomEvent("wurl:editor-setting-changed", {
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
      noun: "header",
      nounPlural: "headers",
      onAdd: () => this.#addHeader(),
      getCount: () => this.#headers.length,
      onDeleteAll: () => this.#deleteAllHeaders(),
      nameColLabel: "Header",
      bulkPlaceholder:
        "Header-Name: value\nContent-Type: application/json\nAuthorization: Bearer token\n# X-Disabled: skipped",
      bulkAriaLabel: "Headers bulk editor",
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
    this._headersDeleteAllCleanup = deleteAllCleanup;

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
      empty.textContent = "No headers — click  +  to add one.";
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
      noun: "header",
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
      empty.textContent = "No parameters — click  +  to add one.";
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
    nameInput.placeholder = "name";
    nameInput.spellcheck = false;
    nameInput.setAttribute("aria-label", "Path parameter name");
    nameInput.addEventListener("input", () =>
      this.#renamePathParam(pp, nameInput.value),
    );

    // Value — a pill editor (variables/functions + secret reveal, as query values).
    const valueEditor = new VariablePillEditor({
      placeholder: "Value",
      ariaLabel: "Path parameter value",
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
    statusIcon.title = "Path parameter";
    statusIcon.setAttribute("aria-label", "Path parameter");
    statusIcon.innerHTML = icon("braces", { size: 14 });

    return this.#buildKvRow({
      item: pp,
      noun: "path parameter",
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
    // Substitute path params before percent-encoding so `{id}` braces aren't
    // mangled by encodeBaseUrl (which would otherwise %7B-escape them).
    const substituted = applyPathParams(
      urlParts.join(""),
      await resolvePathParamValues(this.#pathParams, (s) =>
        resolveStringAsync(s, ctx),
      ),
    );
    const base = encodeBaseUrl(substituted);

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

    return this.#buildKvRow({
      item: param,
      index,
      noun: "parameter",
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

  // ── Body form bulk editor ─────────────────────────────────────────────────

  #handleBodyFormBulkToggle(nowBulk) {
    if (nowBulk && !this.#bodyFormBulkMode) {
      if (this.#bodyFormBulkEl)
        this.#bodyFormBulkEl.value = this.#bodyFormToBulkText();
    } else if (!nowBulk && this.#bodyFormBulkMode) {
      if (this.#bodyFormBulkEl)
        this.#bodyFormRows = this.#bodyFormFromBulkText(
          this.#bodyFormBulkEl.value,
        );
    }
    this.#bodyFormBulkMode = nowBulk;
    this.#applyBodyFormBulkMode();
    if (!nowBulk) {
      this.#disposePillEditors(this.#bodyFormPillEditors);
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

  #dispatchPathParamsUpdated() {
    if (!this.#currentNodeId) return;
    // Persist only id/name/value; the token style is re-derived from the URL.
    window.dispatchEvent(
      new CustomEvent("wurl:request-updated", {
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
    const rawUrl = this.#urlPillEditor.getValue().trim();
    if (!rawUrl) {
      this.#urlPillEditor.focus();
      return;
    }

    // ── Path params must all be named — a blank token can't be substituted ──
    if (this.#pathParams.some((p) => !(p.name ?? "").trim())) {
      PopupManager.notify({
        title: "Incomplete path parameter",
        message:
          "A path parameter has a blank name. Name every path parameter (or remove its token from the URL) before sending.",
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
    if (this.#bodyFormBulkMode && this.#bodyFormBulkEl)
      this.#bodyFormRows = this.#bodyFormFromBulkText(
        this.#bodyFormBulkEl.value,
      );

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

    // ── Build the native request payload ─────────────────────────────────
    // Query-param encoding, header resolution, the auth transforms that reduce
    // to a static header / query value (basic, bearer, apikey) or a pass-through
    // credential bag (digest, ntlm, aws-iam), and body serialisation are shared
    // with the dependency prefetcher (app.js) via buildRequestPayload(). OAuth2
    // is the one auth type that can't be a pure transform — it's interactive —
    // so it runs as a post-step below, after the payload (including any
    // user-supplied headers) already exists.
    const authModel = this.#auth.getModel();
    const {
      finalUrl,
      headers,
      body,
      bodyFilePath,
      multipart,
      awsIam,
      authDigest,
      authNtlm,
    } = await buildRequestPayload(
      {
        method: this.#method,
        // Substitute path params before percent-encoding (so `{id}` survives).
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
        bodyType: this.#bodyType,
        bodyText: this.#bodyText,
        bodyFormRows: this.#bodyFormRows,
        bodyFile: this.#bodyFileObject,
        bodyGraphql: {
          query: this.#bodyGraphqlQuery,
          variables: this.#bodyGraphqlVariables,
        },
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
        window.dispatchEvent(new CustomEvent("wurl:request-loading"));

        // ── Acquire token (cache → refresh → full flow) ────────────────────
        let _oauthResult;
        try {
          _oauthResult = await oauthExecutor.acquireToken({
            ...authModel.authOAuth2,
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

        // ── Handle flow failure ────────────────────────────────────────────
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
        // The prefix is resolved by the auth editor: live DOM input first
        // (covers a value typed but not yet committed to state), then the
        // in-memory state, then the "Bearer" default.
        const _prefix = this.#auth.getOAuth2HeaderPrefix();
        headers["Authorization"] = `${_prefix} ${_oauthResult.accessToken}`;

        // Keep local auth state in sync (token display + expiry badge).
        this.#auth.applyAcquiredToken({
          accessToken: _oauthResult.accessToken,
          refreshToken: _oauthResult.refreshToken,
          expiresAt: _oauthResult.expiresAt,
        });
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
          multipart,
          awsIam,
          authDigest,
          authNtlm,
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
    ].filter(Boolean);
    for (const editor of allEditors) {
      editor.revalidate();
    }
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
      this.#urlPreviewEnabled = !!settings.showUrlPreview;
      // Sync the Show URL checkbox by ID
      const cb = this.#el.querySelector("#url-preview-toggle");
      if (cb) cb.checked = this.#urlPreviewEnabled;
      this.#updateUrlPreview();
    }
    if (settings.removeHeaders != null) {
      this.#removeHeaders = !!settings.removeHeaders;
      this.#applyBodyFormHeaderRow();
      this.#applyGraphqlHeaderRows();
    }
    if (settings.editorFolding != null) {
      this.#editorFolding = !!settings.editorFolding;
      // Apply live to any on-screen GraphQL editors (no rebuild needed).
      this.#gqlEditors?.forEach((ed) =>
        ed.setFoldingEnabled(this.#editorFolding),
      );
    }

    // GraphQL split orientation + position. Apply only the keys that differ from
    // the live state so unrelated settings changes don't disturb the editor; if
    // something did change and the GraphQL body is on screen, re-render it so the
    // restored layout takes effect.
    let gqlChanged = false;
    if (
      (settings.graphqlSplitFlow === "row" ||
        settings.graphqlSplitFlow === "column") &&
      settings.graphqlSplitFlow !== this.#bodyGraphqlFlow
    ) {
      this.#bodyGraphqlFlow = settings.graphqlSplitFlow;
      gqlChanged = true;
    }
    const setFrac = (flow, val) => {
      const frac = typeof val === "number" && val > 0 && val < 1 ? val : null;
      if (frac !== this.#bodyGraphqlVarsSize[flow]) {
        this.#bodyGraphqlVarsSize[flow] = frac;
        gqlChanged = true;
      }
    };
    setFrac("column", settings.graphqlVarsFractionColumn);
    setFrac("row", settings.graphqlVarsFractionRow);
    if (gqlChanged && this.#bodyType === "graphql") this.#renderBodyContent();
  }

  /** Dispatch a settings change so app.js merges + persists it (see app.js). */
  #persistGqlSetting(detail) {
    window.dispatchEvent(
      new CustomEvent("wurl:editor-setting-changed", { detail, bubbles: true }),
    );
  }

  /** Persist the Variables-pane fraction for the current orientation. */
  #persistGqlVarsFraction() {
    const key =
      this.#bodyGraphqlFlow === "row"
        ? "graphqlVarsFractionRow"
        : "graphqlVarsFractionColumn";
    this.#persistGqlSetting({
      [key]: this.#bodyGraphqlVarsSize[this.#bodyGraphqlFlow],
    });
  }

  /** Show/hide the body-form column-label row to match the removeHeaders setting. */
  #applyBodyFormHeaderRow() {
    const hdr = this.#bodyFormKvWrapEl?.querySelector(".params-header-row");
    if (hdr) hdr.style.display = this.#removeHeaders ? "none" : "";
  }

  /** Show/hide the GraphQL Query/Variables pane labels to match removeHeaders. */
  #applyGraphqlHeaderRows() {
    this.#bodyContentEl
      ?.querySelectorAll(".body-graphql-pane__label")
      .forEach((hdr) => {
        hdr.style.display = this.#removeHeaders ? "none" : "";
      });
  }

  /**
   * Populate the editor from a saved request node.
   * @param {object} node
   */
  load(node) {
    this.#currentNodeId = node.id ?? null;

    // Cancel any in-progress inline confirm on the Delete All buttons.
    this._paramsDeleteAllCleanup?.();
    this._headersDeleteAllCleanup?.();
    this._bodyFormDeleteAllCleanup?.();

    // Protocol — rebuild the url bar + tabs when switching between HTTP and
    // WebSocket so the right controls (method vs WS, Body vs Message) render.
    this.#protocol = node.protocol === "websocket" ? "websocket" : "http";
    if (this.#protocol !== this.#renderedProtocol) {
      this.#rebuildLayout();
    }

    if (node.method && this._methodSel) {
      this.#method = node.method;
      this._methodSelLabel.textContent = node.method;
      this._methodSel.dataset.method = node.method.toLowerCase();
      this._sendBtn.dataset.method = node.method.toLowerCase();
    }

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

    // Body
    this.#bodyType = node.bodyType ?? "no-body";
    // Form rows — new unified format first, then legacy per-type fallbacks
    if (Array.isArray(node.bodyFormRows)) {
      this.#bodyFormRows = node.bodyFormRows.map((r) => ({
        id: r.id ?? crypto.randomUUID(),
        name: r.name ?? "",
        value: r.value ?? "",
        enabled: r.enabled ?? true,
        // Multipart file fields (Feature 49) — carried through unchanged. Older
        // rows lack these, defaulting to a plain text field.
        kind: r.kind === "file" ? "file" : "text",
        filePath: r.filePath ?? "",
        fileName: r.fileName ?? "",
        contentType: r.contentType ?? "",
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
    // GraphQL body (Feature 34) — query + variables; the introspected schema is
    // per-request and not persisted, so reset it when a new request loads.
    this.#bodyGraphqlQuery = node.bodyGraphql?.query ?? "";
    this.#bodyGraphqlVariables = node.bodyGraphql?.variables ?? "";
    this.#graphqlSchema = null;
    // Sync the select element if the body tab has been built
    const sel = this.#el.querySelector(".body-type-select");
    if (sel) sel.value = this.#bodyType;
    this.#renderBodyContent(); // safe no-op in WebSocket mode (no body pane)

    // WebSocket composer (Feature 32). The live connection is session-scoped and
    // owned by app.js — every newly loaded request starts disconnected (app.js
    // auto-disconnects the previous one), so reset the displayed state to idle.
    this.#wsMessage = node.wsMessage ?? "";
    this.#wsMessageFormat = node.wsMessageFormat === "json" ? "json" : "text";
    this.#wsSubprotocols = node.wsSubprotocols ?? "";
    if (this.#wsMessageEl) this.#wsMessageEl.value = this.#wsMessage;
    if (this.#wsSubprotoEl) this.#wsSubprotoEl.value = this.#wsSubprotocols;
    this.#syncWsFormatButtons?.();
    if (this.#protocol === "websocket") this.#applyWsState("idle");

    // Auth — delegated to the sub-component (reads node._decryptErrors,
    // auth* fields, and syncs its own toolbar controls).
    this.#auth.setModel(node);

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
