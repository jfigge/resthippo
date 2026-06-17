/**
 * body-editor.js — the request Body tab.
 *
 * Owns every body type EXCEPT the request-coupled introspection fetch: no-body,
 * form-data / form-urlencoded (a drag-reorderable KV editor with a bulk-text
 * mode and, for form-data, per-row file fields), the text editors (JSON / YAML /
 * XML / plain), the single-file upload, and the GraphQL composer.
 *
 * Extracted from RequestEditor as a delegated sub-editor (same pattern as
 * GraphQLBodyEditor / RequestAuthEditor). The host injects the genuinely
 * shell-coupled pieces:
 *   • makeCodeEditor(opts) — the shared PillCodeEditor factory (so body text
 *       editors register in the host's #codeEditors set and follow view-setting
 *       changes / disposal).
 *   • disposeCodeEditors() — tear those down before a re-render.
 *   • graphql — the GraphQLBodyEditor instance (its introspection fetch is wired
 *       to the host's URL/auth/params, so the host owns it; this editor only
 *       mounts/unmounts it for the "graphql" body type).
 *   • getItems()/ensureResponseCaches() — for the {{var}} pill editors in rows.
 *   • onChange() — the host's "body changed" hook (→ request-updated).
 * Variable context + the removeHeaders setting are pushed in via setters.
 */
"use strict";

import { VariablePillEditor } from "../variable-pill-editor.js";
import {
  DragReorderController,
  buildKvRow,
  buildToolbarToggle,
  wireDeleteAllConfirm,
  applyBulkMode,
  kvRowsToText,
  textToKvRows,
  disposePillEditors,
} from "../kv-editor-shared.js";
import { icon } from "../../icons.js";
import { t } from "../../i18n.js";

export class BodyEditor {
  // ── Injected dependencies ────────────────────────────────────────────────
  #onChange;
  #makeCodeEditor;
  #disposeCodeEditors;
  #graphql;
  #getItems;
  #ensureResponseCaches;
  #variableContext = null;
  #removeHeaders = false;

