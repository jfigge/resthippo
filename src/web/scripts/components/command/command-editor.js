/*
 * Copyright 2026 Jason Figge
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * This file is part of Rest Hippo.
 *
 * Rest Hippo is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option) any later
 * version.
 *
 * Rest Hippo is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR
 * A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with
 * Rest Hippo. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * components/command/command-editor.js — the Command request editor surface
 * (Feature 70), hosted by RequestEditor when `node.protocol === "command"`.
 *
 * Mirrors the REST layout:
 *   URL bar      → command line (VariablePillEditor) + CMD/output-type badge +
 *                  the shared Execute split button (built by the host)
 *   Params tab   → Arguments  (two-way synced with the command line)
 *   Headers tab  → Environment (rows merged over Settings → Commands)
 *   Body tab     → Stdin
 *
 * The command line is canonical; the Arguments rows are derived from its tokens
 * (command-line.js) and edits re-serialise only the token that changed.
 *
 * Owns its state and DOM; reports field edits to the host through `onChange`
 * (persisted as `hippo:request-updated`). Edits the user types also approve the
 * new command template locally (see command-approval.js / ipc/command.js).
 */

"use strict";

import { VariablePillEditor } from "../variable-pill-editor.js";
import { resolveStringAsync } from "../variable-resolver.js";
import { PopupManager } from "../../popup-manager.js";
import { icon } from "../../icons.js";
import { t } from "../../i18n.js";
import {
  DragReorderController,
  buildKvRow,
  wireDeleteAllConfirm,
  disposePillEditors,
} from "../kv-editor-shared.js";
import { tokenize, setArgs } from "./command-line.js";
import { commandsAvailable as _available } from "./availability.js";
import {
  OUTPUT_TYPES,
  commandTemplate,
  rendererPlatform,
} from "./command-exec.js";

/** Typing pause before the executable is looked up on the PATH. */
export const EXE_CHECK_DEBOUNCE_MS = 1200;
/** Debounce for auto-approving a template the user edited. */
const APPROVE_DEBOUNCE_MS = 600;
/** Refresh rate of the in-button timeout countdown. */
const COUNTDOWN_TICK_MS = 100;

/** Tabs of a Command request (labelKey resolved at render time). */
export const CMD_TABS = [
  { id: "args", labelKey: "request.tab.args" },
  { id: "env", labelKey: "request.tab.env" },
  { id: "stdin", labelKey: "request.tab.stdin" },
  { id: "captures", labelKey: "request.tab.captures" },
  { id: "tests", labelKey: "request.tab.tests" },
  { id: "scripts", labelKey: "request.tab.scripts" },
  { id: "notes", labelKey: "request.tab.notes" },
];

/** True when this build can run commands (hidden entirely under MAS). */
function commandsAvailable() {
  return _available() && !!globalThis.window?.hippo?.command;
}

const newId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `id-${Math.random().toString(36).slice(2)}`;

export class CommandEditor {
  // ── Collaborators (host-supplied) ─────────────────────────────────────────
  #getContext;
  #getItems;
  #ensureResponseCaches;
  #makeCodeEditor;
  #onChange;
  #getRequestId;

  // ── State ────────────────────────────────────────────────────────────────
  #commandLine = "";
  /** @type {{ id: string, value: string }[]} derived from #commandLine */
  #args = [];
  /** @type {{ id: string, name: string, value: string, enabled: boolean }[]} */
  #env = [];
  #stdin = "";
  #outputType = "auto";
  #timeoutMs = 0;
  /** Settings → Commands base env rows (null = not yet known). */
  #baseEnv = null;
  /** Executable lookup: null = unknown/pending, else { found, path }. */
  #exeResult = null;

