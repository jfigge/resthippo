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
 * keymap.js — single source of truth for the application's keyboard shortcuts.
 *
 * One flat catalogue (grouped for display) drives three consumers so a binding is
 * only ever declared once:
 *   1. The renderer key handler — `installKeymap()` wires a capture-phase keydown
 *      listener for the renderer-owned shortcuts (those flagged `wire`).
 *   2. The application menu — `main.js` advertises matching accelerators; the
 *      menu-owned actions route their keystroke through Electron (real
 *      accelerators) and their click through IPC to the same command.
 *   3. The cheat-sheet — `KeyboardShortcuts` renders every group with a
 *      platform-correct key label via `formatBinding()`.
 *
 * Binding ownership (why a shortcut lives where it does):
 *   • `menuOwned`  — registered as a real menu accelerator in main.js (fires
 *                    anywhere, even mid-typing, since these are coarse app
 *                    commands). Handled in the renderer via the menu's IPC event,
 *                    NOT by installKeymap.
 *   • `wire`       — renderer-owned: handled here by installKeymap (navigation
 *                    shortcuts that should not be global menu accelerators).
 *   • neither      — display-only: the keystroke is already handled by an
 *                    existing focused-component or zoom handler (Find, Select
 *                    body, font zoom, Send, …); listed only so the cheat-sheet
 *                    and the menu stay complete.
 */

"use strict";

import { t } from "./i18n.js";

// `mod` in a binding means ⌘ on macOS, Ctrl elsewhere. Resolve the platform once
// from the preload bridge, falling back to a UA sniff for the dev/browser path.
const PLATFORM =
  (typeof window !== "undefined" && window.hippo?.platform) || "";
const IS_MAC = PLATFORM
  ? PLATFORM === "darwin"
  : /Mac|iPhone|iPad/.test(
      (typeof navigator !== "undefined" &&
        (navigator.platform || navigator.userAgent)) ||
        "",
    );

/** True on macOS — exported so callers can pick ⌘ vs Ctrl wording if needed. */
export function isMac() {
  return IS_MAC;
}

/**
 * The shortcut catalogue, grouped for the cheat-sheet. Each item:
 *   id        unique action key (referenced by handlers + the menu)
 *   descKey   i18n key for the human description
 *   binding   { mod?, shift?, alt?, ctrl?, key }  — `key` matches e.key
 *             (case-insensitive for single chars; exact for "Enter"/"ArrowUp"/…)
 *   menuOwned the keystroke is a real menu accelerator (main.js) — not wired here
 *   wire      renderer-owned — installKeymap attaches a handler for it
 *   allowWhileTyping  a wired shortcut still fires while an input/editor is focused
 */
