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
 * response-viewer.js — HTTP response display component
 *
 * Displays the result of a hippo:send-request in one of three views:
 *
 *  1. JSON / YAML / XML / CSS / JavaScript  — raw text or pretty-printed + syntax-highlighted depending on renderMode
 *  2. HTML               — raw text with syntax highlighting (raw mode) or live browser preview (preview mode)
 *                          • Electron: WebContentsView that loads the request URL
 *                          • Dev/browser: <iframe src=requestUrl> placeholder
 *  3. Everything else    — raw text only (renderMode toggle is a no-op)
 */

"use strict";

import renderMarkdown from "../vendor/markdown.js";
import { escapeHtml, escapeHtmlText, escapeHtmlAttr } from "../utils/html.js";
import { t } from "../i18n.js";
import { Notifications } from "../notifications.js";
import { ResponseSearch } from "./response-search.js";
import { ResponseFilter } from "./response-filter.js";
import { isFilterable } from "./response/body-filter.js";
import {
  appendCodeBlock,
  fillHexDump,
  highlightMarkdownCode,
  renderFoldableCode,
} from "./response/body-render.js";
import { TimelineView } from "./response/timeline-view.js";
import { StreamView } from "./response/stream-view.js";

// Tab labels resolve from the i18n catalog at render time (labelKey, not a
// literal) — this array is built at module load, before the catalog is ready.
const TABS = [
  { id: "body", labelKey: "response.tab.body" },
  { id: "preview", labelKey: "response.tab.preview" }, // shown only for HTML responses
  { id: "headers", labelKey: "response.tab.headers" },
  { id: "cookies", labelKey: "response.tab.cookies" },
  { id: "console", labelKey: "response.tab.console" },
  { id: "tests", labelKey: "response.tab.tests" }, // shown only when a run has assertions
  { id: "timeline", labelKey: "response.tab.timeline" },
];

// ── Content-type classification ───────────────────────────────────────────────

