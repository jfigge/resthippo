/**
 * pill-code-editor.js — multi-line {{pill}} code editor (Option B).
 *
 * A SINGLE `contenteditable` document. Each line is a `<div class="pce-line">`
 * block; `{{variable}}`/function tokens are atomic `contenteditable=false` pill
 * islands inline. Because the whole thing is one editing host, the browser gives
 * us caret movement, selection ACROSS lines, copy and paste for free — the things
 * the earlier per-line composition had to reimplement by hand.
 *
 * On top of the editing host we add: a measured gutter (line numbers + fold
 * carets), wrap, indentation folding, validation, and masking-based syntax
 * highlight. Pill rendering, the `{{` typeahead (PillPicker), click-to-edit
 * (PillEditorPopup) and `{{…}}` serialization are reused from the existing
 * single-line editor's building blocks.
 *
 * Integrated into the request editor (body text, GraphQL Query/Variables, and
 * the WebSocket message composer). `.pce-*` structural CSS lives in
 * src/web/styles/components.css.
 *
 * Highlight = "pill masking": each pill becomes a `0`-run of its token length,
 * the masked document is Prism-highlighted in one pass (multi-line tokens
 * resolve), split back per line, and pills are spliced back over their masked
 * columns. The line holding the caret stays clean (editable); other lines show
 * the highlighted rendering.
 */
"use strict";

import {
  tokenize,
  serializeEditor,
  resolveVariable,
  isFunctionCall,
  parseFunctionCall,
  buildFunctionToken,
  collectScopes,
} from "./variable-resolver.js";
import { PillEditorPopup } from "./pill-editor-popup.js";
import { PillPicker } from "./pill-picker.js";
import { registry } from "./function-registry.js";
import { logicMap } from "./function-logic-map.js";
import Prism from "../vendor/prism.js";
import {
  parse as parseYaml,
  stringify as stringifyYaml,
} from "../vendor/yaml.js";
import {
  parse as parseGraphql,
  print as printGraphql,
} from "../vendor/graphql.js";

const MAX_FOLD_LINES = 5000;
const PICKER_DEBOUNCE_MS = 150;
const UNDO_COALESCE_MS = 400; // consecutive typing within this window = one undo
const UNDO_LIMIT = 200; // max checkpoints kept on the undo stack
const PRISM_LANG = {
  json: "json",
  yaml: "yaml",
  xml: "markup",
  graphql: "graphql",
  text: null,
};
const VALIDATED_LANGS = ["json", "yaml", "xml", "graphql"];

/** Convert a 0-based character offset into 1-based {line, col}. */
function posToLineCol(text, pos) {
  let line = 1;
  let col = 1;
  for (let i = 0; i < pos && i < text.length; i++) {
    if (text[i] === "\n") {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, col };
}

/** Indentation-based fold ranges: opener line index → last child line index. */
function computeFoldEnds(lines) {
  const foldEnd = new Map();
  if (lines.length > MAX_FOLD_LINES) return foldEnd;
  const indent = lines.map((l) =>
    l.trim() === "" ? null : l.length - l.trimStart().length,
  );
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
  return foldEnd;
}

/** Flatten Prism HTML into per-line arrays of {ch, cls}, splitting on newlines. */
function highlightToLineChars(html) {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  const lines = [[]];
  const walk = (node, cls) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent;
        for (let i = 0; i < text.length; i++) {
          if (text[i] === "\n") lines.push([]);
          else lines[lines.length - 1].push({ ch: text[i], cls });
        }
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const next = child.classList?.contains("token") ? child.className : cls;
        walk(child, next);
      }
    }
  };
  walk(tmp, "");
  return lines;
}

export class PillCodeEditor {
  #el; // outer container (.pce)
  #inner; // positioned wrapper (gutter + doc)
  #gutter; // absolute-positioned line-number / fold entries
  #doc; // the single contenteditable
  #language;
  #multiline;
  #wrap;
  #lineNumbers;
  #folding;
  #highlight;
  #validateOn;
  #externalErrors; // host owns validation: internal #runValidate is a no-op
  #richErrors;
  #readonly;
  #markers; // overlay layer for error squiggles
  #errors = []; // last parsed errors: { line, col, length, message }
  #errorRegions = []; // inner-relative hover bands per error: { top, bottom, left, right, title }
  #hoverTitle = ""; // current error title on #inner (re-assigning resets the OS tooltip)
  #getContext;
  #getItems;
  #onInput;
  #onEnter;
  #onCaret; // fired when the caret/selection moves within the document
  #collapsed = new Set(); // source-line indices of collapsed openers
  #pickerInst = null;
  #pickerTimer = null;
  #pickerOutside = null;
  #hlTimer = null;
  #valTimer = null;
  #placeholder;
  #ro = null; // ResizeObserver — re-measures the gutter on mount / relayout

  // ── Undo / redo (snapshot-based) ──────────────────────────────────────────
  // The native contenteditable undo stack is unusable here: highlight repaints
  // and pill conversion rebuild line DOM, which clears/corrupts it. So we keep
  // our own stack of { value, caret } checkpoints. Typing coalesces into one
  // entry within UNDO_COALESCE_MS; structural edits force a boundary.
  #undoStack = []; // past states (most recent last)
  #redoStack = []; // undone states, for redo
  #histValue = ""; // value mirror as of the last recorded checkpoint
  #histCaret = 0; // caret offset as of #histValue
  #histAt = 0; // timestamp of the last record (for coalescing)
  #histBoundary = false; // force a new undo group on the next record
  #applyingHistory = false; // guard so undo/redo restores don't re-record
  #onEditAction; // window "wurl:edit-action" handler (menu-routed undo/redo)

