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
 * scripts-editor.js — the Scripts request tab (Feature 25).
 *
 * Two JavaScript code panes — a pre-request script (runs before send) and an
 * after-response script (runs after receive) — persisted on the request node.
 * A delegated sub-editor like NotesEditor / CapturesEditor: it owns the two
 * script strings, their per-pane enabled flags and the drag-splitter ratio, and
 * reports edits through the injected `onChange` callback, which the host
 * (RequestEditor) turns into the request-updated event.
 *
 * The panes reuse the shared PillCodeEditor via the injected `makeCodeEditor`
 * factory (so they register in the host's editor set for disposal + view-setting
 * sync). Highlighting is JavaScript; validation is host-driven — each pane runs
 * the source through the main-process compiler (`hippo.script.validate`) on a
 * debounce and pushes any syntax error back as an inline squiggle via setErrors().
 * A draggable splitter between the panes resizes them; the ratio is persisted.
 */
"use strict";

import { t } from "../../i18n.js";
import { wireScriptAutocomplete } from "./script-autocomplete.js";

/** Debounce (ms) before a pane re-validates after a keystroke. */
const VALIDATE_DEBOUNCE_MS = 400;
/** Pre-pane height as a % of the container, clamped so neither pane collapses. */
const SPLIT_MIN = 12;
const SPLIT_MAX = 88;
/** px floor per pane while dragging the splitter. */
const PANE_MIN_PX = 48;

export class ScriptsEditor {
  #makeCodeEditor;
  #onChange;
  #pre = "";
  #post = "";
  #preEnabled = true;
  #postEnabled = true;
  #split = 50; // pre-pane height, % of the container
  #preEditor = null; // PillCodeEditor while mounted
  #postEditor = null;
  #prePane = null;
  #postPane = null;
  #preCheckbox = null;
  #postCheckbox = null;
  #container = null;
  #preTimer = null;
  #postTimer = null;

  /**
   * @param {{ makeCodeEditor: (opts:object)=>object, onChange?: ()=>void }} deps
   *   makeCodeEditor — the host factory (registers the editor for disposal).
   */
  constructor({ makeCodeEditor, onChange } = {}) {
    this.#makeCodeEditor = makeCodeEditor;
    this.#onChange = onChange;
  }

  /**
   * @returns {{ preRequestScript, afterResponseScript,
   *            preRequestScriptEnabled, afterResponseScriptEnabled, scriptSplit }}
   */
  getValue() {
    return {
      preRequestScript: this.#pre,
      afterResponseScript: this.#post,
      preRequestScriptEnabled: this.#preEnabled,
      afterResponseScriptEnabled: this.#postEnabled,
      scriptSplit: Math.round(this.#split),
    };
  }

  /**
   * @param {{ preRequestScript?, afterResponseScript?, preRequestScriptEnabled?,
   *          afterResponseScriptEnabled?, scriptSplit? }} v
   */
  setValue(v) {
    this.#pre = v?.preRequestScript ?? "";
    this.#post = v?.afterResponseScript ?? "";
    // Default enabled = true so existing scripts keep running (no flag stored).
    this.#preEnabled = v?.preRequestScriptEnabled !== false;
    this.#postEnabled = v?.afterResponseScriptEnabled !== false;
    this.#split =
      typeof v?.scriptSplit === "number" && isFinite(v.scriptSplit)
        ? v.scriptSplit
        : 50;
    if (this.#preEditor) this.#preEditor.setValue(this.#pre);
    if (this.#postEditor) this.#postEditor.setValue(this.#post);
    if (this.#preCheckbox) this.#preCheckbox.checked = this.#preEnabled;
    if (this.#postCheckbox) this.#postCheckbox.checked = this.#postEnabled;
    this.#applySplit();
    this.#applyEnabledDim();
    // The just-loaded source may differ from what was shown — re-check both.
    this.#validate(this.#preEditor, this.#pre);
    this.#validate(this.#postEditor, this.#post);
  }

  /**
   * Called by the host when the Scripts tab becomes visible. Validation runs on
   * load while the tab is still hidden, where zero-size rects suppress squiggle
   * rendering; re-render the markers now that the panes have layout.
   */
  onShown() {
    this.#preEditor?.refreshMarkers();
    this.#postEditor?.refreshMarkers();
  }

  /** Build (or rebuild) the Scripts tab-pane element. */
  build() {
    const container = document.createElement("div");
    container.className = "params-editor scripts-editor";
    this.#container = container;

    const prePane = this.#buildPane(
      "pre",
      t("script.preLabel"),
      t("script.prePlaceholder"),
      this.#pre,
      (val) => {
        this.#pre = val;
        this.#onChange?.();
        this.#scheduleValidate("pre");
      },
    );
    container.appendChild(prePane);

    const splitter = document.createElement("div");
    splitter.className = "splitter splitter--v scripts-splitter";
    splitter.setAttribute("role", "separator");
    splitter.setAttribute("aria-orientation", "horizontal");
    splitter.setAttribute("aria-label", t("script.resizeAria"));
    splitter.tabIndex = 0;
    container.appendChild(splitter);

    const postPane = this.#buildPane(
      "post",
      t("script.postLabel"),
      t("script.postPlaceholder"),
      this.#post,
      (val) => {
        this.#post = val;
        this.#onChange?.();
        this.#scheduleValidate("post");
      },
    );
    container.appendChild(postPane);

    this.#wireSplitter(splitter);
    this.#applySplit();
    this.#applyEnabledDim();

    // Validate whatever was preloaded so a stored syntax error shows immediately.
    this.#validate(this.#preEditor, this.#pre);
    this.#validate(this.#postEditor, this.#post);
    return container;
  }

  /** Build one labelled code pane (header: label + enable checkbox). */
  #buildPane(which, label, placeholder, value, onInput) {
    const isPre = which === "pre";
    const pane = document.createElement("div");
    pane.className = "scripts-pane";

    const header = document.createElement("div");
    header.className = "scripts-pane-label";
    const labelText = document.createElement("span");
    labelText.className = "scripts-pane-label-text";
    labelText.textContent = label;
    header.appendChild(labelText);

    const enable = document.createElement("label");
    enable.className = "scripts-enable";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "scripts-enable-checkbox";
    checkbox.checked = isPre ? this.#preEnabled : this.#postEnabled;
    checkbox.addEventListener("change", () => {
      if (isPre) this.#preEnabled = checkbox.checked;
      else this.#postEnabled = checkbox.checked;
      this.#applyEnabledDim();
      this.#onChange?.();
    });
    const enableText = document.createElement("span");
    enableText.textContent = t("script.enabled");
    enable.appendChild(checkbox);
    enable.appendChild(enableText);
    header.appendChild(enable);

    pane.appendChild(header);

    let editor;
    editor = this.#makeCodeEditor({
      language: "javascript",
      externalErrors: true,
      richErrors: true,
      value,
      placeholder,
      onInput: (v) => {
        onInput(v);
        editor?._hippoRefresh?.();
      },
      onCaret: () => editor?._hippoRefresh?.(),
    });
    wireScriptAutocomplete(editor);
    pane.appendChild(editor.element);

    if (isPre) {
      this.#preEditor = editor;
      this.#prePane = pane;
      this.#preCheckbox = checkbox;
    } else {
      this.#postEditor = editor;
      this.#postPane = pane;
      this.#postCheckbox = checkbox;
    }
    return pane;
  }

