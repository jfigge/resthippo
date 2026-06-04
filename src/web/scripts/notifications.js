/**
 * notifications.js — Singleton toast / notification surface for the renderer.
 *
 * The one app-wide way to tell the user something happened. Before this module
 * the renderer had no way to surface a failure: persistence errors were logged
 * to a console the user can't see while the UI proceeded as if the action had
 * succeeded (silent data loss). Toasts close that gap.
 *
 * Levels and behaviour:
 *   error    — red.   Persistent (no auto-dismiss); manual dismiss + optional
 *                     action button. Announced via an aria-live="assertive" region.
 *   warning  — amber. Auto-dismisses; announced politely.
 *   info     — blue.  Auto-dismisses; announced politely.
 *   success  — green. Auto-dismisses; announced politely.
 *
 * Accessibility (coordinates with Feature 48):
 *   – Two persistent live regions are mounted up front: one assertive (errors),
 *     one polite (everything else). Inserting a toast into a region that already
 *     exists in the DOM is what makes screen readers announce it.
 *   – Every toast carries a real <button> close control, so it is keyboard
 *     dismissible; Escape also dismisses a toast while focus is inside it.
 *
 * Usage:
 *   import { Notifications } from "./notifications.js";
 *
 *   Notifications.error("Could not save your changes.");
 *   Notifications.success("Collection imported.");
 *   Notifications.error("Save failed.", {
 *     title: "Disk full",
 *     actionLabel: "Retry",
 *     onAction: () => retry(),
 *   });
 */

"use strict";

import { icon } from "./icons.js";
import { escapeHtml } from "./utils/html.js";

// ── Configuration ─────────────────────────────────────────────────────────────

/** Per-level presentation + default behaviour. */
const LEVELS = {
  error: { iconName: "error", assertive: true, defaultDuration: 0 },
  warning: { iconName: "warning", assertive: false, defaultDuration: 6000 },
  info: { iconName: "info", assertive: false, defaultDuration: 4000 },
  success: { iconName: "check", assertive: false, defaultDuration: 4000 },
};

/** Most toasts shown at once before the oldest auto-expires to make room. */
const MAX_VISIBLE = 5;

// ── Private state ─────────────────────────────────────────────────────────────

/** @type {HTMLElement | null} container holding both live regions */
let _root = null;

/** @type {HTMLElement | null} aria-live="assertive" region (errors) */
let _assertiveRegion = null;

/** @type {HTMLElement | null} aria-live="polite" region (warning/info/success) */
let _politeRegion = null;

/** Live toasts in insertion order, so MAX_VISIBLE can evict the oldest. */
const _toasts = [];

// ── DOM bootstrap ─────────────────────────────────────────────────────────────

/**
 * Create the toast container and its two live regions once, lazily. Both regions
 * must be present in the DOM before any toast is inserted so assistive tech picks
 * up the mutation.
 */
function _ensureRoot() {
  if (_root) return;

  _root = document.createElement("div");
  _root.className = "toast-region";

  _assertiveRegion = document.createElement("div");
  _assertiveRegion.className = "toast-stack toast-stack--assertive";
  _assertiveRegion.setAttribute("role", "alert");
  _assertiveRegion.setAttribute("aria-live", "assertive");
  _assertiveRegion.setAttribute("aria-relevant", "additions");

  _politeRegion = document.createElement("div");
  _politeRegion.className = "toast-stack toast-stack--polite";
  _politeRegion.setAttribute("role", "status");
  _politeRegion.setAttribute("aria-live", "polite");
  _politeRegion.setAttribute("aria-relevant", "additions");

  _root.appendChild(_assertiveRegion);
  _root.appendChild(_politeRegion);
  document.body.appendChild(_root);
}

// ── Toast lifecycle ───────────────────────────────────────────────────────────

/**
 * Remove a toast: animate out, detach, and drop it from the registry. Safe to
 * call more than once for the same toast (later calls are no-ops).
 * @param {{ el: HTMLElement, timer: number|null, removed: boolean }} entry
 */
function _dismiss(entry) {
  if (entry.removed) return;
  entry.removed = true;
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  const idx = _toasts.indexOf(entry);
  if (idx !== -1) _toasts.splice(idx, 1);

  const { el } = entry;
  el.classList.remove("toast--visible");
  el.classList.add("toast--leaving");

  const onEnd = () => {
    el.removeEventListener("transitionend", onEnd);
    if (el.parentNode) el.parentNode.removeChild(el);
  };
  el.addEventListener("transitionend", onEnd);
  // Safety fallback in case transitionend never fires (e.g. reduced-motion).
  setTimeout(() => {
    el.removeEventListener("transitionend", onEnd);
    if (el.parentNode) el.parentNode.removeChild(el);
  }, 400);
}

