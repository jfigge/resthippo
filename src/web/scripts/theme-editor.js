"use strict";

import { deepClone } from "./utils/clone.js";

const BUILT_IN_THEMES = [
  {
    id: "mocha",
    name: "Mocha",
    colorScheme: "dark",
    vars: {
      "--color-base": "#1e1e2e",
      "--color-mantle": "#181825",
      "--color-crust": "#11111b",
      "--color-surface-0": "#313244",
      "--color-surface-1": "#45475a",
      "--color-surface-2": "#585b70",
      "--color-overlay-0": "#6c7086",
      "--color-overlay-1": "#7f849c",
      "--color-text": "#cdd6f4",
      "--color-subtext": "#a6adc8",
      "--color-accent": "#89b4fa",
      "--color-accent-dim": "#74c7ec",
      "--color-success": "#a6e3a1",
      "--color-warning": "#f9e2af",
      "--color-error": "#f38ba8",
      "--color-info": "#89dceb",
      "--color-method-get": "#a6e3a1",
      "--color-method-post": "#fab387",
      "--color-method-put": "#89b4fa",
      "--color-method-patch": "#cba6f7",
      "--color-method-delete": "#f38ba8",
      "--color-method-head": "#f9e2af",
      "--color-method-options": "#94e2d5",
      "--color-method-ws": "#89dceb",
    },
  },
  {
    id: "latte",
    name: "Latte",
    colorScheme: "light",
    vars: {
      "--color-base": "#eff1f5",
      "--color-mantle": "#e6e9ef",
      "--color-crust": "#dce0e8",
      "--color-surface-0": "#ccd0da",
      "--color-surface-1": "#bcc0cc",
      "--color-surface-2": "#acb0be",
      "--color-overlay-0": "#9ca0b0",
      "--color-overlay-1": "#8c8fa1",
      "--color-text": "#4c4f69",
      "--color-subtext": "#5c5f77",
      "--color-accent": "#1e66f5",
      "--color-accent-dim": "#04a5e5",
      "--color-success": "#40a02b",
      "--color-warning": "#df8e1d",
      "--color-error": "#d20f39",
      "--color-info": "#179299",
      "--color-method-get": "#40a02b",
      "--color-method-post": "#fe640b",
      "--color-method-put": "#1e66f5",
      "--color-method-patch": "#8839ef",
      "--color-method-delete": "#d20f39",
      "--color-method-head": "#df8e1d",
      "--color-method-options": "#179299",
      "--color-method-ws": "#209fb5",
    },
  },
  {
    id: "grey-dark",
    name: "Grey Dark",
    colorScheme: "dark",
    vars: {
      "--color-base": "#1c1c1c",
      "--color-mantle": "#161616",
      "--color-crust": "#101010",
      "--color-surface-0": "#2a2a2a",
      "--color-surface-1": "#383838",
      "--color-surface-2": "#484848",
      "--color-overlay-0": "#686868",
      "--color-overlay-1": "#808080",
      "--color-text": "#e8e8e8",
      "--color-subtext": "#b0b0b0",
      "--color-accent": "#d0d0d0",
      "--color-accent-dim": "#a0a0a0",
      "--color-success": "#80c080",
      "--color-warning": "#d4b060",
      "--color-error": "#e07070",
      "--color-info": "#70b8d0",
      "--color-method-get": "#80c080",
      "--color-method-post": "#d09060",
      "--color-method-put": "#8090d0",
      "--color-method-patch": "#a880c0",
      "--color-method-delete": "#e07070",
      "--color-method-head": "#d4b060",
      "--color-method-options": "#70b8d0",
      "--color-method-ws": "#6aa6e0",
    },
  },
  {
    id: "grey-light",
    name: "Grey Light",
    colorScheme: "light",
    vars: {
      "--color-base": "#f4f4f4",
      "--color-mantle": "#ebebeb",
      "--color-crust": "#dedede",
      "--color-surface-0": "#d2d2d2",
      "--color-surface-1": "#c2c2c2",
      "--color-surface-2": "#aeaeae",
      "--color-overlay-0": "#828282",
      "--color-overlay-1": "#686868",
      "--color-text": "#1e1e1e",
      "--color-subtext": "#484848",
      "--color-accent": "#383838",
      "--color-accent-dim": "#606060",
      "--color-success": "#2a7a2a",
      "--color-warning": "#9a6800",
      "--color-error": "#b82020",
      "--color-info": "#1870a0",
      "--color-method-get": "#2a7a2a",
      "--color-method-post": "#b05010",
      "--color-method-put": "#2050c0",
      "--color-method-patch": "#6820b0",
      "--color-method-delete": "#b82020",
      "--color-method-head": "#9a6800",
      "--color-method-options": "#1870a0",
      "--color-method-ws": "#2060b8",
    },
  },
];

