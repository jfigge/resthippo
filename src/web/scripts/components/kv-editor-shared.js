/**
 * kv-editor-shared.js — shared machinery for the key/value editors
 *
 * The Params, Headers, and Body-form editors all build the same kind of
 * draggable, bulk-editable key/value row list. This module holds the pieces
 * they share, extracted verbatim from RequestEditor so the (now separate)
 * body editor can reuse them without depending on the parent:
 *
 *   • DragReorderController — phantom-placeholder drag-to-reorder for a row list
 *   • AutocompleteDropdown  — the floating combo-box used by header/scope/api-key
 *   • the pure row/serialiser helpers (buildKvRow, the bulk-text <→> rows
 *     converters, the toolbar-toggle/bulk-mode/delete-all helpers, pill disposal)
 *
 * Everything here is concern-agnostic: callers pass in all state as arguments.
 */

"use strict";

import { icon } from "../icons.js";
import { wireDeleteConfirm } from "../delete-confirm.js";
import { t } from "../i18n.js";

// ── Autocomplete dropdown (shared mechanism) ──────────────────────────────────
// One class drives all four combo dropdowns (header-name, header-value,
// scope, API-key name). It owns ONLY the mechanism: lazy DOM creation, outside-
// click dismiss, positioning, keyboard navigation, and show/hide. Per-dropdown
// match logic and the exact select-ordering stay in the free functions, which
// delegate mechanism to their instance. All four reuse the .hdr-autocomplete
// CSS classes.
export class AutocompleteDropdown {
  #el = null; // the floating listbox div
  #anchor = null; // element the dropdown is currently anchored to
  #activeIdx = -1; // keyboard-focused item index (-1 = none)
  #blurTimer = null; // pending blur-hide timer (cancelled on re-show)
  #className;
  #ariaLabel;

  constructor(className, ariaLabel) {
    this.#className = className;
    this.#ariaLabel = ariaLabel;
  }

  #ensure() {
    if (this.#el) return this.#el;
    this.#el = document.createElement("div");
    this.#el.className = this.#className;
    this.#el.setAttribute("role", "listbox");
    this.#el.setAttribute("aria-label", this.#ariaLabel);
    document.body.appendChild(this.#el);

    // Hide when anything outside the anchor + dropdown is clicked.
    document.addEventListener(
      "mousedown",
      (e) => {
        if (
          this.#anchor &&
          !this.#anchor.contains(e.target) &&
          !this.#el.contains(e.target)
        ) {
          this.hide();
        }
      },
      true,
    );

    return this.#el;
  }

  /**
   * Populate + position the dropdown below `anchorEl`.
   * `onPick(value, entry)` fires on item mousedown (before the input blur).
   * `renderItem(item, entry)` customises an item's DOM; when omitted the entry
   * is treated as a plain string label (stored on item.dataset.value).
   */
  show(anchorEl, entries, onPick, { minWidth = 0, renderItem = null } = {}) {
    if (this.#blurTimer !== null) {
      clearTimeout(this.#blurTimer);
      this.#blurTimer = null;
    }
    if (!entries || entries.length === 0) {
      this.hide();
      return;
    }

    const dl = this.#ensure();
    dl.innerHTML = "";
    this.#activeIdx = -1;

    entries.forEach((entry, i) => {
      const item = document.createElement("div");
      item.className = "hdr-autocomplete-item";
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", "false");
      item.dataset.idx = String(i);
      if (renderItem) {
        renderItem(item, entry);
      } else {
        item.textContent = entry;
        item.dataset.value = entry;
      }

      // mousedown (not click) so we fire before the input's blur
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        onPick(item.dataset.value ?? item.textContent, entry);
      });
      dl.appendChild(item);
    });

    const rect = anchorEl.getBoundingClientRect();
    dl.style.left = `${rect.left + window.scrollX}px`;
    dl.style.top = `${rect.bottom + window.scrollY + 2}px`;
    dl.style.width = `${Math.max(rect.width, minWidth)}px`;
    dl.classList.add("hdr-autocomplete--visible");
    this.#anchor = anchorEl;
  }

