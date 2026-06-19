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
 * response-search.js — the response body's find-in-page bar.
 *
 * Extracted verbatim (behaviour-preserving) from ResponseViewer: a slim
 * search bar (query input, prev/next navigation, case-sensitivity and
 * regular-expression toggles, close) that wraps every match in the visible
 * body text in a `<mark class="res-search-highlight">`, walks between them
 * with wrap-around, and — in the foldable JSON/XML view — opens the folds
 * enclosing a match before scrolling to it.
 *
 * The host (ResponseViewer) keeps ownership of the body content and injects
 * the two things the search needs to read from it:
 *   • getBodyPane()          — the current body-pane element (where the
 *       `.res-body-pre` to search lives, and where stray <mark>s are cleared).
 *   • isHtmlPreviewActive()  — true while a live HTML preview covers the body,
 *       when there is no searchable text (open + run are then no-ops).
 *
 * The fold-reveal hook is push-state, not a dependency: the host hands it in
 * via setFoldReveal() whenever it (re)builds a foldable body, and clears it
 * (null) for every other body kind — so the navigator only expands folds when
 * the current view actually has them.
 */
"use strict";

import { t } from "../i18n.js";
import { icon } from "../icons.js";

export class ResponseSearch {
  #deps;

  // ── Per-mount DOM refs ───────────────────────────────────────────────────────
  #bar = null;
  #input = null;
  #prevBtn = null;
  #nextBtn = null;
  #caseBtn = null;
  #regexBtn = null;

  // ── Match state ──────────────────────────────────────────────────────────────
  #matches = []; // current <mark> elements, in document order
  #current = -1; // index of the active (focused) match
  #lastQuery = null; // query string of the last run search, so Enter knows
  // whether to navigate (unchanged) or restart (edited)
  // fn(lineEl) that expands collapsed folds around a line, or null when the
  // body isn't a foldable view (host-supplied via setFoldReveal).
  #foldReveal = null;

  constructor(deps) {
    this.#deps = deps;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /** Build the search bar and insert it into `el` before `beforeNode`. */
  mount(el, beforeNode) {
    const bar = document.createElement("div");
    bar.className = "res-search-bar";
    bar.hidden = true;

    const label = document.createElement("span");
    label.className = "res-search-label";
    label.textContent = t("response.find.label");
    label.setAttribute("aria-hidden", "true");

    const input = document.createElement("input");
    input.type = "text";
    input.className = "res-search-input";
    input.placeholder = t("response.find.placeholder");
    input.setAttribute("aria-label", t("response.find.inputAria"));

    const actions = document.createElement("div");
    actions.className = "res-search-actions";

    // Previous-match button (up arrow)
    const prevBtn = document.createElement("button");
    prevBtn.className = "res-search-btn res-search-nav-btn";
    prevBtn.title = t("response.find.prevTitle");
    prevBtn.setAttribute("aria-label", t("response.find.prevAria"));
    prevBtn.disabled = true;
    prevBtn.innerHTML = icon("chevronUp", { size: 12 });

    // Next-match button (down arrow)
    const nextBtn = document.createElement("button");
    nextBtn.className = "res-search-btn res-search-nav-btn";
    nextBtn.title = t("response.find.nextTitle");
    nextBtn.setAttribute("aria-label", t("response.find.nextAria"));
    nextBtn.disabled = true;
    nextBtn.innerHTML = icon("chevronDown", { size: 12 });

    // Case-sensitivity toggle
    const caseBtn = document.createElement("button");
    caseBtn.className = "res-search-btn";
    caseBtn.title = t("response.find.caseTitle");
    caseBtn.setAttribute("aria-label", t("response.find.caseTitle"));
    caseBtn.setAttribute("aria-pressed", "false");
    caseBtn.textContent = t("response.find.caseLabel");

    // Regular-expression toggle
    const regexBtn = document.createElement("button");
    regexBtn.className = "res-search-btn";
    regexBtn.title = t("response.find.regexTitle");
    regexBtn.setAttribute("aria-label", t("response.find.regexAria"));
    regexBtn.setAttribute("aria-pressed", "false");
    regexBtn.textContent = ".*";

    // Close button
    const closeBtn = document.createElement("button");
    closeBtn.className = "res-search-btn res-search-close-btn";
    closeBtn.title = t("response.find.closeTitle");
    closeBtn.setAttribute("aria-label", t("response.find.closeAria"));
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
        // Enter/Shift+Enter navigates only while the query is unchanged since
        // the last run; a fresh keystroke in the input restarts the search
        // instead of advancing through the now-stale matches.
        if (this.#matches.length > 0 && this.#input.value === this.#lastQuery) {
          this.#goToMatch(this.#current + (e.shiftKey ? -1 : 1));
        } else {
          this.#runSearch();
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      }
    });

