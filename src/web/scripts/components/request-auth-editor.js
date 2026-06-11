/**
 * request-auth-editor.js — Authentication editor sub-component
 *
 * Owns the Auth tab of the request editor: the type selector, the bulk-edit
 * textarea, and all seven auth schemes (Basic, Bearer, API-key, Digest, NTLM,
 * OAuth 2.0 with OIDC discovery, AWS IAM). It encapsulates the full auth model
 * and emits the same partial `wurl:request-updated` event the rest of the
 * editor uses, so the persisted model and event contract are unchanged.
 *
 * The parent {@link RequestEditor} owns send/load orchestration and supplies
 * the variable-resolution context, request-item list, response-cache hook, and
 * the current node id via callbacks. Auth-only concerns (decrypt errors,
 * OAuth 2.0 advanced toggle, scope/API-key autocompletes, OIDC discovery)
 * live entirely here.
 */

"use strict";

import { VariablePillEditor } from "./variable-pill-editor.js";
import { wrapSecretField } from "./secret-field.js";
import { PopupManager } from "../popup-manager.js";
import { Notifications } from "../notifications.js";
import { icon } from "../icons.js";
import { escapeHtml } from "../utils/html.js";
import { t } from "../i18n.js";
import { oauthExecutor } from "../auth/oauth-executor.js";
import {
  AutocompleteDropdown,
  buildToolbarToggle,
  disposePillEditors,
} from "./kv-editor-shared.js";

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

// Two dropdown instances — one for the OAuth 2.0 scope combo input and one for
// the API-key name combo input.
const _scope = new AutocompleteDropdown(
  "hdr-autocomplete scope-autocomplete",
  "Scope suggestions",
);
const _apiKey = new AutocompleteDropdown(
  "hdr-autocomplete apikey-autocomplete",
  "API key name suggestions",
);

/**
 * Show / refresh the scope suggestion dropdown below `input`.
 * `onSelect(picked, currentWord)` is called when the user picks an item.
 * `scopeList` defaults to DEFAULT_SCOPES but can be overridden with OIDC-discovered scopes.
 */
function _showScopeDropdown(input, onSelect, scopeList = DEFAULT_SCOPES) {
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

  _scope.show(input, matches, (s) => {
    _scope.hide();
    onSelect(s, currentWord);
    input.focus();
  });
}

function _scopeDropdownAccept(input, onSelect) {
  const label = _scope.activeLabel();
  if (label === null) return false;
  const fullVal = input.value;
  const lastSpace = fullVal.lastIndexOf(" ");
  const currentWord = lastSpace === -1 ? fullVal : fullVal.slice(lastSpace + 1);
  _scope.hide();
  onSelect(label, currentWord);
  return true;
}

// ── API-key name combo dropdown ───────────────────────────────────────────────
// Reuses the .hdr-autocomplete CSS classes. Offers the common API-key header
// names, each with a short comment, but the user can always type their own.

const API_KEY_NAMES = [
  { name: "X-API-Key", comment: "The de-facto industry standard name." },
  {
    name: "X-API-KEY",
    comment: "The uppercase variant of the de-facto standard.",
  },
  { name: "api-key", comment: "Common lowercase, non-prefixed alternative." },
  { name: "apikey", comment: "Common lowercase, non-prefixed alternative." },
  {
    name: "X-Auth-Token",
    comment:
      "Frequently used when the key serves as a long-lived security token.",
  },
];

/**
 * Show / refresh the API-key name dropdown below `input`.
 * Filters the standard names by what's typed; `onSelect(name)` fires on pick.
 */
function _showApiKeyDropdown(input, onSelect) {
  const query = input.value.toLowerCase().trim();
  const matches = query
    ? API_KEY_NAMES.filter((k) => k.name.toLowerCase().includes(query))
    : API_KEY_NAMES;

  _apiKey.show(
    input,
    matches,
    (name) => {
      input.value = name;
      _apiKey.hide();
      onSelect?.(name);
      input.focus();
    },
    {
      minWidth: 280,
      renderItem: (item, k) => {
        item.classList.add("apikey-autocomplete-item");
        const name = document.createElement("span");
        name.className = "apikey-autocomplete-name";
        name.textContent = k.name;
        const comment = document.createElement("span");
        comment.className = "apikey-autocomplete-comment";
        comment.textContent = k.comment;
        item.appendChild(name);
        item.appendChild(comment);
        item.dataset.value = k.name;
      },
    },
  );
}

/** Accept the currently keyboard-focused item, if any. */
function _apiKeyDropdownAccept(input, onSelect) {
  const label = _apiKey.activeLabel();
  if (label === null) return false;
  input.value = label;
  _apiKey.hide();
  onSelect?.(label);
  return true;
}

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

export class RequestAuthEditor {
  /** @type {HTMLElement} */
  #el;

