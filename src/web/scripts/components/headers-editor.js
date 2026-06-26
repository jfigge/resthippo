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
 * headers-editor.js — reusable key/value Headers editor.
 *
 * This is the exact request-Headers editor (bulk-textarea / KV-row toggle, drag
 * reorder, and the standard-header name/value autocomplete) lifted into a
 * standalone component so the collection-level "default headers" tab
 * (collections-popup.js) and the request editor offer an identical surface. It
 * is built on the shared primitives in kv-editor-shared.js and the suggestion
 * machinery in header-suggestions.js — the same pieces RequestEditor uses.
 *
 * The header VALUE field is a {@link VariablePillEditor} so `{{var}}` tokens
 * still render as pills, validated against whatever `getContext()` returns. The
 * request-response picker hooks (getItems / ensureResponseCaches) are
 * intentionally omitted: a collection-level default header is shared across every
 * request, so referencing one request's response makes no sense at this scope.
 *
 * Usage:
 *   const editor = new HeadersEditor({
 *     getContext: () => variableContext,         // for {{var}} pill validation
 *     onChange:   (rows) => persist(rows),        // [{id,name,value,enabled}]
 *   });
 *   mount.appendChild(editor.element);
 *   editor.setHeaders(collection.headers);
 */

"use strict";

import { icon } from "../icons.js";
import { t } from "../i18n.js";
import {
  DragReorderController,
  buildToolbarToggle,
  buildKvRow,
  wireDeleteAllConfirm,
  headerRowsToText,
  textToHeaderRows,
  disposePillEditors,
} from "./kv-editor-shared.js";
import { VariablePillEditor } from "./variable-pill-editor.js";
import {
  STANDARD_HEADERS_DICT,
  hdrAc,
  hdrVal,
  showHdrDropdown,
  hdrDropdownAccept,
  showHdrValDropdown,
  hdrValDropdownAccept,
  hdrValDropdownVisible,
} from "./header-suggestions.js";

export class HeadersEditor {
  /** @type {HTMLElement} */
  #el;
  /** @type {{ id:string, name:string, value:string, enabled:boolean }[]} */
  #rows = [];
  #bulkMode = false;
  #suggestionsEnabled;
  /** @type {VariablePillEditor[]} */
  #pillEditors = [];
  #getContext;
  #onChange;
  #drag;

  // ── Element refs (set in #build) ───────────────────────────────────────────
  #bulkEl = null;
  #kvWrapEl = null;
  #listEl = null;
  #addBtnEl = null;
  #delAllBtnEl = null;
  #listHdrLabelEl = null;
  #listHdrSpacerEl = null;
  #deleteAllCleanup = null;

