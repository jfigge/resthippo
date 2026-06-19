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
 * pill-builders.js — shared {{ }} pill element constructors.
 *
 * VariablePillEditor and PillCodeEditor both turn a `{{name}}` / `{{fn(args)}}`
 * token into a contenteditable-false `<span>` pill with the same look, the same
 * click-to-edit popup, and (for functions) the same live preview. The two had
 * drifted independently; these builders are the single source of truth, with the
 * genuine per-editor differences passed in as options rather than copied:
 *
 *   • isReadonly()        — PillCodeEditor suppresses the edit popup while
 *       read-only; VariablePillEditor is always editable (defaults to false).
 *   • onCommit()          — the host's "value changed" hook (VPE: emitChange;
 *       PCE: emit + re-highlight). Fired after an in-place edit or a delete.
 *   • ensureResponseCaches — VPE warms response.* caches before previewing those
 *       functions; PCE passes null (the preview just runs the function).
 *   • onContextMenu(x,y,onEdit,onDelete) — VPE wires a right-click Edit/Delete
 *       menu onto pills; PCE passes null (no pill context menu).
 *
 * The element shape (tag, dataset keys, classes, title) is identical to what the
 * editors produced before, so serialization and the known/unknown styling are
 * unchanged.
 */
"use strict";

import { t } from "../i18n.js";
import {
  resolveVariable,
  parseFunctionCall,
  buildFunctionToken,
  parseFnArgs,
} from "./variable-resolver.js";
import { PillEditorPopup } from "./pill-editor-popup.js";
import { registry } from "./function-registry.js";
import { logicMap } from "./function-logic-map.js";

const TOKEN_RE = /^\{\{([^{}]+)\}\}$/;

/**
 * Build a variable pill for `{{name}}`.
 * @param {string} name
 * @param {object|null} ctx  resolved context (drives the known/unknown class)
 * @param {object} opts  { getContext, isReadonly?, onCommit, onContextMenu? }
 * @returns {HTMLSpanElement}
 */
export function makeVariablePill(name, ctx, opts) {
  const {
    getContext,
    isReadonly = () => false,
    onCommit = () => {},
    onContextMenu = null,
  } = opts;

  const span = document.createElement("span");
  span.contentEditable = "false";
  span.dataset.variable = name;
  span.textContent = name;
  span.title = `{{${name}}}`;
  const { found } = resolveVariable(name, ctx);
  span.className =
    "variable-pill " +
    (found ? "variable-pill--known" : "variable-pill--unknown");

  const openEditor = () => {
    PillEditorPopup.open({
      type: "variable",
      rawValue: `{{${span.dataset.variable}}}`,
      getContext,
      onCommit: (raw) => {
        const m = TOKEN_RE.exec(raw);
        if (!m) return;
        span.dataset.variable = m[1];
        span.textContent = m[1];
        span.title = raw;
        const { found: f } = resolveVariable(m[1], getContext());
        span.classList.toggle("variable-pill--known", f);
        span.classList.toggle("variable-pill--unknown", !f);
        onCommit();
      },
    });
  };

  span.addEventListener("click", (e) => {
    if (isReadonly()) return; // selection only; no edit popup
    e.preventDefault();
    e.stopPropagation();
    openEditor();
  });

  if (onContextMenu) {
    span.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onContextMenu(e.clientX, e.clientY, openEditor, () => {
        span.remove();
        onCommit();
      });
    });
  }

  return span;
}

/**
 * Build a function pill for `{{fn(args)}}`.
 * @param {string} name      function name (registry key)
 * @param {Array}  rawArgs   the function's raw string args
 * @param {object} opts  { getContext, getItems, ensureResponseCaches?, isReadonly?, onCommit, onContextMenu? }
 * @returns {HTMLSpanElement}
 */
export function makeFunctionPill(name, rawArgs, opts) {
  const {
    getContext,
    getItems,
    ensureResponseCaches = null,
    isReadonly = () => false,
    onCommit = () => {},
    onContextMenu = null,
  } = opts;

  const funcDef = registry[name];
  const span = document.createElement("span");
  span.contentEditable = "false";
  span.dataset.function = name;
  span.dataset.fnArgs = JSON.stringify(rawArgs);
  span.textContent = funcDef?.labelKey ? t(funcDef.labelKey) : name;
  span.title = buildFunctionToken(name, rawArgs);
  span.className = "variable-pill function-pill";

  const openEditor = () => {
    PillEditorPopup.open({
      type: "function",
      funcName: span.dataset.function,
      funcDef: registry[span.dataset.function],
      rawArgs: parseFnArgs(span.dataset.fnArgs),
      getContext,
      getItems,
      getPreview: async (args) => {
        const fn = logicMap[span.dataset.function];
        if (!fn) return null;
        const fnName = span.dataset.function;
        // Warm response.* caches before previewing those functions (host-supplied).
        if (
          ensureResponseCaches &&
          (fnName === "response" ||
            fnName === "responseHeader" ||
            fnName === "responseStatus")
        ) {
          const argName = args[0];
          if (argName) await ensureResponseCaches([argName]);
        }
        return String(await fn(args, getContext()));
      },
      onCommit: (raw) => {
        const m = TOKEN_RE.exec(raw);
        const parsed = m && parseFunctionCall(m[1]);
        if (!parsed) return;
        span.dataset.fnArgs = JSON.stringify(parsed.rawArgs);
        span.title = raw;
        onCommit();
      },
    });
  };

  span.addEventListener("click", (e) => {
    if (isReadonly()) return; // selection only; no edit popup
    e.preventDefault();
    e.stopPropagation();
    openEditor();
  });

  if (onContextMenu) {
    span.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onContextMenu(e.clientX, e.clientY, openEditor, () => {
        span.remove();
        onCommit();
      });
    });
  }

  return span;
}