  // ── DOM ──────────────────────────────────────────────────────────────────
  #lineEditor = null;
  #badgeBtn = null;
  #badgeLabel = null;
  #argsListEl = null;
  #exeInfoEl = null;
  #envListEl = null;
  #inheritedEl = null;
  #stdinEditor = null;
  #argEditors = [];
  #envEditors = [];
  #envDeleteAllCleanup = null;
  #exeTimer = null;
  #approveTimer = null;
  #exeSeq = 0;

  /** requestId → { start, timeoutMs } for runs in flight (countdown source). */
  #runs = new Map();
  #countdownTimer = null;

  #argsDrag = new DragReorderController({
    getItems: () => this.#args,
    render: () => this.#renderArgs(),
    dispatch: () => this.#commitArgs(),
  });
  #envDrag = new DragReorderController({
    getItems: () => this.#env,
    render: () => this.#renderEnv(),
    dispatch: () => this.#commitEnv(),
  });

  /**
   * @param {object} o
   * @param {() => object} o.getContext            variable-resolution context
   * @param {() => object[]} o.getItems            request items (pill pickers)
   * @param {(names: string[]) => Promise} [o.ensureResponseCaches]
   * @param {(opts: object) => object} o.makeCodeEditor  host's PillCodeEditor factory
   * @param {(partial: object) => void} o.onChange  persist edited fields
   * @param {() => string|null} o.getRequestId      the loaded request id
   */
  constructor({
    getContext,
    getItems,
    ensureResponseCaches,
    makeCodeEditor,
    onChange,
    getRequestId,
  }) {
    this.#getContext = getContext;
    this.#getItems = getItems;
    this.#ensureResponseCaches = ensureResponseCaches;
    this.#makeCodeEditor = makeCodeEditor;
    this.#onChange = onChange;
    this.#getRequestId = getRequestId;

    // Track run start times for the timeout countdown. Registered once (the
    // editor is an app-lifetime singleton, like its host).
    window.addEventListener("hippo:request-loading", (e) => {
      const rid = e.detail?.requestId;
      if (rid == null || rid !== this.#getRequestId()) return;
      if (!this.#isCommandLoaded) return;
      this.#runs.set(rid, { start: Date.now(), timeoutMs: this.#timeoutMs });
    });
    const settle = (e) => this.#runs.delete(e.detail?.requestId);
    window.addEventListener("hippo:response-received", settle);
    window.addEventListener("hippo:request-error", settle);
  }

  /** Set by the host while a command request is the loaded request. */
  #isCommandLoaded = false;
  set active(v) {
    this.#isCommandLoaded = !!v;
    if (!v) this.#stopCountdown();
  }

  // ── Public API ───────────────────────────────────────────────────────────

  get commandLine() {
    return this.#commandLine;
  }
  get timeoutMs() {
    return this.#timeoutMs;
  }

  /** Persist a new per-request timeout (0 = none). */
  setTimeoutMs(ms) {
    this.#timeoutMs = Math.max(0, Math.round(Number(ms) || 0));
    this.#onChange({ commandTimeoutMs: this.#timeoutMs });
  }

  /** The request fields as the send path / descriptor builder reads them. */
  toNode(id) {
    return {
      id,
      protocol: "command",
      commandLine: this.#commandLine,
      commandEnv: this.#env.map((r) => ({ ...r })),
      commandStdin: this.#stdin,
      commandOutputType: this.#outputType,
      commandTimeoutMs: this.#timeoutMs,
    };
  }

  /** Populate from a request node. Never approves (only user edits do). */
  load(node) {
    clearTimeout(this.#approveTimer);
    this.#commandLine = String(node.commandLine ?? "");
    this.#args = this.#deriveArgs(this.#commandLine, []);
    this.#env = Array.isArray(node.commandEnv)
      ? node.commandEnv.map((r) => ({
          id: r.id ?? newId(),
          name: String(r.name ?? r.key ?? ""),
          value: String(r.value ?? ""),
          enabled: r.enabled !== false,
        }))
      : [];
    this.#stdin = String(node.commandStdin ?? "");
    this.#outputType = OUTPUT_TYPES.includes(node.commandOutputType)
      ? node.commandOutputType
      : "auto";
    this.#timeoutMs = Math.max(0, Number(node.commandTimeoutMs) || 0);
    this.#envDeleteAllCleanup?.();

    this.#lineEditor?.setValue(this.#commandLine);
    this.#syncBadge();
    this.#renderArgs();
    this.#renderEnv();
    this.#stdinEditor?.setValue(this.#stdin);
    this.#exeResult = null;
    this.#applyExeState();
    this.#scheduleExeCheck(0);
  }

  /** Settings changed: refresh the inherited base environment. */
  applySettings(settings) {
    const rows = settings?.commandBaseEnv;
    if (Array.isArray(rows)) {
      this.#baseEnv = rows;
      this.#renderInherited();
    } else if (commandsAvailable()) {
      // null → the platform defaults, computed by the main process.
      window.hippo.command
        ?.defaults?.()
        .then((r) => {
          this.#baseEnv = Array.isArray(r?.rows) ? r.rows : [];
          this.#renderInherited();
        })
        .catch(() => {});
    }
    this.#scheduleExeCheck(0);
  }

  /** The variable context changed (environment/profile): re-check the PATH. */
  contextChanged() {
    this.#scheduleExeCheck(0);
  }

  /** Destroy pill editors / timers before the host wipes the DOM. */
  dispose() {
    this.#lineEditor?.destroy();
    this.#lineEditor = null;
    disposePillEditors(this.#argEditors);
    disposePillEditors(this.#envEditors);
    this.#argEditors = [];
    this.#envEditors = [];
    this.#envDeleteAllCleanup?.();
    this.#argsDrag.reset();
    this.#envDrag.reset();
    clearTimeout(this.#exeTimer);
    this.#stopCountdown();
    this.#badgeBtn = this.#badgeLabel = null;
    this.#argsListEl = this.#exeInfoEl = null;
    this.#envListEl = this.#inheritedEl = null;
    this.#stdinEditor = null;
  }

  // ── Command bar ──────────────────────────────────────────────────────────

  /**
   * Build the command bar (replaces the URL bar).
   * @param {object} o
   * @param {HTMLElement} o.sendGroup   the host's split Execute control
   * @param {() => void} o.onEnter      Enter in the command line → execute
   * @returns {{ bar: HTMLElement, lineEditor: VariablePillEditor }}
   */
  buildBar({ sendGroup, onEnter }) {
    this.#lineEditor?.destroy();
    const bar = document.createElement("div");
    bar.className = "req-url-bar";
    const row = document.createElement("div");
    row.className = "req-url-bar-row";

    // CMD badge doubling as the output-type picker (the method-menu analogue).
    const badge = document.createElement("button");
    badge.type = "button";
    badge.className = "req-method-select req-method-select--cmd";
    badge.dataset.method = "cmd";
    badge.setAttribute("aria-haspopup", "listbox");
    const label = document.createElement("span");
    label.className = "req-method-select-label";
    badge.appendChild(label);
    badge.insertAdjacentHTML(
      "beforeend",
      icon("caret", { size: null, className: "req-method-select-chevron" }),
    );
    badge.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      this.#openOutputMenu(badge);
    });
    this.#badgeBtn = badge;
    this.#badgeLabel = label;
    this.#syncBadge();

    const lineEditor = new VariablePillEditor({
      placeholder: t("request.cmd.linePlaceholder"),
      ariaLabel: t("request.cmd.lineAria"),
      className: "req-url-input cmd-line-input",
      getContext: () => this.#getContext(),
      getItems: () => this.#getItems(),
      ensureResponseCaches: (names) => this.#ensureResponseCaches?.(names),
      onInput: (v) => this.#onLineInput(v),
      onEnter,
    });
    lineEditor.setValue(this.#commandLine);
    this.#lineEditor = lineEditor;

    if (!commandsAvailable()) {
      const btn = sendGroup.querySelector(".req-send-btn");
      if (btn) {
        btn.disabled = true;
        btn.title = t("request.cmd.unavailable");
      }
    }

    row.append(badge, lineEditor.element, sendGroup);
    bar.appendChild(row);
    if (!commandsAvailable()) {
      const note = document.createElement("div");
      note.className = "cmd-unavailable";
      note.setAttribute("role", "note");
      note.textContent = t("request.cmd.unavailable");
      bar.appendChild(note);
    }
    this.#applyExeState();
    return { bar, lineEditor };
  }

  #syncBadge() {
    if (!this.#badgeBtn) return;
    const type = this.#outputType;
    this.#badgeLabel.textContent =
      type === "auto"
        ? t("request.cmd.badge")
        : `${t("request.cmd.badge")} · ${t(`request.cmd.outputShort.${type}`)}`;
    const aria = t("request.cmd.outputAria", {
      type: t(`request.cmd.output.${type}`),
    });
    this.#badgeBtn.setAttribute("aria-label", aria);
    this.#badgeBtn.title = aria;
  }

  /** Output-type dropdown (Auto / JSON / YAML / XML / Text). */
  #openOutputMenu(anchor) {
    const menu = document.createElement("div");
    menu.className = "req-method-menu cmd-output-menu";
    menu.setAttribute("role", "listbox");
    menu.setAttribute("aria-label", t("request.cmd.outputMenuTitle"));
    menu.addEventListener("mousedown", (ev) => ev.preventDefault());
    const heading = document.createElement("div");
    heading.className = "cmd-output-menu-heading";
    heading.textContent = t("request.cmd.outputMenuTitle");
    menu.appendChild(heading);
    const check = icon("check", {
      size: 12,
      className: "req-method-menu-check-icon",
    });
    for (const type of OUTPUT_TYPES) {
      const item = document.createElement("div");
      item.className = "req-method-menu-item";
      item.setAttribute("role", "option");
      const selected = type === this.#outputType;
      item.setAttribute("aria-selected", String(selected));
      if (selected) item.classList.add("req-method-menu-item--selected");
      const chk = document.createElement("span");
      chk.className = "req-method-menu-item-check";
      chk.setAttribute("aria-hidden", "true");
      chk.innerHTML = check;
      const lbl = document.createElement("span");
      lbl.className = "req-method-menu-item-label";
      lbl.textContent = t(`request.cmd.output.${type}`);
      item.append(chk, lbl);
      item.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        this.#outputType = type;
        this.#syncBadge();
        this.#onChange({ commandOutputType: type });
        PopupManager.close();
      });
      menu.appendChild(item);
    }
    const r = anchor.getBoundingClientRect();
    PopupManager.openMenu(menu, r.left, r.bottom + 4);
  }

  // ── Command line ⇄ Arguments sync ────────────────────────────────────────

  #onLineInput(value) {
    this.#commandLine = value;
    const prevExe = tokenize(this.#exeLineCache, rendererPlatform())[0]?.value;
    this.#args = this.#deriveArgs(value, this.#args);
    this.#renderArgs();
    this.#onChange({ commandLine: value });
    this.#scheduleApprove();
    const exe = tokenize(value, rendererPlatform())[0]?.value;
    if (exe !== prevExe) {
      this.#exeResult = null;
      this.#applyExeState();
      this.#scheduleExeCheck(EXE_CHECK_DEBOUNCE_MS);
    }
  }

  /** The command line the last executable check ran against. */
  #exeLineCache = "";

  /** Argument rows for a line, reusing existing row ids by position. */
  #deriveArgs(line, prev) {
    return tokenize(line, rendererPlatform())
      .slice(1)
      .map((tok, i) => ({ id: prev[i]?.id ?? newId(), value: tok.value }));
  }

  /** Re-serialise the line from the Arguments rows. */
  #commitArgs() {
    this.#commandLine = setArgs(
      this.#commandLine,
      this.#args.map((a) => a.value),
      rendererPlatform(),
    );
    this.#lineEditor?.setValue(this.#commandLine); // programmatic: no onInput
    this.#onChange({ commandLine: this.#commandLine });
    this.#scheduleApprove();
  }

  // ── Executable lookup (red highlight when not on the PATH) ───────────────

  #scheduleExeCheck(delay) {
    clearTimeout(this.#exeTimer);
    if (!commandsAvailable()) return;
    this.#exeTimer = setTimeout(() => this.#checkExecutable(), delay);
  }

  async #checkExecutable() {
    const seq = ++this.#exeSeq;
    this.#exeLineCache = this.#commandLine;
    const raw = tokenize(this.#commandLine, rendererPlatform())[0]?.value ?? "";
    if (!raw) {
      this.#exeResult = null;
      this.#applyExeState();
      return;
    }
    const ctx = this.#getContext();
    let exe = raw;
    try {
      exe = await resolveStringAsync(raw, ctx);
    } catch {
      // leave unresolved
    }
    // Unresolved variables → can't judge; stay neutral rather than cry wolf.
    if (exe.includes("{{")) {
      this.#exeResult = null;
      this.#applyExeState();
      return;
    }
    const env = [];
    for (const r of this.#env) {
      if (!r.enabled || !r.name.trim()) continue;
      let value = r.value;
      try {
        value = await resolveStringAsync(r.value, ctx);
      } catch {
        // keep raw
      }
      env.push({ key: r.name.trim(), value, enabled: true });
    }
    let res = null;
    try {
      res = await window.hippo.command.resolve({ executable: exe, env });
    } catch {
      res = null;
    }
    if (seq !== this.#exeSeq) return; // superseded by a newer check
    this.#exeResult = res ? { found: !!res.found, path: res.path, exe } : null;
    this.#applyExeState();
  }

  #applyExeState() {
    const el = this.#lineEditor?.element;
    const r = this.#exeResult;
    if (el) {
      el.classList.toggle("cmd-line-input--unresolved", r?.found === false);
      if (r?.found === false) {
        el.title = t("request.cmd.notFound", { name: r.exe });
      } else if (r?.found) {
        el.title = t("request.cmd.found", { path: r.path });
      } else {
        el.removeAttribute("title");
      }
    }
    this.#renderExeInfo();
  }

  // ── Approval of user-typed templates ─────────────────────────────────────

  /** A template the user typed approves itself (debounced). */
  #scheduleApprove() {
    clearTimeout(this.#approveTimer);
    const requestId = this.#getRequestId();
    if (!requestId || !commandsAvailable()) return;
    this.#approveTimer = setTimeout(() => {
      const template = commandTemplate(this.toNode(requestId));
      window.hippo.command.approval
        .grant({ requestId, template })
        .catch(() => {});
    }, APPROVE_DEBOUNCE_MS);
  }

  // ── Tabs ─────────────────────────────────────────────────────────────────

  /** Build a Command tab pane (`args` | `env` | `stdin`), or null. */
  buildTab(id) {
    if (id === "args") return this.#buildArgsTab();
    if (id === "env") return this.#buildEnvTab();
    if (id === "stdin") return this.#buildStdinTab();
    return null;
  }

  #toolbar({ noun, nounPlural, onAdd, getCount, onDeleteAll }) {
    const toolbar = document.createElement("div");
    toolbar.className = "params-toolbar";
    const addBtn = document.createElement("button");
    addBtn.className = "icon-btn params-toolbar-btn";
    addBtn.title = t("kv.add", { noun });
    addBtn.setAttribute("aria-label", t("kv.add", { noun }));
    addBtn.innerHTML = `<span class="icon">${icon("add", { size: 15 })}</span>`;
    addBtn.addEventListener("click", onAdd);
    const delAll = document.createElement("button");
    delAll.className =
      "params-toolbar-btn params-toolbar-btn--danger params-delete-all-btn";
    delAll.title = t("kv.deleteAllNoun", { noun: nounPlural });
    delAll.setAttribute(
      "aria-label",
      t("kv.deleteAllNoun", { noun: nounPlural }),
    );
    delAll.textContent = t("kv.deleteAll");
    const cleanup = wireDeleteAllConfirm(delAll, getCount, onDeleteAll);
    toolbar.append(addBtn, delAll);
    return { toolbar, cleanup };
  }

  #buildArgsTab() {
    const container = document.createElement("div");
    container.className = "params-editor cmd-args-editor";
    const { toolbar } = this.#toolbar({
      noun: t("request.cmd.args.noun"),
      nounPlural: t("request.cmd.args.nounPlural"),
      onAdd: () => {
        this.#args.push({ id: newId(), value: "" });
        this.#commitArgs();
        this.#renderArgs();
        this.#argEditors.at(-1)?.focus();
      },
      getCount: () => this.#args.length,
      onDeleteAll: () => {
        this.#args = [];
        this.#commitArgs();
        this.#renderArgs();
      },
    });
    container.appendChild(toolbar);

    const info = document.createElement("div");
    info.className = "cmd-exe-info";
    this.#exeInfoEl = info;
    container.appendChild(info);

    const list = document.createElement("div");
    list.className = "params-list";
    this.#argsDrag.attach(list);
    this.#argsListEl = list;
    container.appendChild(list);
    this.#renderExeInfo();
    this.#renderArgs();
    return container;
  }

  #renderExeInfo() {
    const el = this.#exeInfoEl;
    if (!el) return;
    const exe = tokenize(this.#commandLine, rendererPlatform())[0]?.value ?? "";
    el.replaceChildren();
    const lbl = document.createElement("span");
    lbl.className = "cmd-exe-info-label";
    lbl.textContent = t("request.cmd.args.executable");
    const val = document.createElement("code");
    val.className = "cmd-exe-info-value";
    val.textContent = exe || t("request.cmd.args.noExecutable");
    el.append(lbl, val);
    const r = this.#exeResult;
    if (r) {
      const status = document.createElement("span");
      status.className = r.found
        ? "cmd-exe-info-path"
        : "cmd-exe-info-path cmd-exe-info-path--missing";
      status.textContent = r.found
        ? `→ ${r.path}`
        : t("request.cmd.notFoundShort");
      el.appendChild(status);
    }
  }

  #renderArgs() {
    const list = this.#argsListEl;
    if (!list) return;
    // Don't rebuild under the user's caret while they edit a row.
    if (list.contains(document.activeElement) && this.#argsEditing) return;
    disposePillEditors(this.#argEditors);
    this.#argEditors = [];
    list.innerHTML = "";
    this.#renderExeInfo();
    if (this.#args.length === 0) {
      const empty = document.createElement("div");
      empty.className = "params-empty";
      empty.textContent = t("request.cmd.args.empty");
      list.appendChild(empty);
      return;
    }
    this.#args.forEach((arg, index) => {
      const pos = document.createElement("span");
      pos.className = "cmd-arg-index";
      pos.textContent = String(index + 1);
      pos.setAttribute("aria-hidden", "true");
      const editor = new VariablePillEditor({
        placeholder: t("request.cmd.args.placeholder"),
        ariaLabel: t("request.cmd.args.valueAria", { n: index + 1 }),
        className: "params-value cmd-arg-value",
        getContext: () => this.#getContext(),
        getItems: () => this.#getItems(),
        ensureResponseCaches: (names) => this.#ensureResponseCaches?.(names),
        onInput: (v) => {
          arg.value = v;
          this.#argsEditing = true;
          try {
            this.#commitArgs();
          } finally {
            this.#argsEditing = false;
          }
        },
      });
      editor.setValue(arg.value);
      this.#argEditors.push(editor);
      // buildKvRow lays out [handle][control][name][value][delete]; arguments
      // have no enable state, so the position number takes the control slot.
      const filler = document.createElement("span");
      filler.className = "cmd-arg-filler";
      list.appendChild(
        buildKvRow({
          item: arg,
          index,
          noun: t("request.cmd.args.noun"),
          name: filler,
          value: editor.element,
          drag: this.#argsDrag,
          statusIcon: pos,
          onToggle: () => {},
          onDelete: () => {
            this.#args = this.#args.filter((a) => a !== arg);
            this.#commitArgs();
            this.#renderArgs();
          },
        }),
      );
    });
  }
  #argsEditing = false;

  #buildEnvTab() {
    const container = document.createElement("div");
    container.className = "params-editor cmd-env-editor";
    const { toolbar, cleanup } = this.#toolbar({
      noun: t("request.cmd.env.noun"),
      nounPlural: t("request.cmd.env.nounPlural"),
      onAdd: () => {
        this.#env.push({ id: newId(), name: "", value: "", enabled: true });
        this.#renderEnv();
        this.#commitEnv();
        this.#envListEl
          ?.querySelector(".params-row:last-child .cmd-env-name")
          ?.focus();
      },
      getCount: () => this.#env.length,
      onDeleteAll: () => {
        this.#env = [];
        this.#renderEnv();
        this.#commitEnv();
      },
    });
    this.#envDeleteAllCleanup = cleanup;
    container.appendChild(toolbar);

    const hint = document.createElement("div");
    hint.className = "cmd-env-hint";
    hint.textContent = t("request.cmd.env.hint");
    container.appendChild(hint);

    const list = document.createElement("div");
    list.className = "params-list";
    this.#envDrag.attach(list);
    this.#envListEl = list;
    container.appendChild(list);

    const inherited = document.createElement("details");
    inherited.className = "cmd-env-inherited";
    this.#inheritedEl = inherited;
    container.appendChild(inherited);

    this.#renderEnv();
    this.#renderInherited();
    return container;
  }

  #renderEnv() {
    const list = this.#envListEl;
    if (!list) return;
    disposePillEditors(this.#envEditors);
    this.#envEditors = [];
    list.innerHTML = "";
    if (this.#env.length === 0) {
      const empty = document.createElement("div");
      empty.className = "params-empty";
      empty.textContent = t("request.cmd.env.empty");
      list.appendChild(empty);
      return;
    }
    this.#env.forEach((row, index) => {
      const name = document.createElement("input");
      name.type = "text";
      name.className = "params-name cmd-env-name";
      name.value = row.name;
      name.spellcheck = false;
      name.placeholder = t("request.cmd.env.namePlaceholder");
      name.setAttribute("aria-label", t("request.cmd.env.nameAria"));
      name.addEventListener("input", () => {
        row.name = name.value;
        this.#commitEnv();
      });
      const value = new VariablePillEditor({
        placeholder: t("kv.value"),
        ariaLabel: t("request.cmd.env.valueAria"),
        className: "params-value",
        getContext: () => this.#getContext(),
        getItems: () => this.#getItems(),
        ensureResponseCaches: (names) => this.#ensureResponseCaches?.(names),
        onInput: (v) => {
          row.value = v;
          this.#commitEnv();
        },
      });
      value.setValue(row.value);
      this.#envEditors.push(value);
      list.appendChild(
        buildKvRow({
          item: row,
          index,
          noun: t("request.cmd.env.noun"),
          name,
          value: value.element,
          drag: this.#envDrag,
          onToggle: () => this.#commitEnv(),
          onDelete: () => {
            this.#env = this.#env.filter((r) => r !== row);
            this.#renderEnv();
            this.#commitEnv();
          },
        }),
      );
    });
  }

  #commitEnv() {
    this.#onChange({ commandEnv: this.#env.map((r) => ({ ...r })) });
    this.#scheduleApprove();
    this.#scheduleExeCheck(EXE_CHECK_DEBOUNCE_MS); // a PATH row changes lookup
  }

  /** Read-only list of the Settings → Commands base environment. */
  #renderInherited() {
    const el = this.#inheritedEl;
    if (!el) return;
    el.replaceChildren();
    const summary = document.createElement("summary");
    summary.textContent = t("request.cmd.env.inherited");
    el.appendChild(summary);
    const rows = (this.#baseEnv ?? []).filter(
      (r) => r && r.enabled !== false && String(r.key ?? r.name ?? "").trim(),
    );
    if (rows.length === 0) {
      const none = document.createElement("div");
      none.className = "cmd-env-inherited-empty";
      none.textContent = t("request.cmd.env.inheritedEmpty");
      el.appendChild(none);
      return;
    }
    const dl = document.createElement("dl");
    dl.className = "cmd-env-inherited-list";
    for (const r of rows) {
      const dt = document.createElement("dt");
      dt.textContent = String(r.key ?? r.name);
      const dd = document.createElement("dd");
      dd.textContent = String(r.value ?? "");
      dl.append(dt, dd);
    }
    el.appendChild(dl);
  }

  #buildStdinTab() {
    const container = document.createElement("div");
    container.className = "params-editor cmd-stdin-editor";
    const editor = this.#makeCodeEditor({
      language: "text",
      richErrors: false,
      value: this.#stdin,
      placeholder: t("request.cmd.stdin.placeholder"),
      onInput: (v) => {
        this.#stdin = v;
        this.#onChange({ commandStdin: v });
        this.#scheduleApprove();
      },
    });
    editor.element.classList.add("cmd-stdin-code");
    editor.element
      .querySelector(".pce-doc")
      ?.setAttribute("aria-label", t("request.cmd.stdin.aria"));
    this.#stdinEditor = editor;
    const hint = document.createElement("div");
    hint.className = "cmd-stdin-hint";
    hint.textContent = t("request.cmd.stdin.hint");
    container.append(editor.element, hint);
    return container;
  }

  // ── Execute / Stop button decoration ─────────────────────────────────────

  /**
   * Decorate the host's in-flight Stop button for a command: red (via CSS on
   * `data-method="cmd"`) and, when a timeout is set, a countdown label plus a
   * draining progress bar — visually distinct from the scheduled-send sweep.
   * @param {HTMLButtonElement} btn
   * @param {string|null} requestId
   */
  decorateInFlight(btn, requestId) {
    const run = this.#runs.get(requestId);
    if (!run || !(run.timeoutMs > 0)) {
      this.#stopCountdown(btn);
      return;
    }
    btn.classList.add("req-send-btn--timeout");
    const tick = () => {
      const left = Math.max(0, run.timeoutMs - (Date.now() - run.start));
      btn.style.setProperty("--timeout-progress", String(left / run.timeoutMs));
      btn.textContent = t("request.cmd.stopIn", {
        secs: Math.ceil(left / 1000),
      });
    };
    tick();
    clearInterval(this.#countdownTimer);
    this.#countdownTimer = setInterval(() => {
      if (!btn.isConnected || !this.#runs.has(requestId)) {
        this.#stopCountdown(btn);
        return;
      }
      tick();
    }, COUNTDOWN_TICK_MS);
  }

  /** Remove the timeout countdown decoration (idle / countdown states). */
  #stopCountdown(btn) {
    clearInterval(this.#countdownTimer);
    this.#countdownTimer = null;
    if (btn) {
      btn.classList.remove("req-send-btn--timeout");
      btn.style.removeProperty("--timeout-progress");
    }
  }

  /** Public: clear countdown decoration from `btn`. */
  clearDecoration(btn) {
    this.#stopCountdown(btn);
  }
}
