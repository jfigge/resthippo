/**
 * response-viewer.js — HTTP response display component
 *
 * Displays the result of a wurl:send-request in one of three views:
 *
 *  1. JSON / YAML / XML  — raw text or pretty-printed + syntax-highlighted depending on renderMode
 *  2. HTML               — raw text with syntax highlighting (raw mode) or live browser preview (preview mode)
 *                          • Electron: WebContentsView that loads the request URL
 *                          • Dev/browser: <iframe src=requestUrl> placeholder
 *  3. Everything else    — raw text only (renderMode toggle is a no-op)
 */

"use strict";

import { PopupManager } from "../popup-manager.js";
import Prism from "../vendor/prism.js";

const TABS = [
  { id: "body",     label: "Body"     },
  { id: "headers",  label: "Headers"  },
  { id: "cookies",  label: "Cookies"  },
  { id: "console",  label: "Console"  },
  { id: "timeline", label: "Timeline" },
];

// ── Content-type classification ───────────────────────────────────────────────

/**
 * Classify a Content-Type header value into one of the rendering categories.
 * @param {string} ct  - raw Content-Type value (may include charset/boundary)
 * @returns {"json"|"yaml"|"xml"|"html"|"other"}
 */
function classifyContentType(ct) {
  const base = (ct ?? "").toLowerCase().split(";")[0].trim();
  if (base.includes("json"))                                         return "json";
  if (base.includes("yaml"))                                         return "yaml";
  if (base.includes("xml"))                                          return "xml";
  if (base === "text/html" || base === "application/xhtml+xml")      return "html";
  return "other";
}

// ── Simple XML pretty-printer ─────────────────────────────────────────────────

