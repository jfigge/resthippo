/**
 * response-viewer.js — HTTP response display component
 *
 * Displays the result of a wurl:send-request in one of three views:
 *
 *  1. JSON / YAML / XML / CSS / JavaScript  — raw text or pretty-printed + syntax-highlighted depending on renderMode
 *  2. HTML               — raw text with syntax highlighting (raw mode) or live browser preview (preview mode)
 *                          • Electron: WebContentsView that loads the request URL
 *                          • Dev/browser: <iframe src=requestUrl> placeholder
 *  3. Everything else    — raw text only (renderMode toggle is a no-op)
 */

"use strict";

import Prism from "../vendor/prism.js";
import renderMarkdown from "../vendor/markdown.js";
import { icon } from "../icons.js";
import { escapeHtml } from "../utils/html.js";

const TABS = [
  { id: "body", label: "Body" },
  { id: "preview", label: "Preview" }, // shown only for HTML responses
  { id: "headers", label: "Headers" },
  { id: "cookies", label: "Cookies" },
  { id: "console", label: "Console" },
  { id: "timeline", label: "Timeline" },
];

// ── Content-type classification ───────────────────────────────────────────────

/**
 * Classify a Content-Type header value into one of the rendering categories.
 * @param {string} ct  - raw Content-Type value (may include charset/boundary)
/**
 * Map a markdown fenced-code info-string (the word after ```) to a Prism
 * grammar id.  Anything unlisted is left un-highlighted.
 */
const MD_CODE_LANG = {
  js: "javascript",
  javascript: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  ts: "javascript",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  xml: "markup",
  html: "markup",
  svg: "markup",
  markup: "markup",
  css: "css",
};

/**
 * @returns {"image"|"pdf"|"json"|"yaml"|"xml"|"html"|"markdown"|"css"|"javascript"|"other"}
 */
function classifyContentType(ct) {
  const base = (ct ?? "").toLowerCase().split(";")[0].trim();
  // Binary previews are checked first so e.g. image/svg+xml does not fall into
  // the generic "xml" text branch below.
  if (base.startsWith("image/")) return "image";
  if (base === "application/pdf") return "pdf";
  if (base.includes("json")) return "json";
  if (base.includes("yaml")) return "yaml";
  if (base.includes("xml")) return "xml";
  if (base === "text/markdown" || base === "text/x-markdown") return "markdown";
  if (base === "text/html" || base === "application/xhtml+xml") return "html";
  if (base === "text/css") return "css";
  if (
    base === "text/javascript" ||
    base === "application/javascript" ||
    base === "application/x-javascript" ||
    base === "application/ecmascript" ||
    base === "text/ecmascript"
  )
    return "javascript";
  return "other";
}

// Content-Type → save-dialog extension for a binary body. Mirrors the main
// process http-content-type helper (the sandboxed renderer cannot require
// main-process modules), falling back to the subtype after "/", else "bin".
const BINARY_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "image/tiff": "tiff",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/gzip": "gz",
  "application/wasm": "wasm",
  "application/octet-stream": "bin",
  "font/woff": "woff",
  "font/woff2": "woff2",
  "font/ttf": "ttf",
  "font/otf": "otf",
};

function binaryExtension(ct) {
  const base = (ct ?? "").toLowerCase().split(";")[0].trim();
  if (BINARY_EXT[base]) return BINARY_EXT[base];
  const subtype = (base.split("/")[1] ?? "").replace(/\+.*$/, "");
  const cleaned = subtype.replace(/[^a-z0-9]/g, "");
  return cleaned || "bin";
}

// ── Simple XML pretty-printer ─────────────────────────────────────────────────

function prettyXml(xml) {
  try {
    const INDENT = "  ";
    // Collapse existing whitespace between tags so we start fresh.
    const normalised = xml.replace(/>\s+</g, "><").trim();
    let depth = 0;
    let result = "";

    const re = /(<[^>]+>|[^<]+)/g;
    let m;
    while ((m = re.exec(normalised)) !== null) {
      const token = m[1].trim();
      if (!token) continue;

      if (token.startsWith("</")) {
        // Closing tag — dedent before printing
        depth = Math.max(0, depth - 1);
        result += INDENT.repeat(depth) + token + "\n";
      } else if (
        token.startsWith("<?") ||
        token.startsWith("<!") ||
        token.endsWith("/>")
      ) {
        // Processing instruction, doctype, or self-closing tag — no depth change
        result += INDENT.repeat(depth) + token + "\n";
      } else if (token.startsWith("<")) {
        // Opening tag — print then indent
        result += INDENT.repeat(depth) + token + "\n";
        depth++;
      } else {
        // Text node
        result += INDENT.repeat(depth) + token + "\n";
      }
    }
    return result.trim();
  } catch {
    return xml;
  }
}

// ── Simple HTML pretty-printer ────────────────────────────────────────────────

// Void elements have no closing tag and never open a nesting level, so — unlike
// in XML — encountering one must NOT increase indent depth.
const HTML_VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
// Elements whose content is opaque text, not markup, and so must be emitted
// verbatim rather than tokenised into child tags.
const HTML_RAW = new Set(["script", "style", "pre", "textarea"]);

/**
 * Pretty-print HTML into one-tag-per-line, indented source so the styled body
 * view can fold it by indentation (the same machinery as JSON/XML/YAML).
 *
 * The browser's own HTML parser does the heavy lifting via DOMParser — that
 * handles void elements, raw-text elements, comments and malformed markup
 * correctly, where the XML tokeniser (prettyXml) would mis-nest. The output is
 * a normalised, reflowed view; the Raw tab and HTML Preview keep full fidelity.
 */
function prettyHtml(html) {
  try {
    const INDENT = "  ";
    const doc = new DOMParser().parseFromString(html, "text/html");
    if (!doc || !doc.documentElement) return html;

    const escAttr = (v) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    const escText = (v) =>
      v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const openTag = (el) => {
      const attrs = Array.from(el.attributes)
        .map((a) =>
          a.value === "" ? ` ${a.name}` : ` ${a.name}="${escAttr(a.value)}"`,
        )
        .join("");
      return `<${el.tagName.toLowerCase()}${attrs}>`;
    };

    const out = [];
    // Emit str across lines, prefixing each with pad so fold nesting stays
    // intact (every emitted line is at least as indented as its parent line).
    const pushLines = (str, pad) => {
      for (const line of str.replace(/\r\n/g, "\n").split("\n")) {
        out.push(pad + line);
      }
    };

    const renderElement = (node, depth) => {
      const pad = INDENT.repeat(depth);
      const tag = node.tagName.toLowerCase();

      if (HTML_VOID.has(tag)) {
        out.push(pad + openTag(node));
        return;
      }

      if (HTML_RAW.has(tag)) {
        const open = openTag(node);
        const close = `</${tag}>`;
        const raw = node.textContent ?? "";
        if (!raw.trim()) {
          out.push(pad + open + close);
          return;
        }
        out.push(pad + open);
        // script/style are code (CDATA-like, kept literal); pre/textarea are
        // text and must be re-escaped to valid source.
        const body = tag === "script" || tag === "style" ? raw : escText(raw);
        pushLines(body, INDENT.repeat(depth + 1));
        out.push(pad + close);
        return;
      }

      const kids = Array.from(node.childNodes);
      if (kids.length === 0) {
        out.push(pad + openTag(node) + close(tag));
        return;
      }
      // A lone text child stays inline: <title>Hello</title>.
      if (kids.length === 1 && kids[0].nodeType === Node.TEXT_NODE) {
        const t = kids[0].textContent.trim();
        out.push(pad + openTag(node) + (t ? escText(t) : "") + close(tag));
        return;
      }

      out.push(pad + openTag(node));
      for (const child of kids) renderChild(child, depth + 1);
      out.push(pad + close(tag));
    };

    const close = (tag) => `</${tag}>`;

    const renderChild = (child, depth) => {
      const pad = INDENT.repeat(depth);
      switch (child.nodeType) {
        case Node.ELEMENT_NODE:
          renderElement(child, depth);
          break;
        case Node.TEXT_NODE: {
          const t = child.textContent.trim();
          if (t) out.push(pad + escText(t));
          break;
        }
        case Node.COMMENT_NODE:
          pushLines(`<!--${child.textContent}-->`, pad);
          break;
        default:
          break;
      }
    };

    if (doc.doctype) out.push(`<!DOCTYPE ${doc.doctype.name}>`);
    renderElement(doc.documentElement, 0);
    return out.join("\n");
  } catch {
    return html;
  }
}

// ── ResponseViewer class ──────────────────────────────────────────────────────

export class ResponseViewer {
  static #SVG_COPY = icon("copy", { size: 18 });
  static #SVG_CHECK = icon("check", { size: 18 });

  /** @type {HTMLElement} */
  #el;
  #activeTab = "body...";
  #renderMode = "styled"; // "styled" | "raw" | "hex"
  #wrapResponseText = true; // wrap long lines in Styled mode (settings-controlled)
  #lastResponse = null; // cached so mode changes can re-render

  // Cached pane references (set once in #renderTabContent)
  #bodyPane = null;
  #previewPane = null;

  // Whether the current response has an HTML content-type (drives Preview tab visibility)
  #isHtmlResponse = false;

  // HTTP method of the currently loaded request (drives Body tab colour in Styled mode)
  #currentMethod = "get";

  // HTML-preview state
  #htmlPreviewActive = false; // true while an HTML preview is live
  #popupDepth = 0; // count of currently open popups (prevents re-show during rapid open/close)
  #snapshotPending = false; // true while capture() is in-flight; cleared on popup-closed to cancel
  #previewSnapshot = null; // <img> standing in for the hidden WebContentsView during a popup
  #iframeEl = null; // dev-mode <iframe> element
  #resizeObserver = null; // observes body pane for Electron overlay
  #winResizeHandler = null; // window resize listener for Electron overlay
  #settingsHandler = null; // wurl:settings-changed listener for font-size repositioning

  // Binary-response state (images / PDF). The Hex view is a render mode (see
  // #renderMode), available for every content-type via the Body context menu.
  #objectUrl = null; // active blob: URL for an image preview (revoked on teardown)
  #pdfPreviewActive = false; // true while the native PDF overlay is live
  #pdfHost = null; // body-pane element the PDF overlay is positioned against
  #pdfResizeObserver = null; // observes #pdfHost for the PDF overlay
  #pdfWinResizeHandler = null; // window resize listener for the PDF overlay
  #pdfSettingsHandler = null; // settings-changed listener for the PDF overlay

  // Find-in-response search bar state
  #searchBar = null; // the bar element
  #searchInput = null; // text input
  #prevBtn = null; // navigate to previous match
  #nextBtn = null; // navigate to next match
  #caseBtn = null; // Cc toggle button
  #regexBtn = null; // .* toggle button
  #searchMatches = []; // current <mark> elements
  #searchCurrent = -1; // index of the active (focused) match
  #foldReveal = null; // fn(lineEl) that expands collapsed folds around a line, or null when the body isn't a foldable view

  // Timeline state
  #timelineEntries = []; // current list of HistoryEntry objects (newest first)
  #timelineSelected = -1; // index of the selected entry (-1 = none)
  #requestId = null; // id of the request whose timeline is shown (for delete/clear)
  #timestampTimer = null; // setInterval handle for live timestamp updates

