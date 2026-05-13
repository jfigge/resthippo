/**
 * response-viewer.js — HTTP response display component
 *
 * Shows the result of a wurl:send-request dispatched by the RequestEditor.
 * Displays:
 *   - Status line (code + text + elapsed time)
 *   - Tab strip: Body | Headers | Cookies | Timeline
 *   - Pretty-printed response body (JSON / XML / plain text / image)
 *
 * Future expansion:
 *   - Syntax highlighting (JSON, XML, HTML)
 *   - Binary / image preview
 *   - Save-to-file
 *   - Response history
 *   - Size / timing breakdown
 */

"use strict";

const TABS = [
  { id: "body", label: "Body" },
  { id: "headers", label: "Headers" },
  { id: "cookies", label: "Cookies" },
  { id: "timeline", label: "Timeline" },
];

export class ResponseViewer {
  /** @type {HTMLElement} */
  #el;
  #activeTab = "body";

  constructor() {
    this.#el = document.createElement("div");
    this.#el.className = "response-viewer";

    this.#renderStatusBar();
    this.#renderTabStrip();
    this.#renderTabContent();

    // Listen for responses
    window.addEventListener("wurl:response-received", (e) =>
      this.#showResponse(e.detail),
    );
    window.addEventListener("wurl:request-loading", () => this.#showLoading());
    window.addEventListener("wurl:request-error", (e) =>
      this.#showError(e.detail),
    );
  }

  /** Root DOM element — pass to Panel.mount(). */
  get element() {
    return this.#el;
  }

  // ── Status bar ────────────────────────────────────────────────────────────
  #renderStatusBar() {
    const bar = document.createElement("div");
    bar.className = "res-status-bar";
    bar.innerHTML = `
      <span class="res-status-badge" aria-label="HTTP status"></span>
      <span class="res-status-text"></span>
      <span class="res-meta">
        <span class="res-time"  title="Elapsed time"></span>
        <span class="res-size"  title="Response size"></span>
      </span>
    `;
    this.#el.appendChild(bar);
    this._statusBar = bar;
  }

  // ── Tab strip ─────────────────────────────────────────────────────────────
  #renderTabStrip() {
    const strip = document.createElement("div");
    strip.className = "res-tab-strip";
    strip.setAttribute("role", "tablist");

    TABS.forEach((tab) => {
      const btn = document.createElement("button");
      btn.className = "res-tab-btn";
      btn.textContent = tab.label;
      btn.dataset.tab = tab.id;
      btn.setAttribute("role", "tab");
      btn.setAttribute(
        "aria-selected",
        tab.id === this.#activeTab ? "true" : "false",
      );
      btn.setAttribute("aria-controls", `res-tab-${tab.id}`);
      if (tab.id === this.#activeTab) btn.classList.add("res-tab-btn--active");

      btn.addEventListener("click", () => this.#switchTab(tab.id));
      strip.appendChild(btn);
    });

    this.#el.appendChild(strip);
    this._tabStrip = strip;
  }

  // ── Tab content ───────────────────────────────────────────────────────────
  #renderTabContent() {
    const content = document.createElement("div");
    content.className = "res-tab-content";

    TABS.forEach((tab) => {
      const pane = document.createElement("div");
      pane.className = "res-tab-pane";
      pane.id = `res-tab-${tab.id}`;
      pane.setAttribute("role", "tabpanel");
      pane.hidden = tab.id !== this.#activeTab;
      content.appendChild(pane);
    });

    // Initial empty state
    const bodyPane = content.querySelector("#res-tab-body");
    bodyPane.appendChild(this.#emptyState());

    this.#el.appendChild(content);
    this._tabContent = content;
  }

  #emptyState() {
    const el = document.createElement("div");
    el.className = "panel-placeholder";
    el.innerHTML =
      '<span class="placeholder-icon">📡</span>' +
      "<span>Send a request to see the response</span>";
    return el;
  }

