/**
 * popup-manager.js — Singleton that manages popup lifecycle
 *
 * Responsibilities:
 *  - Creates and controls a single full-page overlay mask
 *  - Attaches / detaches popup elements from the DOM
 *  - Delegates mask-click events to the active popup's onMaskClick() hook
 *  - Provides a confirmation dialog for popups with unsaved changes
 *
 * Usage:
 *   import { PopupManager } from "./popup-manager.js";
 *
 *   PopupManager.open(myPopupInstance);   // show mask + popup
 *   PopupManager.close();                 // hide mask + popup
 *   PopupManager.confirmClose(callback);  // show confirm dialog; callback on "Discard"
 */

"use strict";

// ── Private state ─────────────────────────────────────────────────────────────

/** @type {{ element: HTMLElement, onMaskClick?: () => void } | null} */
let _activePopup = null;

/** @type {HTMLElement | null} */
let _maskEl = null;

/** @type {HTMLElement | null} */
let _confirmEl = null;

/** Whether the confirmation dialog is currently visible */
let _confirmOpen = false;

// ── Private helpers ───────────────────────────────────────────────────────────

function _ensureMask() {
  if (_maskEl) return;

  _maskEl = document.createElement("div");
  _maskEl.className = "popup-overlay";
  _maskEl.setAttribute("aria-hidden", "true");
  _maskEl.addEventListener("click", _onMaskClick);
  document.body.appendChild(_maskEl);
}

function _ensureConfirm() {
  if (_confirmEl) return;

  _confirmEl = document.createElement("div");
  _confirmEl.className = "popup popup-confirm";
  _confirmEl.setAttribute("role", "alertdialog");
  _confirmEl.setAttribute("aria-modal", "true");
  _confirmEl.setAttribute("aria-label", "Confirm discard changes");
  _confirmEl.innerHTML = `
    <div class="popup-header">
      <span class="popup-title">Discard changes?</span>
    </div>
    <div class="popup-body popup-confirm-body">
      <p>You have unsaved changes. Are you sure you want to discard them?</p>
    </div>
    <div class="popup-footer">
      <button class="popup-btn popup-btn--secondary" id="pm-confirm-keep">Keep editing</button>
      <button class="popup-btn popup-btn--danger"    id="pm-confirm-discard">Discard</button>
    </div>
  `;
  document.body.appendChild(_confirmEl);
}

/**
 * Fired when the user clicks directly on the overlay mask.
 * Delegates to the active popup's onMaskClick hook (if any), but only when no
 * confirmation dialog is already showing.
 */
