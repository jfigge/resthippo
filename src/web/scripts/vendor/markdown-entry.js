/**
 * markdown-entry.js — Markdown renderer bundle entry point
 *
 * Bundles `marked` (CommonMark / GFM parser) + `DOMPurify` (HTML sanitizer)
 * into a single safe renderer for untrusted response bodies.
 *
 * marked turns markdown into HTML; DOMPurify then strips any scripts, inline
 * event handlers and javascript: URLs that survive parsing, so the output is
 * safe to assign via innerHTML in the sandboxed renderer.
 *
 * Every link is forced to target="_blank" so the main process opens it in the
 * system browser (see setWindowOpenHandler in main.js) instead of navigating
 * the app window.
 *
 * Fenced code blocks are emitted as <pre><code class="language-xxx"> carrying
 * the escaped source as text; response-viewer.js re-highlights them with the
 * already-bundled Prism so we do not ship a second highlighter here.
 *
 * This file is NOT imported at runtime — it is compiled by esbuild into
 *   web/scripts/vendor/markdown.js
 * via the `vendor-markdown` npm / make target.
 */

import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: false });

// Open every link in the system browser; never navigate the renderer window.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.hasAttribute("href")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

/** Render an untrusted markdown source string to sanitized HTML. */
export function renderMarkdown(src) {
  const rawHtml = marked.parse(src ?? "", { async: false });
  return DOMPurify.sanitize(rawHtml);
}

export default renderMarkdown;