function prettyXml(xml) {
  try {
    const INDENT = "  ";
    // Collapse existing whitespace between tags so we start fresh.
    const normalised = xml.replace(/>\s+</g, "><").trim();
    let depth  = 0;
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

// ── ResponseViewer class ──────────────────────────────────────────────────────

export class ResponseViewer {
  /** @type {HTMLElement} */
  #el;
  #activeTab    = "body";
  #renderMode   = "preview";   // "preview" | "raw"
  #lastResponse = null;        // cached so mode changes can re-render

  // Cached reference to the body pane element (set once in #renderTabContent)
  #bodyPane = null;

  // HTML-preview state
  #htmlPreviewActive  = false;  // true while an HTML preview is live
  #popupDepth         = 0;      // count of currently open popups (prevents re-show during rapid open/close)
  #iframeEl           = null;   // dev-mode <iframe> element
  #resizeObserver     = null;   // observes body pane for Electron overlay
  #winResizeHandler   = null;   // window resize listener for Electron overlay
  #settingsHandler    = null;   // wurl:settings-changed listener for font-size repositioning

  // Find-in-response search bar state
  #searchBar     = null;   // the bar element
  #searchInput   = null;   // text input
  #prevBtn       = null;   // navigate to previous match
  #nextBtn       = null;   // navigate to next match
  #caseBtn       = null;   // Cc toggle button
  #regexBtn      = null;   // .* toggle button
  #searchMatches = [];     // current <mark> elements
  #searchCurrent = -1;     // index of the active (focused) match

  constructor() {
    this.#el = document.createElement("div");
    this.#el.className = "response-viewer";

    this.#renderStatusBar();
    this.#renderTabStrip();
    this.#renderTabContent();
    this.#renderSearchBar();   // inserted between tab-strip and tab-content

    // Listen for responses
    window.addEventListener("wurl:response-received", (e) =>
      this.#showResponse(e.detail),
    );
    window.addEventListener("wurl:request-loading", () => this.#showLoading());
    window.addEventListener("wurl:request-error", (e) =>
      this.#showError(e.detail),
    );

    // Keyboard shortcuts while focus is inside the response viewer
    this.#el.addEventListener("keydown", (e) => {
      // Cmd/Ctrl+A → select body text only (pass through when search input is focused)
      const selectAll = e.key === "a" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey;
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
      const findKey = e.key === "f" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey;
      if (findKey) {
        e.preventDefault();
        e.stopPropagation();
        this.#openSearch();
      }
    });

    // Hide the Electron HTML preview whenever any popup/menu/dialog opens so the
    // native WebContentsView (which renders above all web content) does not cover it.
    // Re-show it with the correct bounds once the popup is dismissed.
    window.addEventListener("wurl:popup-opened", () => {
      this.#popupDepth++;
      if (this.#htmlPreviewActive && window.wurl?.isElectron) {
        window.wurl.htmlPreview.hide().catch(() => {});
      }
    });
    window.addEventListener("wurl:popup-closed", () => {
      this.#popupDepth = Math.max(0, this.#popupDepth - 1);
      if (!this.#htmlPreviewActive || !window.wurl?.isElectron) return;
      if (this.#activeTab !== "body") return;   // body tab is not visible — stay hidden
      requestAnimationFrame(() => {
        if (!this.#htmlPreviewActive || this.#popupDepth > 0) return;
        window.wurl.htmlPreview.show(this.#computePreviewBounds()).catch(() => {});
      });
    });
  }

  /**
   * Apply persisted settings to the viewer.
   * @param {{ responseBodyRenderMode?: string }} settings
   */
  applySettings(settings) {
    if (settings.responseBodyRenderMode) {
      this.#renderMode = settings.responseBodyRenderMode;
      this.#updateBodyTabLabel();
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
        btn.textContent = this.#bodyTabLabel();
        // Right-click on the Body tab → render-mode context menu
        btn.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          PopupManager.openMenu(this.#buildBodyContextMenu(), e.clientX, e.clientY);
        });
      } else {
        btn.textContent = tab.label;
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

    // Cache a direct reference to the body pane for use by HTML preview
    this.#bodyPane = content.querySelector("#res-tab-body");

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
    prevBtn.innerHTML =
      `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
         <polyline points="18 15 12 9 6 15"/>
       </svg>`;

    // Next-match button (down arrow)
    const nextBtn = document.createElement("button");
    nextBtn.className = "res-search-btn res-search-nav-btn";
    nextBtn.title = "Next match (Enter)";
    nextBtn.setAttribute("aria-label", "Next match");
    nextBtn.disabled = true;
    nextBtn.innerHTML =
      `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
         <polyline points="6 9 12 15 18 9"/>
       </svg>`;

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
    closeBtn.textContent = "✕";

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

    prevBtn.addEventListener("click", () => this.#goToMatch(this.#searchCurrent - 1));
    nextBtn.addEventListener("click", () => this.#goToMatch(this.#searchCurrent + 1));

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

    this.#searchBar   = bar;
    this.#searchInput = input;
    this.#prevBtn     = prevBtn;
    this.#nextBtn     = nextBtn;
    this.#caseBtn     = caseBtn;
    this.#regexBtn    = regexBtn;

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
      this.#searchMatches[this.#searchCurrent].classList.remove("res-search-highlight--current");
    }

    // Wrap around
    this.#searchCurrent = ((index % count) + count) % count;

    const mark = this.#searchMatches[this.#searchCurrent];
    mark.classList.add("res-search-highlight--current");
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

    const caseSensitive = this.#caseBtn.classList.contains("res-search-btn--active");
    const useRegex      = this.#regexBtn.classList.contains("res-search-btn--active");
    const flags         = caseSensitive ? "g" : "gi";

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
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null);
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
          frag.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
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
      this.#bodyPane.querySelectorAll("mark.res-search-highlight").forEach((mark) => {
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

  #emptyState() {
    const el = document.createElement("div");
    el.className = "panel-placeholder";
    el.innerHTML =
      '<span class="placeholder-icon">📡</span>' +
      "<span>Send a request to see the response</span>";
    return el;
  }

  #consolePlaceholder() {
    const el = document.createElement("div");
    el.className = "panel-placeholder";
    el.innerHTML =
      '<span class="placeholder-icon">🖥️</span>' +
      "<span>Verbose output from each request will appear here</span>";
    return el;
  }

  // ── Body context menu ─────────────────────────────────────────────────────

  /** Returns the label text for the Body tab given the current render mode. */
  #bodyTabLabel() {
    return this.#renderMode === "raw" ? "Body: Raw" : "Body: Preview";
  }

  /** Sync the Body tab button text to the current render mode. */
  #updateBodyTabLabel() {
    const btn = this._tabStrip?.querySelector('[data-tab="body"]');
    if (btn) btn.textContent = this.#bodyTabLabel();
  }

  #buildBodyContextMenu() {
    const menu = document.createElement("div");
    menu.className = "tree-ctxmenu";
    menu.setAttribute("role", "menu");
    menu.addEventListener("contextmenu", (e) => e.preventDefault());

    [
      { label: "Preview", mode: "preview" },
      { label: "Raw",     mode: "raw"     },
    ].forEach(({ label, mode }) => {
      const btn = document.createElement("button");
      btn.className = "tree-ctxmenu__item res-body-menu-item";
      btn.setAttribute("role", "menuitem");

      const tick = document.createElement("span");
      tick.className = "res-body-menu-tick";
      tick.textContent = this.#renderMode === mode ? "✓" : "";

      btn.appendChild(tick);
      btn.appendChild(document.createTextNode(label));
      btn.addEventListener("click", () => {
        PopupManager.close();
        this.#setRenderMode(mode);
      });
      menu.appendChild(btn);
    });

    return menu;
  }

  #setRenderMode(mode) {
    if (this.#renderMode === mode) return;
    this.#renderMode = mode;
    this.#updateBodyTabLabel();
    // Persist the choice via the shared editor-setting channel
    window.dispatchEvent(new CustomEvent("wurl:editor-setting-changed", {
      detail: { responseBodyRenderMode: mode },
    }));
    // Re-render the body pane if we have a cached response
    if (this.#lastResponse) {
      this.#renderBodyPane(this.#lastResponse);
    }
  }

  // ── Render body pane ──────────────────────────────────────────────────────

  /**
   * Main body-pane renderer — routes to text, HTML iframe, or Electron overlay
   * depending on content type and render mode.
   *
   * @param {object} response  - cached response object (includes requestUrl)
   */
  #renderBodyPane(response) {
    const pane       = this.#bodyPane;
    // Node.js (Electron) lowercases all header names; browsers may preserve
    // title-case.  Search case-insensitively so both environments work.
    const hdrs       = response.headers ?? {};
    const ct         = (Object.entries(hdrs).find(([k]) => k.toLowerCase() === "content-type")?.[1]) ?? "";
    const category   = classifyContentType(ct);
    const isElectron = window.wurl?.isElectron === true;

    // Always tear down any existing HTML preview and highlights before re-rendering.
    this.#clearHighlights();
    this.#destroyHtmlPreview();
    pane.innerHTML = "";

    // ── HTML content type ─────────────────────────────────────────────────
    if (category === "html" && this.#renderMode === "preview") {
      if (isElectron) {
        this.#activateElectronHtmlPreview(response.requestUrl, pane);
      } else {
        this.#activateDevHtmlPreview(response.requestUrl, pane);
      }
      return;
    }

    // ── Text rendering (JSON / YAML / XML / other / HTML-raw) ─────────────
    const pre = document.createElement("pre");
    pre.className = "res-body-pre";
    // Make focusable so keyboard events (e.g. Cmd/Ctrl+A) bubble up to the viewer.
    pre.tabIndex = 0;

    /** @type {string|null} Prism language id, or null for plain text */
    let prismLang = null;
    let displayText;

    if (this.#renderMode === "preview" && (category === "json" || category === "yaml" || category === "xml")) {
      // Pretty-print structured formats and syntax-highlight them
      displayText = this.#prettyBody(response.body, category);
      prismLang   = category === "xml" ? "markup" : category;
    } else if (category === "html" && this.#renderMode === "raw") {
      // Raw HTML source — highlight as markup
      displayText = response.body;
      prismLang   = "markup";
    } else {
      // raw mode for JSON/YAML/XML, or unrecognised type — show verbatim
      displayText = response.body;
    }

    if (prismLang) {
      const grammar = Prism.languages[prismLang];
      const code = document.createElement("code");
      code.className = `language-${prismLang}`;
      if (grammar) {
        code.innerHTML = Prism.highlight(displayText, grammar, prismLang);
      } else {
        code.textContent = displayText;
      }
      pre.appendChild(code);
    } else {
      pre.textContent = displayText;
    }

    pane.appendChild(pre);

    // Re-apply an active search query (the pane was just rebuilt from scratch)
    if (this.#searchBar && !this.#searchBar.hidden && this.#searchInput?.value.trim()) {
      this.#runSearch();
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
    const r = this.#bodyPane.getBoundingClientRect();
    return {
      x:      Math.round(r.left),
      y:      Math.round(r.top),
      width:  Math.max(1, Math.round(r.width)),
      height: Math.max(1, Math.round(r.height)),
    };
  }

  /**
   * Electron mode: overlay a WebContentsView on the body pane and navigate to
   * the request URL.  A ResizeObserver on the body pane plus a settings-changed
   * listener keeps the bounds in sync as panels resize or the font-size changes.
   *
   * @param {string}      url   - original request URL to load
   * @param {HTMLElement} pane  - body pane element (used only for the loading placeholder)
   */
  #activateElectronHtmlPreview(url, pane) {
    this.#htmlPreviewActive = true;

    // Show a lightweight loading indicator inside the pane while the URL loads.
    const placeholder = document.createElement("div");
    placeholder.className = "panel-placeholder res-html-loading";
    placeholder.innerHTML =
      '<span class="placeholder-icon res-spinner">⏳</span>' +
      "<span>Loading preview…</span>";
    pane.appendChild(placeholder);

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
      if (!this.#htmlPreviewActive) return;  // destroyed before frame fired
      window.wurl?.htmlPreview?.loadUrl(url, this.#computePreviewBounds()).catch(() => {});
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
  #activateDevHtmlPreview(url, pane) {
    this.#htmlPreviewActive = true;

    // Pane must be the stacking context for the absolutely-positioned iframe.
    pane.style.position = "relative";
    pane.style.overflow = "hidden";

    const iframe = document.createElement("iframe");
    iframe.src = url;
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
      window.removeEventListener("wurl:settings-changed", this.#settingsHandler);
      this.#settingsHandler = null;
    }

    // Remove dev-mode iframe.
    if (this.#iframeEl) {
      this.#iframeEl.remove();
      this.#iframeEl = null;
    }

    // Destroy the Electron WebContentsView.
    if (window.wurl?.htmlPreview?.destroy) {
      window.wurl.htmlPreview.destroy().catch(() => {});
    }
  }

  // ── Pretty-printing ───────────────────────────────────────────────────────

  /**
   * Return a pretty-printed version of `body` for the given category.
   * Falls back to the raw body if parsing fails.
   *
   * @param {string} body
   * @param {"json"|"yaml"|"xml"} category
   */
  #prettyBody(body, category) {
    try {
      if (category === "json") {
        return JSON.stringify(JSON.parse(body), null, 2);
      }
      if (category === "xml") {
        return prettyXml(body);
      }
      // YAML is typically already human-readable; return as-is.
    } catch { /* fall through to raw */ }
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

    // When running in Electron with an HTML preview active, hide/show the
    // WebContentsView overlay depending on whether the body tab is visible.
    if (this.#htmlPreviewActive && window.wurl?.htmlPreview) {
      if (tabId !== "body" && prevTab === "body") {
        // Leaving the body tab — detach the overlay
        window.wurl.htmlPreview.hide().catch(() => {});
      } else if (tabId === "body" && prevTab !== "body") {
        // Returning to the body tab — re-attach and reposition the overlay
        requestAnimationFrame(() => {
          window.wurl.htmlPreview.show(this.#computePreviewBounds()).catch(() => {});
        });
      }
    }

    // Dev-mode iframe: simply show/hide it via CSS.
    if (this.#iframeEl) {
      this.#iframeEl.style.display = tabId === "body" ? "" : "none";
    }
  }

  // ── Response states ───────────────────────────────────────────────────────
  #showLoading() {
    this.#lastResponse = null;
    this.#destroyHtmlPreview();
    this.#clearHighlights();
    this.#setStatus("", "", "", "");
    const bodyPane = this.#bodyPane;
    bodyPane.innerHTML = "";
    const loading = document.createElement("div");
    loading.className = "panel-placeholder";
    loading.innerHTML =
      '<span class="placeholder-icon res-spinner">⏳</span>' +
      "<span>Sending request…</span>";
    bodyPane.appendChild(loading);

    // Clear console pane on each new request
    this.#renderConsole([]);
  }

  #showError(detail) {
    this.#lastResponse = null;
    this.#destroyHtmlPreview();
    this.#clearHighlights();
    const hasStatus  = detail?.status && detail.status > 0;
    const statusCode = hasStatus ? String(detail.status) : "ERR";
    const statusTxt  = detail?.statusText || detail?.name || "Connection Error";
    const elapsed    = detail?.elapsed ? `${detail.elapsed} ms` : "";

    this.#setStatus(statusCode, statusTxt, elapsed, "");
    const badge = this._statusBar.querySelector(".res-status-badge");
    badge.className = `res-status-badge ${hasStatus ? this.#statusClass(detail.status) : "res-status--error"}`;

    // Body pane — show error placeholder
    const bodyPane = this.#bodyPane;
    bodyPane.innerHTML = "";
    const err = document.createElement("div");
    err.className = "panel-placeholder";
    err.innerHTML =
      '<span class="placeholder-icon">⚠️</span>' +
      `<span>${this.#escapeHtml(detail?.message ?? "Request failed")}</span>`;
    if (detail?.hint) {
      const hint = document.createElement("span");
      hint.className = "res-error-hint";
      hint.textContent = detail.hint;
      err.appendChild(hint);
    }
    bodyPane.appendChild(err);

    // Console pane — always show the verbose log (or an error summary)
    const log = Array.isArray(detail?.consoleLog) && detail.consoleLog.length
      ? detail.consoleLog
      : [
          `* Error: ${detail?.name || "NetworkError"}`,
          `* ${detail?.message || "An unknown error occurred."}`,
          detail?.hint ? `* Hint: ${detail.hint}` : null,
        ].filter(Boolean);
    this.#renderConsole(log);
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
  #showResponse(response) {
    const {
      request    = {},
      status     = 0,
      statusText = "",
      headers    = {},
      cookies    = [],
      body       = "",
      elapsed    = 0,
      size       = 0,
      consoleLog = [],
    } = response;

    // Cache for re-rendering when the mode is changed.
    // Store the original request URL so HTML preview can load it.
    this.#lastResponse = {
      requestUrl: request.url ?? "",
      status, statusText, headers, cookies, body, elapsed, size, consoleLog,
    };

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
    table.className = "res-headers-table";
    Object.entries(headers).forEach(([k, v]) => {
      const row = table.insertRow();
      row.insertCell().textContent = k;
      row.insertCell().textContent = v;
    });
    headersPane.appendChild(table);

    // ── Cookies pane ───────────────────────────────────────────────────────
    const cookiesPane = this._tabContent.querySelector("#res-tab-cookies");
    cookiesPane.innerHTML = "";
    if (cookies.length > 0) {
      const ct = document.createElement("table");
      ct.className = "res-headers-table";
      // Header row
      const hdr = ct.insertRow();
      ["Name", "Attributes", "Value"].forEach((lbl) => {
        const th = document.createElement("th");
        th.textContent = lbl;
        th.style.fontWeight = "700";
        th.style.textAlign  = "left";
        th.style.padding    = "4px 12px";
        th.style.color      = "var(--color-overlay-0)";
        th.style.fontSize   = "var(--font-size-xs)";
        th.style.textTransform = "uppercase";
        th.style.letterSpacing = "0.06em";
        hdr.appendChild(th);
      });
      cookies.forEach((raw) => {
        const parts = raw.split(";").map((s) => s.trim());
        const [nameVal, ...attrs] = parts;
        const eqIdx = nameVal.indexOf("=");
        const name  = eqIdx >= 0 ? nameVal.slice(0, eqIdx) : nameVal;
        const value = eqIdx >= 0 ? nameVal.slice(eqIdx + 1) : "";
        const row   = ct.insertRow();
        row.title   = raw;
        row.insertCell().textContent = name;
        row.insertCell().textContent = attrs.join("; ");
        row.insertCell().textContent = value;
      });
      cookiesPane.appendChild(ct);
    } else {
      const empty = document.createElement("div");
      empty.className = "panel-placeholder";
      empty.innerHTML = "<span>No cookies were set by this response</span>";
      cookiesPane.appendChild(empty);
    }

    // ── Console pane ───────────────────────────────────────────────────────
    this.#renderConsole(consoleLog);
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

  // ── Helpers ───────────────────────────────────────────────────────────────
  #setStatus(code, text, time, size) {
    this._statusBar.querySelector(".res-status-badge").textContent = code;
    this._statusBar.querySelector(".res-status-text").textContent  = text;
    this._statusBar.querySelector(".res-time").textContent         = time;
    this._statusBar.querySelector(".res-size").textContent         = size;
  }

  #statusClass(code) {
    if (code >= 200 && code < 300) return "res-status--success";
    if (code >= 300 && code < 400) return "res-status--redirect";
    if (code >= 400 && code < 500) return "res-status--client-error";
    if (code >= 500)               return "res-status--server-error";
    return "";
  }


  #formatSize(bytes) {
    if (bytes < 1024)            return `${bytes} B`;
    if (bytes < 1024 * 1024)    return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  #escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
}
