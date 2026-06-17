/**
 * settings-popup.js — Application settings popup
 *
 * Built on top of PopupManager so it participates in the shared overlay/mask
 * system.  Settings are persisted immediately on every control change by
 * dispatching a "hippo:settings-changed" event; app.js listens and writes to
 * storage.  There is no explicit Save button — any change is live.
 *
 * Usage:
 *   import { SettingsPopup } from "./components/settings-popup.js";
 *   const settings = new SettingsPopup();
 *   document.getElementById("btn-settings").addEventListener("click", () => {
 *     settings.open(currentSettingsValues);
 *   });
 */

"use strict";

import { PopupManager } from "../popup-manager.js";
import { icon } from "../icons.js";
import { wrapSecretField } from "./secret-field.js";
import { t, LOCALE_OPTIONS } from "../i18n.js";

export class SettingsPopup {
  /** @type {HTMLElement} */
  #el;

  // historyCount value at the time the popup was opened — used to revert on X/Escape.
  #openHistoryCount = 5;

  // Stable handler references so we can attach on open() and detach on close.
  // A one-shot document-level keydown was previously registered in the
  // constructor and never removed — harmless for a singleton popup, but it
  // fired app-wide for the entire process lifetime. Scoping it to the open
  // window also avoids racing other Escape handlers when the popup is hidden.
  #onKeyDown = (e) => {
    if (e.key === "Escape" && this.#el.isConnected) {
      e.stopPropagation();
      this.#revertHistoryCount();
      PopupManager.close();
    }
  };

  #onPopupClosed = () => {
    document.removeEventListener("keydown", this.#onKeyDown);
  };

  constructor() {
    // DOM is built lazily on first use (#ensureBuilt), not here. This singleton
    // is constructed at module load — before i18n.init() resolves the catalog —
    // so building now would bake in untranslated keys (t() would return the key
    // itself). open()/load()/refreshThemeList() all run after startup, when the
    // catalog is ready.
  }

  /** Build the popup DOM and wire its events once, on first use. */
  #ensureBuilt() {
    if (this.#el) return;
    this.#el = this.#build();
    this.#wrapSecretFields();
    this.#bindEvents();
  }

  /** Wrap secret inputs (proxy password) with the mask/reveal eye toggle. */
  #wrapSecretFields() {
    const pwd = this.#el.querySelector("#setting-proxy-password");
    if (!pwd) return;
    // wrapSecretField() moves `pwd` into a new wrapper, so capture its slot in
    // the DOM first, then drop the wrapper where the bare input had been.
    const parent = pwd.parentNode;
    const next = pwd.nextSibling;
    const wrapper = wrapSecretField(pwd);
    parent.insertBefore(wrapper, next);
  }

  /** Root DOM element (required by PopupManager) */
  get element() {
    return this.#el;
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  #build() {
    const el = document.createElement("div");
    el.className = "popup settings-popup";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", t("settings.title"));

    el.innerHTML = `
      <div class="popup-header">
        <span class="popup-title">${t("settings.title")}</span>
        <button class="popup-close" aria-label="${t("settings.closeAria")}" title="${t("settings.close")}">${icon("close", { size: 13 })}</button>
      </div>

      <div class="popup-body settings-popup-body">
        <!-- Left navigation list — one entry per settings panel -->
        <nav class="settings-nav" role="tablist" aria-label="${t("settings.navAria")}">
          <button class="settings-nav-item settings-nav-item--active" type="button" role="tab" aria-selected="true" data-panel="appearance">${t("settings.nav.appearance")}</button>
          <button class="settings-nav-item" type="button" role="tab" aria-selected="false" data-panel="request">${t("settings.nav.request")}</button>
          <button class="settings-nav-item" type="button" role="tab" aria-selected="false" data-panel="proxy">${t("settings.nav.proxy")}</button>
          <button class="settings-nav-item" type="button" role="tab" aria-selected="false" data-panel="certificates">${t("settings.nav.certificates")}</button>
          <button class="settings-nav-item" type="button" role="tab" aria-selected="false" data-panel="retries">${t("settings.nav.retries")}</button>
          <button class="settings-nav-item" type="button" role="tab" aria-selected="false" data-panel="history">${t("settings.nav.history")}</button>
        </nav>

        <!-- Right-hand stack of single-column panels; only the active one shows -->
        <div class="settings-panels">
          <!-- Appearance ──────────────────────────────────────────────── -->
          <section class="settings-panel" role="tabpanel" data-panel="appearance">
            <div class="settings-row">
              <label class="settings-label" for="setting-language">${t("settings.appearance.language")}</label>
              <select class="settings-select" id="setting-language">
                ${LOCALE_OPTIONS.map(
                  (o) =>
                    `<option value="${o.value}">${o.labelKey ? t(o.labelKey) : o.label}</option>`,
                ).join("")}
              </select>
            </div>

            <div class="settings-row">
              <label class="settings-label" for="setting-theme">${t("settings.appearance.theme")}</label>
              <select class="settings-select" id="setting-theme">
                <optgroup label="${t("settings.appearance.themeDark")}">
                  <option value="mocha">Mocha</option>
                  <option value="grey-dark">Grey</option>
                </optgroup>
                <optgroup label="${t("settings.appearance.themeLight")}">
                  <option value="latte">Latte</option>
                  <option value="grey-light">Grey</option>
                </optgroup>
              </select>
            </div>

            <div class="settings-row">
              <label class="settings-label" for="setting-font-size">${t("settings.appearance.fontSize")}</label>
              <select class="settings-select" id="setting-font-size">
                <option value="11">11 px</option>
                <option value="12">12 px</option>
                <option value="13">13 px</option>
                <option value="14">14 px</option>
                <option value="16">16 px</option>
                <option value="18">18 px</option>
              </select>
            </div>

            <div class="settings-row">
              <label class="settings-label" for="setting-font-family">${t("settings.appearance.fontFamily")}</label>
              <select class="settings-select" id="setting-font-family">
                <option value="inter">Inter</option>
                <option value="system">${t("settings.appearance.fontFamilySystem")}</option>
                <option value="sf-pro">SF Pro (macOS)</option>
                <option value="segoe">Segoe UI (Windows)</option>
                <option value="ubuntu">Ubuntu (Linux)</option>
                <option value="roboto">Roboto</option>
              </select>
            </div>

            <div class="settings-row settings-row--toggle" id="setting-remove-headers-row">
              <label class="settings-label" for="setting-remove-headers">${t("settings.appearance.hideHeaders")}</label>
              <input
                class="settings-toggle"
                id="setting-remove-headers"
                type="checkbox"
              />
            </div>

            <div class="settings-row settings-row--toggle" id="setting-method-icons-row" title="${t("settings.appearance.useMethodIconsTitle")}">
              <label class="settings-label" for="setting-method-icons">${t("settings.appearance.useMethodIcons")}</label>
              <input
                class="settings-toggle"
                id="setting-method-icons"
                type="checkbox"
              />
            </div>

            <div class="settings-row settings-row--toggle" title="${t("settings.appearance.showRecentsTitle")}">
              <label class="settings-label" for="setting-show-recents">${t("settings.appearance.showRecents")}</label>
              <input
                class="settings-toggle"
                id="setting-show-recents"
                type="checkbox"
              />
            </div>

            <div class="settings-row settings-row--toggle" title="${t("settings.appearance.showUrlPreviewTitle")}">
              <label class="settings-label" for="setting-show-url-preview">${t("settings.appearance.showUrlPreview")}</label>
              <input
                class="settings-toggle"
                id="setting-show-url-preview"
                type="checkbox"
              />
            </div>
          </section>

          <!-- Request ──────────────────────────────────────────────────── -->
          <section class="settings-panel" role="tabpanel" data-panel="request" hidden>
            <div class="settings-row">
              <label class="settings-label" for="setting-timeout">${t("settings.request.timeout")}</label>
              <input
                class="settings-input"
                id="setting-timeout"
                type="number"
                min="0"
                max="300000"
                step="1000"
              />
            </div>

            <div class="settings-row">
              <label class="settings-label" for="setting-picker-debounce">${t("settings.request.pickerDebounce")}</label>
              <input
                class="settings-input"
                id="setting-picker-debounce"
                type="number"
                min="0"
                max="2000"
                step="50"
                value="200"
              />
            </div>

            <div class="settings-row settings-row--toggle">
              <label class="settings-label" for="setting-follow-redirects">${t("settings.request.followRedirects")}</label>
              <input
                class="settings-toggle"
                id="setting-follow-redirects"
                type="checkbox"
              />
            </div>

            <div class="settings-row settings-row--toggle">
              <label class="settings-label" for="setting-dblclick-execute">${t("settings.request.dblclickExecute")}</label>
              <input
                class="settings-toggle"
                id="setting-dblclick-execute"
                type="checkbox"
              />
            </div>

            <div class="settings-row settings-row--toggle">
              <label class="settings-label" for="setting-verify-ssl">${t("settings.request.verifySsl")}</label>
              <input
                class="settings-toggle"
                id="setting-verify-ssl"
                type="checkbox"
              />
            </div>

            <div class="settings-row settings-row--toggle" title="${t("settings.request.streamNdjsonTitle")}">
              <label class="settings-label" for="setting-stream-ndjson">${t("settings.request.streamNdjson")}</label>
              <input
                class="settings-toggle"
                id="setting-stream-ndjson"
                type="checkbox"
              />
            </div>
          </section>

          <!-- Proxy ────────────────────────────────────────────────────── -->
          <section class="settings-panel" role="tabpanel" data-panel="proxy" hidden>
            <div class="settings-row settings-row--toggle">
              <label class="settings-label" for="setting-proxy-enabled">${t("settings.proxy.enable")}</label>
              <input class="settings-toggle" id="setting-proxy-enabled" type="checkbox" />
            </div>

            <div class="settings-row">
              <label class="settings-label" for="setting-proxy-url">${t("settings.proxy.url")}</label>
              <input
                class="settings-input"
                id="setting-proxy-url"
                type="text"
                placeholder="${t("settings.proxy.urlPlaceholder")}"
              />
            </div>
            <p class="settings-help">${t("settings.proxy.help")}</p>

            <div class="settings-row settings-row--toggle">
              <label class="settings-label" for="setting-proxy-auth-enabled">${t("settings.proxy.auth")}</label>
              <input class="settings-toggle" id="setting-proxy-auth-enabled" type="checkbox" />
            </div>

            <div class="settings-row settings-row--credentials">
              <div class="settings-field">
                <label class="settings-label" for="setting-proxy-username">${t("settings.proxy.username")}</label>
                <input
                  class="settings-input"
                  id="setting-proxy-username"
                  type="text"
                  autocomplete="off"
                />
              </div>
              <div class="settings-field">
                <label class="settings-label" for="setting-proxy-password">${t("settings.proxy.password")}</label>
                <input
                  class="settings-input"
                  id="setting-proxy-password"
                  type="text"
                  autocomplete="off"
                />
              </div>
            </div>

            <div class="settings-row settings-row--stacked">
              <label class="settings-label" for="setting-proxy-bypass">${t("settings.proxy.bypass")}</label>
              <textarea
                class="settings-input settings-textarea"
                id="setting-proxy-bypass"
                rows="3"
                placeholder="${t("settings.proxy.bypassPlaceholder")}"
              ></textarea>
            </div>
            <p class="settings-help">${t("settings.proxy.bypassHelp")}</p>
          </section>

          <!-- Certificates ─────────────────────────────────────────────── -->
          <section class="settings-panel" role="tabpanel" data-panel="certificates" hidden>
            <h3 class="settings-subhead">${t("settings.certificates.clientHeading")}</h3>
            <p class="settings-help">${t("settings.certificates.clientHelp")}</p>
            <div class="cert-list" id="client-cert-list"></div>
            <button class="btn cert-add" type="button" id="btn-add-client-cert">${t("settings.certificates.addClient")}</button>

            <h3 class="settings-subhead settings-subhead--spaced">${t("settings.certificates.caHeading")}</h3>
            <p class="settings-help">${t("settings.certificates.caHelp")}</p>
            <div class="cert-list" id="ca-cert-list"></div>
            <button class="btn cert-add" type="button" id="btn-add-ca-cert">${t("settings.certificates.addCa")}</button>

            <h3 class="settings-subhead settings-subhead--spaced">${t("settings.certificates.insecureHeading")}</h3>
            <div class="settings-row settings-row--stacked">
              <textarea
                class="settings-input settings-textarea"
                id="setting-tls-insecure-hosts"
                rows="3"
                placeholder="${t("settings.certificates.insecurePlaceholder")}"
              ></textarea>
            </div>
            <p class="settings-help">${t("settings.certificates.insecureHelp")}</p>
          </section>

          <!-- Retries ──────────────────────────────────────────────────── -->
          <section class="settings-panel" role="tabpanel" data-panel="retries" hidden>
            <div class="settings-row settings-row--toggle">
              <label class="settings-label" for="setting-retry-enabled">${t("settings.retries.enable")}</label>
              <input class="settings-toggle" id="setting-retry-enabled" type="checkbox" />
            </div>

            <div class="settings-row">
              <label class="settings-label" for="setting-retry-attempts">${t("settings.retries.maxAttempts")}</label>
              <input
                class="settings-input"
                id="setting-retry-attempts"
                type="number"
                min="1"
                max="10"
                step="1"
              />
            </div>

            <div class="settings-row">
              <label class="settings-label" for="setting-retry-backoff">${t("settings.retries.backoffBase")}</label>
              <input
                class="settings-input"
                id="setting-retry-backoff"
                type="number"
                min="0"
                max="60000"
                step="100"
              />
            </div>

            <div class="settings-row">
              <label class="settings-label" for="setting-retry-multiplier">${t("settings.retries.backoffMultiplier")}</label>
              <input
                class="settings-input"
                id="setting-retry-multiplier"
                type="number"
                min="1"
                max="10"
                step="0.5"
              />
            </div>

            <div class="settings-row">
              <label class="settings-label" for="setting-retry-max-delay">${t("settings.retries.maxDelay")}</label>
              <input
                class="settings-input"
                id="setting-retry-max-delay"
                type="number"
                min="0"
                max="600000"
                step="500"
              />
            </div>

            <div class="settings-row settings-row--toggle">
              <label class="settings-label" for="setting-retry-conn">${t("settings.retries.onConn")}</label>
              <input class="settings-toggle" id="setting-retry-conn" type="checkbox" />
            </div>

            <div class="settings-row settings-row--toggle">
              <label class="settings-label" for="setting-retry-timeout">${t("settings.retries.onTimeout")}</label>
              <input class="settings-toggle" id="setting-retry-timeout" type="checkbox" />
            </div>

            <div class="settings-row">
              <label class="settings-label" for="setting-retry-status">${t("settings.retries.onStatus")}</label>
              <input
                class="settings-input"
                id="setting-retry-status"
                type="text"
                placeholder="${t("settings.retries.statusPlaceholder")}"
              />
            </div>
          </section>

          <!-- History ──────────────────────────────────────────────────── -->
          <section class="settings-panel" role="tabpanel" data-panel="history" hidden>
            <div class="settings-row">
              <label class="settings-label" for="setting-history-count">${t("settings.history.timelineEntries")}</label>
              <select class="settings-select" id="setting-history-count">
                <option value="1">1</option>
                <option value="2">2</option>
                <option value="3">3</option>
                <option value="4">4</option>
                <option value="5">5</option>
                <option value="6">6</option>
                <option value="7">7</option>
                <option value="8">8</option>
                <option value="9">9</option>
                <option value="10">10</option>
              </select>
            </div>
          </section>
        </div>
      </div>

      <div class="popup-footer">
        <button class="btn popup-btn btn--primary js-close">${t("settings.close")}</button>
      </div>
    `;

    return el;
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  #bindEvents() {
    // Left-nav: clicking an entry reveals its panel and hides the rest.
    this.#el.querySelectorAll(".settings-nav-item").forEach((item) => {
      item.addEventListener("click", () => this.#showPanel(item.dataset.panel));
    });

    // Auto-save on every user interaction — no explicit Save needed.
    // Use "input" for text/number inputs (fires on every keystroke) and
    // "change" for selects and checkboxes (which have no meaningful "input").
    // historyCount is intentionally excluded: it is only committed when the
    // user clicks Close (not X or Escape), so it needs deferred handling.
    // Theme select — intercept the special "Theme Editor…" sentinel value.
    const themeSelect = this.#el.querySelector("#setting-theme");
    let _prevTheme = themeSelect.value;
    themeSelect.addEventListener("mousedown", () => {
      _prevTheme = themeSelect.value;
    });
    themeSelect.addEventListener("change", () => {
      if (themeSelect.value === "__theme-editor__") {
        themeSelect.value = _prevTheme;
        window.hippo.ui.openThemeEditor?.();
        return;
      }
      _prevTheme = themeSelect.value;
      this.#emitChange();
    });

    this.#el.querySelectorAll("select").forEach((control) => {
      if (
        control.id === "setting-history-count" ||
        control.id === "setting-theme"
      )
        return;
      control.addEventListener("change", () => this.#emitChange());
    });
    this.#el.querySelectorAll("input[type='checkbox']").forEach((control) => {
      control.addEventListener("change", () => this.#emitChange());
    });
    this.#el
      .querySelectorAll(
        "input[type='text'], input[type='number'], input[type='url'], textarea",
      )
      .forEach((control) => {
        control.addEventListener("input", () => this.#emitChange());
      });

    // Update the "Remove headers" tooltip whenever the checkbox is toggled
    const removeHeadersCb = this.#el.querySelector("#setting-remove-headers");
    removeHeadersCb.addEventListener("change", () =>
      this.#updateRemoveHeadersTitle(),
    );

    // Enable/disable the proxy credential fields with the auth toggle.
    this.#el
      .querySelector("#setting-proxy-auth-enabled")
      .addEventListener("change", () => this.#syncProxyAuthState());

    // Certificates panel — add a blank client-cert row (filled in by the user),
    // or pick a CA file and append a row for it. Row-level controls wire their
    // own listeners as they are built (see #buildClientCertRow / #buildCaRow).
    this.#el
      .querySelector("#btn-add-client-cert")
      .addEventListener("click", () => {
        this.#el
          .querySelector("#client-cert-list")
          .appendChild(this.#buildClientCertRow({}));
      });
    this.#el
      .querySelector("#btn-add-ca-cert")
      .addEventListener("click", () => this.#pickCaFile());

    // Escape handling lives in #onKeyDown, attached on open() and detached
    // when PopupManager dispatches "hippo:popup-closed". See class fields above.

    // X button (top-right ✕) — revert historyCount to the value at open time,
    // then close without committing the pending history count.
    this.#el.querySelector(".popup-close").addEventListener("click", () => {
      this.#revertHistoryCount();
      PopupManager.close();
    });

    // Close button (footer) — commit historyCount and trigger history trimming.
    this.#el.querySelector(".js-close").addEventListener("click", () => {
      const historyCount = this.#readHistoryCount();
      this.#emitChange(historyCount);
      window.dispatchEvent(
        new CustomEvent("hippo:history-trim", {
          detail: { historyCount },
          bubbles: true,
        }),
      );
      PopupManager.close();
    });
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  /**
   * Reveal the panel identified by `name` and mark its nav entry active,
   * hiding all other panels. Falls back gracefully if `name` is unknown.
   * @param {string} name
   */
  #showPanel(name) {
    this.#el.querySelectorAll(".settings-nav-item").forEach((item) => {
      const active = item.dataset.panel === name;
      item.classList.toggle("settings-nav-item--active", active);
      item.setAttribute("aria-selected", String(active));
    });
    this.#el.querySelectorAll(".settings-panel").forEach((panel) => {
      const active = panel.dataset.panel === name;
      panel.hidden = !active;
    });
  }

  /**
   * Sync the tooltip on the "Remove headers" row to reflect the current state.
   * Checked → explains where the icon will be after checking the box.
   * Unchecked   → explains where the settings icon moves when headers are hidden.
   */
  #updateRemoveHeadersTitle() {
    const cb = this.#el.querySelector("#setting-remove-headers");
    const row = this.#el.querySelector("#setting-remove-headers-row");
    if (!cb || !row) return;
    row.title = cb.checked
      ? t("settings.appearance.removeHeadersOnTitle")
      : t("settings.appearance.removeHeadersOffTitle");
  }

  /**
   * Read current control values and dispatch "hippo:settings-changed".
   * Pass an explicit historyCount to include it (only done from the Close button).
   * @param {number} [historyCount]
   */
  #emitChange(historyCount) {
    const detail = this.#readValues();
    if (historyCount !== undefined) detail.historyCount = historyCount;
    window.dispatchEvent(
      new CustomEvent("hippo:settings-changed", {
        detail,
        bubbles: true,
      }),
    );
  }

  /** Read the historyCount select value as a number. */
  #readHistoryCount() {
    return (
      parseInt(this.#el.querySelector("#setting-history-count").value, 10) || 0
    );
  }

  /** Reset the historyCount control to the value it had when the popup was opened. */
  #revertHistoryCount() {
    const ctrl = this.#el.querySelector("#setting-history-count");
    if (ctrl) ctrl.value = String(this.#openHistoryCount);
  }

  /** Collect all setting values into a plain object (historyCount excluded — deferred). */
  #readValues() {
    return {
      locale: this.#el.querySelector("#setting-language").value,
      theme: this.#el.querySelector("#setting-theme").value,
      fontSize:
        parseInt(this.#el.querySelector("#setting-font-size").value, 10) || 13,
      fontFamily: this.#el.querySelector("#setting-font-family").value,
      removeHeaders: this.#el.querySelector("#setting-remove-headers").checked,
      methodIcons: this.#el.querySelector("#setting-method-icons").checked,
      showRecents: this.#el.querySelector("#setting-show-recents").checked,
      showUrlPreview: this.#el.querySelector("#setting-show-url-preview")
        .checked,
      timeout:
        parseInt(this.#el.querySelector("#setting-timeout").value, 10) || 0,
      followRedirects: this.#el.querySelector("#setting-follow-redirects")
        .checked,
      doubleClickExecute: this.#el.querySelector("#setting-dblclick-execute")
        .checked,
      verifySsl: this.#el.querySelector("#setting-verify-ssl").checked,
      streamNdjson: this.#el.querySelector("#setting-stream-ndjson").checked,
      pickerDebounceMs:
        parseInt(
          this.#el.querySelector("#setting-picker-debounce").value,
          10,
        ) || 200,
      proxyEnabled: this.#el.querySelector("#setting-proxy-enabled").checked,
      proxyUrl: this.#el.querySelector("#setting-proxy-url").value.trim(),
      proxyAuthEnabled: this.#el.querySelector("#setting-proxy-auth-enabled")
        .checked,
      proxyUsername: this.#el.querySelector("#setting-proxy-username").value,
      proxyPassword: this.#el.querySelector("#setting-proxy-password").value,
      proxyBypass: this.#el.querySelector("#setting-proxy-bypass").value.trim(),
      retryEnabled: this.#el.querySelector("#setting-retry-enabled").checked,
      retryMaxAttempts:
        parseInt(this.#el.querySelector("#setting-retry-attempts").value, 10) ||
        3,
      retryBackoffMs:
        parseInt(this.#el.querySelector("#setting-retry-backoff").value, 10) ||
        0,
      retryBackoffMultiplier:
        parseFloat(this.#el.querySelector("#setting-retry-multiplier").value) ||
        2,
      retryMaxDelayMs:
        parseInt(
          this.#el.querySelector("#setting-retry-max-delay").value,
          10,
        ) || 0,
      retryOnConnectionError: this.#el.querySelector("#setting-retry-conn")
        .checked,
      retryOnTimeout: this.#el.querySelector("#setting-retry-timeout").checked,
      retryStatusCodes: this.#el
        .querySelector("#setting-retry-status")
        .value.trim(),
      clientCerts: this.#serializeClientCerts(),
      caCerts: this.#serializeCaCerts(),
      tlsInsecureHosts: this.#el
        .querySelector("#setting-tls-insecure-hosts")
        .value.trim(),
    };
  }

  // ── Certificates panel ───────────────────────────────────────────────────

  /**
   * Build one client-certificate row. The host/passphrase are editable inputs;
   * the cert/key/PFX files are chosen through the native picker and their paths
   * stored on the picker buttons' `dataset.path` (only the basename is shown).
   * Every control reports edits via #emitChange so the panel auto-saves like the
   * rest of settings.
   * @param {object} entry  a settings.clientCerts entry (or {} for a new row)
   */
  #buildClientCertRow(entry = {}) {
    const row = document.createElement("div");
    row.className = "cert-row";
    row.dataset.id = entry.id || crypto.randomUUID();
    const format = entry.format === "pfx" ? "pfx" : "pem";
    row.innerHTML = `
      <div class="cert-row-grid">
        <div class="cert-field cert-field--host">
          <label class="settings-label">${t("settings.certificates.host")}</label>
          <input class="settings-input cert-host" type="text" autocomplete="off"
            placeholder="${t("settings.certificates.hostPlaceholder")}" />
        </div>
        <div class="cert-field">
          <label class="settings-label">${t("settings.certificates.format")}</label>
          <select class="settings-select cert-format">
            <option value="pem">${t("settings.certificates.formatPem")}</option>
            <option value="pfx">${t("settings.certificates.formatPfx")}</option>
          </select>
        </div>
      </div>
      <div class="cert-files cert-files--pem">
        ${this.#filePickerHtml("cert", "pem", t("settings.certificates.certFile"))}
        ${this.#filePickerHtml("key", "key", t("settings.certificates.keyFile"))}
      </div>
      <div class="cert-files cert-files--pfx">
        ${this.#filePickerHtml("pfx", "pfx", t("settings.certificates.pfxFile"))}
      </div>
      <div class="cert-row-foot">
        <div class="cert-field cert-field--pass">
          <label class="settings-label">${t("settings.certificates.passphrase")}</label>
          <input class="settings-input cert-passphrase" type="text" autocomplete="off" />
        </div>
        <button class="btn cert-row-remove" type="button">${t("settings.certificates.remove")}</button>
      </div>
    `;

    row.querySelector(".cert-host").value = entry.host || "";
    row.querySelector(".cert-format").value = format;
    row.querySelector(".cert-passphrase").value = entry.passphrase || "";
    this.#setPickerPath(
      row.querySelector('[data-target="cert"]'),
      entry.certPath,
    );
    this.#setPickerPath(
      row.querySelector('[data-target="key"]'),
      entry.keyPath,
    );
    this.#setPickerPath(
      row.querySelector('[data-target="pfx"]'),
      entry.pfxPath,
    );

    // Mask/reveal the passphrase like other secret fields. wrapSecretField()
    // moves the input into a new wrapper, so capture its field first, then drop
    // the wrapper back into that field.
    const pass = row.querySelector(".cert-passphrase");
    const passField = pass.closest(".cert-field--pass");
    passField.appendChild(wrapSecretField(pass));

    // Wire edits.
    row
      .querySelector(".cert-host")
      .addEventListener("input", () => this.#emitChange());
    pass.addEventListener("input", () => this.#emitChange());
    const formatSel = row.querySelector(".cert-format");
    formatSel.addEventListener("change", () => {
      this.#syncCertFormat(row);
      this.#emitChange();
    });
    row.querySelectorAll(".cert-file-btn").forEach((btn) => {
      btn.addEventListener("click", () => this.#pickCertFile(btn));
    });
    row.querySelector(".cert-row-remove").addEventListener("click", () => {
      row.remove();
      this.#emitChange();
    });

    this.#syncCertFormat(row);
    return row;
  }

  /** Markup for one file-picker button (label + chosen-file name span). */
  #filePickerHtml(target, kind, label) {
    return `
      <div class="cert-file">
        <button class="btn cert-file-btn" type="button" data-target="${target}" data-kind="${kind}">${label}</button>
        <span class="cert-file-name">${t("settings.certificates.noFile")}</span>
      </div>`;
  }

  /** Reflect a stored path onto a picker button (path on dataset, basename shown). */
  #setPickerPath(btn, path) {
    if (!btn) return;
    const nameEl = btn.parentNode.querySelector(".cert-file-name");
    if (path) {
      btn.dataset.path = path;
      nameEl.textContent = path.split(/[\\/]/).pop();
      nameEl.title = path;
      nameEl.classList.add("cert-file-name--set");
    } else {
      delete btn.dataset.path;
      nameEl.textContent = t("settings.certificates.noFile");
      nameEl.removeAttribute("title");
      nameEl.classList.remove("cert-file-name--set");
    }
  }

  /** Open the native picker for a client-cert file button, then record its path. */
  async #pickCertFile(btn) {
    const path = await window.hippo?.dialog?.pickFile?.(btn.dataset.kind);
    if (!path) return;
    this.#setPickerPath(btn, path);
    this.#emitChange();
  }

  /** Open the native picker for a CA file and append a row when one is chosen. */
  async #pickCaFile() {
    const path = await window.hippo?.dialog?.pickFile?.("ca");
    if (!path) return;
    this.#el.querySelector("#ca-cert-list").appendChild(this.#buildCaRow(path));
    this.#emitChange();
  }

  /** Build one CA-file row (path display + remove). */
  #buildCaRow(path) {
    const row = document.createElement("div");
    row.className = "ca-row";
    row.dataset.path = path;
    row.innerHTML = `
      <span class="cert-file-name cert-file-name--set"></span>
      <button class="btn cert-row-remove" type="button">${t("settings.certificates.remove")}</button>
    `;
    const nameEl = row.querySelector(".cert-file-name");
    nameEl.textContent = path.split(/[\\/]/).pop();
    nameEl.title = path;
    row.querySelector(".cert-row-remove").addEventListener("click", () => {
      row.remove();
      this.#emitChange();
    });
    return row;
  }

  /** Show the PEM or PFX file inputs for a row based on its format select. */
  #syncCertFormat(row) {
    const pfx = row.querySelector(".cert-format").value === "pfx";
    row.querySelector(".cert-files--pem").hidden = pfx;
    row.querySelector(".cert-files--pfx").hidden = !pfx;
  }

  /** Serialize the client-cert rows, dropping rows the user left entirely blank. */
  #serializeClientCerts() {
    const list = this.#el.querySelector("#client-cert-list");
    if (!list) return [];
    return [...list.querySelectorAll(".cert-row")]
      .map((row) => ({
        id: row.dataset.id,
        host: row.querySelector(".cert-host").value.trim(),
        format: row.querySelector(".cert-format").value,
        certPath: row.querySelector('[data-target="cert"]').dataset.path || "",
        keyPath: row.querySelector('[data-target="key"]').dataset.path || "",
        pfxPath: row.querySelector('[data-target="pfx"]').dataset.path || "",
        passphrase: row.querySelector(".cert-passphrase").value,
      }))
      .filter((e) => e.host || e.certPath || e.pfxPath || e.passphrase);
  }

  /** Serialize the CA-file rows to a path list. */
  #serializeCaCerts() {
    const list = this.#el.querySelector("#ca-cert-list");
    if (!list) return [];
    return [...list.querySelectorAll(".ca-row")]
      .map((row) => row.dataset.path || "")
      .filter(Boolean);
  }

  /** Rebuild the client-cert + CA rows from a saved settings object. */
  #renderCertLists(settings) {
    const clientList = this.#el.querySelector("#client-cert-list");
    clientList.replaceChildren();
    for (const entry of settings.clientCerts || []) {
      clientList.appendChild(this.#buildClientCertRow(entry));
    }
    const caList = this.#el.querySelector("#ca-cert-list");
    caList.replaceChildren();
    for (const path of settings.caCerts || []) {
      caList.appendChild(this.#buildCaRow(path));
    }
  }

  // ── PopupManager protocol ──────────────────────────────────────────────────

  /** Called by PopupManager when the user clicks the overlay mask — same as X: revert. */
  onMaskClick() {
    this.#revertHistoryCount();
    PopupManager.close();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Populate the controls from a stored settings object, then open the popup.
   * Missing keys fall back to their HTML default values.
   * @param {object} [settings]
   */
  open(settings = {}) {
    this.#ensureBuilt();
    this.#openHistoryCount = settings.historyCount ?? 5;
    this.refreshThemeList(settings.customThemes ?? []);
    this.#applyValues(settings);
    this.#showPanel("appearance");
    PopupManager.open(this);
    // Scope the Escape handler to the open lifecycle. PopupManager.close()
    // dispatches "hippo:popup-closed" via _hideMask(), which fires for every
    // close path (X button, Close button, Escape, and mask click), so this
    // one once-listener covers them all.
    document.addEventListener("keydown", this.#onKeyDown);
    window.addEventListener("hippo:popup-closed", this.#onPopupClosed, {
      once: true,
    });
  }

  /**
   * Populate all controls from a settings object without opening the popup.
   * Call this at startup to initialise the controls from persisted values.
   * @param {object} settings
   */
  load(settings = {}) {
    this.#ensureBuilt();
    if (settings.customThemes !== undefined)
      this.refreshThemeList(settings.customThemes);
    this.#applyValues(settings);
  }

  refreshThemeList(customThemes = []) {
    this.#ensureBuilt();
    const sel = this.#el.querySelector("#setting-theme");
    const saved = sel.value;
    sel.querySelector("optgroup[data-custom]")?.remove();
    if (!customThemes.length) {
      sel.value = saved;
      return;
    }
    const group = document.createElement("optgroup");
    group.label = t("settings.appearance.themeCustom");
    group.dataset.custom = "";
    for (const theme of customThemes) {
      const opt = document.createElement("option");
      opt.value = theme.id;
      opt.textContent = theme.name;
      group.appendChild(opt);
    }
    // Keep separator + "Theme Editor…" pinned at the bottom.
    const separator = sel.querySelector("option[disabled]");
    sel.insertBefore(group, separator ?? null);
    sel.value = saved;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /** Write a settings object back into the form controls. */
  #applyValues(settings) {
    if (settings.locale !== undefined) {
      this.#el.querySelector("#setting-language").value = settings.locale;
    }
    if (settings.theme !== undefined) {
      this.#el.querySelector("#setting-theme").value = settings.theme;
    }
    if (settings.fontSize !== undefined) {
      this.#el.querySelector("#setting-font-size").value = String(
        settings.fontSize,
      );
    }
    if (settings.fontFamily !== undefined) {
      this.#el.querySelector("#setting-font-family").value =
        settings.fontFamily;
    }
    if (settings.removeHeaders !== undefined) {
      this.#el.querySelector("#setting-remove-headers").checked =
        settings.removeHeaders;
    }
    // Always refresh the tooltip so it matches the current checkbox state
    this.#updateRemoveHeadersTitle();
    if (settings.methodIcons !== undefined) {
      this.#el.querySelector("#setting-method-icons").checked =
        settings.methodIcons;
    }
    if (settings.showRecents !== undefined) {
      this.#el.querySelector("#setting-show-recents").checked =
        settings.showRecents;
    }
    if (settings.showUrlPreview !== undefined) {
      this.#el.querySelector("#setting-show-url-preview").checked =
        settings.showUrlPreview;
    }
    if (settings.timeout !== undefined) {
      this.#el.querySelector("#setting-timeout").value = String(
        settings.timeout,
      );
    }
    if (settings.followRedirects !== undefined) {
      this.#el.querySelector("#setting-follow-redirects").checked =
        settings.followRedirects;
    }
    if (settings.doubleClickExecute !== undefined) {
      this.#el.querySelector("#setting-dblclick-execute").checked =
        settings.doubleClickExecute;
    }
    if (settings.verifySsl !== undefined) {
      this.#el.querySelector("#setting-verify-ssl").checked =
        settings.verifySsl;
    }
    if (settings.streamNdjson !== undefined) {
      this.#el.querySelector("#setting-stream-ndjson").checked =
        settings.streamNdjson;
    }
    if (settings.pickerDebounceMs !== undefined) {
      this.#el.querySelector("#setting-picker-debounce").value = String(
        settings.pickerDebounceMs,
      );
    }
    if (settings.proxyEnabled !== undefined) {
      this.#el.querySelector("#setting-proxy-enabled").checked =
        settings.proxyEnabled;
    }
    if (settings.proxyUrl !== undefined) {
      this.#el.querySelector("#setting-proxy-url").value = settings.proxyUrl;
    }
    if (settings.proxyAuthEnabled !== undefined) {
      this.#el.querySelector("#setting-proxy-auth-enabled").checked =
        settings.proxyAuthEnabled;
    }
    if (settings.proxyUsername !== undefined) {
      this.#el.querySelector("#setting-proxy-username").value =
        settings.proxyUsername;
    }
    if (settings.proxyPassword !== undefined) {
      this.#el.querySelector("#setting-proxy-password").value =
        settings.proxyPassword;
    }
    if (settings.proxyBypass !== undefined) {
      this.#el.querySelector("#setting-proxy-bypass").value =
        settings.proxyBypass;
    }
    if (settings.retryEnabled !== undefined) {
      this.#el.querySelector("#setting-retry-enabled").checked =
        settings.retryEnabled;
    }
    if (settings.retryMaxAttempts !== undefined) {
      this.#el.querySelector("#setting-retry-attempts").value = String(
        settings.retryMaxAttempts,
      );
    }
    if (settings.retryBackoffMs !== undefined) {
      this.#el.querySelector("#setting-retry-backoff").value = String(
        settings.retryBackoffMs,
      );
    }
    if (settings.retryBackoffMultiplier !== undefined) {
      this.#el.querySelector("#setting-retry-multiplier").value = String(
        settings.retryBackoffMultiplier,
      );
    }
    if (settings.retryMaxDelayMs !== undefined) {
      this.#el.querySelector("#setting-retry-max-delay").value = String(
        settings.retryMaxDelayMs,
      );
    }
    if (settings.retryOnConnectionError !== undefined) {
      this.#el.querySelector("#setting-retry-conn").checked =
        settings.retryOnConnectionError;
    }
    if (settings.retryOnTimeout !== undefined) {
      this.#el.querySelector("#setting-retry-timeout").checked =
        settings.retryOnTimeout;
    }
    if (settings.retryStatusCodes !== undefined) {
      this.#el.querySelector("#setting-retry-status").value =
        settings.retryStatusCodes;
    }
    if (settings.historyCount !== undefined) {
      this.#el.querySelector("#setting-history-count").value = String(
        settings.historyCount,
      );
    }
    if (settings.tlsInsecureHosts !== undefined) {
      this.#el.querySelector("#setting-tls-insecure-hosts").value =
        settings.tlsInsecureHosts;
    }
    // Rebuild the cert lists whenever either is supplied (imperative DOM can't be
    // patched key-by-key, so a full rebuild keeps the rows in sync with storage).
    if (settings.clientCerts !== undefined || settings.caCerts !== undefined) {
      this.#renderCertLists(settings);
    }
    this.#syncProxyAuthState();
  }

  /**
   * Reflect the "Proxy authentication" toggle onto its credential fields: when
   * auth is off the username/password inputs are disabled and dimmed, so it is
   * clear no credentials are sent (the values are kept, just not editable/used).
   */
  #syncProxyAuthState() {
    const on = this.#el.querySelector("#setting-proxy-auth-enabled").checked;
    const row = this.#el.querySelector(".settings-row--credentials");
    row.classList.toggle("settings-row--disabled", !on);
    row.querySelectorAll("input").forEach((input) => (input.disabled = !on));
  }
}