function _onMaskClick(e) {
  // Ignore if the click bubbled up from the popup itself
  if (_activePopup && _activePopup.element && _activePopup.element.contains(e.target)) return;
  if (_confirmOpen) return;

  if (_activePopup && typeof _activePopup.onMaskClick === "function") {
    _activePopup.onMaskClick();
  } else {
    PopupManager.close();
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export const PopupManager = {
  /**
   * Show the overlay mask and mount a popup element.
   *
   * @param {{ element: HTMLElement, onMaskClick?: () => void }} popup
   */
  open(popup) {
    _ensureMask();

    // Detach any previously active popup
    if (_activePopup?.element?.parentNode) {
      _activePopup.element.parentNode.removeChild(_activePopup.element);
    }

    _activePopup = popup;

    // Show mask first (behind popup)
    _maskEl.classList.add("popup-overlay--visible");

    // Mount popup above the mask
    document.body.appendChild(popup.element);

    // Trigger transition on next frame
    requestAnimationFrame(() => {
      popup.element.classList.add("popup--visible");
    });

    // Move focus into the popup
    const firstFocusable = popup.element.querySelector(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (firstFocusable) {
      requestAnimationFrame(() => firstFocusable.focus());
    }
  },

  /**
   * Hide and remove the active popup, and hide the overlay mask.
   * Handles both animated modal popups and instant context menus.
   */
  close() {
    if (!_activePopup) return;

    const el = _activePopup.element;

    // Reset any inline style overrides applied by openMenu()
    if (_maskEl) {
      _maskEl.style.background = "";
      _maskEl.style.transition = "";
      _maskEl.classList.remove("popup-overlay--visible");
    }

    _activePopup = null;

    if (el.classList.contains("popup--visible")) {
      // Animated modal — fade out, then remove
      el.classList.remove("popup--visible");
      const onEnd = () => {
        el.removeEventListener("transitionend", onEnd);
        if (el.parentNode) el.parentNode.removeChild(el);
      };
      el.addEventListener("transitionend", onEnd);
      // Safety fallback in case transitionend never fires
      setTimeout(() => {
        el.removeEventListener("transitionend", onEnd);
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 400);
    } else {
      // Context-menu or other non-animated element — remove immediately
      if (el.parentNode) el.parentNode.removeChild(el);
    }
  },

  /**
   * Show a lightweight, self-contained confirmation dialog.
   * Does NOT require an active popup — suitable for any in-page action.
   *
   * @param {{ title?: string, message: string, confirmLabel?: string, confirmClass?: string, onConfirm: () => void }} opts
   */
  confirm({ title = "Are you sure?", message, confirmLabel = "Confirm", confirmClass = "popup-btn--danger", onConfirm }) {
    _ensureMask();

    // Build a one-shot dialog element
    const dlg = document.createElement("div");
    dlg.className = "popup popup-confirm";
    dlg.setAttribute("role", "alertdialog");
    dlg.setAttribute("aria-modal", "true");
    dlg.innerHTML = `
      <div class="popup-header">
        <span class="popup-title">${title}</span>
      </div>
      <div class="popup-body popup-confirm-body">
        <p>${message}</p>
      </div>
      <div class="popup-footer">
        <button class="popup-btn popup-btn--secondary" data-action="cancel">Cancel</button>
        <button class="popup-btn ${confirmClass}" data-action="confirm">${confirmLabel}</button>
      </div>
    `;
    document.body.appendChild(dlg);

    // Show mask (transparent overlay so background is still visible)
    const prevActivePopup = _activePopup;
    _activePopup = { element: dlg, onMaskClick: cancel };
    _maskEl.classList.add("popup-overlay--visible");

    requestAnimationFrame(() => dlg.classList.add("popup--visible"));

    const cancelBtn  = dlg.querySelector("[data-action='cancel']");
    const confirmBtn = dlg.querySelector("[data-action='confirm']");

    requestAnimationFrame(() => cancelBtn.focus());

    function cleanup() {
      _activePopup = prevActivePopup;
      if (!_activePopup) {
        _maskEl.classList.remove("popup-overlay--visible");
      }
      dlg.classList.remove("popup--visible");
      const onEnd = () => {
        dlg.removeEventListener("transitionend", onEnd);
        if (dlg.parentNode) dlg.parentNode.removeChild(dlg);
      };
      dlg.addEventListener("transitionend", onEnd);
      setTimeout(() => { if (dlg.parentNode) dlg.parentNode.removeChild(dlg); }, 400);
    }

    function cancel()  { cleanup(); }
    function confirm_() { cleanup(); onConfirm(); }

    cancelBtn.addEventListener("click",  cancel);
    confirmBtn.addEventListener("click", confirm_);

    // Escape key cancels
    function onKey(e) {
      if (e.key === "Escape") { document.removeEventListener("keydown", onKey); cancel(); }
    }
    document.addEventListener("keydown", onKey);
  },

  /**
   * Display a blocking confirmation dialog on top of the current popup.
   * Calls `onConfirm` if the user selects "Discard".
   *
   * @param {() => void} onConfirm  Called when the user chooses to discard changes
   */
  confirmClose(onConfirm) {
    _ensureMask();
    _ensureConfirm();

    _confirmOpen = true;
    document.body.appendChild(_confirmEl);

    requestAnimationFrame(() => {
      _confirmEl.classList.add("popup--visible");
    });

    const keepBtn    = _confirmEl.querySelector("#pm-confirm-keep");
    const discardBtn = _confirmEl.querySelector("#pm-confirm-discard");

    function cleanup() {
      _confirmOpen = false;
      _confirmEl.classList.remove("popup--visible");

      const onEnd = () => {
        _confirmEl.removeEventListener("transitionend", onEnd);
        if (_confirmEl.parentNode) _confirmEl.parentNode.removeChild(_confirmEl);
      };
      _confirmEl.addEventListener("transitionend", onEnd);

      keepBtn.removeEventListener("click", onKeep);
      discardBtn.removeEventListener("click", onDiscard);
    }

    function onKeep() {
      cleanup();
      // Return focus to the popup behind
      const firstFocusable = _activePopup?.element?.querySelector(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (firstFocusable) firstFocusable.focus();
    }

    function onDiscard() {
      cleanup();
      onConfirm();
    }

    keepBtn.addEventListener("click", onKeep);
    discardBtn.addEventListener("click", onDiscard);

    // Focus the safe "Keep editing" button by default
    requestAnimationFrame(() => keepBtn.focus());
  },

  /**
   * Show a lightweight informational dialog with a single "OK" button.
   * Does NOT require an active popup — suitable for any in-page notification.
   *
   * @param {{ title?: string, message?: string, detail?: string }} opts
   *   title   — Dialog title (default: "Info")
   *   message — Primary message text
   *   detail  — Optional secondary / pre-formatted text shown in a code block
   */
  notify({ title = "Info", message = "", detail = "" } = {}) {
    _ensureMask();

    const dlg = document.createElement("div");
    dlg.className = "popup popup-notify";
    dlg.setAttribute("role", "dialog");
    dlg.setAttribute("aria-modal", "true");
    dlg.setAttribute("aria-label", title);

    const detailHtml = detail
      ? `<pre class="popup-notify-detail">${detail.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`
      : "";

    dlg.innerHTML = `
      <div class="popup-header">
        <span class="popup-title">${title}</span>
      </div>
      <div class="popup-body popup-notify-body">
        ${message ? `<p>${message}</p>` : ""}
        ${detailHtml}
      </div>
      <div class="popup-footer">
        <button class="popup-btn popup-btn--primary" data-action="ok">OK</button>
      </div>
    `;
    document.body.appendChild(dlg);

    const prevActivePopup = _activePopup;
    _activePopup = { element: dlg, onMaskClick: close_ };
    _maskEl.classList.add("popup-overlay--visible");

    requestAnimationFrame(() => dlg.classList.add("popup--visible"));

    const okBtn = dlg.querySelector("[data-action='ok']");
    requestAnimationFrame(() => okBtn.focus());

    function close_() {
      _activePopup = prevActivePopup;
      if (!_activePopup) _maskEl.classList.remove("popup-overlay--visible");
      dlg.classList.remove("popup--visible");
      const onEnd = () => {
        dlg.removeEventListener("transitionend", onEnd);
        if (dlg.parentNode) dlg.parentNode.removeChild(dlg);
      };
      dlg.addEventListener("transitionend", onEnd);
      setTimeout(() => { if (dlg.parentNode) dlg.parentNode.removeChild(dlg); }, 400);
    }

    okBtn.addEventListener("click", close_);

    function onKey(e) {
      if (e.key === "Escape" || e.key === "Enter") {
        document.removeEventListener("keydown", onKey);
        close_();
      }
    }
    document.addEventListener("keydown", onKey);
  },

  /**
   * Show a context menu at the given viewport coordinates.
   * The overlay mask is made interactive but transparent — clicking anywhere
   * outside the menu closes it immediately with no confirmation.
   *
   * @param {HTMLElement} element  - The context-menu DOM element to display
   * @param {number}      x        - Desired left position (clientX)
   * @param {number}      y        - Desired top position (clientY)
   */
  openMenu(element, x, y) {
    _ensureMask();

    // Tear down any previously active popup
    if (_activePopup?.element?.parentNode) {
      _activePopup.element.parentNode.removeChild(_activePopup.element);
    }

    // Wrap in the standard popup-like interface; mask click always just closes
    _activePopup = {
      element,
      onMaskClick: () => PopupManager.close(),
    };

    // Transparent mask — click-capture only, no dimming
    _maskEl.style.background = "transparent";
    _maskEl.style.transition  = "none";
    _maskEl.classList.add("popup-overlay--visible");

    // Position and mount
    element.style.left = `${x}px`;
    element.style.top  = `${y}px`;
    document.body.appendChild(element);

    // Clamp to viewport after layout
    requestAnimationFrame(() => {
      const rect = element.getBoundingClientRect();
      if (rect.right > window.innerWidth - 8) {
        element.style.left = `${Math.max(8, x - rect.width)}px`;
      }
      if (rect.bottom > window.innerHeight - 8) {
        element.style.top = `${Math.max(8, y - rect.height)}px`;
      }
    });
  },
};
