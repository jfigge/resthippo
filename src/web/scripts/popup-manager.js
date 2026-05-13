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
   */
  close() {
    if (!_activePopup) return;

    const el = _activePopup.element;
    el.classList.remove("popup--visible");

    // Wait for the CSS transition, then remove from DOM
    const onTransitionEnd = () => {
      el.removeEventListener("transitionend", onTransitionEnd);
      if (el.parentNode) el.parentNode.removeChild(el);
    };
    el.addEventListener("transitionend", onTransitionEnd);

    // Hide mask
    if (_maskEl) _maskEl.classList.remove("popup-overlay--visible");

    _activePopup = null;
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
};