  /** Dim a pane's editor when its script is disabled (it won't run). */
  #applyEnabledDim() {
    this.#prePane?.classList.toggle(
      "scripts-pane--disabled",
      !this.#preEnabled,
    );
    this.#postPane?.classList.toggle(
      "scripts-pane--disabled",
      !this.#postEnabled,
    );
  }

  /** Size the two panes from the stored split ratio. */
  #applySplit() {
    if (!this.#prePane || !this.#postPane) return;
    const pct = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, this.#split));
    this.#prePane.style.flex = `0 0 ${pct}%`;
    this.#postPane.style.flex = "1 1 0";
  }

  /** Make the splitter draggable (mouse/touch) + keyboard-resizable (↑/↓). */
  #wireSplitter(splitterEl) {
    const apply = (prePx) => {
      const total = this.#container?.clientHeight ?? 0;
      if (total <= 0) return;
      const splitterH = splitterEl.offsetHeight || 6;
      const max = total - PANE_MIN_PX - splitterH;
      const clamped = Math.min(max, Math.max(PANE_MIN_PX, prePx));
      this.#split = (clamped / total) * 100;
      this.#applySplit();
    };

    let dragging = false;
    const onMove = (e) => {
      if (!dragging) return;
      if (e.cancelable) e.preventDefault();
      const y = (e.touches ? e.touches[0] : e).clientY;
      apply(y - this.#container.getBoundingClientRect().top);
    };
    const onEnd = () => {
      if (!dragging) return;
      dragging = false;
      splitterEl.classList.remove("splitter--dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onEnd);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      this.#onChange?.(); // persist the new ratio
    };
    const onStart = (e) => {
      e.preventDefault();
      dragging = true;
      splitterEl.classList.add("splitter--dragging");
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
    };

    splitterEl.addEventListener("mousedown", (e) => {
      onStart(e);
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onEnd);
    });
    splitterEl.addEventListener(
      "touchstart",
      (e) => {
        onStart(e);
        window.addEventListener("touchmove", onMove, { passive: false });
        window.addEventListener("touchend", onEnd);
      },
      { passive: false },
    );

    splitterEl.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      const total = this.#container?.clientHeight ?? 0;
      if (total <= 0) return;
      const step = e.shiftKey ? 48 : 16;
      apply(
        (this.#split / 100) * total + (e.key === "ArrowDown" ? step : -step),
      );
      this.#onChange?.();
    });
  }

  #scheduleValidate(which) {
    const isPre = which === "pre";
    clearTimeout(isPre ? this.#preTimer : this.#postTimer);
    const timer = setTimeout(() => {
      const editor = isPre ? this.#preEditor : this.#postEditor;
      this.#validate(editor, isPre ? this.#pre : this.#post);
    }, VALIDATE_DEBOUNCE_MS);
    if (isPre) this.#preTimer = timer;
    else this.#postTimer = timer;
  }

  /**
   * Compile the source in the main-process sandbox and push any syntax error
   * back to the pane as an inline squiggle. Guarded for non-Electron / test
   * contexts where the bridge is absent (validation simply no-ops there).
   */
  async #validate(editor, code) {
    if (!editor) return;
    const validate = window.hippo?.script?.validate;
    if (typeof validate !== "function") return;
    let res;
    try {
      res = await validate(code ?? "");
    } catch {
      return; // bridge failure — leave existing markers untouched
    }
    const err = res?.error;
    editor.setErrors(
      err
        ? [
            {
              line: err.line ?? 1,
              col: err.col ?? 1,
              length: 1,
              message: err.message,
            },
          ]
        : [],
    );
  }
}
