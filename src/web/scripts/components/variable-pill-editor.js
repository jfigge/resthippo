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
 *     getContext:  () => ({ envVariables: {…}, folderChain: […] }),
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
  collectScopes,
} from "./variable-resolver.js";
import { PillEditorPopup } from "./pill-editor-popup.js";
import { PillPicker } from "./pill-picker.js";
import { registry } from "./function-registry.js";
import { logicMap } from "./function-logic-map.js";

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

export class VariablePillEditor {
  #el;
  #placeholder;
  #onInput;
  #onEnter;
  #getContext;
  #getItems;
  #ensureResponseCaches;
  #lastValue = "\x00"; // sentinel forces first setValue to always render
  #pickerTimer = null;
  #pickerInst = null;
  #pickerOutsideHandler = null;

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
  } = {}) {
    this.#placeholder = placeholder;
    this.#onInput = onInput ?? null;
    this.#onEnter = onEnter ?? null;
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
      this.#closePicker();
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
    if (this.#pickerTimer) {
      clearTimeout(this.#pickerTimer);
      this.#pickerTimer = null;
    }
    this.#closePicker();
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
      this.#closePicker();
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

    const caretNode = pill.nextSibling;
    if (caretNode?.nodeType === Node.TEXT_NODE) {
      const nr = document.createRange();
      nr.setStart(caretNode, 0);
      nr.collapse(true);
      sel.removeAllRanges();
      sel.addRange(nr);
    }

    this.#closePicker();
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
    const span = document.createElement("span");
    span.contentEditable = "false";
    span.dataset.variable = name;
    span.textContent = name;
    span.title = `{{${name}}}`;
    const { found } = resolveVariable(name, ctx);
    span.className = [
      "variable-pill",
      found ? "variable-pill--known" : "variable-pill--unknown",
    ].join(" ");

    span.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      PillEditorPopup.open({
        type: "variable",
        rawValue: `{{${span.dataset.variable}}}`,
        getContext: this.#getContext,
        onCommit: (newRaw) => {
          const match = /^\{\{([^{}]+)\}\}$/.exec(newRaw);
          if (!match) return;
          const newName = match[1];
          span.dataset.variable = newName;
          span.textContent = newName;
          span.title = `{{${newName}}}`;
          const { found: f } = resolveVariable(newName, this.#getContext());
          span.classList.toggle("variable-pill--known", f);
          span.classList.toggle("variable-pill--unknown", !f);
          this.#emitChange();
        },
      });
    });

    span.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.#showPillContextMenu(
        e.clientX,
        e.clientY,
        () =>
          PillEditorPopup.open({
            type: "variable",
            rawValue: `{{${span.dataset.variable}}}`,
            getContext: this.#getContext,
            onCommit: (newRaw) => {
              const match = /^\{\{([^{}]+)\}\}$/.exec(newRaw);
              if (!match) return;
              const newName = match[1];
              span.dataset.variable = newName;
              span.textContent = newName;
              span.title = `{{${newName}}}`;
              const { found: f } = resolveVariable(newName, this.#getContext());
              span.classList.toggle("variable-pill--known", f);
              span.classList.toggle("variable-pill--unknown", !f);
              this.#emitChange();
            },
          }),
        () => {
          span.remove();
          this.#emitChange();
        },
      );
    });

    return span;
  }

  #makeFunctionPill(name, rawArgs) {
    const funcDef = registry[name];
    const rawToken = buildFunctionToken(name, rawArgs);

    const span = document.createElement("span");
    span.contentEditable = "false";
    span.dataset.function = name;
    span.dataset.fnArgs = JSON.stringify(rawArgs);
    span.textContent = funcDef?.label ?? name;
    span.title = rawToken;
    span.className = "variable-pill function-pill";

    span.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const currentArgs = JSON.parse(span.dataset.fnArgs ?? "[]");
      PillEditorPopup.open({
        type: "function",
        funcName: span.dataset.function,
        funcDef: registry[span.dataset.function],
        rawArgs: currentArgs,
        getContext: this.#getContext,
        getItems: this.#getItems,
        getPreview: async (args) => {
          const fn = logicMap[span.dataset.function];
          if (!fn) return null;
          const fnName = span.dataset.function;
          if (
            this.#ensureResponseCaches &&
            (fnName === "response" ||
              fnName === "responseHeader" ||
              fnName === "responseStatus")
          ) {
            const name = args[0];
            if (name) await this.#ensureResponseCaches([name]);
          }
          return String(await fn(args, this.#getContext()));
        },
        onCommit: (newRawToken) => {
          const m = /^\{\{([^{}]+)\}\}$/.exec(newRawToken);
          if (!m) return;
          const parsed = parseFunctionCall(m[1]);
          if (!parsed) return;
          span.dataset.fnArgs = JSON.stringify(parsed.rawArgs);
          span.title = newRawToken;
          this.#emitChange();
        },
      });
    });

    span.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.#showPillContextMenu(
        e.clientX,
        e.clientY,
        () => {
          const currentArgs = JSON.parse(span.dataset.fnArgs ?? "[]");
          PillEditorPopup.open({
            type: "function",
            funcName: span.dataset.function,
            funcDef: registry[span.dataset.function],
            rawArgs: currentArgs,
            getContext: this.#getContext,
            getItems: this.#getItems,
            getPreview: async (args) => {
              const fn = logicMap[span.dataset.function];
              if (!fn) return null;
              const fnName = span.dataset.function;
              if (
                this.#ensureResponseCaches &&
                (fnName === "response" ||
                  fnName === "responseHeader" ||
                  fnName === "responseStatus")
              ) {
                const name = args[0];
                if (name) await this.#ensureResponseCaches([name]);
              }
              return String(await fn(args, this.#getContext()));
            },
            onCommit: (newRawToken) => {
              const m = /^\{\{([^{}]+)\}\}$/.exec(newRawToken);
              if (!m) return;
              const parsed = parseFunctionCall(m[1]);
              if (!parsed) return;
              span.dataset.fnArgs = JSON.stringify(parsed.rawArgs);
              span.title = newRawToken;
              this.#emitChange();
            },
          });
        },
        () => {
          span.remove();
          this.#emitChange();
        },
      );
    });

    return span;
  }

  #scanAndConvertAll() {
    const ctx = this.#getContext();
    const VAR_RE = /\{\{([^{}]+)\}\}/g;

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
    this.#schedulePicker();
  }

  // ── Picker ────────────────────────────────────────────────────────────────

  #schedulePicker() {
    if (this.#pickerTimer !== null) clearTimeout(this.#pickerTimer);

    const filter = this.#getPickerFilter();
    if (filter === null) {
      this.#closePicker();
      return;
    }

    // Picker already open — update its filter immediately
    if (this.#pickerInst) {
      this.#pickerInst.updateFilter(
        filter,
        this.#getPickerVariables(),
        this.#getPickerFunctions(),
      );
      return;
    }

    this.#pickerTimer = setTimeout(() => {
      this.#pickerTimer = null;
      const f = this.#getPickerFilter();
      if (f === null) return;
      const rect = this.#getCaretRect();
      if (!rect) return;
      this.#openPicker(f, rect);
    }, _pickerDebounceMs);
  }

  #getPickerFilter() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!range.collapsed) return null;
    const { startContainer, startOffset } = range;
    if (startContainer.nodeType !== Node.TEXT_NODE) return null;
    if (!this.#el.contains(startContainer)) return null;

    const before = startContainer.textContent.slice(0, startOffset);
    const openIdx = before.lastIndexOf("{{");
    if (openIdx === -1) return null;
    const between = before.slice(openIdx + 2);
    if (between.includes("}}")) return null;
    return between;
  }

  #getCaretRect() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const r = sel.getRangeAt(0).cloneRange();
    r.collapse(true);
    const rects = r.getClientRects();
    if (rects.length) return { x: rects[0].left, y: rects[0].bottom };
    const er = this.#el.getBoundingClientRect();
    return { x: er.left, y: er.bottom };
  }

  #openPicker(filter, rect) {
    this.#closePicker();

    this.#pickerInst = new PillPicker({
      x: rect.x,
      y: rect.y,
      filter,
      variables: this.#getPickerVariables(),
      functions: this.#getPickerFunctions(),
      onSelect: (item) => this.insertToken(item.rawToken),
      onClose: () => this.#closePicker(),
    });
    document.body.appendChild(this.#pickerInst.element);
    window.dispatchEvent(new CustomEvent("wurl:popup-opened"));

    this.#pickerOutsideHandler = (e) => {
      if (
        !this.#pickerInst?.element.contains(e.target) &&
        e.target !== this.#el &&
        !this.#el.contains(e.target)
      ) {
        this.#closePicker();
      }
    };
    document.addEventListener("mousedown", this.#pickerOutsideHandler, {
      capture: true,
    });
  }

  #closePicker() {
    if (this.#pickerTimer !== null) {
      clearTimeout(this.#pickerTimer);
      this.#pickerTimer = null;
    }
    const wasOpen = !!this.#pickerInst;
    if (this.#pickerInst) {
      this.#pickerInst.destroy();
      this.#pickerInst = null;
    }
    if (this.#pickerOutsideHandler) {
      document.removeEventListener("mousedown", this.#pickerOutsideHandler, {
        capture: true,
      });
      this.#pickerOutsideHandler = null;
    }
    if (wasOpen) window.dispatchEvent(new CustomEvent("wurl:popup-closed"));
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
      const child = focusNode.childNodes[focusOffset];
      const rect = child
        ? child.getBoundingClientRect()
        : focusNode.getBoundingClientRect();
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

  #getPickerVariables() {
    const ctx = this.#getContext();
    // collectScopes() is the single source of truth for which context keys are
    // scopes and their resolution priority; here we render them lowest-priority
    // first (the reverse) with picker-specific labels.
    const bySource = { global: null, environment: null, collection: null };
    const folderNames = new Set();
    for (const { source, vars } of collectScopes(ctx)) {
      if (source === "folder") {
        for (const name of Object.keys(vars)) folderNames.add(name);
      } else {
        bySource[source] = vars;
      }
    }

    const labels = {
      global: "Global",
      environment: ctx?.activeEnvironmentName || "Environment",
      collection: ctx?.envName || "Collection",
    };

    const scopes = [];
    // Non-folder scopes, lowest priority first: global → environment → collection.
    for (const source of ["global", "environment", "collection"]) {
      const vars = bySource[source];
      if (!vars) continue;
      const names = Object.keys(vars).sort();
      if (names.length)
        scopes.push({ label: labels[source], variables: names });
    }

    // Folder chain — child folders override their parents, so when several
    // folders in the chain define the same name only the innermost is ever
    // reachable. Present the reachable set as a single "Folders" list of unique
    // names rather than one subsection per folder (which would surface
    // superseded, unselectable duplicates).
    if (folderNames.size)
      scopes.push({ label: "Folders", variables: [...folderNames].sort() });

    return scopes;
  }

  #getPickerFunctions() {
    return Object.entries(registry).map(([name, funcDef]) => ({
      name,
      funcDef,
    }));
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

    const caretNode = pill.nextSibling;
    if (caretNode && caretNode.nodeType === Node.TEXT_NODE) {
      const newRange = document.createRange();
      newRange.setStart(caretNode, 0);
      newRange.collapse(true);
      sel.removeAllRanges();
      sel.addRange(newRange);
    }
  }

  // ── Key handling ──────────────────────────────────────────────────────────

  #onKeyDown(e) {
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      if (e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        this.#closePicker();
        this.#undo();
        return;
      }
      if (e.key === "y" || (e.key === "z" && e.shiftKey)) {
        e.preventDefault();
        this.#redo();
        return;
      }
    }

    if (this.#pickerInst) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        this.#pickerInst.selectNext();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        this.#pickerInst.selectPrev();
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        const item = this.#pickerInst.getSelected();
        if (item) this.insertToken(item.rawToken);
        else this.#closePicker();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        this.#closePicker();
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
        const prev = startContainer.previousSibling;
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
        const next = startContainer.nextSibling;
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
      } else if (child.classList?.contains("variable-pill")) {
        if (remaining === 0) {
          // "Before this pill" — land at the end of the preceding text node.
          const prev = child.previousSibling;
          if (prev?.nodeType === Node.TEXT_NODE) {
            return { node: prev, offset: prev.textContent.length };
          }
          const idx = [...this.#el.childNodes].indexOf(child);
          return { node: this.#el, offset: idx };
        }
        remaining--;
      }
    }

    // Past the end — position at end of the last child.
    const last = this.#el.lastChild;
    if (last?.nodeType === Node.TEXT_NODE) {
      return { node: last, offset: last.textContent.length };
    }
    return { node: this.#el, offset: this.#el.childNodes.length };
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
    const clicked = await window.wurl.ui.contextMenu({
      items: [
        { id: "edit", label: "Edit" },
        { id: "delete", label: "Delete" },
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
          // Cursor lands inside a pill (atomic) — snap to just after it
          const after = node.nextSibling;
          const range = document.createRange();
          if (after?.nodeType === Node.TEXT_NODE) {
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
      if (last.nodeType === Node.TEXT_NODE) {
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
      !node.classList.contains("variable-pill")
    );
  }

  /**
   * Native contenteditable editing can inject non-canonical nodes: Chromium
   * drops a filler `<br>` into an emptied field and occasionally wraps content
   * in a `<div>`.  Left in place, #ensureEdgePadding treats each as atomic
   * content and sandwiches it in zero-width-space guards — and in a masked
   * secret field (`-webkit-text-security: disc`) every such guard renders as a
   * stray disc and every `<br>` as a spurious line break.  That is the "new
   * line plus dots" artefact seen when clearing a secret.
   *
   * When such nodes are present, rebuild the canonical flat model — text nodes
   * and `.variable-pill` spans only — preserving the caret through the logical
   * index, and re-pad.  Returns true when it acted (padding already done),
   * false when there was nothing to clean so the caller can pad normally.
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

  /**
   * Guarantee navigable text nodes at both edges of the editor and between
   * any two consecutive pill spans.
   *
   * Without these guard nodes the browser has no text-node position to place
   * the caret before the first pill or after the last pill, making it
   * impossible to type in those regions.
   *
   * Guard nodes are empty text nodes ("").  An empty text node still gives the
   * browser a placeable caret position adjacent to an atomic pill, but, unlike
   * a zero-width space (U+200B), it has no character to render.  That matters
   * in a masked secret field (`-webkit-text-security: disc`), where Chromium
   * masks *every* character including a U+200B, so a ZWS guard would surface as
   * a stray disc beside the caret.  An empty guard renders nothing in any state.
   */
  #ensureEdgePadding() {
    if (!this.#el.firstChild) {
      this.#el.appendChild(document.createTextNode(""));
      return;
    }

    if (this.#el.firstChild.nodeType !== Node.TEXT_NODE) {
      this.#el.insertBefore(document.createTextNode(""), this.#el.firstChild);
    }

    if (this.#el.lastChild.nodeType !== Node.TEXT_NODE) {
      this.#el.appendChild(document.createTextNode(""));
    }

    let node = this.#el.firstChild;
    while (node && node.nextSibling) {
      const next = node.nextSibling;
      if (
        node.nodeType !== Node.TEXT_NODE &&
        next.nodeType !== Node.TEXT_NODE
      ) {
        this.#el.insertBefore(document.createTextNode(""), next);
      } else {
        node = next;
      }
    }
  }
}
