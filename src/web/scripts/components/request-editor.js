/**
 * request-editor.js — Request definition panel component
 */

"use strict";

import { parse as parseYaml, stringify as stringifyYaml } from "../vendor/yaml.js";
import { VariablePillEditor } from "./variable-pill-editor.js";
import { resolveString, collectTemplateVariables } from "./variable-resolver.js";
import { PopupManager } from "../popup-manager.js";


// Standard HTTP request headers offered in the header-name combo box.
// Custom values are always accepted too (free-text input).
const STANDARD_HEADERS = [
  "Accept",
  "Accept-Charset",
  "Accept-Encoding",
  "Accept-Language",
  "Authorization",
  "Cache-Control",
  "Connection",
  "Content-Encoding",
  "Content-Length",
  "Content-MD5",
  "Content-Type",
  "Cookie",
  "Date",
  "DNT",
  "Expect",
  "Forwarded",
  "From",
  "Host",
  "If-Match",
  "If-Modified-Since",
  "If-None-Match",
  "If-Range",
  "If-Unmodified-Since",
  "Max-Forwards",
  "Origin",
  "Pragma",
  "Proxy-Authorization",
  "Range",
  "Referer",
  "TE",
  "Trailer",
  "Transfer-Encoding",
  "Upgrade",
  "User-Agent",
  "Via",
  "Warning",
  "X-Api-Key",
  "X-Auth-Token",
  "X-Csrf-Token",
  "X-Forwarded-For",
  "X-Forwarded-Host",
  "X-Forwarded-Proto",
  "X-Request-Id",
  "X-Requested-With",
];

/** Lazily create + cache the shared autocomplete dropdown in the document. */
let _hdrAcDropdown     = null;   // the floating listbox div
let _hdrAcActiveInput  = null;   // which input currently owns the dropdown
let _hdrAcActiveIdx    = -1;     // keyboard-focused item index (-1 = none)
let _hdrAcBlurTimer    = null;   // pending blur-hide timer (cancelled on re-focus)

function _ensureHdrDropdown() {
  if (_hdrAcDropdown) return _hdrAcDropdown;
  _hdrAcDropdown = document.createElement("div");
  _hdrAcDropdown.className = "hdr-autocomplete";
  _hdrAcDropdown.setAttribute("role", "listbox");
  _hdrAcDropdown.setAttribute("aria-label", "Header suggestions");
  document.body.appendChild(_hdrAcDropdown);

  // Hide when anything outside the input+dropdown is clicked
  document.addEventListener("mousedown", (e) => {
    if (_hdrAcActiveInput && !_hdrAcActiveInput.contains(e.target) && !_hdrAcDropdown.contains(e.target)) {
      _hideHdrDropdown();
    }
  }, true);

  return _hdrAcDropdown;
}

function _showHdrDropdown(input) {
  // Cancel any pending blur-hide so rapid blur→focus doesn't flash the dropdown
  if (_hdrAcBlurTimer !== null) { clearTimeout(_hdrAcBlurTimer); _hdrAcBlurTimer = null; }

  const dl     = _ensureHdrDropdown();
  const query  = input.value.toLowerCase().trim();
  const matches = query
    ? STANDARD_HEADERS.filter(h => h.toLowerCase().includes(query))
    : STANDARD_HEADERS;

  if (matches.length === 0) { _hideHdrDropdown(); return; }

  dl.innerHTML    = "";
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
    });
    dl.appendChild(item);
  });

  // Position directly below the input
  const rect = input.getBoundingClientRect();
  dl.style.left  = `${rect.left + window.scrollX}px`;
  dl.style.top   = `${rect.bottom + window.scrollY + 2}px`;
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
  _hdrAcActiveIdx   = -1;
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
  { id: "params",   label: "Params"   },
  { id: "headers",  label: "Headers"  },
  { id: "body",     label: "Body"     },
  { id: "auth",     label: "Auth"     },
//  { id: "settings", label: "Settings" },
];

export class RequestEditor {
  /** @type {HTMLElement} */
  #el;
  #method       = "GET";
  #url          = "";
  #activeTab    = "params";
  #currentNodeId = null;

  // Params state
  #params            = [];   // [{ id, name, value, enabled }]
  #paramsListEl      = null;
  #urlPreviewEnabled = true; // toggled by "Show URL" checkbox
  #urlPreviewEl      = null; // the preview bar element
  #urlPreviewInputEl = null; // the read-only input inside it
  // Drag state
  #dragSrcId         = null; // id of the param being dragged
  #dragInsideList    = false;
  #dragDropHandled   = false;
  #paramPhantomEl    = null; // placeholder shown while dragging
  #docDragOverHandler = null;

  // Headers state
  #headers               = [];   // [{ id, name, value, enabled }]
  #headersListEl         = null;
  #headerSuggestionsEnabled = true;  // toggled by "List Headers" checkbox

  // Auth state
  #authType      = "none";
  #authEnabled   = true;
  #authBasic     = { username: "", password: "" };
  #authBearer    = { token: "" };
  #authOAuth2    = { grantType: "client_credentials", clientId: "", clientSecret: "", accessTokenUrl: "", authUrl: "", scope: "", token: "" };
  #authAwsIam    = { accessKeyId: "", secretAccessKey: "", region: "", service: "", sessionToken: "" };
  #authContentEl = null;
  #authTypeBarEl = null;

  // Body state
  #bodyType      = "no-body";
  #bodyContentEl = null;
  #bodyTypeBarEl = null;      // the bar holding the type selector (+ optional Prettify)
  #bodyFormRows  = [];        // shared for form-data AND form-urlencoded
  #bodyText      = "";        // shared for json, yaml, xml, and plain text
  #bodyFilePath  = "";        // path/name of selected file (display)
  #bodyFileObject = null;     // actual File object reference for sending
  // Body form drag state (one active form editor at a time)
  #bfListEl      = null;
  #bfPhantom     = null;
  #bfDragSrcId   = null;
  #bfDragInside  = false;
  #bfDropHandled = false;
  #bfActiveType  = null;
  #bfDocHandler  = null;
  #hdrDragSrcId          = null;
  #hdrDragInsideList     = false;
  #hdrDragDropHandled    = false;
  #headerPhantomEl       = null;
  #hdrDocDragOverHandler = null;

  // Params bulk editor
  #paramsBulkMode    = false;
  #paramsBulkEl      = null;   // <textarea> shown in bulk mode
  #paramsKvWrapEl    = null;   // div wrapping col-headers + list
  #paramsAddBtnEl    = null;   // hidden in bulk mode
  #paramsDelAllBtnEl = null;   // hidden in bulk mode

  // Headers bulk editor
  #headersBulkMode    = false;
  #headersBulkEl      = null;
  #headersKvWrapEl    = null;
  #headersAddBtnEl    = null;
  #headersDelAllBtnEl = null;
  #listHdrSpacerEl    = null;   // spacer before "List Headers" toggle
  #listHdrLabelEl     = null;   // "List Headers" toggle label

  // Body form bulk editor
  #bodyFormBulkMode    = false;
  #bodyFormBulkEl      = null;
  #bodyFormKvWrapEl    = null;
  #bodyFormAddBtnEl    = null;
  #bodyFormDelAllBtnEl = null;

  // Global "Remove Headers" setting — applied to body-form column label row
  #removeHeaders = false;

  // ── Variable pill editor support ───────────────────────────────────────────
  /** Current variable resolution context: { envVariables, folderChain } */
  #variableContext = null;

  /** Pill editor for the URL bar (single instance, never replaced). */
  #urlPillEditor       = null;
  /** All active pill editors in the params list (cleared on each re-render). */
  #paramPillEditors    = [];
  /** All active pill editors in the headers list (cleared on each re-render). */
  #headerPillEditors   = [];
  /** All active pill editors in the body-form list (cleared on each re-render). */
  #bodyFormPillEditors = [];

  constructor() {
    this.#el = document.createElement("div");
    this.#el.className = "request-editor";

    this.#renderUrlBar();
    this.#renderTabStrip();
    this.#renderTabContent();
  }

