/**
 * captures-editor.js — the Captures request tab (Feature 03).
 *
 * Post-response rules: after a successful (2xx) response, app.js extracts a
 * value (status / header / body dot-path) and writes it into the chosen
 * variable scope. This tab edits the rules; execution lives in app.js.
 *
 * Extracted from RequestEditor as a delegated sub-editor (same pattern as
 * GraphQLBodyEditor / RequestAuthEditor): it owns the rule list + its DOM and
 * reports every edit through the injected `onChange` callback, which the host
 * turns into the request-updated event. The scope/source options are static
 * enums, so this editor needs no variable context.
 */
"use strict";

import {
  DragReorderController,
  wireDeleteAllConfirm,
} from "../kv-editor-shared.js";
import { wireDeleteConfirm } from "../../delete-confirm.js";
import { icon } from "../../icons.js";
import { t } from "../../i18n.js";

export class CapturesEditor {
  #onChange;
  #captures = [];
  #listEl = null;
  #deleteAllCleanup = null;
  #drag = new DragReorderController({
    getItems: () => this.#captures,
    render: () => this.#renderList(),
    dispatch: () => this.#onChange?.(),
  });

  /** @param {{ onChange?: () => void }} [deps] */
  constructor({ onChange } = {}) {
    this.#onChange = onChange;
  }

  /** @returns {object[]} the normalized capture rules */
  getValue() {
    return this.#captures;
  }

  /** @param {object[]} captures */
  setValue(captures) {
    this.#captures = Array.isArray(captures)
      ? captures.map((r) => this.#normalizeRule(r))
      : [];
    this.#renderList();
  }

  /** Cancel any in-progress inline confirm on the Delete All button. */
  cancelPendingDeleteAll() {
    this.#deleteAllCleanup?.();
  }

  /** Build (or rebuild) the Captures tab-pane element. */
  build() {
    const container = document.createElement("div");
    container.className = "params-editor captures-editor";

    // Toolbar — Add + Delete All (mirrors the KV editors' toolbar).
    const toolbar = document.createElement("div");
    toolbar.className = "params-toolbar";

    const addBtn = document.createElement("button");
    addBtn.className = "icon-btn params-toolbar-btn";
    addBtn.title = t("request.captures.add");
    addBtn.setAttribute("aria-label", t("request.captures.add"));
    addBtn.innerHTML = `<span class="icon">${icon("add", { size: 15 })}</span>`;
    addBtn.addEventListener("click", () => this.#add());

    const delAllBtn = document.createElement("button");
    delAllBtn.className =
      "params-toolbar-btn params-toolbar-btn--danger params-delete-all-btn";
    delAllBtn.title = t("request.captures.deleteAll");
    delAllBtn.setAttribute("aria-label", t("request.captures.deleteAll"));
    delAllBtn.textContent = t("kv.deleteAll");
    this.#deleteAllCleanup = wireDeleteAllConfirm(
      delAllBtn,
      () => this.#captures.length,
      () => this.#deleteAll(),
    );

    toolbar.appendChild(addBtn);
    toolbar.appendChild(delAllBtn);
    container.appendChild(toolbar);

    // Explainer — static, developer-authored copy.
    const hint = document.createElement("div");
    hint.className = "captures-hint";
    hint.textContent = t("request.captures.hint");
    container.appendChild(hint);

    // Column headers + scrollable list.
    const wrap = document.createElement("div");
    wrap.style.cssText =
      "display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden";

    const colHeaders = document.createElement("div");
    colHeaders.className = "params-header-row captures-header-row";
    colHeaders.innerHTML = `
      <span class="params-col-handle"></span>
      <span class="params-col-enabled"></span>
      <span>${t("request.captures.source")}</span>
      <span>${t("request.captures.pathName")}</span>
      <span>${t("request.captures.scope")}</span>
      <span>${t("request.captures.variable")}</span>
      <span class="captures-col-secure">${t("request.captures.secret")}</span>
      <span class="params-col-delete"></span>`;
    wrap.appendChild(colHeaders);

    const list = document.createElement("div");
    list.className = "params-list captures-list";
    this.#drag.attach(list);
    this.#listEl = list;
    wrap.appendChild(list);

    container.appendChild(wrap);

    this.#renderList();
    return container;
  }

  #renderList() {
    if (!this.#listEl) return;
    this.#listEl.innerHTML = "";

    if (this.#captures.length === 0) {
      const empty = document.createElement("div");
      empty.className = "params-empty";
      empty.textContent = t("request.captures.empty");
      this.#listEl.appendChild(empty);
      return;
    }

    this.#captures.forEach((rule, index) => {
      this.#listEl.appendChild(this.#buildRow(rule, index));
    });
  }

  #buildRow(rule, index) {
    const row = document.createElement("div");
    row.className = "params-row captures-row";
    row.dataset.id = rule.id;
    row.dataset.index = String(index);
    row.draggable = true;
    if (rule.enabled === false) row.classList.add("params-row--disabled");

    // Drag handle
    const handle = document.createElement("span");
    handle.className = "params-drag-handle";
    handle.setAttribute("aria-hidden", "true");
    handle.title = t("request.dragReorder");
    handle.innerHTML = icon("drag", { width: 10, height: 16 });

    // Enabled checkbox
    const enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.className = "params-checkbox";
    enabled.checked = rule.enabled !== false;
    enabled.setAttribute("aria-label", t("request.captures.enable"));
    enabled.title = enabled.checked
      ? t("request.captures.disable")
      : t("request.captures.enable");
    enabled.addEventListener("change", () => {
      rule.enabled = enabled.checked;
      row.classList.toggle("params-row--disabled", !enabled.checked);
      enabled.title = enabled.checked
        ? t("request.captures.disable")
        : t("request.captures.enable");
      this.#onChange?.();
    });

    // Source select (Body / Header / Status)
    const source = this.#buildSelect(
      "captures-source",
      [
        { value: "body", label: t("request.captures.sourceBody") },
        { value: "header", label: t("request.captures.sourceHeader") },
        { value: "status", label: t("request.captures.sourceStatus") },
      ],
      rule.source ?? "body",
      t("request.captures.sourceAria"),
    );

    // Path / name input — meaning + placeholder depend on the source.
    const path = document.createElement("input");
    path.type = "text";
    path.className = "params-input captures-path";
    path.value = rule.path ?? "";
    path.spellcheck = false;
    path.setAttribute("aria-label", t("request.captures.pathPlaceholder"));
    const syncPath = () => {
      const s = rule.source ?? "body";
      path.disabled = s === "status";
      path.placeholder =
        s === "body" ? ".access_token" : s === "header" ? "Header-Name" : "—";
    };
    syncPath();
    path.addEventListener("input", () => {
      rule.path = path.value;
      this.#onChange?.();
    });
    source.addEventListener("change", () => {
      rule.source = source.value;
      syncPath();
      this.#onChange?.();
    });

    // Target scope select
    const scope = this.#buildSelect(
      "captures-scope",
      [
        { value: "environment", label: t("request.captures.scopeEnvironment") },
        { value: "collection", label: t("request.captures.scopeCollection") },
        { value: "global", label: t("env.global") },
      ],
      rule.target?.scope ?? "environment",
      t("request.captures.scopeAria"),
    );
    scope.addEventListener("change", () => {
      rule.target = { ...rule.target, scope: scope.value };
      this.#onChange?.();
    });

    // Target variable name
    const name = document.createElement("input");
    name.type = "text";
    name.className = "params-input captures-name";
    name.value = rule.target?.name ?? "";
    name.placeholder = t("request.captures.variablePlaceholder");
    name.spellcheck = false;
    name.setAttribute("aria-label", t("request.captures.variableAria"));
    name.addEventListener("input", () => {
      rule.target = { ...rule.target, name: name.value };
      this.#onChange?.();
    });

    // Secret toggle — a padlock button matching the variable dialogs (open
    // padlock = plaintext, closed = encrypted at rest). A distinct control from
    // the enable checkbox so the two aren't confused.
    const secure = document.createElement("button");
    secure.type = "button";
    secure.className = "icon-btn params-secure-btn captures-secure";
    const applySecure = () => {
      secure.classList.toggle("params-secure-btn--active", !!rule.secure);
      secure.innerHTML = icon(rule.secure ? "lock" : "lockOpen", { size: 14 });
      const label = rule.secure
        ? t("request.captures.secretOn")
        : t("request.captures.secretOff");
      secure.title = label;
      secure.setAttribute("aria-label", label);
      secure.setAttribute("aria-pressed", String(!!rule.secure));
    };
    applySecure();
    secure.addEventListener("click", () => {
      rule.secure = !rule.secure;
      applySecure();
      this.#onChange?.();
    });

    // Delete button (two-click confirm, shared behaviour)
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "icon-btn params-delete-btn";
    deleteBtn.title = t("request.captures.delete");
    deleteBtn.setAttribute("aria-label", t("request.captures.delete"));
    wireDeleteConfirm(deleteBtn, () => this.#remove(rule.id));

    this.#drag.wireRow(row, rule.id);

    row.appendChild(handle);
    row.appendChild(enabled);
    row.appendChild(source);
    row.appendChild(path);
    row.appendChild(scope);
    row.appendChild(name);
    row.appendChild(secure);
    row.appendChild(deleteBtn);
    return row;
  }

  /** Build a styled <select> for a capture row (no user data in option text). */
  #buildSelect(className, options, value, ariaLabel) {
    const sel = document.createElement("select");
    sel.className = `params-input ${className}`;
    sel.setAttribute("aria-label", ariaLabel);
    for (const opt of options) {
      const o = document.createElement("option");
      o.value = opt.value;
      o.textContent = opt.label;
      sel.appendChild(o);
    }
    sel.value = value;
    return sel;
  }

  #add() {
    this.#captures.push(this.#normalizeRule({}));
    this.#renderList();
    this.#onChange?.();
  }

  #deleteAll() {
    if (this.#captures.length === 0) return;
    this.#captures = [];
    this.#renderList();
    this.#onChange?.();
  }

  #remove(id) {
    this.#captures = this.#captures.filter((c) => c.id !== id);
    this.#renderList();
    this.#onChange?.();
  }

  /** Fill a stored/blank capture rule with defaults + a stable id. */
  #normalizeRule(r) {
    return {
      id: r.id ?? crypto.randomUUID(),
      enabled: r.enabled !== false,
      source: r.source ?? "body",
      path: r.path ?? "",
      target: {
        scope: r.target?.scope ?? "environment",
        name: r.target?.name ?? "",
      },
      secure: !!r.secure,
    };
  }
}
