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
import { LAYOUT_ICONS } from "./layout-icons.js";
import { t, LOCALE_OPTIONS } from "../i18n.js";
import { reportCliResult } from "../cli-command.js";
import { debounce } from "../utils/debounce.js";

// Trailing delay before a typed field commits. Text/number/textarea controls
// fire on every keystroke; without this a 30-char proxy URL would trigger 30
// full manifest writes + whole-app re-applies. Discrete controls (checkboxes,
// selects, the layout picker) still emit immediately so they apply live.
const SETTINGS_SAVE_DEBOUNCE_MS = 250;

export class SettingsPopup {
  /** @type {HTMLElement} */
  #el;

  // historyCount value at the time the popup was opened — used to revert on X/Escape.
  #openHistoryCount = 5;

  // Snapshot of #readValues() at open() — the dirty baseline. Closing with no
  // real edit skips both the save and the history sweep. #lastEmittedJson dedups
  // redundant emits (e.g. a field typed back to its previous value).
  #baselineJson = "";
  #lastEmittedJson = "";

  // Debounced emit for the per-keystroke text/number/textarea controls. Coalesces
  // a burst of keystrokes into a single hippo:settings-changed (one save + apply).
  #emitDebounced = debounce(
    () => this.#emitChange(),
    SETTINGS_SAVE_DEBOUNCE_MS,
  );

  // Live secret-storage backend state ({ mode, locked, available, hasPassword }),
  // fetched from main on open / when the Security panel is shown.
  #securityState = null;

  // Live CLI-launcher state ({ available, installed, ... }), fetched from main on
  // open / when the Command Line panel is shown. Cached so the action button's
  // click handler knows whether to install or remove without re-probing first.
  #cliStatus = null;

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
    this.#unwireUpdaterStatus();
    // Flush a still-pending keystroke on any close path that didn't already do so
    // (X / Escape / mask click) — historically every keystroke persisted, so the
    // last one must survive the close. The footer Close cancels first, so nothing
    // is pending here for that path.
    if (this.#emitDebounced.pending()) {
      this.#emitDebounced.cancel();
      this.#emitChange();
    }
  };

  // Auto-update status-line handlers (Feature 36). Stable references so they can
  // be attached on open() and detached on close — the inline status only tracks
  // updater events while the About panel is reachable; the app-wide toasts in
  // app.js are the always-on surface.
  #onUpdaterChecking = () => this.#setUpdateStatus(t("updater.checking"));
  #onUpdaterAvailable = (e) =>
    this.#setUpdateStatus(
      t("updater.downloadingMsg", { version: e.detail?.version || "" }),
    );
  #onUpdaterNotAvailable = (e) =>
    this.#setUpdateStatus(
      e.detail?.reason === "store-build"
        ? t("updater.storeManaged")
        : e.detail?.reason === "dev-build"
          ? t("updater.devBuild")
          : t("updater.upToDate"),
    );
  #onUpdaterDownloaded = () => this.#setUpdateStatus(t("updater.ready"));
  #onUpdaterError = () => this.#setUpdateStatus(t("updater.failed"));

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
          <button class="settings-nav-item" type="button" role="tab" aria-selected="false" data-panel="security">${t("settings.nav.security")}</button>
          <button class="settings-nav-item" type="button" role="tab" aria-selected="false" data-panel="retries">${t("settings.nav.retries")}</button>
          <button class="settings-nav-item" type="button" role="tab" aria-selected="false" data-panel="cli">${t("settings.nav.cli")}</button>
          <button class="settings-nav-item" type="button" role="tab" aria-selected="false" data-panel="about">${t("settings.nav.about")}</button>
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
                <option disabled>──────────</option>
                <option value="__theme-editor__">${t("settings.appearance.themeEditor")}</option>
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

            <div class="settings-row">
              <span class="settings-label" id="setting-layout-label">${t("settings.appearance.layout")}</span>
              <div class="settings-layout-picker" role="radiogroup" aria-labelledby="setting-layout-label">
                ${[1, 2, 3, 4]
                  .map(
                    (n) => `
                <button
                  type="button"
                  class="settings-layout-option"
                  role="radio"
                  aria-checked="false"
                  tabindex="-1"
                  data-layout="${n}"
                  title="${t("layout.option." + n)}"
                  aria-label="${t("layout.option." + n)}"
                >${LAYOUT_ICONS[n]}</button>`,
                  )
                  .join("")}
              </div>
            </div>

            <div class="settings-row settings-row--toggle" id="setting-remove-headers-row">
              <label class="settings-label" for="setting-remove-headers">${t("settings.appearance.showHeaders")}</label>
              <input
                class="settings-toggle"
                id="setting-remove-headers"
                type="checkbox"
                checked
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
              <label class="settings-label" for="setting-history-count">${t("settings.request.timelineEntries")}</label>
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

            <div class="settings-row settings-row--toggle" title="${t("settings.request.showCapturesTabTitle")}">
              <label class="settings-label" for="setting-show-captures-tab">${t("settings.request.showCapturesTab")}</label>
              <input
                class="settings-toggle"
                id="setting-show-captures-tab"
                type="checkbox"
              />
            </div>

            <div class="settings-row settings-row--toggle" title="${t("settings.request.showScriptsTabTitle")}">
              <label class="settings-label" for="setting-show-scripts-tab">${t("settings.request.showScriptsTab")}</label>
              <input
                class="settings-toggle"
                id="setting-show-scripts-tab"
                type="checkbox"
              />
            </div>

            <div class="settings-row settings-row--toggle" title="${t("settings.request.showTestsTabTitle")}">
              <label class="settings-label" for="setting-show-tests-tab">${t("settings.request.showTestsTab")}</label>
              <input
                class="settings-toggle"
                id="setting-show-tests-tab"
                type="checkbox"
              />
            </div>

            <div class="settings-row settings-row--toggle">
              <label class="settings-label" for="setting-show-notes-tab">${t("settings.request.showNotesTab")}</label>
              <input
                class="settings-toggle"
                id="setting-show-notes-tab"
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

          <!-- Security ─────────────────────────────────────────────────── -->
          <section class="settings-panel" role="tabpanel" data-panel="security" hidden>
            <h3 class="settings-subhead">${t("settings.security.heading")}</h3>
            <p class="settings-help">${t("settings.security.help")}</p>

            <!-- Locked master-password session: enter the password to unlock. -->
            <div class="security-locked-row" hidden>
              <p class="settings-help">${t("settings.security.lockedNote")}</p>
              <div class="settings-row security-inline-field">
                <input
                  class="settings-input js-security-unlock-pw"
                  type="password"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="${t("settings.security.password")}"
                />
                <button class="btn cert-add js-security-unlock" type="button">${t("settings.security.unlock")}</button>
              </div>
            </div>

            <div class="security-mode-group" role="radiogroup" aria-label="${t("settings.security.modeAria")}">
              ${this.#securityModeOption("app-key", t("settings.security.mode.appKey"), t("settings.security.mode.appKeyDesc"))}
              ${this.#securityModeOption("os-keychain", t("settings.security.mode.osKeychain"), t("settings.security.mode.osKeychainDesc"))}
              ${this.#securityModeOption(
                "master-password",
                t("settings.security.mode.masterPassword"),
                t("settings.security.mode.masterPasswordDesc"),
                `
                <div class="security-master-fields" hidden>
                  <div class="security-inline-field">
                    <input class="settings-input js-master-pw" type="password" autocomplete="new-password" spellcheck="false" placeholder="${t("settings.security.password")}" />
                  </div>
                  <div class="security-inline-field">
                    <input class="settings-input js-master-pw-confirm" type="password" autocomplete="new-password" spellcheck="false" placeholder="${t("settings.security.confirmPassword")}" />
                  </div>
                  <p class="settings-help">${t("settings.security.setPasswordWarn")}</p>
                  <button class="btn cert-add js-master-apply" type="button">${t("settings.security.setPasswordSubmit")}</button>
                </div>`,
              )}
            </div>
            <div class="security-status" role="status" aria-live="polite"></div>
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

            <div class="settings-row settings-row--toggle">
              <label class="settings-label" for="setting-retry-nonidempotent">${t("settings.retries.nonIdempotent")}</label>
              <input class="settings-toggle" id="setting-retry-nonidempotent" type="checkbox" />
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

          <!-- Command Line ───────────────────────────────────────────────── -->
          <!-- Install / remove the hippo shell command. The desc + button label
               + status line are filled at open() from window.hippo.cli.status();
               the button installs or removes depending on the current state. -->
          <section class="settings-panel" role="tabpanel" data-panel="cli" hidden>
            <p class="settings-help" id="setting-cli-desc">${t("settings.cli.desc")}</p>
            <div class="settings-row">
              <button class="btn popup-btn" id="setting-cli-action" type="button"></button>
              <span class="settings-label" id="setting-cli-status" role="status" aria-live="polite"></span>
            </div>
          </section>

          <!-- About ──────────────────────────────────────────────────────── -->
          <!-- Version + on-demand update check (Feature 36). The version line is
               filled at open() from window.hippo.app.info(); the status line
               reflects hippo:updater-* events while the popup is open. -->
          <section class="settings-panel" role="tabpanel" data-panel="about" hidden>
            <div class="settings-row">
              <span class="settings-label" id="setting-about-version"></span>
            </div>
            <div class="settings-row settings-row--toggle">
              <label class="settings-label" for="setting-auto-update">${t("settings.about.autoCheck")}</label>
              <input class="settings-toggle" id="setting-auto-update" type="checkbox" />
            </div>
            <div class="settings-row">
              <button class="btn popup-btn" id="setting-check-updates" type="button">${t("settings.about.checkButton")}</button>
              <span class="settings-label" id="setting-about-status" role="status" aria-live="polite"></span>
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

    // About panel: on-demand update check (Feature 36). The updater pushes its
    // result back via hippo:updater-* events, which the status line reflects.
    this.#el
      .querySelector("#setting-check-updates")
      ?.addEventListener("click", () => {
        this.#setUpdateStatus(t("updater.checking"));
        window.hippo?.updater?.check?.();
      });

    // Command Line panel: install / remove the `hippo` shell command. The button
    // toggles between Install and Remove based on the live state cached by
    // #loadCliStatus(); after either action we re-probe to refresh the panel.
    this.#el
      .querySelector("#setting-cli-action")
      ?.addEventListener("click", () => this.#onCliAction());

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

    // Layout picker — a radiogroup of icon buttons. Clicking (or arrowing onto)
    // an option marks it and emits the change, so the layout applies live like
    // every other setting (app.js's settings handler calls applyLayout).
    const layoutGroup = this.#el.querySelector(".settings-layout-picker");
    const layoutOpts = [
      ...layoutGroup.querySelectorAll(".settings-layout-option"),
    ];
    layoutOpts.forEach((btn) => {
      btn.addEventListener("click", () => {
        this.#selectLayout(parseInt(btn.dataset.layout, 10));
        this.#emitChange();
      });
    });
    // Roving-tabindex keyboard model: arrows / Home / End move and select.
    layoutGroup.addEventListener("keydown", (e) => {
      const cur = layoutOpts.indexOf(
        e.target.closest(".settings-layout-option"),
      );
      let next = -1;
      if (e.key === "ArrowRight" || e.key === "ArrowDown")
        next = Math.min(layoutOpts.length - 1, cur + 1);
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp")
        next = Math.max(0, cur - 1);
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = layoutOpts.length - 1;
      if (next < 0 || next === cur) return;
      e.preventDefault();
      this.#selectLayout(parseInt(layoutOpts[next].dataset.layout, 10), {
        focus: true,
      });
      this.#emitChange();
    });

    this.#el.querySelectorAll("input[type='checkbox']").forEach((control) => {
      control.addEventListener("change", () => this.#emitChange());
    });
    this.#el
      .querySelectorAll(
        "input[type='text'], input[type='number'], input[type='url'], textarea",
      )
      .forEach((control) => {
        control.addEventListener("input", () => this.#emitDebounced());
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

    // Security panel — secret-storage mode radios + unlock button. These do NOT
    // go through #emitChange (the mode lives in an unencrypted config, not the
    // settings manifest, and switching runs a re-encryption migration).
    this.#wireSecurity();

    // Escape handling lives in #onKeyDown, attached on open() and detached
    // when PopupManager dispatches "hippo:popup-closed". See class fields above.

    // X button (top-right ✕) — revert historyCount to the value at open time,
    // then close without committing the pending history count.
    this.#el.querySelector(".popup-close").addEventListener("click", () => {
      this.#revertHistoryCount();
      PopupManager.close();
    });

    // Close button (footer) — commit historyCount and trigger history trimming,
    // but only when something actually changed. Opening and closing untouched
    // must write nothing and must not sweep on-disk history.
    this.#el.querySelector(".js-close").addEventListener("click", () => {
      this.#emitDebounced.cancel(); // flush below via #emitChange, not the timer
      const historyCount = this.#readHistoryCount();
      const historyChanged = historyCount !== this.#openHistoryCount;
      // #emitChange self-dedups: with historyCount it always commits; without,
      // it emits only a not-yet-flushed field edit and is a no-op otherwise.
      this.#emitChange(historyChanged ? historyCount : undefined);
      if (historyChanged) {
        window.dispatchEvent(
          new CustomEvent("hippo:history-trim", {
            detail: { historyCount },
            bubbles: true,
          }),
        );
      }
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
    // Refresh the live backend state each time the Security panel is revealed.
    if (name === "security") this.#loadSecurityState();
    // Re-probe the CLI launcher each time the Command Line panel is revealed.
    if (name === "cli") this.#loadCliStatus();
  }

  // ── Security panel (secret-storage backend) ─────────────────────────────────
  //
  // Everything here is INLINE (no PopupManager.open child modal): the Settings
  // popup is the active popup, and PopupManager.open would detach it. The mode is
  // NOT routed through #emitChange — it lives in an unencrypted config, and
  // switching runs a re-encryption migration in the main process. set-mode /
  // unlock reload the window on success, so the success paths fall through.

  /**
   * One radio option card for the secret-storage mode group. `extra` carries the
   * inline master-password fields nested inside the master-password card.
   */
  #securityModeOption(value, label, desc, extra = "") {
    const head = `
      <label class="security-mode-head">
        <input type="radio" name="secret-storage-mode" value="${value}" />
        <span class="security-mode-text">
          <span class="security-mode-label">${label}</span>
          <span class="security-mode-desc">${desc}</span>
        </span>
      </label>`;
    if (!extra) return `<label class="security-mode-option">${head}</label>`;
    return `<div class="security-mode-option security-mode-option--expandable">${head}${extra}</div>`;
  }

  /** Wire the security radios, the master-password Apply, and the Unlock button. */
  #wireSecurity() {
    for (const radio of this.#el.querySelectorAll(
      'input[name="secret-storage-mode"]',
    )) {
      radio.addEventListener("change", () => this.#onSecurityModeChange(radio));
    }
    this.#el
      .querySelector(".js-master-apply")
      ?.addEventListener("click", () => this.#applyMasterPassword());
    this.#el
      .querySelector(".js-security-unlock")
      ?.addEventListener("click", () => this.#unlockMaster());
    this.#el
      .querySelector(".js-security-unlock-pw")
      ?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.#unlockMaster();
        }
      });
  }

  /** Fetch the live backend state and reflect it in the Security panel. */
  async #loadSecurityState() {
    let state;
    try {
      state = await window.hippo.secretStorage.getMode();
    } catch {
      return; // leave the panel as-is if the bridge is unavailable
    }
    if (!this.#el) return;
    this.#securityState = state;
    this.#syncSecurityRadio(state.mode);
    this.#showMasterFields(false);
    // Disable OS keychain when the platform keystore isn't available.
    const keychainRadio = this.#el.querySelector(
      'input[name="secret-storage-mode"][value="os-keychain"]',
    );
    if (keychainRadio) keychainRadio.disabled = !state.available;
    // Locked master-password session: surface the inline unlock field.
    const lockedRow = this.#el.querySelector(".security-locked-row");
    if (lockedRow) lockedRow.hidden = !state.locked;
    this.#setSecurityStatus("");
  }

  /** Select the radio matching `mode` without firing its change handler. */
  #syncSecurityRadio(mode) {
    for (const radio of this.#el.querySelectorAll(
      'input[name="secret-storage-mode"]',
    )) {
      radio.checked = radio.value === mode;
    }
  }

  #showMasterFields(show) {
    const fields = this.#el.querySelector(".security-master-fields");
    if (!fields) return;
    fields.hidden = !show;
    if (show) {
      requestAnimationFrame(() =>
        this.#el.querySelector(".js-master-pw")?.focus(),
      );
    } else {
      const pw = this.#el.querySelector(".js-master-pw");
      const cpw = this.#el.querySelector(".js-master-pw-confirm");
      if (pw) pw.value = "";
      if (cpw) cpw.value = "";
    }
  }

  #setSecurityStatus(text, isError = false) {
    const el = this.#el?.querySelector(".security-status");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("security-status--error", isError && !!text);
  }

  /**
   * A mode radio changed. app-key / OS-keychain confirm then re-encrypt directly
   * (the confirm dialog stacks safely over Settings). master-password reveals the
   * inline password fields; the actual switch happens on Apply.
   */
  #onSecurityModeChange(radio) {
    const target = radio.value;
    const current = this.#securityState?.mode;
    this.#setSecurityStatus("");
    if (target === current) {
      this.#showMasterFields(false);
      return;
    }

    if (target === "master-password") {
      this.#showMasterFields(true);
      return;
    }
    this.#showMasterFields(false);

    PopupManager.confirm({
      title: t("settings.security.switchTitle"),
      message: t("settings.security.switchMessage"),
      confirmLabel: t("settings.security.switchConfirm"),
      confirmClass: "btn--primary",
      onConfirm: () => this.#applyMode(target),
      onCancel: () => this.#syncSecurityRadio(current),
    });
  }

  /** Switch to app-key / os-keychain (no password). Reloads on success. */
  async #applyMode(target) {
    this.#setSecurityStatus(t("settings.security.switching"));
    let res;
    try {
      res = await window.hippo.secretStorage.setMode({ mode: target });
    } catch {
      res = { ok: false, reason: "error" };
    }
    if (res && res.ok) return; // success reloads the window
    this.#setSecurityStatus(this.#switchErrorMessage(res?.reason), true);
    this.#syncSecurityRadio(this.#securityState?.mode);
  }

  /** Apply a freshly chosen master password (validates confirm). Reloads on success. */
  async #applyMasterPassword() {
    const pw = this.#el.querySelector(".js-master-pw").value;
    const confirm = this.#el.querySelector(".js-master-pw-confirm").value;
    if (!pw) {
      this.#setSecurityStatus(
        t("settings.security.error.passwordRequired"),
        true,
      );
      return;
    }
    if (pw !== confirm) {
      this.#setSecurityStatus(
        t("settings.security.error.passwordMismatch"),
        true,
      );
      return;
    }
    this.#setSecurityStatus(t("settings.security.switching"));
    let res;
    try {
      res = await window.hippo.secretStorage.setMode({
        mode: "master-password",
        password: pw,
      });
    } catch {
      res = { ok: false, reason: "error" };
    }
    if (res && res.ok) return; // success reloads the window
    this.#setSecurityStatus(this.#switchErrorMessage(res?.reason), true);
  }

  /** Unlock a locked master-password session from the inline field. */
  async #unlockMaster() {
    const input = this.#el.querySelector(".js-security-unlock-pw");
    const pw = input ? input.value : "";
    if (!pw) {
      this.#setSecurityStatus(
        t("settings.security.error.passwordRequired"),
        true,
      );
      return;
    }
    this.#setSecurityStatus(t("settings.security.unlocking"));
    let res;
    try {
      res = await window.hippo.secretStorage.unlock(pw);
    } catch {
      res = { ok: false, reason: "error" };
    }
    if (res && res.ok) return; // success reloads the window
    this.#setSecurityStatus(
      res?.reason === "bad-password"
        ? t("settings.security.error.badPassword")
        : t("settings.security.error.generic"),
      true,
    );
    if (input) {
      input.value = "";
      input.focus();
    }
  }

  #switchErrorMessage(reason) {
    if (reason === "keychain-unavailable")
      return t("settings.security.error.keychainUnavailable");
    if (reason === "locked") return t("settings.security.error.lockedSwitch");
    if (reason === "migration-failed")
      return t("settings.security.error.migrationFailed");
    return t("settings.security.error.generic");
  }

  // ── About panel / auto-update (Feature 36) ───────────────────────────────────

  /** Set the inline update-status line text (no-op if the panel isn't built). */
  #setUpdateStatus(text) {
    const el = this.#el?.querySelector("#setting-about-status");
    if (el) el.textContent = text;
  }

  /** Attach the updater status-line listeners (open lifecycle). */
  #wireUpdaterStatus() {
    window.addEventListener("hippo:updater-checking", this.#onUpdaterChecking);
    window.addEventListener(
      "hippo:updater-available",
      this.#onUpdaterAvailable,
    );
    window.addEventListener(
      "hippo:updater-not-available",
      this.#onUpdaterNotAvailable,
    );
    window.addEventListener(
      "hippo:updater-downloaded",
      this.#onUpdaterDownloaded,
    );
    window.addEventListener("hippo:updater-error", this.#onUpdaterError);
  }

  /** Detach the updater status-line listeners (close lifecycle). */
  #unwireUpdaterStatus() {
    window.removeEventListener(
      "hippo:updater-checking",
      this.#onUpdaterChecking,
    );
    window.removeEventListener(
      "hippo:updater-available",
      this.#onUpdaterAvailable,
    );
    window.removeEventListener(
      "hippo:updater-not-available",
      this.#onUpdaterNotAvailable,
    );
    window.removeEventListener(
      "hippo:updater-downloaded",
      this.#onUpdaterDownloaded,
    );
    window.removeEventListener("hippo:updater-error", this.#onUpdaterError);
  }

  /** Fill the About version line from the main process (app / build metadata). */
  async #loadAppInfo() {
    const versionEl = this.#el?.querySelector("#setting-about-version");
    if (!versionEl) return;
    try {
      const info = await window.hippo?.app?.info?.();
      if (info?.version)
        versionEl.textContent = t("settings.about.version", {
          version: info.version,
        });
    } catch {
      /* leave the version line blank if the metadata can't be read */
    }
    // Store builds (Mac App Store / Microsoft Store) self-update through the
    // store, so the in-app updater is disabled: hide the auto-check toggle and
    // the Check-for-Updates button, and explain it on the status line.
    if (window.hippo?.isStoreBuild) {
      this.#el
        ?.querySelector("#setting-auto-update")
        ?.closest(".settings-row")
        ?.setAttribute("hidden", "");
      this.#el
        ?.querySelector("#setting-check-updates")
        ?.setAttribute("hidden", "");
      this.#setUpdateStatus(t("updater.storeManaged"));
    }
  }

  // ── Command Line panel (hippo CLI launcher) ──────────────────────────────────

  /**
   * Probe the CLI launcher and render the panel: the button toggles between
   * Install and Remove, and is disabled (with an explanatory status line) on a
   * dev build or an unsupported OS, where installation isn't possible.
   */
  async #loadCliStatus() {
    const btn = this.#el?.querySelector("#setting-cli-action");
    const statusEl = this.#el?.querySelector("#setting-cli-status");
    if (!btn || !statusEl) return;
    let s = null;
    try {
      s = await window.hippo?.cli?.status?.();
    } catch {
      /* leave s null → treated as unavailable below */
    }
    this.#cliStatus = s;
    if (!s?.available) {
      btn.disabled = true;
      btn.textContent = t("settings.cli.installButton");
      statusEl.textContent = t("settings.cli.unavailable");
      return;
    }
    btn.disabled = false;
    btn.textContent = s.installed
      ? t("settings.cli.removeButton")
      : t("settings.cli.installButton");
    statusEl.textContent = s.installed
      ? t("settings.cli.installed")
      : t("settings.cli.notInstalled");
  }

  /** Install or remove the `hippo` command, then refresh the panel. */
  async #onCliAction() {
    const btn = this.#el?.querySelector("#setting-cli-action");
    if (!btn || btn.disabled) return;
    const removing = !!this.#cliStatus?.installed;
    btn.disabled = true;
    try {
      const result = removing
        ? await window.hippo?.cli?.uninstall?.()
        : await window.hippo?.cli?.install?.();
      reportCliResult(result, { uninstall: removing });
    } finally {
      await this.#loadCliStatus();
    }
  }

  /**
   * Mark layout option `n` as the selected radio: toggles the --selected class
   * and aria-checked, and moves the single roving tab stop onto it. Pass
   * focus:true (keyboard navigation) to also move focus there.
   * @param {number} n  1–4
   * @param {{ focus?: boolean }} [opts]
   */
  #selectLayout(n, { focus = false } = {}) {
    this.#el.querySelectorAll(".settings-layout-option").forEach((btn) => {
      const on = parseInt(btn.dataset.layout, 10) === n;
      btn.classList.toggle("settings-layout-option--selected", on);
      btn.setAttribute("aria-checked", String(on));
      btn.tabIndex = on ? 0 : -1;
      if (on && focus) btn.focus();
    });
  }

  /**
   * Sync the tooltip on the "Show headers" row to reflect the current state.
   * The toggle is displayed inverted (checked = headers shown), so checked maps
   * to the "headers shown" tooltip and unchecked to the "headers hidden" one.
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
    const json = JSON.stringify(detail);
    // Dedup: a plain emit (no historyCount commit) whose values match the last
    // one dispatched is a no-op — skip the full save + whole-app re-apply. An
    // explicit historyCount always emits (it's a deliberate commit at Close).
    if (historyCount === undefined && json === this.#lastEmittedJson) return;
    this.#lastEmittedJson = json;
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
      layout:
        parseInt(
          this.#el.querySelector(".settings-layout-option--selected")?.dataset
            .layout,
          10,
        ) || 2,
      // Inverted display: the toggle reads "Show headers", but the persisted
      // flag stays `removeHeaders` (checked = shown = removeHeaders false).
      removeHeaders: !this.#el.querySelector("#setting-remove-headers").checked,
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
      showCapturesTab: this.#el.querySelector("#setting-show-captures-tab")
        .checked,
      showScriptsTab: this.#el.querySelector("#setting-show-scripts-tab")
        .checked,
      showTestsTab: this.#el.querySelector("#setting-show-tests-tab").checked,
      showNotesTab: this.#el.querySelector("#setting-show-notes-tab").checked,
      pickerDebounceMs: (() => {
        // `|| 200` would coerce a legitimate 0 (min="0", disables the debounce)
        // back to the default, so a finite value — including 0 — is kept as-is.
        const parsed = parseInt(
          this.#el.querySelector("#setting-picker-debounce").value,
          10,
        );
        return Number.isFinite(parsed) ? parsed : 200;
      })(),
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
      retryNonIdempotent: this.#el.querySelector("#setting-retry-nonidempotent")
        .checked,
      retryStatusCodes: this.#el
        .querySelector("#setting-retry-status")
        .value.trim(),
      clientCerts: this.#serializeClientCerts(),
      caCerts: this.#serializeCaCerts(),
      tlsInsecureHosts: this.#el
        .querySelector("#setting-tls-insecure-hosts")
        .value.trim(),
      autoUpdateCheck: this.#el.querySelector("#setting-auto-update").checked,
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
      .addEventListener("input", () => this.#emitDebounced());
    pass.addEventListener("input", () => this.#emitDebounced());
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
    // Snapshot the opened state so a close with no real edit writes nothing, and
    // seed the dedup baseline so an unchanged re-emit is skipped. Any stale
    // pending emit from a previous open is dropped.
    this.#emitDebounced.cancel();
    this.#baselineJson = JSON.stringify(this.#readValues());
    this.#lastEmittedJson = this.#baselineJson;
    this.#showPanel("appearance");
    // About panel (Feature 36): refresh the version line and clear any stale
    // status from a previous open, then track updater events while open.
    this.#setUpdateStatus("");
    this.#loadAppInfo();
    this.#loadSecurityState();
    this.#loadCliStatus();
    this.#wireUpdaterStatus();
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
    // Layout — reflect the stored layout when present. Guarded like every
    // other field: a partial load (e.g. { fontSize } from applySettings, which
    // fires on every settings change) must NOT reset the selection. The full
    // startup load (and open()) always carry layout, so the selected option /
    // roving tab stop is established before the popup is ever shown.
    if (settings.layout !== undefined) {
      this.#selectLayout(settings.layout);
    }
    if (settings.removeHeaders !== undefined) {
      // Inverted display: checked = "Show headers" = NOT removeHeaders.
      this.#el.querySelector("#setting-remove-headers").checked =
        !settings.removeHeaders;
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
    if (settings.showCapturesTab !== undefined) {
      this.#el.querySelector("#setting-show-captures-tab").checked =
        settings.showCapturesTab;
    }
    if (settings.showScriptsTab !== undefined) {
      this.#el.querySelector("#setting-show-scripts-tab").checked =
        settings.showScriptsTab;
    }
    if (settings.showTestsTab !== undefined) {
      this.#el.querySelector("#setting-show-tests-tab").checked =
        settings.showTestsTab;
    }
    if (settings.showNotesTab !== undefined) {
      this.#el.querySelector("#setting-show-notes-tab").checked =
        settings.showNotesTab;
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
    if (settings.retryNonIdempotent !== undefined) {
      this.#el.querySelector("#setting-retry-nonidempotent").checked =
        settings.retryNonIdempotent;
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
    if (settings.autoUpdateCheck !== undefined) {
      this.#el.querySelector("#setting-auto-update").checked =
        settings.autoUpdateCheck;
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