  /**
   * @param {{
   *   getContext?: () => object|null,
   *   onChange?: (rows: {id:string,name:string,value:string,enabled:boolean}[]) => void,
   *   suggestionsEnabled?: boolean,
   * }} [opts]
   */
  constructor({
    getContext = () => null,
    onChange = null,
    suggestionsEnabled = true,
  } = {}) {
    this.#getContext = getContext;
    this.#onChange = onChange;
    this.#suggestionsEnabled = suggestionsEnabled;
    this.#drag = new DragReorderController({
      getItems: () => this.#rows,
      render: () => this.#renderList(),
      dispatch: () => this.#emitChange(),
    });
    this.#el = this.#build();
    this.#applyBulkMode();
    this.#renderList();
  }

  /** Root DOM element — mount this into the host container. */
  get element() {
    return this.#el;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Load rows (any tolerant shape) and re-render. Does NOT fire onChange. */
  setHeaders(rows) {
    this.#rows = HeadersEditor.#normalize(rows);
    if (this.#bulkMode && this.#bulkEl) {
      this.#bulkEl.value = headerRowsToText(this.#rows);
    }
    this.#renderList();
  }

  /** Current rows as a fresh array of `{id,name,value,enabled}`. */
  getHeaders() {
    return this.#rows.map((r) => ({ ...r }));
  }

  /** Re-validate the value pills after the variable context changes. */
  setVariableContext() {
    for (const ed of this.#pillEditors) ed.revalidate();
  }

  /** Mirror the "show column headers" appearance setting (params-header-row). */
  applySettings({ removeHeaders } = {}) {
    if (removeHeaders === undefined) return;
    const hdr = this.#el.querySelector(".params-header-row");
    if (hdr) hdr.style.display = removeHeaders ? "none" : "";
  }

  /** Tear down pill editors + drag wiring; call before discarding the editor. */
  destroy() {
    disposePillEditors(this.#pillEditors);
    this.#drag.reset();
    this.#deleteAllCleanup?.();
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  #build() {
    const container = document.createElement("div");
    container.className = "params-editor";

    // ── Toolbar ──────────────────────────────────────────────────────────
    const toolbar = document.createElement("div");
    toolbar.className = "params-toolbar";

    const { label: bulkLabel } = buildToolbarToggle({
      text: " " + t("kv.bulkEditor"),
      title: t("kv.bulkEditorTitle"),
      checked: this.#bulkMode,
      onChange: (checked) => this.#handleBulkToggle(checked),
    });
    toolbar.appendChild(bulkLabel);

    const addBtn = document.createElement("button");
    addBtn.className = "icon-btn params-toolbar-btn";
    addBtn.title = t("kv.add", { noun: t("request.noun.header") });
    addBtn.setAttribute(
      "aria-label",
      t("kv.add", { noun: t("request.noun.header") }),
    );
    addBtn.innerHTML = `<span class="icon">${icon("add", { size: 15 })}</span>`;
    addBtn.addEventListener("click", () => this.#addHeader());
    this.#addBtnEl = addBtn;

    const delAllBtn = document.createElement("button");
    delAllBtn.className =
      "params-toolbar-btn params-toolbar-btn--danger params-delete-all-btn";
    delAllBtn.title = t("kv.deleteAllNoun", {
      noun: t("request.noun.headers"),
    });
    delAllBtn.setAttribute(
      "aria-label",
      t("kv.deleteAllNoun", { noun: t("request.noun.headers") }),
    );
    delAllBtn.textContent = t("kv.deleteAll");
    this.#delAllBtnEl = delAllBtn;
    this.#deleteAllCleanup = wireDeleteAllConfirm(
      delAllBtn,
      () => this.#rows.length,
      () => this.#deleteAll(),
    );

    toolbar.appendChild(addBtn);
    toolbar.appendChild(delAllBtn);

    // Spacer pushes the "List Headers" toggle to the far edge.
    const spacer = document.createElement("span");
    spacer.style.flex = "1";
    toolbar.appendChild(spacer);
    this.#listHdrSpacerEl = spacer;

    const { label: listHdrLabel } = buildToolbarToggle({
      text: " " + t("request.headers.listHeaders"),
      title: t("request.headers.suggestTitle"),
      checked: this.#suggestionsEnabled,
      onChange: (checked) => {
        this.#suggestionsEnabled = checked;
        if (!checked) hdrAc.hide();
      },
    });
    this.#listHdrLabelEl = listHdrLabel;
    toolbar.appendChild(listHdrLabel);

    container.appendChild(toolbar);

    // ── Bulk mode textarea ────────────────────────────────────────────────
    const bulkTa = document.createElement("textarea");
    bulkTa.className = "body-text-editor";
    bulkTa.placeholder = t("request.headers.bulkPlaceholder");
    bulkTa.spellcheck = false;
    bulkTa.setAttribute("aria-label", t("request.headers.bulkAria"));
    bulkTa.addEventListener("input", () => {
      this.#rows = textToHeaderRows(bulkTa.value);
      this.#emitChange();
    });
    this.#bulkEl = bulkTa;
    container.appendChild(bulkTa);

    // ── KV wrap (column headers + list) ──────────────────────────────────
    const kvWrap = document.createElement("div");
    kvWrap.style.cssText =
      "display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden";

    const colHeaders = document.createElement("div");
    colHeaders.className = "params-header-row";
    colHeaders.innerHTML = `
      <span class="params-col-handle"></span>
      <span class="params-col-enabled"></span>
      <span class="params-col-name">${t("kv.header")}</span>
      <span class="params-col-value">${t("kv.value")}</span>
      <span class="params-col-delete"></span>`;
    kvWrap.appendChild(colHeaders);

    const list = document.createElement("div");
    list.className = "params-list";
    this.#drag.attach(list);
    kvWrap.appendChild(list);

    this.#kvWrapEl = kvWrap;
    this.#listEl = list;
    container.appendChild(kvWrap);

    return container;
  }

  // ── Bulk mode ──────────────────────────────────────────────────────────────

  #handleBulkToggle(nowBulk) {
    if (nowBulk && !this.#bulkMode) {
      if (this.#bulkEl) this.#bulkEl.value = headerRowsToText(this.#rows);
    } else if (!nowBulk && this.#bulkMode) {
      if (this.#bulkEl) this.#rows = textToHeaderRows(this.#bulkEl.value);
    }
    this.#bulkMode = nowBulk;
    this.#applyBulkMode();
    if (!nowBulk) this.#renderList();
    this.#emitChange();
  }

  #applyBulkMode() {
    const bulk = this.#bulkMode;
    if (this.#bulkEl) this.#bulkEl.style.display = bulk ? "" : "none";
    if (this.#kvWrapEl) this.#kvWrapEl.style.display = bulk ? "none" : "";
    if (this.#addBtnEl) this.#addBtnEl.style.display = bulk ? "none" : "";
    if (this.#delAllBtnEl) this.#delAllBtnEl.style.display = bulk ? "none" : "";
    // Hide the "List Headers" toggle (and its spacer) in bulk mode.
    if (this.#listHdrSpacerEl)
      this.#listHdrSpacerEl.style.display = bulk ? "none" : "";
    if (this.#listHdrLabelEl)
      this.#listHdrLabelEl.style.display = bulk ? "none" : "";
    if (bulk) hdrAc.hide();
  }

  // ── Row management ───────────────────────────────────────────────────────────

  #addHeader() {
    this.#rows.push({
      id: crypto.randomUUID(),
      name: "",
      value: "",
      enabled: true,
    });
    this.#renderList();
    const rows = this.#listEl?.querySelectorAll(".params-row") ?? [];
    if (rows.length)
      rows[rows.length - 1].querySelector(".params-name")?.focus();
    this.#emitChange();
  }

  #deleteAll() {
    if (this.#rows.length === 0) return;
    this.#rows = [];
    this.#renderList();
    this.#emitChange();
  }

  #deleteHeader(id) {
    this.#rows = this.#rows.filter((h) => h.id !== id);
    this.#renderList();
    this.#emitChange();
  }

  #renderList() {
    if (!this.#listEl) return;
    disposePillEditors(this.#pillEditors);

    // In bulk mode just keep the textarea in sync.
    if (this.#bulkMode) {
      if (this.#bulkEl) this.#bulkEl.value = headerRowsToText(this.#rows);
      return;
    }

    this.#listEl.innerHTML = "";

    if (this.#rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "params-empty";
      empty.textContent = t("request.headers.empty");
      this.#listEl.appendChild(empty);
      return;
    }

    this.#rows.forEach((header, index) => {
      this.#listEl.appendChild(this.#buildRow(header, index));
    });
  }

  #buildRow(header, index) {
    // ── Forward references for the value-dropdown callbacks ───────────────
    let _onValueSelected = null;
    let _onNameConfirmed = null;

    // ── Header name combo box ─────────────────────────────────────────────
    const headerInput = document.createElement("input");
    headerInput.type = "text";
    headerInput.className = "params-input params-name";
    headerInput.placeholder = t("kv.header");
    headerInput.value = header.name;
    headerInput.setAttribute("aria-label", t("request.headers.nameAria"));
    headerInput.setAttribute("autocomplete", "off");
    headerInput.addEventListener("focus", () => {
      if (this.#suggestionsEnabled)
        showHdrDropdown(headerInput, (name) => _onNameConfirmed?.(name));
    });
    headerInput.addEventListener("input", () => {
      header.name = headerInput.value;
      this.#emitChange();
      if (this.#suggestionsEnabled)
        showHdrDropdown(headerInput, (name) => _onNameConfirmed?.(name));
    });
    headerInput.addEventListener("blur", () => {
      hdrAc.scheduleHide();
    });
    headerInput.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        hdrAc.navigate(+1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        hdrAc.navigate(-1);
        return;
      }
      if (e.key === "Escape") {
        hdrAc.hide();
        return;
      }
      if (e.key === " " && e.ctrlKey) {
        // Ctrl+Space: open the name-suggestions dropdown even when listHeaders is off.
        e.preventDefault();
        showHdrDropdown(headerInput, (name) =>
          _onNameConfirmed?.(name, { force: true }),
        );
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (!hdrDropdownAccept(headerInput)) this.#addHeader();
      }
    });

    // ── Value input ─────────────────────────────────────────────────────
    const valueEditor = new VariablePillEditor({
      placeholder: t("kv.value"),
      ariaLabel: t("request.headers.valueAria"),
      className: "params-value",
      getContext: this.#getContext,
      onInput: (v) => {
        header.value = v;
        this.#emitChange();
        // Re-open value suggestions on a trailing comma (multi-value headers).
        if (this.#suggestionsEnabled && v.trimEnd().endsWith(",")) {
          _onNameConfirmed?.(headerInput.value);
        }
      },
      onEnter: () => this.#addHeader(),
    });
    valueEditor.setValue(header.value);
    this.#pillEditors.push(valueEditor);

    // ── Post-creation: wire value-dropdown callbacks ──────────────────────
    _onValueSelected = (picked) => {
      const current = valueEditor.getValue().trimEnd();
      const newVal = current.endsWith(",")
        ? `${current} ${picked}`
        : current === ""
          ? picked
          : `${current}, ${picked}`;
      valueEditor.setValue(newVal);
      header.value = newVal;
      this.#emitChange();
      valueEditor.focus();
    };

    _onNameConfirmed = (name, { force = false } = {}) => {
      if (!this.#suggestionsEnabled && !force) return;
      const values = STANDARD_HEADERS_DICT[name] ?? [];
      if (values.length === 0) {
        hdrVal.hide();
        return;
      }
      showHdrValDropdown(valueEditor.element, values, _onValueSelected);
    };

    valueEditor.element.addEventListener("blur", () => {
      hdrVal.scheduleHide();
    });

    valueEditor.element.addEventListener(
      "keydown",
      (e) => {
        if (e.key === " " && e.ctrlKey) {
          e.preventDefault();
          _onNameConfirmed?.(headerInput.value, { force: true });
          return;
        }
        if (!hdrValDropdownVisible()) return;
        if (e.key === "ArrowDown") {
          e.preventDefault();
          hdrVal.navigate(+1);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          hdrVal.navigate(-1);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          hdrVal.hide();
          return;
        }
        if (e.key === "Enter" && hdrVal.activeLabel() !== null) {
          e.preventDefault();
          e.stopPropagation();
          hdrValDropdownAccept();
        }
      },
      true /* capture — before VariablePillEditor's bubble-phase listener */,
    );

    return buildKvRow({
      item: header,
      index,
      noun: t("request.noun.header"),
      name: headerInput,
      value: valueEditor.element,
      drag: this.#drag,
      onToggle: () => this.#emitChange(),
      onDelete: () => this.#deleteHeader(header.id),
    });
  }

  // ── Change emission + normalisation ──────────────────────────────────────────

  #emitChange() {
    this.#onChange?.(this.#rows.map((r) => ({ ...r })));
  }

  /** Coerce any tolerant input into canonical `{id,name,value,enabled}` rows. */
  static #normalize(input) {
    if (!Array.isArray(input)) return [];
    const out = [];
    for (const h of input) {
      if (!h || typeof h !== "object") continue;
      out.push({
        id: h.id ?? crypto.randomUUID(),
        name: String(h.name ?? ""),
        value: String(h.value ?? ""),
        enabled: h.enabled !== false,
      });
    }
    return out;
  }
}