  // ── Tab switching ─────────────────────────────────────────────────────────
  #switchTab(tabId) {
    this.#activeTab = tabId;

    this._tabStrip.querySelectorAll(".res-tab-btn").forEach((btn) => {
      const active = btn.dataset.tab === tabId;
      btn.classList.toggle("res-tab-btn--active", active);
      btn.setAttribute("aria-selected", String(active));
    });

    this._tabContent.querySelectorAll(".res-tab-pane").forEach((pane) => {
      pane.hidden = pane.id !== `res-tab-${tabId}`;
    });
  }

  // ── Response states ───────────────────────────────────────────────────────
  #showLoading() {
    this.#setStatus("", "", "", "");
    const bodyPane = this._tabContent.querySelector("#res-tab-body");
    bodyPane.innerHTML = "";
    const loading = document.createElement("div");
    loading.className = "panel-placeholder";
    loading.innerHTML =
      '<span class="placeholder-icon res-spinner">⏳</span>' +
      "<span>Sending request…</span>";
    bodyPane.appendChild(loading);
  }

  #showError(detail) {
    this.#setStatus("ERR", "Network Error", "", "");
    const badge = this._statusBar.querySelector(".res-status-badge");
    badge.className = "res-status-badge res-status--error";

    const bodyPane = this._tabContent.querySelector("#res-tab-body");
    bodyPane.innerHTML = "";
    const err = document.createElement("div");
    err.className = "panel-placeholder";
    err.innerHTML =
      '<span class="placeholder-icon">⚠️</span>' +
      `<span>${this.#escapeHtml(detail?.message ?? "Request failed")}</span>`;
    bodyPane.appendChild(err);
  }

  /**
   * @param {object} response
   * @param {number} response.status
   * @param {string} response.statusText
   * @param {Headers|object} response.headers
   * @param {string} response.body
   * @param {number} response.elapsed  - milliseconds
   * @param {number} response.size     - bytes
   */
  #showResponse(response) {
    const {
      status,
      statusText,
      headers = {},
      body = "",
      elapsed = 0,
      size = 0,
    } = response;

    // Status badge
    const statusClass = this.#statusClass(status);
    this.#setStatus(
      status,
      statusText,
      `${elapsed} ms`,
      this.#formatSize(size),
    );
    const badge = this._statusBar.querySelector(".res-status-badge");
    badge.className = `res-status-badge ${statusClass}`;

    // Body pane
    const bodyPane = this._tabContent.querySelector("#res-tab-body");
    bodyPane.innerHTML = "";
    const pre = document.createElement("pre");
    pre.className = "res-body-pre";
    pre.textContent = this.#prettyBody(body, headers["content-type"] ?? "");
    bodyPane.appendChild(pre);

    // Headers pane
    const headersPane = this._tabContent.querySelector("#res-tab-headers");
    headersPane.innerHTML = "";
    const table = document.createElement("table");
    table.className = "res-headers-table";
    Object.entries(headers).forEach(([k, v]) => {
      const row = table.insertRow();
      row.insertCell().textContent = k;
      row.insertCell().textContent = v;
    });
    headersPane.appendChild(table);
  }

  #setStatus(code, text, time, size) {
    this._statusBar.querySelector(".res-status-badge").textContent = code;
    this._statusBar.querySelector(".res-status-text").textContent = text;
    this._statusBar.querySelector(".res-time").textContent = time;
    this._statusBar.querySelector(".res-size").textContent = size;
  }

  #statusClass(code) {
    if (code >= 200 && code < 300) return "res-status--success";
    if (code >= 300 && code < 400) return "res-status--redirect";
    if (code >= 400 && code < 500) return "res-status--client-error";
    if (code >= 500) return "res-status--server-error";
    return "";
  }

  #prettyBody(body, contentType) {
    if (contentType.includes("application/json")) {
      try {
        return JSON.stringify(JSON.parse(body), null, 2);
      } catch {}
    }
    return body;
  }

  #formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  #escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
}