  hide() {
    this.#blurTimer = null;
    if (this.#el) {
      this.#el.classList.remove("hdr-autocomplete--visible");
      this.#el.innerHTML = "";
    }
    this.#anchor = null;
    this.#activeIdx = -1;
  }

  /** Schedule a deferred hide (cancelled if show() runs first). */
  scheduleHide(delay = 150) {
    this.#blurTimer = setTimeout(() => this.hide(), delay);
  }

  /** Move keyboard focus within the dropdown; wraps around. */
  navigate(dir) {
    if (!this.#el) return;
    const items = [...this.#el.querySelectorAll(".hdr-autocomplete-item")];
    if (!items.length) return;

    items[this.#activeIdx]?.classList.remove("hdr-autocomplete-item--active");
    items[this.#activeIdx]?.setAttribute("aria-selected", "false");

    this.#activeIdx = (this.#activeIdx + dir + items.length) % items.length;

    const active = items[this.#activeIdx];
    active.classList.add("hdr-autocomplete-item--active");
    active.setAttribute("aria-selected", "true");
    active.scrollIntoView({ block: "nearest" });
  }

  /** Label of the keyboard-focused item, or null when none is focused. */
  activeLabel() {
    if (!this.#el || this.#activeIdx < 0) return null;
    const items = this.#el.querySelectorAll(".hdr-autocomplete-item");
    const active = items[this.#activeIdx];
    if (!active) return null;
    return active.dataset.value ?? active.textContent ?? null;
  }

  get visible() {
    return !!this.#el?.classList.contains("hdr-autocomplete--visible");
  }
}

/**
 * DragReorderController — HTML5 phantom-placeholder drag-to-reorder for a
 * vertical list of `.params-row` elements.
 *
 * Generalises the three byte-identical implementations (params, headers,
 * body-form) that previously lived inline in RequestEditor. While a row is
 * dragged it is hidden (`display:none`) and a `.params-drop-phantom` div is
 * moved to the prospective drop slot; a document-level `dragover` listener
 * withdraws the phantom when the pointer leaves the list. On drop the backing
 * array is reordered in place and the caller's render/dispatch run.
 *
 * The backing array is read live via getItems() on every drop because callers
 * may reassign it (e.g. body-form rows are rebuilt on bulk-mode toggles).
 *
 * Lifecycle:
 *   attach(listEl)      — call once per list (re)build: creates the phantom and
 *                         wires the list-level dragover/drop handlers.
 *   wireRow(rowEl, id)  — call per row: wires dragstart/dragover/dragend.
 *   reset()             — abandon any in-flight drag and release element refs
 *                         (used when the body-form list is torn down on a
 *                         panel switch without a new attach()).
 */
export class DragReorderController {
  #getItems;
  #render;
  #dispatch;
  #listEl = null;
  #phantom = null;
  #srcId = null;
  #insideList = false;
  #dropHandled = false;
  #docHandler = null;

  constructor({ getItems, render, dispatch }) {
    this.#getItems = getItems;
    this.#render = render;
    this.#dispatch = dispatch;
  }

  /** Create the phantom and wire list-level dragover/drop. Call per list build. */
  attach(listEl) {
    this.#listEl = listEl;
    const phantom = document.createElement("div");
    phantom.className = "params-drop-phantom";
    phantom.setAttribute("aria-hidden", "true");
    this.#phantom = phantom;

    listEl.addEventListener("dragover", (e) => {
      if (this.#srcId) e.preventDefault();
    });
    listEl.addEventListener("drop", (e) => {
      e.preventDefault();
      if (!this.#srcId) return;
      this.#dropHandled = true;
      const allChildren = [...listEl.children];
      const phantomIdx = allChildren.indexOf(phantom);
      if (phantomIdx === -1) {
        this.#cancel();
        this.#finalize();
        return;
      }
      const insertBefore = allChildren
        .slice(0, phantomIdx)
        .filter((c) => c.classList.contains("params-row")).length;
      const items = this.#getItems();
      const srcIdx = items.findIndex((it) => it.id === this.#srcId);
      if (srcIdx !== -1) {
        const [moved] = items.splice(srcIdx, 1);
        const target = insertBefore > srcIdx ? insertBefore - 1 : insertBefore;
        items.splice(target, 0, moved);
        this.#render();
        this.#dispatch();
      }
      this.#finalize();
    });
  }

  /** Wire dragstart/dragover/dragend for one row. Call per row build. */
  wireRow(rowEl, itemId) {
    rowEl.addEventListener("dragstart", (e) => {
      // Defensive: clear any drag state still lingering from a prior gesture
      // (dragend normally finalizes, so this is a no-op on the happy path).
      if (this.#srcId) this.#finalize();
      this.#srcId = itemId;
      this.#dropHandled = false;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", itemId);

      requestAnimationFrame(() => {
        this.#insideList = true;
        rowEl.parentElement?.insertBefore(this.#phantom, rowEl);
        rowEl.style.display = "none";
      });

      this.#docHandler = (ev) => {
        if (!this.#srcId || !this.#listEl) return;
        const inside = this.#listEl.contains(ev.target);
        if (!inside && this.#insideList) {
          this.#insideList = false;
          this.#phantom?.remove();
          const draggedRow = this.#listEl.querySelector(
            `[data-id="${this.#srcId}"]`,
          );
          if (draggedRow) draggedRow.style.display = "";
        } else if (inside && !this.#insideList) {
          this.#insideList = true;
        }
      };
      document.addEventListener("dragover", this.#docHandler);
    });

    rowEl.addEventListener("dragover", (e) => {
      if (!this.#srcId || this.#srcId === itemId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";

      const rect = rowEl.getBoundingClientRect();
      const after = (e.clientY - rect.top) / rect.height >= 0.5;
      const ph = this.#phantom;

      const draggedRow = this.#listEl?.querySelector(
        `[data-id="${this.#srcId}"]`,
      );
      if (draggedRow && draggedRow.style.display !== "none")
        draggedRow.style.display = "none";

      const sibling = after ? rowEl.nextSibling : rowEl;
      if (ph.nextSibling !== sibling && ph !== sibling)
        rowEl.parentElement?.insertBefore(ph, sibling);
    });

    rowEl.addEventListener("dragend", () => {
      if (!this.#dropHandled) this.#cancel();
      this.#finalize();
    });
  }

  /** Abandon any in-flight drag and release the list/phantom references. */
  reset() {
    this.#finalize();
    this.#listEl = null;
    this.#phantom = null;
  }

  /** Cancel a drag: remove the phantom and re-render from unchanged data. */
  #cancel() {
    this.#phantom?.remove();
    this.#render();
  }

  /** Clear drag state and detach the document-level dragover listener. */
  #finalize() {
    if (this.#docHandler) {
      document.removeEventListener("dragover", this.#docHandler);
      this.#docHandler = null;
    }
    this.#srcId = null;
    this.#insideList = false;
    this.#dropHandled = false;
  }
}

/**
 * Build a `.params-toolbar-toggle-label` checkbox toggle.
 * Returns `{ label, check }` so callers can mount the label and read/sync the
 * input. `onChange(checked)` fires on every change.
 */
export function buildToolbarToggle({
  text,
  title,
  checked,
  onChange,
  id = null,
}) {
  const label = document.createElement("label");
  label.className = "params-toolbar-toggle-label";
  label.title = title;
  const check = document.createElement("input");
  check.type = "checkbox";
  check.className = "params-toolbar-toggle";
  if (id) check.id = id;
  check.checked = checked;
  check.addEventListener("change", () => onChange(check.checked));
  label.appendChild(check);
  label.append(text);
  return { label, check };
}

/**
 * Build one `.params-row` from a `{ id, enabled }` item plus pre-built `name`
 * and `value` editor elements. Wires the enabled checkbox, delete-confirm
 * button, and drag handle. `onToggle()` runs after the enabled flag flips;
 * `onDelete()` runs on a confirmed delete; `drag` is the row's
 * DragReorderController.
 *
 * Optional slots let the same grid serve non-query rows without forking it:
 *   • `leading`    — element inserted after the toggle, before the name cell
 *                    (e.g. the form-data Text/File type select).
 *   • `statusIcon` — element shown INSTEAD of the enabled checkbox (e.g. the
 *                    path-parameter indicator); the row becomes non-toggleable.
 *   • `noDrag`     — omit the drag grip and skip reorder wiring (path rows are
 *                    ordered by the URL, not draggable). The handle column is
 *                    kept as an inert placeholder so columns stay aligned.
 */
export function buildKvRow({
  item,
  index,
  noun,
  name,
  value,
  drag,
  onToggle,
  onDelete,
  leading = null,
  statusIcon = null,
  noDrag = false,
}) {
  const row = document.createElement("div");
  row.className = "params-row";
  row.dataset.id = item.id;
  if (index != null) row.dataset.index = String(index);
  if (!noDrag) row.draggable = true;
  if (item.enabled === false) row.classList.add("params-row--disabled");

  // ── Drag handle (inert placeholder when reordering is disabled) ───────
  const handle = document.createElement("span");
  handle.className = "params-drag-handle";
  handle.setAttribute("aria-hidden", "true");
  if (!noDrag) {
    handle.title = t("common.dragReorder");
    handle.innerHTML = icon("drag", { width: 10, height: 16 });
  }

  // ── Enabled checkbox, or a status icon for non-toggleable rows ────────
  let control;
  if (statusIcon) {
    control = statusIcon;
  } else {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "params-checkbox";
    checkbox.checked = item.enabled;
    const syncCbTitle = () => {
      checkbox.title = item.enabled ? `Disable ${noun}` : `Enable ${noun}`;
    };
    syncCbTitle();
    checkbox.setAttribute("aria-label", `Enable ${noun}`);
    checkbox.addEventListener("change", () => {
      item.enabled = checkbox.checked;
      syncCbTitle();
      row.classList.toggle("params-row--disabled", !item.enabled);
      onToggle();
    });
    control = checkbox;
  }

  // ── Delete button ────────────────────────────────────────────────────
  const deleteBtn = document.createElement("button");
  deleteBtn.className = "icon-btn params-delete-btn";
  deleteBtn.title = `Delete ${noun}`;
  deleteBtn.setAttribute("aria-label", `Delete ${noun}`);
  wireDeleteConfirm(deleteBtn, onDelete);

  // ── HTML5 drag-and-drop reordering (phantom pattern) ─────────────────
  if (!noDrag) drag.wireRow(row, item.id);

  row.appendChild(handle);
  row.appendChild(control);
  if (leading) row.appendChild(leading);
  row.appendChild(name);
  row.appendChild(value);
  row.appendChild(deleteBtn);
  return row;
}

/**
 * Wire up the standard two-click inline-confirm pattern on a "Delete All"
 * button.  First click turns it amber and shows "Confirm?"; second click
 * runs `onDelete`.  Escape or clicking outside cancels.
 *
 * Returns a cancel function (store it so node-switches can reset the button).
 *
 * @param {HTMLButtonElement} btn
 * @param {() => number}      getCount   — called to guard against empty list
 * @param {() => void}        onDelete   — called on confirmed second click
 * @returns {() => void} cancel function
 */
export function wireDeleteAllConfirm(btn, getCount, onDelete) {
  let cleanupConfirm = null;

  const enterConfirm = () => {
    btn.textContent = t("kv.confirm");
    btn.classList.remove("params-toolbar-btn--danger");
    btn.classList.add("params-toolbar-btn--confirming");

    const restore = () => {
      btn.textContent = t("kv.deleteAll");
      btn.classList.remove("params-toolbar-btn--confirming");
      btn.classList.add("params-toolbar-btn--danger");
      document.removeEventListener("keydown", onEsc, true);
      document.removeEventListener("mousedown", onOutside, true);
      cleanupConfirm = null;
    };

    const onEsc = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        restore();
      }
    };
    const onOutside = (e) => {
      if (!btn.contains(e.target)) restore();
    };

    document.addEventListener("keydown", onEsc, true);
    document.addEventListener("mousedown", onOutside, true);
    cleanupConfirm = restore;
  };

  btn.addEventListener("click", () => {
    if (!getCount()) return;
    if (cleanupConfirm) {
      cleanupConfirm();
      onDelete();
    } else enterConfirm();
  });

  return () => cleanupConfirm?.();
}

/**
 * Toggle a bulk-editor's textarea/kv-wrap and KV-only toolbar buttons.
 * @param {boolean}          bulk
 * @param {HTMLElement|null} textareaEl
 * @param {HTMLElement|null} kvWrapEl
 * @param {HTMLElement|null} addBtnEl
 * @param {HTMLElement|null} delAllBtnEl
 */
export function applyBulkMode(
  bulk,
  textareaEl,
  kvWrapEl,
  addBtnEl,
  delAllBtnEl,
) {
  if (textareaEl) textareaEl.style.display = bulk ? "" : "none";
  if (kvWrapEl) kvWrapEl.style.display = bulk ? "none" : "";
  if (addBtnEl) addBtnEl.style.display = bulk ? "none" : "";
  if (delAllBtnEl) delAllBtnEl.style.display = bulk ? "none" : "";
}

// ── Bulk editor shared utilities ─────────────────────────────────────────

/**
 * Serialise an array of { name, value, enabled } rows to  name=value  text.
 * Disabled rows are prefixed with "# " so the enabled state survives a
 * round-trip through the bulk editor.
 */
export function kvRowsToText(rows) {
  return rows
    .map((r) => `${r.enabled ? "" : "# "}${r.name}=${r.value}`)
    .join("\n");
}

/**
 * Serialise header rows to  Name: value  text (standard HTTP format).
 * Disabled rows are prefixed with "# ".
 */
export function headerRowsToText(rows) {
  return rows
    .map((r) => `${r.enabled ? "" : "# "}${r.name}: ${r.value}`)
    .join("\n");
}

/**
 * Parse  name=value  bulk text into an array of row objects.
 * Lines prefixed with "# " are parsed as disabled rows; all others are enabled.
 * Lines with no '=' are treated as name-only rows with an empty value.
 */
export function textToKvRows(text) {
  const out = [];
  for (const line of text.split("\n")) {
    let trimmed = line.trim();
    if (!trimmed) continue;
    const disabled = trimmed.startsWith("# ");
    if (disabled) trimmed = trimmed.slice(2).trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf("=");
    const name = eqIdx === -1 ? trimmed : trimmed.slice(0, eqIdx).trim();
    const value = eqIdx === -1 ? "" : trimmed.slice(eqIdx + 1);
    if (name)
      out.push({ id: crypto.randomUUID(), name, value, enabled: !disabled });
  }
  return out;
}

/**
 * Parse  Header-Name: value  OR  Header-Name=value  lines into header rows.
 * Supports both colon-separated (natural HTTP format) and equals-separated.
 * Lines prefixed with "# " are parsed as disabled rows; all others are enabled.
 */
export function textToHeaderRows(text) {
  const out = [];
  for (const line of text.split("\n")) {
    let trimmed = line.trim();
    if (!trimmed) continue;
    const disabled = trimmed.startsWith("# ");
    if (disabled) trimmed = trimmed.slice(2).trim();
    if (!trimmed) continue;
    // Prefer colon separator for headers, fall back to equals
    const colonIdx = trimmed.indexOf(":");
    const eqIdx = trimmed.indexOf("=");
    let name, value;
    if (colonIdx !== -1 && (eqIdx === -1 || colonIdx < eqIdx)) {
      name = trimmed.slice(0, colonIdx).trim();
      value = trimmed.slice(colonIdx + 1).trim();
    } else if (eqIdx !== -1) {
      name = trimmed.slice(0, eqIdx).trim();
      value = trimmed.slice(eqIdx + 1);
    } else {
      name = trimmed;
      value = "";
    }
    if (name)
      out.push({ id: crypto.randomUUID(), name, value, enabled: !disabled });
  }
  return out;
}

/**
 * Destroy every pill editor in `editors` and empty the array in place.
 *
 * Each VariablePillEditor attaches a document-level selectionchange listener;
 * dropping the reference without calling destroy() leaks that listener, which
 * then accumulates on every re-render. Clearing in place (rather than
 * reassigning) preserves the field's array identity so the per-row builders
 * keep pushing fresh editors onto the same instance.
 */
export function disposePillEditors(editors) {
  for (const ed of editors) ed.destroy?.();
  editors.length = 0;
}
