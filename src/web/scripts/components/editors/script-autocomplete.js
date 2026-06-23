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
 * script-autocomplete.js — `hippo.*` member completion for the Scripts editors
 * (Feature 25).
 *
 * A deliberately small, static completion model (no JS semantic analysis): it
 * mirrors the documented `hippo.*` API surface and offers member names as you
 * type `hippo.`, `hippo.variables.`, etc. It reuses the shared
 * `AutocompleteDropdown` widget and the PillCodeEditor host-autocomplete
 * primitives (`getCaretOffset` / `caretCoords` / `replaceRange`) — the same
 * pattern the GraphQL schema autocomplete uses. The terse signatures shown as a
 * muted hint are technical (parameter lists / types), kept literal like the
 * GraphQL schema-type hints.
 */
"use strict";

import { AutocompleteDropdown } from "../kv-editor-shared.js";

// receiver path → its members ({ name inserted verbatim, detail shown as a hint }).
const MEMBERS = {
  hippo: [
    { name: "variables", detail: "{ get, set }" },
    { name: "request", detail: "method/url/headers/body" },
    { name: "response", detail: "after-response only" },
    { name: "environment", detail: "{ name, variables }" },
    { name: "console", detail: "log/info/warn/error" },
    { name: "run", detail: '("Request") → response' },
  ],
  "hippo.variables": [
    { name: "get", detail: "(scope, name)" },
    { name: "set", detail: "(scope, name, value)" },
  ],
  "hippo.request": [
    { name: "method", detail: "string" },
    { name: "url", detail: "string" },
    { name: "headers", detail: "object" },
    { name: "body", detail: "string" },
  ],
  "hippo.response": [
    { name: "status", detail: "number" },
    { name: "headers", detail: "object" },
    { name: "body", detail: "string" },
    { name: "json", detail: "()" },
  ],
  "hippo.console": [
    { name: "log", detail: "(...args)" },
    { name: "info", detail: "(...args)" },
    { name: "warn", detail: "(...args)" },
    { name: "error", detail: "(...args)" },
  ],
  "hippo.environment": [
    { name: "name", detail: "string" },
    { name: "variables", detail: "object" },
  ],
};

/**
 * Completions for the caret at `pos` in `text`.
 * @returns {{ items: Array<{name,detail}>, from: number } | null}
 *   `from` is the offset where the partial member starts (for replaceRange).
 */
export function suggestHippo(text, pos) {
  const before = text.slice(0, Math.max(0, pos));

  // Member access: <receiver chain>.<partial>
  const dotted =
    /([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\.([A-Za-z_$][\w$]*)?$/.exec(
      before,
    );
  if (dotted) {
    const receiver = dotted[1].replace(/\s+/g, "");
    const partial = dotted[2] || "";
    const members = MEMBERS[receiver];
    if (members) {
      const items = members.filter((m) => m.name.startsWith(partial));
      if (items.length) return { items, from: pos - partial.length };
    }
    return null;
  }

  // Bare identifier prefix → offer the top-level `hippo` once there are ≥2 chars.
  const ident = /(^|[^\w$.])([A-Za-z_$][\w$]*)$/.exec(before);
  if (ident) {
    const partial = ident[2];
    if (
      partial.length >= 2 &&
      "hippo".startsWith(partial) &&
      partial !== "hippo"
    )
      return {
        items: [{ name: "hippo", detail: "scripting API" }],
        from: pos - partial.length,
      };
  }
  return null;
}

// One shared dropdown + off-screen caret anchor for all script panes.
const _ac = new AutocompleteDropdown(
  "hdr-autocomplete script-autocomplete",
  "Script suggestions",
);
// The editor that opened the currently-visible dropdown — so a sibling pane's
// keydown can't drive (or insert from) a dropdown anchored to the other pane.
let _owner = null;
let _anchor = null;
function _anchorAt({ left, top, height }) {
  if (!_anchor) {
    _anchor = document.createElement("div");
    _anchor.className = "script-caret-anchor";
    _anchor.setAttribute("aria-hidden", "true");
    document.body.appendChild(_anchor);
  }
  const s = _anchor.style;
  s.position = "fixed";
  s.width = "0";
  s.pointerEvents = "none";
  s.left = `${left}px`;
  s.top = `${top}px`;
  s.height = `${height}px`;
  return _anchor;
}

function apply(editor, label) {
  const pos = editor.getCaretOffset();
  if (pos < 0) {
    _ac.hide();
    return;
  }
  const before = editor.getValue().slice(0, pos);
  const m = /[A-Za-z_$][\w$]*$/.exec(before);
  const start = m ? pos - m[0].length : pos;
  editor.replaceRange(start, pos, label);
  _ac.hide();
}

/**
 * Wire `hippo.*` autocomplete onto a PillCodeEditor. Sets `editor._hippoRefresh`
 * (call it from the editor's onInput/onCaret) and installs the keyboard + blur
 * handling. Defers to the editor's own `{{` variable picker when that is open.
 * @param {object} editor a PillCodeEditor instance
 */
export function wireScriptAutocomplete(editor) {
  const show = () => {
    if (editor.isPickerOpen()) return _ac.hide();
    const pos = editor.getCaretOffset();
    if (pos < 0) return _ac.hide();
    const res = suggestHippo(editor.getValue(), pos);
    const coords = res ? editor.caretCoords() : null;
    if (!res || !coords) return _ac.hide();
    _owner = editor;
    _ac.show(_anchorAt(coords), res.items, (label) => apply(editor, label), {
      minWidth: 220,
      renderItem: (item, entry) => {
        item.dataset.value = entry.name;
        item.innerHTML = "";
        const name = document.createElement("span");
        name.className = "script-ac-name";
        name.textContent = entry.name;
        item.appendChild(name);
        if (entry.detail) {
          const d = document.createElement("span");
          d.className = "script-ac-detail";
          d.textContent = entry.detail;
          item.appendChild(d);
        }
      },
    });
  };

  let timer = null;
  editor._hippoRefresh = () => {
    clearTimeout(timer);
    if (_ac.visible) show();
    else timer = setTimeout(show, 120);
  };

  editor.element.addEventListener(
    "keydown",
    (e) => {
      if (!_ac.visible || _owner !== editor || editor.isPickerOpen()) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        _ac.navigate(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        _ac.navigate(-1);
      } else if (e.key === "Escape") {
        e.preventDefault();
        _ac.hide();
      } else if (e.key === "Enter" || e.key === "Tab") {
        const label = _ac.activeLabel();
        if (label !== null) {
          e.preventDefault();
          apply(editor, label);
        }
      }
    },
    true,
  );

  editor.element.addEventListener("focusout", () => {
    clearTimeout(timer);
    _ac.scheduleHide();
  });
}
