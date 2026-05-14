/**
 * request-editor.js — Request definition panel component
 */

"use strict";

import { PopupManager } from "../popup-manager.js";

const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
];

const TABS = [
  { id: "params",   label: "Params"   },
  { id: "headers",  label: "Headers"  },
  { id: "body",     label: "Body"     },
  { id: "auth",     label: "Auth"     },
  { id: "settings", label: "Settings" },
];

export class RequestEditor {
  /** @type {HTMLElement} */
  #el;
  #method       = "GET";
  #url          = "";
  #activeTab    = "params";
  #currentNodeId = null;

  // Params state
  #params            = [];   // [{ id, name, value, enabled }]
  #paramsListEl      = null;
  // Drag state
  #dragSrcId         = null; // id of the param being dragged
  #dragInsideList    = false;
  #dragDropHandled   = false;
  #paramPhantomEl    = null; // placeholder shown while dragging
  #docDragOverHandler = null;

  constructor() {
    this.#el = document.createElement("div");
    this.#el.className = "request-editor";

    this.#renderUrlBar();
    this.#renderTabStrip();
    this.#renderTabContent();
  }

  /** Root DOM element — pass to Panel.mount(). */
  get element() { return this.#el; }

  // ── URL bar ─────────────────────────────────────────────────────────────
  #renderUrlBar() {
    const bar = document.createElement("div");
    bar.className = "req-url-bar";

    // Method selector
    const methodSel = document.createElement("select");
    methodSel.className = "req-method-select";
    methodSel.setAttribute("aria-label", "HTTP Method");
    HTTP_METHODS.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = m;
      methodSel.appendChild(opt);
    });
    methodSel.value = this.#method;
    methodSel.dataset.method = this.#method.toLowerCase();
    methodSel.addEventListener("change", () => {
      this.#method = methodSel.value;
      methodSel.dataset.method = this.#method.toLowerCase();
      this.#dispatchRequestUpdated();
    });

    // URL input
    const urlInput = document.createElement("input");
    urlInput.type = "url";
    urlInput.className = "req-url-input";
    urlInput.placeholder = "https://api.example.com/endpoint";
    urlInput.setAttribute("aria-label", "Request URL");
    urlInput.addEventListener("input", () => {
      this.#url = urlInput.value;
      this.#dispatchRequestUpdated();
    });
    urlInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.#sendRequest();
    });

    // Send button
    const sendBtn = document.createElement("button");
    sendBtn.className = "req-send-btn";
    sendBtn.textContent = "Send";
    sendBtn.setAttribute("aria-label", "Send request");
    sendBtn.addEventListener("click", () => this.#sendRequest());

    bar.appendChild(methodSel);
    bar.appendChild(urlInput);
    bar.appendChild(sendBtn);
    this.#el.appendChild(bar);

    this._methodSel = methodSel;
    this._urlInput  = urlInput;
  }

  // ── Tab strip ────────────────────────────────────────────────────────────
  #renderTabStrip() {
    const strip = document.createElement("div");
    strip.className = "req-tab-strip";
    strip.setAttribute("role", "tablist");

    TABS.forEach((tab) => {
      const btn = document.createElement("button");
      btn.className = "req-tab-btn";
      btn.textContent = tab.label;
      btn.dataset.tab = tab.id;
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", tab.id === this.#activeTab ? "true" : "false");
      btn.setAttribute("aria-controls", `req-tab-${tab.id}`);
      if (tab.id === this.#activeTab) btn.classList.add("req-tab-btn--active");
      btn.addEventListener("click", () => this.#switchTab(tab.id));
      strip.appendChild(btn);
    });

    this.#el.appendChild(strip);
    this._tabStrip = strip;
  }

  // ── Tab content panels ───────────────────────────────────────────────────
  #renderTabContent() {
    const content = document.createElement("div");
    content.className = "req-tab-content";

    TABS.forEach((tab) => {
      const pane = document.createElement("div");
      pane.className = "req-tab-pane";
      pane.id = `req-tab-${tab.id}`;
      pane.setAttribute("role", "tabpanel");
      pane.hidden = tab.id !== this.#activeTab;
      pane.appendChild(this.#buildTabPane(tab.id));
      content.appendChild(pane);
    });

    this.#el.appendChild(content);
    this._tabContent = content;
  }

  #buildTabPane(tabId) {
    if (tabId === "params") return this.#buildParamsEditor();

    // Placeholder for other tabs
    const placeholder = document.createElement("div");
    placeholder.className = "panel-placeholder";
    const icons  = { headers: "🗂", body: "📄", auth: "🔑", settings: "⚙️" };
    const labels = { headers: "Request headers", body: "Request body", auth: "Authentication", settings: "Request settings" };
    placeholder.innerHTML =
      `<span class="placeholder-icon">${icons[tabId]}</span>` +
      `<span>${labels[tabId]} — coming soon</span>`;
    return placeholder;
  }

  // ── Params editor ────────────────────────────────────────────────────────
  #buildParamsEditor() {
    const container = document.createElement("div");
    container.className = "params-editor";

    // ── Toolbar ──────────────────────────────────────────────────────────
    const toolbar = document.createElement("div");
    toolbar.className = "params-toolbar";

    const addBtn = document.createElement("button");
    addBtn.className = "icon-btn params-toolbar-btn";
    addBtn.title = "Add parameter";
    addBtn.setAttribute("aria-label", "Add parameter");
    addBtn.innerHTML = `<span class="icon">＋</span>`;
    addBtn.addEventListener("click", () => this.#addParam());

    const deleteAllBtn = document.createElement("button");
    deleteAllBtn.className = "params-toolbar-btn params-toolbar-btn--danger params-delete-all-btn";
    deleteAllBtn.title = "Delete all parameters";
    deleteAllBtn.setAttribute("aria-label", "Delete all parameters");
    deleteAllBtn.textContent = "Delete All";
    deleteAllBtn.addEventListener("click", () => this.#deleteAllParams());

    toolbar.appendChild(addBtn);
    toolbar.appendChild(deleteAllBtn);
    container.appendChild(toolbar);

    // ── Column headers ───────────────────────────────────────────────────
    const headers = document.createElement("div");
    headers.className = "params-header-row";
    headers.innerHTML = `
      <span class="params-col-handle"></span>
      <span class="params-col-enabled"></span>
      <span class="params-col-name">Name</span>
      <span class="params-col-value">Value</span>
      <span class="params-col-delete"></span>`;
    container.appendChild(headers);

    // ── List ─────────────────────────────────────────────────────────────
    const list = document.createElement("div");
    list.className = "params-list";
    this.#paramsListEl = list;

    // Phantom placeholder shown at the drop target while dragging
    this.#paramPhantomEl = document.createElement("div");
    this.#paramPhantomEl.className = "params-drop-phantom";
    this.#paramPhantomEl.setAttribute("aria-hidden", "true");

    // Container-level drop — commit the reorder
    list.addEventListener("dragover", (e) => {
      if (this.#dragSrcId) e.preventDefault();
    });
    list.addEventListener("drop", (e) => {
      e.preventDefault();
      if (!this.#dragSrcId) return;
      this.#dragDropHandled = true;
      const ph = this.#paramPhantomEl;
      // Find the index of the phantom to know where to insert
      const allChildren = [...list.children];
      const phantomIdx = allChildren.indexOf(ph);
      if (phantomIdx === -1) { this.#cancelParamDrag(); this.#finalizeParamDrag(); return; }
      // Count only param rows before the phantom
      const insertBefore = allChildren.slice(0, phantomIdx).filter(el => el.classList.contains("params-row")).length;
      const srcIdx = this.#params.findIndex(p => p.id === this.#dragSrcId);
      if (srcIdx !== -1) {
        const [moved] = this.#params.splice(srcIdx, 1);
        const target = insertBefore > srcIdx ? insertBefore - 1 : insertBefore;
        this.#params.splice(target, 0, moved);
        this.#renderParamsList();
        this.#dispatchParamsUpdated();
      }
      this.#finalizeParamDrag();
    });

    container.appendChild(list);

    this.#renderParamsList();
    return container;
  }

  #addParam() {
    this.#params.push({
      id:      crypto.randomUUID(),
      name:    "",
      value:   "",
      enabled: true,
    });
    this.#renderParamsList();
    // Focus the new row's name input
    const rows = this.#paramsListEl.querySelectorAll(".params-row");
    if (rows.length) rows[rows.length - 1].querySelector(".params-name")?.focus();
    this.#dispatchParamsUpdated();
  }

  #deleteAllParams() {
    if (this.#params.length === 0) return;
    PopupManager.confirm({
      title:         "Delete all parameters?",
      message:       "This will remove all query parameters. This cannot be undone.",
      confirmLabel:  "Delete all",
      confirmClass:  "popup-btn--danger",
      onConfirm:     () => {
        this.#params = [];
        this.#renderParamsList();
        this.#dispatchParamsUpdated();
      },
    });
  }

  #deleteParam(id) {
    this.#params = this.#params.filter((p) => p.id !== id);
    this.#renderParamsList();
    this.#dispatchParamsUpdated();
  }

  #renderParamsList() {
    if (!this.#paramsListEl) return;
    this.#paramsListEl.innerHTML = "";

    if (this.#params.length === 0) {
      const empty = document.createElement("div");
      empty.className = "params-empty";
      empty.textContent = "No parameters — click  +  to add one.";
      this.#paramsListEl.appendChild(empty);
      return;
    }

    this.#params.forEach((param, index) => {
      this.#paramsListEl.appendChild(this.#buildParamRow(param, index));
    });
  }

  #buildParamRow(param, index) {
    const row = document.createElement("div");
    row.className = "params-row";
    row.dataset.id    = param.id;
    row.dataset.index = String(index);
    row.draggable = true;
    if (!param.enabled) row.classList.add("params-row--disabled");

    // ── Drag handle ──────────────────────────────────────────────────────
    const handle = document.createElement("span");
    handle.className = "params-drag-handle";
    handle.setAttribute("aria-hidden", "true");
    handle.title = "Drag to reorder";
    handle.innerHTML = `<svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor">
      <circle cx="3" cy="3"  r="1.4"/><circle cx="7" cy="3"  r="1.4"/>
      <circle cx="3" cy="8"  r="1.4"/><circle cx="7" cy="8"  r="1.4"/>
      <circle cx="3" cy="13" r="1.4"/><circle cx="7" cy="13" r="1.4"/>
    </svg>`;

    // ── Enabled checkbox ─────────────────────────────────────────────────
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "params-checkbox";
    checkbox.checked = param.enabled;
    checkbox.title = param.enabled ? "Disable parameter" : "Enable parameter";
    checkbox.setAttribute("aria-label", "Enable parameter");
    checkbox.addEventListener("change", () => {
      param.enabled  = checkbox.checked;
      checkbox.title = param.enabled ? "Disable parameter" : "Enable parameter";
      row.classList.toggle("params-row--disabled", !param.enabled);
      this.#dispatchParamsUpdated();
    });

    // ── Name input ───────────────────────────────────────────────────────
    const nameInput = document.createElement("input");
    nameInput.type        = "text";
    nameInput.className   = "params-input params-name";
    nameInput.placeholder = "Name";
    nameInput.value       = param.name;
    nameInput.setAttribute("aria-label", "Parameter name");
    nameInput.addEventListener("input", () => {
      param.name = nameInput.value;
      this.#dispatchParamsUpdated();
    });
    // Tab to value, Enter to add new row
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); this.#addParam(); }
    });

    // ── Value input ──────────────────────────────────────────────────────
    const valueInput = document.createElement("input");
    valueInput.type        = "text";
    valueInput.className   = "params-input params-value";
    valueInput.placeholder = "Value";
    valueInput.value       = param.value;
    valueInput.setAttribute("aria-label", "Parameter value");
    valueInput.addEventListener("input", () => {
      param.value = valueInput.value;
      this.#dispatchParamsUpdated();
    });
    valueInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); this.#addParam(); }
    });

    // ── Delete button ────────────────────────────────────────────────────
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "icon-btn params-delete-btn";
    deleteBtn.title = "Delete parameter";
    deleteBtn.setAttribute("aria-label", "Delete parameter");
    deleteBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 12 12" fill="none"
        stroke="currentColor" stroke-width="2" stroke-linecap="round">
      <line x1="1" y1="1" x2="11" y2="11"/><line x1="11" y1="1" x2="1" y2="11"/>
    </svg>`;
    deleteBtn.addEventListener("click", () => this.#deleteParam(param.id));

    // ── HTML5 drag-and-drop reordering (phantom pattern) ─────────────────
    row.draggable = true;

    row.addEventListener("dragstart", (e) => {
      this.#dragSrcId      = param.id;
      this.#dragDropHandled = false;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", param.id); // required by Firefox

      requestAnimationFrame(() => {
        this.#dragInsideList = true;
        // Insert phantom where the row was, then hide the row
        row.parentElement?.insertBefore(this.#paramPhantomEl, row);
        row.style.display = "none";
      });

      // Document-level handler to detect leaving/re-entering the list
      this.#docDragOverHandler = (ev) => {
        if (!this.#dragSrcId) return;
        const inside = this.#paramsListEl.contains(ev.target);
        if (!inside && this.#dragInsideList) {
          this.#dragInsideList = false;
          this.#paramPhantomEl.remove();
          const draggedRow = this.#paramsListEl.querySelector(`[data-id="${this.#dragSrcId}"]`);
          if (draggedRow) draggedRow.style.display = "";
        } else if (inside && !this.#dragInsideList) {
          this.#dragInsideList = true;
        }
      };
      document.addEventListener("dragover", this.#docDragOverHandler);
    });

    row.addEventListener("dragover", (e) => {
      if (!this.#dragSrcId || this.#dragSrcId === param.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";

      const rect  = row.getBoundingClientRect();
      const after = (e.clientY - rect.top) / rect.height >= 0.5;
      const ph    = this.#paramPhantomEl;

      // Ensure dragged row stays hidden after re-entry
      const draggedRow = this.#paramsListEl.querySelector(`[data-id="${this.#dragSrcId}"]`);
      if (draggedRow && draggedRow.style.display !== "none") draggedRow.style.display = "none";

      const sibling = after ? row.nextSibling : row;
      if (ph.nextSibling !== sibling && ph !== sibling) {
        row.parentElement?.insertBefore(ph, after ? row.nextSibling : row);
      }
    });

    row.addEventListener("dragend", () => {
      if (!this.#dragDropHandled) this.#cancelParamDrag();
      this.#finalizeParamDrag();
    });

    row.appendChild(handle);
    row.appendChild(checkbox);
    row.appendChild(nameInput);
    row.appendChild(valueInput);
    row.appendChild(deleteBtn);
    return row;
  }

  /** Cancel a drag: remove phantom and re-render from unchanged #params. */
  #cancelParamDrag() {
    this.#paramPhantomEl.remove();
    this.#renderParamsList();
  }

  /** Clean up all drag state and remove the document-level listener. */
  #finalizeParamDrag() {
    if (this.#docDragOverHandler) {
      document.removeEventListener("dragover", this.#docDragOverHandler);
      this.#docDragOverHandler = null;
    }
    this.#dragSrcId       = null;
    this.#dragInsideList  = false;
    this.#dragDropHandled = false;
  }

  // ── Tab switching ─────────────────────────────────────────────────────────
  #switchTab(tabId) {
    this.#activeTab = tabId;
    this._tabStrip.querySelectorAll(".req-tab-btn").forEach((btn) => {
      const active = btn.dataset.tab === tabId;
      btn.classList.toggle("req-tab-btn--active", active);
      btn.setAttribute("aria-selected", String(active));
    });
    this._tabContent.querySelectorAll(".req-tab-pane").forEach((pane) => {
      pane.hidden = pane.id !== `req-tab-${tabId}`;
    });
  }

  // ── Event dispatch ────────────────────────────────────────────────────────
  #dispatchRequestUpdated() {
    if (!this.#currentNodeId) return;
    window.dispatchEvent(new CustomEvent("wurl:request-updated", {
      detail: { id: this.#currentNodeId, method: this.#method, url: this.#url },
      bubbles: true,
    }));
  }

  #dispatchParamsUpdated() {
    if (!this.#currentNodeId) return;
    window.dispatchEvent(new CustomEvent("wurl:request-updated", {
      detail: { id: this.#currentNodeId, params: this.#params.map((p) => ({ ...p })) },
      bubbles: true,
    }));
  }

  // ── Send ─────────────────────────────────────────────────────────────────
  #sendRequest() {
    const url = this._urlInput.value.trim();
    if (!url) { this._urlInput.focus(); return; }

    const descriptor = {
      method:  this.#method,
      url,
      params:  this.#params.filter((p) => p.enabled),
      headers: {},
      body:    null,
    };

    window.dispatchEvent(new CustomEvent("wurl:send-request", {
      detail: descriptor,
      bubbles: true,
    }));
  }

  /**
   * Populate the editor from a saved request node.
   * @param {object} node
   */
  load(node) {
    this.#currentNodeId = node.id ?? null;

    if (node.method) {
      this.#method = node.method;
      this._methodSel.value = node.method;
      this._methodSel.dataset.method = node.method.toLowerCase();
    }

    const url = node.url ?? "";
    this.#url = url;
    this._urlInput.value = url;

    // Params
    this.#params = Array.isArray(node.params)
      ? node.params.map((p) => ({
          id:      p.id      ?? crypto.randomUUID(),
          name:    p.name    ?? "",
          value:   p.value   ?? "",
          enabled: p.enabled ?? true,
        }))
      : [];
    this.#renderParamsList();
  }
}
