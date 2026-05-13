/**
 * request-editor.js — Request definition panel component
 *
 * Allows the user to configure and send an HTTP request:
 *   - Method selector (GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS)
 *   - URL input
 *   - Tab strip: Headers | Body | Auth | Params | Settings
 *   - Send button
 *
 * When the user clicks Send the component dispatches a 'wurl:send-request'
 * CustomEvent on the window with the full request descriptor as `detail`.
 *
 * Future expansion:
 *   - Body editor with syntax highlighting (JSON / XML / form-data / raw)
 *   - Auth configuration (Bearer, Basic, OAuth2, API key)
 *   - Request params table with enable/disable toggles
 *   - Environment variable injection
 *   - Pre/Post request scripts
 */

"use strict";

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
  { id: "params", label: "Params" },
  { id: "headers", label: "Headers" },
  { id: "body", label: "Body" },
  { id: "auth", label: "Auth" },
  { id: "settings", label: "Settings" },
];

export class RequestEditor {
  /** @type {HTMLElement} */
  #el;
  #method = "GET";
  #url = "";
  #activeTab = "params";

  constructor() {
    this.#el = document.createElement("div");
    this.#el.className = "request-editor";

    this.#renderUrlBar();
    this.#renderTabStrip();
    this.#renderTabContent();
  }

  /** Root DOM element — pass to Panel.mount(). */
  get element() {
    return this.#el;
  }

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
    methodSel.addEventListener("change", () => {
      this.#method = methodSel.value;
      methodSel.dataset.method = this.#method.toLowerCase();
    });
    methodSel.dataset.method = this.#method.toLowerCase();

    // URL input
    const urlInput = document.createElement("input");
    urlInput.type = "url";
    urlInput.className = "req-url-input";
    urlInput.placeholder = "https://api.example.com/endpoint";
    urlInput.setAttribute("aria-label", "Request URL");
    urlInput.addEventListener("input", () => {
      this.#url = urlInput.value;
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

    // Store references for later use
    this._methodSel = methodSel;
    this._urlInput = urlInput;
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
      btn.setAttribute(
        "aria-selected",
        tab.id === this.#activeTab ? "true" : "false",
      );
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
    const placeholder = document.createElement("div");
    placeholder.className = "panel-placeholder";

    const icons = {
      params: "🔗",
      headers: "🗂",
      body: "📄",
      auth: "🔑",
      settings: "⚙️",
    };
    const labels = {
      params: "Query parameters",
      headers: "Request headers",
      body: "Request body",
      auth: "Authentication",
      settings: "Request settings",
    };

    placeholder.innerHTML =
      `<span class="placeholder-icon">${icons[tabId]}</span>` +
      `<span>${labels[tabId]} — coming soon</span>`;

    return placeholder;
  }

  // ── Tab switching ─────────────────────────────────────────────────────────
  #switchTab(tabId) {
    this.#activeTab = tabId;

    // Update tab buttons
    this._tabStrip.querySelectorAll(".req-tab-btn").forEach((btn) => {
      const active = btn.dataset.tab === tabId;
      btn.classList.toggle("req-tab-btn--active", active);
      btn.setAttribute("aria-selected", String(active));
    });

    // Update tab panes
    this._tabContent.querySelectorAll(".req-tab-pane").forEach((pane) => {
      pane.hidden = pane.id !== `req-tab-${tabId}`;
    });
  }

  // ── Send ─────────────────────────────────────────────────────────────────
  #sendRequest() {
    const url = this._urlInput.value.trim();
    if (!url) {
      this._urlInput.focus();
      return;
    }

    const descriptor = {
      method: this.#method,
      url,
      headers: {}, // TODO: collect from headers tab
      body: null, // TODO: collect from body tab
    };

    window.dispatchEvent(
      new CustomEvent("wurl:send-request", {
        detail: descriptor,
        bubbles: true,
      }),
    );
  }

  /**
   * Populate the editor from a saved request node (from the tree-view).
   * @param {object} node
   */
  load(node) {
    if (node.method) {
      this.#method = node.method;
      this._methodSel.value = node.method;
      this._methodSel.dataset.method = node.method.toLowerCase();
    }
    if (node.url) {
      this.#url = node.url;
      this._urlInput.value = node.url;
    }
  }
}
