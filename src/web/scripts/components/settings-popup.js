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

      <div class="popup-body settings-popup-body">
        <!-- Left navigation list — one entry per settings panel -->
        <nav class="settings-nav" role="tablist" aria-label="Settings sections">
          <button class="settings-nav-item is-active" type="button" role="tab" aria-selected="true" data-panel="appearance">Appearance</button>
          <button class="settings-nav-item" type="button" role="tab" aria-selected="false" data-panel="request">Request</button>
          <button class="settings-nav-item" type="button" role="tab" aria-selected="false" data-panel="proxy">Proxy</button>
          <button class="settings-nav-item" type="button" role="tab" aria-selected="false" data-panel="history">History</button>
        </nav>

        <!-- Right-hand stack of single-column panels; only the active one shows -->
        <div class="settings-panels">
          <!-- Appearance ──────────────────────────────────────────────── -->
          <section class="settings-panel is-active" role="tabpanel" data-panel="appearance">
            <h3 class="settings-panel-title">Appearance</h3>

            <div class="settings-row">
              <label class="settings-label" for="setting-theme">Theme</label>
              <select class="settings-select" id="setting-theme">
                <optgroup label="Dark">
                  <option value="mocha">Mocha</option>
                  <option value="grey-dark">Grey</option>
                </optgroup>
                <optgroup label="Light">
                  <option value="latte">Latte</option>
                  <option value="grey-light">Grey</option>
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

            <div class="settings-row">
              <label class="settings-label" for="setting-font-family">UI font</label>
              <select class="settings-select" id="setting-font-family">
                <option value="inter">Inter</option>
                <option value="system">System Default</option>
                <option value="sf-pro">SF Pro (macOS)</option>
                <option value="segoe">Segoe UI (Windows)</option>
                <option value="ubuntu">Ubuntu (Linux)</option>
                <option value="roboto">Roboto</option>
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

            <div class="settings-row settings-row--toggle">
              <label class="settings-label" for="setting-wrap-response-text">Wrap response text</label>
              <input
                class="settings-toggle"
                id="setting-wrap-response-text"
                type="checkbox"
              />
            </div>
          </section>

          <!-- Request ──────────────────────────────────────────────────── -->
          <section class="settings-panel" role="tabpanel" data-panel="request" hidden>
            <h3 class="settings-panel-title">Request</h3>

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
          </section>

          <!-- Proxy ────────────────────────────────────────────────────── -->
          <section class="settings-panel" role="tabpanel" data-panel="proxy" hidden>
            <h3 class="settings-panel-title">Proxy</h3>

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
          </section>

          <!-- History ──────────────────────────────────────────────────── -->
          <section class="settings-panel" role="tabpanel" data-panel="history" hidden>
            <h3 class="settings-panel-title">History</h3>

            <div class="settings-row">
              <label class="settings-label" for="setting-history-count">Timeline entries</label>
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
        <button class="popup-btn popup-btn--primary js-close">Close</button>
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
        window.wurl.ui.openThemeEditor?.();
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
        "input[type='text'], input[type='number'], input[type='url']",
      )
      .forEach((control) => {
        control.addEventListener("input", () => this.#emitChange());
      });

    // Update the "Remove headers" tooltip whenever the checkbox is toggled
    const removeHeadersCb = this.#el.querySelector("#setting-remove-headers");
    removeHeadersCb.addEventListener("change", () =>
      this.#updateRemoveHeadersTitle(),
    );

    // Escape handling lives in #onKeyDown, attached on open() and detached
    // when PopupManager dispatches "wurl:popup-closed". See class fields above.

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
        new CustomEvent("wurl:history-trim", {
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
      item.classList.toggle("is-active", active);
      item.setAttribute("aria-selected", String(active));
    });
    this.#el.querySelectorAll(".settings-panel").forEach((panel) => {
      const active = panel.dataset.panel === name;
      panel.classList.toggle("is-active", active);
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
      ? "When headers are shown, the settings icon will move to the top right corner"
      : "When headers are hidden, the settings icon will move to the bottom left corner";
  }

  /**
   * Read current control values and dispatch "wurl:settings-changed".
   * Pass an explicit historyCount to include it (only done from the Close button).
   * @param {number} [historyCount]
   */
  #emitChange(historyCount) {
    const detail = this.#readValues();
    if (historyCount !== undefined) detail.historyCount = historyCount;
    window.dispatchEvent(
      new CustomEvent("wurl:settings-changed", {
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
      theme: this.#el.querySelector("#setting-theme").value,
      fontSize:
        parseInt(this.#el.querySelector("#setting-font-size").value, 10) || 13,
      fontFamily: this.#el.querySelector("#setting-font-family").value,
      removeHeaders: this.#el.querySelector("#setting-remove-headers").checked,
      wrapResponseText: this.#el.querySelector("#setting-wrap-response-text")
        .checked,
      timeout:
        parseInt(this.#el.querySelector("#setting-timeout").value, 10) || 0,
      followRedirects: this.#el.querySelector("#setting-follow-redirects")
        .checked,
      doubleClickExecute: this.#el.querySelector("#setting-dblclick-execute")
        .checked,
      verifySsl: this.#el.querySelector("#setting-verify-ssl").checked,
      pickerDebounceMs:
        parseInt(
          this.#el.querySelector("#setting-picker-debounce").value,
          10,
        ) || 200,
      proxyEnabled: this.#el.querySelector("#setting-proxy-enabled").checked,
      proxyUrl: this.#el.querySelector("#setting-proxy-url").value.trim(),
    };
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
    this.#openHistoryCount = settings.historyCount ?? 5;
    this.refreshThemeList(settings.customThemes ?? []);
    this.#applyValues(settings);
    this.#showPanel("appearance");
    PopupManager.open(this);
    // Scope the Escape handler to the open lifecycle. PopupManager.close()
    // dispatches "wurl:popup-closed" via _hideMask(), which fires for every
    // close path (X button, Close button, Escape, and mask click), so this
    // one once-listener covers them all.
    document.addEventListener("keydown", this.#onKeyDown);
    window.addEventListener("wurl:popup-closed", this.#onPopupClosed, {
      once: true,
    });
  }

  /**
   * Populate all controls from a settings object without opening the popup.
   * Call this at startup to initialise the controls from persisted values.
   * @param {object} settings
   */
  load(settings = {}) {
    if (settings.customThemes !== undefined)
      this.refreshThemeList(settings.customThemes);
    this.#applyValues(settings);
  }

  refreshThemeList(customThemes = []) {
    const sel = this.#el.querySelector("#setting-theme");
    const saved = sel.value;
    sel.querySelector("optgroup[data-custom]")?.remove();
    if (!customThemes.length) {
      sel.value = saved;
      return;
    }
    const group = document.createElement("optgroup");
    group.label = "Custom";
    group.dataset.custom = "";
    for (const t of customThemes) {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = t.name;
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
    if (settings.wrapResponseText !== undefined) {
      this.#el.querySelector("#setting-wrap-response-text").checked =
        settings.wrapResponseText;
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
    if (settings.historyCount !== undefined) {
      this.#el.querySelector("#setting-history-count").value = String(
        settings.historyCount,
      );
    }
  }
}