/**
 * Build and mount one toast.
 *
 * @param {{
 *   level:        "error"|"warning"|"info"|"success",
 *   message:      string,
 *   title?:       string,
 *   actionLabel?: string,
 *   onAction?:    () => void,
 *   duration?:    number,        Override auto-dismiss ms; 0 = persistent
 * }} opts
 * @returns {() => void} a dismiss function for the caller
 */
function _show({ level, message, title, actionLabel, onAction, duration }) {
  _ensureRoot();

  const spec = LEVELS[level] ?? LEVELS.info;
  const region = spec.assertive ? _assertiveRegion : _politeRegion;

  const el = document.createElement("div");
  el.className = `toast toast--${level}`;

  const actionHtml =
    actionLabel && typeof onAction === "function"
      ? `<button type="button" class="toast-action" data-action="custom">${escapeHtml(
          actionLabel,
        )}</button>`
      : "";
  const titleHtml = title
    ? `<p class="toast-title">${escapeHtml(title)}</p>`
    : "";

  el.innerHTML = `
    <span class="toast-icon">${icon(spec.iconName, { size: 18 })}</span>
    <div class="toast-content">
      ${titleHtml}
      <p class="toast-message">${escapeHtml(message)}</p>
    </div>
    <div class="toast-controls">
      ${actionHtml}
      <button type="button" class="toast-close" data-action="dismiss" aria-label="Dismiss notification">
        ${icon("close", { size: 14 })}
      </button>
    </div>
  `;

  const entry = { el, timer: null, removed: false };
  _toasts.push(entry);

  // Evict the oldest toast once the stack grows past the cap so the surface
  // never buries the screen.
  while (_toasts.length > MAX_VISIBLE) _dismiss(_toasts[0]);

  region.appendChild(el);
  requestAnimationFrame(() => el.classList.add("toast--visible"));

  // ── Wire dismissal ──────────────────────────────────────────────────────
  el.querySelector("[data-action='dismiss']").addEventListener("click", () =>
    _dismiss(entry),
  );

  const actionBtn = el.querySelector("[data-action='custom']");
  if (actionBtn) {
    actionBtn.addEventListener("click", () => {
      _dismiss(entry);
      onAction();
    });
  }

  // Escape dismisses the toast while focus is within it (keyboard a11y).
  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape") _dismiss(entry);
  });

  // ── Auto-dismiss (non-errors), paused while hovered or focused ──────────
  const ms = duration ?? spec.defaultDuration;
  if (ms > 0) {
    const arm = () => {
      entry.timer = setTimeout(() => _dismiss(entry), ms);
    };
    const pause = () => {
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
    };
    el.addEventListener("mouseenter", pause);
    el.addEventListener("mouseleave", () => {
      if (!entry.removed) arm();
    });
    el.addEventListener("focusin", pause);
    el.addEventListener("focusout", () => {
      if (!entry.removed) arm();
    });
    arm();
  }

  return () => _dismiss(entry);
}

// ── Public API ────────────────────────────────────────────────────────────────

export const Notifications = {
  /**
   * Low-level entry point. Prefer the level-specific helpers below.
   * @param {{ level, message, title?, actionLabel?, onAction?, duration? }} opts
   * @returns {() => void} dismiss function
   */
  show(opts) {
    return _show(opts);
  },

  /**
   * Show an error toast. Persistent by default (no auto-dismiss) since errors are
   * actionable; pass `duration` to override.
   * @param {string} message
   * @param {{ title?: string, actionLabel?: string, onAction?: () => void, duration?: number }} [opts]
   * @returns {() => void} dismiss function
   */
  error(message, opts = {}) {
    return _show({ level: "error", message, ...opts });
  },

  /**
   * Show a warning toast (auto-dismisses).
   * @param {string} message
   * @param {{ title?: string, actionLabel?: string, onAction?: () => void, duration?: number }} [opts]
   * @returns {() => void} dismiss function
   */
  warning(message, opts = {}) {
    return _show({ level: "warning", message, ...opts });
  },

  /**
   * Show an informational toast (auto-dismisses).
   * @param {string} message
   * @param {{ title?: string, duration?: number }} [opts]
   * @returns {() => void} dismiss function
   */
  info(message, opts = {}) {
    return _show({ level: "info", message, ...opts });
  },

  /**
   * Show a success toast (auto-dismisses).
   * @param {string} message
   * @param {{ title?: string, duration?: number }} [opts]
   * @returns {() => void} dismiss function
   */
  success(message, opts = {}) {
    return _show({ level: "success", message, ...opts });
  },

  /** Dismiss every visible toast (e.g. on teardown). */
  dismissAll() {
    for (const entry of [..._toasts]) _dismiss(entry);
  },
};
