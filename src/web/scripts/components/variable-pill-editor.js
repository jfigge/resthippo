/**
 * variable-pill-editor.js — contenteditable inline editor with variable and function pills.
 *
 * Converts {{varName}} and {{funcName(args)}} syntax into inline pill chips as the user
 * types, and serializes back to standard {{…}} template syntax.  Pills are atomic:
 * cursor cannot enter them; backspace/delete removes them whole.
 *
 * Typing "{{" opens a PillPicker dropdown (after a configurable debounce) to browse
 * variables and functions.  The editor retains keyboard focus — arrow keys / Enter /
 * Escape are forwarded to the picker internally.
 *
 * Usage:
 *   const editor = new VariablePillEditor({
 *     placeholder: "Value",
 *     ariaLabel:   "Parameter value",
 *     className:   "params-value",
 *     getContext:  () => ({ collectionVariables: {…}, folderChain: […] }),
 *     getItems:    () => treeView.getItems(),   // for request-picker params
 *     onInput:     (value) => { row.value = value; },
 *     onEnter:     () => addNewRow(),
 *   });
 *   container.appendChild(editor.element);
 *   editor.setValue("Bearer {{token}}");
 *   const serialized = editor.getValue(); // → "Bearer {{token}}"
 */
"use strict";

import {
  resolveVariable,
  tokenize,
  serializeEditor,
  isFunctionCall,
  parseFunctionCall,
  buildFunctionToken,
} from "./variable-resolver.js";
import { makeVariablePill, makeFunctionPill } from "./pill-builders.js";
import { PillPickerController } from "./pill-picker-controller.js";
import { t } from "../i18n.js";

let _pickerDebounceMs = 200;

/**
 * Given two serialized editor values, returns the character offset in `to`
 * that marks the end of the changed region — i.e. where the cursor should land
 * after an undo (to=prev) or redo (to=next).
 */
function _histDiffCursor(from, to) {
  let prefix = 0;
  const minLen = Math.min(from.length, to.length);
  while (prefix < minLen && from[prefix] === to[prefix]) prefix++;
  let fromEnd = from.length,
    toEnd = to.length;
  while (
    fromEnd > prefix &&
    toEnd > prefix &&
    from[fromEnd - 1] === to[toEnd - 1]
  ) {
    fromEnd--;
    toEnd--;
  }
  return toEnd;
}
export function setPickerDebounceMs(ms) {
  _pickerDebounceMs = typeof ms === "number" && ms >= 0 ? ms : 200;
}

/** Current picker debounce in ms — shared with the GraphQL autocomplete popup. */
export function getPickerDebounceMs() {
  return _pickerDebounceMs;
}