export const SHORTCUT_GROUPS = [
  {
    titleKey: "shortcuts.group.requests",
    items: [
      // Send keeps its long-standing dedicated handler in app.js (it must fire
      // from inside the URL editor), so it is display-only here.
      {
        id: "send",
        descKey: "shortcuts.send",
        binding: { mod: true, key: "Enter" },
      },
      {
        id: "newRequest",
        descKey: "shortcuts.newRequest",
        binding: { mod: true, key: "n" },
        menuOwned: true,
      },
      {
        id: "newCollection",
        descKey: "shortcuts.newCollection",
        binding: { mod: true, shift: true, key: "n" },
        menuOwned: true,
      },
      {
        id: "newWsRequest",
        descKey: "shortcuts.newWsRequest",
        binding: { mod: true, alt: true, key: "n" },
        menuOwned: true,
      },
      // Tree-focus shortcuts — handled by TreeView's own keydown when a row is
      // focused, so display-only here (neither wired nor a menu accelerator).
      {
        id: "duplicate",
        descKey: "shortcuts.duplicate",
        binding: { mod: true, key: "d" },
      },
      {
        id: "rename",
        descKey: "shortcuts.rename",
        binding: { key: "F2" },
      },
      {
        id: "delete",
        descKey: "shortcuts.delete",
        binding: { key: "Delete" },
      },
    ],
  },
  {
    titleKey: "shortcuts.group.navigation",
    items: [
      {
        id: "focusUrl",
        descKey: "shortcuts.focusUrl",
        binding: { mod: true, key: "l" },
        wire: true,
        allowWhileTyping: true,
      },
      {
        id: "prevRequest",
        descKey: "shortcuts.prevRequest",
        binding: { mod: true, alt: true, key: "ArrowUp" },
        wire: true,
      },
      {
        id: "nextRequest",
        descKey: "shortcuts.nextRequest",
        binding: { mod: true, alt: true, key: "ArrowDown" },
        wire: true,
      },
      {
        id: "tabRequests",
        descKey: "shortcuts.tabRequests",
        binding: { mod: true, key: "1" },
        wire: true,
        allowWhileTyping: true,
      },
      {
        id: "tabFavorites",
        descKey: "shortcuts.tabFavorites",
        binding: { mod: true, key: "2" },
        wire: true,
        allowWhileTyping: true,
      },
      {
        id: "tabRecents",
        descKey: "shortcuts.tabRecents",
        binding: { mod: true, key: "3" },
        wire: true,
        allowWhileTyping: true,
      },
    ],
  },
  {
    titleKey: "shortcuts.group.search",
    items: [
      // Context-sensitive — owned by the focused tree / response component.
      {
        id: "find",
        descKey: "shortcuts.find",
        binding: { mod: true, key: "f" },
      },
      {
        id: "filter",
        descKey: "shortcuts.filter",
        binding: { mod: true, shift: true, key: "f" },
      },
      {
        id: "selectBody",
        descKey: "shortcuts.selectBody",
        binding: { mod: true, key: "a" },
      },
    ],
  },
  {
    titleKey: "shortcuts.group.view",
    items: [
      {
        id: "cycleLayout",
        descKey: "shortcuts.cycleLayout",
        binding: { mod: true, key: "\\" },
        menuOwned: true,
      },
      // Font zoom is owned by installZoomHandlers() (it also handles wheel/pinch).
      {
        id: "fontIn",
        descKey: "shortcuts.fontIn",
        binding: { mod: true, key: "+" },
      },
      {
        id: "fontOut",
        descKey: "shortcuts.fontOut",
        binding: { mod: true, key: "-" },
      },
      {
        id: "fontReset",
        descKey: "shortcuts.fontReset",
        binding: { mod: true, key: "0" },
      },
    ],
  },
  {
    titleKey: "shortcuts.group.app",
    items: [
      {
        id: "settings",
        descKey: "shortcuts.settings",
        binding: { mod: true, key: "," },
        menuOwned: true,
      },
      // The ⌘/Ctrl+E family opens two variable scopes: plain ⌘E the active
      // environment, ⇧⌘E the active collection (the Collections manager). Both
      // renderer-owned; the matching native menu entries advertise them as
      // display-only accelerators (env-picker "Manage…"). (Folder/collection
      // variables are also edited inline by selecting the container in the
      // tree — no dedicated shortcut.)
      {
        id: "editEnvironment",
        descKey: "shortcuts.editEnvironment",
        binding: { mod: true, key: "e" },
        wire: true,
        allowWhileTyping: true,
      },
      {
        id: "collectionVariables",
        descKey: "shortcuts.collectionVariables",
        binding: { mod: true, shift: true, key: "e" },
        wire: true,
        allowWhileTyping: true,
      },
      {
        id: "shortcuts",
        descKey: "shortcuts.shortcuts",
        binding: { mod: true, key: "k" },
        menuOwned: true,
      },
      {
        id: "userGuide",
        descKey: "shortcuts.userGuide",
        binding: { mod: true, key: "/" },
      },
      {
        id: "import",
        descKey: "shortcuts.import",
        binding: { mod: true, shift: true, key: "i" },
      },
    ],
  },
];

/** Flat view of every catalogue item. */
const ALL_ITEMS = SHORTCUT_GROUPS.flatMap((g) => g.items);

/** id → binding lookup, for tooltips and ad-hoc display. */
export const BINDINGS = Object.fromEntries(
  ALL_ITEMS.map((i) => [i.id, i.binding]),
);

/** Does keyboard event `e` match the single key `key` (ignoring modifiers)? */
function keyMatches(e, key) {
  if (key.length !== 1) return e.key === key;
  if ((e.key || "").toLowerCase() === key.toLowerCase()) return true;
  // macOS composes Option+<key> into an accented / dead character, so with Alt
  // held `e.key` is no longer the base key (⌥E yields a dead accent, not "e").
  // Fall back to the layout-physical `e.code` for letters/digits in that case so
  // Alt shortcuts (e.g. ⌥⌘E) still match. Scoped to Alt-down to avoid binding
  // non-Alt shortcuts to physical positions on non-QWERTY layouts.
  if (e.altKey) {
    if (/[a-z]/i.test(key)) return e.code === `Key${key.toUpperCase()}`;
    if (/[0-9]/.test(key)) return e.code === `Digit${key}`;
  }
  return false;
}

/**
 * Whether keydown `e` satisfies binding `b`. The platform `mod` flag maps to
 * ⌘ (mac) / Ctrl (other); the opposite modifier must be up so a Cmd binding does
 * not also match Ctrl+key on macOS.
 * @param {KeyboardEvent} e
 * @param {{mod?:boolean,shift?:boolean,alt?:boolean,ctrl?:boolean,key:string}} b
 */
export function matchesBinding(e, b) {
  if (!b) return false;
  const mod = IS_MAC ? e.metaKey : e.ctrlKey;
  const otherMod = IS_MAC ? e.ctrlKey : e.metaKey;
  if (!!b.mod !== mod) return false;
  if (b.ctrl && !b.mod && !otherMod) return false;
  if (!b.ctrl && otherMod) return false;
  if (!!b.shift !== e.shiftKey) return false;
  if (!!b.alt !== e.altKey) return false;
  return keyMatches(e, b.key);
}