const VAR_LABELS = {
  "--color-base": "Base",
  "--color-mantle": "Mantle",
  "--color-crust": "Crust",
  "--color-surface-0": "Surface 0",
  "--color-surface-1": "Surface 1",
  "--color-surface-2": "Surface 2",
  "--color-overlay-0": "Overlay 0",
  "--color-overlay-1": "Overlay 1",
  "--color-text": "Text",
  "--color-subtext": "Subtext",
  "--color-accent": "Accent",
  "--color-accent-dim": "Accent Dim",
  "--color-success": "Success",
  "--color-warning": "Warning",
  "--color-error": "Error",
  "--color-info": "Info",
  "--color-method-get": "GET",
  "--color-method-post": "POST",
  "--color-method-put": "PUT",
  "--color-method-patch": "PATCH",
  "--color-method-delete": "DELETE",
  "--color-method-head": "HEAD",
  "--color-method-options": "OPTIONS",
  "--color-method-ws": "WS",
};

const VAR_KEYS = Object.keys(VAR_LABELS);

// Sensible per-key defaults for any token a theme's vars omit — e.g. a custom
// theme saved before a new token (like --color-method-ws) was introduced. Falls
// back to the first built-in (Mocha) so legacy themes show a real colour rather
// than black, and capture it if re-saved.
const FALLBACK_VARS = BUILT_IN_THEMES[0].vars;

let _customThemes = [];
let _selectedId = null;
let _editingTheme = null;

function init() {
  window.themeEditor.getManifest().then((manifest) => {
    _customThemes = manifest?.settings?.customThemes ?? [];
    renderThemeList();
    if (_customThemes.length > 0) selectCustomTheme(_customThemes[0].id);
  });

  document
    .getElementById("btn-new-theme")
    .addEventListener("click", createNewTheme);
  document
    .getElementById("btn-import-theme")
    .addEventListener("click", importTheme);
  document
    .getElementById("btn-export")
    .addEventListener("click", exportSelected);
  document.getElementById("btn-clone").addEventListener("click", cloneSelected);
  document
    .getElementById("btn-delete")
    .addEventListener("click", deleteSelected);
  document.getElementById("btn-apply").addEventListener("click", applySelected);
  document.getElementById("btn-save").addEventListener("click", saveSelected);

  document.getElementById("theme-name").addEventListener("input", () => {
    if (!_editingTheme) return;
    _editingTheme.name = document.getElementById("theme-name").value;
    markDirty();
    previewCurrent();
  });

  document.getElementById("theme-scheme").addEventListener("change", () => {
    if (!_editingTheme) return;
    _editingTheme.colorScheme = document.getElementById("theme-scheme").value;
    markDirty();
    previewCurrent();
  });
}

function renderThemeList() {
  const list = document.getElementById("theme-list");
  list.innerHTML = "";

  for (const t of BUILT_IN_THEMES) {
    list.appendChild(makeThemeItem(t, true));
  }

  if (_customThemes.length > 0) {
    const divider = document.createElement("li");
    divider.className = "theme-divider";
    list.appendChild(divider);
    for (const t of _customThemes) {
      list.appendChild(makeThemeItem(t, false));
    }
  }
}

function makeThemeItem(theme, isBuiltIn) {
  const li = document.createElement("li");
  li.className = "theme-item" + (_selectedId === theme.id ? " selected" : "");
  li.dataset.id = theme.id;

  const swatch = document.createElement("span");
  swatch.className = "theme-swatch";
  swatch.style.background = theme.vars["--color-accent"] ?? "#888";

  const label = document.createElement("span");
  label.className = "theme-label";
  label.textContent = theme.name;

  const badge = document.createElement("span");
  badge.className = "theme-badge";
  badge.textContent = isBuiltIn ? "built-in" : "";

  li.appendChild(swatch);
  li.appendChild(label);
  li.appendChild(badge);

  li.addEventListener("click", () => {
    if (isBuiltIn) selectBuiltInTheme(theme.id);
    else selectCustomTheme(theme.id);
  });

  return li;
}