export class VariablePillEditor {
  #el;
  #placeholder;
  #onInput;
  #onEnter;
  #onPasteHook;
  #getContext;
  #getItems;
  #ensureResponseCaches;
  #lastValue = "\x00"; // sentinel forces first setValue to always render
  // The `{{` typeahead lifecycle is owned by the shared controller; this editor
  // injects its contenteditable root, context, debounce, and how to insert.
  #picker = new PillPickerController({
    getRoot: () => this.#el,
    getContext: () => this.#getContext(),
    onInsert: (raw) => this.insertToken(raw),
    debounceMs: () => getPickerDebounceMs(),
  });

  #isFocused = false;

  // Stable reference so we can detach the document-level selectionchange
  // listener in destroy(). Without removal each new editor leaks its listener,
  // and there are several per request — they pile up as the user navigates.
  #onSelectionChange = () => {
    if (this.#isFocused) {
      this.#scrollToSelectionEnd();
      this.#syncPillSelection();
    }
  };

  // ── Undo / redo ────────────────────────────────────────────────────────────
  #history = []; // committed serialized-value snapshots
  #histIdx = -1; // pointer into #history; -1 = empty
  #histTimer = null; // debounce handle (500 ms inactivity → commit)
  #histPaused = false; // true while restoring a snapshot

  constructor({
    placeholder = "",
    ariaLabel = "",
    className = "",
    getContext = () => null,
    getItems = () => [],
    ensureResponseCaches = null,
    onInput,
    onEnter,
    onPaste,
  } = {}) {
    this.#placeholder = placeholder;
    this.#onInput = onInput ?? null;
    this.#onEnter = onEnter ?? null;
    // Optional interceptor: given the pasted plain text, return true to signal
    // the paste was fully handled (so the editor skips its own insertion). Used
    // by the URL bar to catch a pasted cURL command (request-editor.js).
    this.#onPasteHook = onPaste ?? null;
    this.#getContext = getContext;
    this.#getItems = getItems;
    this.#ensureResponseCaches = ensureResponseCaches;

    const el = document.createElement("div");
    el.contentEditable = "true";
    el.spellcheck = false;
    el.setAttribute("autocorrect", "off");
    el.setAttribute("autocapitalize", "off");
    el.dataset.placeholder = placeholder;
    el.dataset.empty = "true";
    el.className = ["pill-editor", "params-input", className]
      .filter(Boolean)
      .join(" ");
    el.setAttribute("role", "textbox");
    el.setAttribute("aria-label", ariaLabel || placeholder);
    el.addEventListener("input", () => this.#onEditorInput());
    el.addEventListener("keydown", (e) => this.#onKeyDown(e));
    el.addEventListener("copy", (e) => this.#onCopy(e));
    el.addEventListener("cut", (e) => this.#onCut(e));
    el.addEventListener("paste", (e) => this.#onPaste(e));
    el.addEventListener("drop", (e) => this.#onDrop(e));
    el.addEventListener("focus", () => {
      this.#isFocused = true;
    });
    el.addEventListener("blur", () => {
      this.#isFocused = false;
      this.#picker.close();
      for (const p of el.querySelectorAll(".variable-pill--selected"))
        p.classList.remove("variable-pill--selected");
    });
    el.addEventListener("mouseup", () => this.#normalizeAfterMouse());
    document.addEventListener("selectionchange", this.#onSelectionChange);
    this.#el = el;
  }

  get element() {
    return this.#el;
  }

  /**
   * Detach document-level listeners and clear pending timers.  Callers must
   * invoke this before discarding an editor — otherwise the selectionchange
   * listener keeps the instance reachable forever.
   */
  destroy() {
    document.removeEventListener("selectionchange", this.#onSelectionChange);
    if (this.#histTimer) {
      clearTimeout(this.#histTimer);
      this.#histTimer = null;
    }
    this.#picker.close(); // controller clears its own pending-open timer
  }

  getValue() {
    return serializeEditor(this.#el);
  }

  setValue(text) {
    const normalized = text ?? "";
    if (normalized === this.#lastValue) return;
    this.#lastValue = normalized;
    this.#renderFromText(normalized);
    this.#syncEmpty();
    if (!this.#histPaused) {
      clearTimeout(this.#histTimer);
      this.#histTimer = null;
      this.#history = [normalized];
      this.#histIdx = 0;
    }
  }

  focus() {
    this.#el.focus();
  }

  revalidate() {
    const ctx = this.#getContext();
    for (const pill of this.#el.querySelectorAll(".variable-pill")) {
      if (pill.dataset.function !== undefined) continue;
      const name = pill.dataset.variable;
      if (!name) continue;
      const { found } = resolveVariable(name, ctx);
      pill.classList.toggle("variable-pill--known", found);
      pill.classList.toggle("variable-pill--unknown", !found);
    }
  }

  /**
   * Replace the "{{" + filter prefix before the caret with a fully-formed pill
   * derived from rawToken.  Called when the user selects an item from the picker.
   */
  insertToken(rawToken) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!range.collapsed) return;
    const { startContainer, startOffset } = range;
    if (startContainer.nodeType !== Node.TEXT_NODE) return;
    if (!this.#el.contains(startContainer)) return;

    const text = startContainer.textContent;
    const before = text.slice(0, startOffset);
    const openIdx = before.lastIndexOf("{{");
    if (openIdx === -1) return;

    const ctx = this.#getContext();
    const beforeText = text.slice(0, openIdx);
    const afterText = text.slice(startOffset);

    const m = /^\{\{([^{}]+)\}\}$/.exec(rawToken);
    let pill = null;
    if (m) {
      const content = m[1].trim();
      if (isFunctionCall(content)) {
        const parsed = parseFunctionCall(content);
        if (parsed) pill = this.#makeFunctionPill(parsed.name, parsed.rawArgs);
      } else {
        pill = this.#makePill(content, ctx);
      }
    }
    if (!pill) {
      this.#picker.close();
      return;
    }

    const parent = startContainer.parentNode;
    const beforeNode = beforeText ? document.createTextNode(beforeText) : null;
    const afterNode = document.createTextNode(afterText);

    if (beforeNode) parent.insertBefore(beforeNode, startContainer);
    parent.insertBefore(pill, startContainer);
    parent.insertBefore(afterNode, startContainer);
    parent.removeChild(startContainer);

    this.#ensureEdgePadding();

    // Place the caret just after the inserted pill via the logical model, so it
    // lands inside the trailing guard span when the pill is now the last node
    // (where a bare text position can't paint the caret).
    const afterPill = this.#domToLogical(pill, 0) + 1;
    const pos = this.#logicalToDom(afterPill);
    this.#setCollapsedCaret(pos.node, pos.offset);

    this.#picker.close();
    this.#emitChange();
  }

  // ── Private ───────────────────────────────────────────────────────────────

  #renderFromText(text) {
    const ctx = this.#getContext();
    const tokens = tokenize(text);
    const frag = document.createDocumentFragment();

    for (const token of tokens) {
      if (token.type === "text") {
        if (token.content)
          frag.appendChild(document.createTextNode(token.content));
      } else if (isFunctionCall(token.content)) {
        const parsed = parseFunctionCall(token.content);
        frag.appendChild(
          parsed
            ? this.#makeFunctionPill(parsed.name, parsed.rawArgs)
            : this.#makePill(token.content, ctx),
        );
      } else {
        frag.appendChild(this.#makePill(token.content, ctx));
      }
    }

    this.#el.innerHTML = "";
    this.#el.appendChild(frag);
    this.#ensureEdgePadding();
  }

  #makePill(name, ctx) {
    return makeVariablePill(name, ctx, {
      getContext: this.#getContext,
      onCommit: () => this.#emitChange(),
      onContextMenu: (x, y, onEdit, onDelete) =>
        this.#showPillContextMenu(x, y, onEdit, onDelete),
    });
  }

  #makeFunctionPill(name, rawArgs) {
    return makeFunctionPill(name, rawArgs, {
      getContext: this.#getContext,
      getItems: this.#getItems,
      ensureResponseCaches: this.#ensureResponseCaches,
      onCommit: () => this.#emitChange(),
      onContextMenu: (x, y, onEdit, onDelete) =>
        this.#showPillContextMenu(x, y, onEdit, onDelete),
    });
  }

  #scanAndConvertAll() {
    const ctx = this.#getContext();
    const VAR_RE = /\{\{([^{}]+)\}\}/g;

    // Text pasted/dropped while the caret was inside a guard span lands inside
    // that (mask-exempt) span; pull it back into a top-level text node first so
    // it is both masked and visible to the scan below.
    this.#exfiltrateGuards();

    for (const child of [...this.#el.childNodes]) {
      if (child.nodeType !== Node.TEXT_NODE) continue;

      const text = child.textContent;
      const matches = [...text.matchAll(VAR_RE)];
      if (!matches.length) continue;

      const frag = document.createDocumentFragment();
      let pos = 0;

      for (const match of matches) {
        if (match.index > pos) {
          frag.appendChild(
            document.createTextNode(text.slice(pos, match.index)),
          );
        }
        const content = match[1];
        if (isFunctionCall(content)) {
          const parsed = parseFunctionCall(content);
          frag.appendChild(
            parsed
              ? this.#makeFunctionPill(parsed.name, parsed.rawArgs)
              : this.#makePill(content, ctx),
          );
        } else {
          frag.appendChild(this.#makePill(content, ctx));
        }
        pos = match.index + match[0].length;
      }
      if (pos < text.length) {
        frag.appendChild(document.createTextNode(text.slice(pos)));
      }
      child.replaceWith(frag);
    }
    this.#ensureEdgePadding();
  }

  #onEditorInput() {
    // Native editing — clearing the field especially — can leave a filler <br>
    // or block wrapper behind.  #sanitizeArtifacts rebuilds the canonical model
    // (and re-pads) when it finds any; only when it found nothing do we fall
    // back to a bare edge-padding pass, so ordinary typing keeps its cheap path.
    if (!this.#sanitizeArtifacts()) {
      this.#ensureEdgePadding();
    }
    this.#tryConvertAtCaret();
    this.#emitChange();
    this.#picker.schedule();
  }

  #scrollToSelectionEnd() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const { focusNode, focusOffset } = sel;
    if (!focusNode || !this.#el.contains(focusNode)) return;

    let caretLeft, caretRight;
    if (focusNode.nodeType === Node.TEXT_NODE) {
      const r = document.createRange();
      r.setStart(focusNode, focusOffset);
      r.collapse(true);
      const rects = r.getClientRects();
      if (!rects.length) return;
      caretLeft = rects[0].left;
      caretRight = rects[0].right;
    } else {
      // focusNode is an element; the caret sits before childNodes[focusOffset]
      // (or at the very end when that index is past the last child).
      const child = focusNode.childNodes[focusOffset];
      let rect;
      if (child && child.nodeType === Node.ELEMENT_NODE) {
        rect = child.getBoundingClientRect();
      } else if (child && child.nodeType === Node.TEXT_NODE) {
        // Text nodes have no getBoundingClientRect — an empty editor seeds an
        // empty text-node guard (#ensureEdgePadding), so measure the caret via
        // a collapsed range instead, falling back to the element's own rect.
        const r = document.createRange();
        r.setStart(child, 0);
        r.collapse(true);
        rect = r.getClientRects()[0] ?? focusNode.getBoundingClientRect();
      } else {
        rect = focusNode.getBoundingClientRect();
      }
      caretLeft = rect.left;
      caretRight = rect.right;
    }

    const er = this.#el.getBoundingClientRect();
    const PAD = 4;
    if (caretRight > er.right - PAD) {
      this.#el.scrollLeft += caretRight - er.right + PAD;
    } else if (caretLeft < er.left + PAD) {
      this.#el.scrollLeft -= er.left + PAD - caretLeft;
    }
  }

  /**
   * Toggle .variable-pill--selected on every pill that falls inside the
   * current selection range.  Called on every selectionchange while focused.
   */
  #syncPillSelection() {
    const sel = window.getSelection();
    const hasRange = sel && sel.rangeCount > 0 && !sel.isCollapsed;
    const range = hasRange ? sel.getRangeAt(0) : null;

    for (const pill of this.#el.querySelectorAll(".variable-pill")) {
      const selected =
        range !== null &&
        range.comparePoint(pill, 0) <= 0 &&
        range.comparePoint(pill, pill.childNodes.length) >= 0;
      pill.classList.toggle("variable-pill--selected", selected);
    }
  }

  // ── Caret conversion ──────────────────────────────────────────────────────

  #tryConvertAtCaret() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;

    const range = sel.getRangeAt(0);
    if (!range.collapsed) return;

    const { startContainer, startOffset } = range;
    if (startContainer.nodeType !== Node.TEXT_NODE) return;
    if (!this.#el.contains(startContainer)) return;

    const text = startContainer.textContent;
    const before = text.slice(0, startOffset);

    if (!before.endsWith("}}")) return;

    const openIdx = before.lastIndexOf("{{");
    if (openIdx === -1) return;

    const inner = before.slice(openIdx + 2, before.length - 2).trim();
    if (!inner || /[{}]/.test(inner)) return;

    const ctx = this.#getContext();
    const beforeText = text.slice(0, openIdx);
    const afterText = text.slice(startOffset);

    let pill;
    if (isFunctionCall(inner)) {
      const parsed = parseFunctionCall(inner);
      pill = parsed
        ? this.#makeFunctionPill(parsed.name, parsed.rawArgs)
        : this.#makePill(inner, ctx);
    } else {
      pill = this.#makePill(inner, ctx);
    }

    const parent = startContainer.parentNode;
    const beforeNode = beforeText ? document.createTextNode(beforeText) : null;
    const afterNode = document.createTextNode(afterText);

    if (beforeNode) parent.insertBefore(beforeNode, startContainer);
    parent.insertBefore(pill, startContainer);
    parent.insertBefore(afterNode, startContainer);
    parent.removeChild(startContainer);

    this.#ensureEdgePadding();

    // Land the caret just after the freshly-converted pill via the logical
    // model (routes into the trailing guard span when the pill is last).
    const afterPill = this.#domToLogical(pill, 0) + 1;
    const pos = this.#logicalToDom(afterPill);
    this.#setCollapsedCaret(pos.node, pos.offset);
  }

  // ── Key handling ──────────────────────────────────────────────────────────

  #onKeyDown(e) {
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      if (e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        this.#picker.close();
        this.#undo();
        return;
      }
      if (e.key === "y" || (e.key === "z" && e.shiftKey)) {
        e.preventDefault();
        this.#redo();
        return;
      }
    }

    if (this.#picker.isOpen()) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        this.#picker.selectNext();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        this.#picker.selectPrev();
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        const item = this.#picker.getSelected();
        if (item) this.insertToken(item.rawToken);
        else this.#picker.close();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        this.#picker.close();
        return;
      }
    }

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
        const logical = this.#domToLogical(
          range.startContainer,
          range.startOffset,
        );
        pill.remove();
        this.#ensureEdgePadding();
        const pos = this.#logicalToDom(Math.max(0, logical - 1));
        this.#setCollapsedCaret(pos.node, pos.offset);
        this.#emitChange();
        return;
      }
    }

    if (e.key === "Delete" && range.collapsed) {
      const pill = this.#pillAfterCaret(range);
      if (pill) {
        e.preventDefault();
        const logical = this.#domToLogical(
          range.startContainer,
          range.startOffset,
        );
        pill.remove();
        this.#ensureEdgePadding();
        const pos = this.#logicalToDom(logical);
        this.#setCollapsedCaret(pos.node, pos.offset);
        this.#emitChange();
        return;
      }
    }

    // Arrow keys — logical navigation that treats pills as atomic units.
    // Every Left / Right press moves exactly one logical position.  Pills
    // count as one position; ZWS guard characters count as zero.  Shift
    // extends the selection; without Shift a non-collapsed selection
    // collapses to its near or far end without moving further.
    if (
      (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey
    ) {
      e.preventDefault();
      const dir = e.key === "ArrowRight" ? 1 : -1;
      const max = this.#logicalLength();

      if (e.shiftKey) {
        // Extend or shrink the selection by one logical position.
        const anchorLog = this.#domToLogical(sel.anchorNode, sel.anchorOffset);
        const focusLog = this.#domToLogical(sel.focusNode, sel.focusOffset);
        const newFocus = Math.max(0, Math.min(max, focusLog + dir));
        const anchorDOM = this.#logicalToDom(anchorLog);
        const focusDOM = this.#logicalToDom(newFocus);
        sel.setBaseAndExtent(
          anchorDOM.node,
          anchorDOM.offset,
          focusDOM.node,
          focusDOM.offset,
        );
      } else if (!sel.isCollapsed) {
        // Collapse to the near or far end of the existing selection.
        const aLog = this.#domToLogical(sel.anchorNode, sel.anchorOffset);
        const fLog = this.#domToLogical(sel.focusNode, sel.focusOffset);
        const target = dir === 1 ? Math.max(aLog, fLog) : Math.min(aLog, fLog);
        const pos = this.#logicalToDom(target);
        this.#setCollapsedCaret(pos.node, pos.offset);
      } else {
        // Move caret one logical position.
        const cur = this.#domToLogical(sel.focusNode, sel.focusOffset);
        const next = Math.max(0, Math.min(max, cur + dir));
        const pos = this.#logicalToDom(next);
        this.#setCollapsedCaret(pos.node, pos.offset);
      }
      return;
    }

    // Home / End — jump to logical start or end.
    if ((e.key === "Home" || e.key === "End") && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      const target = e.key === "Home" ? 0 : this.#logicalLength();
      const pos = this.#logicalToDom(target);

      if (e.shiftKey) {
        const anchorLog = this.#domToLogical(sel.anchorNode, sel.anchorOffset);
        const anchorDOM = this.#logicalToDom(anchorLog);
        sel.setBaseAndExtent(
          anchorDOM.node,
          anchorDOM.offset,
          pos.node,
          pos.offset,
        );
      } else {
        this.#setCollapsedCaret(pos.node, pos.offset);
      }
      return;
    }
  }

  // ── Copy / paste / drop ───────────────────────────────────────────────────

  #onCopy(e) {
    e.preventDefault();
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) {
      e.clipboardData.setData("text/plain", "");
      return;
    }
    const frag = sel.getRangeAt(0).cloneContents();
    e.clipboardData.setData("text/plain", this.#rawTextFromFragment(frag));
  }

  #onCut(e) {
    e.preventDefault();
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) {
      e.clipboardData.setData("text/plain", "");
      return;
    }
    const range = sel.getRangeAt(0);
    // Serialise pills to their raw {{...}} tokens, mirroring copy.
    e.clipboardData.setData(
      "text/plain",
      this.#rawTextFromFragment(range.cloneContents()),
    );
    if (range.collapsed) return;
    // Remove the selection ourselves so pills are deleted as whole units.
    range.deleteContents();
    sel.removeAllRanges();
    sel.addRange(range);
    this.#scanAndConvertAll();
    this.#emitChange();
  }

  #rawTextFromFragment(node) {
    let out = "";
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        out += child.textContent.replace(/\u200B/g, "");
      } else if (child.classList?.contains("variable-pill")) {
        out +=
          child.dataset.function !== undefined
            ? buildFunctionToken(
                child.dataset.function,
                JSON.parse(child.dataset.fnArgs ?? "[]"),
              )
            : `{{${child.dataset.variable}}}`;
      } else {
        out += this.#rawTextFromFragment(child);
      }
    }
    return out;
  }

  #onPaste(e) {
    e.preventDefault();
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (!text) return;
    // Give an interceptor first refusal (e.g. the URL bar catching a pasted
    // cURL command). When it claims the paste, don't also insert the raw text.
    if (this.#onPasteHook?.(text)) return;
    this.#insertTextAtCaret(text);
  }

  #onDrop(e) {
    e.preventDefault();
    const text = e.dataTransfer?.getData("text/plain") ?? "";
    if (!text) return;
    const dropRange = document.caretRangeFromPoint?.(e.clientX, e.clientY);
    if (dropRange) {
      const sel = window.getSelection();
      if (!sel) {
        this.#insertTextAtCaret(text);
        return;
      }
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

  // ── Pill detection helpers ────────────────────────────────────────────────

  #pillBeforeCaret(range) {
    const { startContainer, startOffset } = range;
    if (startContainer === this.#el) {
      if (startOffset > 0) {
        const prev = this.#el.childNodes[startOffset - 1];
        if (prev?.classList?.contains("variable-pill")) return prev;
      }
      return null;
    }
    if (startContainer.nodeType === Node.TEXT_NODE) {
      // "Effectively at start" when every char before the offset is ZWS.
      const before = startContainer.textContent.slice(0, startOffset);
      if (before.replace(/\u200B/g, "") === "") {
        let prev = startContainer.previousSibling;
        // Inside a guard span the pill is the guard's own previous sibling.
        if (!prev && this.#isGuard(startContainer.parentNode)) {
          prev = startContainer.parentNode.previousSibling;
        }
        if (prev?.classList?.contains("variable-pill")) return prev;
      }
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
    if (startContainer.nodeType === Node.TEXT_NODE) {
      // "Effectively at end" when every char after the offset is ZWS.
      const after = startContainer.textContent.slice(startOffset);
      if (after.replace(/\u200B/g, "") === "") {
        let next = startContainer.nextSibling;
        // Inside a guard span the pill is the guard's own next sibling.
        if (!next && this.#isGuard(startContainer.parentNode)) {
          next = startContainer.parentNode.nextSibling;
        }
        if (next?.classList?.contains("variable-pill")) return next;
      }
    }
    return null;
  }

  // ── Logical position model ─────────────────────────────────────────────────
  //
  // The editor content is modelled as a flat sequence of "logical characters"
  // where every non-ZWS text character counts as 1 and every pill counts as 1.
  // ZWS guard characters (\u200B) count as 0.
  //
  // #domToLogical maps a DOM position to a logical index, #logicalToDom maps
  // back.  Together they let arrow-key navigation, selection extension, Home /
  // End, and post-mouse normalisation operate on a clean abstraction that
  // automatically hides ZWS padding and pill boundaries.

  /** True when `node` is a text node containing nothing but zero-width spaces. */
  #isZwsOnly(node) {
    return (
      node.nodeType === Node.TEXT_NODE &&
      node.textContent.replace(/\u200B/g, "") === ""
    );
  }

  /** Total logical characters in the editor (non-ZWS text + 1 per pill). */
  #logicalLength() {
    let len = 0;
    for (const child of this.#el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        for (const ch of child.textContent) {
          if (ch !== "\u200B") len++;
        }
      } else if (child.classList?.contains("variable-pill")) {
        len++;
      }
    }
    return len;
  }

  /** Map a DOM position (node + offset) to a zero-based logical index. */
  #domToLogical(targetNode, targetOffset) {
    if (!targetNode || !this.#el.contains(targetNode)) return 0;

    // Position at editor element level — count complete children up to offset.
    if (targetNode === this.#el) {
      let logical = 0;
      const limit = Math.min(targetOffset, this.#el.childNodes.length);
      for (let i = 0; i < limit; i++) {
        const child = this.#el.childNodes[i];
        if (child.nodeType === Node.TEXT_NODE) {
          for (const ch of child.textContent) {
            if (ch !== "\u200B") logical++;
          }
        } else if (child.classList?.contains("variable-pill")) {
          logical++;
        }
      }
      return logical;
    }

    // Position inside a child node — walk children until we find the target.
    let logical = 0;
    for (const child of this.#el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (child === targetNode) {
          const text = child.textContent;
          for (let i = 0; i < Math.min(targetOffset, text.length); i++) {
            if (text[i] !== "\u200B") logical++;
          }
          return logical;
        }
        for (const ch of child.textContent) {
          if (ch !== "\u200B") logical++;
        }
      } else if (this.#isGuard(child)) {
        // Guards carry no logical length; a caret inside one sits at this index.
        if (child === targetNode || child.contains(targetNode)) return logical;
      } else if (child.classList?.contains("variable-pill")) {
        if (child === targetNode || child.contains(targetNode)) return logical;
        logical++;
      }
    }
    return logical;
  }

  /**
   * Map a logical index back to a DOM position {node, offset}.
   * The returned offset always lands after any leading ZWS so the caret
   * is placed at a visually meaningful position.
   */
  #logicalToDom(pos) {
    let remaining = Math.max(0, pos);

    for (const child of this.#el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent;
        for (let i = 0; i < text.length; i++) {
          if (text[i] !== "\u200B") {
            if (remaining === 0) return { node: child, offset: i };
            remaining--;
          }
        }
        // Exhausted this node — if remaining is 0, position at its end.
        if (remaining === 0) return { node: child, offset: text.length };
      } else if (this.#isGuard(child)) {
        // A guard span is the caret anchor beside a pill: placing the caret
        // inside it (after its ZWS) paints right at the pill edge with nothing
        // visible. It carries no logical length.
        if (remaining === 0) return this.#caretInGuard(child);
      } else if (child.classList?.contains("variable-pill")) {
        if (remaining === 0) {
          // "Before this pill" — prefer a guard/text anchor on its left.
          const prev = child.previousSibling;
          if (this.#isGuard(prev)) return this.#caretInGuard(prev);
          if (prev?.nodeType === Node.TEXT_NODE) {
            return { node: prev, offset: prev.textContent.length };
          }
          const idx = [...this.#el.childNodes].indexOf(child);
          return { node: this.#el, offset: idx };
        }
        remaining--;
      }
    }

    // Past the end — land inside a trailing guard, or at the end of the last
    // text node.
    const last = this.#el.lastChild;
    if (this.#isGuard(last)) return this.#caretInGuard(last);
    if (last?.nodeType === Node.TEXT_NODE) {
      return { node: last, offset: last.textContent.length };
    }
    return { node: this.#el, offset: this.#el.childNodes.length };
  }

  /** DOM caret position just after a guard span's zero-width space. */
  #caretInGuard(guard) {
    const t = guard.firstChild;
    if (t?.nodeType === Node.TEXT_NODE) {
      return { node: t, offset: t.textContent.length };
    }
    // Defensive: a guard should always hold a ZWS text node.
    const idx = [...this.#el.childNodes].indexOf(guard);
    return { node: this.#el, offset: idx + 1 };
  }

  /** Collapse the selection to a single caret at the given DOM position. */
  #setCollapsedCaret(node, offset) {
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /**
   * After a mouse interaction (click or drag), snap the caret / selection
   * endpoints out of ZWS-only guard nodes onto real content positions.
   * Uses the logical model so the normalisation is always consistent with
   * keyboard navigation.
   */
  #normalizeAfterMouse() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    if (!this.#el.contains(sel.anchorNode)) return;

    const anchorLog = this.#domToLogical(sel.anchorNode, sel.anchorOffset);
    const focusLog = this.#domToLogical(sel.focusNode, sel.focusOffset);
    const anchorDOM = this.#logicalToDom(anchorLog);
    const focusDOM = this.#logicalToDom(focusLog);

    if (sel.isCollapsed) {
      if (
        focusDOM.node !== sel.focusNode ||
        focusDOM.offset !== sel.focusOffset
      ) {
        this.#setCollapsedCaret(focusDOM.node, focusDOM.offset);
      }
    } else {
      if (
        anchorDOM.node !== sel.anchorNode ||
        anchorDOM.offset !== sel.anchorOffset ||
        focusDOM.node !== sel.focusNode ||
        focusDOM.offset !== sel.focusOffset
      ) {
        sel.setBaseAndExtent(
          anchorDOM.node,
          anchorDOM.offset,
          focusDOM.node,
          focusDOM.offset,
        );
      }
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  // ── Pill context menu ─────────────────────────────────────────────────────

  async #showPillContextMenu(x, y, onEdit, onDelete) {
    const clicked = await window.wurl.ui.contextMenu.show({
      items: [
        { id: "edit", label: t("menu.edit") },
        { id: "delete", label: t("menu.delete") },
      ],
      x,
      y,
    });
    if (clicked === "edit") onEdit();
    if (clicked === "delete") onDelete();
  }

  #emitChange() {
    const val = serializeEditor(this.#el);
    this.#lastValue = val;
    this.#syncEmpty();
    this.#onInput?.(val);
    this.#scheduleHistory();
  }

  // ── Undo / redo ────────────────────────────────────────────────────────────

  #scheduleHistory() {
    if (this.#histPaused) return;
    clearTimeout(this.#histTimer);
    this.#histTimer = setTimeout(() => {
      this.#histTimer = null;
      this.#commitHistory();
    }, 500);
  }

  #commitHistory() {
    clearTimeout(this.#histTimer);
    this.#histTimer = null;
    if (this.#histPaused) return;
    const val = serializeEditor(this.#el);
    if (val === this.#history[this.#histIdx]) return;
    this.#history = this.#history.slice(0, this.#histIdx + 1);
    this.#history.push(val);
    if (this.#history.length > 200) this.#history.shift();
    else this.#histIdx++;
  }

  #undo() {
    this.#commitHistory(); // flush any in-flight debounce first
    if (this.#histIdx <= 0) return;
    this.#histIdx--;
    this.#applyHistory();
  }

  #redo() {
    if (this.#histIdx >= this.#history.length - 1) return;
    this.#histIdx++;
    this.#applyHistory();
  }

  #applyHistory() {
    const val = this.#history[this.#histIdx];
    if (val === undefined) return;
    const caretPos = _histDiffCursor(this.#lastValue, val);
    this.#histPaused = true;
    this.#lastValue = val;
    this.#renderFromText(val);
    this.#syncEmpty();
    this.#histPaused = false;
    this.#onInput?.(val);
    if (this.#isFocused) this.#placeCaret(caretPos);
  }

  /**
   * Place the caret at `offset` characters into the serialized editor value.
   * Walks child nodes, counting non-ZWS text chars and pill token lengths,
   * until the target position is consumed.
   */
  #placeCaret(offset) {
    const sel = window.getSelection();
    if (!sel) return;

    let rem = Math.max(0, offset);

    for (const node of this.#el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        const raw = node.textContent;
        const text = raw.replace(/\u200B/g, "");
        if (rem <= text.length) {
          // Advance rawIdx past exactly `rem` non-ZWS characters
          let rawIdx = 0,
            count = 0;
          while (count < rem && rawIdx < raw.length) {
            if (raw[rawIdx] !== "\u200B") count++;
            rawIdx++;
          }
          const range = document.createRange();
          range.setStart(node, rawIdx);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
          return;
        }
        rem -= text.length;
      } else if (node.classList?.contains("variable-pill")) {
        const serialized =
          node.dataset.function !== undefined
            ? buildFunctionToken(
                node.dataset.function,
                JSON.parse(node.dataset.fnArgs ?? "[]"),
              )
            : `{{${node.dataset.variable}}}`;
        if (rem < serialized.length) {
          // Cursor lands inside a pill (atomic) — snap to just after it, landing
          // in the trailing guard span when one follows so the caret paints.
          const after = node.nextSibling;
          const range = document.createRange();
          if (this.#isGuard(after)) {
            const pos = this.#caretInGuard(after);
            range.setStart(pos.node, pos.offset);
          } else if (after?.nodeType === Node.TEXT_NODE) {
            range.setStart(after, 0);
          } else {
            range.setStartAfter(node);
          }
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
          return;
        }
        rem -= serialized.length;
      }
    }

    // Fallback: end of last child
    const last = this.#el.lastChild;
    if (last) {
      const range = document.createRange();
      if (this.#isGuard(last)) {
        const pos = this.#caretInGuard(last);
        range.setStart(pos.node, pos.offset);
      } else if (last.nodeType === Node.TEXT_NODE) {
        range.setStart(last, last.textContent.length);
      } else {
        range.setStartAfter(last);
      }
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  #syncEmpty() {
    const text = this.#el.textContent.replace(/\u200B/g, "");
    const hasText = text.trim() !== "";
    const hasPills = this.#el.querySelector(".variable-pill") !== null;
    this.#el.dataset.empty = String(!hasText && !hasPills);
  }

  /** True for any child that isn't part of the canonical text-node/pill model. */
  #isForeignNode(node) {
    return (
      node.nodeType === Node.ELEMENT_NODE &&
      !node.classList.contains("variable-pill") &&
      !node.classList.contains("pill-guard")
    );
  }

  /**
   * Native contenteditable editing can inject non-canonical nodes: Chromium
   * drops a filler `<br>` into an emptied field and occasionally wraps content
   * in a `<div>`.  Left in place, #ensureEdgePadding treats each as atomic
   * content and wraps it in caret-anchor guards — and in a masked secret field
   * (`-webkit-text-security: disc`) a stray `<br>` renders as a spurious line
   * break.  That is the "new line plus dots" artefact seen when clearing a
   * secret.
   *
   * When such nodes are present, rebuild the canonical flat model — text nodes,
   * `.variable-pill` spans, and `.pill-guard` anchors only — preserving the
   * caret through the logical index, and re-pad.  Returns true when it acted
   * (padding already done), false when there was nothing to clean so the caller
   * can pad normally.
   */
  #sanitizeArtifacts() {
    if (![...this.#el.childNodes].some((n) => this.#isForeignNode(n))) {
      return false;
    }

    // Capture the selection in the logical model before mutating the DOM.
    const sel = window.getSelection();
    const tracking =
      sel && sel.rangeCount > 0 && this.#el.contains(sel.anchorNode);
    const anchorLog = tracking
      ? this.#domToLogical(sel.anchorNode, sel.anchorOffset)
      : 0;
    const focusLog = tracking
      ? this.#domToLogical(sel.focusNode, sel.focusOffset)
      : 0;

    // 1. Drop <br> fillers; unwrap any other foreign element in place so a
    //    wrapped pill survives.  Re-scan until a clean pass, since unwrapping
    //    can surface nodes that were a level deeper.
    let mutated = true;
    while (mutated) {
      mutated = false;
      for (const child of [...this.#el.childNodes]) {
        if (!this.#isForeignNode(child)) continue;
        if (child.tagName !== "BR") {
          while (child.firstChild) {
            this.#el.insertBefore(child.firstChild, child);
          }
        }
        child.remove();
        mutated = true;
      }
    }

    // 2. Strip every ZWS guard, then let #ensureEdgePadding re-add only the
    //    ones pills need.  normalize() discards the now-empty text nodes the
    //    strip leaves behind and merges adjacent runs.
    for (const child of this.#el.childNodes) {
      if (
        child.nodeType === Node.TEXT_NODE &&
        child.textContent.includes("\u200B")
      ) {
        child.textContent = child.textContent.replace(/\u200B/g, "");
      }
    }
    this.#el.normalize();
    this.#ensureEdgePadding();

    // 3. Restore the caret to the same logical position.
    if (tracking) {
      const a = this.#logicalToDom(anchorLog);
      const f = this.#logicalToDom(focusLog);
      const range = document.createRange();
      range.setStart(a.node, a.offset);
      range.setEnd(f.node, f.offset);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    return true;
  }

  /** True for a `.variable-pill` span (atomic variable/function chip). */
  #isPill(node) {
    return (
      node?.nodeType === Node.ELEMENT_NODE &&
      node.classList.contains("variable-pill")
    );
  }

  /** True for a `.pill-guard` caret-anchor span (see #ensureEdgePadding). */
  #isGuard(node) {
    return (
      node?.nodeType === Node.ELEMENT_NODE &&
      node.classList.contains("pill-guard")
    );
  }

  /**
   * A mask-exempt caret-anchor: a `<span class="pill-guard">` holding a single
   * zero-width space.  Because the span carries no real caret text and is
   * exempted from `-webkit-text-security` (see components.css), a Range placed
   * inside it paints the caret right at the pill edge with nothing visible —
   * unlike a bare ZWS (which masks to a stray disc) or an empty text node
   * (which has no geometry, so the caret can't paint after a trailing pill).
   */
  #makeGuard() {
    const span = document.createElement("span");
    span.className = "pill-guard";
    span.textContent = "\u200B";
    return span;
  }

  /**
   * Move any non-ZWS text that landed inside a guard span back out into a bare
   * text node, so it is masked like every other secret character.
   *
   * Guard spans are editable, so when the caret sits inside one (after arrowing
   * past a trailing pill, say) a typed or pasted character is inserted into the
   * span — which is mask-exempt, hence visible.  Running this from
   * #ensureEdgePadding (before the change is serialised or painted) keeps the
   * exposure within the same input handler, so no unmasked character is ever
   * shown.  It is a no-op whenever every guard still holds only its ZWS.
   */
  #exfiltrateGuards() {
    const sel = window.getSelection();
    for (const g of this.#el.querySelectorAll(".pill-guard")) {
      const extra = g.textContent.replace(/\u200B/g, "");
      if (!extra) continue;
      const t = document.createTextNode(extra);
      g.after(t);
      g.textContent = "\u200B";
      if (sel) this.#setCollapsedCaret(t, t.textContent.length);
    }
  }

  /**
   * Guarantee a placeable, paint-able caret position beside every pill.
   *
   * Each pill is atomic, so the caret can only rest in a node adjacent to it.
   * Real text on a side already provides that anchor; where a pill instead sits
   * at an edge of the field or directly against another pill, we insert a
   * `.pill-guard` span (see #makeGuard) to stand in.  Empty bare text nodes that
   * end up flush against a pill are dropped — an empty text node has no geometry,
   * so the browser cannot paint the caret there (it strands visibly at the pill's
   * left edge), which is exactly the bug the guard spans fix.
   */
  #ensureEdgePadding() {
    // Pull any secret characters back out of mask-exempt guards first.
    this.#exfiltrateGuards();

    if (!this.#el.firstChild) {
      this.#el.appendChild(document.createTextNode(""));
      return;
    }

    // Remember a collapsed caret so it can be restored if a mutation below
    // removes the node it sits in (e.g. deleting the last character flush
    // against a pill drops the now-empty text node it lived in).
    const sel = window.getSelection();
    const trackCaret =
      sel &&
      sel.rangeCount > 0 &&
      sel.isCollapsed &&
      this.#el.contains(sel.anchorNode);
    const caretLog = trackCaret
      ? this.#domToLogical(sel.anchorNode, sel.anchorOffset)
      : 0;

    // Drop empty bare text nodes flush against a pill — they offer no paintable
    // caret box; a guard span replaces them below.
    for (const n of [...this.#el.childNodes]) {
      if (
        n.nodeType === Node.TEXT_NODE &&
        n.textContent.replace(/\u200B/g, "") === "" &&
        (this.#isPill(n.previousSibling) || this.#isPill(n.nextSibling))
      ) {
        n.remove();
      }
    }

    // A pill at either edge needs a guard on its outer side …
    if (this.#isPill(this.#el.firstChild)) {
      this.#el.insertBefore(this.#makeGuard(), this.#el.firstChild);
    }
    if (this.#isPill(this.#el.lastChild)) {
      this.#el.appendChild(this.#makeGuard());
    }

    // … and any two adjacent pills need one between them.
    let node = this.#el.firstChild;
    while (node && node.nextSibling) {
      const next = node.nextSibling;
      if (this.#isPill(node) && this.#isPill(next)) {
        this.#el.insertBefore(this.#makeGuard(), next);
        node = next;
      } else {
        node = next;
      }
    }

    // Remove redundant guards: any touching no pill, or whose outer side already
    // has real text to anchor the caret.
    for (const g of [...this.#el.querySelectorAll(".pill-guard")]) {
      const prevPill = this.#isPill(g.previousSibling);
      const nextPill = this.#isPill(g.nextSibling);
      if (!prevPill && !nextPill) {
        g.remove();
        continue;
      }
      const outer = prevPill ? g.nextSibling : g.previousSibling;
      if (
        outer &&
        outer.nodeType === Node.TEXT_NODE &&
        outer.textContent.replace(/\u200B/g, "") !== ""
      ) {
        g.remove();
      }
    }

    if (!this.#el.firstChild) this.#el.appendChild(document.createTextNode(""));

    // If a removal above orphaned the caret, restore it to the same logical
    // spot (which now routes into the adjacent guard so it paints).
    if (trackCaret && !this.#el.contains(sel.anchorNode)) {
      const pos = this.#logicalToDom(caretLog);
      this.#setCollapsedCaret(pos.node, pos.offset);
    }
  }
}
