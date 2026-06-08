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

import { escapeHtml } from "./utils/html.js";

// ── Private state ─────────────────────────────────────────────────────────────

/** @type {{ element: HTMLElement, onMaskClick?: () => void } | null} */
let _activePopup = null;

/** Cleanup function registered by the most recent confirmClose() call; called by _closeConfirmIfOpen. */
let _confirmCleanup = null;

/** @type {HTMLElement | null} */
let _maskEl = null;

/** @type {HTMLElement | null} */
let _confirmEl = null;

/** Whether the confirmClose dialog is currently visible */
let _confirmOpen = false;

/** Whether the overlay mask is currently visible (used to coalesce open/close events). */
let _maskVisible = false;

// ── Mask visibility helpers (dispatch popup-open/close events) ────────────────

/**
 * Show the overlay mask and fire `wurl:popup-opened` the first time it becomes
 * visible.  Safe to call multiple times — only fires one event per open cycle.
 */
function _showMask() {
  if (!_maskEl) return;
  if (!_maskVisible) {
    _maskVisible = true;
    window.dispatchEvent(new CustomEvent("wurl:popup-opened"));
  }
  _maskEl.classList.add("popup-overlay--visible");
}

/**
 * Hide the overlay mask and fire `wurl:popup-closed` once it goes away.
 * Safe to call when the mask is already hidden (no-op).
 */
function _hideMask() {
  if (!_maskEl) return;
  _maskEl.classList.remove("popup-overlay--visible");
  if (_maskVisible) {
    _maskVisible = false;
    window.dispatchEvent(new CustomEvent("wurl:popup-closed"));
  }
}

// ── Resize → close any active popup / dialog ──────────────────────────────────

/**
 * Dismiss the confirmClose overlay without taking any action.
 * Mirrors the "Keep editing" path but skips the focus-restore step.
 */
function _closeConfirmIfOpen() {
  if (!_confirmOpen || !_confirmEl) return;
  _confirmCleanup?.();
  _confirmCleanup = null;
  _confirmOpen = false;
  _confirmEl.classList.remove("popup--visible");
  const onEnd = () => {
    _confirmEl.removeEventListener("transitionend", onEnd);
    if (_confirmEl.parentNode) _confirmEl.parentNode.removeChild(_confirmEl);
  };
  _confirmEl.addEventListener("transitionend", onEnd);
  setTimeout(() => {
    if (!_confirmEl) return;
    _confirmEl.removeEventListener("transitionend", onEnd);
    if (_confirmEl.parentNode) _confirmEl.parentNode.removeChild(_confirmEl);
  }, 400);
}

window.addEventListener("resize", () => {
  _closeConfirmIfOpen();
  if (_activePopup) PopupManager.close();
});

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
  if (
    _activePopup &&
    _activePopup.element &&
    _activePopup.element.contains(e.target)
  )
    return;
  if (_confirmOpen) return;

  if (_activePopup && typeof _activePopup.onMaskClick === "function") {
    _activePopup.onMaskClick();
  } else {
    PopupManager.close();
  }
}

/**
 * Create, mount, animate, and wire keyboard/mask dismissal for a one-shot dialog.
 *
 * All shared boilerplate between confirm() and notify() lives here:
 *   – element creation, class/role/aria wiring
 *   – mask show/restore
 *   – popup-in animation
 *   – initial focus
 *   – keyboard listener (always torn down on dismiss, never leaks)
 *   – fade-out animation + DOM removal
 *
 * Returns the dialog element and a `dismiss(afterFn?)` function.
 * Callers wire their own buttons then call dismiss() in each handler.
 *
 * @param {{
 *   cssClass:  string,     Extra CSS class added alongside "popup" (e.g. "popup-confirm")
 *   role:      string,     ARIA role — "dialog" or "alertdialog"
 *   ariaLabel: string,     aria-label value for screen readers
 *   innerHTML: string,     Full inner HTML of the dialog
 *   focusSel:  string,     querySelector string for the element to receive initial focus
 *   escKeys?:  string[],   Key values that trigger dismissal — default ["Escape"]
 * }} opts
 * @returns {{ dlg: HTMLElement, dismiss: (afterFn?: () => void) => void }}
 */
