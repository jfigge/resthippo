/**
 * settings-popup.js — Application settings popup
 *
 * Built on top of PopupManager so it participates in the shared overlay/mask
 * system and implements the dirty-tracking / close-confirmation protocol.
 *
 * Usage:
 *   import { SettingsPopup } from "./components/settings-popup.js";
 *   const settings = new SettingsPopup();
 *   document.getElementById("btn-settings").addEventListener("click", () => settings.open());
 */

"use strict";

import { PopupManager } from "../popup-manager.js";

export class SettingsPopup {
  /** @type {HTMLElement} */
  #el;

  /** True when any setting has been changed since the popup was opened */
  #dirty = false;

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
              <option value="mocha" selected>Mocha (Dark)</option>
              <option value="latte">Latte (Light)</option>
            </select>
          </div>

          <div class="settings-row">
            <label class="settings-label" for="setting-font-size">Editor font size</label>
            <select class="settings-select" id="setting-font-size">
              <option value="11">11 px</option>
              <option value="12">12 px</option>
              <option value="13" selected>13 px</option>
              <option value="14">14 px</option>
              <option value="16">16 px</option>
            </select>
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
              value="30000"
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
              checked
            />
          </div>

          <div class="settings-row settings-row--toggle">
            <label class="settings-label" for="setting-verify-ssl">Verify SSL certificates</label>
            <input
              class="settings-toggle"
              id="setting-verify-ssl"
              type="checkbox"
              checked
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
        <button class="popup-btn popup-btn--secondary js-cancel">Cancel</button>
        <button class="popup-btn popup-btn--primary   js-save">Save changes</button>
      </div>
    `;

    return el;
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  #bindEvents() {
    // Mark dirty on any user interaction with a form control
    this.#el.querySelectorAll("select, input").forEach((control) => {
      control.addEventListener("change", () => { this.#dirty = true; });
      control.addEventListener("input",  () => { this.#dirty = true; });
    });

    // Close button (top-right ✕)
    this.#el.querySelector(".popup-close").addEventListener("click", () => {
      this.#requestClose();
    });

    // Cancel button (footer)
    this.#el.querySelector(".js-cancel").addEventListener("click", () => {
      this.#requestClose();
    });

    // Save button (footer)
    this.#el.querySelector(".js-save").addEventListener("click", () => {
      this.#save();
      PopupManager.close();
    });
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  /**
   * Initiates a close attempt — shows discard confirmation when dirty,
   * otherwise closes immediately.
   */
  #requestClose() {
    if (this.#dirty) {
      PopupManager.confirmClose(() => {
        this.#dirty = false;
        PopupManager.close();
      });
    } else {
      PopupManager.close();
    }
  }

  /**
   * Persist the current settings values.
   * Dispatches a custom event so other parts of the app can react.
   */
  #save() {
    const values = this.#readValues();
    this.#dirty = false;

    window.dispatchEvent(
      new CustomEvent("wurl:settings-changed", { detail: values }),
    );
  }

  /** Collect all setting values into a plain object */
  #readValues() {
    return {
      theme:            this.#el.querySelector("#setting-theme").value,
      fontSize:         parseInt(this.#el.querySelector("#setting-font-size").value, 10),
      timeout:          parseInt(this.#el.querySelector("#setting-timeout").value, 10),
      followRedirects:  this.#el.querySelector("#setting-follow-redirects").checked,
      verifySsl:        this.#el.querySelector("#setting-verify-ssl").checked,
      proxyEnabled:     this.#el.querySelector("#setting-proxy-enabled").checked,
      proxyUrl:         this.#el.querySelector("#setting-proxy-url").value.trim(),
    };
  }

  // ── PopupManager protocol ──────────────────────────────────────────────────

  /**
   * Called by PopupManager when the user clicks the overlay mask.
   * Implements dirty-check/confirmation before closing.
   */
  onMaskClick() {
    this.#requestClose();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Open the settings popup (resets the dirty flag). */
  open() {
    this.#dirty = false;
    PopupManager.open(this);
  }
}

