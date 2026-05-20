/**
 * settings-popup.js — Application settings popup
 *
 * Built on top of PopupManager so it participates in the shared overlay/mask
 * system.  Settings are persisted immediately on every control change by
 * dispatching a "wurl:settings-changed" event; app.js listens and writes to
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

export class SettingsPopup {
  /** @type {HTMLElement} */
  #el;

  constructor() {
    this.#el = this.#build();
    this.#bindEvents();
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
    el.setAttribute("aria-label", "Settings");

    el.innerHTML = `
      <div class="popup-header">
        <span class="popup-title">Settings</span>
        <button class="popup-close" aria-label="Close settings" title="Close">✕</button>
      </div>

      <div class="popup-body">
        <!-- Appearance ──────────────────────────────────────────────── -->
        <div class="settings-section">
          <h3 class="settings-section-title">Appearance</h3>

          <div class="settings-row">
            <label class="settings-label" for="setting-theme">Theme</label>
            <select class="settings-select" id="setting-theme">
              <optgroup label="Dark">
                <option value="mocha">Mocha</option>
                <option value="grey-dark">Grey</option>
                <option value="yellow">Yellow</option>
                <option value="green">Green</option>
                <option value="blue">Blue</option>
                <option value="red">Red</option>
              </optgroup>
              <optgroup label="Light">
                <option value="latte">Latte</option>
                <option value="grey-light">Grey</option>
                <option value="yellow-light">Yellow</option>
                <option value="green-light">Green</option>
                <option value="blue-light">Blue</option>
                <option value="red-light">Red</option>
              </optgroup>
            </select>
          </div>

          <div class="settings-row">
            <label class="settings-label" for="setting-font-size">Editor font size</label>
            <select class="settings-select" id="setting-font-size">
              <option value="11">11 px</option>
              <option value="12">12 px</option>
              <option value="13">13 px</option>
              <option value="14">14 px</option>
              <option value="16">16 px</option>
              <option value="18">18 px</option>
            </select>
          </div>

          <div class="settings-row settings-row--toggle" id="setting-remove-headers-row">
            <label class="settings-label" for="setting-remove-headers">Remove headers</label>
            <input
              class="settings-toggle"
              id="setting-remove-headers"
              type="checkbox"
            />
          </div>
        </div>

        <!-- Request ──────────────────────────────────────────────────── -->
        <div class="settings-section">
          <h3 class="settings-section-title">Request</h3>

          <div class="settings-row">
            <label class="settings-label" for="setting-timeout">Timeout (ms)</label>
            <input
              class="settings-input"
              id="setting-timeout"
              type="number"
              min="0"
              max="300000"
              step="1000"
            />
          </div>

          <div class="settings-row settings-row--toggle">
            <label class="settings-label" for="setting-follow-redirects">Follow redirects</label>
            <input
              class="settings-toggle"
              id="setting-follow-redirects"
              type="checkbox"
            />
          </div>

          <div class="settings-row settings-row--toggle">
            <label class="settings-label" for="setting-dblclick-execute">Double-click requests to execute</label>
            <input
              class="settings-toggle"
              id="setting-dblclick-execute"
              type="checkbox"
            />
          </div>

          <div class="settings-row settings-row--toggle">
            <label class="settings-label" for="setting-verify-ssl">Verify SSL certificates</label>
            <input
              class="settings-toggle"
              id="setting-verify-ssl"
              type="checkbox"
            />
          </div>

          <div class="settings-row">
            <label class="settings-label" for="setting-picker-debounce">Picker debounce (ms)</label>
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
        </div>

        <!-- Proxy ───────────────────────────────────────────────────── -->
        <div class="settings-section">
          <h3 class="settings-section-title">Proxy</h3>

          <div class="settings-row settings-row--toggle">
            <label class="settings-label" for="setting-proxy-enabled">Enable proxy</label>
            <input class="settings-toggle" id="setting-proxy-enabled" type="checkbox" />
          </div>

          <div class="settings-row">
            <label class="settings-label" for="setting-proxy-url">Proxy URL</label>
            <input
              class="settings-input"
              id="setting-proxy-url"
              type="url"
              placeholder="http://proxy:8080"
            />
          </div>
        </div>
      </div>

      <div class="popup-footer">
        <button class="popup-btn popup-btn--primary js-close">Close</button>
      </div>
    `;

    return el;
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  #bindEvents() {
    // Auto-save on every user interaction — no explicit Save needed
    this.#el.querySelectorAll("select, input").forEach((control) => {
      control.addEventListener("change", () => this.#emitChange());
      control.addEventListener("input",  () => this.#emitChange());
    });

    // Update the "Remove headers" tooltip whenever the checkbox is toggled
    const removeHeadersCb = this.#el.querySelector("#setting-remove-headers");
    removeHeadersCb.addEventListener("change", () => this.#updateRemoveHeadersTitle());

    // Close button (top-right ✕)
    this.#el.querySelector(".popup-close").addEventListener("click", () => {
      PopupManager.close();
    });

    // Close button (footer)
    this.#el.querySelector(".js-close").addEventListener("click", () => {
      PopupManager.close();
    });
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  /**
   * Sync the tooltip on the "Remove headers" row to reflect the current state.
   * Checked → explains where the icon will be after checking the box.
   * Unchecked   → explains where the settings icon moves when headers are hidden.
   */
  #updateRemoveHeadersTitle() {
    const cb  = this.#el.querySelector("#setting-remove-headers");
    const row = this.#el.querySelector("#setting-remove-headers-row");
    if (!cb || !row) return;
    row.title = cb.checked
      ? "When headers are shown, the settings icon will move to the top right corner"
      : "When headers are hidden, the settings icon will move to the bottom left corner";
  }

  /**
   * Read current control values and dispatch "wurl:settings-changed".
   * app.js listens and persists to storage immediately.
   */
  #emitChange() {
    window.dispatchEvent(
      new CustomEvent("wurl:settings-changed", {
        detail: this.#readValues(),
        bubbles: true,
      }),
    );
  }

  /** Collect all setting values into a plain object. */
  #readValues() {
    return {
      theme:           this.#el.querySelector("#setting-theme").value,
      fontSize:        parseInt(this.#el.querySelector("#setting-font-size").value, 10),
      removeHeaders:   this.#el.querySelector("#setting-remove-headers").checked,
      timeout:         parseInt(this.#el.querySelector("#setting-timeout").value, 10),
      followRedirects:    this.#el.querySelector("#setting-follow-redirects").checked,
      doubleClickExecute: this.#el.querySelector("#setting-dblclick-execute").checked,
      verifySsl:          this.#el.querySelector("#setting-verify-ssl").checked,
      pickerDebounceMs: parseInt(this.#el.querySelector("#setting-picker-debounce").value, 10),
      proxyEnabled:    this.#el.querySelector("#setting-proxy-enabled").checked,
      proxyUrl:        this.#el.querySelector("#setting-proxy-url").value.trim(),
    };
  }

  // ── PopupManager protocol ──────────────────────────────────────────────────

  /** Called by PopupManager when the user clicks the overlay mask. */
  onMaskClick() {
    PopupManager.close();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Populate the controls from a stored settings object, then open the popup.
   * Missing keys fall back to their HTML default values.
   * @param {object} [settings]
   */
  open(settings = {}) {
    this.#applyValues(settings);
    PopupManager.open(this);
  }

  /**
   * Populate all controls from a settings object without opening the popup.
   * Call this at startup to initialise the controls from persisted values.
   * @param {object} settings
   */
  load(settings = {}) {
    this.#applyValues(settings);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /** Write a settings object back into the form controls. */
  #applyValues(settings) {
    if (settings.theme !== undefined) {
      this.#el.querySelector("#setting-theme").value = settings.theme;
    }
    if (settings.fontSize !== undefined) {
      this.#el.querySelector("#setting-font-size").value = String(settings.fontSize);
    }
    if (settings.removeHeaders !== undefined) {
      this.#el.querySelector("#setting-remove-headers").checked = settings.removeHeaders;
    }
    // Always refresh the tooltip so it matches the current checkbox state
    this.#updateRemoveHeadersTitle();
    if (settings.timeout !== undefined) {
      this.#el.querySelector("#setting-timeout").value = String(settings.timeout);
    }
    if (settings.followRedirects !== undefined) {
      this.#el.querySelector("#setting-follow-redirects").checked = settings.followRedirects;
    }
    if (settings.doubleClickExecute !== undefined) {
      this.#el.querySelector("#setting-dblclick-execute").checked = settings.doubleClickExecute;
    }
    if (settings.verifySsl !== undefined) {
      this.#el.querySelector("#setting-verify-ssl").checked = settings.verifySsl;
    }
    if (settings.pickerDebounceMs !== undefined) {
      this.#el.querySelector("#setting-picker-debounce").value = String(settings.pickerDebounceMs);
    }
    if (settings.proxyEnabled !== undefined) {
      this.#el.querySelector("#setting-proxy-enabled").checked = settings.proxyEnabled;
    }
    if (settings.proxyUrl !== undefined) {
      this.#el.querySelector("#setting-proxy-url").value = settings.proxyUrl;
    }
  }
}