/** Pretty-print one key for display (platform-correct glyphs). */
function formatKey(key) {
  switch (key) {
    case "Enter":
      return IS_MAC ? "↵" : "Enter";
    case "ArrowUp":
      return "↑";
    case "ArrowDown":
      return "↓";
    case "Delete":
      // On macOS the delete key is ⌫ (Backspace); on Windows/Linux it's "Del".
      // The handler accepts both keys regardless of platform.
      return IS_MAC ? "⌫" : "Del";
    case " ":
      return IS_MAC ? "Space" : "Space";
    default:
      return key.length === 1 ? key.toUpperCase() : key;
  }
}

/**
 * Render a binding as a platform-correct label, e.g. "⌘N" / "Ctrl+N",
 * "⌥⌘↓" / "Ctrl+Alt+↓". macOS concatenates glyphs in the conventional
 * ⌃⌥⇧⌘ order; other platforms join with "+".
 * @param {{mod?:boolean,shift?:boolean,alt?:boolean,ctrl?:boolean,key:string}} b
 */
export function formatBinding(b) {
  if (!b) return "";
  const parts = [];
  if (b.ctrl && !b.mod) parts.push(IS_MAC ? "⌃" : "Ctrl");
  if (b.alt) parts.push(IS_MAC ? "⌥" : "Alt");
  if (b.shift) parts.push(IS_MAC ? "⇧" : "Shift");
  if (b.mod) parts.push(IS_MAC ? "⌘" : "Ctrl");
  parts.push(formatKey(b.key));
  return IS_MAC ? parts.join("") : parts.join("+");
}

/** Convenience: the display label for an action id. */
export function bindingDisplay(id) {
  return formatBinding(BINDINGS[id]);
}

/** Map a binding key to Electron's accelerator key name (e.g. "d"→"D", "Enter"→"Return"). */
function electronKeyName(key) {
  switch (key) {
    case "Enter":
      return "Return";
    case "ArrowUp":
      return "Up";
    case "ArrowDown":
      return "Down";
    case " ":
      return "Space";
    case "Delete":
      // Display the key the user actually presses: ⌫ (Backspace) on macOS, "Del"
      // elsewhere — matching the cheat-sheet's formatKey. Display-only anyway, so
      // this never registers; the tree handler accepts both keys on all platforms.
      return IS_MAC ? "Backspace" : "Delete";
    default:
      return key.length === 1 ? key.toUpperCase() : key; // "d"→"D", "F2"→"F2"
  }
}

/**
 * Electron accelerator string for an action id (e.g. "CmdOrCtrl+D", "F2"), so
 * native menus can advertise the same binding the keymap defines. Returns
 * undefined for an unknown id. Pair with `registerAccelerator: false` in the menu
 * — the renderer owns these keystrokes, so the menu must only display them.
 * @param {string} id
 */
export function electronAccelerator(id) {
  const b = BINDINGS[id];
  if (!b) return undefined;
  const parts = [];
  if (b.ctrl && !b.mod) parts.push("Control");
  if (b.alt) parts.push("Alt");
  if (b.shift) parts.push("Shift");
  if (b.mod) parts.push("CmdOrCtrl");
  parts.push(electronKeyName(b.key));
  return parts.join("+");
}

/**
 * Attach the renderer's capture-phase keydown listener for the `wire`-flagged
 * shortcuts. `handlers` maps action id → callback; only ids with both `wire` and
 * a handler are bound. By default a wired shortcut is suppressed while focus is in
 * a text input / editor (so it never steals a keystroke from typing); items
 * flagged `allowWhileTyping` (pure navigation, e.g. focus-URL / switch-tab) still
 * fire. `isBlocked()` lets the caller gate everything (e.g. while a modal is up).
 *
 * @param {Record<string, () => void>} handlers
 * @param {{ isBlocked?: () => boolean }} [opts]
 */
export function installKeymap(handlers, { isBlocked } = {}) {
  const wired = ALL_ITEMS.filter((i) => i.wire && handlers[i.id]);
  window.addEventListener(
    "keydown",
    (e) => {
      if (isBlocked?.()) return;
      const tag = e.target?.tagName ?? "";
      const typing =
        tag === "INPUT" || tag === "TEXTAREA" || e.target?.isContentEditable;
      for (const item of wired) {
        if (typing && !item.allowWhileTyping) continue;
        if (matchesBinding(e, item.binding)) {
          e.preventDefault();
          e.stopPropagation();
          handlers[item.id]();
          return;
        }
      }
    },
    { capture: true },
  );
}

/**
 * Cheat-sheet view model: groups with resolved title + rows of
 * { desc, keys }. Resolved at call time so t() sees the loaded catalogue.
 */
export function shortcutTable() {
  return SHORTCUT_GROUPS.map((g) => ({
    title: t(g.titleKey),
    rows: g.items.map((i) => ({
      desc: t(i.descKey),
      keys: formatBinding(i.binding),
    })),
  }));
}
