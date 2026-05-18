/**
 * variable-pill-editor.js — contenteditable inline editor with variable pills.
 *
 * Converts {{variableName}} syntax into inline pill chips as the user types,
 * and serializes back to standard {{variableName}} template syntax.
 * Pills are atomic: cursor cannot enter them; backspace/delete removes them whole.
 *
 * Usage:
 *   const editor = new VariablePillEditor({
 *     placeholder: "Value",
 *     ariaLabel:   "Parameter value",
 *     className:   "params-value",
 *     getContext:  () => ({ envVariables: {…}, folderChain: […] }),
 *     onInput:     (value) => { row.value = value; },
 *     onEnter:     () => addNewRow(),
 *   });
 *   container.appendChild(editor.element);
 *   editor.setValue("Bearer {{token}}");
 *   const serialized = editor.getValue(); // → "Bearer {{token}}"
 */
"use strict";
import { resolveVariable, tokenize, serializeEditor } from "./variable-resolver.js";
export class VariablePillEditor {
  #el;
  #placeholder;
  #onInput;
  #onEnter;
  #getContext;
  #lastValue = "\x00"; // sentinel forces first setValue to always render
  constructor({
    placeholder = "",
    ariaLabel   = "",
    className   = "",
    getContext  = () => null,
    onInput,
    onEnter,
  } = {}) {
    this.#placeholder = placeholder;
    this.#onInput     = onInput   ?? null;
    this.#onEnter     = onEnter   ?? null;
    this.#getContext  = getContext;
    const el = document.createElement("div");
    el.contentEditable = "true";
    el.spellcheck      = false;
    el.setAttribute("autocorrect",    "off");
    el.setAttribute("autocapitalize", "off");
    el.dataset.placeholder = placeholder;
    el.dataset.empty       = "true";
    el.className = ["pill-editor", "params-input", className]
      .filter(Boolean).join(" ");
    el.setAttribute("role",       "textbox");
    el.setAttribute("aria-label", ariaLabel || placeholder);
    el.addEventListener("input",   () => this.#onEditorInput());
    el.addEventListener("keydown", (e) => this.#onKeyDown(e));
    el.addEventListener("paste",   (e) => this.#onPaste(e));
    el.addEventListener("drop",    (e) => this.#onDrop(e));
    this.#el = el;
  }
  get element() { return this.#el; }
  getValue() {
    return serializeEditor(this.#el);
  }
  setValue(text) {
    const normalized = text ?? "";
    if (normalized === this.#lastValue) return;
    this.#lastValue = normalized;
    this.#renderFromText(normalized);
    this.#syncEmpty();
  }
  focus() {
    this.#el.focus();
  }
  revalidate() {
    const ctx = this.#getContext();
    for (const pill of this.#el.querySelectorAll(".variable-pill")) {
      const name = pill.dataset.variable;
      if (!name) continue;
      const { found } = resolveVariable(name, ctx);
      pill.classList.toggle("variable-pill--known",   found);
      pill.classList.toggle("variable-pill--unknown", !found);
    }
  }
  // ── Private ──────────────────────────────────────────────────────────────
  #renderFromText(text) {
    const ctx    = this.#getContext();
    const tokens = tokenize(text);
    const frag   = document.createDocumentFragment();

    for (const token of tokens) {
      if (token.type === "text") {
        if (token.content) frag.appendChild(document.createTextNode(token.content));
      } else {
        frag.appendChild(this.#makePill(token.content, ctx));
      }
    }

    this.#el.innerHTML = "";
    this.#el.appendChild(frag);
    // Guarantee navigable text nodes at both edges and between adjacent pills
    this.#ensureEdgePadding();
  }
  #makePill(name, ctx) {
    const span = document.createElement("span");
    span.contentEditable  = "false";
    span.dataset.variable = name;
    span.textContent      = name;
    span.title            = `{{${name}}}`;
    const { found } = resolveVariable(name, ctx);
    span.className = [
      "variable-pill",
      found ? "variable-pill--known" : "variable-pill--unknown",
    ].join(" ");
    return span;
  }
  #scanAndConvertAll() {
    const ctx    = this.#getContext();
    const VAR_RE = /\{\{([^{}]+)\}\}/g;
    const children = [...this.#el.childNodes];

    for (const child of children) {
      if (child.nodeType !== Node.TEXT_NODE) continue;
      if (!this.#el.contains(child)) continue;

      const text    = child.textContent;
      const matches = [...text.matchAll(VAR_RE)];
      if (!matches.length) continue;

      const frag = document.createDocumentFragment();
      let pos    = 0;

      for (const match of matches) {
        if (match.index > pos) {
          frag.appendChild(document.createTextNode(text.slice(pos, match.index)));
        }
        frag.appendChild(this.#makePill(match[1], ctx));
        pos = match.index + match[0].length;
      }
      if (pos < text.length) {
        frag.appendChild(document.createTextNode(text.slice(pos)));
      }

      child.replaceWith(frag);
    }
    // Guarantee navigable text nodes at both edges and between adjacent pills
    this.#ensureEdgePadding();
  }
  #onEditorInput() {
    this.#tryConvertAtCaret();
    const val       = serializeEditor(this.#el);
    this.#lastValue = val;
    this.#syncEmpty();
    this.#onInput?.(val);
  }
  #tryConvertAtCaret() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;

    const range = sel.getRangeAt(0);
    if (!range.collapsed) return;

    const { startContainer, startOffset } = range;
    if (startContainer.nodeType !== Node.TEXT_NODE) return;
    if (!this.#el.contains(startContainer)) return;

    const text   = startContainer.textContent;
    const before = text.slice(0, startOffset);

    if (!before.endsWith("}}")) return;

    const openIdx = before.lastIndexOf("{{");
    if (openIdx === -1) return;

    const name = before.slice(openIdx + 2, before.length - 2).trim();
    if (!name || /[{}]/.test(name)) return;

    const beforeText = text.slice(0, openIdx);
    const afterText  = text.slice(startOffset);
    const ctx        = this.#getContext();
    const pill       = this.#makePill(name, ctx);
    const parent     = startContainer.parentNode;

    const beforeNode = beforeText ? document.createTextNode(beforeText) : null;
    // Always create afterNode — even when empty — so the caret always lands
    // inside a concrete text node, not as a child-index offset of the element.
    const afterNode  = document.createTextNode(afterText);

    if (beforeNode) parent.insertBefore(beforeNode, startContainer);
    parent.insertBefore(pill, startContainer);
    parent.insertBefore(afterNode, startContainer);
    parent.removeChild(startContainer);

    // Ensure navigable text nodes at both edges / between pills BEFORE
    // placing the caret so that any newly-inserted leading node doesn't
    // shift the child indices we rely on.
    this.#ensureEdgePadding();

    // Place caret at the start of the text node that now follows the pill.
    // Because we always create afterNode above, pill.nextSibling is guaranteed
    // to be a text node (either afterNode itself, or the edge-padding node).
    const caretNode = pill.nextSibling;
    if (caretNode && caretNode.nodeType === Node.TEXT_NODE) {
      const newRange = document.createRange();
      newRange.setStart(caretNode, 0);
      newRange.collapse(true);
      sel.removeAllRanges();
      sel.addRange(newRange);
    }
  }
  #onKeyDown(e) {
    if (e.key === "Enter") {
      e.preventDefault();
      this.#onEnter?.();
      return;
    }

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);

    if (e.key === "Backspace" && range.collapsed) {
      const pill = this.#pillBeforeCaret(range);
      if (pill) {
        e.preventDefault();
        pill.remove();
        this.#ensureEdgePadding();
        this.#emitChange();
        return;
      }
    }

    if (e.key === "Delete" && range.collapsed) {
      const pill = this.#pillAfterCaret(range);
      if (pill) {
        e.preventDefault();
        pill.remove();
        this.#ensureEdgePadding();
        this.#emitChange();
        return;
      }
    }
  }
  #onPaste(e) {
    e.preventDefault();
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (!text) return;
    this.#insertTextAtCaret(text);
  }
  #onDrop(e) {
    e.preventDefault();
    const text = e.dataTransfer?.getData("text/plain") ?? "";
    if (!text) return;
    const dropRange = document.caretRangeFromPoint?.(e.clientX, e.clientY);
    if (dropRange) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(dropRange);
    }
    this.#insertTextAtCaret(text);
  }
  #insertTextAtCaret(text) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!range.collapsed) range.deleteContents();
    const textNode = document.createTextNode(text);
    range.insertNode(textNode);
    const newRange = document.createRange();
    newRange.setStartAfter(textNode);
    newRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(newRange);
    this.#scanAndConvertAll();
    this.#emitChange();
  }
  #pillBeforeCaret(range) {
    const { startContainer, startOffset } = range;
    if (startContainer === this.#el) {
      if (startOffset > 0) {
        const prev = this.#el.childNodes[startOffset - 1];
        if (prev?.classList?.contains("variable-pill")) return prev;
      }
      return null;
    }
    if (startContainer.nodeType === Node.TEXT_NODE && startOffset === 0) {
      const prev = startContainer.previousSibling;
      if (prev?.classList?.contains("variable-pill")) return prev;
    }
    return null;
  }
  #pillAfterCaret(range) {
    const { startContainer, startOffset } = range;
    if (startContainer === this.#el) {
      const next = this.#el.childNodes[startOffset];
      if (next?.classList?.contains("variable-pill")) return next;
      return null;
    }
    if (
      startContainer.nodeType === Node.TEXT_NODE &&
      startOffset === startContainer.textContent.length
    ) {
      const next = startContainer.nextSibling;
      if (next?.classList?.contains("variable-pill")) return next;
    }
    return null;
  }
  #emitChange() {
    const val       = serializeEditor(this.#el);
    this.#lastValue = val;
    this.#syncEmpty();
    this.#onInput?.(val);
  }
  #syncEmpty() {
    const text     = this.#el.textContent.replace(/\u200B/g, "");
    const hasText  = text.trim() !== "";
    const hasPills = this.#el.querySelector(".variable-pill") !== null;
    this.#el.dataset.empty = String(!hasText && !hasPills);
  }
  /**
   * Guarantee navigable text nodes at both edges of the editor and between
   * any two consecutive pill spans.
   *
   * Without these guard nodes the browser has no text-node position to place
   * the caret before the first pill or after the last pill, making it
   * impossible to type in those regions.
   *
   * Guard nodes adjacent to pills use a zero-width space (U+200B) so that
   * the browser can anchor a caret there even when the node would otherwise
   * appear visually empty.  The serialiser and empty-state check both strip
   * U+200B, so it is invisible to the rest of the application.
   */
  #ensureEdgePadding() {
    // Zero-width space used as an invisible but navigable caret anchor.
    const ZWS = "\u200B";

    // Empty editor — put in one plain text node so the caret can live somewhere
    if (!this.#el.firstChild) {
      this.#el.appendChild(document.createTextNode(""));
      return;
    }

    // Guarantee a text node at the very start
    if (this.#el.firstChild.nodeType !== Node.TEXT_NODE) {
      this.#el.insertBefore(document.createTextNode(ZWS), this.#el.firstChild);
    } else if (this.#el.firstChild.textContent === "") {
      // Upgrade an existing empty guard so the caret can land here
      this.#el.firstChild.textContent = ZWS;
    }

    // Guarantee a text node at the very end
    if (this.#el.lastChild.nodeType !== Node.TEXT_NODE) {
      this.#el.appendChild(document.createTextNode(ZWS));
    } else if (
      this.#el.lastChild !== this.#el.firstChild &&
      this.#el.lastChild.textContent === ""
    ) {
      this.#el.lastChild.textContent = ZWS;
    }

    // Guarantee a text node between any two consecutive non-text siblings
    // (prevents two adjacent pills from becoming unnavigable)
    let node = this.#el.firstChild;
    while (node && node.nextSibling) {
      const next = node.nextSibling;
      if (node.nodeType !== Node.TEXT_NODE && next.nodeType !== Node.TEXT_NODE) {
        this.#el.insertBefore(document.createTextNode(ZWS), next);
        // Don't advance — re-check from this node in case there are more
      } else {
        node = next;
      }
    }
  }
}
