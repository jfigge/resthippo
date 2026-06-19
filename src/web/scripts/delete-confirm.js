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

/* delete-confirm.js — the one shared trash-delete confirmation behaviour.
 *
 * Every trash-can delete control in the app is wired through wireDeleteConfirm()
 * so they all confirm the same way: the resting control shows a trash-can; the
 * first click swaps it for a question mark and arms it; a second click on the
 * question mark runs the delete. Clicking anywhere else, or pressing Escape,
 * cancels and restores the trash-can.
 *
 *   wireDeleteConfirm(btn, () => removeRow(id))
 *   wireDeleteConfirm(span, () => removeEntry(id), { size: 12 })
 *
 * The control owns its own icon — callers do not set innerHTML themselves.
 * Text-label controls (e.g. a "Delete All" button) can opt out of the icons by
 * passing restingHtml / confirmHtml instead:
 *
 *   wireDeleteConfirm(btn, () => clearAll(), { restingHtml: "Delete All", confirmHtml: "Confirm?" })
 */

import { icon } from "./icons.js";

/**
 * Wire a delete control so it requires a confirming second click.
 *
 * Works on any element (a <button>, or a role="button" <span>); keyboard
 * activation (Enter / Space) follows the same arm-then-confirm flow so the
 * control is usable without a mouse.
 *
 * @param {HTMLElement} el          the delete control
 * @param {() => void}  onConfirm   run once the user confirms the delete
 * @param {object}      [opts]
 * @param {number}      [opts.size=13]      icon size in px (ignored if restingHtml/confirmHtml given)
 * @param {string}      [opts.restingHtml]  resting-state markup (defaults to the trash icon)
 * @param {string}      [opts.confirmHtml]  armed-state markup (defaults to the question icon)
 * @returns {() => void} a cancel function that disarms and restores the icon
 */
export function wireDeleteConfirm(el, onConfirm, opts = {}) {
  const size = opts.size ?? 13;
  const trashMarkup = opts.restingHtml ?? icon("trash", { size });
  const questionMarkup = opts.confirmHtml ?? icon("question", { size });

  // Non-null only while armed; calling it disarms + restores the trash icon.
  let disarm = null;

  const restore = () => {
    el.innerHTML = trashMarkup;
    el.classList.remove("delete-confirm--armed");
    document.removeEventListener("mousedown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
    disarm = null;
  };

  const onOutside = (e) => {
    if (!el.contains(e.target)) restore();
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      restore();
    }
  };

  const arm = () => {
    el.innerHTML = questionMarkup;
    el.classList.add("delete-confirm--armed");
    // Capture phase so an outside click cancels before any other handler acts.
    document.addEventListener("mousedown", onOutside, true);
    document.addEventListener("keydown", onKey, true);
    disarm = restore;
  };

  const activate = (e) => {
    e.stopPropagation();
    if (disarm) {
      disarm();
      onConfirm();
    } else {
      arm();
    }
  };

  el.innerHTML = trashMarkup;
  el.addEventListener("click", activate);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activate(e);
    }
  });

  return () => disarm?.();
}