  /** Root DOM element — pass to Panel.mount(). */
  get element() { return this.#el; }

  // ── URL bar ─────────────────────────────────────────────────────────────
  #renderUrlBar() {
    const bar = document.createElement("div");
    bar.className = "req-url-bar";

    // Method selector
    const methodSel = document.createElement("select");
    methodSel.className = "req-method-select";
    methodSel.setAttribute("aria-label", "HTTP Method");
    HTTP_METHODS.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = m;
      methodSel.appendChild(opt);
    });
    methodSel.value = this.#method;
    methodSel.dataset.method = this.#method.toLowerCase();
    methodSel.addEventListener("change", () => {
      this.#method = methodSel.value;
      methodSel.dataset.method = this.#method.toLowerCase();
      this.#dispatchRequestUpdated();
    });

    // URL pill editor — replaces the plain <input type="url">
    const urlEditor = new VariablePillEditor({
      placeholder: "https://api.example.com/endpoint",
      ariaLabel:   "Request URL",
      className:   "req-url-input",
      getContext:  () => this.#variableContext,
      onInput: (v) => {
        this.#url = v;
        this.#dispatchRequestUpdated();
        this.#updateUrlPreview();
      },
      onEnter: () => this.#sendRequest(),
    });
    this.#urlPillEditor = urlEditor;

    // Send / Cancel button
    const sendBtn = document.createElement("button");
    sendBtn.className = "req-send-btn";
    sendBtn.textContent = "Send";
    sendBtn.setAttribute("aria-label", "Send request");
    sendBtn.addEventListener("click", () => {
      if (this._requestInFlight) {
        window.dispatchEvent(new CustomEvent("wurl:cancel-request"));
      } else {
        this.#sendRequest();
      }
    });

    // Track in-flight state to toggle the button
    this._requestInFlight = false;
    window.addEventListener("wurl:request-loading", () => {
      this._requestInFlight = true;
      sendBtn.textContent = "Stop";
      sendBtn.setAttribute("aria-label", "Stop request");
      sendBtn.classList.add("req-send-btn--cancel");
    });
    const resetSendBtn = () => {
      this._requestInFlight = false;
      sendBtn.textContent = "Send";
      sendBtn.setAttribute("aria-label", "Send request");
      sendBtn.classList.remove("req-send-btn--cancel");
    };
    window.addEventListener("wurl:response-received", resetSendBtn);
    window.addEventListener("wurl:request-error",     resetSendBtn);

    bar.appendChild(methodSel);
    bar.appendChild(urlEditor.element);
    bar.appendChild(sendBtn);
    this.#el.appendChild(bar);

    this._methodSel = methodSel;
    // Keep _urlInput as a compatibility shim pointing at the editor's element
    // so any external code that reads _urlInput.focus() still works.
    this._urlInput  = urlEditor.element;
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
      btn.setAttribute("aria-selected", tab.id === this.#activeTab ? "true" : "false");
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
    if (tabId === "params")   return this.#buildParamsEditor();
    if (tabId === "headers")  return this.#buildHeadersEditor();
    if (tabId === "body")     return this.#buildBodyEditor();
    if (tabId === "auth")     return this.#buildAuthEditor();

    // Placeholder for other tabs
    const placeholder = document.createElement("div");
    placeholder.className = "panel-placeholder";
    const icons  = { settings: "⚙️" };
    const labels = { settings: "Request settings" };
    placeholder.innerHTML =
      `<span class="placeholder-icon">${icons[tabId]}</span>` +
      `<span>${labels[tabId]} — coming soon</span>`;
    return placeholder;
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
      this.#renderAuthContent();
      this.#dispatchAuthUpdated();
    });

    typeBar.appendChild(typeSelect);

    // ── Enabled toggle — floated right ────────────────────────────────────
    const spacer = document.createElement("span");
    spacer.style.flex = "1";
    typeBar.appendChild(spacer);

    const enabledLabel = document.createElement("label");
    enabledLabel.className = "params-toolbar-toggle-label";
    enabledLabel.title = "Enable or disable authentication for this request";

    const enabledCheck = document.createElement("input");
    enabledCheck.type      = "checkbox";
    enabledCheck.className = "params-toolbar-toggle";
    enabledCheck.id        = "auth-enabled-check";
    enabledCheck.checked   = this.#authEnabled;
    enabledCheck.addEventListener("change", () => {
      this.#authEnabled = enabledCheck.checked;
      this.#authContentEl?.classList.toggle("auth-content--disabled", !this.#authEnabled);
      this.#dispatchAuthUpdated();
    });

    enabledLabel.appendChild(enabledCheck);
    enabledLabel.append(" Enabled");
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

    /** Re-render the auth content area to match #authType. */
    #renderAuthContent() {
    const el = this.#authContentEl;
    if (!el) return;
    el.innerHTML = "";
    switch (this.#authType) {
      case "none":    return this.#renderAuthNone(el);
      case "basic":   return this.#renderAuthBasic(el);
      case "bearer":  return this.#renderAuthBearer(el);
      case "oauth2":  return this.#renderAuthOAuth2(el);
      case "aws-iam": return this.#renderAuthAwsIam(el);
    }
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

    form.appendChild(this.#buildAuthField("Username", "text", {
      placeholder: "Username",
      value:       this.#authBasic.username,
      onInput:     (v) => { this.#authBasic.username = v; this.#dispatchAuthUpdated(); },
    }));

    form.appendChild(this.#buildAuthFieldPassword("Password", {
      placeholder: "Password",
      value:       this.#authBasic.password,
      onInput:     (v) => { this.#authBasic.password = v; this.#dispatchAuthUpdated(); },
    }));

    el.appendChild(form);
    }

    // ── Bearer Token ──────────────────────────────────────────────────────────
    #renderAuthBearer(el) {
    const form = document.createElement("div");
    form.className = "auth-form";

    form.appendChild(this.#buildAuthField("Token", "text", {
      placeholder: "Enter your bearer token…",
      value:       this.#authBearer.token,
      onInput:     (v) => { this.#authBearer.token = v; this.#dispatchAuthUpdated(); },
      hint:        "Sent as: Authorization: Bearer <token>",
    }));

    el.appendChild(form);
    }

    // ── OAuth 2.0 ─────────────────────────────────────────────────────────────
    #renderAuthOAuth2(el) {
    const form = document.createElement("div");
    form.className = "auth-form";

    // Grant Type select
    const grantWrapper = document.createElement("div");
    grantWrapper.className = "auth-field";
    const grantLabel = document.createElement("label");
    grantLabel.className = "auth-field__label";
    grantLabel.textContent = "Grant Type";
    const grantSelect = document.createElement("select");
    grantSelect.className = "auth-field__input auth-field__select";
    grantSelect.setAttribute("aria-label", "Grant type");
    grantSelect.innerHTML = `
      <option value="authorization_code">Authorization Code</option>
      <option value="client_credentials">Client Credentials</option>
      <option value="password">Resource Owner Password</option>
      <option value="implicit">Implicit</option>
    `;
    grantSelect.value = this.#authOAuth2.grantType;
    grantSelect.addEventListener("change", () => {
      this.#authOAuth2.grantType = grantSelect.value;
      this.#renderAuthContent();
      this.#dispatchAuthUpdated();
    });
    grantWrapper.appendChild(grantLabel);
    grantWrapper.appendChild(grantSelect);
    form.appendChild(grantWrapper);

    // Client ID
    form.appendChild(this.#buildAuthField("Client ID", "text", {
      placeholder: "Client ID",
      value:       this.#authOAuth2.clientId,
      onInput:     (v) => { this.#authOAuth2.clientId = v; this.#dispatchAuthUpdated(); },
    }));

    // Client Secret (hidden for implicit)
    if (this.#authOAuth2.grantType !== "implicit") {
      form.appendChild(this.#buildAuthFieldPassword("Client Secret", {
        placeholder: "Client Secret",
        value:       this.#authOAuth2.clientSecret,
        onInput:     (v) => { this.#authOAuth2.clientSecret = v; this.#dispatchAuthUpdated(); },
      }));
    }

    // Access Token URL (hidden for implicit)
    if (this.#authOAuth2.grantType !== "implicit") {
      form.appendChild(this.#buildAuthField("Access Token URL", "url", {
        placeholder: "https://example.com/oauth/token",
        value:       this.#authOAuth2.accessTokenUrl,
        onInput:     (v) => { this.#authOAuth2.accessTokenUrl = v; this.#dispatchAuthUpdated(); },
      }));
    }

    // Auth URL (shown for authorization_code and implicit)
    if (["authorization_code", "implicit"].includes(this.#authOAuth2.grantType)) {
      form.appendChild(this.#buildAuthField("Auth URL", "url", {
        placeholder: "https://example.com/oauth/authorize",
        value:       this.#authOAuth2.authUrl,
        onInput:     (v) => { this.#authOAuth2.authUrl = v; this.#dispatchAuthUpdated(); },
      }));
    }

    // Scope
    form.appendChild(this.#buildAuthField("Scope", "text", {
      placeholder: "openid profile email",
      value:       this.#authOAuth2.scope,
      onInput:     (v) => { this.#authOAuth2.scope = v; this.#dispatchAuthUpdated(); },
      hint:        "Space-separated list of requested scopes",
    }));

    // Current access token display
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
      const clearBtn = document.createElement("button");
      clearBtn.type = "button";
      clearBtn.className = "body-file-reset-btn";
      clearBtn.textContent = "Clear Token";
      clearBtn.addEventListener("click", () => {
        this.#authOAuth2.token = "";
        this.#renderAuthContent();
        this.#dispatchAuthUpdated();
      });
      tokenDisplay.appendChild(tokenValue);
      tokenDisplay.appendChild(clearBtn);
      form.appendChild(tokenDisplay);
    }

    el.appendChild(form);
    }

    // ── AWS IAM ───────────────────────────────────────────────────────────────
    #renderAuthAwsIam(el) {
    const form = document.createElement("div");
    form.className = "auth-form";

    form.appendChild(this.#buildAuthField("Access Key ID", "text", {
      placeholder: "AKIAIOSFODNN7EXAMPLE",
      value:       this.#authAwsIam.accessKeyId,
      onInput:     (v) => { this.#authAwsIam.accessKeyId = v; this.#dispatchAuthUpdated(); },
    }));

    form.appendChild(this.#buildAuthFieldPassword("Secret Access Key", {
      placeholder: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      value:       this.#authAwsIam.secretAccessKey,
      onInput:     (v) => { this.#authAwsIam.secretAccessKey = v; this.#dispatchAuthUpdated(); },
    }));

    form.appendChild(this.#buildAuthField("Region", "text", {
      placeholder: "us-east-1",
      value:       this.#authAwsIam.region,
      onInput:     (v) => { this.#authAwsIam.region = v; this.#dispatchAuthUpdated(); },
    }));

    form.appendChild(this.#buildAuthField("Service", "text", {
      placeholder: "execute-api",
      value:       this.#authAwsIam.service,
      onInput:     (v) => { this.#authAwsIam.service = v; this.#dispatchAuthUpdated(); },
    }));

    form.appendChild(this.#buildAuthFieldPassword("Session Token", {
      placeholder: "Optional — for temporary / STS credentials",
      value:       this.#authAwsIam.sessionToken,
      onInput:     (v) => { this.#authAwsIam.sessionToken = v; this.#dispatchAuthUpdated(); },
    }));

    el.appendChild(form);
    }

    // ── Auth field helpers ─────────────────────────────────────────────────────
    /**
     * Build a standard labeled input row for use inside an auth-form.
     * @param {string} label
     * @param {string} inputType  e.g. "text" | "url"
     * @param {{ placeholder?, value?, onInput?, hint? }} opts
     */
    #buildAuthField(label, inputType, { placeholder = "", value = "", onInput, hint } = {}) {
    const wrapper = document.createElement("div");
    wrapper.className = "auth-field";

    const lbl = document.createElement("label");
    lbl.className = "auth-field__label";
    lbl.textContent = label;

    const input = document.createElement("input");
    input.type        = inputType;
    input.className   = "auth-field__input";
    input.placeholder = placeholder;
    input.value       = value;
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
     * Build a labeled password input with a show/hide toggle button.
     * @param {string} label
     * @param {{ placeholder?, value?, onInput? }} opts
     */
    #buildAuthFieldPassword(label, { placeholder = "", value = "", onInput } = {}) {
    const wrapper = document.createElement("div");
    wrapper.className = "auth-field";

    const lbl = document.createElement("label");
    lbl.className = "auth-field__label";
    lbl.textContent = label;

    const inputWrap = document.createElement("div");
    inputWrap.className = "auth-pwd-wrapper";

    const input = document.createElement("input");
    input.type        = "password";
    input.className   = "auth-field__input";
    input.placeholder = placeholder;
    input.value       = value;
    input.setAttribute("autocomplete", "off");
    input.setAttribute("aria-label", label);
    if (onInput) input.addEventListener("input", () => onInput(input.value));

    const toggle = document.createElement("button");
    toggle.type      = "button";
    toggle.className = "auth-pwd-toggle";
    toggle.textContent = "Show";
    toggle.title = "Toggle visibility";
    toggle.addEventListener("click", () => {
      const hidden = input.type === "password";
      input.type     = hidden ? "text" : "password";
      toggle.textContent = hidden ? "Hide" : "Show";
    });

    inputWrap.appendChild(input);
    inputWrap.appendChild(toggle);
    wrapper.appendChild(lbl);
    wrapper.appendChild(inputWrap);

    return wrapper;
    }

    #dispatchAuthUpdated() {
    if (!this.#currentNodeId) return;
    window.dispatchEvent(new CustomEvent("wurl:request-updated", {
      detail: {
        id:          this.#currentNodeId,
        authEnabled: this.#authEnabled,
        authType:    this.#authType,
        authBasic:   { ...this.#authBasic },
        authBearer:  { ...this.#authBearer },
        authOAuth2:  { ...this.#authOAuth2 },
        authAwsIam:  { ...this.#authAwsIam },
      },
      bubbles: true,
    }));
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
    // Discard stale pill editor references for form rows
    this.#bodyFormPillEditors = [];
    // Remove any Prettify button / validation badge left over from a previous text type
    this.#bodyTypeBarEl?.querySelector(".body-prettify-btn")?.remove();
    this.#bodyTypeBarEl?.querySelector(".body-validate-badge")?.remove();
    // Reset body form drag state whenever we switch panels
    this.#bfListEl = this.#bfPhantom = null;
    this.#bfDragSrcId = null;
    // Cancel any in-progress delete-all confirm before the UI is rebuilt
    this._bodyFormDeleteAllCleanup?.();
    // Reset body form bulk refs (will be reassigned by #renderBodyForm if applicable)
    this.#bodyFormBulkEl = this.#bodyFormKvWrapEl = this.#bodyFormAddBtnEl = this.#bodyFormDelAllBtnEl = null;

    switch (this.#bodyType) {
      case "no-body":         return this.#renderBodyNone(el);
      case "form-data":
      case "form-urlencoded": return this.#renderBodyForm(el, this.#bodyType);
      case "json":            return this.#renderBodyText(el, "json",  true);
      case "yaml":            return this.#renderBodyText(el, "yaml",  true);
      case "xml":             return this.#renderBodyText(el, "xml",   true);
      case "text":            return this.#renderBodyText(el, "text",  false);
      case "file":            return this.#renderBodyFile(el);
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

    // Toolbar
    const toolbar = document.createElement("div");
    toolbar.className = "params-toolbar";

    const addBtn = document.createElement("button");
    addBtn.className = "icon-btn params-toolbar-btn";
    addBtn.title = "Add field";
    addBtn.setAttribute("aria-label", "Add field");
    addBtn.innerHTML = `<span class="icon">＋</span>`;
    addBtn.addEventListener("click", () => {
      rows.push({ id: crypto.randomUUID(), name: "", value: "", enabled: true });
      this.#renderBodyContent();
      this.#dispatchBodyUpdated();
    });

    const delAllBtn = document.createElement("button");
    delAllBtn.className = "params-toolbar-btn params-toolbar-btn--danger params-delete-all-btn";
    delAllBtn.title = "Delete all fields";
    delAllBtn.textContent = "Delete All";

    // Inline confirm: first click → "Confirm?"; second click → delete all.
    // Escape or clicking outside the button cancels.
    this._bodyFormDeleteAllCleanup = this.#wireDeleteAllConfirm(
      delAllBtn,
      () => this.#bodyFormRows.length,
      () => { this.#bodyFormRows = []; this.#renderBodyContent(); this.#dispatchBodyUpdated(); },
    );

    this.#bodyFormAddBtnEl    = addBtn;
    this.#bodyFormDelAllBtnEl = delAllBtn;

    // ── Bulk Editor toggle — leftmost ─────────────────────────────────────
    const bfBulkLabel = document.createElement("label");
    bfBulkLabel.className = "params-toolbar-toggle-label";
    bfBulkLabel.title = "Toggle between bulk text editor and key/value row editor";
    const bfBulkCheck = document.createElement("input");
    bfBulkCheck.type      = "checkbox";
    bfBulkCheck.className = "params-toolbar-toggle";
    bfBulkCheck.checked   = this.#bodyFormBulkMode;
    bfBulkCheck.addEventListener("change", () => this.#handleBodyFormBulkToggle(bfBulkCheck.checked));
    bfBulkLabel.appendChild(bfBulkCheck);
    bfBulkLabel.append(" Bulk Editor");
    toolbar.appendChild(bfBulkLabel);

    toolbar.appendChild(addBtn);
    toolbar.appendChild(delAllBtn);
    el.appendChild(toolbar);

    // ── Bulk mode textarea ────────────────────────────────────────────────
    const bfBulkTa = document.createElement("textarea");
    bfBulkTa.className   = "body-text-editor";
    bfBulkTa.placeholder = "name=value\nfield1=foo\nfield2=bar\n# disabled=row";
    bfBulkTa.spellcheck  = false;
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
    bfKvWrap.style.cssText = "display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden";
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
    this.#bfPhantom    = phantom;
    this.#bfActiveType = type;

    const list = document.createElement("div");
    list.className = "params-list";
    this.#bfListEl = list;

    list.addEventListener("dragover", (e) => { if (this.#bfDragSrcId) e.preventDefault(); });
    list.addEventListener("drop", (e) => {
      e.preventDefault();
      if (!this.#bfDragSrcId) return;
      this.#bfDropHandled = true;
      const allCh = [...list.children];
      const phIdx = allCh.indexOf(phantom);
      if (phIdx === -1) { this.#cancelBfDrag(); this.#finalizeBfDrag(); return; }
      const insertBefore = allCh.slice(0, phIdx).filter(c => c.classList.contains("params-row")).length;
      const srcIdx = rows.findIndex(r => r.id === this.#bfDragSrcId);
      if (srcIdx !== -1) {
        const [moved] = rows.splice(srcIdx, 1);
        rows.splice(insertBefore > srcIdx ? insertBefore - 1 : insertBefore, 0, moved);
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
    div.draggable  = true;
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
    cb.type = "checkbox"; cb.className = "params-checkbox"; cb.checked = row.enabled;
    cb.addEventListener("change", () => {
      row.enabled = cb.checked;
      div.classList.toggle("params-row--disabled", !row.enabled);
      this.#dispatchBodyUpdated();
    });

    // Name pill editor
    const getCtx = () => this.#variableContext;
    const nameEditor = new VariablePillEditor({
      placeholder: "Name",
      ariaLabel:   "Field name",
      className:   "params-name",
      getContext:  getCtx,
      onInput: (v) => { row.name = v; this.#dispatchBodyUpdated(); },
      onEnter: () => {
        rows.push({ id: crypto.randomUUID(), name: "", value: "", enabled: true });
        this.#renderBodyContent();
        this.#dispatchBodyUpdated();
      },
    });
    nameEditor.setValue(row.name);
    this.#bodyFormPillEditors.push(nameEditor);

    // Value pill editor
    const valueEditor = new VariablePillEditor({
      placeholder: "Value",
      ariaLabel:   "Field value",
      className:   "params-value",
      getContext:  getCtx,
      onInput: (v) => { row.value = v; this.#dispatchBodyUpdated(); },
      onEnter: () => {
        rows.push({ id: crypto.randomUUID(), name: "", value: "", enabled: true });
        this.#renderBodyContent();
        this.#dispatchBodyUpdated();
      },
    });
    valueEditor.setValue(row.value);
    this.#bodyFormPillEditors.push(valueEditor);

    // Delete
    const delBtn = document.createElement("button");
    delBtn.className = "icon-btn params-delete-btn"; delBtn.title = "Delete field";
    delBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 12 12" fill="none"
        stroke="currentColor" stroke-width="2" stroke-linecap="round">
      <line x1="1" y1="1" x2="11" y2="11"/><line x1="11" y1="1" x2="1" y2="11"/>
    </svg>`;
    delBtn.addEventListener("click", () => {
      this.#bodyFormRows = rows.filter(r => r.id !== row.id);
      this.#renderBodyContent();
      this.#dispatchBodyUpdated();
    });

    // Drag events
    div.addEventListener("dragstart", (e) => {
      this.#bfDragSrcId  = row.id;
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
          this.#bfListEl?.querySelector(`[data-id="${this.#bfDragSrcId}"]`)?.style?.removeProperty("display");
        } else if (inside && !this.#bfDragInside) {
          this.#bfDragInside = true;
        }
      };
      document.addEventListener("dragover", this.#bfDocHandler);
    });
    div.addEventListener("dragover", (e) => {
      if (!this.#bfDragSrcId || this.#bfDragSrcId === row.id) return;
      e.preventDefault(); e.dataTransfer.dropEffect = "move";
      const rect  = div.getBoundingClientRect();
      const after = (e.clientY - rect.top) / rect.height >= 0.5;
      const ph    = this.#bfPhantom;
      const draggedEl = this.#bfListEl?.querySelector(`[data-id="${this.#bfDragSrcId}"]`);
      if (draggedEl?.style.display !== "none") draggedEl.style.display = "none";
      const sibling = after ? div.nextSibling : div;
      if (ph.nextSibling !== sibling && ph !== sibling) div.parentElement?.insertBefore(ph, sibling);
    });
    div.addEventListener("dragend", () => {
      if (!this.#bfDropHandled) this.#cancelBfDrag();
      this.#finalizeBfDrag();
    });

    div.appendChild(handle); div.appendChild(cb);
    div.appendChild(nameEditor.element); div.appendChild(valueEditor.element); div.appendChild(delBtn);
    return div;
    }

    #cancelBfDrag() { this.#bfPhantom?.remove(); this.#renderBodyContent(); }
    #finalizeBfDrag() {
    if (this.#bfDocHandler) { document.removeEventListener("dragover", this.#bfDocHandler); this.#bfDocHandler = null; }
    this.#bfDragSrcId  = null;
    this.#bfDragInside = false;
    this.#bfDropHandled = false;
    }

    // ── Text editor (JSON / YAML / XML / Plain Text) ──────────────────────────
    #renderBodyText(el, type, canPrettify) {
    const ta = document.createElement("textarea");
    ta.className = "body-text-editor";
    ta.value     = this.#bodyText;
    ta.placeholder = `Enter ${type === "text" ? "plain text" : type.toUpperCase()} body here…`;
    ta.spellcheck  = false;
    ta.setAttribute("aria-label", `${type} body`);
    el.appendChild(ta);

    // ── Inline validation (JSON / YAML / XML) ─────────────────────────────
    const canValidate = canPrettify && type !== "text";
    let validateBadge  = null;
    let prettyBtnRef   = null;
    let validateTimer  = null;
    const VALIDATE_MS  = 400;

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
        if (!text.trim()) { applyValidity(null); return; }
        applyValidity(this.#validate(type, text) ? "valid" : "invalid");
      }, VALIDATE_MS);
    };

    ta.addEventListener("input", () => {
      this.#bodyText = ta.value;
      this.#dispatchBodyUpdated();
      if (canValidate) scheduleValidation();
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
      prettyBtn.className = "params-toolbar-btn params-delete-all-btn body-prettify-btn";
      prettyBtn.title = `Prettify ${type.toUpperCase()}`;
      prettyBtn.textContent = "Prettify";
      prettyBtn.addEventListener("click", () => {
        const prettified = this.#prettify(type, ta.value);
        ta.value = prettified;
        this.#bodyText = prettified;
        this.#dispatchBodyUpdated();
        // Immediate re-validate after prettifying (no debounce needed)
        if (canValidate) {
          applyValidity(ta.value.trim()
            ? (this.#validate(type, ta.value) ? "valid" : "invalid")
            : null);
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
      if (type === "json") { JSON.parse(text); return true; }
      if (type === "yaml") { parseYaml(text);  return true; }
      if (type === "xml") {
        const doc = new DOMParser().parseFromString(text, "application/xml");
        return !doc.querySelector("parsererror");
      }
    } catch { /* fall through */ }
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
        const raw = new XMLSerializer().serializeToString(doc)
          .replace(/>\s*</g, ">\n<");
        let indent = 0;
        return raw.split("\n").map(line => {
          const trimmed = line.trim();
          if (!trimmed) return "";
          if (trimmed.startsWith("</")) indent = Math.max(0, indent - 1);
          const out = "  ".repeat(indent) + trimmed;
          if (!trimmed.startsWith("</") && !trimmed.startsWith("<?") &&
              !trimmed.endsWith("/>") && !trimmed.includes("</")) indent++;
          return out;
        }).filter(l => l !== "").join("\n");
      }
      if (type === "yaml") {
        return stringifyYaml(parseYaml(text));
      }
    } catch { /* invalid — return unchanged */ }
    return text;
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

    const icon  = document.createElement("div");
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
    fileInput.type = "file"; fileInput.style.display = "none";
    fileInput.addEventListener("change", () => {
      const f = fileInput.files?.[0];
      if (!f) return;
      this.#bodyFilePath   = f.path || f.name;   // Electron exposes .path
      this.#bodyFileObject = f;
      this.#renderFileChosen(el);
      this.#dispatchBodyUpdated();
    });

    browseBtn.addEventListener("click", () => fileInput.click());

    // Drag-and-drop
    zone.addEventListener("dragover", (e) => {
      e.preventDefault(); e.dataTransfer.dropEffect = "copy";
      zone.classList.add("body-file-zone--over");
    });
    zone.addEventListener("dragleave", (e) => {
      if (!zone.contains(e.relatedTarget)) zone.classList.remove("body-file-zone--over");
    });
    zone.addEventListener("drop", (e) => {
      e.preventDefault(); zone.classList.remove("body-file-zone--over");
      const f = e.dataTransfer.files?.[0];
      if (!f) return;
      this.#bodyFilePath   = f.path || f.webkitRelativePath || f.name;
      this.#bodyFileObject = f;
      this.#renderFileChosen(el);
      this.#dispatchBodyUpdated();
    });

    zone.appendChild(icon); zone.appendChild(label);
    zone.appendChild(sub); zone.appendChild(browseBtn);
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
      this.#bodyFilePath   = "";
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
    window.dispatchEvent(new CustomEvent("wurl:request-updated", {
      detail: {
        id:       this.#currentNodeId,
        bodyType: this.#bodyType,
        bodyFormRows:         [...this.#bodyFormRows],
        bodyText:             this.#bodyText,
        bodyFilePath:         this.#bodyFilePath,
      },
      bubbles: true,
    }));
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
    pBulkLabel.title = "Toggle between bulk text editor and key/value row editor";
    const pBulkCheck = document.createElement("input");
    pBulkCheck.type      = "checkbox";
    pBulkCheck.className = "params-toolbar-toggle";
    pBulkCheck.checked   = this.#paramsBulkMode;
    pBulkCheck.addEventListener("change", () => this.#handleParamsBulkToggle(pBulkCheck.checked));
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
    deleteAllBtn.className = "params-toolbar-btn params-toolbar-btn--danger params-delete-all-btn";
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
    this.#paramsAddBtnEl    = addBtn;
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
    showUrlCheck.type      = "checkbox";
    showUrlCheck.id        = "url-preview-toggle";
    showUrlCheck.className = "params-toolbar-toggle";
    showUrlCheck.checked   = this.#urlPreviewEnabled;
    showUrlCheck.addEventListener("change", () => {
      this.#urlPreviewEnabled = showUrlCheck.checked;
      this.#updateUrlPreview();
      window.dispatchEvent(new CustomEvent("wurl:editor-setting-changed", {
        detail: { showUrlPreview: showUrlCheck.checked },
        bubbles: true,
      }));
    });

    showUrlLabel.appendChild(showUrlCheck);
    showUrlLabel.append("Show URL Preview");
    toolbar.appendChild(showUrlLabel);

    container.appendChild(toolbar);

    // ── URL preview bar (below toolbar, above column headers) ─────────────
    container.appendChild(this.#buildUrlPreviewBar());

    // ── Bulk mode textarea ────────────────────────────────────────────────
    const pBulkTa = document.createElement("textarea");
    pBulkTa.className   = "body-text-editor";
    pBulkTa.placeholder = "name=value\nparam1=foo\nparam2=bar\n# disabled=row";
    pBulkTa.spellcheck  = false;
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
    pKvWrap.style.cssText = "display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden";
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
      if (phantomIdx === -1) { this.#cancelParamDrag(); this.#finalizeParamDrag(); return; }
      // Count only param rows before the phantom
      const insertBefore = allChildren.slice(0, phantomIdx).filter(el => el.classList.contains("params-row")).length;
      const srcIdx = this.#params.findIndex(p => p.id === this.#dragSrcId);
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
    hBulkLabel.title = "Toggle between bulk text editor and key/value row editor";
    const hBulkCheck = document.createElement("input");
    hBulkCheck.type      = "checkbox";
    hBulkCheck.className = "params-toolbar-toggle";
    hBulkCheck.checked   = this.#headersBulkMode;
    hBulkCheck.addEventListener("change", () => this.#handleHeadersBulkToggle(hBulkCheck.checked));
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
    deleteAllBtn.className = "params-toolbar-btn params-toolbar-btn--danger params-delete-all-btn";
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
    this.#headersAddBtnEl    = addBtn;
    this.#headersDelAllBtnEl = deleteAllBtn;

    // ── "List Headers" toggle — pushed to the right ───────────────────────
    const spacer = document.createElement("span");
    spacer.style.flex = "1";
    toolbar.appendChild(spacer);
    this.#listHdrSpacerEl = spacer;

    const listHdrLabel = document.createElement("label");
    listHdrLabel.className = "params-toolbar-toggle-label";
    listHdrLabel.title = "Show standard header suggestions when editing the header name";

    const listHdrCheck = document.createElement("input");
    listHdrCheck.type      = "checkbox";
    listHdrCheck.id        = "list-headers-toggle";
    listHdrCheck.checked   = this.#headerSuggestionsEnabled;
    listHdrCheck.className = "params-toolbar-toggle";
    listHdrCheck.addEventListener("change", () => {
      this.#headerSuggestionsEnabled = listHdrCheck.checked;
      if (!listHdrCheck.checked) _hideHdrDropdown();
      // Persist the preference into settings
      window.dispatchEvent(new CustomEvent("wurl:editor-setting-changed", {
        detail: { listHeaders: listHdrCheck.checked },
        bubbles: true,
      }));
    });

    listHdrLabel.appendChild(listHdrCheck);
    listHdrLabel.append(" List Headers");
    toolbar.appendChild(listHdrLabel);
    this.#listHdrLabelEl = listHdrLabel;


    container.appendChild(toolbar);

    // ── Bulk mode textarea ────────────────────────────────────────────────
    const hBulkTa = document.createElement("textarea");
    hBulkTa.className   = "body-text-editor";
    hBulkTa.placeholder = "Header-Name: value\nContent-Type: application/json\nAuthorization: Bearer token\n# X-Disabled: skipped";
    hBulkTa.spellcheck  = false;
    hBulkTa.setAttribute("aria-label", "Headers bulk editor");
    hBulkTa.addEventListener("input", () => {
      this.#headers = this.#textToHeaderRows(hBulkTa.value);
      this.#dispatchHeadersUpdated();
    });
    this.#headersBulkEl = hBulkTa;
    container.appendChild(hBulkTa);

    // ── KV wrap (column headers + list) ──────────────────────────────────
    const hKvWrap = document.createElement("div");
    hKvWrap.style.cssText = "display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden";
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
      if (phantomIdx === -1) { this.#cancelHeaderDrag(); this.#finalizeHeaderDrag(); return; }
      const insertBefore = allChildren.slice(0, phantomIdx).filter(el => el.classList.contains("params-row")).length;
      const srcIdx = this.#headers.findIndex(h => h.id === this.#hdrDragSrcId);
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
      id:      crypto.randomUUID(),
      name:    "",
      value:   "",
      enabled: true,
    });
    this.#renderHeadersList();
    const rows = this.#headersListEl.querySelectorAll(".params-row");
    if (rows.length) rows[rows.length - 1].querySelector(".params-name")?.focus();
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
    // Discard stale pill editor references
    this.#headerPillEditors = [];

    // In bulk mode just keep the textarea in sync
    if (this.#headersBulkMode) {
      if (this.#headersBulkEl) this.#headersBulkEl.value = this.#headerRowsToText(this.#headers);
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
    row.dataset.id    = header.id;
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
      header.enabled  = checkbox.checked;
      checkbox.title  = header.enabled ? "Disable header" : "Enable header";
      row.classList.toggle("params-row--disabled", !header.enabled);
      this.#dispatchHeadersUpdated();
    });

    // ── Header name combo box ─────────────────────────────────────────────
    const headerInput = document.createElement("input");
    headerInput.type        = "text";
    headerInput.className   = "params-input params-name";
    headerInput.placeholder = "Header";
    headerInput.value       = header.name;
    headerInput.setAttribute("aria-label",    "Header name");
    headerInput.setAttribute("autocomplete",  "off");
    headerInput.addEventListener("focus", () => {
      if (this.#headerSuggestionsEnabled) _showHdrDropdown(headerInput);
    });
    headerInput.addEventListener("input", () => {
      header.name = headerInput.value;
      this.#dispatchHeadersUpdated();
      if (this.#headerSuggestionsEnabled) _showHdrDropdown(headerInput);
    });
    headerInput.addEventListener("blur", () => {
      // Store the timer ID so focus can cancel it if the user clicks back quickly
      _hdrAcBlurTimer = setTimeout(_hideHdrDropdown, 150);
    });
    headerInput.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown")  { e.preventDefault(); _hdrDropdownNavigate(+1); return; }
      if (e.key === "ArrowUp")    { e.preventDefault(); _hdrDropdownNavigate(-1); return; }
      if (e.key === "Escape")     { _hideHdrDropdown(); return; }
      if (e.key === "Enter") {
        e.preventDefault();
        if (!_hdrDropdownAccept(headerInput)) this.#addHeader();
      }
    });

    // ── Value input ─────────────────────────────────────────────────────
    const valueEditor = new VariablePillEditor({
      placeholder: "Value",
      ariaLabel:   "Header value",
      className:   "params-value",
      getContext:  () => this.#variableContext,
      onInput: (v) => {
        header.value = v;
        this.#dispatchHeadersUpdated();
      },
      onEnter: () => this.#addHeader(),
    });
    valueEditor.setValue(header.value);
    this.#headerPillEditors.push(valueEditor);

    // ── Delete button ────────────────────────────────────────────────────
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "icon-btn params-delete-btn";
    deleteBtn.title = "Delete header";
    deleteBtn.setAttribute("aria-label", "Delete header");
    deleteBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 12 12" fill="none"
        stroke="currentColor" stroke-width="2" stroke-linecap="round">
      <line x1="1" y1="1" x2="11" y2="11"/><line x1="11" y1="1" x2="1" y2="11"/>
    </svg>`;
    deleteBtn.addEventListener("click", () => this.#deleteHeader(header.id));

    // ── HTML5 drag-and-drop reordering (phantom pattern) ─────────────────
    row.addEventListener("dragstart", (e) => {
      this.#hdrDragSrcId       = header.id;
      this.#hdrDragDropHandled = false;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", header.id);

      requestAnimationFrame(() => {
        this.#hdrDragInsideList = true;
        row.parentElement?.insertBefore(this.#headerPhantomEl, row);
        row.style.display = "none";
      });

      this.#hdrDocDragOverHandler = (ev) => {
        if (!this.#hdrDragSrcId) return;
        const inside = this.#headersListEl.contains(ev.target);
        if (!inside && this.#hdrDragInsideList) {
          this.#hdrDragInsideList = false;
          this.#headerPhantomEl.remove();
          const draggedRow = this.#headersListEl.querySelector(`[data-id="${this.#hdrDragSrcId}"]`);
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

      const rect  = row.getBoundingClientRect();
      const after = (e.clientY - rect.top) / rect.height >= 0.5;
      const ph    = this.#headerPhantomEl;

      const draggedRow = this.#headersListEl.querySelector(`[data-id="${this.#hdrDragSrcId}"]`);
      if (draggedRow && draggedRow.style.display !== "none") draggedRow.style.display = "none";

      const sibling = after ? row.nextSibling : row;
      if (ph.nextSibling !== sibling && ph !== sibling) {
        row.parentElement?.insertBefore(ph, after ? row.nextSibling : row);
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
    this.#hdrDragSrcId       = null;
    this.#hdrDragInsideList  = false;
    this.#hdrDragDropHandled = false;
    }

  #addParam() {
    this.#params.push({
      id:      crypto.randomUUID(),
      name:    "",
      value:   "",
      enabled: true,
    });
    this.#renderParamsList();
    // Focus the new row's name input
    const rows = this.#paramsListEl.querySelectorAll(".params-row");
    if (rows.length) rows[rows.length - 1].querySelector(".params-name")?.focus();
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
    // Discard stale pill editor references
    this.#paramPillEditors = [];

    // In bulk mode just keep the textarea in sync and update the URL preview
    if (this.#paramsBulkMode) {
      if (this.#paramsBulkEl) this.#paramsBulkEl.value = this.#kvRowsToText(this.#params);
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
    input.type        = "text";
    input.readOnly    = true;
    input.className   = "params-url-preview__input";
    input.placeholder = "Enter a URL above to preview it here";
    input.setAttribute("aria-label", "Request URL with query parameters");
    input.tabIndex    = -1;

    const copyBtn = document.createElement("button");
    copyBtn.type      = "button";
    copyBtn.className = "params-url-preview__copy-btn";
    copyBtn.textContent = "Copy";
    copyBtn.title     = "Copy URL to clipboard";
    copyBtn.setAttribute("aria-label", "Copy URL to clipboard");
    copyBtn.addEventListener("click", () => {
      const text = input.value;
      if (!text) return;
      navigator.clipboard.writeText(text).then(() => {
        copyBtn.textContent = "Copied!";
        setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
      }).catch(() => {
        // Fallback: select + execCommand for environments without Clipboard API
        input.removeAttribute("readonly");
        input.select();
        document.execCommand("copy");
        input.setAttribute("readonly", "");
      });
    });

    bar.appendChild(input);
    bar.appendChild(copyBtn);

    this.#urlPreviewEl      = bar;
    this.#urlPreviewInputEl = input;
    this.#updateUrlPreview();
    return bar;
  }

  /** Assemble the URL string with enabled query parameters appended. */
  #buildPreviewUrl() {
    const base    = this.#url ?? "";
    const enabled = this.#params.filter(p => p.enabled && p.name.trim());
    if (!enabled.length) return base;
    const qs = enabled
      .map(p => `${encodeURIComponent(p.name)}=${encodeURIComponent(p.value)}`)
      .join("&");
    return base + (base.includes("?") ? "&" : "?") + qs;
  }

  /** Refresh the preview bar's visibility and text content. */
  #updateUrlPreview() {
    if (!this.#urlPreviewEl) return;
    this.#urlPreviewEl.classList.toggle("params-url-preview--hidden", !this.#urlPreviewEnabled);
    if (this.#urlPreviewInputEl) {
      this.#urlPreviewInputEl.value = this.#buildPreviewUrl();
    }
  }

  #buildParamRow(param, index) {
    const row = document.createElement("div");
    row.className = "params-row";
    row.dataset.id    = param.id;
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
      param.enabled  = checkbox.checked;
      checkbox.title = param.enabled ? "Disable parameter" : "Enable parameter";
      row.classList.toggle("params-row--disabled", !param.enabled);
      this.#updateUrlPreview();
      this.#dispatchParamsUpdated();
    });

    // ── Name pill editor ─────────────────────────────────────────────────
    const getCtx = () => this.#variableContext;
    const nameEditor = new VariablePillEditor({
      placeholder: "Name",
      ariaLabel:   "Parameter name",
      className:   "params-name",
      getContext:  getCtx,
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
      ariaLabel:   "Parameter value",
      className:   "params-value",
      getContext:  getCtx,
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
    deleteBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 12 12" fill="none"
        stroke="currentColor" stroke-width="2" stroke-linecap="round">
      <line x1="1" y1="1" x2="11" y2="11"/><line x1="11" y1="1" x2="1" y2="11"/>
    </svg>`;
    deleteBtn.addEventListener("click", () => this.#deleteParam(param.id));

    // ── HTML5 drag-and-drop reordering (phantom pattern) ─────────────────

    row.addEventListener("dragstart", (e) => {
      this.#dragSrcId      = param.id;
      this.#dragDropHandled = false;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", param.id);

      requestAnimationFrame(() => {
        this.#dragInsideList = true;
        row.parentElement?.insertBefore(this.#paramPhantomEl, row);
        row.style.display = "none";
      });

      this.#docDragOverHandler = (ev) => {
        if (!this.#dragSrcId) return;
        const inside = this.#paramsListEl.contains(ev.target);
        if (!inside && this.#dragInsideList) {
          this.#dragInsideList = false;
          this.#paramPhantomEl.remove();
          const draggedRow = this.#paramsListEl.querySelector(`[data-id="${this.#dragSrcId}"]`);
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

      const rect  = row.getBoundingClientRect();
      const after = (e.clientY - rect.top) / rect.height >= 0.5;
      const ph    = this.#paramPhantomEl;

      const draggedRow = this.#paramsListEl.querySelector(`[data-id="${this.#dragSrcId}"]`);
      if (draggedRow && draggedRow.style.display !== "none") draggedRow.style.display = "none";

      const sibling = after ? row.nextSibling : row;
      if (ph.nextSibling !== sibling && ph !== sibling) {
        row.parentElement?.insertBefore(ph, after ? row.nextSibling : row);
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
    this.#dragSrcId       = null;
    this.#dragInsideList  = false;
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
        document.removeEventListener("keydown",   onEsc,     true);
        document.removeEventListener("mousedown", onOutside, true);
        cleanupConfirm = null;
      };

      const onEsc     = (e) => { if (e.key === "Escape") { e.stopPropagation(); restore(); } };
      const onOutside = (e) => { if (!btn.contains(e.target)) restore(); };

      document.addEventListener("keydown",   onEsc,     true);
      document.addEventListener("mousedown", onOutside, true);
      cleanupConfirm = restore;
    };

    btn.addEventListener("click", () => {
      if (!getCount()) return;
      if (cleanupConfirm) { cleanupConfirm(); onDelete(); }
      else enterConfirm();
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
    if (textareaEl)  textareaEl.style.display  = bulk ? ""     : "none";
    if (kvWrapEl)    kvWrapEl.style.display    = bulk ? "none" : "";
    if (addBtnEl)    addBtnEl.style.display    = bulk ? "none" : "";
    if (delAllBtnEl) delAllBtnEl.style.display = bulk ? "none" : "";
  }

  // ── Bulk editor shared utilities ─────────────────────────────────────────

  /**
   * Serialise an array of { name, value, enabled } rows to  name=value  text.
   * Disabled rows are prefixed with "# " so the enabled state survives a
   * round-trip through the bulk editor.
   */
  #kvRowsToText(rows) {
    return rows.map(r => `${r.enabled ? "" : "# "}${r.name}=${r.value}`).join("\n");
  }

  /**
   * Serialise header rows to  Name: value  text (standard HTTP format).
   * Disabled rows are prefixed with "# ".
   */
  #headerRowsToText(rows) {
    return rows.map(r => `${r.enabled ? "" : "# "}${r.name}: ${r.value}`).join("\n");
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
      const name  = eqIdx === -1 ? trimmed           : trimmed.slice(0, eqIdx).trim();
      const value = eqIdx === -1 ? ""                : trimmed.slice(eqIdx + 1);
      if (name) out.push({ id: crypto.randomUUID(), name, value, enabled: !disabled });
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
      const eqIdx    = trimmed.indexOf("=");
      let name, value;
      if (colonIdx !== -1 && (eqIdx === -1 || colonIdx < eqIdx)) {
        name  = trimmed.slice(0, colonIdx).trim();
        value = trimmed.slice(colonIdx + 1).trim();
      } else if (eqIdx !== -1) {
        name  = trimmed.slice(0, eqIdx).trim();
        value = trimmed.slice(eqIdx + 1);
      } else {
        name  = trimmed;
        value = "";
      }
      if (name) out.push({ id: crypto.randomUUID(), name, value, enabled: !disabled });
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
    if (this.#paramsBulkEl)    this.#paramsBulkEl.style.display    = bulk ? "" : "none";
    if (this.#paramsKvWrapEl)  this.#paramsKvWrapEl.style.display  = bulk ? "none" : "";
    if (this.#paramsAddBtnEl)    this.#paramsAddBtnEl.style.display    = bulk ? "none" : "";
    if (this.#paramsDelAllBtnEl) this.#paramsDelAllBtnEl.style.display = bulk ? "none" : "";
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
    if (this.#headersBulkEl)    this.#headersBulkEl.style.display    = bulk ? "" : "none";
    if (this.#headersKvWrapEl)  this.#headersKvWrapEl.style.display  = bulk ? "none" : "";
    if (this.#headersAddBtnEl)    this.#headersAddBtnEl.style.display    = bulk ? "none" : "";
    if (this.#headersDelAllBtnEl) this.#headersDelAllBtnEl.style.display = bulk ? "none" : "";
    // Hide the "List Headers" toggle (and its spacer) in bulk mode
    if (this.#listHdrSpacerEl) this.#listHdrSpacerEl.style.display = bulk ? "none" : "";
    if (this.#listHdrLabelEl)  this.#listHdrLabelEl.style.display  = bulk ? "none" : "";
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
      // Discard stale pill editors before rebuilding the KV list
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
            this.#bfListEl.appendChild(this.#buildBfRow(row, this.#bodyFormRows))
          );
        }
      }
    }
    this.#dispatchBodyUpdated();
  }

  #applyBodyFormBulkMode() {
    this.#applyBulkMode(this.#bodyFormBulkMode,
      this.#bodyFormBulkEl, this.#bodyFormKvWrapEl,
      this.#bodyFormAddBtnEl, this.#bodyFormDelAllBtnEl);
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
    window.dispatchEvent(new CustomEvent("wurl:request-updated", {
      detail: { id: this.#currentNodeId, method: this.#method, url: this.#url },
      bubbles: true,
    }));
    }

    #dispatchParamsUpdated() {
    if (!this.#currentNodeId) return;
    window.dispatchEvent(new CustomEvent("wurl:request-updated", {
      detail: { id: this.#currentNodeId, params: this.#params.map((p) => ({ ...p })) },
      bubbles: true,
    }));
    }

    #dispatchHeadersUpdated() {
    if (!this.#currentNodeId) return;
    window.dispatchEvent(new CustomEvent("wurl:request-updated", {
      detail: { id: this.#currentNodeId, headers: this.#headers.map((h) => ({ ...h })) },
      bubbles: true,
    }));
    }

  // ── Send ─────────────────────────────────────────────────────────────────
  #sendRequest(force = false) {
    const rawUrl = this.#urlPillEditor.getValue().trim();
    if (!rawUrl) { this.#urlPillEditor.focus(); return; }

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
    const rv  = ctx ? (s) => resolveString(s, ctx) : (s) => s ?? "";

    // ── Variable pre-flight check ─────────────────────────────────────────
    // Before sending, collect every {{varName}} token from all request fields
    // and check whether each one resolves.  If any are unresolved and the
    // user hasn't already confirmed they want to proceed, show a warning
    // popup that lists all variables (resolved in success colour, unresolved
    // as "?" in error colour) with Cancel / Send Anyway options.
    if (!force) {
      const allVars  = collectTemplateVariables(this.#gatherRequestTemplates(), ctx);
      const badCount = allVars.filter(v => !v.found).length;
      if (badCount > 0) {
        PopupManager.warnVariables({
          variables:   allVars,
          actionLabel: "Send Anyway",
          onAction:    () => this.#sendRequest(true),
        });
        return;
      }
    }


    const baseUrl = rv(rawUrl);

    // ── 1. URL — append enabled, non-blank query parameters ──────────────
    const enabledParams = this.#params.filter(p => p.enabled && p.name.trim());
    let finalUrl = baseUrl;
    if (enabledParams.length) {
      const qs = enabledParams
        .map(p => `${encodeURIComponent(rv(p.name))}=${encodeURIComponent(rv(p.value))}`)
        .join("&");
      finalUrl += (baseUrl.includes("?") ? "&" : "?") + qs;
    }

    // ── 2. Headers — start with all enabled, non-blank request headers ────
    const headers = {};
    this.#headers
      .filter(h => h.enabled && h.name.trim())
      .forEach(h => { headers[rv(h.name).trim()] = rv(h.value); });

    // ── 3. Auth — inject Authorization (or other) headers if enabled ──────
    if (this.#authEnabled && this.#authType !== "none") {
      switch (this.#authType) {
        case "basic": {
          const username = rv(this.#authBasic.username ?? "");
          const password = rv(this.#authBasic.password ?? "");
          if (username || password) {
            headers["Authorization"] = `Basic ${btoa(`${username}:${password}`)}`;
          }
          break;
        }
        case "bearer":
          if (this.#authBearer.token)
            headers["Authorization"] = `Bearer ${rv(this.#authBearer.token)}`;
          break;
        case "oauth2":
          if (this.#authOAuth2.token)
            headers["Authorization"] = `Bearer ${rv(this.#authOAuth2.token)}`;
          break;
        // aws-iam: Signature v4 requires request-time signing — not yet implemented
      }
    }

    // ── 4. Body — build based on the selected body type ───────────────────
    // GET and HEAD must not carry a body.
    // All body types are serialised to a plain string (or null) so they can
    // be forwarded to the native layer (Electron IPC / Go dev server) which
    // cannot receive FormData, URLSearchParams, or File objects directly.
    const noBodyMethods = new Set(["GET", "HEAD"]);
    let body         = null;   // string | null
    let bodyFilePath = null;   // absolute path for the "file" body type (Electron only)

    if (!noBodyMethods.has(this.#method)) {
      switch (this.#bodyType) {
        case "form-data": {
          // Build a multipart/form-data body manually so we get a plain string.
          const boundary = `----WurlBoundary${Date.now()}`;
          const enabled  = this.#bodyFormRows.filter(r => r.enabled && r.name.trim());
          if (enabled.length > 0) {
            const parts = enabled.map(r =>
              `--${boundary}\r\nContent-Disposition: form-data; name="${rv(r.name)}"\r\n\r\n${rv(r.value)}`
            ).join("\r\n");
            body = `${parts}\r\n--${boundary}--`;
            if (!headers["Content-Type"])
              headers["Content-Type"] = `multipart/form-data; boundary=${boundary}`;
          }
          break;
        }
        case "form-urlencoded": {
          const sp = new URLSearchParams();
          this.#bodyFormRows
            .filter(r => r.enabled && r.name.trim())
            .forEach(r => sp.append(rv(r.name), rv(r.value)));
          body = sp.toString();
          if (!headers["Content-Type"])
            headers["Content-Type"] = "application/x-www-form-urlencoded";
          break;
        }
        case "json":
          if (this.#bodyText.trim()) {
            body = rv(this.#bodyText);
            if (!headers["Content-Type"])
              headers["Content-Type"] = "application/json";
          }
          break;
        case "yaml":
          if (this.#bodyText.trim()) {
            body = rv(this.#bodyText);
            if (!headers["Content-Type"])
              headers["Content-Type"] = "application/x-yaml";
          }
          break;
        case "xml":
          if (this.#bodyText.trim()) {
            body = rv(this.#bodyText);
            if (!headers["Content-Type"])
              headers["Content-Type"] = "application/xml";
          }
          break;
        case "text":
          if (this.#bodyText.trim()) {
            body = rv(this.#bodyText);
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

    window.dispatchEvent(new CustomEvent("wurl:send-request", {
      detail: { method: this.#method, url: finalUrl, headers, body, bodyFilePath },
      bubbles: true,
    }));
  }

  /**
   * Collect all template strings from the current request state so every
   * {{varName}} token can be checked before execution.
   * @returns {string[]}
   */
  #gatherRequestTemplates() {
    const t = [this.#urlPillEditor.getValue() ?? ""];
    for (const p of this.#params) {
      if (p.enabled) { t.push(p.name ?? "", p.value ?? ""); }
    }
    for (const h of this.#headers) {
      if (h.enabled) { t.push(h.name ?? "", h.value ?? ""); }
    }
    if (this.#authEnabled && this.#authType !== "none") {
      t.push(this.#authBasic?.username ?? "", this.#authBasic?.password ?? "");
      t.push(this.#authBearer?.token   ?? "");
      t.push(this.#authOAuth2?.token   ?? "");
    }
    t.push(this.#bodyText ?? "");
    for (const r of this.#bodyFormRows) {
      if (r.enabled) { t.push(r.name ?? "", r.value ?? ""); }
    }
    return t.filter(Boolean);
  }

  /**
   * Update the variable resolution context used by all active pill editors.
   * Call this whenever the selected request, environment, or folder variables
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

    // Cancel any in-progress inline confirm on the Delete All buttons.
    this._paramsDeleteAllCleanup?.();
    this._headersDeleteAllCleanup?.();
    this._bodyFormDeleteAllCleanup?.();

    if (node.method) {
      this.#method = node.method;
      this._methodSel.value = node.method;
      this._methodSel.dataset.method = node.method.toLowerCase();
    }

    const url = node.url ?? "";
    this.#url = url;
    this.#urlPillEditor.setValue(url);

    // Params
    this.#params = Array.isArray(node.params)
      ? node.params.map((p) => ({
          id:      p.id      ?? crypto.randomUUID(),
          name:    p.name    ?? "",
          value:   p.value   ?? "",
          enabled: p.enabled ?? true,
        }))
      : [];
    this.#renderParamsList();

    // Headers
    this.#headers = Array.isArray(node.headers)
      ? node.headers.map((h) => ({
          id:      h.id      ?? crypto.randomUUID(),
          name:    h.name    ?? "",
          value:   h.value   ?? "",
          enabled: h.enabled ?? true,
        }))
      : [];
    this.#renderHeadersList();

    // Body
    this.#bodyType = node.bodyType ?? "no-body";
    // Form rows — new unified format first, then legacy per-type fallbacks
    if (Array.isArray(node.bodyFormRows)) {
      this.#bodyFormRows = node.bodyFormRows.map(r => ({ id: r.id ?? crypto.randomUUID(), name: r.name ?? "", value: r.value ?? "", enabled: r.enabled ?? true }));
    } else if (Array.isArray(node.bodyFormData)) {
      this.#bodyFormRows = node.bodyFormData.map(r => ({ id: r.id ?? crypto.randomUUID(), name: r.name ?? "", value: r.value ?? "", enabled: r.enabled ?? true }));
    } else if (Array.isArray(node.bodyFormUrlEncoded)) {
      this.#bodyFormRows = node.bodyFormUrlEncoded.map(r => ({ id: r.id ?? crypto.randomUUID(), name: r.name ?? "", value: r.value ?? "", enabled: r.enabled ?? true }));
    }
    // Text body — new unified format first, then legacy per-type dict
    if (node.bodyText != null) {
      this.#bodyText = node.bodyText;
    } else if (node.bodyTexts) {
      // Legacy: prefer the text stored for the current body type, then the first non-empty entry
      const bt = node.bodyTexts;
      this.#bodyText = bt[this.#bodyType] ?? bt.json ?? bt.yaml ?? bt.xml ?? bt.text ?? "";
    }
    if (node.bodyFilePath != null) this.#bodyFilePath = node.bodyFilePath;
    // Sync the select element if the body tab has been built
    const sel = this.#el.querySelector(".body-type-select");
    if (sel) sel.value = this.#bodyType;
    this.#renderBodyContent();

    // Auth
    this.#authType    = node.authType    ?? "none";
    this.#authEnabled = node.authEnabled ?? true;
    if (node.authBasic)  this.#authBasic  = { ...this.#authBasic,  ...node.authBasic  };
    if (node.authBearer) this.#authBearer = { ...this.#authBearer, ...node.authBearer };
    if (node.authOAuth2) this.#authOAuth2 = { ...this.#authOAuth2, ...node.authOAuth2 };
    if (node.authAwsIam) this.#authAwsIam = { ...this.#authAwsIam, ...node.authAwsIam };
    const authSel = this.#el.querySelector("#auth-type-select");
    if (authSel) authSel.value = this.#authType;
    const authEnabledCheck = this.#el.querySelector("#auth-enabled-check");
    if (authEnabledCheck) authEnabledCheck.checked = this.#authEnabled;
    this.#authContentEl?.classList.toggle("auth-content--disabled", !this.#authEnabled);
    this.#renderAuthContent();
  }
}