function selectBuiltInTheme(id) {
  _selectedId = id;
  _editingTheme = null;
  const theme = BUILT_IN_THEMES.find((t) => t.id === id);
  if (!theme) return;

  updateSelectedClass();
  document.getElementById("editor-panel").classList.remove("empty");

  document.getElementById("theme-name").value = theme.name;
  document.getElementById("theme-name").disabled = true;
  document.getElementById("theme-scheme").value = theme.colorScheme;
  document.getElementById("theme-scheme").disabled = true;
  document.getElementById("btn-save").disabled = true;
  document.getElementById("btn-save").textContent = "Save";
  document.getElementById("btn-delete").disabled = true;
  document.getElementById("btn-apply").disabled = false;
  document.getElementById("btn-clone").disabled = false;
  document.getElementById("btn-export").disabled = false;

  renderColorGrid(theme.vars, true);
  previewThemeData(theme);
}

function selectCustomTheme(id) {
  _selectedId = id;
  const theme = _customThemes.find((t) => t.id === id);
  if (!theme) return;
  _editingTheme = deepClone(theme);

  updateSelectedClass();
  document.getElementById("editor-panel").classList.remove("empty");

  document.getElementById("theme-name").value = theme.name;
  document.getElementById("theme-name").disabled = false;
  document.getElementById("theme-scheme").value = theme.colorScheme;
  document.getElementById("theme-scheme").disabled = false;
  document.getElementById("btn-save").disabled = false;
  document.getElementById("btn-save").textContent = "Save";
  document.getElementById("btn-delete").disabled = false;
  document.getElementById("btn-apply").disabled = false;
  document.getElementById("btn-clone").disabled = false;
  document.getElementById("btn-export").disabled = false;

  renderColorGrid(theme.vars, false);
  previewThemeData(theme);
}

function updateSelectedClass() {
  document.querySelectorAll(".theme-item").forEach((el) => {
    el.classList.toggle("selected", el.dataset.id === _selectedId);
  });
}

function renderColorGrid(vars, readOnly) {
  const grid = document.getElementById("color-grid");
  grid.innerHTML = "";

  for (const key of VAR_KEYS) {
    const value = vars[key] ?? FALLBACK_VARS[key] ?? "#000000";
    const row = document.createElement("div");
    row.className = "color-row";

    const label = document.createElement("label");
    label.textContent = VAR_LABELS[key];
    label.title = key;

    const picker = document.createElement("input");
    picker.type = "color";
    picker.value = value;
    picker.disabled = readOnly;
    picker.dataset.varKey = key;

    const hexInput = document.createElement("input");
    hexInput.type = "text";
    hexInput.className = "hex-input";
    hexInput.value = value;
    hexInput.maxLength = 7;
    hexInput.disabled = readOnly;
    hexInput.spellcheck = false;
    hexInput.dataset.varKey = key;

    picker.addEventListener("input", () => {
      hexInput.value = picker.value;
      onColorChange(key, picker.value);
    });

    hexInput.addEventListener("input", () => {
      const normalized = normalizeHex(hexInput.value);
      if (normalized) {
        picker.value = normalized;
        onColorChange(key, normalized);
      }
    });

    row.appendChild(label);
    row.appendChild(picker);
    row.appendChild(hexInput);
    grid.appendChild(row);
  }
}

function onColorChange(varKey, value) {
  if (!_editingTheme) return;
  _editingTheme.vars[varKey] = value;
  markDirty();
  previewCurrent();
}

function previewCurrent() {
  if (_editingTheme) previewThemeData(_editingTheme);
}

function previewThemeData(theme) {
  window.themeEditor.previewTheme({
    colorScheme: theme.colorScheme,
    vars: theme.vars,
  });
}

function markDirty() {
  document.getElementById("btn-save").textContent = "Save*";
}