  // ── Callbacks supplied by the parent RequestEditor ──────────────────────────
  /** @type {() => (object|null)} current variable-resolution context */
  #getContext;
  /** @type {() => object[]} request items for function-pill request pickers */
  #getItems;
  /** @type {((names: string[]) => any)|null} preload cross-request response caches */
  #ensureResponseCaches;
  /** @type {() => (string|null)} id of the request currently being edited */
  #getCurrentNodeId;

  // ── Auth state ──────────────────────────────────────────────────────────────
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
  #authApiKey = {
    name: "", // header name or query-param key (e.g. "X-API-Key")
    value: "", // the secret key value (encrypted at rest)
    addTo: "header", // "header" | "query"
  };
  #authDigest = {
    username: "",
    password: "", // encrypted at rest; challenge/response runs in the main process
  };
  #authNtlm = {
    username: "",
    password: "", // encrypted at rest; the NTLM handshake runs in the main process
    domain: "", // optional NT domain (or use DOMAIN\username in the username field)
    workstation: "", // optional client workstation name
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

  // OAuth 2.0 advanced-fields toggle
  #oauth2Advanced = false;

  /** All active pill editors in the auth form (cleared on each re-render). */
  #authPillEditors = [];

  /**
   * @param {object} opts
   * @param {() => (object|null)} opts.getContext       current variable context
   * @param {() => object[]} opts.getItems              request items for pickers
   * @param {(names: string[]) => any} opts.ensureResponseCaches
   * @param {() => (string|null)} opts.getCurrentNodeId  current node id
   */
  constructor({
    getContext,
    getItems,
    ensureResponseCaches,
    getCurrentNodeId,
  } = {}) {
    this.#getContext = getContext ?? (() => null);
    this.#getItems = getItems ?? (() => []);
    this.#ensureResponseCaches = ensureResponseCaches ?? null;
    this.#getCurrentNodeId = getCurrentNodeId ?? (() => null);
    this.#el = this.#build();
  }

  /** Root DOM element — the Auth tab pane content. */
  get element() {
    return this.#el;
  }

  // ── Auth editor ───────────────────────────────────────────────────────────
  #build() {
    const container = document.createElement("div");
    container.className = "params-editor";

    // ── Type selector bar ─────────────────────────────────────────────────
    const typeBar = document.createElement("div");
    typeBar.className = "params-toolbar body-type-bar";
    this.#authTypeBarEl = typeBar;

    const typeSelect = document.createElement("select");
    typeSelect.className = "body-type-select";
    typeSelect.id = "auth-type-select";
    typeSelect.setAttribute("aria-label", t("auth.typeAria"));
    typeSelect.innerHTML = `
      <optgroup label="${t("auth.typeGroupAuth")}">
        <option value="basic">${t("auth.type.basic")}</option>
        <option value="bearer">${t("auth.type.bearer")}</option>
        <option value="apikey">${t("auth.type.apikey")}</option>
        <option value="digest">${t("auth.type.digest")}</option>
        <option value="ntlm">${t("auth.type.ntlm")}</option>
        <option value="oauth2">${t("auth.type.oauth2")}</option>
        <option value="aws-iam">${t("auth.type.awsIam")}</option>
      </optgroup>
      <optgroup label="${t("auth.typeGroupOther")}">
        <option value="none">${t("auth.type.none")}</option>
      </optgroup>
    `;
    typeSelect.value = this.#authType;
    typeSelect.addEventListener("change", () => {
      this.#authType = typeSelect.value;
      if (this.#discoverBtnEl)
        this.#discoverBtnEl.hidden = this.#authType !== "oauth2";
      if (this.#authBulkEl)
        this.#authBulkEl.classList.toggle(
          "params-toolbar-toggle-label--hidden",
          this.#authType === "none",
        );
      if (this.#authEnabledLabelEl)
        this.#authEnabledLabelEl.classList.toggle(
          "params-toolbar-toggle-label--hidden",
          this.#authType === "none",
        );
      this.#renderAuthContent();
      this.#dispatchAuthUpdated();
    });

    typeBar.appendChild(typeSelect);

    // ── Bulk Editor toggle — shown for all auth types except None ─────────
    const { label: bulkLabel, check: bulkCheck } = buildToolbarToggle({
      text: " " + t("kv.bulkEditor"),
      title: t("kv.bulkEditorTitle"),
      checked: this.#authBulkMode,
      onChange: (checked) => {
        this.#authBulkMode = checked;
        this.#renderAuthContent();
      },
    });
    bulkLabel.classList.toggle(
      "params-toolbar-toggle-label--hidden",
      this.#authType === "none",
    );
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
    discoverBtn.textContent = t("auth.discover");
    discoverBtn.title = t("auth.discoverTitle");
    discoverBtn.hidden = this.#authType !== "oauth2";
    this.#discoverBtnEl = discoverBtn;
    discoverBtn.addEventListener("click", () => {
      this.#showIssuerDialog();
    });
    typeBar.appendChild(discoverBtn);

    const enabledLabel = document.createElement("label");
    enabledLabel.className = "params-toolbar-toggle-label";
    enabledLabel.title = t("auth.enabledTitle");

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
    enabledLabel.append(" " + t("auth.enabled"));
    enabledLabel.classList.toggle(
      "params-toolbar-toggle-label--hidden",
      this.#authType === "none",
    );
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
    disposePillEditors(this.#authPillEditors);
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
      case "apikey":
        return this.#renderAuthApiKey(el);
      case "digest":
        return this.#renderAuthDigest(el);
      case "ntlm":
        return this.#renderAuthNtlm(el);
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

      case "apikey":
        return [
          { key: "name", value: this.#authApiKey.name },
          { key: "value", value: this.#authApiKey.value },
          { key: "addTo", value: this.#authApiKey.addTo },
        ];

      case "digest":
        return [
          { key: "username", value: this.#authDigest.username },
          { key: "password", value: this.#authDigest.password },
        ];

      case "ntlm":
        return [
          { key: "username", value: this.#authNtlm.username },
          { key: "password", value: this.#authNtlm.password },
          { key: "domain", value: this.#authNtlm.domain },
          { key: "workstation", value: this.#authNtlm.workstation },
        ];

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
        case "apikey":
          if (key === "addTo") {
            // Constrain to the two valid targets so the select can't desync.
            if (v === "header" || v === "query") this.#authApiKey.addTo = v;
          } else if (key === "name" || key === "value") {
            this.#authApiKey[key] = v;
          }
          break;
        case "digest":
          if (key === "username" || key === "password")
            this.#authDigest[key] = v;
          break;
        case "ntlm":
          if (
            key === "username" ||
            key === "password" ||
            key === "domain" ||
            key === "workstation"
          )
            this.#authNtlm[key] = v;
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
    msg.textContent = t("auth.noneMessage");
    el.appendChild(msg);
  }

  // ── Basic ─────────────────────────────────────────────────────────────────
  #renderAuthBasic(el) {
    const form = document.createElement("div");
    form.className = "auth-form";

    form.appendChild(
      this.#buildAuthPillField(t("auth.username"), {
        placeholder: t("auth.username"),
        value: this.#authBasic.username,
        onInput: (v) => {
          this.#authBasic.username = v;
          this.#dispatchAuthUpdated();
        },
      }),
    );

    form.appendChild(
      this.#buildAuthPillField(t("auth.password"), {
        placeholder: t("auth.password"),
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
      this.#buildAuthPillField(t("auth.bearer.token"), {
        placeholder: t("auth.bearer.tokenPlaceholder"),
        value: this.#authBearer.token,
        decryptPath: "authBearer.token",
        onInput: (v) => {
          this.#authBearer.token = v;
          this.#dispatchAuthUpdated();
        },
        hint: t("auth.bearer.tokenHint"),
      }),
    );

    el.appendChild(form);
  }

  // ── API Key ───────────────────────────────────────────────────────────────
  #renderAuthApiKey(el) {
    const form = document.createElement("div");
    form.className = "auth-form";

    form.appendChild(
      this.#buildAuthApiKeyNameField({
        value: this.#authApiKey.name,
        onInput: (v) => {
          this.#authApiKey.name = v;
          this.#dispatchAuthUpdated();
        },
      }),
    );

    form.appendChild(
      this.#buildAuthPillField(t("auth.apiKey.value"), {
        placeholder: t("auth.apiKey.valuePlaceholder"),
        value: this.#authApiKey.value,
        decryptPath: "authApiKey.value",
        onInput: (v) => {
          this.#authApiKey.value = v;
          this.#dispatchAuthUpdated();
        },
      }),
    );

    form.appendChild(
      this.#buildAuthFieldSelect(t("auth.apiKey.addTo"), {
        options: [
          { value: "header", label: t("auth.apiKey.header") },
          { value: "query", label: t("auth.apiKey.queryParams") },
        ],
        value: this.#authApiKey.addTo,
        ariaLabel: t("auth.apiKey.addToAria"),
        onInput: (v) => {
          this.#authApiKey.addTo = v;
          this.#dispatchAuthUpdated();
        },
      }),
    );

    el.appendChild(form);
  }

  // ── Digest ────────────────────────────────────────────────────────────────
  #renderAuthDigest(el) {
    const form = document.createElement("div");
    form.className = "auth-form";

    form.appendChild(
      this.#buildAuthPillField(t("auth.username"), {
        placeholder: t("auth.username"),
        value: this.#authDigest.username,
        onInput: (v) => {
          this.#authDigest.username = v;
          this.#dispatchAuthUpdated();
        },
      }),
    );

    form.appendChild(
      this.#buildAuthPillField(t("auth.password"), {
        placeholder: t("auth.password"),
        value: this.#authDigest.password,
        decryptPath: "authDigest.password",
        onInput: (v) => {
          this.#authDigest.password = v;
          this.#dispatchAuthUpdated();
        },
        hint: t("auth.digest.hint"),
      }),
    );

    el.appendChild(form);
  }

  // ── NTLM ──────────────────────────────────────────────────────────────────
  #renderAuthNtlm(el) {
    const form = document.createElement("div");
    form.className = "auth-form";

    form.appendChild(
      this.#buildAuthPillField(t("auth.username"), {
        placeholder: t("auth.ntlm.usernamePlaceholder"),
        value: this.#authNtlm.username,
        onInput: (v) => {
          this.#authNtlm.username = v;
          this.#dispatchAuthUpdated();
        },
      }),
    );

    form.appendChild(
      this.#buildAuthPillField(t("auth.password"), {
        placeholder: t("auth.password"),
        value: this.#authNtlm.password,
        decryptPath: "authNtlm.password",
        onInput: (v) => {
          this.#authNtlm.password = v;
          this.#dispatchAuthUpdated();
        },
      }),
    );

    form.appendChild(
      this.#buildAuthPillField(t("auth.ntlm.domain"), {
        placeholder: t("auth.ntlm.domainPlaceholder"),
        value: this.#authNtlm.domain,
        onInput: (v) => {
          this.#authNtlm.domain = v;
          this.#dispatchAuthUpdated();
        },
      }),
    );

    form.appendChild(
      this.#buildAuthPillField(t("auth.ntlm.workstation"), {
        placeholder: t("auth.ntlm.workstationPlaceholder"),
        value: this.#authNtlm.workstation,
        onInput: (v) => {
          this.#authNtlm.workstation = v;
          this.#dispatchAuthUpdated();
        },
        hint: t("auth.ntlm.hint"),
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
      {
        value: "authorization_code",
        label: t("auth.oauth2.grant.authorizationCode"),
      },
      {
        value: "client_credentials",
        label: t("auth.oauth2.grant.clientCredentials"),
      },
      { value: "password", label: t("auth.oauth2.grant.password") },
      { value: "implicit", label: t("auth.oauth2.grant.implicit") },
    ];
    form.appendChild(
      this.#buildAuthFieldSelect(t("auth.oauth2.grantType"), {
        options: allGrantTypes,
        value: this.#authOAuth2.grantType,
        ariaLabel: t("auth.oauth2.grantTypeAria"),
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
        {
          value: "confidential",
          label: t("auth.oauth2.clientTypeConfidential"),
        },
        { value: "public", label: t("auth.oauth2.clientTypePublic") },
      ];
      form.appendChild(
        this.#buildAuthFieldSelect(t("auth.oauth2.clientType"), {
          options: clientTypeOptions,
          value: this.#authOAuth2.clientType ?? "confidential",
          ariaLabel: t("auth.oauth2.clientTypeAria"),
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
      this.#buildAuthPillField(t("auth.oauth2.clientId"), {
        placeholder: t("auth.oauth2.clientId"),
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
        this.#buildAuthPillField(t("auth.oauth2.clientSecret"), {
          placeholder: t("auth.oauth2.clientSecret"),
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
        this.#buildAuthPillField(t("auth.oauth2.accessTokenUrl"), {
          placeholder: t("auth.oauth2.accessTokenUrlPlaceholder"),
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
        this.#buildAuthPillField(t("auth.oauth2.authUrl"), {
          placeholder: t("auth.oauth2.authUrlPlaceholder"),
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
        this.#buildAuthPillField(t("auth.oauth2.redirectUri"), {
          placeholder: t("auth.oauth2.redirectUriPlaceholder"),
          value: this.#authOAuth2.redirectUri ?? "",
          onInput: (v) => {
            this.#authOAuth2.redirectUri = v;
            this.#dispatchAuthUpdated();
          },
          hint: t("auth.oauth2.redirectUriHint"),
        }),
      );
    }

    // ── Username / Password (resource owner password only) ─────────────────
    if (this.#authOAuth2.grantType === "password") {
      form.appendChild(
        this.#buildAuthPillField(t("auth.username"), {
          placeholder: t("auth.username"),
          value: this.#authOAuth2.username ?? "",
          onInput: (v) => {
            this.#authOAuth2.username = v;
            this.#dispatchAuthUpdated();
          },
        }),
      );
      form.appendChild(
        this.#buildAuthPillField(t("auth.password"), {
          placeholder: t("auth.password"),
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
    advCheck.setAttribute("aria-label", t("auth.oauth2.advancedAria"));
    advCheck.addEventListener("change", () => {
      this.#oauth2Advanced = advCheck.checked;
      this.#renderAuthContent();
    });

    advLabel.appendChild(advCheck);
    advLabel.append(" " + t("auth.oauth2.advanced"));
    advRow.appendChild(advLabel);
    form.appendChild(advRow);

    // ── Advanced fields (only when toggle is on) ───────────────────────────
    if (this.#oauth2Advanced) {
      const grant = this.#authOAuth2.grantType;

      // Response Type — implicit only
      if (grant === "implicit") {
        form.appendChild(
          this.#buildAuthFieldSelect(t("auth.oauth2.responseType"), {
            options: [
              {
                value: "access_token",
                label: t("auth.oauth2.responseAccessToken"),
              },
              { value: "id_token", label: t("auth.oauth2.responseIdToken") },
              { value: "both", label: t("auth.oauth2.responseBoth") },
            ],
            value: this.#authOAuth2.responseType ?? "access_token",
            ariaLabel: t("auth.oauth2.responseTypeAria"),
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
          this.#buildAuthPillField(t("auth.oauth2.state"), {
            placeholder: t("auth.oauth2.statePlaceholder"),
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
          this.#buildAuthFieldSelect(t("auth.oauth2.credentials"), {
            options: [
              { value: "header", label: t("auth.oauth2.credentialsHeader") },
              { value: "body", label: t("auth.oauth2.credentialsBody") },
            ],
            value: this.#authOAuth2.credentials ?? "header",
            ariaLabel: t("auth.oauth2.credentialsAria"),
            onInput: (v) => {
              this.#authOAuth2.credentials = v;
              this.#dispatchAuthUpdated();
            },
          }),
        );
      }

      // Audience — all grant types
      form.appendChild(
        this.#buildAuthPillField(t("auth.oauth2.audience"), {
          placeholder: t("auth.oauth2.audiencePlaceholder"),
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
          this.#buildAuthPillField(t("auth.oauth2.resource"), {
            placeholder: t("auth.oauth2.resourcePlaceholder"),
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
          this.#buildAuthPillField(t("auth.oauth2.origin"), {
            placeholder: t("auth.oauth2.originPlaceholder"),
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
        this.#buildAuthPillField(t("auth.oauth2.headerPrefix"), {
          placeholder: t("auth.oauth2.headerPrefixPlaceholder"),
          value: this.#authOAuth2.headerPrefix ?? "",
          onInput: (v) => {
            this.#authOAuth2.headerPrefix = v;
            this.#dispatchAuthUpdated();
          },
          hint: t("auth.oauth2.headerPrefixHint"),
        }),
      );
    }

    // ── Current access token display ───────────────────────────────────────
    if (this.#authOAuth2.token) {
      const tokenSection = document.createElement("div");
      tokenSection.className = "auth-section-title";
      tokenSection.textContent = t("auth.oauth2.currentToken");
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
      clearBtn.className = "btn body-file-reset-btn";
      clearBtn.textContent = t("auth.oauth2.clearToken");
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
      clearSessionBtn.className = "btn body-file-reset-btn";
      clearSessionBtn.textContent = t("auth.oauth2.clearSession");
      clearSessionBtn.title = t("auth.oauth2.clearSessionTitle");
      clearSessionBtn.addEventListener("click", async () => {
        // Clear token state and executor cache
        this.#authOAuth2.token = "";
        this.#authOAuth2.refreshToken = "";
        this.#authOAuth2.expiresAt = null;
        oauthExecutor.clearToken(this.#authOAuth2);

        // Clear Electron session (cookies, localStorage, cache, …)
        if (typeof window.wurl?.oauth?.clearSession === "function") {
          clearSessionBtn.disabled = true;
          clearSessionBtn.textContent = t("auth.oauth2.clearing");
          try {
            await window.wurl.oauth.clearSession();
          } catch (err) {
            console.warn("[oauth] clearSession failed:", err.message);
            Notifications.warning(t("auth.oauth2.clearSessionFailed"));
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
        expiryEl.className = "auth-field-hint";
        const remaining = Math.max(
          0,
          Math.floor((this.#authOAuth2.expiresAt - Date.now()) / 1000),
        );
        if (remaining > 0) {
          expiryEl.textContent = t("auth.oauth2.expiresIn", {
            seconds: remaining,
          });
        } else {
          expiryEl.textContent = t("auth.oauth2.tokenExpired");
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
      ? t("auth.oauth2.refreshToken")
      : t("auth.oauth2.getToken");
    getTokenBtn.title = t("auth.oauth2.getTokenTitle");

    const tokenStatusEl = document.createElement("span");
    tokenStatusEl.className = "auth-token-status";

    getTokenBtn.addEventListener("click", async () => {
      const tokenNodeId = this.#getCurrentNodeId();
      getTokenBtn.disabled = true;
      getTokenBtn.textContent = t("auth.oauth2.fetching");
      tokenStatusEl.textContent = "";
      tokenStatusEl.className = "auth-token-status";

      try {
        const result = await oauthExecutor.forceRefresh({
          ...this.#authOAuth2,
        });
        if (this.#getCurrentNodeId() !== tokenNodeId) return;

        if (result.success && result.accessToken) {
          this.#authOAuth2.token = result.accessToken;
          this.#authOAuth2.refreshToken = result.refreshToken ?? "";
          this.#authOAuth2.expiresAt = result.expiresAt ?? null;
          tokenStatusEl.textContent = t("auth.oauth2.tokenAcquired");
          tokenStatusEl.className = "auth-token-status auth-token-status--ok";
        } else {
          const msg =
            result.error?.description ??
            result.error?.code ??
            t("auth.oauth2.unknownError");
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
          ? t("auth.oauth2.refreshToken")
          : t("auth.oauth2.getToken");
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
      this.#buildAuthPillField(t("auth.aws.accessKeyId"), {
        placeholder: t("auth.aws.accessKeyIdPlaceholder"),
        value: this.#authAwsIam.accessKeyId,
        onInput: (v) => {
          this.#authAwsIam.accessKeyId = v;
          this.#dispatchAuthUpdated();
        },
      }),
    );

    form.appendChild(
      this.#buildAuthPillField(t("auth.aws.secretAccessKey"), {
        placeholder: t("auth.aws.secretAccessKeyPlaceholder"),
        value: this.#authAwsIam.secretAccessKey,
        decryptPath: "authAwsIam.secretAccessKey",
        onInput: (v) => {
          this.#authAwsIam.secretAccessKey = v;
          this.#dispatchAuthUpdated();
        },
      }),
    );

    form.appendChild(
      this.#buildAuthPillField(t("auth.aws.region"), {
        placeholder: t("auth.aws.regionPlaceholder"),
        value: this.#authAwsIam.region,
        onInput: (v) => {
          this.#authAwsIam.region = v;
          this.#dispatchAuthUpdated();
        },
      }),
    );

    form.appendChild(
      this.#buildAuthPillField(t("auth.aws.service"), {
        placeholder: t("auth.aws.servicePlaceholder"),
        value: this.#authAwsIam.service,
        onInput: (v) => {
          this.#authAwsIam.service = v;
          this.#dispatchAuthUpdated();
        },
      }),
    );

    form.appendChild(
      this.#buildAuthPillField(t("auth.aws.sessionToken"), {
        placeholder: t("auth.aws.sessionTokenPlaceholder"),
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
    lbl.className = "auth-field-label";
    lbl.textContent = label;

    const editor = new VariablePillEditor({
      placeholder,
      ariaLabel: label,
      className: "auth-field-input",
      getContext: () => this.#getContext(),
      getItems: () => this.#getItems(),
      ensureResponseCaches: (names) => this.#ensureResponseCaches?.(names),
      onInput: onInput ?? (() => {}),
    });
    editor.setValue(value ?? "");
    this.#authPillEditors.push(editor);

    wrapper.appendChild(lbl);
    // Encrypted-at-rest fields (those with a decryptPath) are masked behind a
    // reveal control; non-secret pill fields render the editor bare.
    wrapper.appendChild(
      decryptPath ? wrapSecretField(editor.element) : editor.element,
    );

    if (hint) {
      const hintEl = document.createElement("span");
      hintEl.className = "auth-field-hint";
      hintEl.textContent = hint;
      wrapper.appendChild(hintEl);
    }

    if (failedDecrypt) {
      const warnEl = document.createElement("span");
      warnEl.className = "auth-field-decrypt-warning";
      warnEl.textContent = t("auth.decryptFailed");
      wrapper.appendChild(warnEl);
    }

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
    lbl.className = "auth-field-label";
    lbl.textContent = t("auth.oauth2.scope");

    const input = document.createElement("input");
    input.type = "text";
    input.className = "auth-field-input";
    input.placeholder = t("auth.oauth2.scopePlaceholder");
    input.value = value;
    input.name = "wurl-auth-scope";
    input.setAttribute("autocomplete", "off");
    input.setAttribute("aria-label", t("auth.oauth2.scope"));
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
      _scope.scheduleHide();
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        _scope.navigate(+1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        _scope.navigate(-1);
        return;
      }
      if (e.key === "Escape") {
        _scope.hide();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        _scopeDropdownAccept(input, onSelect);
      }
    });

    const hint = document.createElement("span");
    hint.className = "auth-field-hint";
    hint.textContent = t("auth.oauth2.scopeHint");

    wrapper.appendChild(lbl);
    wrapper.appendChild(input);
    wrapper.appendChild(hint);
    return wrapper;
  }

  /**
   * Build the API-key name field: a free-text combo input backed by a
   * suggestive dropdown of common API-key header names. The user can pick a
   * standard name (each annotated with a short comment) or type their own.
   * @param {{ value?: string, onInput?: (v:string)=>void }} opts
   */
  #buildAuthApiKeyNameField({ value = "", onInput } = {}) {
    const wrapper = document.createElement("div");
    wrapper.className = "auth-field";

    const lbl = document.createElement("label");
    lbl.className = "auth-field-label";
    lbl.textContent = t("auth.apiKey.name");

    const input = document.createElement("input");
    input.type = "text";
    input.className = "auth-field-input";
    input.placeholder = t("auth.apiKey.namePlaceholder");
    input.value = value;
    input.name = "wurl-auth-apikey-name";
    input.setAttribute("autocomplete", "off");
    input.setAttribute("aria-label", t("auth.apiKey.nameAria"));
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-haspopup", "listbox");

    input.addEventListener("focus", () => _showApiKeyDropdown(input, onInput));

    input.addEventListener("input", () => {
      onInput?.(input.value);
      _showApiKeyDropdown(input, onInput);
    });

    input.addEventListener("blur", () => {
      _apiKey.scheduleHide();
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        _apiKey.navigate(+1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        _apiKey.navigate(-1);
        return;
      }
      if (e.key === "Escape") {
        _apiKey.hide();
        return;
      }
      if (e.key === "Enter") {
        if (_apiKeyDropdownAccept(input, onInput)) e.preventDefault();
      }
    });

    const hint = document.createElement("span");
    hint.className = "auth-field-hint";
    hint.textContent = t("auth.apiKey.nameHint");

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
    lbl.className = "auth-field-label";
    lbl.textContent = label;

    const sel = document.createElement("select");
    sel.className = "auth-field-input auth-field-select";
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
    const currentNodeId = this.#getCurrentNodeId();
    if (!currentNodeId) return;
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
          id: currentNodeId,
          authEnabled: this.#authEnabled,
          authType: this.#authType,
          authBasic: { ...this.#authBasic },
          authBearer: { ...this.#authBearer },
          authApiKey: { ...this.#authApiKey },
          authDigest: { ...this.#authDigest },
          authNtlm: { ...this.#authNtlm },
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
    dlg.setAttribute("aria-label", t("auth.discoverDialog.title"));

    dlg.innerHTML = `
      <div class="popup-header">
        <span class="popup-title">${t("auth.discoverDialog.title")}</span>
        <button class="popup-close" aria-label="${t("common.close")}" data-action="close" title="${t("common.close")}">${icon("close", { size: 13 })}</button>
      </div>
      <div class="popup-body discover-dialog-body">
        <p class="discover-dialog-desc">${t("auth.discoverDialog.desc")}</p>
        <label class="discover-dialog-label" for="discover-issuer-input">${t("auth.discoverDialog.issuerLabel")}</label>
        <input
          id="discover-issuer-input"
          type="url"
          class="discover-dialog-input"
          placeholder="${t("auth.discoverDialog.issuerPlaceholder")}"
          autocomplete="off"
          spellcheck="false"
          aria-label="${t("auth.discoverDialog.issuerLabel")}"
          value="${escapeHtml(this.#authOAuth2.discoveredIssuer)}"
        />
        <p class="discover-dialog-error" aria-live="polite" hidden></p>
      </div>
      <div class="popup-footer">
        <button class="btn popup-btn btn--secondary" data-action="cancel">${t("auth.discoverDialog.cancel")}</button>
        <button class="btn popup-btn btn--primary"   data-action="discover">${t("auth.discoverDialog.discover")}</button>
      </div>
    `;

    const urlInput = dlg.querySelector("#discover-issuer-input");
    const errorEl = dlg.querySelector(".discover-dialog-error");
    const discoverEl = dlg.querySelector("[data-action='discover']");

    const dismiss = () => {
      document.removeEventListener("keydown", onDocKey);
      PopupManager.close();
    };

    const showError = (msg) => {
      errorEl.innerHTML = msg;
      errorEl.hidden = false;
      discoverEl.disabled = false;
      discoverEl.textContent = t("auth.discoverDialog.discover");
      urlInput.focus();
    };

    const doDiscover = async () => {
      const raw = urlInput.value.trim();
      if (!raw) {
        showError(t("auth.discoverDialog.enterUrl"));
        return;
      }

      // Capture which request started the discovery — used to guard
      // against applying results to a different request if the user
      // switched selections while the fetch was in flight.
      const targetNodeId = this.#getCurrentNodeId();

      errorEl.hidden = true;
      discoverEl.disabled = true;
      discoverEl.textContent = t("auth.discoverDialog.fetching");

      const base = raw.replace(/\/+$/, "");
      const discoveryUrl = `${base}/.well-known/openid-configuration`;

      let config;
      try {
        config = await _fetchJson(discoveryUrl);
      } catch (err) {
        showError(
          t("auth.discoverDialog.fetchFailed", {
            url: escapeHtml(discoveryUrl),
            message: escapeHtml(err.message),
          }),
        );
        // Clear any previously stored discovery data so stale scopes/issuer
        // from a prior successful lookup don't linger after a failed re-discover.
        if (this.#getCurrentNodeId() === targetNodeId) {
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
    if (this.#getCurrentNodeId() !== targetNodeId) return;

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

  // ── Public API (parent RequestEditor) ───────────────────────────────────────

  /**
   * Populate the auth fields from a saved request node and sync the toolbar
   * controls to match. Mirrors the auth block of RequestEditor#load.
   * @param {object} node
   */
  setModel(node) {
    this.#decryptErrors = new Set(
      Array.isArray(node._decryptErrors) ? node._decryptErrors : [],
    );

    this.#authType = node.authType ?? "none";
    this.#authEnabled = node.authEnabled ?? true;
    this.#authBasic = { username: "", password: "", ...(node.authBasic ?? {}) };
    this.#authBearer = { token: "", ...(node.authBearer ?? {}) };
    this.#authApiKey = {
      name: "",
      value: "",
      addTo: "header",
      ...(node.authApiKey ?? {}),
    };
    this.#authDigest = {
      username: "",
      password: "",
      ...(node.authDigest ?? {}),
    };
    this.#authNtlm = {
      username: "",
      password: "",
      domain: "",
      workstation: "",
      ...(node.authNtlm ?? {}),
    };
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
      this.#authBulkEl.classList.toggle(
        "params-toolbar-toggle-label--hidden",
        this.#authType === "none",
      );
    if (this.#authEnabledLabelEl)
      this.#authEnabledLabelEl.classList.toggle(
        "params-toolbar-toggle-label--hidden",
        this.#authType === "none",
      );
    this.#renderAuthContent();
  }

  /**
   * Live auth model consumed by the parent at send time (buildRequestPayload).
   * Returns the same field references the form mutates — do not copy/mutate.
   */
  getModel() {
    return {
      authEnabled: this.#authEnabled,
      authType: this.#authType,
      authBasic: this.#authBasic,
      authBearer: this.#authBearer,
      authApiKey: this.#authApiKey,
      authDigest: this.#authDigest,
      authNtlm: this.#authNtlm,
      authOAuth2: this.#authOAuth2,
      authAwsIam: this.#authAwsIam,
    };
  }

  /**
   * Template strings for the variable pre-flight check. Mirrors the auth block
   * of RequestEditor#gatherRequestTemplates (empties are filtered by caller).
   * @returns {string[]}
   */
  gatherTemplates() {
    if (!(this.#authEnabled && this.#authType !== "none")) return [];
    return [
      this.#authBasic?.username ?? "",
      this.#authBasic?.password ?? "",
      this.#authBearer?.token ?? "",
      this.#authDigest?.username ?? "",
      this.#authDigest?.password ?? "",
      this.#authNtlm?.username ?? "",
      this.#authNtlm?.password ?? "",
      this.#authNtlm?.domain ?? "",
      this.#authNtlm?.workstation ?? "",
      this.#authOAuth2?.token ?? "",
    ];
  }

  /** Re-validate every active auth pill editor (variable context changed). */
  revalidatePills() {
    for (const editor of this.#authPillEditors) editor?.revalidate();
  }

  /**
   * Resolve the OAuth 2.0 Authorization header prefix at send time. Reads the
   * live DOM input first (covers a value typed but not yet committed to state),
   * then the in-memory state, then the "Bearer" default.
   * @returns {string}
   */
  getOAuth2HeaderPrefix() {
    const prefixEl = this.#el.querySelector('[name="wurl-auth-header-prefix"]');
    return (
      prefixEl?.value?.trim() ||
      this.#authOAuth2.headerPrefix?.trim() ||
      "Bearer"
    );
  }

  /**
   * Sync local auth state with a token acquired during send (token display +
   * expiry badge), then re-render and persist. Mirrors the post-send block of
   * RequestEditor#sendRequest.
   * @param {{ accessToken: string, refreshToken?: string, expiresAt?: number|null }} result
   */
  applyAcquiredToken({ accessToken, refreshToken, expiresAt }) {
    this.#authOAuth2.token = accessToken;
    this.#authOAuth2.refreshToken =
      refreshToken ?? this.#authOAuth2.refreshToken ?? "";
    this.#authOAuth2.expiresAt = expiresAt ?? this.#authOAuth2.expiresAt;
    this.#renderAuthContent();
    this.#dispatchAuthUpdated();
  }

  /** Tear down pill editors and dismiss any open autocomplete dropdowns. */
  destroy() {
    disposePillEditors(this.#authPillEditors);
    _scope.hide();
    _apiKey.hide();
  }
}
