/**
 * pill-picker-controller.js — the `{{` typeahead lifecycle, shared by both editors.
 *
 * VariablePillEditor and PillCodeEditor both drove the PillPicker the same way —
 * debounced open on a `{{filter` caret, live filter updates while open, caret-
 * anchored placement, an outside-mousedown dismiss, and the app-wide
 * popup-opened/-closed depth signals — with only three genuine per-editor
 * differences. Those are injected; everything else lives here once.
 *
 * Injected deps:
 *   • getRoot()      — the editor's editable root (contenteditable / .pce-doc).
 *       Used to scope the caret filter, the caret-rect fallback, and the
 *       outside-click check to this editor.
 *   • getContext()   — resolved variable context, for the picker's variable list.
 *   • onInsert(raw)  — insert the chosen token at the caret (the editor owns how).
 *   • debounceMs()   — open debounce (VPE: the configurable global; PCE: a const).
 *
 * Keyboard navigation stays in the host's keydown handler, which forwards to the
 * controller's isOpen()/selectNext()/selectPrev()/getSelected() (thin pass-throughs
 * to the live PillPicker), exactly as it forwarded to the picker instance before.
 */
"use strict";

import { PillPicker } from "./pill-picker.js";
import { pickerScopes, pickerFunctions } from "./pill-picker-data.js";

export class PillPickerController {
  #deps;
  #timer = null;
  #inst = null;
  #outside = null;

  constructor(deps) {
    this.#deps = deps;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  /**
   * (Re)evaluate the caret: dismiss when there's no `{{` trigger, live-update the
   * open picker's filter, or arm the debounced open.
   */
  schedule() {
    clearTimeout(this.#timer);
    const filter = this.#filter();
    if (filter === null) {
      this.close();
      return;
    }
    if (this.#inst) {
      this.#inst.updateFilter(filter, this.#variables(), pickerFunctions());
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = null;
      const f = this.#filter();
      if (f === null) return;
      const rect = this.#caretRect();
      if (rect) this.#open(f, rect);
    }, this.#deps.debounceMs());
  }

  /** Tear down the picker (and pending open) and balance the popup-opened signal. */
  close() {
    clearTimeout(this.#timer);
    this.#timer = null;
    const wasOpen = !!this.#inst;
    if (this.#inst) {
      this.#inst.destroy();
      this.#inst = null;
    }
    if (this.#outside) {
      document.removeEventListener("mousedown", this.#outside, true);
      this.#outside = null;
    }
    // Balance the hippo:popup-opened dispatched in #open (depth-counted by
    // ResponseViewer); only when a picker was actually open.
    if (wasOpen) window.dispatchEvent(new CustomEvent("hippo:popup-closed"));
  }

  // ── Keyboard pass-throughs (driven by the host's keydown handler) ─────────────

  isOpen() {
    return !!this.#inst;
  }
  selectNext() {
    this.#inst?.selectNext();
  }
  selectPrev() {
    this.#inst?.selectPrev();
  }
  getSelected() {
    return this.#inst?.getSelected() ?? null;
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  #variables() {
    return pickerScopes(this.#deps.getContext());
  }

  /**
   * The filter text between the nearest `{{` and a collapsed caret in this
   * editor's text, or null when the caret isn't inside an open `{{…` run.
   */
  #filter() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!range.collapsed || range.startContainer.nodeType !== Node.TEXT_NODE)
      return null;
    if (!this.#deps.getRoot().contains(range.startContainer)) return null;
    const before = range.startContainer.textContent.slice(0, range.startOffset);
    const openIdx = before.lastIndexOf("{{");
    if (openIdx === -1) return null;
    const between = before.slice(openIdx + 2);
    return between.includes("}}") ? null : between;
  }

  /** Viewport point just below the caret, falling back to the editor root. */
  #caretRect() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const r = sel.getRangeAt(0).cloneRange();
    r.collapse(true);
    const rects = r.getClientRects();
    if (rects.length) return { x: rects[0].left, y: rects[0].bottom };
    const er = this.#deps.getRoot().getBoundingClientRect();
    return { x: er.left, y: er.bottom };
  }

  #open(filter, rect) {
    this.close();
    this.#inst = new PillPicker({
      x: rect.x,
      y: rect.y,
      filter,
      variables: this.#variables(),
      functions: pickerFunctions(),
      onSelect: (item) => this.#deps.onInsert(item.rawToken),
      onClose: () => this.close(),
    });
    document.body.appendChild(this.#inst.element);
    // Notify app-wide listeners so ResponseViewer hides its native HTML/PDF
    // preview overlay, which would otherwise render above this typeahead.
    window.dispatchEvent(new CustomEvent("hippo:popup-opened"));
    this.#outside = (e) => {
      if (
        !this.#inst?.element.contains(e.target) &&
        !this.#deps.getRoot().contains(e.target)
      )
        this.close();
    };
    document.addEventListener("mousedown", this.#outside, true);
  }
}