  // ── Body state ─────────────────────────────────────────────────────────────
  #bodyType = "no-body";
  #bodyContentEl = null;
  #bodyTypeBarEl = null; // the bar holding the type selector (+ optional Prettify)
  #typeSelectEl = null; // the body-type <select>, for value sync on load
  #bodyFormRows = []; // shared for form-data AND form-urlencoded
  #bodyText = ""; // shared for json, yaml, xml, and plain text
  #bodyFilePath = ""; // path/name of selected file (display)
  #bodyFileObject = null; // actual File object reference for sending
  #bodyFormPillEditors = [];
  #bfListEl = null;
  #bfDrag = new DragReorderController({
    getItems: () => this.#bodyFormRows,
    render: () => this.#renderBodyContent(),
    dispatch: () => this.#dispatchBodyUpdated(),
  });

  // ── Body-form bulk-editor state ──────────────────────────────────────────
  #bodyFormBulkMode = false;
  #bodyFormBulkEl = null;
  #bodyFormBulkCheckEl = null;
  #bodyFormKvWrapEl = null;
  #bodyFormAddBtnEl = null;
  #bodyFormDelAllBtnEl = null;
  #bodyFormToolbarGroupEl = null;
  #bodyFormDeleteAllCleanup = null;

  constructor({
    onChange,
    makeCodeEditor,
    disposeCodeEditors,
    graphql,
    getItems,
    ensureResponseCaches,
  } = {}) {
    this.#onChange = onChange;
    this.#makeCodeEditor = makeCodeEditor;
    this.#disposeCodeEditors = disposeCodeEditors;
    this.#graphql = graphql;
    this.#getItems = getItems;
    this.#ensureResponseCaches = ensureResponseCaches;
  }

  // ── Public API used by the host ────────────────────────────────────────────

  getBodyType() {
    return this.#bodyType;
  }

  /** @returns {{bodyType,bodyFormRows,bodyText,bodyFilePath,bodyFile}} */
  getValue() {
    return {
      bodyType: this.#bodyType,
      bodyFormRows: [...this.#bodyFormRows],
      bodyText: this.#bodyText,
      bodyFilePath: this.#bodyFilePath,
      bodyFile: this.#bodyFileObject,
    };
  }

  /** Populate body state from a saved request node (legacy formats included). */
  setValue(node) {
    this.#bodyType = node.bodyType ?? "no-body";
    // Form rows — new unified format first, then legacy per-type fallbacks
    if (Array.isArray(node.bodyFormRows)) {
      this.#bodyFormRows = node.bodyFormRows.map((r) => ({
        id: r.id ?? crypto.randomUUID(),
        name: r.name ?? "",
        value: r.value ?? "",
        enabled: r.enabled ?? true,
        // Multipart file fields (Feature 49) — carried through unchanged. Older
        // rows lack these, defaulting to a plain text field.
        kind: r.kind === "file" ? "file" : "text",
        filePath: r.filePath ?? "",
        fileName: r.fileName ?? "",
        contentType: r.contentType ?? "",
      }));
    } else if (Array.isArray(node.bodyFormData)) {
      this.#bodyFormRows = node.bodyFormData.map((r) => ({
        id: r.id ?? crypto.randomUUID(),
        name: r.name ?? "",
        value: r.value ?? "",
        enabled: r.enabled ?? true,
      }));
    } else if (Array.isArray(node.bodyFormUrlEncoded)) {
      this.#bodyFormRows = node.bodyFormUrlEncoded.map((r) => ({
        id: r.id ?? crypto.randomUUID(),
        name: r.name ?? "",
        value: r.value ?? "",
        enabled: r.enabled ?? true,
      }));
    } else {
      this.#bodyFormRows = [];
    }
    // Text body — new unified format first, then legacy per-type dict
    if (node.bodyText != null) {
      this.#bodyText = node.bodyText;
    } else if (node.bodyTexts) {
      // Legacy: prefer the text stored for the current body type, then the first non-empty entry
      const bt = node.bodyTexts;
      this.#bodyText =
        bt[this.#bodyType] ?? bt.json ?? bt.yaml ?? bt.xml ?? bt.text ?? "";
    } else {
      this.#bodyText = "";
    }
    this.#bodyFilePath = node.bodyFilePath ?? "";
    this.#bodyFileObject = null;
    // GraphQL body (Feature 34) — query + variables; the introspected schema is
    // per-request and not persisted, so reset it when a new request loads.
    this.#graphql.setValue({
      query: node.bodyGraphql?.query ?? "",
      variables: node.bodyGraphql?.variables ?? "",
    });
    this.#graphql.reset();
    // Sync the select element if the body tab has been built
    if (this.#typeSelectEl) this.#typeSelectEl.value = this.#bodyType;
    this.#renderBodyContent();
  }

  /** Push the current variable-resolution context to the row pill editors. */
  setVariableContext(ctx) {
    this.#variableContext = ctx;
    for (const ed of this.#bodyFormPillEditors) ed.revalidate?.();
  }

  /** Show/hide the body-form column-label row to match the removeHeaders setting. */
  setRemoveHeaders(on) {
    this.#removeHeaders = !!on;
    this.#applyBodyFormHeaderRow();
  }

  /** Re-render the content area (host calls this on a GraphQL settings change). */
  renderContent() {
    this.#renderBodyContent();
  }

  /**
   * Safety flush — if the form bulk textarea is active, parse its current content
   * so in-progress edits are captured before the host builds a payload.
   */
  flushBulk() {
    if (this.#bodyFormBulkMode && this.#bodyFormBulkEl)
      this.#bodyFormRows = this.#bodyFormFromBulkText(
        this.#bodyFormBulkEl.value,
      );
  }

  /** Cancel any in-progress inline confirm on the form Delete All button. */
  cancelPendingDeleteAll() {
    this.#bodyFormDeleteAllCleanup?.();
  }

  // ── Thin delegators (kept so the ported method bodies read verbatim) ───────
  #dispatchBodyUpdated() {
    this.#onChange?.();
  }
  #buildKvRow(opts) {
    return buildKvRow(opts);
  }
  #buildToolbarToggle(o) {
    return buildToolbarToggle(o);
  }
  #wireDeleteAllConfirm(btn, getCount, onDelete) {
    return wireDeleteAllConfirm(btn, getCount, onDelete);
  }
  #applyBulkMode(bulk, textareaEl, kvWrapEl, addBtnEl, delAllBtnEl) {
    return applyBulkMode(bulk, textareaEl, kvWrapEl, addBtnEl, delAllBtnEl);
  }
  #kvRowsToText(rows) {
    return kvRowsToText(rows);
  }
  #textToKvRows(text) {
    return textToKvRows(text);
  }
  #disposePillEditors(editors) {
    return disposePillEditors(editors);
  }

  // ── Body editor ──────────────────────────────────────────────────────────
  build() {
    const container = document.createElement("div");
    container.className = "params-editor";

    // ── Type selector bar (also hosts the Prettify button when relevant) ──
    const typeBar = document.createElement("div");
    typeBar.className = "params-toolbar body-type-bar";
    this.#bodyTypeBarEl = typeBar;

    const typeSelect = document.createElement("select");
    typeSelect.className = "body-type-select";
    typeSelect.id = "body-type-select";
    typeSelect.setAttribute("aria-label", t("request.bodyType.aria"));
    typeSelect.innerHTML = `
      <optgroup label="${t("request.bodyType.groupStructured")}">
        <option value="form-data">${t("request.bodyType.formData")}</option>
        <option value="form-urlencoded">${t("request.bodyType.formUrlEncoded")}</option>
      </optgroup>
      <optgroup label="${t("request.bodyType.groupText")}">
        <option value="json">${t("request.bodyType.json")}</option>
        <option value="yaml">${t("request.bodyType.yaml")}</option>
        <option value="xml">${t("request.bodyType.xml")}</option>
        <option value="text">${t("request.bodyType.plainText")}</option>
      </optgroup>
      <optgroup label="${t("request.bodyType.graphql")}">
        <option value="graphql">${t("request.bodyType.graphql")}</option>
      </optgroup>
      <optgroup label="${t("request.bodyType.groupOther")}">
        <option value="file">${t("request.bodyType.file")}</option>
        <option value="no-body" selected>${t("request.bodyType.noBody")}</option>
      </optgroup>
    `;
    typeSelect.value = this.#bodyType;
    this.#typeSelectEl = typeSelect;
    typeSelect.addEventListener("change", () => {
      this.#bodyType = typeSelect.value;
      this.#renderBodyContent();
      this.#dispatchBodyUpdated();
    });

    typeBar.appendChild(typeSelect);

    // ── Form toolbar (Bulk Editor toggle + Add + Delete All) ─────────────
    // Appended to typeBar; shown only when body type is form-data or form-urlencoded
    const formToolbarGroup = document.createElement("span");
    formToolbarGroup.className =
      "body-form-toolbar-group body-form-toolbar-group--hidden";
    this.#bodyFormToolbarGroupEl = formToolbarGroup;

    const { label: bfBulkLabel, check: bfBulkCheck } = this.#buildToolbarToggle(
      {
        text: " " + t("kv.bulkEditor"),
        title: t("kv.bulkEditorTitle"),
        checked: this.#bodyFormBulkMode,
        onChange: (checked) => this.#handleBodyFormBulkToggle(checked),
      },
    );
    this.#bodyFormBulkCheckEl = bfBulkCheck;

    const addBtn = document.createElement("button");
    addBtn.className = "icon-btn params-toolbar-btn";
    addBtn.title = t("request.fields.add");
    addBtn.setAttribute("aria-label", t("request.fields.add"));
    addBtn.innerHTML = `<span class="icon">${icon("add", { size: 15 })}</span>`;
    addBtn.addEventListener("click", () => {
      this.#bodyFormRows.push({
        id: crypto.randomUUID(),
        name: "",
        value: "",
        enabled: true,
      });
      this.#renderBodyContent();
      this.#dispatchBodyUpdated();
    });

    const delAllBtn = document.createElement("button");
    delAllBtn.className =
      "params-toolbar-btn params-toolbar-btn--danger params-delete-all-btn";
    delAllBtn.title = t("request.fields.deleteAll");
    delAllBtn.textContent = t("kv.deleteAll");

    this.#bodyFormDeleteAllCleanup = this.#wireDeleteAllConfirm(
      delAllBtn,
      () => this.#bodyFormRows.length,
      () => {
        this.#bodyFormRows = [];
        this.#renderBodyContent();
        this.#dispatchBodyUpdated();
      },
    );

    this.#bodyFormAddBtnEl = addBtn;
    this.#bodyFormDelAllBtnEl = delAllBtn;

    formToolbarGroup.appendChild(bfBulkLabel);
    formToolbarGroup.appendChild(addBtn);
    formToolbarGroup.appendChild(delAllBtn);
    typeBar.appendChild(formToolbarGroup);

    container.appendChild(typeBar);

    // ── Content area ─────────────────────────────────────────────────────
    const content = document.createElement("div");
    content.className = "body-content";
    this.#bodyContentEl = content;
    container.appendChild(content);

    this.#renderBodyContent();
    return container;
  }

  /** Render the body content area to match the current #bodyType. */
  #renderBodyContent() {
    const el = this.#bodyContentEl;
    if (!el) return;
    el.innerHTML = "";
    this.#disposePillEditors(this.#bodyFormPillEditors);
    // Tear down any PillCodeEditors from the previous body type (removes their
    // document selectionchange + ResizeObserver listeners). The WebSocket
    // message editor lives in a different tab/protocol and is never present here.
    this.#disposeCodeEditors();
    // Remove any validation badge left over from a previous text type
    this.#bodyTypeBarEl?.querySelector(".body-validate-badge")?.remove();
    // Tear down any prior GraphQL composer: removes its fetch-schema button /
    // status badge / spacer from the type bar, dismisses a stale autocomplete
    // dropdown, and stops observing the old container (safe no-op when not in
    // GraphQL mode).
    this.#graphql.unmount();
    // Reset body form drag state whenever we switch panels
    this.#bfListEl = null;
    this.#bfDrag.reset();
    // Cancel any in-progress delete-all confirm before the UI is rebuilt
    this.#bodyFormDeleteAllCleanup?.();
    // Show / hide the form toolbar based on body type
    const isFormType =
      this.#bodyType === "form-data" || this.#bodyType === "form-urlencoded";
    if (this.#bodyFormToolbarGroupEl) {
      this.#bodyFormToolbarGroupEl.classList.toggle(
        "body-form-toolbar-group--hidden",
        !isFormType,
      );
      if (isFormType && this.#bodyFormBulkCheckEl) {
        this.#bodyFormBulkCheckEl.checked = this.#bodyFormBulkMode;
      }
    }
    // Reset body form bulk refs (will be reassigned by #renderBodyForm if applicable)
    this.#bodyFormBulkEl = this.#bodyFormKvWrapEl = null;

    switch (this.#bodyType) {
      case "no-body":
        return this.#renderBodyNone(el);
      case "form-data":
      case "form-urlencoded":
        return this.#renderBodyForm(el);
      case "json":
        return this.#renderBodyText(el, "json", true);
      case "yaml":
        return this.#renderBodyText(el, "yaml", true);
      case "xml":
        return this.#renderBodyText(el, "xml", true);
      case "text":
        return this.#renderBodyText(el, "text", false);
      case "graphql":
        return this.#graphql.mount(el, this.#bodyTypeBarEl);
      case "file":
        return this.#renderBodyFile(el);
    }
  }

  // ── No body ───────────────────────────────────────────────────────────────
  #renderBodyNone(el) {
    const msg = document.createElement("div");
    msg.className = "params-empty";
    msg.textContent = t("request.bodyType.noneMessage");
    el.appendChild(msg);
  }

  // ── Form key-value editor (form-data / form-urlencoded) ───────────────────
  #renderBodyForm(el) {
    const rows = this.#bodyFormRows;

    // ── Bulk mode textarea ────────────────────────────────────────────────
    const bfBulkTa = document.createElement("textarea");
    bfBulkTa.className = "body-text-editor";
    bfBulkTa.placeholder =
      this.#bodyType === "form-data"
        ? "name=value\nfile=@/path/to/file\n# disabled=row"
        : "name=value\nfield1=foo\nfield2=bar\n# disabled=row";
    bfBulkTa.spellcheck = false;
    bfBulkTa.setAttribute("aria-label", t("request.fields.bulkAria"));
    bfBulkTa.value = this.#bodyFormToBulkText();
    bfBulkTa.addEventListener("input", () => {
      this.#bodyFormRows = this.#bodyFormFromBulkText(bfBulkTa.value);
      this.#dispatchBodyUpdated();
    });
    this.#bodyFormBulkEl = bfBulkTa;
    el.appendChild(bfBulkTa);

    // ── KV wrap (column headers + list) ──────────────────────────────────
    const bfKvWrap = document.createElement("div");
    bfKvWrap.style.cssText =
      "display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden";
    // form-data rows carry a Text/File type column → widen the grid via CSS.
    if (this.#bodyType === "form-data") {
      bfKvWrap.classList.add("body-form--with-type");
    }
    this.#bodyFormKvWrapEl = bfKvWrap;

    // Column headers — form-data gets an extra Text/File type column.
    const typeCol =
      this.#bodyType === "form-data"
        ? `<span class="params-col-type"></span>`
        : "";
    const hdr = document.createElement("div");
    hdr.className = "params-header-row";
    hdr.innerHTML = `
      <span class="params-col-handle"></span>
      <span class="params-col-enabled"></span>
      ${typeCol}
      <span class="params-col-name">${t("kv.name")}</span>
      <span class="params-col-value">${t("kv.value")}</span>
      <span class="params-col-delete"></span>`;
    bfKvWrap.appendChild(hdr);

    // List — drag-to-reorder is wired through the controller, which creates
    // and owns the phantom placeholder. A fresh list is built on every render,
    // so attach() re-runs each time (the old list/listeners are GC'd with it).
    const list = document.createElement("div");
    list.className = "params-list";
    this.#bfListEl = list;
    this.#bfDrag.attach(list);

    if (!rows.length) {
      const empty = document.createElement("div");
      empty.className = "params-empty";
      empty.textContent = t("request.fields.empty");
      list.appendChild(empty);
    } else {
      rows.forEach((row) => list.appendChild(this.#buildBfRow(row, rows)));
    }

    bfKvWrap.appendChild(list);
    el.appendChild(bfKvWrap);

    this.#applyBodyFormBulkMode();
    this.#applyBodyFormHeaderRow();
  }

  #buildBfRow(row, rows) {
    const getCtx = () => this.#variableContext;
    const getItms = () => this.#getItems();
    // File fields exist only in multipart form-data, never form-urlencoded.
    const allowFile = this.#bodyType === "form-data";
    const addRow = () => {
      rows.push({
        id: crypto.randomUUID(),
        name: "",
        value: "",
        enabled: true,
      });
      this.#renderBodyContent();
      this.#dispatchBodyUpdated();
    };

    // ── Name pill editor (text and file rows alike) ──────────────────────
    const nameEditor = new VariablePillEditor({
      placeholder: t("kv.name"),
      ariaLabel: t("request.fields.nameAria"),
      className: "params-name",
      getContext: getCtx,
      getItems: getItms,
      ensureResponseCaches: (names) => this.#ensureResponseCaches?.(names),
      onInput: (v) => {
        row.name = v;
        this.#dispatchBodyUpdated();
      },
      onEnter: addRow,
    });
    nameEditor.setValue(row.name);
    this.#bodyFormPillEditors.push(nameEditor);

    // ── Value cell: a file picker for file rows, else a value pill editor ─
    let valueEl;
    if (allowFile && row.kind === "file") {
      valueEl = this.#buildBfFileCell(row);
    } else {
      const valueEditor = new VariablePillEditor({
        placeholder: t("kv.value"),
        ariaLabel: t("request.fields.valueAria"),
        className: "params-value",
        getContext: getCtx,
        getItems: getItms,
        ensureResponseCaches: (names) => this.#ensureResponseCaches?.(names),
        onInput: (v) => {
          row.value = v;
          this.#dispatchBodyUpdated();
        },
        onEnter: addRow,
      });
      valueEditor.setValue(row.value);
      this.#bodyFormPillEditors.push(valueEditor);
      valueEl = valueEditor.element;
    }

    // ── Text/File type toggle (form-data only) — an icon button that flips
    //    the field between a text value and a file upload. The glyph shows the
    //    CURRENT kind; the tooltip names it and the action. The whole row is
    //    rebuilt on toggle, so no in-place icon swap is needed here. ─────────
    let leading = null;
    if (allowFile) {
      const isFile = row.kind === "file";
      const typeToggle = document.createElement("button");
      typeToggle.type = "button";
      typeToggle.className = "icon-btn bf-type-toggle";
      typeToggle.innerHTML = icon(isFile ? "file" : "text", { size: 14 });
      const label = isFile
        ? t("request.fields.typeToText")
        : t("request.fields.typeToFile");
      typeToggle.title = label;
      typeToggle.setAttribute("aria-label", label);
      typeToggle.addEventListener("click", () => {
        if (row.kind === "file") {
          row.kind = "text";
          row.filePath = row.fileName = row.contentType = "";
        } else {
          row.kind = "file";
          row.value = ""; // text value is meaningless for a file field
        }
        this.#renderBodyContent();
        this.#dispatchBodyUpdated();
      });
      leading = typeToggle;
    }

    return this.#buildKvRow({
      item: row,
      noun: t("request.noun.field"),
      name: nameEditor.element,
      value: valueEl,
      drag: this.#bfDrag,
      leading,
      onToggle: () => this.#dispatchBodyUpdated(),
      onDelete: () => {
        this.#bodyFormRows = rows.filter((r) => r.id !== row.id);
        this.#renderBodyContent();
        this.#dispatchBodyUpdated();
      },
    });
  }

  /**
   * Build the value-cell file picker for a form-data file field. The file's
   * absolute PATH is captured here via window.hippo.getPathForFile (Electron
   * removed File.path in v32); the bytes are read in the main process at send
   * time, so only the path crosses IPC.
   */
  #buildBfFileCell(row) {
    const cell = document.createElement("div");
    cell.className = "params-value bf-file-cell";

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.style.display = "none";
    fileInput.addEventListener("change", () => {
      const f = fileInput.files?.[0];
      if (!f) return;
      row.filePath = window.hippo?.getPathForFile?.(f) || f.path || f.name;
      row.fileName = f.name;
      row.contentType = f.type || "";
      this.#renderBodyContent();
      this.#dispatchBodyUpdated();
    });
    cell.appendChild(fileInput);

    if (row.filePath) {
      const nameSpan = document.createElement("span");
      nameSpan.className = "bf-file-name";
      nameSpan.textContent = row.fileName || row.filePath;
      nameSpan.title = row.filePath;
      cell.appendChild(nameSpan);

      const clearBtn = document.createElement("button");
      clearBtn.className = "icon-btn bf-file-clear";
      clearBtn.title = t("request.file.remove");
      clearBtn.setAttribute("aria-label", t("request.file.remove"));
      clearBtn.textContent = "×";
      clearBtn.addEventListener("click", () => {
        row.filePath = row.fileName = row.contentType = "";
        this.#renderBodyContent();
        this.#dispatchBodyUpdated();
      });
      cell.appendChild(clearBtn);
    } else {
      const browseBtn = document.createElement("button");
      browseBtn.className = "bf-file-choose";
      browseBtn.textContent = t("request.file.choose");
      browseBtn.addEventListener("click", () => fileInput.click());
      cell.appendChild(browseBtn);
    }
    return cell;
  }

  /**
   * Serialize the form rows to bulk text. In form-data a file field uses `=@`
   * as its assignment marker (`name=@<path>`, or `name=@` for an unassigned
   * file) so it is visible and distinguishable from a text field (`name=value`);
   * disabled rows keep the leading `# `. form-urlencoded has no file fields, so
   * it falls back to the plain shared serializer.
   */
  #bodyFormToBulkText() {
    if (this.#bodyType !== "form-data") {
      return this.#kvRowsToText(this.#bodyFormRows);
    }
    return this.#bodyFormRows
      .map((r) => {
        const prefix = r.enabled ? "" : "# ";
        return r.kind === "file"
          ? `${prefix}${r.name}=@${r.filePath ?? ""}`
          : `${prefix}${r.name}=${r.value ?? ""}`;
      })
      .join("\n");
  }

  /**
   * Parse bulk text back into form rows. In form-data, a value beginning with
   * `@` (immediately after the `=`) marks a file field; the rest is its path.
   * File metadata (fileName / contentType) is recovered by matching the path
   * back to an existing file row so a bulk round-trip doesn't lose it.
   */
  #bodyFormFromBulkText(text) {
    if (this.#bodyType !== "form-data") {
      return this.#textToKvRows(text);
    }
    const prevFiles = this.#bodyFormRows.filter((r) => r.kind === "file");
    const out = [];
    for (const line of text.split("\n")) {
      let trimmed = line.trim();
      if (!trimmed) continue;
      const disabled = trimmed.startsWith("# ");
      if (disabled) trimmed = trimmed.slice(2).trim();
      if (!trimmed) continue;
      const eqIdx = trimmed.indexOf("=");
      const name = eqIdx === -1 ? trimmed : trimmed.slice(0, eqIdx).trim();
      if (!name) continue;
      const rhs = eqIdx === -1 ? "" : trimmed.slice(eqIdx + 1);
      if (rhs.startsWith("@")) {
        const filePath = rhs.slice(1);
        const prev = filePath
          ? prevFiles.find((r) => (r.filePath ?? "") === filePath)
          : null;
        out.push({
          id: crypto.randomUUID(),
          name,
          value: "",
          enabled: !disabled,
          kind: "file",
          filePath,
          fileName: prev?.fileName || (filePath.split(/[\\/]/).pop() ?? ""),
          contentType: prev?.contentType ?? "",
        });
      } else {
        out.push({
          id: crypto.randomUUID(),
          name,
          value: rhs,
          enabled: !disabled,
          kind: "text",
        });
      }
    }
    return out;
  }

  // ── Text editor (JSON / YAML / XML / Plain Text) ──────────────────────────
  #renderBodyText(el, type, validated) {
    // `type` is one of json / yaml / xml / text — all valid PillCodeEditor
    // languages. Rich (inline squiggle) errors are disabled for the body editor;
    // validity instead drives the type-bar badge via the `pce:validity` event.
    const editor = this.#makeCodeEditor({
      value: this.#bodyText,
      language: type,
      richErrors: false,
      placeholder: t("request.body.placeholder", {
        type:
          type === "text" ? t("request.body.plainText") : type.toUpperCase(),
      }),
      onInput: (v) => {
        this.#bodyText = v;
        this.#dispatchBodyUpdated();
      },
    });
    el.appendChild(editor.element);

    // Validation badge — only for the validated types (JSON / YAML / XML),
    // tracking the editor's `pce:validity` event. Prettify lives in the
    // editor's own context menu (right-click), so there's no toolbar button.
    if (validated && this.#bodyTypeBarEl) {
      const validateBadge = document.createElement("span");
      validateBadge.className = "body-validate-badge";
      validateBadge.setAttribute("aria-live", "polite");
      validateBadge.dataset.state = "";
      this.#bodyTypeBarEl.appendChild(validateBadge);

      editor.element.addEventListener("pce:validity", (e) => {
        const state = e.detail?.state; // true | false | null
        validateBadge.dataset.state =
          state == null ? "" : state ? "valid" : "invalid";
        if (state === true) {
          validateBadge.textContent = t("request.graphql.valid");
          validateBadge.title = t("request.bodyValidate.validTitle", {
            type: type.toUpperCase(),
          });
        } else if (state === false) {
          validateBadge.textContent = t("request.graphql.invalid");
          validateBadge.title = t("request.bodyValidate.invalidTitle", {
            type: type.toUpperCase(),
          });
        } else {
          validateBadge.textContent = "";
          validateBadge.title = "";
        }
      });
      editor.revalidate(); // sync the badge to any pre-loaded content now
    }
  }

  // ── File picker ───────────────────────────────────────────────────────────
  #renderBodyFile(el) {
    const showPicker = () => {
      if (this.#bodyFilePath) {
        this.#renderFileChosen(el);
      } else {
        this.#renderFileDropZone(el);
      }
    };
    showPicker();
  }

  #renderFileDropZone(el) {
    el.innerHTML = "";
    const zone = document.createElement("div");
    zone.className = "body-file-zone";

    const iconEl = document.createElement("div");
    iconEl.className = "body-file-zone-icon";
    iconEl.innerHTML = `<svg width="40" height="40" viewBox="0 0 40 40" fill="none"
        stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <rect x="6" y="4" width="28" height="32" rx="3"/>
      <polyline points="24,4 24,14 34,14"/>
      <line x1="14" y1="22" x2="26" y2="22"/>
      <line x1="14" y1="28" x2="22" y2="28"/>
    </svg>`;

    const label = document.createElement("p");
    label.className = "body-file-zone-label";
    label.textContent = t("request.file.drop");

    const sub = document.createElement("p");
    sub.className = "body-file-zone-sub";
    sub.textContent = t("request.file.or");

    const browseBtn = document.createElement("button");
    browseBtn.className = "btn btn--secondary body-file-browse-btn";
    browseBtn.textContent = t("request.file.browse");

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.style.display = "none";
    fileInput.addEventListener("change", () => {
      const f = fileInput.files?.[0];
      if (!f) return;
      // Electron removed File.path in v32; resolve via the preload bridge.
      this.#bodyFilePath =
        window.hippo?.getPathForFile?.(f) || f.path || f.name;
      this.#bodyFileObject = f;
      this.#renderFileChosen(el);
      this.#dispatchBodyUpdated();
    });

    browseBtn.addEventListener("click", () => fileInput.click());

    // Drag-and-drop
    zone.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      zone.classList.add("body-file-zone--over");
    });
    zone.addEventListener("dragleave", (e) => {
      if (!zone.contains(e.relatedTarget))
        zone.classList.remove("body-file-zone--over");
    });
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      zone.classList.remove("body-file-zone--over");
      const f = e.dataTransfer.files?.[0];
      if (!f) return;
      this.#bodyFilePath =
        window.hippo?.getPathForFile?.(f) ||
        f.path ||
        f.webkitRelativePath ||
        f.name;
      this.#bodyFileObject = f;
      this.#renderFileChosen(el);
      this.#dispatchBodyUpdated();
    });

    zone.appendChild(iconEl);
    zone.appendChild(label);
    zone.appendChild(sub);
    zone.appendChild(browseBtn);
    zone.appendChild(fileInput);
    el.appendChild(zone);
  }

  #renderFileChosen(el) {
    el.innerHTML = "";
    const chosen = document.createElement("div");
    chosen.className = "body-file-chosen";

    const pathIcon = document.createElement("span");
    pathIcon.className = "body-file-chosen-icon";
    pathIcon.innerHTML = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none"
        stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
      <rect x="3" y="2" width="14" height="16" rx="2"/>
      <line x1="7" y1="7" x2="13" y2="7"/>
      <line x1="7" y1="10" x2="13" y2="10"/>
      <line x1="7" y1="13" x2="11" y2="13"/>
    </svg>`;

    const pathText = document.createElement("span");
    pathText.className = "body-file-chosen-path";
    pathText.title = this.#bodyFilePath;
    pathText.textContent = this.#bodyFilePath;

    const resetBtn = document.createElement("button");
    resetBtn.className = "btn body-file-reset-btn";
    resetBtn.textContent = t("request.file.reset");
    resetBtn.title = t("request.file.removeSelectedTitle");
    resetBtn.addEventListener("click", () => {
      this.#bodyFilePath = "";
      this.#bodyFileObject = null;
      this.#renderFileDropZone(el);
      this.#dispatchBodyUpdated();
    });

    chosen.appendChild(pathIcon);
    chosen.appendChild(pathText);
    chosen.appendChild(resetBtn);
    el.appendChild(chosen);
  }

  // ── Body-form bulk editor ──────────────────────────────────────────────────
  #handleBodyFormBulkToggle(nowBulk) {
    if (nowBulk && !this.#bodyFormBulkMode) {
      if (this.#bodyFormBulkEl)
        this.#bodyFormBulkEl.value = this.#bodyFormToBulkText();
    } else if (!nowBulk && this.#bodyFormBulkMode) {
      if (this.#bodyFormBulkEl)
        this.#bodyFormRows = this.#bodyFormFromBulkText(
          this.#bodyFormBulkEl.value,
        );
    }
    this.#bodyFormBulkMode = nowBulk;
    this.#applyBodyFormBulkMode();
    if (!nowBulk) {
      this.#disposePillEditors(this.#bodyFormPillEditors);
      // Re-render the KV list so it reflects any edits made in bulk mode
      if (this.#bfListEl) {
        this.#bfListEl.innerHTML = "";
        if (!this.#bodyFormRows.length) {
          const empty = document.createElement("div");
          empty.className = "params-empty";
          empty.textContent = t("request.fields.empty");
          this.#bfListEl.appendChild(empty);
        } else {
          this.#bodyFormRows.forEach((row) =>
            this.#bfListEl.appendChild(
              this.#buildBfRow(row, this.#bodyFormRows),
            ),
          );
        }
      }
    }
    this.#dispatchBodyUpdated();
  }

  #applyBodyFormBulkMode() {
    this.#applyBulkMode(
      this.#bodyFormBulkMode,
      this.#bodyFormBulkEl,
      this.#bodyFormKvWrapEl,
      this.#bodyFormAddBtnEl,
      this.#bodyFormDelAllBtnEl,
    );
  }

  /** Show/hide the body-form column-label row to match the removeHeaders setting. */
  #applyBodyFormHeaderRow() {
    const hdr = this.#bodyFormKvWrapEl?.querySelector(".params-header-row");
    if (hdr) hdr.style.display = this.#removeHeaders ? "none" : "";
  }
}
