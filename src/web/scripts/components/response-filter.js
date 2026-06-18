/**
 * response-filter.js — the response body's filter bar.
 *
 * A sibling of the find bar (response-search.js), styled identically, that sits
 * between the tab strip and the tab content. Where Find highlights matches in
 * place, Filter *transforms* the body: the user types a jq expression (JSON),
 * a yq/jq expression (YAML) or an XPath expression (XML) and the body is
 * replaced with the selected fields, re-rendered in the same styled view.
 *
 * The bar is only offered for a styled JSON/YAML/XML body; the host decides
 * eligibility via getFilterTarget() and, when filtering can't apply, shows the
 * "unsupported" notification instead of opening (notifyUnsupported()).
 *
 * The host (ResponseViewer) owns the body content and injects:
 *   • getFilterTarget()  — { category, body } for the current styled body, or
 *       null when the body can't be filtered (wrong type, raw/hex view, …).
 *   • renderFiltered(text, category) — render filtered text into the body pane.
 *   • restoreOriginal()  — re-render the original, unfiltered body.
 *   • notifyUnsupported() — surface the bottom-right "can't filter this" toast.
 */
"use strict";

import { t } from "../i18n.js";
import { icon } from "../icons.js";
import { filterBody } from "./response/body-filter.js";

// Re-run the filter this many ms after the last keystroke (live filtering).
const DEBOUNCE_MS = 200;

export class ResponseFilter {
  #deps;

  // ── DOM refs ─────────────────────────────────────────────────────────────────
  #bar = null;
  #input = null;

  // ── State ────────────────────────────────────────────────────────────────────
  #open = false; // bar visible
  #applied = false; // the current expression filtered successfully (non-empty)
  #debounce = null; // pending debounced re-run handle

  constructor(deps) {
    this.#deps = deps;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /** Build the filter bar and insert it into `el` before `beforeNode`. */
  mount(el, beforeNode) {
    const bar = document.createElement("div");
    bar.className = "res-filter-bar";
    bar.hidden = true;

    const label = document.createElement("span");
    label.className = "res-filter-label";
    label.textContent = t("response.filter.label");
    label.setAttribute("aria-hidden", "true");

    const input = document.createElement("input");
    input.type = "text";
    input.className = "res-filter-input";
    input.setAttribute("aria-label", t("response.filter.inputAria"));
    input.spellcheck = false;
    input.autocapitalize = "off";
    input.autocomplete = "off";

    const actions = document.createElement("div");
    actions.className = "res-filter-actions";

    const closeBtn = document.createElement("button");
    closeBtn.className = "res-filter-btn res-filter-close-btn";
    closeBtn.title = t("response.filter.closeTitle");
    closeBtn.setAttribute("aria-label", t("response.filter.closeAria"));
    closeBtn.innerHTML = icon("close", { size: 12 });

    actions.appendChild(closeBtn);
    bar.appendChild(label);
    bar.appendChild(input);
    bar.appendChild(actions);

    // ── Event wiring ──────────────────────────────────────────────────────
    input.addEventListener("input", () => {
      clearTimeout(this.#debounce);
      this.#debounce = setTimeout(() => this.#apply(), DEBOUNCE_MS);
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        clearTimeout(this.#debounce);
        this.#apply();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      }
    });

    closeBtn.addEventListener("click", () => this.close());

    this.#bar = bar;
    this.#input = input;

    el.insertBefore(bar, beforeNode);
  }

  /**
   * Open the filter bar for the current body. When the body can't be filtered
   * (wrong MIME type, or not in the styled view) the host's "unsupported"
   * notification is shown and the bar stays hidden.
   */
  open() {
    const target = this.#deps.getFilterTarget();
    if (!target) {
      this.#deps.notifyUnsupported();
      return;
    }
    this.#input.placeholder = this.#placeholderFor(target.category);
    this.#bar.hidden = false;
    this.#open = true;
    this.#input.select();
    this.#input.focus();
    // Re-apply a query left from a previous open on this body.
    if (this.#input.value.trim()) this.#apply();
  }

  /** Hide the bar and restore the original body (Escape / ✕). */
  close() {
    if (!this.#open) return;
    clearTimeout(this.#debounce);
    this.#open = false;
    this.#applied = false;
    this.#bar.hidden = true;
    this.#setError(null);
    this.#deps.restoreOriginal();
  }

  /**
   * Drop all filter state without restoring (the host has already re-rendered
   * the body for another reason — a new response, a render-mode switch, or a
   * cleared viewer). Called by the host before those re-renders.
   */
  reset() {
    clearTimeout(this.#debounce);
    this.#open = false;
    this.#applied = false;
    if (this.#bar) this.#bar.hidden = true;
    if (this.#input) this.#input.value = "";
    this.#setError(null);
  }

  /**
   * Re-apply the active filter onto a freshly-rebuilt original body. The host
   * calls this at the tail of its styled-body render so cosmetic re-renders
   * (wrap / line-numbers / folding toggles) keep showing the filtered output.
   * Returns true when it rendered filtered text (the host then skips its own
   * find-highlight re-apply, which the filtered render already performed).
   */
  reapply() {
    if (!this.#open || !this.#applied) return false;
    try {
      return this.#renderFiltered();
    } catch {
      // The original body is already on screen — leave it and drop the flag.
      this.#applied = false;
      return false;
    }
  }

  /** True when `target` is this bar's input (host's select-all guard). */
  isFilterInput(target) {
    return target === this.#input;
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  /**
   * Compute and render the filtered body for the current expression. Returns
   * true if filtered text was rendered, false if the expression is empty (the
   * caller restores the original). Throws on a parse / expression error.
   */
  #renderFiltered() {
    const expr = this.#input.value.trim();
    if (!expr) return false;
    const target = this.#deps.getFilterTarget();
    if (!target) return false;
    const text = filterBody(target.category, target.body, expr);
    this.#deps.renderFiltered(text, target.category);
    return true;
  }

  /** User-driven apply (debounced input / Enter). */
  #apply() {
    if (!this.#open) return;
    this.#setError(null);
    const expr = this.#input.value.trim();
    if (!expr) {
      this.#applied = false;
      this.#deps.restoreOriginal();
      return;
    }
    try {
      this.#renderFiltered();
      this.#applied = true;
    } catch (err) {
      this.#applied = false;
      this.#setError(err);
      // Keep the original body visible while the expression is invalid.
      this.#deps.restoreOriginal();
    }
  }

  /** Toggle the input's error state and tooltip (null clears it). */
  #setError(err) {
    if (!this.#input) return;
    if (err) {
      const detail =
        err?.message && err.message !== "undefined" ? err.message : "";
      this.#input.classList.add("res-filter-input--error");
      this.#input.title = detail
        ? t("response.filter.error", { message: detail })
        : t("response.filter.invalid");
    } else {
      this.#input.classList.remove("res-filter-input--error");
      this.#input.title = "";
    }
  }

  #placeholderFor(category) {
    if (category === "yaml") return t("response.filter.placeholderYaml");
    if (category === "xml") return t("response.filter.placeholderXml");
    return t("response.filter.placeholderJson");
  }
}
