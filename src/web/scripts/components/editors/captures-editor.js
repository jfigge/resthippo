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
 * captures-editor.js — the Captures request tab (Feature 03).
 *
 * Post-response rules: when a response matches a rule's response-code selector
 * (groups / specific codes / "any"; default 2xx), app.js extracts a value
 * (status / header / body dot-path) and writes it into the chosen variable
 * scope. This tab edits the rules; execution lives in app.js + captures.js.
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
import { PopupManager } from "../../popup-manager.js";
import {
  STATUS_GROUPS,
  STATUS_ANY,
  isCodeToken,
  normalizeStatusMatch,
} from "../status-match.js";

/** i18n label key per status group token (the "Nxx" buckets). */
const STATUS_GROUP_LABELKEY = {
  "1xx": "request.captures.statusG1xx",
  "2xx": "request.captures.statusG2xx",
  "3xx": "request.captures.statusG3xx",
  "4xx": "request.captures.statusG4xx",
  "5xx": "request.captures.statusG5xx",
};

export class CapturesEditor {
  #onChange;
  #captures = [];
  #listEl = null;
  #deleteAllCleanup = null;
  #statusMenu = null;
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
      <span>${t("request.captures.codes")}</span>
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

    // Response-code selector — a dropdown trigger showing a short summary of the
    // codes this rule fires on (groups + specific codes). Opening it builds the
    // checklist menu (see #openStatusMenu).
    const status = document.createElement("button");
    status.type = "button";
    status.className = "params-input captures-status";
    const syncStatus = () => this.#applyStatusTrigger(status, rule);
    syncStatus();
    status.addEventListener("click", () => this.#openStatusMenu(status, rule));

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
    row.appendChild(status);
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

  // ── Response-code selector ─────────────────────────────────────────────────

  /** A short, column-friendly summary of a rule's status selector. */
  #statusSummary(tokens) {
    if (tokens.length === 0) return t("request.captures.statusNone");
    if (tokens.includes(STATUS_ANY))
      return t("request.captures.statusAnyShort");
    if (tokens.length === 1) return tokens[0];
    if (tokens.length === 2) return `${tokens[0]}, ${tokens[1]}`;
    return `${tokens[0]} +${tokens.length - 1}`;
  }

