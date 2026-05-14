/**
 * request-editor.js — Request definition panel component
 */

"use strict";

import { PopupManager } from "../popup-manager.js";

// Standard HTTP request headers offered in the header-name combo box.
// Custom values are always accepted too (free-text input).
const STANDARD_HEADERS = [
  "Accept",
  "Accept-Charset",
  "Accept-Encoding",
  "Accept-Language",
  "Authorization",
  "Cache-Control",
  "Connection",
  "Content-Encoding",
  "Content-Length",
  "Content-MD5",
  "Content-Type",
  "Cookie",
  "Date",
  "DNT",
  "Expect",
  "Forwarded",
  "From",
  "Host",
  "If-Match",
  "If-Modified-Since",
  "If-None-Match",
  "If-Range",
  "If-Unmodified-Since",
  "Max-Forwards",
  "Origin",
  "Pragma",
  "Proxy-Authorization",
  "Range",
  "Referer",
  "TE",
  "Trailer",
  "Transfer-Encoding",
  "Upgrade",
  "User-Agent",
  "Via",
  "Warning",
  "X-Api-Key",
  "X-Auth-Token",
  "X-Csrf-Token",
  "X-Forwarded-For",
  "X-Forwarded-Host",
  "X-Forwarded-Proto",
  "X-Request-Id",
  "X-Requested-With",
];

/** Lazily create + cache the shared autocomplete dropdown in the document. */
let _hdrAcDropdown     = null;   // the floating listbox div
let _hdrAcActiveInput  = null;   // which input currently owns the dropdown
let _hdrAcActiveIdx    = -1;     // keyboard-focused item index (-1 = none)
let _hdrAcBlurTimer    = null;   // pending blur-hide timer (cancelled on re-focus)

function _ensureHdrDropdown() {
  if (_hdrAcDropdown) return _hdrAcDropdown;
  _hdrAcDropdown = document.createElement("div");
  _hdrAcDropdown.className = "hdr-autocomplete";
  _hdrAcDropdown.setAttribute("role", "listbox");
  _hdrAcDropdown.setAttribute("aria-label", "Header suggestions");
  document.body.appendChild(_hdrAcDropdown);

  // Hide when anything outside the input+dropdown is clicked
  document.addEventListener("mousedown", (e) => {
    if (_hdrAcActiveInput && !_hdrAcActiveInput.contains(e.target) && !_hdrAcDropdown.contains(e.target)) {
      _hideHdrDropdown();
    }
  }, true);

  return _hdrAcDropdown;
}

function _showHdrDropdown(input) {
  // Cancel any pending blur-hide so rapid blur→focus doesn't flash the dropdown
  if (_hdrAcBlurTimer !== null) { clearTimeout(_hdrAcBlurTimer); _hdrAcBlurTimer = null; }

  const dl     = _ensureHdrDropdown();
  const query  = input.value.toLowerCase().trim();
  const matches = query
    ? STANDARD_HEADERS.filter(h => h.toLowerCase().includes(query))
    : STANDARD_HEADERS;

  if (matches.length === 0) { _hideHdrDropdown(); return; }

  dl.innerHTML    = "";
  _hdrAcActiveIdx = -1;

  matches.forEach((h, i) => {
    const item = document.createElement("div");
    item.className = "hdr-autocomplete__item";
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", "false");
    item.dataset.idx = String(i);
    item.textContent = h;

    // mousedown (not click) so we fire before the input's blur
    item.addEventListener("mousedown", (e) => {
      e.preventDefault();
      input.value = h;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      _hideHdrDropdown();
      input.focus();
    });
    dl.appendChild(item);
  });

  // Position directly below the input
  const rect = input.getBoundingClientRect();
  dl.style.left  = `${rect.left + window.scrollX}px`;
  dl.style.top   = `${rect.bottom + window.scrollY + 2}px`;
  dl.style.width = `${rect.width}px`;
  dl.classList.add("hdr-autocomplete--visible");
  _hdrAcActiveInput = input;
}

function _hideHdrDropdown() {
  _hdrAcBlurTimer = null;
  if (_hdrAcDropdown) {
    _hdrAcDropdown.classList.remove("hdr-autocomplete--visible");
    _hdrAcDropdown.innerHTML = "";
  }
  _hdrAcActiveInput = null;
  _hdrAcActiveIdx   = -1;
}

