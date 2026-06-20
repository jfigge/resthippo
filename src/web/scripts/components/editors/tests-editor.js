/*
 * Copyright 2026 Jason Figge
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * tests-editor.js — the Tests request tab (Feature 29), no-code assertions grid.
 *
 * Each row is a declarative assertion: a source (status / response time / header
 * / body / JSON-path value), a matcher (equals, contains, exists, less than, …)
 * and an expected value. After a response arrives, app.js hands these rows to
 * the after-response sandbox (the SAME runtime as the Scripts tab — no second
 * scripting path), which compiles each row to the shared matcher engine and
 * records a pass/fail. This tab edits the rows only; execution lives in the
 * sandbox (src/app/scripting/sandbox.js).
 *
 * Modelled on CapturesEditor: a delegated sub-editor that owns its row list +
 * DOM and reports every edit through the injected `onChange` callback, which the
 * host (RequestEditor) turns into the request-updated event.
 */
"use strict";

import {
  DragReorderController,
  wireDeleteAllConfirm,
} from "../kv-editor-shared.js";
import { wireDeleteConfirm } from "../../delete-confirm.js";
import { icon } from "../../icons.js";
import { t } from "../../i18n.js";

/** i18n label key per assertion source token. */
const SOURCE_LABELKEY = {
  status: "request.tests.sourceStatus",
  responseTime: "request.tests.sourceTime",
  header: "request.tests.sourceHeader",
  body: "request.tests.sourceBody",
  json: "request.tests.sourceJson",
};

/** i18n label key per matcher token. */
const MATCHER_LABELKEY = {
  equals: "request.tests.matcherEquals",
  notEquals: "request.tests.matcherNotEquals",
  contains: "request.tests.matcherContains",
  notContains: "request.tests.matcherNotContains",
  exists: "request.tests.matcherExists",
  notExists: "request.tests.matcherNotExists",
  lessThan: "request.tests.matcherLessThan",
  greaterThan: "request.tests.matcherGreaterThan",
  matches: "request.tests.matcherMatches",
};

/** Matchers that ignore the expected value (the input is disabled for these). */
const NO_EXPECTED = new Set(["exists", "notExists"]);

/**
 * Build a localized, human-readable label for an assertion row — used both as
 * the result `name` shown in the response Tests tab and for accessibility. Built
 * from the same localized option strings the grid shows, so it follows the UI
 * language. Exported so app.js can name each result before handing rows to the
 * sandbox (which stays language-agnostic).
 * @param {object} rule
 * @returns {string}
 */
export function assertionLabel(rule) {
  const src = rule?.source ?? "status";
  const matcher = rule?.matcher ?? "equals";
  const expected = rule?.expected ?? "";
  let field;
  if (src === "header") {
    field = `${t("request.tests.sourceHeader")} ${rule?.name ?? ""}`.trim();
  } else if (src === "json") {
    field = rule?.name ? String(rule.name) : t("request.tests.sourceJson");
  } else {
    field = t(SOURCE_LABELKEY[src] ?? SOURCE_LABELKEY.status);
  }
  const op = t(MATCHER_LABELKEY[matcher] ?? MATCHER_LABELKEY.equals);
  return NO_EXPECTED.has(matcher)
    ? `${field} ${op}`
    : `${field} ${op} ${expected}`.trimEnd();
}