function createNewTheme() {
  const base = BUILT_IN_THEMES[0];
  const newTheme = {
    id: crypto.randomUUID(),
    name: "New Theme",
    colorScheme: "dark",
    vars: { ...base.vars },
  };
  _customThemes.push(newTheme);
  renderThemeList();
  selectCustomTheme(newTheme.id);
  const nameInput = document.getElementById("theme-name");
  nameInput.focus();
  nameInput.select();
}

function cloneSelected() {
  const source =
    BUILT_IN_THEMES.find((t) => t.id === _selectedId) ??
    _customThemes.find((t) => t.id === _selectedId);
  if (!source) return;

  const clone = {
    id: crypto.randomUUID(),
    name: source.name + " Copy",
    colorScheme: source.colorScheme,
    vars: { ...source.vars },
  };
  _customThemes.push(clone);
  renderThemeList();
  selectCustomTheme(clone.id);
  const nameInput = document.getElementById("theme-name");
  nameInput.focus();
  nameInput.select();
}

async function saveSelected() {
  if (!_editingTheme) return;
  const idx = _customThemes.findIndex((t) => t.id === _editingTheme.id);
  if (idx < 0) return;

  _customThemes[idx] = deepClone(_editingTheme);
  renderThemeList();
  updateSelectedClass();

  await persistCustomThemes();
  document.getElementById("btn-save").textContent = "Save";
}

async function deleteSelected() {
  if (!_selectedId) return;
  const idx = _customThemes.findIndex((t) => t.id === _selectedId);
  if (idx < 0) return;

  _customThemes.splice(idx, 1);
  _selectedId = null;
  _editingTheme = null;

  renderThemeList();
  document.getElementById("editor-panel").classList.add("empty");

  await persistCustomThemes();
}

async function applySelected() {
  if (!_selectedId) return;
  if (_customThemes.some((t) => t.id === _selectedId)) {
    if (_editingTheme?.id === _selectedId) {
      const idx = _customThemes.findIndex((t) => t.id === _editingTheme.id);
      if (idx >= 0) {
        _customThemes[idx] = deepClone(_editingTheme);
        renderThemeList();
        updateSelectedClass();
        document.getElementById("btn-save").textContent = "Save";
      }
    }
    await persistCustomThemes();
  }
  window.themeEditor.applyTheme(_selectedId);
}

async function exportSelected() {
  const source =
    BUILT_IN_THEMES.find((t) => t.id === _selectedId) ??
    _customThemes.find((t) => t.id === _selectedId);
  if (!source) return;
  await window.themeEditor.exportTheme({
    name: source.name,
    colorScheme: source.colorScheme,
    vars: source.vars,
  });
}

async function importTheme() {
  const data = await window.themeEditor.importTheme();
  if (!data || typeof data.vars !== "object") return;
  const newTheme = {
    id: crypto.randomUUID(),
    name: String(data.name ?? "Imported Theme"),
    colorScheme: data.colorScheme === "light" ? "light" : "dark",
    vars: {},
  };
  for (const key of VAR_KEYS) {
    newTheme.vars[key] = normalizeHex(data.vars[key] ?? "") ?? "#000000";
  }
  _customThemes.push(newTheme);
  renderThemeList();
  selectCustomTheme(newTheme.id);
  await persistCustomThemes();
}

async function persistCustomThemes() {
  const manifest = await window.themeEditor.getManifest();
  if (!manifest.settings) manifest.settings = {};
  manifest.settings.customThemes = _customThemes;
  const result = await window.themeEditor.saveManifest(manifest);
  // On a write failure (disk full / permission), main returns a discriminable
  // { __wurlError } envelope. This editor is a separate window with no toast
  // surface, so it cannot route into Notifications — but it must NOT broadcast
  // the themes as persisted, or the running app would show phantom themes that
  // vanish on the next restart (silent data loss). Surface the failure instead.
  if (result && result.__wurlError === true) {
    console.error("[theme-editor] saveManifest failed:", result.message);
    window.alert(
      `Could not save your themes: ${result.message || "unknown error"}\n\n` +
        "Your changes have not been persisted.",
    );
    return false;
  }
  window.themeEditor.notifyThemesChanged(_customThemes);
  return true;
}

function normalizeHex(v) {
  const s = v.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(s)) return "#" + s;
  return null;
}

document.addEventListener("DOMContentLoaded", init);