/** Move keyboard focus within the dropdown; wraps around. */
function _hdrDropdownNavigate(dir) {
  if (!_hdrAcDropdown) return;
  const items = [..._hdrAcDropdown.querySelectorAll(".hdr-autocomplete__item")];
  if (!items.length) return;

  items[_hdrAcActiveIdx]?.classList.remove("hdr-autocomplete__item--active");
  items[_hdrAcActiveIdx]?.setAttribute("aria-selected", "false");

  _hdrAcActiveIdx = (_hdrAcActiveIdx + dir + items.length) % items.length;

  const active = items[_hdrAcActiveIdx];
  active.classList.add("hdr-autocomplete__item--active");
  active.setAttribute("aria-selected", "true");
  active.scrollIntoView({ block: "nearest" });
}

/** Accept the currently keyboard-focused item, if any. */
function _hdrDropdownAccept(input) {
  if (!_hdrAcDropdown || _hdrAcActiveIdx < 0) return false;
  const items = _hdrAcDropdown.querySelectorAll(".hdr-autocomplete__item");
  const active = items[_hdrAcActiveIdx];
  if (!active) return false;
  input.value = active.textContent;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  _hideHdrDropdown();
  return true;
}

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

  // Headers state
  #headers               = [];   // [{ id, name, value, enabled }]
  #headersListEl         = null;
  // Headers drag state
  #hdrDragSrcId          = null;
  #hdrDragInsideList     = false;
  #hdrDragDropHandled    = false;
  #headerPhantomEl       = null;
  #hdrDocDragOverHandler = null;

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
    if (tabId === "params")   return this.#buildParamsEditor();
    if (tabId === "headers")  return this.#buildHeadersEditor();

    // Placeholder for other tabs
    const placeholder = document.createElement("div");
    placeholder.className = "panel-placeholder";
    const icons  = { body: "📄", auth: "🔑", settings: "⚙️" };
    const labels = { body: "Request body", auth: "Authentication", settings: "Request settings" };
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

    // ── Headers editor ──────────────────────────────────────────────────
    #buildHeadersEditor() {
    const container = document.createElement("div");
    container.className = "params-editor";

    // ── Toolbar ──────────────────────────────────────────────────────────
    const toolbar = document.createElement("div");
    toolbar.className = "params-toolbar";

    const addBtn = document.createElement("button");
    addBtn.className = "icon-btn params-toolbar-btn";
    addBtn.title = "Add header";
    addBtn.setAttribute("aria-label", "Add header");
    addBtn.innerHTML = `<span class="icon">＋</span>`;
    addBtn.addEventListener("click", () => this.#addHeader());

    const deleteAllBtn = document.createElement("button");
    deleteAllBtn.className = "params-toolbar-btn params-toolbar-btn--danger params-delete-all-btn";
    deleteAllBtn.title = "Delete all headers";
    deleteAllBtn.setAttribute("aria-label", "Delete all headers");
    deleteAllBtn.textContent = "Delete All";
    deleteAllBtn.addEventListener("click", () => this.#deleteAllHeaders());

    toolbar.appendChild(addBtn);
    toolbar.appendChild(deleteAllBtn);
    container.appendChild(toolbar);

    // ── Column headers ───────────────────────────────────────────────────
    const colHeaders = document.createElement("div");
    colHeaders.className = "params-header-row";
    colHeaders.innerHTML = `
      <span class="params-col-handle"></span>
      <span class="params-col-enabled"></span>
      <span class="params-col-name">Header</span>
      <span class="params-col-value">Value</span>
      <span class="params-col-delete"></span>`;
    container.appendChild(colHeaders);

    // ── List ─────────────────────────────────────────────────────────────
    const list = document.createElement("div");
    list.className = "params-list";
    this.#headersListEl = list;

    // Phantom placeholder shown at the drop target while dragging
    this.#headerPhantomEl = document.createElement("div");
    this.#headerPhantomEl.className = "params-drop-phantom";
    this.#headerPhantomEl.setAttribute("aria-hidden", "true");

    // Container-level drop — commit the reorder
    list.addEventListener("dragover", (e) => {
      if (this.#hdrDragSrcId) e.preventDefault();
    });
    list.addEventListener("drop", (e) => {
      e.preventDefault();
      if (!this.#hdrDragSrcId) return;
      this.#hdrDragDropHandled = true;
      const ph = this.#headerPhantomEl;
      const allChildren = [...list.children];
      const phantomIdx = allChildren.indexOf(ph);
      if (phantomIdx === -1) { this.#cancelHeaderDrag(); this.#finalizeHeaderDrag(); return; }
      const insertBefore = allChildren.slice(0, phantomIdx).filter(el => el.classList.contains("params-row")).length;
      const srcIdx = this.#headers.findIndex(h => h.id === this.#hdrDragSrcId);
      if (srcIdx !== -1) {
        const [moved] = this.#headers.splice(srcIdx, 1);
        const target = insertBefore > srcIdx ? insertBefore - 1 : insertBefore;
        this.#headers.splice(target, 0, moved);
        this.#renderHeadersList();
        this.#dispatchHeadersUpdated();
      }
      this.#finalizeHeaderDrag();
    });

    container.appendChild(list);

    this.#renderHeadersList();
    return container;
    }

    #addHeader() {
    this.#headers.push({
      id:      crypto.randomUUID(),
      name:    "",
      value:   "",
      enabled: true,
    });
    this.#renderHeadersList();
    const rows = this.#headersListEl.querySelectorAll(".params-row");
    if (rows.length) rows[rows.length - 1].querySelector(".params-name")?.focus();
    this.#dispatchHeadersUpdated();
    }

    #deleteAllHeaders() {
    if (this.#headers.length === 0) return;
    PopupManager.confirm({
      title:        "Delete all headers?",
      message:      "This will remove all request headers. This cannot be undone.",
      confirmLabel: "Delete all",
      confirmClass: "popup-btn--danger",
      onConfirm:    () => {
        this.#headers = [];
        this.#renderHeadersList();
        this.#dispatchHeadersUpdated();
      },
    });
    }

    #deleteHeader(id) {
    this.#headers = this.#headers.filter((h) => h.id !== id);
    this.#renderHeadersList();
    this.#dispatchHeadersUpdated();
    }

    #renderHeadersList() {
    if (!this.#headersListEl) return;
    this.#headersListEl.innerHTML = "";

    if (this.#headers.length === 0) {
      const empty = document.createElement("div");
      empty.className = "params-empty";
      empty.textContent = "No headers — click  +  to add one.";
      this.#headersListEl.appendChild(empty);
      return;
    }

    this.#headers.forEach((header, index) => {
      this.#headersListEl.appendChild(this.#buildHeaderRow(header, index));
    });
    }

    #buildHeaderRow(header, index) {
    const row = document.createElement("div");
    row.className = "params-row";
    row.dataset.id    = header.id;
    row.dataset.index = String(index);
    row.draggable = true;
    if (!header.enabled) row.classList.add("params-row--disabled");

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
    checkbox.checked = header.enabled;
    checkbox.title = header.enabled ? "Disable header" : "Enable header";
    checkbox.setAttribute("aria-label", "Enable header");
    checkbox.addEventListener("change", () => {
      header.enabled  = checkbox.checked;
      checkbox.title  = header.enabled ? "Disable header" : "Enable header";
      row.classList.toggle("params-row--disabled", !header.enabled);
      this.#dispatchHeadersUpdated();
    });

    // ── Header name combo box ─────────────────────────────────────────────
    const headerInput = document.createElement("input");
    headerInput.type        = "text";
    headerInput.className   = "params-input params-name";
    headerInput.placeholder = "Header";
    headerInput.value       = header.name;
    headerInput.setAttribute("aria-label",    "Header name");
    headerInput.setAttribute("autocomplete",  "off");
    headerInput.addEventListener("focus", () => _showHdrDropdown(headerInput));
    headerInput.addEventListener("input", () => {
      header.name = headerInput.value;
      this.#dispatchHeadersUpdated();
      _showHdrDropdown(headerInput);
    });
    headerInput.addEventListener("blur", () => {
      // Store the timer ID so focus can cancel it if the user clicks back quickly
      _hdrAcBlurTimer = setTimeout(_hideHdrDropdown, 150);
    });
    headerInput.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown")  { e.preventDefault(); _hdrDropdownNavigate(+1); return; }
      if (e.key === "ArrowUp")    { e.preventDefault(); _hdrDropdownNavigate(-1); return; }
      if (e.key === "Escape")     { _hideHdrDropdown(); return; }
      if (e.key === "Enter") {
        e.preventDefault();
        if (!_hdrDropdownAccept(headerInput)) this.#addHeader();
      }
    });

    // ── Value input ─────────────────────────────────────────────────────
    const valueInput = document.createElement("input");
    valueInput.type        = "text";
    valueInput.className   = "params-input params-value";
    valueInput.placeholder = "Value";
    valueInput.value       = header.value;
    valueInput.setAttribute("aria-label", "Header value");
    valueInput.addEventListener("input", () => {
      header.value = valueInput.value;
      this.#dispatchHeadersUpdated();
    });
    valueInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); this.#addHeader(); }
    });

    // ── Delete button ────────────────────────────────────────────────────
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "icon-btn params-delete-btn";
    deleteBtn.title = "Delete header";
    deleteBtn.setAttribute("aria-label", "Delete header");
    deleteBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 12 12" fill="none"
        stroke="currentColor" stroke-width="2" stroke-linecap="round">
      <line x1="1" y1="1" x2="11" y2="11"/><line x1="11" y1="1" x2="1" y2="11"/>
    </svg>`;
    deleteBtn.addEventListener("click", () => this.#deleteHeader(header.id));

    // ── HTML5 drag-and-drop reordering (phantom pattern) ─────────────────
    row.addEventListener("dragstart", (e) => {
      this.#hdrDragSrcId       = header.id;
      this.#hdrDragDropHandled = false;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", header.id);

      requestAnimationFrame(() => {
        this.#hdrDragInsideList = true;
        row.parentElement?.insertBefore(this.#headerPhantomEl, row);
        row.style.display = "none";
      });

      this.#hdrDocDragOverHandler = (ev) => {
        if (!this.#hdrDragSrcId) return;
        const inside = this.#headersListEl.contains(ev.target);
        if (!inside && this.#hdrDragInsideList) {
          this.#hdrDragInsideList = false;
          this.#headerPhantomEl.remove();
          const draggedRow = this.#headersListEl.querySelector(`[data-id="${this.#hdrDragSrcId}"]`);
          if (draggedRow) draggedRow.style.display = "";
        } else if (inside && !this.#hdrDragInsideList) {
          this.#hdrDragInsideList = true;
        }
      };
      document.addEventListener("dragover", this.#hdrDocDragOverHandler);
    });

    row.addEventListener("dragover", (e) => {
      if (!this.#hdrDragSrcId || this.#hdrDragSrcId === header.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";

      const rect  = row.getBoundingClientRect();
      const after = (e.clientY - rect.top) / rect.height >= 0.5;
      const ph    = this.#headerPhantomEl;

      const draggedRow = this.#headersListEl.querySelector(`[data-id="${this.#hdrDragSrcId}"]`);
      if (draggedRow && draggedRow.style.display !== "none") draggedRow.style.display = "none";

      const sibling = after ? row.nextSibling : row;
      if (ph.nextSibling !== sibling && ph !== sibling) {
        row.parentElement?.insertBefore(ph, after ? row.nextSibling : row);
      }
    });

    row.addEventListener("dragend", () => {
      if (!this.#hdrDragDropHandled) this.#cancelHeaderDrag();
      this.#finalizeHeaderDrag();
    });

    row.appendChild(handle);
    row.appendChild(checkbox);
    row.appendChild(headerInput);
    row.appendChild(valueInput);
    row.appendChild(deleteBtn);
    return row;
    }

    /** Cancel a header drag: remove phantom and re-render. */
    #cancelHeaderDrag() {
    this.#headerPhantomEl.remove();
    this.#renderHeadersList();
    }

    /** Clean up all header drag state and remove the document-level listener. */
    #finalizeHeaderDrag() {
    if (this.#hdrDocDragOverHandler) {
      document.removeEventListener("dragover", this.#hdrDocDragOverHandler);
      this.#hdrDocDragOverHandler = null;
    }
    this.#hdrDragSrcId       = null;
    this.#hdrDragInsideList  = false;
    this.#hdrDragDropHandled = false;
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

    #dispatchHeadersUpdated() {
    if (!this.#currentNodeId) return;
    window.dispatchEvent(new CustomEvent("wurl:request-updated", {
      detail: { id: this.#currentNodeId, headers: this.#headers.map((h) => ({ ...h })) },
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

    // Headers
    this.#headers = Array.isArray(node.headers)
      ? node.headers.map((h) => ({
          id:      h.id      ?? crypto.randomUUID(),
          name:    h.name    ?? "",
          value:   h.value   ?? "",
          enabled: h.enabled ?? true,
        }))
      : [];
    this.#renderHeadersList();
  }
}