  constructor() {
    this.#el = document.createElement("div");
    this.#el.className = "response-viewer";

    this.#renderStatusBar();
    this.#renderTabStrip();
    this.#renderTabContent();
    this.#renderSearchBar(); // inserted between tab-strip and tab-content

    // Track the active request's method so the Body tab colour stays in sync.
    window.addEventListener("wurl:request-selected", (e) => {
      if (e.detail?.method) this.#setCurrentMethod(e.detail.method);
    });
    window.addEventListener("wurl:request-updated", (e) => {
      if (e.detail?.method) this.#setCurrentMethod(e.detail.method);
    });

    // Listen for responses
    window.addEventListener("wurl:response-received", (e) =>
      this.#showResponse(e.detail),
    );
    window.addEventListener("wurl:request-loading", () => this.#showLoading());
    window.addEventListener("wurl:request-error", (e) =>
      this.#showError(e.detail),
    );

    // Update the timeline tab whenever history changes.
    // When isRequestSwitch is true the dispatch comes after the history load
    // is complete (sync from memory or after async storage fetch), so it is
    // safe to update the body display here rather than racing on a microtask.
    window.addEventListener("wurl:timeline-update", (e) => {
      this.#timelineEntries = e.detail?.entries ?? [];
      this.#requestId = e.detail?.requestId ?? null;
      this.#timelineSelected = -1;
      this.#renderTimeline();
      if (e.detail?.isRequestSwitch) {
        if (this.#activeTab !== "body") this.#switchTab("body");
        const entry = this.#timelineEntries[0];
        if (entry?.response?.error) {
          this.#showError({
            ...entry.response.error,
            elapsed: entry.response.elapsed,
            consoleLog: entry.response.consoleLog,
          });
        } else if (entry?.response) {
          this.#showResponse(entry.response, entry.requestUrl);
        } else {
          this.#clearToEmpty();
        }
      } else if (!this.#timelineEntries.length) {
        // History was cleared (last entry deleted or "Delete All") without a
        // request switch — wipe the response panes and status bar too.
        this.#clearToEmpty();
      }
    });

    // Keyboard shortcuts while focus is inside the response viewer
    this.#el.addEventListener("keydown", (e) => {
      // Cmd/Ctrl+A → select body text only (pass through when search input is focused)
      const selectAll =
        e.key === "a" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey;
      if (selectAll && e.target !== this.#searchInput) {
        const pre = this.#bodyPane?.querySelector(".res-body-pre");
        if (!pre) return;
        e.preventDefault();
        e.stopPropagation();
        const range = document.createRange();
        range.selectNodeContents(pre);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }

      // Cmd/Ctrl+F → open find bar (ignored when HTML preview is live)
      const findKey =
        e.key === "f" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey;
      if (findKey) {
        e.preventDefault();
        e.stopPropagation();
        this.#openSearch();
      }
    });

    // Hide the Electron HTML preview whenever any popup/menu/dialog opens so the
    // native WebContentsView (which renders above all web content) does not cover it.
    // Before hiding, capture a screenshot and display it as a static stand-in so the
    // preview area does not go blank while the popup is open. Re-show the live view
    // and discard the snapshot once the popup is dismissed.
    window.addEventListener("wurl:popup-opened", async () => {
      this.#popupDepth++;
      // The native PDF overlay renders above all web content too — hide it so a
      // context menu / dialog is not obscured. (No snapshot: a brief blank under
      // a transient menu is acceptable.)
      if (this.#pdfPreviewActive && window.wurl?.isElectron) {
        window.wurl.pdfPreview.hide().catch(() => {});
      }
      if (!this.#htmlPreviewActive || !window.wurl?.isElectron) return;
      // Only capture on the first popup; nested popups reuse the existing snapshot.
      if (this.#popupDepth === 1) {
        this.#snapshotPending = true;
        const dataUrl = await window.wurl.htmlPreview
          .capture()
          .catch(() => null);
        // If the popup was dismissed while capture was in-flight, #snapshotPending
        // will have been cleared — discard the result and do not hide the live view.
        if (!this.#snapshotPending) return;
        this.#snapshotPending = false;
        if (dataUrl && this.#htmlPreviewActive) {
          this.#showPreviewSnapshot(dataUrl);
        }
      }
      window.wurl.htmlPreview.hide().catch(() => {});
    });
    window.addEventListener("wurl:popup-closed", () => {
      this.#popupDepth = Math.max(0, this.#popupDepth - 1);
      // Cancel any capture still in-flight and remove the snapshot immediately —
      // the image must disappear as soon as the last popup is dismissed.
      this.#snapshotPending = false;
      if (this.#popupDepth === 0) this.#removePreviewSnapshot();
      // Re-show the PDF overlay once all popups are gone and Body is visible.
      if (
        this.#popupDepth === 0 &&
        this.#pdfPreviewActive &&
        window.wurl?.isElectron &&
        this.#activeTab === "body" &&
        this.#pdfHost
      ) {
        requestAnimationFrame(() => {
          if (this.#pdfPreviewActive && this.#popupDepth === 0) {
            window.wurl.pdfPreview
              .show(this.#computeBounds(this.#pdfHost))
              .catch(() => {});
          }
        });
      }
      if (!this.#htmlPreviewActive || !window.wurl?.isElectron) return;
      if (this.#activeTab !== "preview") return; // preview tab not visible — stay hidden
      requestAnimationFrame(() => {
        if (!this.#htmlPreviewActive || this.#popupDepth > 0) return;
        window.wurl.htmlPreview
          .show(this.#computePreviewBounds())
          .catch(() => {});
      });
    });
  }

  /**
   * Apply persisted settings to the viewer.
   * @param {{ responseBodyRenderMode?: string }} settings
   */
  applySettings(settings) {
    if (settings.responseBodyRenderMode) {
      const mode =
        settings.responseBodyRenderMode === "preview"
          ? "styled"
          : settings.responseBodyRenderMode;
      this.#renderMode = mode;
      this.#updateBodyTabStyle();
    }
    if (settings.wrapResponseText !== undefined) {
      const changed = this.#wrapResponseText !== settings.wrapResponseText;
      this.#wrapResponseText = settings.wrapResponseText;
      // Re-render so the wrap class on the body pane and cookie values reflect
      // the new value
      if (changed && this.#lastResponse) {
        this.#renderBodyPane(this.#lastResponse);
        this.#renderCookiesPane(this.#lastResponse.cookies);
      }
    }
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

  /**
   * Derive a download filename, extension and save-dialog filter label from a
   * response's content-type and request URL. Shared by the in-memory download
   * path and the spilled-body "save to file" path.
   * @param {object} resp
   * @returns {{ filename: string, ext: string, filterName: string }}
   */
  #downloadNaming(resp) {
    const ct = this.#contentTypeOf(resp.headers);
    const kind = classifyContentType(ct);

    let ext = "txt";
    let filterName = "Text";
    // Binary bodies (base64 in transit) name their file from the content-type.
    if (resp.encoding === "base64" || kind === "image" || kind === "pdf") {
      ext = binaryExtension(ct);
      filterName =
        kind === "pdf" ? "PDF" : kind === "image" ? "Image" : "Binary";
    } else if (kind === "json") {
      ext = "json";
      filterName = "JSON";
    } else if (kind === "html") {
      ext = "html";
      filterName = "HTML";
    } else if (kind === "xml") {
      ext = "xml";
      filterName = "XML";
    } else if (kind === "css") {
      ext = "css";
      filterName = "CSS";
    } else if (kind === "javascript") {
      ext = "js";
      filterName = "JavaScript";
    } else if (kind === "yaml") {
      ext = "yaml";
      filterName = "YAML";
    }

    const url = resp.requestUrl ?? "";
    const base = url
      ? url
          .split("?")[0]
          .split("/")
          .filter(Boolean)
          .pop()
          ?.replace(/[^a-zA-Z0-9._-]/g, "_") || "response"
      : "response";

    return { filename: `${base}.${ext}`, ext, filterName };
  }

  #downloadBody() {
    const resp = this.#lastResponse;
    if (!resp) return;

    // A spilled response only holds a preview in memory — stream the full body
    // straight from the main-process cache to the user's chosen file instead.
    if (resp.truncated && resp.bodyRef) {
      this.#saveFullBody(resp);
      return;
    }

    if (!resp.body) return;

    const { filename, ext, filterName } = this.#downloadNaming(resp);
    // Binary bodies travel as base64 and are decoded to bytes by the main
    // process so the saved file is byte-accurate; text is written as UTF-8.
    window.wurl?.export?.saveFile(
      filename,
      resp.body,
      [
        { name: filterName, extensions: [ext] },
        { name: "All Files", extensions: ["*"] },
      ],
      resp.encoding === "base64" ? "base64" : undefined,
    );
  }

  // ── Tab strip ─────────────────────────────────────────────────────────────
  #renderTabStrip() {
    const strip = document.createElement("div");
    strip.className = "res-tab-strip";
    strip.setAttribute("role", "tablist");

    TABS.forEach((tab) => {
      const btn = document.createElement("button");
      btn.className = "res-tab-btn";
      btn.dataset.tab = tab.id;
      btn.setAttribute("role", "tab");
      btn.setAttribute(
        "aria-selected",
        tab.id === this.#activeTab ? "true" : "false",
      );
      btn.setAttribute("aria-controls", `res-tab-${tab.id}`);
      if (tab.id === this.#activeTab) btn.classList.add("res-tab-btn--active");

      if (tab.id === "body") {
        btn.textContent = "Body…";
        btn.dataset.method = this.#currentMethod;
        btn.title = "Secondary click for options";
        btn.classList.add(this.#modeClass());
        // Right-click on the Body tab → render-mode context menu
        btn.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.#showBodyContextMenu(e.clientX, e.clientY);
        });
      } else {
        btn.textContent = tab.label;
        if (tab.id === "preview") btn.hidden = true;
      }

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

    // Cache direct references to the body and preview panes
    this.#bodyPane = content.querySelector("#res-tab-body");
    this.#previewPane = content.querySelector("#res-tab-preview");

    // Right-click on the rendered body text → Copy (+ Wrap toggle when Styled)
    this.#bodyPane.addEventListener("contextmenu", (e) => {
      const pre = this.#bodyPane.querySelector(".res-body-pre");
      if (!pre || !pre.contains(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      this.#showBodyTextContextMenu(e.clientX, e.clientY);
    });

    // Initial empty state in body pane
    this.#bodyPane.appendChild(this.#emptyState());

    // Initial empty state in console pane
    const consolePane = content.querySelector("#res-tab-console");
    consolePane.appendChild(this.#consolePlaceholder());

    this.#el.appendChild(content);
    this._tabContent = content;
  }

  // ── Find / search bar ─────────────────────────────────────────────────────

  /**
   * Build the search bar and insert it between the tab strip and the tab
   * content area.  The bar starts hidden and is revealed by Cmd/Ctrl+F.
   */
  #renderSearchBar() {
    const bar = document.createElement("div");
    bar.className = "res-search-bar";
    bar.hidden = true;

    const label = document.createElement("span");
    label.className = "res-search-label";
    label.textContent = "Find";
    label.setAttribute("aria-hidden", "true");

    const input = document.createElement("input");
    input.type = "text";
    input.className = "res-search-input";
    input.placeholder = "Search…";
    input.setAttribute("aria-label", "Search in response body");

    const actions = document.createElement("div");
    actions.className = "res-search-actions";

    // Previous-match button (up arrow)
    const prevBtn = document.createElement("button");
    prevBtn.className = "res-search-btn res-search-nav-btn";
    prevBtn.title = "Previous match (Shift+Enter)";
    prevBtn.setAttribute("aria-label", "Previous match");
    prevBtn.disabled = true;
    prevBtn.innerHTML = icon("chevronUp", { size: 12 });

    // Next-match button (down arrow)
    const nextBtn = document.createElement("button");
    nextBtn.className = "res-search-btn res-search-nav-btn";
    nextBtn.title = "Next match (Enter)";
    nextBtn.setAttribute("aria-label", "Next match");
    nextBtn.disabled = true;
    nextBtn.innerHTML = icon("chevronDown", { size: 12 });

    // Case-sensitivity toggle
    const caseBtn = document.createElement("button");
    caseBtn.className = "res-search-btn";
    caseBtn.title = "Match case";
    caseBtn.setAttribute("aria-label", "Match case");
    caseBtn.setAttribute("aria-pressed", "false");
    caseBtn.textContent = "Cc";

    // Regular-expression toggle
    const regexBtn = document.createElement("button");
    regexBtn.className = "res-search-btn";
    regexBtn.title = "Regular expression";
    regexBtn.setAttribute("aria-label", "Use regular expression");
    regexBtn.setAttribute("aria-pressed", "false");
    regexBtn.textContent = ".*";

    // Close button
    const closeBtn = document.createElement("button");
    closeBtn.className = "res-search-btn res-search-close-btn";
    closeBtn.title = "Close search (Escape)";
    closeBtn.setAttribute("aria-label", "Close search");
    closeBtn.innerHTML = icon("close", { size: 12 });

    actions.appendChild(prevBtn);
    actions.appendChild(nextBtn);
    actions.appendChild(caseBtn);
    actions.appendChild(regexBtn);
    actions.appendChild(closeBtn);

    bar.appendChild(label);
    bar.appendChild(input);
    bar.appendChild(actions);

    // ── Event wiring ──────────────────────────────────────────────────────
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        // If results are already applied, Enter/Shift+Enter navigates; otherwise run.
        if (this.#searchMatches.length > 0) {
          this.#goToMatch(this.#searchCurrent + (e.shiftKey ? -1 : 1));
        } else {
          this.#runSearch();
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.#closeSearch();
      }
    });

    prevBtn.addEventListener("click", () =>
      this.#goToMatch(this.#searchCurrent - 1),
    );
    nextBtn.addEventListener("click", () =>
      this.#goToMatch(this.#searchCurrent + 1),
    );

    caseBtn.addEventListener("click", () => {
      const active = caseBtn.classList.toggle("res-search-btn--active");
      caseBtn.setAttribute("aria-pressed", String(active));
      if (input.value.trim()) this.#runSearch();
    });

    regexBtn.addEventListener("click", () => {
      const active = regexBtn.classList.toggle("res-search-btn--active");
      regexBtn.setAttribute("aria-pressed", String(active));
      if (input.value.trim()) this.#runSearch();
    });

    closeBtn.addEventListener("click", () => this.#closeSearch());

    this.#searchBar = bar;
    this.#searchInput = input;
    this.#prevBtn = prevBtn;
    this.#nextBtn = nextBtn;
    this.#caseBtn = caseBtn;
    this.#regexBtn = regexBtn;

    // Insert between tab strip and tab content
    this.#el.insertBefore(bar, this._tabContent);
  }

  /** Show the search bar and focus the input. No-op when HTML preview is live. */
  #openSearch() {
    if (this.#htmlPreviewActive) return;
    this.#searchBar.hidden = false;
    this.#searchInput.select();
    this.#searchInput.focus();
  }

  /** Hide the search bar and remove all highlights. */
  #closeSearch() {
    this.#searchBar.hidden = true;
    this.#clearHighlights();
  }

  /**
   * Navigate to the match at `index`, wrapping at both ends.
   * Removes the current-highlight class from the old match, adds it to the
   * new one, and scrolls it into view.
   */
  #goToMatch(index) {
    const count = this.#searchMatches.length;
    if (count === 0) return;

    // Remove current-highlight from the previous active match
    if (this.#searchCurrent >= 0 && this.#searchCurrent < count) {
      this.#searchMatches[this.#searchCurrent].classList.remove(
        "res-search-highlight--current",
      );
    }

    // Wrap around
    this.#searchCurrent = ((index % count) + count) % count;

    const mark = this.#searchMatches[this.#searchCurrent];
    mark.classList.add("res-search-highlight--current");

    // In the foldable JSON/XML view the match may sit inside a collapsed fold;
    // open the enclosing folds so the row is visible before scrolling to it.
    if (this.#foldReveal) {
      const lineEl = mark.closest(".res-fold-line");
      if (lineEl) this.#foldReveal(lineEl);
    }

    mark.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  /** Enable or disable the prev/next nav buttons based on whether matches exist. */
  #updateNavButtons() {
    const has = this.#searchMatches.length > 0;
    if (this.#prevBtn) this.#prevBtn.disabled = !has;
    if (this.#nextBtn) this.#nextBtn.disabled = !has;
  }

  /**
   * Run the current search query against the visible body text, wrapping
   * each match in a <mark class="res-search-highlight"> element.
   * Navigates to and highlights the first match.
   */
  #runSearch() {
    const query = this.#searchInput?.value ?? "";
    this.#clearHighlights();
    if (!query) return;

    // Only search text content — bail out for HTML previews or missing body
    if (this.#htmlPreviewActive) return;
    const pre = this.#bodyPane?.querySelector(".res-body-pre");
    if (!pre) return;

    const caseSensitive = this.#caseBtn.classList.contains(
      "res-search-btn--active",
    );
    const useRegex = this.#regexBtn.classList.contains(
      "res-search-btn--active",
    );
    const flags = caseSensitive ? "g" : "gi";

    let pattern;
    try {
      pattern = useRegex
        ? new RegExp(query, flags)
        : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
    } catch {
      return; // invalid regex — silently skip
    }

    this.#searchMatches = this.#highlightMatches(pre, pattern);
    this.#updateNavButtons();

    if (this.#searchMatches.length > 0) {
      this.#goToMatch(0);
    }
  }

  /**
   * Walk every text node inside `element`, wrap all regex matches in <mark>
   * elements styled with `res-search-highlight`, and return those marks.
   *
   * @param {HTMLElement} element
   * @param {RegExp}      regex    Must have the `g` flag set.
   * @returns {HTMLElement[]} ordered list of <mark> nodes
   */
  #highlightMatches(element, regex) {
    const marks = [];
    const walker = document.createTreeWalker(
      element,
      NodeFilter.SHOW_TEXT,
      null,
    );
    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) textNodes.push(node);

    for (const textNode of textNodes) {
      const text = textNode.textContent;
      regex.lastIndex = 0;
      if (!regex.test(text)) continue;
      regex.lastIndex = 0;

      const frag = document.createDocumentFragment();
      let lastIndex = 0;
      let match;
      while ((match = regex.exec(text)) !== null) {
        if (match.index > lastIndex) {
          frag.appendChild(
            document.createTextNode(text.slice(lastIndex, match.index)),
          );
        }
        const mark = document.createElement("mark");
        mark.className = "res-search-highlight";
        mark.textContent = match[0];
        frag.appendChild(mark);
        marks.push(mark);
        lastIndex = match.index + match[0].length;
        if (match[0].length === 0) regex.lastIndex++; // guard against zero-length matches
      }
      if (lastIndex < text.length) {
        frag.appendChild(document.createTextNode(text.slice(lastIndex)));
      }
      textNode.parentNode.replaceChild(frag, textNode);
    }

    return marks;
  }

  /**
   * Unwrap all <mark class="res-search-highlight"> nodes, restoring plain
   * text in their place, and reset the match list.
   */
  #clearHighlights() {
    if (this.#bodyPane) {
      this.#bodyPane
        .querySelectorAll("mark.res-search-highlight")
        .forEach((mark) => {
          const parent = mark.parentNode;
          if (!parent) return;
          parent.replaceChild(document.createTextNode(mark.textContent), mark);
          parent.normalize();
        });
    }
    this.#searchMatches = [];
    this.#searchCurrent = -1;
    this.#updateNavButtons();
  }

  /**
   * Build a `.panel-placeholder` element — the empty/loading/error message a
   * pane shows before (or instead of) real content. Every placeholder across
   * the viewer is built here so the markup (optional emoji icon span + text
   * span) stays identical; callers vary only the icon, text, and extra classes.
   * `text` is escaped, so dynamic strings (e.g. an error message) are safe; the
   * static call sites pass plain prose that escapes to itself.
   *
   * @param {object}  opts
   * @param {string} [opts.icon]       emoji for the icon span (omitted if falsy)
   * @param {string}  opts.text        message text (escaped)
   * @param {string} [opts.className]  extra class(es) on the placeholder div
   * @param {string} [opts.iconClass]  extra class(es) on the icon span
   * @returns {HTMLDivElement}
   */
  #placeholder({ icon, text, className = "", iconClass = "" } = {}) {
    const el = document.createElement("div");
    el.className = className
      ? `panel-placeholder ${className}`
      : "panel-placeholder";
    const parts = [];
    if (icon) {
      const ic = iconClass
        ? `placeholder-icon ${iconClass}`
        : "placeholder-icon";
      parts.push(`<span class="${ic}">${icon}</span>`);
    }
    parts.push(`<span>${escapeHtml(text)}</span>`);
    el.innerHTML = parts.join("");
    return el;
  }

  #emptyState() {
    return this.#placeholder({
      icon: "📡",
      text: "Send a request to see the response",
    });
  }

  #consolePlaceholder() {
    return this.#placeholder({
      icon: "🖥️",
      text: "Verbose output from each request will appear here",
    });
  }

  // ── Body context menu ─────────────────────────────────────────────────────

  /** Body-tab CSS class for the current render mode. */
  #modeClass() {
    if (this.#renderMode === "raw") return "res-tab-btn--raw-mode";
    if (this.#renderMode === "hex") return "res-tab-btn--hex-mode";
    return "res-tab-btn--styled-mode";
  }

  /** Sync the Body tab button styling to the current render mode. */
  #updateBodyTabStyle() {
    const btn = this._tabStrip?.querySelector('[data-tab="body"]');
    if (!btn) return;
    btn.classList.remove(
      "res-tab-btn--styled-mode",
      "res-tab-btn--raw-mode",
      "res-tab-btn--hex-mode",
    );
    btn.classList.add(this.#modeClass());
    btn.dataset.method = this.#currentMethod;
  }

  /** Update the tracked HTTP method and refresh the Body tab colour. */
  #setCurrentMethod(method) {
    this.#currentMethod = method.toLowerCase();
    const btn = this._tabStrip?.querySelector('[data-tab="body"]');
    if (btn) btn.dataset.method = this.#currentMethod;
  }

  async #showBodyContextMenu(x, y) {
    const items = [
      {
        id: "styled",
        label: "Styled",
        type: "checkbox",
        checked: this.#renderMode === "styled",
      },
      {
        id: "raw",
        label: "Raw",
        type: "checkbox",
        checked: this.#renderMode === "raw",
      },
      {
        id: "hex",
        label: "Hex",
        type: "checkbox",
        checked: this.#renderMode === "hex",
      },
      { type: "separator" },
      { id: "download", label: "Download..." },
    ];
    const clickedId = await window.wurl.ui.contextMenu({ items, x, y });
    if (clickedId === "download") {
      this.#downloadBody();
    } else if (clickedId) {
      this.#setRenderMode(clickedId);
    }
  }

  /**
   * Context menu for the rendered body text — Copy the current selection, plus
   * a "Wrap" toggle when in Styled mode. Copy works in both Styled and Raw.
   */
  async #showBodyTextContextMenu(x, y) {
    const selectedText = window.getSelection()?.toString() ?? "";
    const items = [{ id: "copy", label: "Copy", enabled: !!selectedText }];
    // Styled mode → offer the wrap toggle (Raw is never wrapped via this menu)
    if (this.#renderMode !== "raw") {
      items.push(
        { type: "separator" },
        {
          id: "wrap",
          label: "Wrap",
          type: "checkbox",
          checked: this.#wrapResponseText,
        },
      );
    }
    const clickedId = await window.wurl.ui.contextMenu({ items, x, y });
    if (clickedId === "copy") {
      if (selectedText) {
        navigator.clipboard.writeText(selectedText).catch(() => {});
      }
    } else if (clickedId === "wrap") {
      // Invert and persist via the shared settings channel; app.js re-applies
      // the setting (which re-renders this pane with the new wrap state).
      window.dispatchEvent(
        new CustomEvent("wurl:settings-changed", {
          detail: { wrapResponseText: !this.#wrapResponseText },
        }),
      );
    }
  }

  #setRenderMode(mode) {
    if (this.#renderMode === mode) return;
    this.#renderMode = mode;
    this.#updateBodyTabStyle();
    // Persist the choice via the shared editor-setting channel
    window.dispatchEvent(
      new CustomEvent("wurl:editor-setting-changed", {
        detail: { responseBodyRenderMode: mode },
      }),
    );
    // Re-render the body pane if we have a cached response
    if (this.#lastResponse) {
      this.#renderBodyPane(this.#lastResponse);
    }
  }

  // ── Render body pane ──────────────────────────────────────────────────────

  /**
   * Resolve the Content-Type header value case-insensitively.
   *
   * Node.js (Electron) lowercases all header names while browsers may preserve
   * title-case; searching case-insensitively lets the same lookup work in both
   * environments. Returns "" when no Content-Type header is present.
   *
   * @param {object} headers  - response header map
   * @returns {string} the raw Content-Type value (with params), or ""
   */
  #contentTypeOf(headers) {
    return (
      Object.entries(headers ?? {}).find(
        ([k]) => k.toLowerCase() === "content-type",
      )?.[1] ?? ""
    );
  }

  /**
   * Fill an element with Prism-highlighted markup when a grammar is available,
   * otherwise with plain text. Centralises the highlight/plain fork shared by
   * every code-rendering path.
   *
   * @param {HTMLElement} el      target (<code> block or per-line <span>)
   * @param {string} text         source text to render
   * @param {string} prismLang    Prism language id (the highlight hint)
   * @param {object} [grammar]    resolved Prism grammar; defaults to the lookup
   *                              for prismLang. Pass an already-resolved grammar
   *                              in hot loops to skip the per-call lookup.
   */
  #fillHighlighted(el, text, prismLang, grammar = Prism.languages[prismLang]) {
    if (grammar) el.innerHTML = Prism.highlight(text, grammar, prismLang);
    else el.textContent = text;
  }

  /**
   * Append a `<code class="language-…">` block to a <pre>, highlighted via
   * #fillHighlighted.
   *
   * @param {HTMLPreElement} pre   the <pre> to append to
   * @param {string} text          source text
   * @param {string} prismLang     Prism language id
   */
  #appendCodeBlock(pre, text, prismLang) {
    const code = document.createElement("code");
    code.className = `language-${prismLang}`;
    this.#fillHighlighted(code, text, prismLang);
    pre.appendChild(code);
  }

  /**
   * Main body-pane renderer — routes to text, HTML iframe, or Electron overlay
   * depending on content type and render mode.
   *
   * @param {object} response  - cached response object (includes requestUrl)
   */
  #renderBodyPane(response) {
    const pane = this.#bodyPane;
    const category = classifyContentType(this.#contentTypeOf(response.headers));

    this.#clearHighlights();
    // Tear down any binary ephemera (PDF overlay, image blob URL) before the
    // pane is rebuilt; the new render re-creates whatever it needs.
    this.#teardownBinaryEphemera();
    pane.innerHTML = "";
    pane.classList.remove("res-tab-pane--fill"); // only the PDF view re-adds this

    // ── Hex view ──────────────────────────────────────────────────────────
    // A render mode (like Styled/Raw) selectable for every content-type from
    // the Body context menu: dump the raw bytes regardless of the body's type.
    if (this.#renderMode === "hex") {
      this.#foldReveal = null;
      if (response.truncated) {
        pane.appendChild(this.#buildTruncationBanner(response));
      }
      this.#renderHex(response, pane);
      return;
    }

    // ── Binary rendering (images / PDF) ───────────────────────────────────
    // A base64 encoding is the authoritative "these are raw bytes" signal from
    // the main process; SVG arrives as UTF-8 text but still renders as an image.
    if (response.encoding === "base64" || category === "image") {
      this.#renderBinaryBody(response, category);
      return;
    }

    // Spilled (large) responses only carry a preview in `body`; surface a banner
    // offering to fetch or save the full payload from the main-process cache.
    if (response.truncated) {
      pane.appendChild(this.#buildTruncationBanner(response));
    }

    // ── Markdown rendering ────────────────────────────────────────────────
    // Styled markdown becomes sanitized rich HTML (marked + DOMPurify); its
    // fenced code blocks are then re-highlighted with the bundled Prism.
    // Raw mode falls through to the verbatim <pre> path below.
    if (this.#renderMode !== "raw" && category === "markdown") {
      this.#foldReveal = null;
      const md = document.createElement("div");
      // Keep the .res-body-pre class so select-all, copy and search machinery
      // (which query `.res-body-pre`) keep working on the rendered block.
      md.className = "res-body-pre res-body-md";
      md.tabIndex = 0;
      md.innerHTML = renderMarkdown(response.body ?? "");
      this.#highlightMarkdownCode(md);
      pane.appendChild(md);

      // Re-apply an active search query (the pane was just rebuilt).
      if (
        this.#searchBar &&
        !this.#searchBar.hidden &&
        this.#searchInput?.value.trim()
      ) {
        this.#runSearch();
      }
      return;
    }

    // ── Text rendering ────────────────────────────────────────────────────
    // Styled: syntax-highlight all recognised types.
    // Raw:    verbatim plain text for every type.
    // HTML preview (iframe / WebContentsView) is handled by the Preview tab.

    const pre = document.createElement("pre");
    pre.className = "res-body-pre";
    pre.tabIndex = 0;

    // Wrap setting only affects Styled mode; leave Raw untouched.
    if (this.#renderMode !== "raw" && !this.#wrapResponseText) {
      pre.classList.add("res-body-pre--no-wrap");
    }

    let prismLang = null;
    let displayText;

    if (this.#renderMode !== "raw") {
      if (category === "json") {
        displayText = this.#prettyBody(response.body, "json");
        prismLang = "json";
      } else if (category === "yaml") {
        displayText = response.body;
        prismLang = "yaml";
      } else if (category === "xml") {
        displayText = this.#prettyBody(response.body, "xml");
        prismLang = "markup";
      } else if (category === "html") {
        displayText = this.#prettyBody(response.body, "html");
        prismLang = "markup";
      } else if (category === "css") {
        displayText = response.body;
        prismLang = "css";
      } else if (category === "javascript") {
        displayText = response.body;
        prismLang = "javascript";
      } else {
        displayText = response.body;
      }
    } else {
      // Raw — verbatim for all types
      displayText = response.body;
    }

    // Styled JSON/XML/YAML/HTML/CSS/JS get a collapsible, line-based render with
    // a fold gutter; everything else is a single highlighted (or plain) block.
    this.#foldReveal = null;
    const foldable =
      this.#renderMode !== "raw" &&
      (category === "json" ||
        category === "xml" ||
        category === "yaml" ||
        category === "html" ||
        category === "css" ||
        category === "javascript");

    if (foldable) {
      this.#renderFoldableCode(pre, displayText, prismLang);
    } else if (prismLang) {
      this.#appendCodeBlock(pre, displayText, prismLang);
    } else {
      pre.textContent = displayText;
    }

    pane.appendChild(pre);

    // Re-apply an active search query (the pane was just rebuilt from scratch)
    if (
      this.#searchBar &&
      !this.#searchBar.hidden &&
      this.#searchInput?.value.trim()
    ) {
      this.#runSearch();
    }
  }

  // ── Binary rendering (images / PDF / hex) ─────────────────────────────────

  /**
   * Render a binary response body in Styled/Raw mode. The base64 `body` is
   * decoded to raw bytes; SVG (which arrives as UTF-8 text) builds its blob
   * from the source string. Images render inline and PDFs via the native
   * overlay; any other byte stream has no text form, so it falls back to a
   * hex+ASCII dump. The Hex render mode (handled in #renderBodyPane) forces a
   * dump for every content-type, so it is not reached here.
   *
   * @param {object} response
   * @param {string} category  classification of the content-type
   */
  #renderBinaryBody(response, category) {
    const pane = this.#bodyPane;
    this.#foldReveal = null;

    // Spilled preview banner (View full / Save).
    if (response.truncated) {
      pane.appendChild(this.#buildTruncationBanner(response));
    }

    const kind =
      category === "image" ? "image" : category === "pdf" ? "pdf" : "hex";

    // A spilled body only holds a partial preview inline — an image/PDF needs
    // the whole file, so prompt to load the full body (hex can show the slice).
    if (response.truncated && (kind === "image" || kind === "pdf")) {
      pane.appendChild(
        this.#placeholder({
          icon: kind === "pdf" ? "📄" : "🖼️",
          text: 'Large response — use "View full" above to preview.',
        }),
      );
      return;
    }

    if (kind === "image") this.#renderImage(response, pane);
    else if (kind === "pdf") this.#renderPdf(response, pane);
    else this.#renderHex(response, pane);
  }

  /** Decode a base64 response body to a Uint8Array of the raw bytes. */
  #decodeBytes(response) {
    const b64 = response.body ?? "";
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  /** Render an inline image from a blob: URL (revoked on the next teardown). */
  #renderImage(response, pane) {
    const ct =
      this.#contentTypeOf(response.headers).split(";")[0].trim() ||
      "application/octet-stream";
    const blob =
      response.encoding === "base64"
        ? new Blob([this.#decodeBytes(response)], { type: ct })
        : new Blob([response.body ?? ""], { type: ct || "image/svg+xml" });

    this.#revokeObjectUrl();
    this.#objectUrl = URL.createObjectURL(blob);

    const wrap = document.createElement("div");
    wrap.className = "res-image-wrap";
    const img = document.createElement("img");
    img.className = "res-body-image";
    img.alt = "Response image";
    img.src = this.#objectUrl;
    wrap.appendChild(img);
    pane.appendChild(wrap);
  }

  /**
   * Render a PDF. Electron overlays the native pdfium viewer (WebContentsView)
   * over a host element; the dev/browser build has no plugin and offers Save.
   */
  #renderPdf(response, pane) {
    if (!window.wurl?.isElectron) {
      pane.appendChild(
        this.#placeholder({
          icon: "📄",
          text: "PDF preview is available in the desktop app — use Save to file.",
        }),
      );
      return;
    }
    pane.classList.add("res-tab-pane--fill");
    const host = document.createElement("div");
    host.className = "res-pdf-host";
    pane.appendChild(host);
    this.#activatePdfPreview(host, response.body ?? "");
  }

  /** Render a capped hex + ASCII dump with 8-digit offsets, 16 bytes per row. */
  #renderHex(response, pane) {
    const bytes =
      response.encoding === "base64"
        ? this.#decodeBytes(response)
        : new TextEncoder().encode(response.body ?? "");

    const HEX_VIEW_LIMIT = 256 * 1024;
    const shown = Math.min(bytes.length, HEX_VIEW_LIMIT);
    if (shown < bytes.length) {
      const note = document.createElement("div");
      note.className = "res-hex-note";
      note.textContent = `Showing the first ${this.#formatSize(
        shown,
      )} of ${this.#formatSize(
        bytes.length,
      )} — use Save to file for the full body.`;
      pane.appendChild(note);
    }

    const pre = document.createElement("pre");
    pre.className = "res-body-pre res-hex-dump";
    pre.tabIndex = 0;
    this.#fillHexDump(pre, bytes, shown);
    pane.appendChild(pre);
    this.#reapplyActiveSearch();
  }

  /**
   * Build `offset  hex…  |ascii|` rows into `pre` as DOM, so the offset column
   * and the hex byte values can be themed independently — the offset span is
   * coloured with the warn token and the byte span with the info token, while
   * the ASCII gutter keeps the default text colour. Text nodes carry the
   * separators so select-all / copy / find still see a faithful plain-text dump.
   */
  #fillHexDump(pre, bytes, length) {
    for (let off = 0; off < length; off += 16) {
      const end = Math.min(off + 16, length);
      let hex = "";
      let ascii = "";
      for (let i = off; i < off + 16; i++) {
        if (i < end) {
          const b = bytes[i];
          hex += b.toString(16).padStart(2, "0") + " ";
          ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".";
        } else {
          hex += "   ";
        }
        if (i === off + 7) hex += " "; // gap between the two 8-byte halves
      }

      if (off !== 0) pre.appendChild(document.createTextNode("\n"));

      const offsetSpan = document.createElement("span");
      offsetSpan.className = "res-hex-offset";
      offsetSpan.textContent = off.toString(16).padStart(8, "0");

      const bytesSpan = document.createElement("span");
      bytesSpan.className = "res-hex-bytes";
      bytesSpan.textContent = hex;

      pre.appendChild(offsetSpan);
      pre.appendChild(document.createTextNode("  "));
      pre.appendChild(bytesSpan);
      pre.appendChild(document.createTextNode(` |${ascii}|`));
    }
  }

  /** Re-run an open find query after the body pane was rebuilt. */
  #reapplyActiveSearch() {
    if (
      this.#searchBar &&
      !this.#searchBar.hidden &&
      this.#searchInput?.value.trim()
    ) {
      this.#runSearch();
    }
  }

  // ── PDF preview overlay (native WebContentsView) ──────────────────────────

  /**
   * Activate the native PDF overlay over `host`, positioned by the same
   * ResizeObserver / window-resize / settings-change machinery as the HTML
   * preview. The PDF bytes are passed as base64; the main process writes a temp
   * file and loads it into a plugins-enabled WebContentsView.
   *
   * @param {HTMLElement} host    body-pane element the overlay covers
   * @param {string}      base64  PDF bytes, base64-encoded
   */
  #activatePdfPreview(host, base64) {
    this.#pdfPreviewActive = true;
    this.#pdfHost = host;

    const reposition = () => {
      if (this.#pdfPreviewActive) {
        window.wurl?.pdfPreview
          ?.resize(this.#computeBounds(host))
          .catch(() => {});
      }
    };

    this.#pdfResizeObserver = new ResizeObserver(reposition);
    this.#pdfResizeObserver.observe(host);

    this.#pdfSettingsHandler = () => requestAnimationFrame(reposition);
    window.addEventListener("wurl:settings-changed", this.#pdfSettingsHandler);

    this.#pdfWinResizeHandler = () => requestAnimationFrame(reposition);
    window.addEventListener("resize", this.#pdfWinResizeHandler);

    requestAnimationFrame(() => {
      if (!this.#pdfPreviewActive) return;
      window.wurl?.pdfPreview
        ?.loadFile(base64, this.#computeBounds(host))
        .catch(() => {});
    });
  }

  /** Tear down the native PDF overlay and its listeners. Safe when inactive. */
  #destroyPdfPreview() {
    if (!this.#pdfPreviewActive) return;
    this.#pdfPreviewActive = false;

    if (this.#pdfResizeObserver) {
      this.#pdfResizeObserver.disconnect();
      this.#pdfResizeObserver = null;
    }
    if (this.#pdfWinResizeHandler) {
      window.removeEventListener("resize", this.#pdfWinResizeHandler);
      this.#pdfWinResizeHandler = null;
    }
    if (this.#pdfSettingsHandler) {
      window.removeEventListener(
        "wurl:settings-changed",
        this.#pdfSettingsHandler,
      );
      this.#pdfSettingsHandler = null;
    }
    this.#pdfHost = null;
    if (window.wurl?.pdfPreview?.destroy) {
      window.wurl.pdfPreview.destroy().catch(() => {});
    }
  }

  /** Revoke the active image blob: URL, if any. */
  #revokeObjectUrl() {
    if (this.#objectUrl) {
      try {
        URL.revokeObjectURL(this.#objectUrl);
      } catch {
        // best-effort
      }
      this.#objectUrl = null;
    }
  }

  /** Destroy all binary ephemera (PDF overlay + image blob URL). */
  #teardownBinaryEphemera() {
    this.#destroyPdfPreview();
    this.#revokeObjectUrl();
  }

  /**
   * Build the banner shown above a spilled (truncated) response body. It reports
   * the preview/full sizes and, when the full body is still cached in the main
   * process (`bodyRef` present), offers buttons to load it inline or save it to
   * a file. After a restart the cache is gone, so we show an explanatory note.
   * @param {object} response  The cached `#lastResponse`.
   * @returns {HTMLElement}
   */
  #buildTruncationBanner(response) {
    const banner = document.createElement("div");
    banner.className = "res-truncation-banner";

    const text = document.createElement("span");
    text.className = "res-truncation-text";
    const previewBytes = (response.body ?? "").length;
    text.textContent = `Large response — showing the first ${this.#formatSize(
      previewBytes,
    )} of ${this.#formatSize(response.fullSize ?? 0)}.`;
    banner.appendChild(text);

    if (response.bodyRef) {
      const viewBtn = document.createElement("button");
      viewBtn.type = "button";
      viewBtn.className = "btn btn--secondary res-truncation-btn";
      viewBtn.textContent = "View full";
      viewBtn.addEventListener("click", () => this.#loadFullBody(response));
      banner.appendChild(viewBtn);

      const saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.className = "btn btn--secondary res-truncation-btn";
      saveBtn.textContent = "Save to file";
      saveBtn.addEventListener("click", () => this.#saveFullBody(response));
      banner.appendChild(saveBtn);
    } else {
      const note = document.createElement("span");
      note.className = "res-truncation-note";
      note.textContent = "Full response is no longer cached.";
      banner.appendChild(note);
    }

    return banner;
  }

  /**
   * Fetch the full spilled body from the main process and render it inline.
   * Very large bodies are redirected to "save to file" rather than risk
   * re-bloating the renderer — the whole point of spilling was to avoid that.
   * @param {object} response  The cached `#lastResponse`.
   */
  async #loadFullBody(response) {
    if (!response.bodyRef) return;

    // Guard: don't pull a huge payload back into the renderer; offer save.
    const INLINE_LIMIT = 16 * 1024 * 1024; // 16 MB
    if ((response.fullSize ?? 0) > INLINE_LIMIT) {
      this.#saveFullBody(response);
      return;
    }

    const res = await window.wurl?.http?.getBody(response.bodyRef);
    if (!res || res.error) {
      // Cache miss / read error — forget the ref so the banner stops offering it.
      response.bodyRef = null;
      this.#renderBodyPane(response);
      return;
    }

    response.body = res.body ?? "";
    response.encoding = res.encoding ?? response.encoding;
    response.truncated = false;
    response.size = res.size ?? response.size;
    this.#renderBodyPane(response);
  }

  /**
   * Stream the full spilled body from the main-process cache straight to a
   * user-chosen file via the native save dialog.
   * @param {object} response  The cached `#lastResponse`.
   */
  async #saveFullBody(response) {
    if (!response.bodyRef) return;
    const { filename } = this.#downloadNaming(response);
    const result = await window.wurl?.http?.saveBody(
      response.bodyRef,
      filename,
    );
    if (result && result.ok === false && result.reason === "not-found") {
      // The cache was reaped between render and click — refresh the banner.
      response.bodyRef = null;
      this.#renderBodyPane(response);
    }
  }

  /**
   * Re-highlight the fenced code blocks inside a rendered-markdown container
   * with the bundled Prism.  marked emits `<pre><code class="language-xxx">`
   * with the source as escaped text; we map the info-string to a Prism grammar
   * and replace the block's HTML with the highlighted version.
   *
   * @param {HTMLElement} root  - the rendered-markdown container
   */
  #highlightMarkdownCode(root) {
    const blocks = root.querySelectorAll('pre > code[class*="language-"]');
    for (const code of blocks) {
      const cls = /language-([\w-]+)/.exec(code.className)?.[1] ?? "";
      const prismLang = MD_CODE_LANG[cls.toLowerCase()];
      const grammar = prismLang ? Prism.languages[prismLang] : null;
      if (!grammar) continue;
      // textContent is the decoded source (marked escaped it into the markup).
      this.#fillHighlighted(code, code.textContent, prismLang, grammar);
      code.className = `language-${prismLang}`;
    }
  }

  /**
   * Render an indentation-structured body (JSON / XML / YAML / HTML / CSS / JS)
   * as a stack of foldable lines.
   *
   * Structure is read purely from leading whitespace: JSON, XML and HTML arrive
   * 2-space-indented from #prettyBody, while YAML, CSS and JavaScript are folded
   * on whatever indentation they were sent with (a minified, single-line body
   * simply yields no folds).  Each line becomes a flex row of
   * [fold-gutter][highlighted code]; a line whose next non-blank line is more
   * deeply indented opens a fold whose range runs until indentation returns to
   * that line's depth.
   *
   * Highlighting is applied per line.  For JSON/XML/YAML/HTML this is exact —
   * structural tokens stay within a single line.  CSS and JS may carry tokens
   * that straddle a newline (block comments in both, template literals in JS);
   * those spans are only approximately coloured line-by-line, but the text is
   * always intact (Prism escapes each line independently).
   *
   * The full text stays in the DOM even when folded (rows are hidden, not
   * removed) so find-in-response, select-all and copy keep working; #foldReveal
   * lets the search navigator open folds around a match.
   *
   * @param {HTMLPreElement} pre   the body <pre> to populate
   * @param {string} text          body text (pretty-printed for JSON/XML/HTML)
   * @param {string} prismLang     Prism language id
   *                               ("json"|"markup"|"yaml"|"css"|"javascript")
   */
  #renderFoldableCode(pre, text, prismLang) {
    const grammar = prismLang ? Prism.languages[prismLang] : null;
    const lines = text.split("\n");

    // Very large bodies: skip the per-line machinery and fall back to one block.
    const MAX_FOLD_LINES = 5000;
    if (lines.length > MAX_FOLD_LINES) {
      this.#appendCodeBlock(pre, text, prismLang);
      return;
    }

    pre.classList.add("res-body-pre--folding");

    // Leading-space depth per line; blank lines are continuations (null).
    const indent = lines.map((line) => {
      if (line.trim() === "") return null;
      return line.length - line.trimStart().length;
    });

    // foldEnd[i] = inclusive index of the last child line of opener i.
    const foldEnd = new Map();
    for (let i = 0; i < lines.length; i++) {
      const depth = indent[i];
      if (depth === null) continue;
      let next = i + 1;
      while (next < lines.length && indent[next] === null) next++;
      if (next < lines.length && indent[next] > depth) {
        let end = i;
        for (
          let k = i + 1;
          k < lines.length && (indent[k] === null || indent[k] > depth);
          k++
        ) {
          if (indent[k] !== null) end = k;
        }
        foldEnd.set(i, end);
      }
    }

    const lineEls = [];
    const collapsed = new Set();

    // Recompute row visibility. Nested fold ranges are guaranteed to nest (they
    // derive from indentation), so a single "hidden through" watermark suffices.
    const applyFolds = () => {
      let coverEnd = -1;
      for (let i = 0; i < lineEls.length; i++) {
        if (i <= coverEnd) {
          lineEls[i].hidden = true;
          continue;
        }
        lineEls[i].hidden = false;
        if (collapsed.has(i)) {
          const end = foldEnd.get(i);
          if (end !== undefined && end > coverEnd) coverEnd = end;
        }
      }
    };

    const frag = document.createDocumentFragment();
    for (let i = 0; i < lines.length; i++) {
      const lineEl = document.createElement("div");
      lineEl.className = "res-fold-line";
      lineEl.dataset.line = String(i);

      const gutter = document.createElement("span");
      gutter.className = "res-fold-gutter";

      if (foldEnd.has(i)) {
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "res-fold-toggle";
        toggle.setAttribute("aria-label", "Toggle fold");
        toggle.setAttribute("aria-expanded", "true");
        toggle.innerHTML = icon("caret", { size: null });
        toggle.addEventListener("click", () => {
          const nowCollapsed = !collapsed.has(i);
          if (nowCollapsed) collapsed.add(i);
          else collapsed.delete(i);
          lineEl.classList.toggle("res-fold-line--collapsed", nowCollapsed);
          toggle.setAttribute("aria-expanded", String(!nowCollapsed));
          applyFolds();
        });
        gutter.appendChild(toggle);
      }

      const code = document.createElement("span");
      code.className = `res-fold-code language-${prismLang}`;
      this.#fillHighlighted(code, lines[i], prismLang, grammar);

      lineEl.append(gutter, code);
      frag.appendChild(lineEl);
      lineEls.push(lineEl);
    }
    pre.appendChild(frag);

    // Let the search navigator open every collapsed fold enclosing a match line.
    this.#foldReveal = (lineEl) => {
      const idx = Number(lineEl?.dataset?.line);
      if (Number.isNaN(idx)) return;
      let changed = false;
      for (const opener of [...collapsed]) {
        const end = foldEnd.get(opener);
        if (opener < idx && end !== undefined && idx <= end) {
          collapsed.delete(opener);
          lineEls[opener].classList.remove("res-fold-line--collapsed");
          lineEls[opener]
            .querySelector(".res-fold-toggle")
            ?.setAttribute("aria-expanded", "true");
          changed = true;
        }
      }
      if (changed) applyFolds();
    };
  }

  // ── HTML preview helpers ──────────────────────────────────────────────────

  /**
   * Compute the pixel bounds for the Electron WebContentsView overlay.
   *
   * Uses the body pane's own bounding rect — the pane IS the exact area the
   * overlay should cover.  Its left edge sits against splitter-2, its top edge
   * starts below the res-tab-strip, and it fills to the bottom-right corner.
   *
   * Because the pane is flex: 1 inside its container, any font-size change
   * that shrinks/grows elements above it will cause the pane's OWN size to
   * change, which the ResizeObserver detects.  Reading the rect at callback
   * time gives us pixel-perfect position and dimensions in one shot.
   *
   * @returns {{ x: number, y: number, width: number, height: number }}
   */
  #computePreviewBounds() {
    return this.#computeBounds(this.#previewPane);
  }

  /**
   * Viewport-relative integer pixel bounds of an element, for positioning a
   * native WebContentsView overlay (HTML or PDF preview) directly over it.
   * @param {HTMLElement} el
   * @returns {{ x: number, y: number, width: number, height: number }}
   */
  #computeBounds(el) {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.left),
      y: Math.round(r.top),
      width: Math.max(1, Math.round(r.width)),
      height: Math.max(1, Math.round(r.height)),
    };
  }

  #showPreviewSnapshot(dataUrl) {
    this.#removePreviewSnapshot();
    const r = this.#previewPane.getBoundingClientRect();
    const img = document.createElement("img");
    img.src = dataUrl;
    img.style.cssText =
      `position:fixed;left:${r.left}px;top:${r.top}px;` +
      `width:${r.width}px;height:${r.height}px;` +
      `pointer-events:none;z-index:0;`;
    document.body.appendChild(img);
    this.#previewSnapshot = img;
  }

  #removePreviewSnapshot() {
    if (this.#previewSnapshot) {
      this.#previewSnapshot.remove();
      this.#previewSnapshot = null;
    }
  }

  /**
   * Electron mode: overlay a WebContentsView on the body pane and navigate to
   * the request URL.  A ResizeObserver on the body pane plus a settings-changed
   * listener keeps the bounds in sync as panels resize or the font-size changes.
   *
   * @param {string}      url   - original request URL to load
   * @param {HTMLElement} pane  - body pane element (used only for the loading placeholder)
   */
  #activateElectronHtmlPreview(url) {
    const pane = this.#previewPane;
    this.#htmlPreviewActive = true;

    // Show a lightweight loading indicator inside the pane while the URL loads.
    pane.appendChild(
      this.#placeholder({
        icon: "⏳",
        text: "Loading preview…",
        className: "res-html-loading",
        iconClass: "res-spinner",
      }),
    );

    // Keep the overlay positioned correctly when the panel splitter moves
    // (pane width/height changes) or font-size changes (pane grows/shrinks as
    // sibling elements like the tab-strip change height).
    this.#resizeObserver = new ResizeObserver(() => {
      if (this.#htmlPreviewActive && window.wurl?.htmlPreview?.resize) {
        window.wurl.htmlPreview.resize(this.#computePreviewBounds());
      }
    });
    this.#resizeObserver.observe(pane);

    // Listen for settings changes (primarily font-size) as a safety net.
    // Font-size changes alter the tab-strip and status-bar heights, which shifts
    // the pane's position.  In a flex layout the pane's own size changes too
    // (triggering the ResizeObserver), but a deferred reposition ensures we
    // pick up the final layout even if the observer fires before reflow settles.
    this.#settingsHandler = () => {
      if (!this.#htmlPreviewActive || !window.wurl?.htmlPreview?.resize) return;
      requestAnimationFrame(() => {
        if (this.#htmlPreviewActive && window.wurl?.htmlPreview?.resize) {
          window.wurl.htmlPreview.resize(this.#computePreviewBounds());
        }
      });
    };
    window.addEventListener("wurl:settings-changed", this.#settingsHandler);

    // Also reposition when the Electron window itself is resized.
    this.#winResizeHandler = () => {
      if (!this.#htmlPreviewActive || !window.wurl?.htmlPreview?.resize) return;
      // Defer one frame so the renderer layout has finished reflowing.
      requestAnimationFrame(() => {
        if (this.#htmlPreviewActive && window.wurl?.htmlPreview?.resize) {
          window.wurl.htmlPreview.resize(this.#computePreviewBounds());
        }
      });
    };
    window.addEventListener("resize", this.#winResizeHandler);

    // Defer the first loadUrl call so the pane has been laid out.
    requestAnimationFrame(() => {
      if (!this.#htmlPreviewActive) return; // destroyed before frame fired
      window.wurl?.htmlPreview
        ?.loadUrl(url, this.#computePreviewBounds())
        .catch(() => {});
    });
  }

  /**
   * Dev / plain-browser mode: render a simple <iframe> placeholder that
   * points at the request URL.  This is a stand-in until the Electron path
   * is verified working; the iframe is subject to normal browser same-origin
   * restrictions.
   *
   * @param {string}      url   - original request URL
   * @param {HTMLElement} pane  - body pane element
   */
  #activateDevHtmlPreview(url) {
    const pane = this.#previewPane;
    this.#htmlPreviewActive = true;

    // Pane must be the stacking context for the absolutely-positioned iframe.
    pane.style.position = "relative";
    pane.style.overflow = "hidden";

    const iframe = document.createElement("iframe");
    iframe.src = url ?? "about:blank";
    iframe.setAttribute("title", "HTML response preview");
    iframe.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;border:none;background:#fff;";
    pane.appendChild(iframe);
    this.#iframeEl = iframe;
  }

  /**
   * Tear down whichever HTML preview is currently active (Electron overlay or
   * dev iframe).  Safe to call when no preview is active.
   */
  #destroyHtmlPreview() {
    if (!this.#htmlPreviewActive) return;
    this.#htmlPreviewActive = false;

    // Disconnect ResizeObserver first so no more resize callbacks fire.
    if (this.#resizeObserver) {
      this.#resizeObserver.disconnect();
      this.#resizeObserver = null;
    }

    // Remove the window resize listener for the Electron overlay.
    if (this.#winResizeHandler) {
      window.removeEventListener("resize", this.#winResizeHandler);
      this.#winResizeHandler = null;
    }

    // Remove the settings-changed listener.
    if (this.#settingsHandler) {
      window.removeEventListener(
        "wurl:settings-changed",
        this.#settingsHandler,
      );
      this.#settingsHandler = null;
    }

    // Remove dev-mode iframe.
    if (this.#iframeEl) {
      this.#iframeEl.remove();
      this.#iframeEl = null;
      if (this.#previewPane) {
        this.#previewPane.style.position = "";
        this.#previewPane.style.overflow = "";
      }
    }

    // Destroy the Electron WebContentsView.
    if (window.wurl?.htmlPreview?.destroy) {
      window.wurl.htmlPreview.destroy().catch(() => {});
    }
  }

  /**
   * Show or hide the Preview tab.  When hidden while the Preview tab is active,
   * automatically switches to the Body tab.
   * @param {boolean} visible
   */
  #setPreviewTabVisible(visible) {
    const btn = this._tabStrip?.querySelector('[data-tab="preview"]');
    if (btn) btn.hidden = !visible;
    if (!visible && this.#activeTab === "preview") {
      this.#switchTab("body");
    }
  }

  // ── Pretty-printing ───────────────────────────────────────────────────────

  /**
   * Return a pretty-printed version of `body` for the given category.
   * Falls back to the raw body if parsing fails.
   *
   * @param {string} body
   * @param {"json"|"yaml"|"xml"|"html"} category
   */
  #prettyBody(body, category) {
    try {
      if (category === "json") {
        return JSON.stringify(JSON.parse(body), null, 2);
      }
      if (category === "xml") {
        return prettyXml(body);
      }
      if (category === "html") {
        return prettyHtml(body);
      }
      // YAML is typically already human-readable; return as-is.
    } catch {
      /* fall through to raw */
    }
    return body;
  }

  // ── Tab switching ─────────────────────────────────────────────────────────

  #switchTab(tabId) {
    const prevTab = this.#activeTab;
    this.#activeTab = tabId;

    this._tabStrip.querySelectorAll(".res-tab-btn").forEach((btn) => {
      const active = btn.dataset.tab === tabId;
      btn.classList.toggle("res-tab-btn--active", active);
      btn.setAttribute("aria-selected", String(active));
    });

    this._tabContent.querySelectorAll(".res-tab-pane").forEach((pane) => {
      pane.hidden = pane.id !== `res-tab-${tabId}`;
    });

    // ── HTML preview — lives on the Preview tab ───────────────────────────
    if (tabId === "preview" && prevTab !== "preview") {
      // Entering Preview tab
      if (this.#isHtmlResponse && this.#lastResponse) {
        if (this.#htmlPreviewActive) {
          // Preview was previously activated and hidden — re-show it.
          if (window.wurl?.isElectron) {
            requestAnimationFrame(() => {
              if (this.#htmlPreviewActive && this.#activeTab === "preview") {
                window.wurl.htmlPreview
                  .show(this.#computePreviewBounds())
                  .catch(() => {});
              }
            });
          }
          if (this.#iframeEl) this.#iframeEl.style.display = "";
        } else {
          // First time on this response — activate.
          if (window.wurl?.isElectron === true) {
            this.#activateElectronHtmlPreview(this.#lastResponse.requestUrl);
          } else {
            this.#activateDevHtmlPreview(this.#lastResponse.requestUrl);
          }
        }
      }
    } else if (prevTab === "preview" && tabId !== "preview") {
      // Leaving Preview tab — hide the overlay/iframe but keep it alive.
      if (this.#htmlPreviewActive) {
        if (window.wurl?.isElectron) {
          window.wurl.htmlPreview.hide().catch(() => {});
        }
        if (this.#iframeEl) this.#iframeEl.style.display = "none";
      }
    }

    // ── Native PDF overlay — lives on the Body tab ────────────────────────
    // Hide it when leaving Body so it doesn't float over other tabs; re-show it
    // (deferred a frame so layout settles) when returning to Body.
    if (this.#pdfPreviewActive && window.wurl?.isElectron && this.#pdfHost) {
      if (tabId === "body" && prevTab !== "body") {
        requestAnimationFrame(() => {
          if (
            this.#pdfPreviewActive &&
            this.#activeTab === "body" &&
            this.#pdfHost
          ) {
            window.wurl.pdfPreview
              .show(this.#computeBounds(this.#pdfHost))
              .catch(() => {});
          }
        });
      } else if (prevTab === "body" && tabId !== "body") {
        window.wurl.pdfPreview.hide().catch(() => {});
      }
    }

    // Lazy timeline: drop DOM when leaving, rebuild when entering.
    if (prevTab === "timeline" && tabId !== "timeline") {
      this.#stopTimestampUpdater();
      const pane = this._tabContent.querySelector("#res-tab-timeline");
      if (pane) pane.innerHTML = "";
    } else if (tabId === "timeline" && prevTab !== "timeline") {
      this.#renderTimeline();
      this.#startTimestampUpdater();
    }
  }

  // ── Response states ───────────────────────────────────────────────────────
  #showLoading() {
    this.#lastResponse = null;
    this.#destroyHtmlPreview();
    this.#teardownBinaryEphemera();
    this.#clearHighlights();
    this.#setStatus("", "", "", "");
    const bodyPane = this.#bodyPane;
    bodyPane.innerHTML = "";
    bodyPane.appendChild(
      this.#placeholder({
        icon: "⏳",
        text: "Sending request…",
        iconClass: "res-spinner",
      }),
    );

    // Clear console pane on each new request
    this.#renderConsole([]);
  }

  #showError(detail) {
    this.#lastResponse = null;
    this.#destroyHtmlPreview();
    this.#teardownBinaryEphemera();
    this.#setPreviewTabVisible(false);
    this.#clearHighlights();
    const hasStatus = detail?.status && detail.status > 0;
    const statusCode = hasStatus ? String(detail.status) : "ERR";
    const statusTxt = detail?.statusText || detail?.name || "Connection Error";
    const elapsed = detail?.elapsed ? `${detail.elapsed} ms` : "";

    this.#setStatus(statusCode, statusTxt, elapsed, "");
    const badge = this._statusBar.querySelector(".res-status-badge");
    badge.className = `res-status-badge ${hasStatus ? this.#statusClass(detail.status) : "res-status--error"}`;

    // Body pane — show error placeholder
    const bodyPane = this.#bodyPane;
    bodyPane.innerHTML = "";
    const err = this.#placeholder({
      icon: "⚠️",
      text: detail?.message ?? "Request failed",
    });
    if (detail?.hint) {
      const hint = document.createElement("span");
      hint.className = "res-error-hint";
      hint.textContent = detail.hint;
      err.appendChild(hint);
    }
    bodyPane.appendChild(err);

    // Console pane — always show the verbose log (or an error summary)
    const log =
      Array.isArray(detail?.consoleLog) && detail.consoleLog.length
        ? detail.consoleLog
        : [
            `* Error: ${detail?.name || "NetworkError"}`,
            `* ${detail?.message || "An unknown error occurred."}`,
            detail?.hint ? `* Hint: ${detail.hint}` : null,
          ].filter(Boolean);
    this.#renderConsole(log);
  }

  /** Reset the viewer to its initial empty state (no response loaded). */
  #clearToEmpty() {
    this.#lastResponse = null;
    this.#destroyHtmlPreview();
    this.#teardownBinaryEphemera();
    this.#setPreviewTabVisible(false);
    this.#clearHighlights();
    this.#setStatus("", "", "", "");
    this._statusBar.querySelector(".res-status-badge").className =
      "res-status-badge";
    this.#bodyPane.innerHTML = "";
    this.#bodyPane.appendChild(this.#emptyState());
    const headersPane = this._tabContent.querySelector("#res-tab-headers");
    if (headersPane) headersPane.innerHTML = "";
    const cookiesPane = this._tabContent.querySelector("#res-tab-cookies");
    if (cookiesPane) cookiesPane.innerHTML = "";
    this.#renderConsole([]);
  }

  /**
   * @param {object} response
   * @param {object}   response.request    - original request {method, url, headers, body}
   * @param {number}   response.status
   * @param {string}   response.statusText
   * @param {object}   response.headers
   * @param {string[]} response.cookies
   * @param {string}   response.body
   * @param {number}   response.elapsed   - milliseconds
   * @param {number}   response.size      - bytes
   * @param {string[]} response.consoleLog
   */
  #showResponse(response, requestUrl) {
    const {
      request = {},
      status = 0,
      statusText = "",
      headers = {},
      cookies = [],
      body = "",
      elapsed = 0,
      size = 0,
      consoleLog = [],
      truncated = false,
      bodyRef = null,
      fullSize = size,
      encoding = "utf8",
    } = response;

    // A fresh response starts in its default view; drop any binary overlay/blob
    // left over from the previous one.
    this.#teardownBinaryEphemera();

    // Cache the raw response for re-rendering when the mode changes.
    // requestUrl comes from the caller (history path) or falls back to the
    // request snapshot embedded in live wurl:response-received events.
    // truncated/bodyRef/fullSize describe spilled (large) responses whose full
    // body lives in the main process and is only fetched on demand.
    // encoding is "base64" for binary bodies (images / PDF / arbitrary bytes).
    this.#lastResponse = {
      requestUrl: requestUrl ?? request.url ?? "",
      status,
      statusText,
      headers,
      cookies,
      body,
      elapsed,
      size,
      consoleLog,
      truncated,
      bodyRef,
      fullSize,
      encoding,
    };

    // Sync method colour from the request that produced this response.
    if (request.method) this.#setCurrentMethod(request.method);

    // Show the Preview tab only for HTML responses.
    this.#isHtmlResponse =
      classifyContentType(this.#contentTypeOf(headers)) === "html";
    this.#setPreviewTabVisible(this.#isHtmlResponse);

    // Status bar
    const statusClass = this.#statusClass(status);
    this.#setStatus(
      status,
      statusText,
      `${elapsed} ms`,
      this.#formatSize(size),
    );
    const badge = this._statusBar.querySelector(".res-status-badge");
    badge.className = `res-status-badge ${statusClass}`;

    // ── Body pane ──────────────────────────────────────────────────────────
    this.#renderBodyPane(this.#lastResponse);

    // ── Headers pane ───────────────────────────────────────────────────────
    const headersPane = this._tabContent.querySelector("#res-tab-headers");
    headersPane.innerHTML = "";
    const table = document.createElement("table");
    table.className = "res-headers-table res-headers-table--split";
    Object.entries(headers).forEach(([k, v]) => {
      const row = table.insertRow();
      row.insertCell().textContent = k;
      row.insertCell().textContent = v;
    });
    headersPane.appendChild(table);

    // ── Cookies pane ───────────────────────────────────────────────────────
    this.#renderCookiesPane(cookies);

    // ── Console pane ───────────────────────────────────────────────────────
    this.#renderConsole(consoleLog);
  }

  /**
   * Render the Cookies tab from the response's raw Set-Cookie strings.
   *
   * The Value column mirrors the "Wrap response text" setting: when wrapping is
   * enabled each cookie value wraps within its cell; when disabled the value
   * stays on one line and the table scrolls horizontally off to the right.
   *
   * @param {string[]} cookies  - raw Set-Cookie header values
   */
  #renderCookiesPane(cookies = []) {
    const cookiesPane = this._tabContent.querySelector("#res-tab-cookies");
    if (!cookiesPane) return;
    cookiesPane.innerHTML = "";
    if (cookies.length > 0) {
      const ct = document.createElement("table");
      ct.className = "res-headers-table res-headers-table--thirds";
      // Header row
      const hdr = ct.insertRow();
      ["Name", "Attributes", "Value"].forEach((lbl) => {
        const th = document.createElement("th");
        th.textContent = lbl;
        th.style.fontWeight = "700";
        th.style.textAlign = "left";
        th.style.padding = "4px 12px";
        th.style.color = "var(--color-overlay-0)";
        th.style.fontSize = "var(--font-size-xs)";
        th.style.textTransform = "uppercase";
        th.style.letterSpacing = "0.06em";
        hdr.appendChild(th);
      });
      cookies.forEach((raw) => {
        const parts = raw.split(";").map((s) => s.trim());
        const [nameVal, ...attrs] = parts;
        const eqIdx = nameVal.indexOf("=");
        const name = eqIdx >= 0 ? nameVal.slice(0, eqIdx) : nameVal;
        const value = eqIdx >= 0 ? nameVal.slice(eqIdx + 1) : "";
        const row = ct.insertRow();
        row.title = raw;
        row.insertCell().textContent = name;
        row.insertCell().textContent = attrs.join("; ");
        const valueCell = row.insertCell();
        valueCell.textContent = value;
        valueCell.className = this.#wrapResponseText
          ? "res-cookie-value res-cookie-value--wrap"
          : "res-cookie-value";
      });
      cookiesPane.appendChild(ct);
    } else {
      cookiesPane.appendChild(
        this.#placeholder({ text: "No cookies were set by this response" }),
      );
    }
  }

  // ── Timeline rendering ────────────────────────────────────────────────────

  /**
   * Re-render the timeline pane from the cached #timelineEntries array. The pane
   * is a master/detail split: a list of run entries on the left and the selected
   * entry's request snapshot on the right.
   */
  #renderTimeline() {
    if (this.#activeTab !== "timeline") return;

    const pane = this._tabContent?.querySelector("#res-tab-timeline");
    if (!pane) return;
    pane.innerHTML = "";

    if (!this.#timelineEntries.length) {
      pane.appendChild(
        this.#placeholder({
          icon: "🕓",
          text: "No history yet — send a request to record an entry",
        }),
      );
      return;
    }

    const split = document.createElement("div");
    split.className = "timeline-pane";

    const list = document.createElement("div");
    list.className = "timeline-list";
    this.#timelineEntries.forEach((entry, idx) =>
      list.appendChild(this.#buildTimelineRow(entry, idx)),
    );

    const detail = document.createElement("div");
    detail.className = "timeline-detail";
    this.#renderTimelineDetail(detail);

    split.appendChild(list);
    split.appendChild(detail);
    pane.appendChild(split);
  }

  /** Build one timeline list row for the entry at `idx`. */
  #buildTimelineRow(entry, idx) {
    const {
      status = 0,
      statusText = "",
      elapsed = 0,
      size = 0,
    } = entry.response ?? {};
    const item = document.createElement("button");
    item.className = "timeline-item";
    item.setAttribute("type", "button");
    if (idx === this.#timelineSelected)
      item.classList.add("timeline-item--selected");
    if (idx === 0) item.classList.add("timeline-item--latest");

    const ts = document.createElement("span");
    ts.className = "timeline-timestamp";
    ts.textContent = this.#formatTimestamp(entry.timestamp);

    const record = document.createElement("div");
    record.className = "timeline-record";

    const badge = document.createElement("span");
    badge.className = `timeline-badge ${this.#statusClass(status)}`;
    badge.textContent = status || "ERR";

    const text = document.createElement("span");
    text.className = "timeline-text";
    text.textContent = statusText || (status ? "" : "Error");

    const meta = document.createElement("span");
    meta.className = "timeline-meta";

    const time = document.createElement("span");
    time.className = "timeline-time";
    time.textContent = elapsed ? `${elapsed} ms` : "";

    const sizeEl = document.createElement("span");
    sizeEl.className = "timeline-size";
    sizeEl.textContent = size ? this.#formatSize(size) : "";

    meta.appendChild(time);
    meta.appendChild(sizeEl);
    record.appendChild(badge);
    record.appendChild(text);
    record.appendChild(meta);
    item.appendChild(ts);
    item.appendChild(record);

    // Left-click selects the entry: highlight it, render its request snapshot in
    // the detail panel, and load that run's response into the other tabs. This
    // is non-destructive — it never overwrites the live request. Use the
    // right-click "Restore" action for that.
    item.addEventListener("click", () => this.#selectTimelineEntry(idx));

    // Right-click opens the OS-native actions menu (restore / copy / delete).
    item.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.#selectTimelineEntry(idx);
      this.#showTimelineContextMenu(entry, e.clientX, e.clientY);
    });

    return item;
  }

  /**
   * Select a timeline entry: highlight the row, render its request snapshot in
   * the detail panel, and dispatch wurl:timeline-select so app.js loads that
   * run's response into the body/headers/cookies tabs. Non-destructive — the
   * live request editor is left untouched.
   */
  #selectTimelineEntry(idx) {
    this.#timelineSelected = idx;
    this.#renderTimeline();
    const entry = this.#timelineEntries[idx];
    if (!entry) return;
    window.dispatchEvent(
      new CustomEvent("wurl:timeline-select", {
        detail: {
          requestUrl: entry.requestUrl ?? "",
          response: entry.response,
        },
      }),
    );
  }

  /**
   * OS-native right-click menu for a timeline entry. "Restore" replays the
   * snapshot back into the request editor (the one destructive action, now
   * explicit); the rest cover copy and history lifecycle.
   */
  async #showTimelineContextMenu(entry, x, y) {
    const url = entry.requestUrl || entry.requestNode?.url || "";
    const items = [
      { id: "restore", label: "Restore Into Editor" },
      { type: "separator" },
      { id: "delete", label: "Delete Entry" },
      { id: "delete-all", label: "Delete All History" },
    ];
    const clickedId = await window.wurl.ui.contextMenu({ items, x, y });
    if (clickedId === "restore") {
      window.dispatchEvent(
        new CustomEvent("wurl:timeline-restore", {
          detail: {
            requestNode: entry.requestNode,
            requestUrl: entry.requestUrl ?? "",
            response: entry.response,
          },
        }),
      );
    } else if (clickedId === "copy-url") {
      if (url) navigator.clipboard.writeText(url).catch(() => {});
    } else if (clickedId === "delete") {
      this.#deleteTimelineEntry(entry.id);
    } else if (clickedId === "delete-all") {
      this.#clearTimeline();
    }
  }

  /**
   * Delete a single timeline entry. Delegates to app.js (owner of history
   * state + storage) which removes the on-disk files and re-dispatches
   * wurl:timeline-update so the pane re-renders.
   */
  #deleteTimelineEntry(historyId) {
    if (!this.#requestId || !historyId) return;
    window.dispatchEvent(
      new CustomEvent("wurl:timeline-delete-entry", {
        detail: { requestId: this.#requestId, historyId },
      }),
    );
  }

  /** Clear the entire run history for the current request (delegated to app.js). */
  #clearTimeline() {
    if (!this.#requestId) return;
    window.dispatchEvent(
      new CustomEvent("wurl:timeline-clear", {
        detail: { requestId: this.#requestId },
      }),
    );
  }

  // ── Timeline detail panel ─────────────────────────────────────────────────

  /**
   * Render the selected entry's request snapshot into the detail `container`.
   * With no explicit selection (-1) the latest entry is previewed. Shows what
   * the run was sent with: method, URL, params, headers, auth — each section
   * with a copy button. (Disabled rows render greyed, prefixed with "# ".)
   */
  #renderTimelineDetail(container) {
    const idx = this.#timelineSelected >= 0 ? this.#timelineSelected : 0;
    const snapshot = this.#timelineEntries[idx]?.requestNode;
    if (!snapshot) {
      const ph = document.createElement("div");
      ph.className = "timeline-detail-empty";
      ph.textContent = "Select an entry to see the request that was sent";
      container.appendChild(ph);
      return;
    }

    // Method — no copy
    this.#appendDetailSection(container, "Method");
    this.#appendDetailValue(container, snapshot.method ?? "GET");

    // URL — copy if present
    const url = (snapshot.url ?? "").trim();
    this.#appendDetailSection(container, "URL", url || null);
    this.#appendDetailValue(container, url || "(none)");

    // Parameters (already bulk-edit format)
    const paramsBulk = (snapshot.params ?? "").trim();
    this.#appendDetailSection(container, "Parameters", paramsBulk || null);
    if (!paramsBulk) {
      this.#appendDetailNone(container);
    } else {
      this.#appendDetailBulkLines(container, paramsBulk);
    }

    // Headers (already bulk-edit format)
    const headersBulk = (snapshot.headers ?? "").trim();
    this.#appendDetailSection(container, "Headers", headersBulk || null);
    if (!headersBulk) {
      this.#appendDetailNone(container);
    } else {
      this.#appendDetailBulkLines(container, headersBulk);
    }

    // Auth
    const authCopy = this.#buildAuthCopyText(snapshot);
    this.#appendDetailSection(container, "Auth", authCopy);
    this.#appendDetailAuth(container, snapshot);
  }

  #buildAuthCopyText(snapshot) {
    const type = snapshot.authType ?? "none";
    const bulk = (snapshot.auth ?? "").trim();
    if (type === "none") return null;
    const lines = [`type: ${type}`];
    if (bulk) lines.push(...bulk.split("\n").filter((l) => l.trim()));
    return lines.join("\n");
  }

  #appendDetailSection(parent, label, copyText = null) {
    const row = document.createElement("div");
    row.className = "timeline-detail-section";
    const lbl = document.createElement("span");
    lbl.textContent = label;
    row.appendChild(lbl);
    if (copyText) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "timeline-detail-copy-btn";
      btn.title = `Copy ${label.toLowerCase()} to clipboard`;
      btn.innerHTML = ResponseViewer.#SVG_COPY;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(copyText).then(() => {
          btn.innerHTML = ResponseViewer.#SVG_CHECK;
          btn.classList.add("timeline-detail-copy-btn--copied");
          setTimeout(() => {
            btn.innerHTML = ResponseViewer.#SVG_COPY;
            btn.classList.remove("timeline-detail-copy-btn--copied");
          }, 1500);
        });
      });
      row.appendChild(btn);
    }
    parent.appendChild(row);
  }

  #appendDetailValue(parent, text) {
    const el = document.createElement("div");
    el.className = "timeline-detail-value";
    el.textContent = text;
    parent.appendChild(el);
  }

  #appendDetailNone(parent) {
    const el = document.createElement("div");
    el.className = "timeline-detail-none";
    el.textContent = "none";
    parent.appendChild(el);
  }

  #appendDetailAuth(parent, snapshot) {
    const type = snapshot.authType ?? "none";
    if (type === "none") {
      this.#appendDetailNone(parent);
      return;
    }
    this.#appendDetailLine(parent, `type: ${type}`);
    const bulk = (snapshot.auth ?? "").trim();
    if (bulk) this.#appendDetailBulkLines(parent, bulk);
  }

  /** Render each non-empty line of a bulk-format string as an indented row. */
  #appendDetailBulkLines(parent, bulk) {
    for (const line of bulk.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      this.#appendDetailLine(parent, t, !t.startsWith("# "));
    }
  }

  #appendDetailLine(parent, text, enabled = true) {
    const el = document.createElement("div");
    el.className =
      "timeline-detail-kv" + (enabled ? "" : " timeline-detail-kv--disabled");
    el.textContent = text;
    parent.appendChild(el);
  }

  // ── Console rendering ─────────────────────────────────────────────────────
  /**
   * Render the verbose console log lines into the Console tab pane.
   * Each line is styled based on its prefix character:
   *   >  sent / request lines  → accent colour
   *   <  received / response   → success colour
   *   *  informational         → muted colour
   *   [error]  error lines     → error colour
   *
   * @param {string[]} lines
   */
  #renderConsole(lines) {
    const pane = this._tabContent.querySelector("#res-tab-console");
    if (!pane) return;
    pane.innerHTML = "";

    if (!lines || lines.length === 0) {
      pane.appendChild(this.#consolePlaceholder());
      return;
    }

    const pre = document.createElement("pre");
    pre.className = "res-console-pre";

    lines.forEach((line) => {
      const span = document.createElement("span");
      span.className = "res-console-line";

      if (line === ">" || line.startsWith("> ")) {
        span.classList.add("res-console-line--sent");
      } else if (line === "<" || line.startsWith("< ")) {
        span.classList.add("res-console-line--recv");
      } else if (line.startsWith("* ")) {
        span.classList.add("res-console-line--info");
      } else if (line === "|" || line.startsWith("| ")) {
        span.classList.add("res-console-line--body");
      } else if (line.startsWith("[error]")) {
        span.classList.add("res-console-line--error");
      }

      span.textContent = line;
      pre.appendChild(span);
      pre.appendChild(document.createTextNode("\n"));
    });

    pane.appendChild(pre);
  }

  // ── Timestamp updater ─────────────────────────────────────────────────────

  #startTimestampUpdater() {
    this.#stopTimestampUpdater();
    this.#timestampTimer = setInterval(
      () => this.#updateTimestampLabels(),
      10_000,
    );
    // This background "Xs ago" ticker must never keep a process alive: under
    // `node --test` (jsdom) a viewer left on the timeline tab would otherwise
    // hang the runner forever. unref() exists on Node's Timeout; in the
    // Electron/Chromium renderer setInterval returns a number, so the optional
    // call is a harmless no-op there (the interval still fires every 10s).
    this.#timestampTimer?.unref?.();
  }

  #stopTimestampUpdater() {
    if (this.#timestampTimer !== null) {
      clearInterval(this.#timestampTimer);
      this.#timestampTimer = null;
    }
  }

  #updateTimestampLabels() {
    const pane = this._tabContent?.querySelector("#res-tab-timeline");
    if (!pane) return;
    pane.querySelectorAll(".timeline-item").forEach((item, idx) => {
      const entry = this.#timelineEntries[idx];
      if (!entry) return;
      const tsEl = item.querySelector(".timeline-timestamp");
      if (tsEl) tsEl.textContent = this.#formatTimestamp(entry.timestamp);
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  #formatTimestamp(ts) {
    if (!ts) return "";
    const delta = Date.now() - ts;
    const secs = delta / 1000;
    const mins = secs / 60;

    if (secs < 10) return "Just now";
    if (mins < 1) return "Less than a minute ago";
    if (mins < 5) return "Within the last 5 minutes";
    if (mins < 30) return "Within the last half hour";
    if (mins < 60) return "Within the last hour";

    const then = new Date(ts);
    const todayMid = new Date();
    todayMid.setHours(0, 0, 0, 0);
    const thenMid = new Date(then);
    thenMid.setHours(0, 0, 0, 0);
    const daysDiff = Math.round((todayMid - thenMid) / 86400000);

    if (daysDiff === 0) return "Today";
    if (daysDiff === 1) return "Yesterday";

    // Start of the current calendar week (Sunday = day 0)
    const weekStart = new Date(todayMid);
    weekStart.setDate(todayMid.getDate() - todayMid.getDay());
    if (thenMid >= weekStart) return "This week";

    const lastWeekStart = new Date(weekStart);
    lastWeekStart.setDate(weekStart.getDate() - 7);
    if (thenMid >= lastWeekStart) return "Last Week";

    // Full format: "On Monday, June 12th, at 12:45 pm"
    const DAYS = [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ];
    const MONTHS = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ];
    const d = then.getDate();
    const ordinal = (n) => {
      if (n >= 11 && n <= 13) return "th";
      switch (n % 10) {
        case 1:
          return "st";
        case 2:
          return "nd";
        case 3:
          return "rd";
        default:
          return "th";
      }
    };
    const h = then.getHours();
    const h12 = h % 12 || 12;
    const m = String(then.getMinutes()).padStart(2, "0");
    const ampm = h < 12 ? "am" : "pm";
    return `On ${DAYS[then.getDay()]}, ${MONTHS[then.getMonth()]} ${d}${ordinal(d)}, at ${h12}:${m} ${ampm}`;
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

  #formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
}