  /** Paint a status trigger button from its rule's current selector. */
  #applyStatusTrigger(btn, rule) {
    const tokens = normalizeStatusMatch(rule.status);
    const summary = this.#statusSummary(tokens);
    // summary is built from validated status tokens, but set it via textContent
    // so this trigger can never become an injection sink; the caret is our own
    // trusted icon SVG.
    const text = document.createElement("span");
    text.className = "captures-status-text";
    text.textContent = summary;
    const caret = document.createElement("span");
    caret.className = "captures-status-caret";
    caret.setAttribute("aria-hidden", "true");
    caret.innerHTML = icon("chevronDown", { size: 12 });
    btn.replaceChildren(text, caret);
    const full = tokens.length
      ? tokens.join(", ")
      : t("request.captures.statusNone");
    const label = `${t("request.captures.codesAria")}: ${full}`;
    btn.title = label;
    btn.setAttribute("aria-label", label);
    if (tokens.length === 0) btn.classList.add("captures-status--empty");
    else btn.classList.remove("captures-status--empty");
  }

  /** Open the checklist dropdown that edits a rule's status selector. */
  #openStatusMenu(trigger, rule) {
    // The page-covering mask normally prevents a second trigger click, but guard
    // anyway so we never stack two menus on the single popup slot.
    if (this.#statusMenu) return;

    const menu = document.createElement("div");
    menu.className = "captures-status-menu";
    menu.setAttribute("role", "group");
    menu.setAttribute("aria-label", t("request.captures.codesAria"));

    // Mutate the rule, repaint the trigger + this menu, and notify the host.
    const commit = (tokens, focusAdd = false) => {
      rule.status = normalizeStatusMatch(tokens);
      this.#applyStatusTrigger(trigger, rule);
      this.#onChange?.();
      renderMenu(focusAdd);
    };

    const renderMenu = (focusAdd = false) => {
      const tokens = normalizeStatusMatch(rule.status);
      const isAny = tokens.includes(STATUS_ANY);
      const codes = tokens.filter((tok) => isCodeToken(tok));
      menu.innerHTML = "";

      // "Any status"
      menu.appendChild(
        this.#buildStatusOption(
          t("request.captures.statusAny"),
          null,
          isAny,
          false,
          (on) => commit(on ? [STATUS_ANY] : []),
        ),
      );

      const sep1 = document.createElement("div");
      sep1.className = "captures-status-sep";
      menu.appendChild(sep1);

      // Group buckets (1xx–5xx) — disabled while "Any" is on.
      for (const group of STATUS_GROUPS) {
        const checked = tokens.includes(group.token);
        menu.appendChild(
          this.#buildStatusOption(
            t(STATUS_GROUP_LABELKEY[group.token]),
            group.token,
            checked,
            isAny,
            (on) => {
              const next = tokens.filter(
                (tok) => tok !== group.token && tok !== STATUS_ANY,
              );
              if (on) next.push(group.token);
              commit(next);
            },
          ),
        );
      }

      const sep2 = document.createElement("div");
      sep2.className = "captures-status-sep";
      menu.appendChild(sep2);

      // Specific-code chips.
      if (codes.length) {
        const chips = document.createElement("div");
        chips.className = "captures-status-chips";
        for (const code of codes) {
          const chip = document.createElement("span");
          chip.className = "captures-status-chip";
          const text = document.createElement("span");
          text.textContent = code;
          const rm = document.createElement("button");
          rm.type = "button";
          rm.className = "captures-status-chip-remove";
          rm.innerHTML = icon("close", { size: 10 });
          const rmLabel = t("request.captures.statusRemove", { code });
          rm.title = rmLabel;
          rm.setAttribute("aria-label", rmLabel);
          rm.addEventListener("click", () =>
            commit(tokens.filter((tok) => tok !== code)),
          );
          chip.appendChild(text);
          chip.appendChild(rm);
          chips.appendChild(chip);
        }
        menu.appendChild(chips);
      }

      // Add-a-code row — disabled while "Any" is on.
      const addRow = document.createElement("div");
      addRow.className = "captures-status-add";
      const addInput = document.createElement("input");
      addInput.type = "text";
      addInput.inputMode = "numeric";
      addInput.maxLength = 3;
      addInput.className = "params-input captures-status-add-input";
      addInput.placeholder = t("request.captures.statusAddPlaceholder");
      addInput.setAttribute("aria-label", t("request.captures.statusAdd"));
      addInput.disabled = isAny;
      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "icon-btn captures-status-add-btn";
      addBtn.title = t("request.captures.statusAdd");
      addBtn.setAttribute("aria-label", t("request.captures.statusAdd"));
      addBtn.innerHTML = `<span class="icon">${icon("add", { size: 13 })}</span>`;
      addBtn.disabled = isAny;
      const addCode = () => {
        const code = addInput.value.trim();
        if (!isCodeToken(code)) return;
        commit([...tokens.filter((tok) => tok !== STATUS_ANY), code], true);
      };
      addInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          addCode();
        }
      });
      addBtn.addEventListener("click", addCode);
      addRow.appendChild(addInput);
      addRow.appendChild(addBtn);
      menu.appendChild(addRow);

      if (focusAdd && !isAny) addInput.focus();
    };

    renderMenu();

    const rect = trigger.getBoundingClientRect();
    PopupManager.openMenu(menu, rect.left, rect.bottom + 4);
    this.#statusMenu = menu;
    window.addEventListener(
      "hippo:popup-closed",
      () => {
        this.#statusMenu = null;
      },
      { once: true },
    );
  }

  /** A single checkbox row in the status dropdown. */
  #buildStatusOption(label, code, checked, disabled, onToggle) {
    const row = document.createElement("label");
    row.className = "captures-status-opt";
    if (disabled) row.classList.add("captures-status-opt--disabled");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = checked;
    box.disabled = disabled;
    box.addEventListener("change", () => onToggle(box.checked));
    const text = document.createElement("span");
    text.className = "captures-status-opt-label";
    if (code) {
      const codeEl = document.createElement("span");
      codeEl.className = "captures-status-opt-code";
      codeEl.textContent = code;
      text.appendChild(codeEl);
    }
    text.appendChild(document.createTextNode(label));
    row.appendChild(box);
    row.appendChild(text);
    return row;
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
      // Response-code selector; absent → 2xx (preserves pre-feature behaviour).
      status: normalizeStatusMatch(r.status),
    };
  }
}
