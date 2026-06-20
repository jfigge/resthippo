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
 * zoom-handlers.js — UI font-size ("zoom") event-bus handlers.
 *
 * Owns the three input paths that step the global UI font size: Ctrl/Cmd + wheel
 * or pinch, the Ctrl/Cmd + '+' / '-' / '0' keyboard shortcuts, and the
 * `hippo:ui-font-change` events the Electron menu re-dispatches. Also wires
 * Cmd/Ctrl+Enter to send the active request (it shares the capture-phase keydown
 * concern and must fire from inside the URL editor). Extracted verbatim from
 * app.js so the bootstrap stays a thin coordinator.
 *
 * Shared state is reached through the bus context (`ctx`, built by
 * buildBusContext() in app.js).
 *
 * @param {object} ctx
 * @param {() => object} ctx.getSettings            live settings object
 * @param {(patch: object) => void} ctx.updateSettings
 * @param {(settings: object) => void} ctx.applySettings
 * @param {() => object|null} ctx.getRequestEditor   the live RequestEditor instance
 */
export function installZoomHandlers(ctx) {
  // These values must stay in sync with the <option> elements in settings-popup.js.
  const FONT_SIZES = [9, 11, 12, 13, 14, 16, 18, 20];
  const DEFAULT_FONT = 13; // matches DEFAULT_SETTINGS.fontSize in data-store.js

  /**
   * Advance the font size by `direction` steps (+1 = larger, -1 = smaller).
   * If the current value is not in the list, the nearest entry is used as the
   * starting point.  Silently no-ops when already at the boundary.
   */
  function changeFontByStep(direction) {
    const current = ctx.getSettings().fontSize ?? DEFAULT_FONT;

    // Locate current value in the allowed list; snap to nearest if not found.
    let idx = FONT_SIZES.indexOf(current);
    if (idx === -1) {
      const nearest = FONT_SIZES.reduce((prev, cur) =>
        Math.abs(cur - current) < Math.abs(prev - current) ? cur : prev,
      );
      idx = FONT_SIZES.indexOf(nearest);
    }

    const nextIdx = Math.max(
      0,
      Math.min(FONT_SIZES.length - 1, idx + direction),
    );
    const newSize = FONT_SIZES[nextIdx];
    if (newSize === current) return; // already at min/max limit

    ctx.updateSettings({ fontSize: newSize });
    ctx.applySettings(ctx.getSettings());
  }

  /** Reset to the default font size. */
  function resetFont() {
    if ((ctx.getSettings().fontSize ?? DEFAULT_FONT) === DEFAULT_FONT) return;
    ctx.updateSettings({ fontSize: DEFAULT_FONT });
    ctx.applySettings(ctx.getSettings());
  }

  // ── Wheel / Pinch ────────────────────────────────────────────────────────────
  // Must be registered as non-passive so preventDefault() stops the browser
  // from performing its native visual zoom.  On macOS, two-finger pinch is
  // delivered to Chromium as a wheel event with ctrlKey=true.
  window.addEventListener(
    "wheel",
    (e) => {
      if (!(e.ctrlKey || e.metaKey)) return; // only intercept zoom-modifier combos

      e.preventDefault();
      e.stopPropagation();

      // Negative deltaY = scroll/pinch toward "zoom in"; positive = "zoom out".
      changeFontByStep(e.deltaY < 0 ? +1 : -1);
    },
    { passive: false, capture: true },
  );

  // ── Keyboard shortcuts ───────────────────────────────────────────────────────
  // Intercept Ctrl/Cmd + '+' / '-' / '0' before Chromium or the OS menu picks
  // them up.  Registered in the capture phase so they fire before editor widgets.
  window.addEventListener(
    "keydown",
    (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;

      // Allow normal key combos inside editable inputs/textareas.
      const tag = e.target?.tagName ?? "";
      if (["INPUT", "TEXTAREA"].includes(tag) || e.target?.isContentEditable)
        return;

      // Both '+' (shift+= US layout) and '=' map to zoom-in; '-' maps to zoom-out.
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        e.stopPropagation();
        changeFontByStep(+1);
      } else if (e.key === "-") {
        e.preventDefault();
        e.stopPropagation();
        changeFontByStep(-1);
      } else if (e.key === "0") {
        e.preventDefault();
        e.stopPropagation();
        resetFont();
      }
    },
    { capture: true },
  );

  // ── Cmd/Ctrl+Enter — send the active request ─────────────────────────────────
  window.addEventListener(
    "keydown",
    (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.key !== "Enter") return;
      e.preventDefault();
      e.stopPropagation();
      ctx.getRequestEditor()?.element?.querySelector(".req-send-btn")?.click();
    },
    { capture: true },
  );

  // ── Electron menu items (main → preload → renderer) ──────────────────────────
  // The Electron main process replaced the native zoomIn/zoomOut/resetZoom menu
  // roles with custom items that send "hippo:ui-font-change" via webContents.send().
  // preload.js re-dispatches these as window CustomEvents so we can handle them here.
  window.addEventListener("hippo:ui-font-change", (e) => {
    const direction = e.detail;
    if (direction === "in") changeFontByStep(+1);
    else if (direction === "out") changeFontByStep(-1);
    else if (direction === "reset") resetFont();
  });
}