export class TestsEditor {
  #onChange;
  #assertions = [];
  #listEl = null;
  #deleteAllCleanup = null;
  #drag = new DragReorderController({
    getItems: () => this.#assertions,
    render: () => this.#renderList(),
    dispatch: () => this.#onChange?.(),
  });

  /** @param {{ onChange?: () => void }} [deps] */
  constructor({ onChange } = {}) {
    this.#onChange = onChange;
  }

  /** @returns {object[]} the normalized assertion rows */
  getValue() {
    return this.#assertions;
  }

  /** @param {object[]} assertions */
  setValue(assertions) {
    this.#assertions = Array.isArray(assertions)
      ? assertions.map((r) => this.#normalizeRule(r))
      : [];
    this.#renderList();
  }

  /** Cancel any in-progress inline confirm on the Delete All button. */
  cancelPendingDeleteAll() {
    this.#deleteAllCleanup?.();
  }

  /** Build (or rebuild) the Tests tab-pane element. */
  build() {
    const container = document.createElement("div");
    container.className = "params-editor tests-editor";

    // Toolbar — Add + Delete All (mirrors the KV / Captures editors' toolbar).
    const toolbar = document.createElement("div");
    toolbar.className = "params-toolbar";

    const addBtn = document.createElement("button");
    addBtn.className = "icon-btn params-toolbar-btn";
    addBtn.title = t("request.tests.add");
    addBtn.setAttribute("aria-label", t("request.tests.add"));
    addBtn.innerHTML = `<span class="icon">${icon("add", { size: 15 })}</span>`;
    addBtn.addEventListener("click", () => this.#add());

    const delAllBtn = document.createElement("button");
    delAllBtn.className =
      "params-toolbar-btn params-toolbar-btn--danger params-delete-all-btn";
    delAllBtn.title = t("request.tests.deleteAll");
    delAllBtn.setAttribute("aria-label", t("request.tests.deleteAll"));
    delAllBtn.textContent = t("kv.deleteAll");
    this.#deleteAllCleanup = wireDeleteAllConfirm(
      delAllBtn,
      () => this.#assertions.length,
      () => this.#deleteAll(),
    );

    toolbar.appendChild(addBtn);
    toolbar.appendChild(delAllBtn);
    container.appendChild(toolbar);

    // Explainer — static, developer-authored copy.
    const hint = document.createElement("div");
    hint.className = "captures-hint";
    hint.textContent = t("request.tests.hint");
    container.appendChild(hint);

    // Column headers + scrollable list.
    const wrap = document.createElement("div");
    wrap.style.cssText =
      "display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden";

    const colHeaders = document.createElement("div");
    colHeaders.className = "params-header-row tests-header-row";
    colHeaders.innerHTML = `
      <span class="params-col-handle"></span>
      <span class="params-col-enabled"></span>
      <span>${t("request.tests.source")}</span>
      <span>${t("request.tests.target")}</span>
      <span>${t("request.tests.matcher")}</span>
      <span>${t("request.tests.expected")}</span>
      <span class="params-col-delete"></span>`;
    wrap.appendChild(colHeaders);

    const list = document.createElement("div");
    list.className = "params-list tests-list";
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

    if (this.#assertions.length === 0) {
      const empty = document.createElement("div");
      empty.className = "params-empty";
      empty.textContent = t("request.tests.empty");
      this.#listEl.appendChild(empty);
      return;
    }

    this.#assertions.forEach((rule, index) => {
      this.#listEl.appendChild(this.#buildRow(rule, index));
    });
  }

  #buildRow(rule, index) {
    const row = document.createElement("div");
    row.className = "params-row tests-row";
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
    enabled.setAttribute("aria-label", t("request.tests.enable"));
    enabled.title = enabled.checked
      ? t("request.tests.disable")
      : t("request.tests.enable");
    enabled.addEventListener("change", () => {
      rule.enabled = enabled.checked;
      row.classList.toggle("params-row--disabled", !enabled.checked);
      enabled.title = enabled.checked
        ? t("request.tests.disable")
        : t("request.tests.enable");
      this.#onChange?.();
    });

    // Source select
    const source = this.#buildSelect(
      "tests-source",
      [
        { value: "status", label: t("request.tests.sourceStatus") },
        { value: "responseTime", label: t("request.tests.sourceTime") },
        { value: "header", label: t("request.tests.sourceHeader") },
        { value: "body", label: t("request.tests.sourceBody") },
        { value: "json", label: t("request.tests.sourceJson") },
      ],
      rule.source ?? "status",
      t("request.tests.sourceAria"),
    );

    // Target input — header name or JSON path; disabled for the other sources.
    const target = document.createElement("input");
    target.type = "text";
    target.className = "params-input tests-target";
    target.value = rule.name ?? "";
    target.spellcheck = false;
    target.setAttribute("aria-label", t("request.tests.targetAria"));
    const syncTarget = () => {
      const s = rule.source ?? "status";
      const needsTarget = s === "header" || s === "json";
      target.disabled = !needsTarget;
      target.placeholder = !needsTarget
        ? "—"
        : s === "header"
          ? "Header-Name"
          : "$.data.id";
    };
    syncTarget();
    target.addEventListener("input", () => {
      rule.name = target.value;
      this.#onChange?.();
    });

    // Matcher select
    const matcher = this.#buildSelect(
      "tests-matcher",
      [
        { value: "equals", label: t("request.tests.matcherEquals") },
        { value: "notEquals", label: t("request.tests.matcherNotEquals") },
        { value: "contains", label: t("request.tests.matcherContains") },
        { value: "notContains", label: t("request.tests.matcherNotContains") },
        { value: "exists", label: t("request.tests.matcherExists") },
        { value: "notExists", label: t("request.tests.matcherNotExists") },
        { value: "lessThan", label: t("request.tests.matcherLessThan") },
        { value: "greaterThan", label: t("request.tests.matcherGreaterThan") },
        { value: "matches", label: t("request.tests.matcherMatches") },
      ],
      rule.matcher ?? "equals",
      t("request.tests.matcherAria"),
    );

    // Expected value — disabled for exists / not exists.
    const expected = document.createElement("input");
    expected.type = "text";
    expected.className = "params-input tests-expected";
    expected.value = rule.expected ?? "";
    expected.spellcheck = false;
    expected.setAttribute("aria-label", t("request.tests.expectedAria"));
    const syncExpected = () => {
      const needsExpected = !NO_EXPECTED.has(rule.matcher ?? "equals");
      expected.disabled = !needsExpected;
      expected.placeholder = needsExpected
        ? t("request.tests.expectedPlaceholder")
        : "—";
    };
    syncExpected();
    expected.addEventListener("input", () => {
      rule.expected = expected.value;
      this.#onChange?.();
    });

    source.addEventListener("change", () => {
      rule.source = source.value;
      syncTarget();
      this.#onChange?.();
    });
    matcher.addEventListener("change", () => {
      rule.matcher = matcher.value;
      syncExpected();
      this.#onChange?.();
    });

    // Delete button (two-click confirm, shared behaviour)
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "icon-btn params-delete-btn";
    deleteBtn.title = t("request.tests.delete");
    deleteBtn.setAttribute("aria-label", t("request.tests.delete"));
    wireDeleteConfirm(deleteBtn, () => this.#remove(rule.id));

    this.#drag.wireRow(row, rule.id);

    row.appendChild(handle);
    row.appendChild(enabled);
    row.appendChild(source);
    row.appendChild(target);
    row.appendChild(matcher);
    row.appendChild(expected);
    row.appendChild(deleteBtn);
    return row;
  }

  /** Build a styled <select> for a row (no user data in option text). */
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
    this.#assertions.push(this.#normalizeRule({}));
    this.#renderList();
    this.#onChange?.();
  }

  #deleteAll() {
    if (this.#assertions.length === 0) return;
    this.#assertions = [];
    this.#renderList();
    this.#onChange?.();
  }

  #remove(id) {
    this.#assertions = this.#assertions.filter((c) => c.id !== id);
    this.#renderList();
    this.#onChange?.();
  }

  /** Fill a stored/blank assertion row with defaults + a stable id. */
  #normalizeRule(r) {
    return {
      id: r.id ?? crypto.randomUUID(),
      enabled: r.enabled !== false,
      source: r.source ?? "status",
      name: r.name ?? "",
      matcher: r.matcher ?? "equals",
      expected: r.expected ?? "",
    };
  }
}