/**
 * Classify a Content-Type header value into one of the rendering categories.
 * @param {string} ct  - raw Content-Type value (may include charset/boundary)
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

    // This reconstructs displayed HTML *source*, so use the minimal-fidelity
    // serializers (escapeHtmlText/escapeHtmlAttr) rather than escapeHtml — a
    // literal `"` in text or `<` in an attribute must round-trip unchanged.
    const openTag = (el) => {
      const attrs = Array.from(el.attributes)
        .map((a) =>
          a.value === ""
            ? ` ${a.name}`
            : ` ${a.name}="${escapeHtmlAttr(a.value)}"`,
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
        const body =
          tag === "script" || tag === "style" ? raw : escapeHtmlText(raw);
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
        out.push(
          pad + openTag(node) + (t ? escapeHtmlText(t) : "") + close(tag),
        );
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
          if (t) out.push(pad + escapeHtmlText(t));
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
  /** @type {HTMLElement} */
  #el;
  #activeTab = "body";
  #renderMode = "styled"; // "styled" | "raw" | "hex"
  #wrapResponseText = true; // wrap long lines in Styled mode (settings-controlled)
  #showLineNumbers = true; // line-number gutter in Styled foldable mode (settings-controlled)
  #showCodeFolding = true; // fold gutter + carets in Styled foldable mode (settings-controlled)
  #lastResponse = null; // cached so mode changes can re-render

  // Cached pane references (set once in #renderTabContent)
  #bodyPane = null;
  #previewPane = null;

  // Cached structural element refs (set once by the #render* builders)
  #statusBar = null; // status bar element
  #tabStrip = null; // tab-button strip
  #tabContent = null; // tab-pane container

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
  #settingsHandler = null; // hippo:settings-changed listener for font-size repositioning

  // Binary-response state (images / PDF). The Hex view is a render mode (see
  // #renderMode), available for every content-type via the Body context menu.
  #objectUrl = null; // active blob: URL for an image preview (revoked on teardown)
  #pdfPreviewActive = false; // true while the native PDF overlay is live
  #pdfHost = null; // body-pane element the PDF overlay is positioned against
  #pdfResizeObserver = null; // observes #pdfHost for the PDF overlay
  #pdfWinResizeHandler = null; // window resize listener for the PDF overlay
  #pdfSettingsHandler = null; // settings-changed listener for the PDF overlay

  // Find-in-response search bar — its UI, match highlighting/navigation and the
  // fold-reveal hook are owned by ResponseSearch; the viewer keeps the body
  // content and injects read access to it (getBodyPane / isHtmlPreviewActive).
  #search = new ResponseSearch({
    getBodyPane: () => this.#bodyPane,
    isHtmlPreviewActive: () => this.#htmlPreviewActive,
  });

  // Filter-the-response bar (Cmd/Ctrl+Shift+F) — transforms a styled JSON/YAML/
  // XML body into the fields a jq / yq / XPath expression selects, re-rendered
  // in the same view. ResponseFilter owns the bar UI; the viewer injects the
  // eligibility check, the filtered/original renders, and the unsupported toast.
  #filter = new ResponseFilter({
    getFilterTarget: () => this.#filterTarget(),
    renderFiltered: (text, category) =>
      this.#renderFilteredText(text, category),
    restoreOriginal: () => {
      if (this.#lastResponse) this.#renderBodyPane(this.#lastResponse);
    },
    notifyUnsupported: () =>
      Notifications.info(t("response.filter.unsupported")),
  });

  // Timeline state
  // Timeline (run-history) tab — owns its own state + live timestamp ticker and
  // dispatches the hippo:timeline-* events app.js handles. The host injects the
  // bits it owns: active tab, the timeline pane, and shared render helpers.
  #timeline = new TimelineView({
    getActiveTab: () => this.#activeTab,
    getPane: () => this.#tabContent?.querySelector("#res-tab-timeline"),
    placeholder: (opts) => this.#placeholder(opts),
    statusClass: (code) => this.#statusClass(code),
    formatSize: (bytes) => this.#formatSize(bytes),
  });

  // Concurrent-request routing
  #selectedRequestId = null; // id of the selected request — lifecycle events for others are ignored
  #inFlightStarts = new Map(); // request id → send time (epoch ms), for all in-flight requests
  #consoleLines = []; // the console pane's current lines, so script logs can append (Feature 25)
  #testResults = []; // the Tests pane's current assertion results (Feature 29)
  #loadingTimer = null; // setInterval handle for the live elapsed readout while loading

  // Live streaming (Feature 33). The body of an SSE / chunked stream is appended
  // to a reused WsConsole log as it arrives; the full stream lives in a spill
  // file in the main process. State is session-scoped — nothing here persists.
  // Live SSE/chunked streaming + recorded-stream summary (Feature 33). Owns all
  // stream state; live streaming writes the shared Body pane + status bar, so it
  // gets a facade of the host accessors/renderers it drives (a wider seam than
  // TimelineView — that asymmetry is intentional, see stream-view.js).
  #stream = new StreamView({
    getActiveTab: () => this.#activeTab,
    getBodyPane: () => this.#bodyPane,
    getStatusBar: () => this.#statusBar,
    isLoading: () => !!this.#loadingTimer,
    statusClass: (code) => this.#statusClass(code),
    formatSize: (bytes) => this.#formatSize(bytes),
    setStatus: (code, text, time, size) =>
      this.#setStatus(code, text, time, size),
    setCurrentMethod: (m) => this.#setCurrentMethod(m),
    setPreviewTabVisible: (b) => this.#setPreviewTabVisible(b),
    switchTab: (id) => this.#switchTab(id),
    renderHeadersPane: (h) => this.#renderHeadersPane(h),
    renderCookiesPane: (c) => this.#renderCookiesPane(c),
    renderConsole: (lines) => this.#renderConsole(lines),
    teardownBinaryEphemera: () => this.#teardownBinaryEphemera(),
    destroyHtmlPreview: () => this.#destroyHtmlPreview(),
    clearSearchHighlights: () => this.#search.clearHighlights(),
    setFoldReveal: (fn) => this.#search.setFoldReveal(fn),
    resetStaticBody: () => {
      this.#lastResponse = null;
      this.#isHtmlResponse = false;
    },
  });

  constructor() {
    this.#el = document.createElement("div");
    this.#el.className = "response-viewer";

    this.#renderStatusBar();
    this.#renderTabStrip();
    this.#renderTabContent();
    // Search + filter bars inserted between tab-strip and tab-content.
    this.#search.mount(this.#el, this.#tabContent);
    this.#filter.mount(this.#el, this.#tabContent);

    // Track the active request's method so the Body tab colour stays in sync,
    // and its id so concurrent lifecycle events can be routed (below).
    window.addEventListener("hippo:request-selected", (e) => {
      this.#selectedRequestId = e.detail?.id ?? null;
      if (e.detail?.method) this.#setCurrentMethod(e.detail.method);
    });
    window.addEventListener("hippo:request-updated", (e) => {
      if (e.detail?.method) this.#setCurrentMethod(e.detail.method);
    });

    // Listen for responses. Requests run concurrently: each lifecycle event
    // carries the requestId it belongs to, and only events for the SELECTED
    // request touch the panes — background results are recorded in history by
    // app.js and shown when their request is next selected. Events without a
    // requestId (history replays) always target the selected request.
    const isSelected = (rid) => rid == null || rid === this.#selectedRequestId;
    window.addEventListener("hippo:response-received", (e) => {
      const rid = e.detail?.requestId;
      if (rid != null) this.#inFlightStarts.delete(rid);
      if (isSelected(rid)) this.#showResponse(e.detail);
    });
    // After-response script console output (Feature 25): append to the verbose
    // log of the request currently shown, leaving the HTTP lines intact.
    window.addEventListener("hippo:script-console", (e) => {
      const lines = e.detail?.lines;
      if (
        !isSelected(e.detail?.requestId) ||
        !Array.isArray(lines) ||
        !lines.length
      )
        return;
      this.#renderConsole([...this.#consoleLines, ...lines]);
    });
    window.addEventListener("hippo:request-loading", (e) => {
      const rid = e.detail?.requestId;
      // Keep the earliest mark — an OAuth send dispatches loading twice
      // (token acquisition, then the request itself).
      if (rid != null && !this.#inFlightStarts.has(rid)) {
        this.#inFlightStarts.set(rid, Date.now());
      }
      if (isSelected(rid)) {
        this.#showLoading(rid != null ? this.#inFlightStarts.get(rid) : null);
        // Pre-arm the stream id so frames that arrive before the streaming
        // marker (Feature 33) are buffered and replayed, not dropped.
        this.#stream.arm(e.detail?.streamId ?? null);
      }
    });
    window.addEventListener("hippo:request-error", (e) => {
      const rid = e.detail?.requestId;
      if (rid != null) this.#inFlightStarts.delete(rid);
      if (isSelected(rid)) this.#showError(e.detail);
    });

    // Live streaming pushes (Feature 33), bridged from IPC by app.js. Routed by
    // streamId to the active (or armed) stream; others are ignored.
    window.addEventListener("hippo:stream-data", (e) =>
      this.#stream.onStreamData(e.detail),
    );
    window.addEventListener("hippo:stream-end", (e) =>
      this.#stream.onStreamEnd(e.detail),
    );
    window.addEventListener("hippo:stream-error", (e) =>
      this.#stream.onStreamError(e.detail),
    );
    // Headers-time heads-up (Feature 33): a buffered NDJSON response is on the way
    // and live streaming is off — show the in-flight hint while the request runs.
    window.addEventListener("hippo:stream-hint", (e) =>
      this.#stream.onStreamHint(e.detail),
    );

    // Post-response captures (Feature 03): show a small marker on the status bar
    // summarising how many variables were captured. Count only — never values.
    window.addEventListener("hippo:captures-applied", (e) =>
      this.#showCapturedBadge(e.detail?.count ?? 0),
    );

    // Test assertions (Feature 29): fill the Tests tab + status badge once the
    // after-response sandbox returns. The response itself was rendered a moment
    // ago off hippo:response-received with no tests; this completes it.
    window.addEventListener("hippo:test-results", (e) => {
      if (!isSelected(e.detail?.requestId)) return;
      this.#applyTestResults(
        e.detail?.results ?? [],
        e.detail?.summary ?? null,
      );
    });

    // Update the timeline tab whenever history changes.
    // When isRequestSwitch is true the dispatch comes after the history load
    // is complete (sync from memory or after async storage fetch), so it is
    // safe to update the body display here rather than racing on a microtask.
    window.addEventListener("hippo:timeline-update", (e) => {
      const entries = e.detail?.entries ?? [];
      const requestId = e.detail?.requestId ?? null;
      this.#timeline.update(entries, requestId);
      if (e.detail?.isRequestSwitch) {
        if (this.#activeTab !== "body") this.#switchTab("body");
        const entry = entries[0];
        if (requestId != null && this.#inFlightStarts.has(requestId)) {
          // Switched to a request that is still running — show its live
          // loading state (timed from its own send) rather than the
          // previous run from history.
          this.#showLoading(this.#inFlightStarts.get(requestId));
        } else if (entry?.response?.error) {
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
      } else if (!entries.length) {
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
      if (
        selectAll &&
        !this.#search.isSearchInput(e.target) &&
        !this.#filter.isFilterInput(e.target)
      ) {
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
        this.#search.open();
        return;
      }

      // Cmd/Ctrl+Shift+F → open filter bar (styled JSON/YAML/XML only; a
      // shifted "F" arrives as either "f" or "F" depending on the platform)
      const filterKey =
        (e.key === "f" || e.key === "F") &&
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        !e.altKey;
      if (filterKey) {
        e.preventDefault();
        e.stopPropagation();
        this.#filter.open();
      }
    });

    // Hide the Electron HTML preview whenever any popup/menu/dialog opens so the
    // native WebContentsView (which renders above all web content) does not cover it.
    // Before hiding, capture a screenshot and display it as a static stand-in so the
    // preview area does not go blank while the popup is open. Re-show the live view
    // and discard the snapshot once the popup is dismissed.
    window.addEventListener("hippo:popup-opened", async () => {
      this.#popupDepth++;
      // The native PDF overlay renders above all web content too — hide it so a
      // context menu / dialog is not obscured. (No snapshot: a brief blank under
      // a transient menu is acceptable.)
      if (this.#pdfPreviewActive && window.hippo?.isElectron) {
        window.hippo.preview.pdf.hide().catch(() => {});
      }
      if (!this.#htmlPreviewActive || !window.hippo?.isElectron) return;
      // Only capture on the first popup; nested popups reuse the existing snapshot.
      if (this.#popupDepth === 1) {
        this.#snapshotPending = true;
        const dataUrl = await window.hippo.preview.html
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
      window.hippo.preview.html.hide().catch(() => {});
    });
    window.addEventListener("hippo:popup-closed", () => {
      this.#popupDepth = Math.max(0, this.#popupDepth - 1);
      // Cancel any capture still in-flight and remove the snapshot immediately —
      // the image must disappear as soon as the last popup is dismissed.
      this.#snapshotPending = false;
      if (this.#popupDepth === 0) this.#removePreviewSnapshot();
      // Re-show the PDF overlay once all popups are gone and Body is visible.
      if (
        this.#popupDepth === 0 &&
        this.#pdfPreviewActive &&
        window.hippo?.isElectron &&
        this.#activeTab === "body" &&
        this.#pdfHost
      ) {
        requestAnimationFrame(() => {
          if (this.#pdfPreviewActive && this.#popupDepth === 0) {
            window.hippo.preview.pdf
              .show(this.#computeBounds(this.#pdfHost))
              .catch(() => {});
          }
        });
      }
      if (!this.#htmlPreviewActive || !window.hippo?.isElectron) return;
      if (this.#activeTab !== "preview") return; // preview tab not visible — stay hidden
      requestAnimationFrame(() => {
        if (!this.#htmlPreviewActive || this.#popupDepth > 0) return;
        window.hippo.preview.html
          .show(this.#computePreviewBounds())
          .catch(() => {});
      });
    });
  }

  /**
   * Apply persisted settings to the viewer.
   * @param {{ responseBodyRenderMode?: string, wrapResponseText?: boolean,
   *           responseBodyLineNumbers?: boolean,
   *           responseBodyCodeFolding?: boolean }} settings
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
    if (settings.responseBodyLineNumbers !== undefined) {
      const changed =
        this.#showLineNumbers !== settings.responseBodyLineNumbers;
      this.#showLineNumbers = settings.responseBodyLineNumbers;
      // Only the foldable Styled body carries the gutter; re-render to add/drop it.
      if (changed && this.#lastResponse) {
        this.#renderBodyPane(this.#lastResponse);
      }
    }
    if (settings.responseBodyCodeFolding !== undefined) {
      const changed =
        this.#showCodeFolding !== settings.responseBodyCodeFolding;
      this.#showCodeFolding = settings.responseBodyCodeFolding;
      if (changed && this.#lastResponse) {
        this.#renderBodyPane(this.#lastResponse);
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
      <span class="res-status-badge" role="status" aria-label="${t("response.status.httpStatusAria")}"></span>
      <span class="res-status-text"></span>
      <span class="res-tests-badge" title="${t("response.status.testsTitle")}" hidden></span>
      <span class="res-captured-badge" title="${t("response.status.capturedTitle")}" hidden></span>
      <span class="res-meta">
        <span class="res-time"  title="${t("response.status.elapsedTitle")}"></span>
        <span class="res-size"  title="${t("response.status.sizeTitle")}"></span>
      </span>
    `;

    this.#el.appendChild(bar);
    this.#statusBar = bar;
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
    let filterName = t("response.download.text");
    // Binary bodies (base64 in transit) name their file from the content-type.
    if (resp.encoding === "base64" || kind === "image" || kind === "pdf") {
      ext = binaryExtension(ct);
      filterName =
        kind === "pdf"
          ? "PDF"
          : kind === "image"
            ? t("response.download.image")
            : t("response.download.binary");
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
    window.hippo?.export?.file?.save(
      filename,
      resp.body,
      [
        { name: filterName, extensions: [ext] },
        { name: t("common.allFiles"), extensions: ["*"] },
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
        btn.textContent = t("response.tab.bodyMenu");
        btn.dataset.method = this.#currentMethod;
        btn.title = t("response.tab.bodyMenuTitle");
        btn.classList.add(this.#modeClass());
        // Right-click on the Body tab → render-mode context menu
        btn.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.#showBodyContextMenu(e.clientX, e.clientY);
        });
      } else {
        btn.textContent = t(tab.labelKey);
        // Preview (HTML only) and Tests (only when a run has assertions) start
        // hidden; #setPreviewTabVisible / #setTestsTabVisible reveal them.
        if (tab.id === "preview" || tab.id === "tests") btn.hidden = true;
        // Right-click on the Timeline tab → switch to it, then show a one-item
        // "Delete All History" menu (the same clear the per-entry menu offers).
        if (tab.id === "timeline") {
          btn.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.#switchTab("timeline");
            this.#showTimelineTabContextMenu(e.clientX, e.clientY);
          });
        }
      }

      btn.addEventListener("click", () => this.#switchTab(tab.id));
      strip.appendChild(btn);
    });

    this.#el.appendChild(strip);
    this.#tabStrip = strip;
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

    // Right-click on the verbose console log → Copy (current selection) /
    // Select All — mirrors the body pane's read-only text menu.
    consolePane.addEventListener("contextmenu", (e) => {
      const pre = consolePane.querySelector(".res-console-pre");
      if (!pre || !pre.contains(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      this.#showConsoleContextMenu(e.clientX, e.clientY);
    });

    // Initial empty state in tests pane (Feature 29)
    const testsPane = content.querySelector("#res-tab-tests");
    if (testsPane) testsPane.appendChild(this.#testsPlaceholder());

    this.#el.appendChild(content);
    this.#tabContent = content;
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
      text: t("response.placeholder.sendRequest"),
    });
  }

  #consolePlaceholder() {
    return this.#placeholder({
      icon: "🖥️",
      text: t("response.placeholder.consoleEmpty"),
    });
  }

  #testsPlaceholder() {
    return this.#placeholder({
      icon: "✓",
      text: t("response.placeholder.testsEmpty"),
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
    const btn = this.#tabStrip?.querySelector('[data-tab="body"]');
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
    const btn = this.#tabStrip?.querySelector('[data-tab="body"]');
    if (btn) btn.dataset.method = this.#currentMethod;
  }

  async #showBodyContextMenu(x, y) {
    const items = [
      {
        id: "styled",
        label: t("menu.styled"),
        type: "checkbox",
        checked: this.#renderMode === "styled",
      },
      {
        id: "raw",
        label: t("menu.raw"),
        type: "checkbox",
        checked: this.#renderMode === "raw",
      },
      {
        id: "hex",
        label: t("menu.hex"),
        type: "checkbox",
        checked: this.#renderMode === "hex",
      },
      { type: "separator" },
      { id: "download", label: t("menu.download") },
    ];
    const clickedId = await window.hippo.ui.contextMenu.show({ items, x, y });
    if (clickedId === "download") {
      // While a live stream is shown the body is the stream, not a buffered
      // response — Download saves the stream (Feature 33), replacing the removed
      // toolbar Save button. Otherwise it saves the rendered response body.
      if (this.#stream.isStreaming()) this.#stream.saveStream();
      else this.#downloadBody();
    } else if (clickedId) {
      this.#setRenderMode(clickedId);
    }
  }

  /**
   * Right-click menu for the Timeline tab: a single "Delete All History" entry
   * wired to the same clear the per-entry context menu uses (TimelineView owns
   * the action + the current request id).
   */
  async #showTimelineTabContextMenu(x, y) {
    const clickedId = await window.hippo.ui.contextMenu.show({
      items: [{ id: "delete-all", label: t("menu.deleteAllHistory") }],
      x,
      y,
    });
    if (clickedId === "delete-all") this.#timeline.clearAll();
  }

  /**
   * Context menu for the rendered body text — Copy the current selection and
   * Select All, plus a "Wrap" toggle when in Styled mode. Copy / Select All work
   * in both Styled and Raw.
   */
  async #showBodyTextContextMenu(x, y) {
    const selectedText = window.getSelection()?.toString() ?? "";
    const items = [
      { id: "copy", label: t("menu.copy"), enabled: !!selectedText },
      {
        id: "selectAll",
        label: t("menu.selectAll"),
        enabled: !!this.#bodyPane?.querySelector(".res-body-pre"),
      },
    ];
    // Styled mode → offer the wrap toggle (Raw is never wrapped via this menu)
    if (this.#renderMode !== "raw") {
      items.push(
        { type: "separator" },
        {
          id: "wrap",
          label: t("menu.wrap"),
          type: "checkbox",
          checked: this.#wrapResponseText,
        },
      );
      // Line numbers + code folding apply only to the per-line foldable render
      // (the styled, supported MIME types); omit them for plain/markdown bodies.
      if (this.#bodyPane?.querySelector(".res-body-pre--foldable")) {
        items.push(
          {
            id: "lineNumbers",
            label: t("menu.lineNumbers"),
            type: "checkbox",
            checked: this.#showLineNumbers,
          },
          {
            id: "codeFolding",
            label: t("menu.codeFolding"),
            type: "checkbox",
            checked: this.#showCodeFolding,
          },
        );
      }
    }
    const clickedId = await window.hippo.ui.contextMenu.show({ items, x, y });
    if (clickedId === "copy") {
      if (selectedText) {
        navigator.clipboard.writeText(selectedText).catch(() => {});
      }
    } else if (clickedId === "selectAll") {
      this.#selectAllElement(this.#bodyPane?.querySelector(".res-body-pre"));
    } else if (clickedId === "wrap") {
      // Invert and persist via the shared settings channel; app.js re-applies
      // the setting (which re-renders this pane with the new wrap state).
      window.dispatchEvent(
        new CustomEvent("hippo:settings-changed", {
          detail: { wrapResponseText: !this.#wrapResponseText },
        }),
      );
    } else if (clickedId === "lineNumbers") {
      // Component-owned view pref: persist via the editor-setting channel and
      // re-render directly (no applySettings round-trip — only the body changes).
      this.#showLineNumbers = !this.#showLineNumbers;
      window.dispatchEvent(
        new CustomEvent("hippo:editor-setting-changed", {
          detail: { responseBodyLineNumbers: this.#showLineNumbers },
        }),
      );
      if (this.#lastResponse) this.#renderBodyPane(this.#lastResponse);
    } else if (clickedId === "codeFolding") {
      // Same component-owned pattern as line numbers (see above).
      this.#showCodeFolding = !this.#showCodeFolding;
      window.dispatchEvent(
        new CustomEvent("hippo:editor-setting-changed", {
          detail: { responseBodyCodeFolding: this.#showCodeFolding },
        }),
      );
      if (this.#lastResponse) this.#renderBodyPane(this.#lastResponse);
    }
  }

  /**
   * Select all of `el`'s contents so the next Copy (or ⌘/Ctrl+C) grabs it all.
   * user-select:none descendants (line numbers / fold carets) are excluded by
   * Chromium, so they stay out of the resulting selection and copy.
   */
  #selectAllElement(el) {
    if (!el) return;
    const sel = window.getSelection();
    if (!sel) return;
    sel.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.addRange(range);
  }

  /**
   * Context menu for the verbose Console log — Copy the current selection and
   * Select All. Mirrors #showBodyTextContextMenu for the read-only console pane.
   */
  async #showConsoleContextMenu(x, y) {
    const selectedText = window.getSelection()?.toString() ?? "";
    const pre = this.#tabContent?.querySelector(
      "#res-tab-console .res-console-pre",
    );
    const items = [
      { id: "copy", label: t("menu.copy"), enabled: !!selectedText },
      { id: "selectAll", label: t("menu.selectAll"), enabled: !!pre },
    ];
    const clickedId = await window.hippo.ui.contextMenu.show({ items, x, y });
    if (clickedId === "copy") {
      if (selectedText) {
        navigator.clipboard.writeText(selectedText).catch(() => {});
      }
    } else if (clickedId === "selectAll") {
      this.#selectAllElement(pre);
    }
  }

  #setRenderMode(mode) {
    if (this.#renderMode === mode) return;
    this.#renderMode = mode;
    this.#updateBodyTabStyle();
    // Persist the choice via the shared editor-setting channel
    window.dispatchEvent(
      new CustomEvent("hippo:editor-setting-changed", {
        detail: { responseBodyRenderMode: mode },
      }),
    );
    // Switching render mode invalidates any active filter (the styled view it
    // transformed is gone) — drop it before the body is rebuilt.
    this.#filter.reset();
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
   * Eligibility probe for the filter bar: returns the original body text and
   * its category when the current body is a *styled* JSON/YAML/XML render, or
   * null when filtering can't apply (raw/hex view, HTML preview, binary or
   * streamed body, or a non-filterable content type). ResponseFilter consults
   * this both to decide whether to open and to read the body it filters.
   *
   * @returns {{ category: string, body: string } | null}
   */
  #filterTarget() {
    const resp = this.#lastResponse;
    if (!resp || this.#renderMode !== "styled" || this.#htmlPreviewActive) {
      return null;
    }
    if (resp.streamSummary || resp.encoding === "base64") return null;
    const category = classifyContentType(this.#contentTypeOf(resp.headers));
    if (!isFilterable(category)) return null;
    return { category, body: resp.body ?? "" };
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

    this.#search.clearHighlights();
    // Tear down any binary ephemera (PDF overlay, image blob URL) before the
    // pane is rebuilt; the new render re-creates whatever it needs.
    this.#teardownBinaryEphemera();
    pane.innerHTML = "";
    pane.classList.remove("res-tab-pane--fill"); // only the PDF view re-adds this

    // ── Streaming-run record (Feature 33) ─────────────────────────────────
    // A recorded stream has no buffered body — show its captured summary
    // (sent time, duration, event/byte counts, last events) instead. Render
    // modes (Styled/Raw/Hex) don't apply, so this precedes them.
    if (response.streamSummary) {
      this.#search.setFoldReveal(null);
      this.#stream.renderStreamSummary(response.streamSummary, pane);
      return;
    }

    // ── Hex view ──────────────────────────────────────────────────────────
    // A render mode (like Styled/Raw) selectable for every content-type from
    // the Body context menu: dump the raw bytes regardless of the body's type.
    if (this.#renderMode === "hex") {
      this.#search.setFoldReveal(null);
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
      this.#search.setFoldReveal(null);
      const md = document.createElement("div");
      // Keep the .res-body-pre class so select-all, copy and search machinery
      // (which query `.res-body-pre`) keep working on the rendered block.
      md.className = "res-body-pre res-body-md";
      md.tabIndex = 0;
      md.innerHTML = renderMarkdown(response.body ?? "");
      highlightMarkdownCode(md);
      pane.appendChild(md);

      // Re-apply an active search query (the pane was just rebuilt).
      this.#search.reapplyActiveSearch();
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
    this.#search.setFoldReveal(null);
    const foldable =
      this.#renderMode !== "raw" &&
      (category === "json" ||
        category === "xml" ||
        category === "yaml" ||
        category === "html" ||
        category === "css" ||
        category === "javascript");

    if (foldable) {
      renderFoldableCode(pre, displayText, prismLang, {
        folding: this.#showCodeFolding,
        lineNumbers: this.#showLineNumbers,
        setFoldReveal: (fn) => this.#search.setFoldReveal(fn),
      });
    } else if (prismLang) {
      appendCodeBlock(pre, displayText, prismLang);
    } else {
      pre.textContent = displayText;
    }

    pane.appendChild(pre);

    // An active body filter owns the rendered body — re-apply it over the
    // freshly-built original (it re-applies the find query itself). Otherwise
    // just re-highlight an active find query (the pane was rebuilt from scratch).
    if (!this.#filter.reapply()) this.#search.reapplyActiveSearch();
  }

  /**
   * Render filtered body `text` (the output of a jq / yq / XPath expression)
   * into the body pane, styled exactly like the original styled view of
   * `category`. Used only by ResponseFilter; the original body is untouched in
   * `#lastResponse`, so closing the filter restores it via a normal re-render.
   *
   * @param {string} text      the filtered body text
   * @param {string} category  "json" | "yaml" | "xml"
   */
  #renderFilteredText(text, category) {
    const pane = this.#bodyPane;
    this.#search.clearHighlights();
    pane.innerHTML = "";
    pane.classList.remove("res-tab-pane--fill");

    const pre = document.createElement("pre");
    pre.className = "res-body-pre";
    pre.tabIndex = 0;
    if (!this.#wrapResponseText) pre.classList.add("res-body-pre--no-wrap");

    const prismLang =
      category === "json" ? "json" : category === "yaml" ? "yaml" : "markup";
    this.#search.setFoldReveal(null);
    renderFoldableCode(pre, text, prismLang, {
      folding: this.#showCodeFolding,
      lineNumbers: this.#showLineNumbers,
      setFoldReveal: (fn) => this.#search.setFoldReveal(fn),
    });
    pane.appendChild(pre);

    // Re-apply an active find query against the freshly-filtered text.
    this.#search.reapplyActiveSearch();
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
    this.#search.setFoldReveal(null);

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
          text: t("response.truncation.previewHint"),
        }),
      );
      return;
    }

    if (kind === "image") this.#renderImage(response, pane);
    else if (kind === "pdf") this.#renderPdf(response, pane);
    else this.#renderHex(response, pane);
  }

  /**
   * Decode a base64 response body to a Uint8Array of the raw bytes. When
   * `maxBytes` is given, only the base64 prefix needed for that many bytes is
   * decoded — so a large under-spill-threshold body isn't fully materialised on
   * the main thread just to show a capped view.
   */
  #decodeBytes(response, maxBytes = Infinity) {
    const b64 = response.body ?? "";
    // base64 packs 3 bytes per 4 chars; round the cap up to a 4-char boundary.
    const slice =
      Number.isFinite(maxBytes) && maxBytes >= 0
        ? b64.slice(0, Math.ceil(maxBytes / 3) * 4)
        : b64;
    const bin = atob(slice);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  /** Exact decoded byte length of a clean (no-whitespace) base64 string. */
  #base64ByteLength(b64) {
    const len = b64.length;
    if (!len) return 0;
    let pad = 0;
    if (b64[len - 1] === "=") pad++;
    if (b64[len - 2] === "=") pad++;
    return Math.floor((len * 3) / 4) - pad;
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
    img.alt = t("response.image.alt");
    img.src = this.#objectUrl;
    wrap.appendChild(img);
    pane.appendChild(wrap);
  }

  /**
   * Render a PDF. Electron overlays the native pdfium viewer (WebContentsView)
   * over a host element; the dev/browser build has no plugin and offers Save.
   */
  #renderPdf(response, pane) {
    if (!window.hippo?.isElectron) {
      pane.appendChild(
        this.#placeholder({
          icon: "📄",
          text: t("response.placeholder.pdfDesktop"),
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
    const HEX_VIEW_LIMIT = 256 * 1024;

    // Decode/encode only the prefix we display: a large under-spill body must
    // not be fully materialised on the main thread just to show a 256 KB window.
    let bytes;
    let total;
    if (response.encoding === "base64") {
      total = this.#base64ByteLength(response.body ?? "");
      bytes = this.#decodeBytes(response, HEX_VIEW_LIMIT);
    } else {
      const all = new TextEncoder().encode(response.body ?? "");
      total = all.length;
      bytes =
        all.length > HEX_VIEW_LIMIT ? all.subarray(0, HEX_VIEW_LIMIT) : all;
    }

    const shown = Math.min(bytes.length, HEX_VIEW_LIMIT);
    if (shown < total) {
      const note = document.createElement("div");
      note.className = "res-hex-note";
      note.textContent = t("response.truncation.hexNote", {
        shown: this.#formatSize(shown),
        total: this.#formatSize(total),
      });
      pane.appendChild(note);
    }

    const pre = document.createElement("pre");
    pre.className = "res-body-pre res-hex-dump";
    pre.tabIndex = 0;
    fillHexDump(pre, bytes, shown);
    pane.appendChild(pre);
    this.#search.reapplyActiveSearch();
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
        window.hippo?.preview?.pdf
          ?.resize(this.#computeBounds(host))
          .catch(() => {});
      }
    };

    this.#pdfResizeObserver = new ResizeObserver(reposition);
    this.#pdfResizeObserver.observe(host);

    this.#pdfSettingsHandler = () => requestAnimationFrame(reposition);
    window.addEventListener("hippo:settings-changed", this.#pdfSettingsHandler);

    this.#pdfWinResizeHandler = () => requestAnimationFrame(reposition);
    window.addEventListener("resize", this.#pdfWinResizeHandler);

    requestAnimationFrame(() => {
      if (!this.#pdfPreviewActive) return;
      window.hippo?.preview?.pdf
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
        "hippo:settings-changed",
        this.#pdfSettingsHandler,
      );
      this.#pdfSettingsHandler = null;
    }
    this.#pdfHost = null;
    if (window.hippo?.preview?.pdf?.destroy) {
      window.hippo.preview.pdf.destroy().catch(() => {});
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
    text.textContent = t("response.truncation.banner", {
      shown: this.#formatSize(previewBytes),
      total: this.#formatSize(response.fullSize ?? 0),
    });
    banner.appendChild(text);

    if (response.bodyRef) {
      const viewBtn = document.createElement("button");
      viewBtn.type = "button";
      viewBtn.className = "btn btn--secondary res-truncation-btn";
      viewBtn.textContent = t("response.truncation.viewFull");
      viewBtn.addEventListener("click", () => this.#loadFullBody(response));
      banner.appendChild(viewBtn);

      const saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.className = "btn btn--secondary res-truncation-btn";
      saveBtn.textContent = t("response.truncation.saveToFile");
      saveBtn.addEventListener("click", () => this.#saveFullBody(response));
      banner.appendChild(saveBtn);
    } else {
      const note = document.createElement("span");
      note.className = "res-truncation-note";
      note.textContent = t("response.truncation.notCached");
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

    const res = await window.hippo?.http?.body?.get(response.bodyRef);
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
    const result = await window.hippo?.http?.body?.save(
      response.bodyRef,
      filename,
    );
    if (result && result.ok === false && result.reason === "not-found") {
      // The cache was reaped between render and click — refresh the banner.
      response.bodyRef = null;
      this.#renderBodyPane(response);
    }
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
   */
  #activateElectronHtmlPreview(url) {
    const pane = this.#previewPane;
    this.#htmlPreviewActive = true;

    // Show a lightweight loading indicator inside the pane while the URL loads.
    pane.appendChild(
      this.#placeholder({
        icon: "⏳",
        text: t("response.placeholder.loadingPreview"),
        className: "res-html-loading",
        iconClass: "res-spinner",
      }),
    );

    // Keep the overlay positioned correctly when the panel splitter moves
    // (pane width/height changes) or font-size changes (pane grows/shrinks as
    // sibling elements like the tab-strip change height).
    this.#resizeObserver = new ResizeObserver(() => {
      if (this.#htmlPreviewActive && window.hippo?.preview?.html?.resize) {
        window.hippo.preview.html.resize(this.#computePreviewBounds());
      }
    });
    this.#resizeObserver.observe(pane);

    // Listen for settings changes (primarily font-size) as a safety net.
    // Font-size changes alter the tab-strip and status-bar heights, which shifts
    // the pane's position.  In a flex layout the pane's own size changes too
    // (triggering the ResizeObserver), but a deferred reposition ensures we
    // pick up the final layout even if the observer fires before reflow settles.
    this.#settingsHandler = () => {
      if (!this.#htmlPreviewActive || !window.hippo?.preview?.html?.resize)
        return;
      requestAnimationFrame(() => {
        if (this.#htmlPreviewActive && window.hippo?.preview?.html?.resize) {
          window.hippo.preview.html.resize(this.#computePreviewBounds());
        }
      });
    };
    window.addEventListener("hippo:settings-changed", this.#settingsHandler);

    // Also reposition when the Electron window itself is resized.
    this.#winResizeHandler = () => {
      if (!this.#htmlPreviewActive || !window.hippo?.preview?.html?.resize)
        return;
      // Defer one frame so the renderer layout has finished reflowing.
      requestAnimationFrame(() => {
        if (this.#htmlPreviewActive && window.hippo?.preview?.html?.resize) {
          window.hippo.preview.html.resize(this.#computePreviewBounds());
        }
      });
    };
    window.addEventListener("resize", this.#winResizeHandler);

    // Defer the first loadUrl call so the pane has been laid out.
    requestAnimationFrame(() => {
      if (!this.#htmlPreviewActive) return; // destroyed before frame fired
      window.hippo?.preview?.html
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
   */
  #activateDevHtmlPreview(url) {
    const pane = this.#previewPane;
    this.#htmlPreviewActive = true;

    // Pane must be the stacking context for the absolutely-positioned iframe.
    pane.style.position = "relative";
    pane.style.overflow = "hidden";

    const iframe = document.createElement("iframe");
    iframe.src = url ?? "about:blank";
    iframe.setAttribute("title", t("response.preview.htmlTitle"));
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
        "hippo:settings-changed",
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
    if (window.hippo?.preview?.html?.destroy) {
      window.hippo.preview.html.destroy().catch(() => {});
    }
  }

  /**
   * Show or hide the Preview tab.  When hidden while the Preview tab is active,
   * automatically switches to the Body tab.
   * @param {boolean} visible
   */
  #setPreviewTabVisible(visible) {
    const btn = this.#tabStrip?.querySelector('[data-tab="preview"]');
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

    this.#tabStrip.querySelectorAll(".res-tab-btn").forEach((btn) => {
      const active = btn.dataset.tab === tabId;
      btn.classList.toggle("res-tab-btn--active", active);
      btn.setAttribute("aria-selected", String(active));
    });

    this.#tabContent.querySelectorAll(".res-tab-pane").forEach((pane) => {
      pane.hidden = pane.id !== `res-tab-${tabId}`;
    });

    // ── HTML preview — lives on the Preview tab ───────────────────────────
    if (tabId === "preview" && prevTab !== "preview") {
      // Entering Preview tab
      if (this.#isHtmlResponse && this.#lastResponse) {
        if (this.#htmlPreviewActive) {
          // Preview was previously activated and hidden — re-show it.
          if (window.hippo?.isElectron) {
            requestAnimationFrame(() => {
              if (this.#htmlPreviewActive && this.#activeTab === "preview") {
                window.hippo.preview.html
                  .show(this.#computePreviewBounds())
                  .catch(() => {});
              }
            });
          }
          if (this.#iframeEl) this.#iframeEl.style.display = "";
        } else {
          // First time on this response — activate.
          if (window.hippo?.isElectron === true) {
            this.#activateElectronHtmlPreview(this.#lastResponse.requestUrl);
          } else {
            this.#activateDevHtmlPreview(this.#lastResponse.requestUrl);
          }
        }
      }
    } else if (prevTab === "preview" && tabId !== "preview") {
      // Leaving Preview tab — hide the overlay/iframe but keep it alive.
      if (this.#htmlPreviewActive) {
        if (window.hippo?.isElectron) {
          window.hippo.preview.html.hide().catch(() => {});
        }
        if (this.#iframeEl) this.#iframeEl.style.display = "none";
      }
    }

    // ── Native PDF overlay — lives on the Body tab ────────────────────────
    // Hide it when leaving Body so it doesn't float over other tabs; re-show it
    // (deferred a frame so layout settles) when returning to Body.
    if (this.#pdfPreviewActive && window.hippo?.isElectron && this.#pdfHost) {
      if (tabId === "body" && prevTab !== "body") {
        requestAnimationFrame(() => {
          if (
            this.#pdfPreviewActive &&
            this.#activeTab === "body" &&
            this.#pdfHost
          ) {
            window.hippo.preview.pdf
              .show(this.#computeBounds(this.#pdfHost))
              .catch(() => {});
          }
        });
      } else if (prevTab === "body" && tabId !== "body") {
        window.hippo.preview.pdf.hide().catch(() => {});
      }
    }

    // Lazy timeline: drop DOM when leaving, rebuild when entering.
    if (prevTab === "timeline" && tabId !== "timeline") {
      this.#timeline.stopTimestampUpdater();
      const pane = this.#tabContent.querySelector("#res-tab-timeline");
      if (pane) pane.innerHTML = "";
    } else if (tabId === "timeline" && prevTab !== "timeline") {
      this.#timeline.render();
      this.#timeline.startTimestampUpdater();
    }
  }

  // ── Response states ───────────────────────────────────────────────────────
  /**
   * @param {number|null} [startedAt]  Epoch ms of the request's send, so a
   *   switch back to an in-flight request resumes its true elapsed time.
   */
  #showLoading(startedAt = null) {
    this.#lastResponse = null;
    this.#destroyHtmlPreview();
    this.#teardownBinaryEphemera();
    this.#stream.teardownStream({ abort: true });
    this.#setPreviewTabVisible(false);
    this.#search.clearHighlights();
    this.#setStatus("", "", "", "");
    const bodyPane = this.#bodyPane;
    bodyPane.innerHTML = "";
    const placeholder = this.#placeholder({
      icon: "⏳",
      text: t("response.placeholder.sending"),
      iconClass: "res-spinner",
    });

    // Live elapsed readout under the hourglass, ticking until the request
    // settles (#showResponse / #showError / #clearToEmpty stop it).
    this.#stopLoadingTimer();
    const timerEl = document.createElement("span");
    timerEl.className = "res-loading-timer";
    placeholder.appendChild(timerEl);
    const t0 = startedAt ?? Date.now();
    const tick = () => {
      timerEl.textContent = `${((Date.now() - t0) / 1000).toFixed(1)} s`;
    };
    tick();
    this.#loadingTimer = setInterval(tick, 100);
    // Under Node/jsdom (tests) the interval would otherwise hold the event
    // loop open and hang `node --test`; in the browser unref doesn't exist.
    this.#loadingTimer?.unref?.();

    bodyPane.appendChild(placeholder);

    // Clear console + tests panes on each new request
    this.#renderConsole([]);
    this.#applyTestResults([]);
  }

  /** Stop the live elapsed readout (idempotent). */
  #stopLoadingTimer() {
    if (this.#loadingTimer) {
      clearInterval(this.#loadingTimer);
      this.#loadingTimer = null;
    }
  }

  #showError(detail) {
    this.#stopLoadingTimer();
    this.#lastResponse = null;
    this.#destroyHtmlPreview();
    this.#teardownBinaryEphemera();
    this.#stream.teardownStream({ abort: true });
    this.#setPreviewTabVisible(false);
    this.#applyTestResults([]);
    this.#search.clearHighlights();
    const hasStatus = detail?.status && detail.status > 0;
    const statusCode = hasStatus ? String(detail.status) : "ERR";
    const statusTxt =
      detail?.statusText || detail?.name || t("response.error.connection");
    const elapsed = detail?.elapsed ? `${detail.elapsed} ms` : "";

    this.#setStatus(statusCode, statusTxt, elapsed, "");
    const badge = this.#statusBar.querySelector(".res-status-badge");
    badge.className = `res-status-badge ${hasStatus ? this.#statusClass(detail.status) : "res-status--error"}`;

    // Body pane — show error placeholder
    const bodyPane = this.#bodyPane;
    bodyPane.innerHTML = "";
    const err = this.#placeholder({
      icon: "⚠️",
      text: detail?.message ?? t("response.error.requestFailed"),
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
            `* ${detail?.message || t("response.error.unknown")}`,
            detail?.hint ? `* Hint: ${detail.hint}` : null,
          ].filter(Boolean);
    this.#renderConsole(log);
  }

  /** Reset the viewer to its initial empty state (no response loaded). */
  #clearToEmpty() {
    this.#stopLoadingTimer();
    this.#lastResponse = null;
    this.#destroyHtmlPreview();
    this.#teardownBinaryEphemera();
    this.#stream.teardownStream({ abort: true });
    this.#setPreviewTabVisible(false);
    this.#search.clearHighlights();
    this.#filter.reset();
    this.#setStatus("", "", "", "");
    this.#statusBar.querySelector(".res-status-badge").className =
      "res-status-badge";
    this.#bodyPane.innerHTML = "";
    this.#bodyPane.appendChild(this.#emptyState());
    const headersPane = this.#tabContent.querySelector("#res-tab-headers");
    if (headersPane) headersPane.innerHTML = "";
    const cookiesPane = this.#tabContent.querySelector("#res-tab-cookies");
    if (cookiesPane) cookiesPane.innerHTML = "";
    this.#renderConsole([]);
    this.#applyTestResults([]);
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
    this.#stopLoadingTimer();

    // Live streaming (Feature 33): the marker carries no body — switch to the
    // live-append surface and let the hippo:stream-* events fill it.
    if (response.streaming === true) {
      this.#stream.startStream(response, requestUrl);
      return;
    }
    // A normal response supersedes any prior live stream — abort it.
    this.#stream.teardownStream({ abort: true });

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
      // A recorded streaming run (Feature 33) carries a compact summary in place
      // of a body; #renderBodyPane renders it instead of the (empty) body.
      streamSummary = null,
      // Test assertions (Feature 29) — present on a Timeline replay; absent on a
      // live send (the hippo:test-results event fills them in shortly after).
      testResults = [],
    } = response;

    // A fresh response starts in its default view; drop any binary overlay/blob
    // left over from the previous one.
    this.#teardownBinaryEphemera();

    // Cache the raw response for re-rendering when the mode changes.
    // requestUrl comes from the caller (history path) or falls back to the
    // request snapshot embedded in live hippo:response-received events.
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
      streamSummary,
      testResults,
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
    const badge = this.#statusBar.querySelector(".res-status-badge");
    badge.className = `res-status-badge ${statusClass}`;

    // ── Body pane ──────────────────────────────────────────────────────────
    // A fresh response closes any filter left open on the previous one.
    this.#filter.reset();
    this.#renderBodyPane(this.#lastResponse);

    // ── Headers pane ───────────────────────────────────────────────────────
    this.#renderHeadersPane(headers);

    // ── Cookies pane ───────────────────────────────────────────────────────
    this.#renderCookiesPane(cookies);

    // ── Console pane ───────────────────────────────────────────────────────
    this.#renderConsole(consoleLog);

    // ── Tests pane (Feature 29) ──────────────────────────────────────────────
    // Replay carries results on the response; a live send arrives empty here and
    // is completed by the hippo:test-results event a moment later.
    this.#applyTestResults(testResults);
  }

  /** Fill the Headers tab with a key/value table (shared by the static + stream renders). */
  #renderHeadersPane(headers) {
    const headersPane = this.#tabContent.querySelector("#res-tab-headers");
    headersPane.innerHTML = "";
    const table = document.createElement("table");
    table.className = "res-headers-table res-headers-table--split";
    Object.entries(headers ?? {}).forEach(([k, v]) => {
      const row = table.insertRow();
      row.insertCell().textContent = k;
      row.insertCell().textContent = v;
    });
    headersPane.appendChild(table);
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
    const cookiesPane = this.#tabContent.querySelector("#res-tab-cookies");
    if (!cookiesPane) return;
    cookiesPane.innerHTML = "";
    if (cookies.length > 0) {
      const ct = document.createElement("table");
      ct.className = "res-headers-table res-headers-table--thirds";
      // Header row
      const hdr = ct.insertRow();
      [
        t("response.cookies.name"),
        t("response.cookies.attributes"),
        t("response.cookies.value"),
      ].forEach((lbl) => {
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
        this.#placeholder({ text: t("response.cookies.empty") }),
      );
    }
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
    // Retain the current lines so an after-response script's console output can
    // append to (not replace) the HTTP verbose log (Feature 25).
    this.#consoleLines = Array.isArray(lines) ? [...lines] : [];
    const pane = this.#tabContent.querySelector("#res-tab-console");
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

  // ── Tests pane (Feature 29) ─────────────────────────────────────────────────

  /**
   * Apply a set of assertion results to the Tests tab + status badge and reveal
   * the tab. Shared by the live (hippo:test-results) and replay (#showResponse)
   * paths. An empty set hides the tab/badge and resets to the placeholder.
   * @param {Array<{name:string,passed:boolean,message:string}>} results
   * @param {{total:number,passed:number,failed:number}|null} [summary]
   */
  #applyTestResults(results, summary = null) {
    const list = Array.isArray(results) ? results : [];
    const sum =
      summary ??
      (list.length
        ? {
            total: list.length,
            passed: list.filter((r) => r.passed).length,
            failed: list.filter((r) => !r.passed).length,
          }
        : null);
    this.#renderTests(list);
    this.#showTestsBadge(sum);
    this.#setTestsTabVisible(list.length > 0);
  }

  /**
   * Render the assertion results into the Tests pane: a summary line plus one row
   * per assertion with a pass/fail glyph, name, and failure message.
   * @param {Array<{name:string,passed:boolean,message:string}>} results
   */
  #renderTests(results) {
    this.#testResults = Array.isArray(results) ? [...results] : [];
    const pane = this.#tabContent.querySelector("#res-tab-tests");
    if (!pane) return;
    pane.innerHTML = "";

    if (!this.#testResults.length) {
      pane.appendChild(this.#testsPlaceholder());
      return;
    }

    const passed = this.#testResults.filter((r) => r.passed).length;
    const failed = this.#testResults.length - passed;

    const summary = document.createElement("div");
    summary.className = "res-tests-summary";
    summary.classList.add(
      failed > 0 ? "res-tests-summary--fail" : "res-tests-summary--pass",
    );
    summary.textContent = t("response.tests.summary", {
      passed,
      failed,
      total: this.#testResults.length,
    });
    pane.appendChild(summary);

    const listEl = document.createElement("div");
    listEl.className = "res-tests-list";
    this.#testResults.forEach((r) => {
      const row = document.createElement("div");
      row.className = `res-tests-row ${
        r.passed ? "res-tests-row--pass" : "res-tests-row--fail"
      }`;

      const glyph = document.createElement("span");
      glyph.className = "res-tests-glyph";
      glyph.setAttribute("aria-hidden", "true");
      glyph.textContent = r.passed ? "✓" : "✗";

      const label = document.createElement("span");
      label.className = "res-tests-name";
      label.textContent = r.name || "";

      const status = document.createElement("span");
      status.className = "res-tests-status";
      status.textContent = r.passed
        ? t("response.tests.passed")
        : t("response.tests.failed");

      row.appendChild(glyph);
      row.appendChild(label);
      row.appendChild(status);

      // Failure detail (the matcher message) on its own line when present.
      if (!r.passed && r.message) {
        const msg = document.createElement("div");
        msg.className = "res-tests-message";
        msg.textContent = r.message;
        row.appendChild(msg);
      }

      listEl.appendChild(row);
    });
    pane.appendChild(listEl);
  }

  /** Show the pass/fail summary badge in the status bar (green pass / red fail). */
  #showTestsBadge(summary) {
    const badge = this.#statusBar?.querySelector(".res-tests-badge");
    if (!badge) return;
    if (!summary || !summary.total) {
      this.#hideTestsBadge();
      return;
    }
    const pass = summary.failed === 0;
    badge.textContent = `${pass ? "✓" : "✗"} ${summary.passed}/${summary.total}`;
    badge.classList.toggle("res-tests--pass", pass);
    badge.classList.toggle("res-tests--fail", !pass);
    badge.hidden = false;
  }

  #hideTestsBadge() {
    const badge = this.#statusBar?.querySelector(".res-tests-badge");
    if (badge) {
      badge.hidden = true;
      badge.textContent = "";
      badge.classList.remove("res-tests--pass", "res-tests--fail");
    }
  }

  /** Show/hide the Tests tab button; fall back to Body if it was active + hidden. */
  #setTestsTabVisible(visible) {
    const btn = this.#tabStrip?.querySelector('[data-tab="tests"]');
    if (btn) btn.hidden = !visible;
    if (!visible && this.#activeTab === "tests") {
      this.#switchTab("body");
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  #setStatus(code, text, time, size) {
    this.#statusBar.querySelector(".res-status-badge").textContent = code;
    this.#statusBar.querySelector(".res-status-text").textContent = text;
    this.#statusBar.querySelector(".res-time").textContent = time;
    this.#statusBar.querySelector(".res-size").textContent = size;
    // A fresh status render clears any captured marker from the previous
    // response; the next hippo:captures-applied (fired after the response is
    // shown) re-shows it if this response captured anything.
    this.#hideCapturedBadge();
    // Likewise clear the test marker — #showResponse re-applies it from the
    // response's own results (replay) and the hippo:test-results event re-shows
    // it on a live send.
    this.#hideTestsBadge();
  }

  /** Show the post-response captured-variable marker (count only — never values). */
  #showCapturedBadge(count) {
    const badge = this.#statusBar?.querySelector(".res-captured-badge");
    if (!badge) return;
    if (!count || count < 1) {
      this.#hideCapturedBadge();
      return;
    }
    badge.textContent = `⤓ ${t("response.captured.badge", { count })}`;
    badge.hidden = false;
  }

  #hideCapturedBadge() {
    const badge = this.#statusBar?.querySelector(".res-captured-badge");
    if (badge) {
      badge.hidden = true;
      badge.textContent = "";
    }
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
