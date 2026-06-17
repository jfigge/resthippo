/**
 * body-render.js — pure DOM builders for the response Body pane.
 *
 * Extracted from ResponseViewer: these take an element + data (and, for the
 * foldable view, the relevant view settings) and produce/fill DOM. They hold no
 * component state, so they are plain functions rather than methods. The stateful
 * body machinery (preview overlays, render-mode routing, truncation banner,
 * pretty-printers) stays in ResponseViewer.
 */
"use strict";

import Prism from "../../vendor/prism.js";
import { icon } from "../../icons.js";
import { t } from "../../i18n.js";

/**
 * Map a markdown fenced-code info-string (the word after ```) to a Prism
 * grammar id. Anything unlisted is left un-highlighted.
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

/** Fill `el` with Prism-highlighted `text`, or plain text when no grammar. */
export function fillHighlighted(
  el,
  text,
  prismLang,
  grammar = Prism.languages[prismLang],
) {
  if (grammar) el.innerHTML = Prism.highlight(text, grammar, prismLang);
  else el.textContent = text;
}

/**
 * Append a `<code class="language-…">` block to a <pre>, highlighted via
 * fillHighlighted.
 */
export function appendCodeBlock(pre, text, prismLang) {
  const code = document.createElement("code");
  code.className = `language-${prismLang}`;
  fillHighlighted(code, text, prismLang);
  pre.appendChild(code);
}

/** Fill a <pre> with a classic offset|hex|ascii hex dump of `bytes`. */
export function fillHexDump(pre, bytes, length) {
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

/** Build the "buffered NDJSON, streaming off" in-flight hint banner. */
export function buildNdjsonStreamHint() {
  const banner = document.createElement("div");
  banner.className = "res-stream-hint-banner";
  const text = document.createElement("span");
  text.className = "res-stream-hint-text";
  text.textContent = t("response.streamHint.ndjson");
  banner.appendChild(text);
  return banner;
}

/**
 * Re-highlight the fenced code blocks inside a rendered-markdown container with
 * the bundled Prism. marked emits `<pre><code class="language-xxx">` with the
 * source as escaped text; map the info-string to a Prism grammar and replace the
 * block's HTML with the highlighted version.
 */
export function highlightMarkdownCode(root) {
  const blocks = root.querySelectorAll('pre > code[class*="language-"]');
  for (const code of blocks) {
    const cls = /language-([\w-]+)/.exec(code.className)?.[1] ?? "";
    const prismLang = MD_CODE_LANG[cls.toLowerCase()];
    const grammar = prismLang ? Prism.languages[prismLang] : null;
    if (!grammar) continue;
    // textContent is the decoded source (marked escaped it into the markup).
    fillHighlighted(code, code.textContent, prismLang, grammar);
    code.className = `language-${prismLang}`;
  }
}

/**
 * Render an indentation-structured body (JSON / XML / YAML / HTML / CSS / JS) as
 * a stack of foldable lines. See the original ResponseViewer doc for the full
 * behaviour notes; structure is read purely from leading whitespace and the full
 * text stays in the DOM (rows hidden, not removed) so find/select/copy work.
 *
 * @param {HTMLPreElement} pre   the body <pre> to populate
 * @param {string} text          body text (pretty-printed for JSON/XML/HTML)
 * @param {string} prismLang     Prism language id
 * @param {object} opts
 * @param {boolean} opts.folding        draw the fold gutter + carets
 * @param {boolean} opts.lineNumbers    draw the line-number gutter
 * @param {(reveal: (lineEl: HTMLElement) => void) => void} opts.setFoldReveal
 *   register the search fold-reveal hook (called only when folding is on)
 */
export function renderFoldableCode(
  pre,
  text,
  prismLang,
  { folding, lineNumbers, setFoldReveal },
) {
  const grammar = prismLang ? Prism.languages[prismLang] : null;
  const lines = text.split("\n");

  // Very large bodies: skip the per-line machinery and fall back to one block.
  const MAX_FOLD_LINES = 5000;
  if (lines.length > MAX_FOLD_LINES) {
    appendCodeBlock(pre, text, prismLang);
    return;
  }

  // --foldable marks the per-line styled render (drives the body menu's Line
  // numbers / Code folding toggles); --folding additionally turns on the fold
  // gutter + carets. Folding off → no gutter, so the default left inset returns.
  pre.classList.add("res-body-pre--foldable");
  if (folding) pre.classList.add("res-body-pre--folding");
  if (lineNumbers) {
    pre.classList.add("res-body-pre--line-numbers");
    // Reserve one shared column width = widest line number, so every row's
    // numbers right-align without the code column shifting at digit boundaries.
    pre.style.setProperty("--res-num-ch", `${String(lines.length).length}ch`);
  }

  // Leading-space depth per line; blank lines are continuations (null).
  const indent = lines.map((line) => {
    if (line.trim() === "") return null;
    return line.length - line.trimStart().length;
  });

  // foldEnd[i] = inclusive index of the last child line of opener i. Skipped
  // entirely when folding is off, so no openers and no fold carets are drawn.
  const foldEnd = new Map();
  if (folding) {
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

    // Line number (source index, 1-based). Hidden via CSS unless the pre
    // carries --line-numbers; aria-hidden + user-select:none keep it out of
    // copy / select-all / find. A folded row's number still reflects its true
    // source line, so collapsed ranges leave the expected gaps.
    const num = document.createElement("span");
    num.className = "res-fold-num";
    num.textContent = String(i + 1);
    num.setAttribute("aria-hidden", "true");
    lineEl.appendChild(num);

    // The fold gutter (caret column) exists only while folding is on; off, the
    // row is just [number][code] and the caret column reclaims its space.
    if (folding) {
      const gutter = document.createElement("span");
      gutter.className = "res-fold-gutter";

      if (foldEnd.has(i)) {
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "res-fold-toggle";
        toggle.setAttribute("aria-label", t("response.fold.toggleAria"));
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
      lineEl.appendChild(gutter);
    }

    const code = document.createElement("span");
    code.className = `res-fold-code language-${prismLang}`;
    fillHighlighted(code, lines[i], prismLang, grammar);

    lineEl.appendChild(code);
    frag.appendChild(lineEl);
    lineEls.push(lineEl);
  }
  pre.appendChild(frag);

  // Search navigator hook: open every collapsed fold enclosing a match line.
  // Only meaningful with folding on; otherwise the search keeps a null
  // fold-reveal and the navigator just scrolls to the match.
  if (!folding) return;
  setFoldReveal((lineEl) => {
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
  });
}