  constructor({
    value = "",
    language = "json",
    multiline = true,
    wrap = false,
    lineNumbers = true,
    folding = true,
    highlight = true,
    validate = true,
    externalErrors = false,
    richErrors = true,
    readonly = false,
    placeholder = "",
    getContext = () => null,
    getItems = () => [],
    onInput,
    onEnter,
    onCaret,
  } = {}) {
    this.#language = language;
    this.#multiline = multiline;
    this.#wrap = wrap;
    this.#readonly = readonly;
    this.#lineNumbers = lineNumbers;
    this.#folding = folding;
    this.#highlight = highlight;
    this.#validateOn = validate;
    this.#externalErrors = externalErrors;
    this.#richErrors = richErrors;
    this.#placeholder = placeholder;
    this.#getContext = getContext;
    this.#getItems = getItems;
    this.#onInput = onInput ?? null;
    this.#onEnter = onEnter ?? null;
    this.#onCaret = onCaret ?? null;

    this.#el = document.createElement("div");
    this.#el.className = "pce";
    this.#inner = document.createElement("div");
    this.#inner.className = "pce-inner";
    this.#gutter = document.createElement("div");
    this.#gutter.className = "pce-gutter";
    this.#doc = document.createElement("div");
    this.#doc.className = "pce-doc";
    this.#doc.spellcheck = false;
    this.#doc.setAttribute("role", "textbox");
    this.#doc.setAttribute("aria-multiline", String(multiline));
    this.#markers = document.createElement("div");
    this.#markers.className = "pce-markers";
    this.#inner.append(this.#gutter, this.#doc, this.#markers);
    this.#el.append(this.#inner);

    this.#doc.addEventListener("beforeinput", (e) => this.#onBeforeInput(e));
    this.#doc.addEventListener("input", () => this.#onInputEvent());
    this.#doc.addEventListener("keydown", (e) => this.#onKeyDown(e));
    this.#doc.addEventListener("copy", (e) => this.#onCopy(e));
    this.#doc.addEventListener("cut", (e) => this.#onCut(e));
    this.#doc.addEventListener("paste", (e) => this.#onPaste(e));
    this.#doc.addEventListener("contextmenu", (e) => this.#showContextMenu(e));
    // Error tooltips: the squiggle strip is too thin to hover reliably, so the
    // message is surfaced via a title on #inner whenever the pointer is over an
    // error's full-height band (see #renderErrorMarkers / #updateErrorHover).
    this.#inner.addEventListener("pointermove", (e) =>
      this.#updateErrorHover(e),
    );
    this.#inner.addEventListener("pointerleave", () => this.#setHoverTitle(""));
    this.#onSelectionChange = () => {
      this.#syncPillSelection();
      if (this.#doc.contains(document.getSelection()?.anchorNode)) {
        this.#scheduleHighlight();
        this.#onCaret?.();
      }
    };
    document.addEventListener("selectionchange", this.#onSelectionChange);

    // offsetTop reads 0 while detached; re-measure the gutter once the control
    // is laid out (mount) and whenever the document reflows (wrap, content).
    // Guarded for non-DOM environments (e.g. the test harness) that lack it.
    if (typeof ResizeObserver !== "undefined") {
      this.#ro = new ResizeObserver(() => this.#syncGutter());
      this.#ro.observe(this.#doc);
    }

    this.#applyReadonly();
    this.#applyModeClasses();
    this.setValue(value);
    this.#histValue = this.getValue(); // initial undo baseline

    // Menu-routed undo/redo: app.js re-dispatches the app Edit menu (and its
    // ⌘Z/⌘⇧Z accelerators) as `wurl:edit-action`; act only when focused here.
    this.#onEditAction = (e) => {
      if (!this.#doc.contains(document.activeElement)) return;
      const action = e.detail?.action;
      if (action === "undo") this.undo();
      else if (action === "redo") this.redo();
    };
    window.addEventListener("wurl:edit-action", this.#onEditAction);
  }

  #onSelectionChange;

  get element() {
    return this.#el;
  }

  destroy() {
    clearTimeout(this.#hlTimer);
    clearTimeout(this.#valTimer);
    this.#closePicker();
    this.#ro?.disconnect();
    document.removeEventListener("selectionchange", this.#onSelectionChange);
    window.removeEventListener("wurl:edit-action", this.#onEditAction);
  }

  // ── Value ↔ lines ─────────────────────────────────────────────────────────
  getValue() {
    return this.#lines()
      .map((l) => serializeEditor(l))
      .join("\n");
  }

  setValue(text) {
    this.#closePicker();
    this.#collapsed.clear();
    let lines = String(text ?? "").split("\n");
    if (!this.#multiline) lines = [lines.join(" ")];
    if (lines.length === 0) lines = [""];
    this.#doc.replaceChildren(...lines.map((l) => this.#buildLine(l)));
    this.#afterStructural({ silent: true });
  }

  focus() {
    this.#doc.focus();
    const first = this.#doc.firstElementChild;
    if (first) this.#caretToRawOffset(first, 0);
  }

  // ── Public view-setting setters ───────────────────────────────────────────
  setLanguage(lang) {
    this.#language = lang;
    // Folding availability is language-dependent (off for plain text), so a
    // language switch must re-derive the fold gutter + mode classes.
    if (!this.#foldingActive()) this.#collapsed.clear();
    this.#applyModeClasses();
    this.#applyFolds();
    this.#repaintHighlight();
    this.#runValidate();
  }
  setWrap(on) {
    this.#wrap = !!on;
    this.#applyModeClasses();
    this.#syncGutter();
  }
  setLineNumbers(on) {
    this.#lineNumbers = !!on;
    this.#applyModeClasses();
    this.#syncGutter();
  }
  setFolding(on) {
    this.#folding = !!on;
    if (!this.#foldingActive()) this.#collapsed.clear();
    this.#applyModeClasses();
    this.#applyFolds();
  }
  setHighlight(on) {
    this.#highlight = !!on;
    if (this.#highlightActive()) this.#repaintHighlight();
    else for (const l of this.#lines()) this.#cleanLine(l);
  }
  setValidate(on) {
    this.#validateOn = !!on;
    if (this.#validateOn) this.#runValidate();
    else this.#emitValidity(null);
  }
  setReadonly(on) {
    this.#readonly = !!on;
    this.#applyReadonly();
    if (this.#readonly) this.#closePicker();
  }
  setRichErrors(on) {
    this.#richErrors = !!on;
    this.#runValidate(); // recompute + (un)render the squiggles
  }
  /** Re-run validation now and re-emit `pce:validity` (e.g. after wiring a
   *  listener, or when the variable context changes). */
  revalidate() {
    this.#runValidate();
  }

  // ── Host-driven validation / autocomplete (externalErrors mode) ───────────
  // When constructed with `externalErrors: true`, the editor does NOT validate
  // itself — the host computes errors (e.g. schema-aware GraphQL validation) and
  // pushes them in via setErrors(); the helpers below give the host the caret
  // position and a range-replace primitive needed to drive an external
  // autocomplete against this contenteditable.

  /** Replace the editor's error squiggles with host-supplied errors. Each error
   *  is { line, col, length, message } with 1-based line/col against getValue().
   *  Honours `richErrors`: a no-op render when rich errors are off. */
  setErrors(errors) {
    this.#errors = this.#richErrors && Array.isArray(errors) ? errors : [];
    this.#renderErrorMarkers();
  }

  /** Global 0-based caret offset within getValue(), or -1 when there is no
   *  collapsed caret inside the document. */
  getCaretOffset() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return -1;
    if (!this.#doc.contains(sel.focusNode)) return -1;
    const caretLine = this.#lineOf(sel.focusNode, sel.focusOffset);
    if (!caretLine) return -1;
    let offset = 0;
    for (const line of this.#lines()) {
      if (line === caretLine)
        return (
          offset + this.#rawBefore(line, sel.focusNode, sel.focusOffset).length
        );
      offset += serializeEditor(line).length + 1; // + newline
    }
    return -1;
  }

  /** Viewport rect of the caret as { left, top, height }, or null when the
   *  caret is not inside the document. */
  caretCoords() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    if (!this.#doc.contains(sel.focusNode)) return null;
    const r = sel.getRangeAt(0).cloneRange();
    r.collapse(true);
    const rects = r.getClientRects();
    const rect = rects.length ? rects[0] : this.#doc.getBoundingClientRect();
    return { left: rect.left, top: rect.top, height: rect.height || 16 };
  }

  /** True while the inline `{{` variable picker is open, so a host autocomplete
   *  can defer the navigation keys to it. */
  isPickerOpen() {
    return !!this.#pickerInst;
  }

  /** Replace the value range [start, end) with `text` (splitting on newlines),
   *  leaving the caret after the inserted text. Offsets are against getValue(). */
  replaceRange(start, end, text) {
    const sel = window.getSelection();
    if (!sel) return;
    const a = this.#globalOffsetToDom(start);
    const b = this.#globalOffsetToDom(end);
    if (!a || !b) return;
    const r = document.createRange();
    r.setStart(a.node, a.offset);
    r.setEnd(b.node, b.offset);
    sel.removeAllRanges();
    sel.addRange(r);
    this.#histBoundary = true; // an autocomplete insertion is its own undo step
    this.#replaceSelection(text); // fires onInput + records via #afterStructural
  }

  /** Map a global character offset within getValue() to a DOM {node, offset}. */
  #globalOffsetToDom(offset) {
    let remaining = offset;
    const lines = this.#lines();
    for (const line of lines) {
      const len = serializeEditor(line).length;
      if (remaining <= len) return this.#domPosAtRawCol(line, remaining);
      remaining -= len + 1; // + newline
    }
    const last = lines.at(-1);
    return last
      ? this.#domPosAtRawCol(last, serializeEditor(last).length)
      : null;
  }

  // ── Undo / redo ───────────────────────────────────────────────────────────
  /** Restore the previous checkpoint (no-op when there's nothing to undo). */
  undo() {
    if (this.#readonly || !this.#undoStack.length) return;
    const cur = { value: this.getValue(), caret: this.getCaretOffset() };
    this.#redoStack.push(cur);
    this.#applySnapshot(this.#undoStack.pop());
  }

  /** Re-apply the last undone checkpoint (no-op when there's nothing to redo). */
  redo() {
    if (this.#readonly || !this.#redoStack.length) return;
    const cur = { value: this.getValue(), caret: this.getCaretOffset() };
    this.#undoStack.push(cur);
    this.#applySnapshot(this.#redoStack.pop());
  }

  get canUndo() {
    return this.#undoStack.length > 0;
  }
  get canRedo() {
    return this.#redoStack.length > 0;
  }

  /**
   * Record a checkpoint of the PRE-edit state onto the undo stack. Called from
   * the edit paths AFTER the value changed; `#histValue` still holds the prior
   * value, so that's what gets pushed. Consecutive edits within
   * UNDO_COALESCE_MS coalesce into one entry unless a boundary was flagged.
   */
  #recordHistory() {
    if (this.#applyingHistory) return;
    const cur = this.getValue();
    if (cur === this.#histValue) return; // no net change
    const now = Date.now();
    const coalesce =
      this.#undoStack.length > 0 &&
      !this.#histBoundary &&
      now - this.#histAt < UNDO_COALESCE_MS;
    if (!coalesce) {
      this.#undoStack.push({ value: this.#histValue, caret: this.#histCaret });
      if (this.#undoStack.length > UNDO_LIMIT) this.#undoStack.shift();
      this.#redoStack.length = 0; // a fresh edit invalidates the redo branch
    }
    this.#histBoundary = false;
    this.#histValue = cur;
    this.#histCaret = this.getCaretOffset();
    this.#histAt = now;
  }

  /** Rebuild the document from a { value, caret } checkpoint without recording. */
  #applySnapshot(snap) {
    this.#applyingHistory = true;
    this.setValue(snap.value); // silent rebuild
    this.#restoreCaret(snap.caret);
    this.#emit(); // surface the restored value to the host (onInput)
    this.#applyingHistory = false;
    this.#histValue = snap.value;
    this.#histCaret = snap.caret;
    this.#histAt = 0; // next edit opens a new group
    this.#histBoundary = true;
  }

  /** Place a collapsed caret at a global character offset (focuses the doc). */
  #restoreCaret(offset) {
    if (offset == null || offset < 0) return;
    const pos = this.#globalOffsetToDom(offset);
    if (!pos) return;
    this.#doc.focus();
    const sel = window.getSelection();
    const r = document.createRange();
    r.setStart(pos.node, pos.offset);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  /** Pretty-format the document for the current (known) language. No-op when
   *  read-only, the language is unknown, or the content can't be parsed. */
  prettify() {
    if (this.#readonly || !VALIDATED_LANGS.includes(this.#language)) return;
    const cur = this.getValue();
    const formatted = this.#prettify(this.#language, cur);
    if (formatted !== cur) {
      this.setValue(formatted); // silent build…
      this.#emit(); // …then surface the reformatted text to the host
      this.#histBoundary = true;
      this.#recordHistory(); // make the reformat a discrete undo step
      this.focus();
    }
  }

  #prettify(lang, text) {
    if (!text.trim()) return text;
    try {
      if (lang === "json") return JSON.stringify(JSON.parse(text), null, 2);
      if (lang === "yaml")
        return stringifyYaml(parseYaml(text)).replace(/\n+$/, "");
      if (lang === "graphql") return printGraphql(parseGraphql(text));
      if (lang === "xml") return this.#prettyXml(text);
    } catch {
      /* invalid — return unchanged */
    }
    return text;
  }

  #prettyXml(text) {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.querySelector("parsererror")) return text;
    const raw = new XMLSerializer()
      .serializeToString(doc)
      .replace(/>\s*</g, ">\n<");
    let indent = 0;
    return raw
      .split("\n")
      .map((line) => {
        const t = line.trim();
        if (!t) return "";
        if (t.startsWith("</")) indent = Math.max(0, indent - 1);
        const out = "  ".repeat(indent) + t;
        if (
          !t.startsWith("</") &&
          !t.startsWith("<?") &&
          !t.endsWith("/>") &&
          !t.includes("</")
        )
          indent++;
        return out;
      })
      .filter((l) => l !== "")
      .join("\n");
  }

  // ── OS context menu (native via the preload bridge) ───────────────────────
  async #showContextMenu(e) {
    e.preventDefault();
    e.stopPropagation(); // pre-empt the app's generic editable-field menu
    const show = window.wurl?.ui?.contextMenu?.edit;
    if (!show) return;
    const ml = this.#multiline;
    // Undo / Redo lead the menu (above the native Cut/Copy/Paste). They drive the
    // editor's OWN snapshot stack, not the native contenteditable one (which our
    // repaints corrupt), so they're custom items, not native roles.
    const leadingItems = this.#readonly
      ? []
      : [
          { id: "undo", label: "Undo", enabled: this.canUndo },
          { id: "redo", label: "Redo", enabled: this.canRedo },
          { type: "separator" },
        ];
    // Editor-specific items appended AFTER the native Cut/Copy/Paste/Select All.
    const items = [{ type: "separator" }];
    // Prettify (+ its own separator) only for formattable languages — sits right
    // after Select All, ahead of the view toggles.
    if (this.#prettifySupported()) {
      // Greyed out when the current content has a syntax error — there's
      // nothing well-formed to reformat.
      items.push({
        id: "prettify",
        label: "Prettify",
        enabled: this.#isValid(),
      });
      items.push({ type: "separator" });
    }
    items.push({
      id: "wrap",
      type: "checkbox",
      checked: this.#wrap,
      label: "Wrap",
    });
    items.push({
      id: "lineNumbers",
      type: "checkbox",
      checked: this.#lineNumbers,
      enabled: ml,
      label: "Line numbers",
    });
    // Code folding + syntax highlighting are meaningless for plain text (no
    // grammar), so they're hidden there (and folding is force-disabled).
    if (this.#hasGrammar()) {
      items.push({
        id: "folding",
        type: "checkbox",
        checked: this.#folding,
        enabled: ml,
        label: "Code folding",
      });
      items.push({
        id: "highlight",
        type: "checkbox",
        checked: this.#highlight,
        enabled: ml,
        label: "Syntax highlighting",
      });
    }
    const id = await show(e.clientX, e.clientY, items, { leadingItems });
    if (id === "undo") this.undo();
    else if (id === "redo") this.redo();
    else if (id === "prettify") this.prettify();
    else if (["wrap", "folding", "lineNumbers", "highlight"].includes(id))
      this.#toggleViewSetting(id);
  }

  /** Whether the current language has a Prism grammar (false for plain text). */
  #hasGrammar() {
    return PRISM_LANG[this.#language] != null;
  }

  /** Whether prettify() can format the current language (and we're editable). */
  #prettifySupported() {
    return !this.#readonly && VALIDATED_LANGS.includes(this.#language);
  }

  /** Whether the current content parses cleanly for a validated language.
   *  Empty or non-validated content counts as valid (nothing to reject). */
  #isValid() {
    const v = this.getValue();
    if (!VALIDATED_LANGS.includes(this.#language) || !v.trim()) return true;
    return this.#parseErrors(this.#language, v).length === 0;
  }

  /**
   * Flip a view setting from the context menu: apply it locally AND emit
   * `pce:setting-change` so the host can persist it as a GLOBAL setting and
   * mirror it across other editor instances.
   */
  #toggleViewSetting(key) {
    const next = !{
      wrap: this.#wrap,
      folding: this.#folding,
      lineNumbers: this.#lineNumbers,
      highlight: this.#highlight,
    }[key];
    ({
      wrap: () => this.setWrap(next),
      folding: () => this.setFolding(next),
      lineNumbers: () => this.setLineNumbers(next),
      highlight: () => this.setHighlight(next),
    })[key]();
    this.#el.dispatchEvent(
      new CustomEvent("pce:setting-change", {
        detail: { key, value: next },
        bubbles: true,
      }),
    );
  }

  /** Make the document non-editable (still selectable / copyable). */
  #applyReadonly() {
    this.#doc.contentEditable = this.#readonly ? "false" : "true";
    this.#doc.setAttribute("aria-readonly", String(this.#readonly));
    this.#el.classList.toggle("pce--readonly", this.#readonly);
  }
  setMultiline(on) {
    const v = this.getValue();
    this.#multiline = !!on;
    this.#doc.setAttribute("aria-multiline", String(this.#multiline));
    this.#applyModeClasses();
    this.setValue(v);
  }

  #foldingActive() {
    // Plain text (no grammar) never folds — the folding menu is hidden there too.
    return this.#multiline && this.#folding && this.#hasGrammar();
  }
  #highlightActive() {
    return this.#multiline && this.#highlight;
  }
  #numbersActive() {
    return this.#multiline && this.#lineNumbers;
  }

  #applyModeClasses() {
    this.#el.classList.toggle("pce--wrap", this.#wrap);
    this.#el.classList.toggle("pce--nums", this.#numbersActive());
    this.#el.classList.toggle("pce--fold", this.#foldingActive());
    this.#el.classList.toggle("pce--single", !this.#multiline);
  }

  // ── Line helpers ──────────────────────────────────────────────────────────
  #lines() {
    return [...this.#doc.children];
  }

  /** Build a `.pce-line` div from a raw `{{…}}` string. */
  #buildLine(raw) {
    const div = document.createElement("div");
    div.className = "pce-line";
    this.#fillLine(div, raw);
    return div;
  }

  /** (Re)render a line's content from raw text — text nodes + pills, no spans. */
  #fillLine(lineEl, raw) {
    lineEl.replaceChildren();
    const ctx = this.#getContext();
    let any = false;
    for (const tk of tokenize(raw)) {
      if (tk.type === "text") {
        if (tk.content) {
          lineEl.appendChild(document.createTextNode(tk.content));
          any = true;
        }
      } else {
        lineEl.appendChild(this.#makeToken(tk.content, ctx));
        any = true;
      }
    }
    if (!any) lineEl.appendChild(document.createElement("br"));
  }

  #makeToken(content, ctx) {
    if (isFunctionCall(content)) {
      const parsed = parseFunctionCall(content);
      if (parsed) return this.#makeFunctionPill(parsed.name, parsed.rawArgs);
    }
    return this.#makePill(content, ctx);
  }

  /** Find the `.pce-line` ancestor (or addressed child) for a DOM node. */
  #lineOf(node, offset = 0) {
    if (node === this.#doc) {
      return this.#doc.children[
        Math.min(offset, this.#doc.children.length - 1)
      ];
    }
    let n = node;
    while (n && n !== this.#doc) {
      if (n.nodeType === Node.ELEMENT_NODE && n.classList?.contains("pce-line"))
        return n;
      n = n.parentNode;
    }
    return null;
  }

  /** Raw text of a line from its start up to a DOM position. */
  #rawBefore(lineEl, node, off) {
    const r = document.createRange();
    r.setStart(lineEl, 0);
    r.setEnd(node, off);
    const tmp = document.createElement("div");
    tmp.appendChild(r.cloneContents());
    return serializeEditor(tmp);
  }

  /** Raw text of a line from a DOM position to its end. */
  #rawAfter(lineEl, node, off) {
    const r = document.createRange();
    r.setStart(node, off);
    r.setEnd(lineEl, lineEl.childNodes.length);
    const tmp = document.createElement("div");
    tmp.appendChild(r.cloneContents());
    return serializeEditor(tmp);
  }

  /**
   * Map a raw column within a line to a DOM position {node, offset}. Recurses
   * through highlight token spans; pills count as their {{…}} raw length and are
   * treated as atomic (caret snaps to a pill boundary).
   */
  #domPosAtRawCol(lineEl, col) {
    let remaining = col;
    let result = null;
    const visit = (parent) => {
      for (const node of parent.childNodes) {
        if (result) return;
        if (node.nodeType === Node.TEXT_NODE) {
          const len = node.textContent.length;
          if (remaining <= len) {
            result = { node, offset: remaining };
            return;
          }
          remaining -= len;
        } else if (node.classList?.contains("variable-pill")) {
          const rawLen = this.#pillRaw(node).length;
          if (remaining < rawLen) {
            const idx = [...node.parentNode.childNodes].indexOf(node);
            result = {
              node: node.parentNode,
              offset: remaining === 0 ? idx : idx + 1,
            };
            return;
          }
          remaining -= rawLen;
        } else if (node.tagName === "BR") {
          result = { node: parent, offset: 0 };
          return;
        } else {
          visit(node); // highlight token span — descend
        }
      }
    };
    visit(lineEl);
    return result ?? { node: lineEl, offset: lineEl.childNodes.length };
  }

  /** Place a collapsed caret at raw column `col` within a line. */
  #caretToRawOffset(lineEl, col) {
    const sel = window.getSelection();
    const { node, offset } = this.#domPosAtRawCol(lineEl, col);
    const r = document.createRange();
    r.setStart(node, offset);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  #pillRaw(pill) {
    return pill.dataset.function !== undefined
      ? buildFunctionToken(
          pill.dataset.function,
          JSON.parse(pill.dataset.fnArgs ?? "[]"),
        )
      : `{{${pill.dataset.variable}}}`;
  }

  // ── Structural editing (one editing host, so this is all we must own) ─────
  #onBeforeInput(e) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const startLine = this.#lineOf(range.startContainer, range.startOffset);
    const endLine = this.#lineOf(range.endContainer, range.endOffset);
    if (!startLine || !endLine) return;
    const t = e.inputType;
    const crossLine = startLine !== endLine;

    // Anything other than continuous typing (delete, newline, paste, format…)
    // starts a fresh undo group rather than coalescing with the prior run.
    if (t !== "insertText" && t !== "insertCompositionText")
      this.#histBoundary = true;

    if (t === "insertParagraph" || t === "insertLineBreak") {
      e.preventDefault();
      if (!this.#multiline) {
        this.#onEnter?.();
        return;
      }
      this.#replaceSelection("\n");
      return;
    }
    if (t === "insertFromPaste" || t === "insertFromDrop") {
      e.preventDefault();
      this.#replaceSelection(e.dataTransfer?.getData("text/plain") ?? "");
      return;
    }
    if (!range.collapsed && crossLine) {
      e.preventDefault();
      this.#replaceSelection(
        t.startsWith("insert") && e.data != null ? e.data : "",
      );
      return;
    }
    if (range.collapsed && t.startsWith("delete")) {
      const backward = /Backward/.test(t);
      const forward = /Forward/.test(t);
      if (
        backward &&
        this.#rawBefore(startLine, range.startContainer, range.startOffset) ===
          "" &&
        startLine.previousElementSibling
      ) {
        e.preventDefault();
        this.#mergeLines(startLine.previousElementSibling, startLine);
      } else if (
        forward &&
        this.#rawAfter(startLine, range.startContainer, range.startOffset) ===
          "" &&
        startLine.nextElementSibling
      ) {
        e.preventDefault();
        this.#mergeLines(startLine, startLine.nextElementSibling);
      }
      // otherwise native delete handles it (incl. deleting a whole pill island)
    }
  }

  /** Replace the current selection (or caret) with raw text, splitting on \n. */
  #replaceSelection(rawInsert) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const startLine = this.#lineOf(range.startContainer, range.startOffset);
    const endLine = this.#lineOf(range.endContainer, range.endOffset);
    if (!startLine || !endLine) return;

    const prefix = this.#rawBefore(
      startLine,
      range.startContainer,
      range.startOffset,
    );
    const suffix = this.#rawAfter(endLine, range.endContainer, range.endOffset);
    const caretRaw = prefix + rawInsert;
    const newRaws = (caretRaw + suffix).split("\n");
    const newLines = newRaws.map((r) => this.#buildLine(r));

    for (const nl of newLines) this.#doc.insertBefore(nl, startLine);
    let n = startLine;
    while (n) {
      const next = n.nextSibling;
      const stop = n === endLine;
      n.remove();
      if (stop) break;
      n = next;
    }

    const caretParts = caretRaw.split("\n");
    const caretLine = newLines[caretParts.length - 1];
    this.#caretToRawOffset(caretLine, caretParts[caretParts.length - 1].length);
    this.#afterStructural();
  }

  #mergeLines(a, b) {
    const aRaw = serializeEditor(a);
    const merged = this.#buildLine(aRaw + serializeEditor(b));
    a.replaceWith(merged);
    b.remove();
    this.#caretToRawOffset(merged, aRaw.length);
    this.#afterStructural();
  }

  #onInputEvent() {
    this.#normalizeDoc();
    this.#convertAtCaret();
    this.#recordHistory(); // checkpoint before #histValue advances in #emit path
    this.#emit();
    this.#syncGutter();
    this.#applyFolds();
    this.#scheduleHighlight();
    this.#scheduleValidate();
    this.#schedulePicker();
  }

  /** Keep the doc as a flat list of `.pce-line` blocks with <br> in empties. */
  #normalizeDoc() {
    if (!this.#doc.firstChild) {
      this.#doc.appendChild(this.#buildLine(""));
      return;
    }
    for (const child of [...this.#doc.childNodes]) {
      if (
        child.nodeType === Node.ELEMENT_NODE &&
        child.classList?.contains("pce-line")
      ) {
        // strip stray <br> from non-empty lines; ensure empties keep one
        const brs = [...child.querySelectorAll("br")];
        const hasContent = serializeEditor(child) !== "";
        if (hasContent) brs.forEach((b) => b.remove());
        else if (brs.length === 0)
          child.appendChild(document.createElement("br"));
        continue;
      }
      // stray node (text or browser-made block) → wrap into a line
      const line = document.createElement("div");
      line.className = "pce-line";
      child.replaceWith(line);
      line.appendChild(child);
      if (serializeEditor(line) === "")
        line.appendChild(document.createElement("br"));
    }
  }

  /** Convert a just-completed {{…}} before the caret into a pill. */
  #convertAtCaret() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!range.collapsed) return;
    const { startContainer, startOffset } = range;
    if (startContainer.nodeType !== Node.TEXT_NODE) return;
    if (!this.#doc.contains(startContainer)) return;
    const before = startContainer.textContent.slice(0, startOffset);
    if (!before.endsWith("}}")) return;
    const openIdx = before.lastIndexOf("{{");
    if (openIdx === -1) return;
    const inner = before.slice(openIdx + 2, before.length - 2).trim();
    if (!inner || /[{}]/.test(inner)) return;

    const ctx = this.#getContext();
    const text = startContainer.textContent;
    const beforeText = text.slice(0, openIdx);
    const afterText = text.slice(startOffset);
    const pill = this.#makeToken(inner, ctx);
    const parent = startContainer.parentNode;
    const afterNode = document.createTextNode(afterText);
    if (beforeText)
      parent.insertBefore(document.createTextNode(beforeText), startContainer);
    parent.insertBefore(pill, startContainer);
    parent.insertBefore(afterNode, startContainer);
    parent.removeChild(startContainer);
    const r = document.createRange();
    r.setStart(afterNode, 0);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    this.#closePicker();
  }

  // ── Keyboard (only the picker + prettify shortcut; the rest is native) ────
  #onKeyDown(e) {
    if (e.code === "KeyF" && e.altKey && e.shiftKey) {
      e.preventDefault();
      this.prettify();
      return;
    }
    if (!this.#pickerInst) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.#pickerInst.selectNext();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this.#pickerInst.selectPrev();
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      const item = this.#pickerInst.getSelected();
      if (item) this.#insertToken(item.rawToken);
      else this.#closePicker();
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.#closePicker();
    }
  }

  // ── Clipboard (serialise pills to {{…}} and keep line breaks) ─────────────
  #rawFromFragment(frag) {
    const divs = [...frag.childNodes].filter(
      (n) => n.nodeType === Node.ELEMENT_NODE && n.tagName === "DIV",
    );
    if (!divs.length) return serializeEditor(frag);
    return divs.map((d) => serializeEditor(d)).join("\n");
  }

  #onCopy(e) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    e.preventDefault();
    e.clipboardData.setData(
      "text/plain",
      this.#rawFromFragment(sel.getRangeAt(0).cloneContents()),
    );
  }

  #onCut(e) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    e.preventDefault();
    const range = sel.getRangeAt(0);
    e.clipboardData.setData(
      "text/plain",
      this.#rawFromFragment(range.cloneContents()),
    );
    if (!range.collapsed) this.#replaceSelection("");
  }

  #onPaste(e) {
    e.preventDefault();
    this.#replaceSelection(e.clipboardData?.getData("text/plain") ?? "");
  }

  // ── Pills (reused from the single-line editor's model) ────────────────────
  #makePill(name, ctx) {
    const span = document.createElement("span");
    span.contentEditable = "false";
    span.dataset.variable = name;
    span.textContent = name;
    span.title = `{{${name}}}`;
    const { found } = resolveVariable(name, ctx);
    span.className =
      "variable-pill " +
      (found ? "variable-pill--known" : "variable-pill--unknown");
    span.addEventListener("click", (e) => {
      if (this.#readonly) return; // selection only; no edit popup
      e.preventDefault();
      e.stopPropagation();
      PillEditorPopup.open({
        type: "variable",
        rawValue: `{{${span.dataset.variable}}}`,
        getContext: this.#getContext,
        onCommit: (raw) => {
          const m = /^\{\{([^{}]+)\}\}$/.exec(raw);
          if (!m) return;
          span.dataset.variable = m[1];
          span.textContent = m[1];
          span.title = raw;
          const { found: f } = resolveVariable(m[1], this.#getContext());
          span.classList.toggle("variable-pill--known", f);
          span.classList.toggle("variable-pill--unknown", !f);
          this.#emit();
          this.#scheduleHighlight();
        },
      });
    });
    return span;
  }

  #makeFunctionPill(name, rawArgs) {
    const funcDef = registry[name];
    const span = document.createElement("span");
    span.contentEditable = "false";
    span.dataset.function = name;
    span.dataset.fnArgs = JSON.stringify(rawArgs);
    span.textContent = funcDef?.label ?? name;
    span.title = buildFunctionToken(name, rawArgs);
    span.className = "variable-pill function-pill";
    span.addEventListener("click", (e) => {
      if (this.#readonly) return; // selection only; no edit popup
      e.preventDefault();
      e.stopPropagation();
      PillEditorPopup.open({
        type: "function",
        funcName: name,
        funcDef: registry[name],
        rawArgs: JSON.parse(span.dataset.fnArgs ?? "[]"),
        getContext: this.#getContext,
        getItems: this.#getItems,
        getPreview: async (args) => {
          const fn = logicMap[name];
          return fn ? String(await fn(args, this.#getContext())) : null;
        },
        onCommit: (raw) => {
          const m = /^\{\{([^{}]+)\}\}$/.exec(raw);
          const parsed = m && parseFunctionCall(m[1]);
          if (!parsed) return;
          span.dataset.fnArgs = JSON.stringify(parsed.rawArgs);
          span.title = raw;
          this.#emit();
          this.#scheduleHighlight();
        },
      });
    });
    return span;
  }

  // ── `{{` typeahead picker ─────────────────────────────────────────────────
  #insertToken(rawToken) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!range.collapsed || range.startContainer.nodeType !== Node.TEXT_NODE)
      return;
    const node = range.startContainer;
    const text = node.textContent;
    const before = text.slice(0, range.startOffset);
    const openIdx = before.lastIndexOf("{{");
    if (openIdx === -1) return;
    const m = /^\{\{([^{}]+)\}\}$/.exec(rawToken);
    if (!m) return this.#closePicker();
    const content = m[1].trim();
    const pill = this.#makeToken(content, this.#getContext());
    const parent = node.parentNode;
    const afterNode = document.createTextNode(text.slice(range.startOffset));
    const beforeText = text.slice(0, openIdx);
    if (beforeText)
      parent.insertBefore(document.createTextNode(beforeText), node);
    parent.insertBefore(pill, node);
    parent.insertBefore(afterNode, node);
    parent.removeChild(node);
    const r = document.createRange();
    r.setStart(afterNode, 0);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    this.#closePicker();
    this.#emit();
    this.#scheduleHighlight();
  }

  #schedulePicker() {
    clearTimeout(this.#pickerTimer);
    const filter = this.#pickerFilter();
    if (filter === null) return this.#closePicker();
    if (this.#pickerInst) {
      this.#pickerInst.updateFilter(
        filter,
        this.#pickerVariables(),
        this.#pickerFunctions(),
      );
      return;
    }
    this.#pickerTimer = setTimeout(() => {
      const f = this.#pickerFilter();
      if (f === null) return;
      const rect = this.#caretRect();
      if (rect) this.#openPicker(f, rect);
    }, PICKER_DEBOUNCE_MS);
  }

  #pickerFilter() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!range.collapsed || range.startContainer.nodeType !== Node.TEXT_NODE)
      return null;
    if (!this.#doc.contains(range.startContainer)) return null;
    const before = range.startContainer.textContent.slice(0, range.startOffset);
    const openIdx = before.lastIndexOf("{{");
    if (openIdx === -1) return null;
    const between = before.slice(openIdx + 2);
    return between.includes("}}") ? null : between;
  }

  #caretRect() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const r = sel.getRangeAt(0).cloneRange();
    r.collapse(true);
    const rects = r.getClientRects();
    if (rects.length) return { x: rects[0].left, y: rects[0].bottom };
    const er = this.#doc.getBoundingClientRect();
    return { x: er.left, y: er.bottom };
  }

  #openPicker(filter, rect) {
    this.#closePicker();
    this.#pickerInst = new PillPicker({
      x: rect.x,
      y: rect.y,
      filter,
      variables: this.#pickerVariables(),
      functions: this.#pickerFunctions(),
      onSelect: (item) => this.#insertToken(item.rawToken),
      onClose: () => this.#closePicker(),
    });
    document.body.appendChild(this.#pickerInst.element);
    this.#pickerOutside = (e) => {
      if (
        !this.#pickerInst?.element.contains(e.target) &&
        !this.#doc.contains(e.target)
      )
        this.#closePicker();
    };
    document.addEventListener("mousedown", this.#pickerOutside, true);
  }

  #closePicker() {
    clearTimeout(this.#pickerTimer);
    this.#pickerTimer = null;
    if (this.#pickerInst) {
      this.#pickerInst.destroy();
      this.#pickerInst = null;
    }
    if (this.#pickerOutside) {
      document.removeEventListener("mousedown", this.#pickerOutside, true);
      this.#pickerOutside = null;
    }
  }

  #pickerVariables() {
    const ctx = this.#getContext();
    const bySource = { global: null, environment: null, collection: null };
    const folderNames = new Set();
    for (const { source, vars } of collectScopes(ctx)) {
      if (source === "folder")
        for (const name of Object.keys(vars)) folderNames.add(name);
      else bySource[source] = vars;
    }
    const labels = {
      global: "Global",
      environment: ctx?.activeEnvironmentName || "Environment",
      collection: ctx?.envName || "Collection",
    };
    const scopes = [];
    for (const source of ["global", "environment", "collection"]) {
      const vars = bySource[source];
      if (!vars) continue;
      const names = Object.keys(vars).sort();
      if (names.length)
        scopes.push({ label: labels[source], variables: names });
    }
    if (folderNames.size)
      scopes.push({ label: "Folders", variables: [...folderNames].sort() });
    return scopes;
  }

  #pickerFunctions() {
    return Object.entries(registry).map(([name, funcDef]) => ({
      name,
      funcDef,
    }));
  }

  /**
   * Treat pills as atomic in a selection: toggle .variable-pill--selected on
   * every pill that falls inside the current range so the WHOLE pill highlights
   * as one unit (paired with the `::selection { transparent }` CSS that hides
   * the native per-character paint inside a pill).
   */
  #syncPillSelection() {
    const sel = window.getSelection();
    const range =
      sel && sel.rangeCount > 0 && !sel.isCollapsed ? sel.getRangeAt(0) : null;
    for (const pill of this.#doc.querySelectorAll(".variable-pill")) {
      let selected = false;
      if (range) {
        try {
          selected =
            range.comparePoint(pill, 0) <= 0 &&
            range.comparePoint(pill, pill.childNodes.length) >= 0;
        } catch {
          selected = false;
        }
      }
      pill.classList.toggle("variable-pill--selected", selected);
    }
  }

  // ── Change plumbing ───────────────────────────────────────────────────────
  // `silent` builds without firing onInput — used by setValue() so a programmatic
  // load doesn't masquerade as a user edit (matches VariablePillEditor.setValue).
  // User edits (replaceSelection / mergeLines) and prettify() emit normally.
  #afterStructural({ silent = false } = {}) {
    this.#normalizeDoc();
    this.#syncEmpty();
    if (!silent) {
      this.#recordHistory(); // checkpoint structural edits (paste, newline, merge…)
      this.#onInput?.(this.getValue());
    }
    this.#syncGutter();
    this.#applyFolds();
    this.#repaintHighlight();
    this.#runValidate();
  }

  /** Reflect the empty/placeholder state on the document (no onInput). */
  #syncEmpty() {
    const empty = this.getValue() === "";
    this.#doc.dataset.empty = empty ? "true" : "false";
    this.#doc.dataset.placeholder = empty ? this.#placeholder : "";
  }

  #emit() {
    this.#syncEmpty();
    this.#onInput?.(this.getValue());
  }

  // ── Gutter (line numbers + fold carets), measured to each line's top ──────
  #syncGutter() {
    const lines = this.#lines();
    const entries = this.#gutter.children;
    while (entries.length > lines.length)
      this.#gutter.removeChild(this.#gutter.lastChild);
    while (entries.length < lines.length) {
      const entry = document.createElement("div");
      entry.className = "pce-gutter-cell";
      const num = document.createElement("span");
      num.className = "pce-num";
      const caret = document.createElement("span");
      caret.className = "pce-fold";
      caret.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.#toggleFoldAt([...this.#gutter.children].indexOf(entry));
      });
      entry.append(num, caret);
      this.#gutter.appendChild(entry);
    }
    lines.forEach((line, i) => {
      const entry = this.#gutter.children[i];
      entry.classList.toggle(
        "pce-gutter-cell--hidden",
        line.classList.contains("pce-line--hidden"),
      );
      entry.style.top = `${line.offsetTop}px`;
      entry.firstChild.textContent = String(i + 1);
    });
    this.#gutter.style.height = `${this.#doc.offsetHeight}px`;
    this.#applyFoldCarets();
    // Reclaim space for any inactive column: indent the doc by the gutter's
    // actual rendered width (0 when both line numbers and folding are off).
    const w = this.#gutter.firstElementChild?.offsetWidth ?? 0;
    this.#gutter.style.width = `${w}px`;
    this.#doc.style.marginLeft = `${w}px`;
    this.#renderErrorMarkers(); // reposition squiggles for the new layout
  }

  // ── Folding ───────────────────────────────────────────────────────────────
  #toggleFoldAt(i) {
    const lines = this.#lines().map((l) => serializeEditor(l));
    if (!computeFoldEnds(lines).has(i)) return;
    if (this.#collapsed.has(i)) this.#collapsed.delete(i);
    else this.#collapsed.add(i);
    this.#applyFolds();
  }

  #applyFolds() {
    const lineEls = this.#lines();
    const lines = lineEls.map((l) => serializeEditor(l));
    const foldEnd = this.#foldingActive() ? computeFoldEnds(lines) : new Map();
    for (const i of [...this.#collapsed])
      if (!foldEnd.has(i)) this.#collapsed.delete(i);
    const hidden = new Set();
    for (const opener of this.#collapsed) {
      const end = foldEnd.get(opener);
      for (let k = opener + 1; k <= end; k++) hidden.add(k);
    }
    lineEls.forEach((line, i) =>
      line.classList.toggle("pce-line--hidden", hidden.has(i)),
    );
    this.#foldEnd = foldEnd;
    this.#syncGutter();
  }

  #foldEnd = new Map();

  #applyFoldCarets() {
    this.#lines().forEach((line, i) => {
      const caret = this.#gutter.children[i]?.querySelector(".pce-fold");
      if (!caret) return;
      const isOpener = this.#foldEnd.has(i);
      caret.classList.toggle("pce-fold--opener", isOpener);
      const collapsed = this.#collapsed.has(i);
      caret.textContent = isOpener ? (collapsed ? "▸" : "▾") : "";
    });
  }

  // ── Syntax highlight (pill masking; caret line stays clean) ───────────────
  #scheduleHighlight() {
    clearTimeout(this.#hlTimer);
    this.#hlTimer = setTimeout(() => this.#repaintHighlight(), 120);
  }

  #activeLines() {
    const sel = window.getSelection();
    const set = new Set();
    if (sel && sel.rangeCount && this.#doc.contains(sel.anchorNode)) {
      const a = this.#lineOf(sel.anchorNode, sel.anchorOffset);
      const f = this.#lineOf(sel.focusNode, sel.focusOffset);
      if (a) set.add(a);
      if (f) set.add(f);
    }
    return set;
  }

  #repaintHighlight() {
    if (!this.#highlightActive()) return;
    // Never rebuild line DOM under a live (non-collapsed) selection — replacing
    // the nodes the selection spans would cancel it mid-drag. Highlight catches
    // up once the selection collapses to a caret (or on the next edit).
    const sel = window.getSelection();
    if (
      sel &&
      sel.rangeCount &&
      !sel.isCollapsed &&
      this.#doc.contains(sel.anchorNode)
    ) {
      return;
    }
    const langName = PRISM_LANG[this.#language];
    const grammar = langName ? Prism.languages[langName] : null;
    const lines = this.#lines();
    if (!grammar) {
      for (const l of lines) this.#cleanLine(l);
      return;
    }
    const active = this.#activeLines();
    const masked = lines.map((line) => {
      let out = "";
      for (const tk of tokenize(serializeEditor(line)))
        out +=
          tk.type === "text"
            ? tk.content
            : "0".repeat(`{{${tk.content}}}`.length);
      return out;
    });
    const lineChars = highlightToLineChars(
      Prism.highlight(masked.join("\n"), grammar, langName),
    );
    lines.forEach((line, i) => {
      if (active.has(line)) this.#cleanLine(line);
      else this.#paintLine(line, lineChars[i] ?? []);
    });
    this.#syncGutter();
  }

  /** Remove highlight spans, restoring a clean editable line (keeps caret). */
  #cleanLine(line) {
    if (!line.dataset.hl) return;
    const caretCol = this.#caretColIn(line);
    this.#fillLine(line, serializeEditor(line));
    delete line.dataset.hl;
    if (caretCol >= 0) this.#caretToRawOffset(line, caretCol);
  }

  #caretColIn(line) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return -1;
    if (!line.contains(sel.focusNode)) return -1;
    return this.#rawBefore(line, sel.focusNode, sel.focusOffset).length;
  }

  /** Repaint a line as highlighted token spans + pills (masking splice). */
  #paintLine(line, lineChars) {
    const value = serializeEditor(line);
    const pills = [...line.querySelectorAll(".variable-pill")];
    const frag = document.createDocumentFragment();
    let col = 0;
    let pillIdx = 0;
    for (const tk of tokenize(value)) {
      if (tk.type === "text") {
        const len = tk.content.length;
        let i = 0;
        while (i < len) {
          const cls = lineChars[col + i]?.cls || "";
          let j = i + 1;
          while (j < len && (lineChars[col + j]?.cls || "") === cls) j++;
          const run = tk.content.slice(i, j);
          if (cls) {
            const span = document.createElement("span");
            span.className = cls;
            span.textContent = run;
            frag.appendChild(span);
          } else {
            frag.appendChild(document.createTextNode(run));
          }
          i = j;
        }
        col += len;
      } else {
        // Move the ORIGINAL pill node (not a clone) so its click handler
        // survives the repaint; cleanLine() rebuilds fresh pills anyway.
        const pill = pills[pillIdx++];
        if (pill) frag.appendChild(pill);
        col += `{{${tk.content}}}`.length;
      }
    }
    if (!frag.childNodes.length) frag.appendChild(document.createElement("br"));
    line.replaceChildren(frag);
    line.dataset.hl = "1";
  }

  // ── Validation ────────────────────────────────────────────────────────────
  #scheduleValidate() {
    clearTimeout(this.#valTimer);
    this.#valTimer = setTimeout(() => this.#runValidate(), 400);
  }

  #runValidate() {
    // Host-driven validation: the owner pushes errors via setErrors().
    if (this.#externalErrors) return;
    const known = VALIDATED_LANGS.includes(this.#language);
    const v = this.getValue();
    if (!this.#validateOn || !known || !v.trim()) {
      this.#emitValidity(null);
      this.#errors = [];
      this.#renderErrorMarkers();
      return;
    }
    const errors = this.#parseErrors(this.#language, v);
    this.#emitValidity(errors.length === 0);
    this.#errors = this.#richErrors ? errors : [];
    this.#renderErrorMarkers();
  }

  /**
   * Parse `text` for the given language and return located errors:
   * { line, col, length, message } (1-based line/col against the raw text).
   * Empty when valid. Parsers stop at the first error, so this is 0 or 1 entry.
   */
  #parseErrors(lang, text) {
    if (lang === "xml") {
      const doc = new DOMParser().parseFromString(text, "application/xml");
      const errEl = doc.querySelector("parsererror");
      return errEl ? [this.#xmlError(errEl.textContent || "")] : [];
    }
    try {
      if (lang === "json") JSON.parse(text);
      else if (lang === "yaml") parseYaml(text);
      else if (lang === "graphql") parseGraphql(text);
      else return [];
      return [];
    } catch (e) {
      return [this.#errorFrom(lang, e, text)];
    }
  }

  #errorFrom(lang, e, text) {
    const message = String(e?.message ?? e).trim();
    if (lang === "yaml" && e?.linePos?.[0]) {
      const a = e.linePos[0];
      const b = e.linePos[1];
      const length = b && b.line === a.line ? Math.max(1, b.col - a.col) : 1;
      return { line: a.line, col: a.col, length, message };
    }
    if (lang === "graphql" && e?.locations?.[0]) {
      const loc = e.locations[0];
      return { line: loc.line, col: loc.column, length: 1, message };
    }
    if (lang === "json") {
      const lc = /line (\d+) column (\d+)/i.exec(message);
      if (lc) return { line: +lc[1], col: +lc[2], length: 1, message };
      const p = /position (\d+)/i.exec(message);
      const { line, col } = posToLineCol(text, p ? +p[1] : 0);
      return { line, col, length: 1, message };
    }
    return { line: 1, col: 1, length: 1, message };
  }

  #xmlError(raw) {
    const m = /line (\d+)\s+(?:at\s+)?column (\d+)\s*:?\s*([\s\S]*)/i.exec(raw);
    if (m) {
      const message =
        (m[3] || "").split("\n")[0].trim() || raw.replace(/\s+/g, " ").trim();
      return { line: +m[1], col: +m[2], length: 1, message };
    }
    return {
      line: 1,
      col: 1,
      length: 1,
      message: raw.replace(/\s+/g, " ").trim(),
    };
  }

  /**
   * Draw a wavy underline for each error in the overlay, positioned via a DOM
   * Range at the error's column, and record a full-height hover band per error
   * so #updateErrorHover can surface the message. The overlay itself never
   * blocks editing (pointer-events:none); the tooltip rides on #inner instead of
   * the 3px strip, which is too thin to hover and is destroyed on every re-run.
   * Re-run on every gutter sync so it tracks layout changes.
   */
  #renderErrorMarkers() {
    if (!this.#markers) return;
    this.#markers.replaceChildren();
    this.#errorRegions = [];
    if (!this.#richErrors || !this.#errors.length) {
      this.#setHoverTitle("");
      return;
    }
    const innerRect = this.#inner.getBoundingClientRect();
    const lines = this.#lines();
    for (const err of this.#errors) {
      const line = lines[err.line - 1];
      if (!line || line.classList.contains("pce-line--hidden")) continue;
      const c0 = Math.max(0, err.col - 1);
      const start = this.#domPosAtRawCol(line, c0);
      const end = this.#domPosAtRawCol(line, c0 + Math.max(1, err.length));
      let rects = [];
      try {
        const r = document.createRange();
        r.setStart(start.node, start.offset);
        r.setEnd(end.node, end.offset);
        rects = [...r.getClientRects()];
      } catch {
        rects = [];
      }
      if (!rects.length) rects = [line.getBoundingClientRect()];
      const title = `${err.line}:${err.col}  ${err.message}`;
      for (const rect of rects) {
        if (rect.width === 0 && rect.height === 0) continue;
        const left = rect.left - innerRect.left;
        const width = Math.max(6, rect.width);
        const seg = document.createElement("div");
        seg.className = "pce-error-squiggle";
        seg.style.left = `${left}px`;
        seg.style.top = `${rect.bottom - innerRect.top - 3}px`;
        seg.style.width = `${width}px`;
        this.#markers.appendChild(seg);
        // Hover band covers the underlined text (full glyph height), not just
        // the strip, so the message shows when hovering the error itself.
        this.#errorRegions.push({
          left,
          right: left + width,
          top: rect.top - innerRect.top,
          bottom: rect.bottom - innerRect.top,
          title,
        });
      }
    }
  }

  /**
   * Toggle the error tooltip as the pointer moves over the document. The title
   * rides on #inner (not the squiggle strip): native `title` resolution walks up
   * from the hovered node to the nearest ancestor carrying one, so plain error
   * text shows the message while pills keep their own tooltips.
   */
  #updateErrorHover(e) {
    if (!this.#richErrors || !this.#errorRegions.length) {
      this.#setHoverTitle("");
      return;
    }
    const innerRect = this.#inner.getBoundingClientRect();
    const x = e.clientX - innerRect.left;
    const y = e.clientY - innerRect.top;
    const hit = this.#errorRegions.find(
      (r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom,
    );
    this.#setHoverTitle(hit ? hit.title : "");
  }

  /** Set/clear #inner's title only on change — re-assigning resets the OS
   *  tooltip's hover-dwell timer, so an unchanged value must be left alone. */
  #setHoverTitle(title) {
    if (title === this.#hoverTitle) return;
    this.#hoverTitle = title;
    if (title) this.#inner.title = title;
    else this.#inner.removeAttribute("title");
  }

  /**
   * Report validity OUTWARD instead of rendering it inside the editor: fire a
   * `pce:validity` CustomEvent on the root element so an external control can
   * toggle. `detail.state` is true (valid) / false (invalid) / null (empty or
   * validation off). Bubbles, so an ancestor can listen too.
   */
  #emitValidity(state) {
    this.#el.dispatchEvent(
      new CustomEvent("pce:validity", {
        detail: { state, language: this.#language },
        bubbles: true,
      }),
    );
  }
}