    prevBtn.addEventListener("click", () => this.#goToMatch(this.#current - 1));
    nextBtn.addEventListener("click", () => this.#goToMatch(this.#current + 1));

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

    closeBtn.addEventListener("click", () => this.close());

    this.#bar = bar;
    this.#input = input;
    this.#prevBtn = prevBtn;
    this.#nextBtn = nextBtn;
    this.#caseBtn = caseBtn;
    this.#regexBtn = regexBtn;

    // Insert between tab strip and tab content
    el.insertBefore(bar, beforeNode);
  }

  /** Show the search bar and focus the input. No-op when HTML preview is live. */
  open() {
    if (this.#deps.isHtmlPreviewActive()) return;
    this.#bar.hidden = false;
    this.#input.select();
    this.#input.focus();
  }

  /** Hide the search bar and remove all highlights. */
  close() {
    this.#bar.hidden = true;
    this.clearHighlights();
  }

  /** Re-run the active query after the body pane was rebuilt (no-op if closed). */
  reapplyActiveSearch() {
    if (this.#bar && !this.#bar.hidden && this.#input?.value.trim()) {
      this.#runSearch();
    }
  }

  /**
   * Unwrap all `<mark class="res-search-highlight">` nodes, restoring plain
   * text in their place, and reset the match list.
   */
  clearHighlights() {
    const bodyPane = this.#deps.getBodyPane();
    if (bodyPane) {
      bodyPane.querySelectorAll("mark.res-search-highlight").forEach((mark) => {
        const parent = mark.parentNode;
        if (!parent) return;
        parent.replaceChild(document.createTextNode(mark.textContent), mark);
        parent.normalize();
      });
    }
    this.#matches = [];
    this.#current = -1;
    this.#updateNavButtons();
  }

  /** True when `target` is this bar's query input (host's select-all guard). */
  isSearchInput(target) {
    return target === this.#input;
  }

  /**
   * Set (or clear with null) the fold-reveal hook used to open collapsed folds
   * around a match before scrolling to it. The host calls this whenever it
   * (re)builds the body: the foldable view supplies a fn, every other view null.
   */
  setFoldReveal(fn) {
    this.#foldReveal = fn ?? null;
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  /**
   * Navigate to the match at `index`, wrapping at both ends.
   * Removes the current-highlight class from the old match, adds it to the
   * new one, and scrolls it into view.
   */
  #goToMatch(index) {
    const count = this.#matches.length;
    if (count === 0) return;

    // Remove current-highlight from the previous active match
    if (this.#current >= 0 && this.#current < count) {
      this.#matches[this.#current].classList.remove(
        "res-search-highlight--current",
      );
    }

    // Wrap around
    this.#current = ((index % count) + count) % count;

    const mark = this.#matches[this.#current];
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
    const has = this.#matches.length > 0;
    if (this.#prevBtn) this.#prevBtn.disabled = !has;
    if (this.#nextBtn) this.#nextBtn.disabled = !has;
  }

  /**
   * Run the current search query against the visible body text, wrapping
   * each match in a <mark class="res-search-highlight"> element.
   * Navigates to and highlights the first match.
   */
  #runSearch() {
    const query = this.#input?.value ?? "";
    this.#lastQuery = query;
    this.clearHighlights();
    if (!query) return;

    // Only search text content — bail out for HTML previews or missing body
    if (this.#deps.isHtmlPreviewActive()) return;
    const pre = this.#deps.getBodyPane()?.querySelector(".res-body-pre");
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

    this.#matches = this.#highlightMatches(pre, pattern);
    this.#updateNavButtons();

    if (this.#matches.length > 0) {
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
    // Skip the line-number gutter — its digits are presentational, not body text.
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.parentElement?.closest(".res-fold-num")
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    });
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
}