function _showOneShotDialog({
  cssClass,
  role,
  ariaLabel,
  innerHTML,
  focusSel,
  escKeys = ["Escape"],
}) {
  _ensureMask();

  // Build the dialog element
  const dlg = document.createElement("div");
  dlg.className = `popup ${cssClass}`;
  dlg.setAttribute("role", role);
  dlg.setAttribute("aria-modal", "true");
  dlg.setAttribute("aria-label", ariaLabel);
  dlg.innerHTML = innerHTML;
  document.body.appendChild(dlg);

  // Snapshot and replace the active popup slot
  const prevActivePopup = _activePopup;

  /**
   * Tear down this dialog cleanly, then optionally invoke a callback.
   * Safe to call from any dismissal path (button, keyboard, mask).
   * @param {(() => void) | undefined} afterFn  called after teardown begins
   */
  function dismiss(afterFn) {
    document.removeEventListener("keydown", onKey);
    _activePopup = prevActivePopup;
    if (!_activePopup) _hideMask();
    dlg.classList.remove("popup--visible");
    const onEnd = () => {
      dlg.removeEventListener("transitionend", onEnd);
      if (dlg.parentNode) dlg.parentNode.removeChild(dlg);
    };
    dlg.addEventListener("transitionend", onEnd);
    // Safety fallback in case transitionend never fires
    setTimeout(() => {
      if (dlg.parentNode) dlg.parentNode.removeChild(dlg);
    }, 400);
    if (typeof afterFn === "function") afterFn();
  }

  // Register as the active popup so mask clicks delegate correctly
  _activePopup = { element: dlg, onMaskClick: () => dismiss() };
  _showMask();

  // Animate in and focus the primary button
  requestAnimationFrame(() => dlg.classList.add("popup--visible"));
  const focusEl = dlg.querySelector(focusSel);
  if (focusEl) requestAnimationFrame(() => focusEl.focus());

  // Keyboard dismissal — removed inside dismiss() so it never leaks
  function onKey(e) {
    if (escKeys.includes(e.key)) dismiss();
  }
  document.addEventListener("keydown", onKey);

  return { dlg, dismiss };
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
    _showMask();

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
    }
    _hideMask();

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
   * @param {{
   *   title?:        string,
   *   message:       string,
   *   note?:         string,
   *   confirmLabel?: string,
   *   confirmClass?: string,
   *   onConfirm:     () => void,
   * }} opts
   */
  confirm({
    title = "Are you sure?",
    message,
    note,
    confirmLabel = "Confirm",
    confirmClass = "popup-btn--danger",
    onConfirm,
  }) {
    const noteHtml = note
      ? `<p class="popup-confirm-note">${escapeHtml(note)}</p>`
      : "";
    const { dlg, dismiss } = _showOneShotDialog({
      cssClass: "popup-confirm",
      role: "alertdialog",
      ariaLabel: escapeHtml(title),
      innerHTML: `
        <div class="popup-header">
          <span class="popup-title">${escapeHtml(title)}</span>
        </div>
        <div class="popup-body popup-confirm-body">
          <p>${escapeHtml(message)}</p>
          ${noteHtml}
        </div>
        <div class="popup-footer">
          <button class="popup-btn popup-btn--secondary" data-action="cancel">Cancel</button>
          <button class="popup-btn ${confirmClass}"      data-action="confirm">${escapeHtml(confirmLabel)}</button>
        </div>
      `,
      focusSel: "[data-action='cancel']",
      escKeys: ["Escape"],
    });

    dlg
      .querySelector("[data-action='cancel']")
      .addEventListener("click", () => dismiss());
    dlg
      .querySelector("[data-action='confirm']")
      .addEventListener("click", () => dismiss(onConfirm));
  },

  /**
   * Confirm a destructive entity delete (a whole collection, environment, …).
   *
   * The single shared entry point for the heavier deletes that still warrant a
   * blocking dialog — callers supply only the entity-specific title and lead
   * message; the shared backup reminder is appended for every one so they all
   * warn the same way.
   *
   * @param {{
   *   title:     string,
   *   message:   string,
   *   onConfirm: () => void,
   * }} opts
   */
  confirmDelete({ title, message, onConfirm }) {
    this.confirm({
      title,
      message,
      note: "Take a backup beforehand if you may need to restore it — this cannot be undone otherwise.",
      confirmLabel: "Delete",
      confirmClass: "popup-btn--danger",
      onConfirm,
    });
  },

  /**
   * Display a blocking confirmation dialog on top of the current popup.
   * Calls `onConfirm` if the user selects "Discard".
   *
   * @param {() => void} onConfirm  Called when the user chooses to discard changes
   */
  confirmClose(onConfirm) {
    if (_confirmOpen) _closeConfirmIfOpen();
    _ensureMask();
    _ensureConfirm();

    _confirmOpen = true;
    document.body.appendChild(_confirmEl);

    requestAnimationFrame(() => {
      _confirmEl.classList.add("popup--visible");
    });

    const keepBtn = _confirmEl.querySelector("#pm-confirm-keep");
    const discardBtn = _confirmEl.querySelector("#pm-confirm-discard");

    function cleanup() {
      _confirmOpen = false;
      _confirmEl.classList.remove("popup--visible");

      const onEnd = () => {
        _confirmEl.removeEventListener("transitionend", onEnd);
        if (_confirmEl.parentNode)
          _confirmEl.parentNode.removeChild(_confirmEl);
      };
      _confirmEl.addEventListener("transitionend", onEnd);
      setTimeout(() => {
        if (!_confirmEl) return;
        _confirmEl.removeEventListener("transitionend", onEnd);
        if (_confirmEl.parentNode)
          _confirmEl.parentNode.removeChild(_confirmEl);
      }, 400);

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
    _confirmCleanup = cleanup;

    // Focus the safe "Keep editing" button by default
    requestAnimationFrame(() => keepBtn.focus());
  },

  /**
   * Show a variable-resolution warning dialog.
   *
   * Triggered when a request contains {{variable}} placeholders that could
   * not be fully resolved against the active variable context.  Lists every
   * variable found in the request, colour-coded by resolution status:
   *   • resolved   → actual value shown in the success colour
   *   • unresolved → "?" shown in the error colour
   *
   * The user can dismiss (Cancel) or acknowledge and proceed anyway.
   *
   * @param {{
   *   variables:    Array<{ name: string, found: boolean, value: string|null }>,
   *   actionLabel?: string,     label for the "proceed" button  (default: "Send Anyway")
   *   onAction:     () => void  called when the user chooses to proceed
   * }} opts
   */
  warnVariables({
    variables = [],
    actionLabel = "Send Anyway",
    onAction,
  } = {}) {
    const itemsHtml = variables
      .map((v) => {
        const valueCell = v.found
          ? `<span class="var-warn-value var-warn-value--known">${escapeHtml(v.value)}</span>`
          : `<span class="var-warn-value var-warn-value--unknown">?</span>`;
        return `
        <li class="var-warn-item">
          <span class="var-warn-name">{{${escapeHtml(v.name)}}}</span>
          <span class="var-warn-arrow">→</span>
          ${valueCell}
        </li>`;
      })
      .join("");

    const { dlg, dismiss } = _showOneShotDialog({
      cssClass: "popup-var-warn",
      role: "alertdialog",
      ariaLabel: "Unresolved variables",
      innerHTML: `
        <div class="popup-header">
          <span class="popup-title">Unresolved Variables</span>
        </div>
        <div class="popup-body var-warn-body">
          <p class="var-warn-desc">One or more variable placeholders in this request could not be resolved. Review the values below before proceeding.</p>
          <ul class="var-warn-list" role="list">${itemsHtml}</ul>
        </div>
        <div class="popup-footer">
          <button class="popup-btn popup-btn--secondary" data-action="cancel">Cancel</button>
          <button class="popup-btn popup-btn--warning"   data-action="proceed">${escapeHtml(actionLabel)}</button>
        </div>
      `,
      focusSel: "[data-action='cancel']",
    });

    dlg
      .querySelector("[data-action='cancel']")
      .addEventListener("click", () => dismiss());
    dlg
      .querySelector("[data-action='proceed']")
      .addEventListener("click", () => dismiss(onAction));
  },

  /**
   * Show a lightweight informational dialog with a single "OK" button.
   * Does NOT require an active popup — suitable for any in-page notification.
   *
   * @param {{ title?: string, message?: string }} opts
   *   title   — Dialog title (default: "Info")
   *   message — Message text shown in the dialog body
   */
  notify({ title = "Info", message = "", autoCloseMs = 0 } = {}) {
    const { dlg, dismiss } = _showOneShotDialog({
      cssClass: "popup-notify",
      role: "dialog",
      ariaLabel: escapeHtml(title),
      innerHTML: `
        <div class="popup-header">
          <span class="popup-title">${escapeHtml(title)}</span>
        </div>
        <div class="popup-body popup-notify-body">
          ${message ? `<p>${escapeHtml(message)}</p>` : ""}
        </div>
        <div class="popup-footer">
          <button class="popup-btn popup-btn--primary" data-action="ok">OK</button>
        </div>
      `,
      focusSel: "[data-action='ok']",
      escKeys: ["Escape", "Enter"],
    });

    dlg
      .querySelector("[data-action='ok']")
      .addEventListener("click", () => dismiss());

    if (autoCloseMs > 0) setTimeout(() => dismiss(), autoCloseMs);
  },

  /**
   * Show a context / dropdown menu at the given viewport coordinates.
   * The overlay mask is made interactive but transparent — clicking anywhere
   * outside the menu closes it immediately with no confirmation.
   *
   * This is the canonical path for every anchored DOM menu (HTTP-method picker,
   * layout picker, …): callers build the element and pass an anchor point;
   * openMenu handles mount, the click-capturing mask, viewport clamping, and
   * fires wurl:popup-opened / -closed via the shared mask. Components must NOT
   * roll their own outside-click/mount logic. Close with PopupManager.close().
   *
   * Invariant: only open a menu when no other popup is already active. Menus
   * reuse the single _activePopup/mask slot, and the popup-opened/-closed events
   * are coalesced to the mask's visibility — opening a menu on top of an
   * existing popup would skip the second `opened` and unbalance listeners that
   * count popup depth (e.g. response-viewer's native preview overlays).
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
    _maskEl.style.transition = "none";
    _showMask();

    // Position and mount
    element.style.left = `${x}px`;
    element.style.top = `${y}px`;
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
