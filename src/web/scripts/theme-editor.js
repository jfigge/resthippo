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

"use strict";

import { deepClone } from "./utils/clone.js";
import { applyCatalog, t } from "./i18n.js";

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

// Descriptive colour-role labels — localized; the i18n key is resolved via t()
// at render time (the catalog isn't loaded when this module is first evaluated).
const VAR_LABEL_KEYS = {
  "--color-base": "themeEditor.var.base",
  "--color-mantle": "themeEditor.var.mantle",
  "--color-crust": "themeEditor.var.crust",
  "--color-surface-0": "themeEditor.var.surface0",
  "--color-surface-1": "themeEditor.var.surface1",
  "--color-surface-2": "themeEditor.var.surface2",
  "--color-overlay-0": "themeEditor.var.overlay0",
  "--color-overlay-1": "themeEditor.var.overlay1",
  "--color-text": "themeEditor.var.text",
  "--color-subtext": "themeEditor.var.subtext",
  "--color-accent": "themeEditor.var.accent",
  "--color-accent-dim": "themeEditor.var.accentDim",
  "--color-success": "themeEditor.var.success",
  "--color-warning": "themeEditor.var.warning",
  "--color-error": "themeEditor.var.error",
  "--color-info": "themeEditor.var.info",
};

// HTTP-method (and WS) swatches: protocol keywords shown verbatim in every
// locale, so they carry the literal token rather than an i18n key.
const METHOD_LABELS = {
  "--color-method-get": "GET",
  "--color-method-post": "POST",
  "--color-method-put": "PUT",
  "--color-method-patch": "PATCH",
  "--color-method-delete": "DELETE",
  "--color-method-head": "HEAD",
  "--color-method-options": "OPTIONS",
  "--color-method-ws": "WS",
};

// Grid order: descriptive roles first, then the method swatches.
const VAR_KEYS = [
  ...Object.keys(VAR_LABEL_KEYS),
  ...Object.keys(METHOD_LABELS),
];

/** Display label for a colour token — a verbatim method token or a localized role. */
function varLabel(key) {
  return METHOD_LABELS[key] ?? t(VAR_LABEL_KEYS[key]);
}

// Sensible per-key defaults for any token a theme's vars omit — e.g. a custom
// theme saved before a new token (like --color-method-ws) was introduced. Falls
// back to the first built-in (Mocha) so legacy themes show a real colour rather
// than black, and capture it if re-saved.
const FALLBACK_VARS = BUILT_IN_THEMES[0].vars;

// ── Metric tokens (the second editor tab) ───────────────────────────────────
// The non-colour design tokens a theme may override: the spacing scale, control
// heights, corner radii, and the splitter thickness. Each is an integer-pixel
// value stored as "<n>px" in the theme's `vars` alongside the colour tokens, so
// the existing buildCustomThemeCss()/preview/apply path carries them with no
// extra plumbing. Grouped for display; group headings and per-row labels resolve
// via t() at render time (the catalog isn't loaded when this module is first
// evaluated, mirroring VAR_LABEL_KEYS above).
const METRIC_GROUPS = [
  {
    titleKey: "themeEditor.metric.group.spacing",
    rows: [
      {
        key: "--space-1",
        labelKey: "themeEditor.metric.space",
        params: { n: 1 },
      },
      {
        key: "--space-2",
        labelKey: "themeEditor.metric.space",
        params: { n: 2 },
      },
      {
        key: "--space-3",
        labelKey: "themeEditor.metric.space",
        params: { n: 3 },
      },
      {
        key: "--space-4",
        labelKey: "themeEditor.metric.space",
        params: { n: 4 },
      },
      {
        key: "--space-5",
        labelKey: "themeEditor.metric.space",
        params: { n: 5 },
      },
      {
        key: "--space-6",
        labelKey: "themeEditor.metric.space",
        params: { n: 6 },
      },
      {
        key: "--space-7",
        labelKey: "themeEditor.metric.space",
        params: { n: 7 },
      },
    ],
  },
  {
    titleKey: "themeEditor.metric.group.controlHeights",
    rows: [
      { key: "--control-h-xs", labelKey: "themeEditor.metric.size.xs" },
      { key: "--control-h-sm", labelKey: "themeEditor.metric.size.sm" },
      { key: "--control-h-md", labelKey: "themeEditor.metric.size.md" },
      { key: "--control-h-lg", labelKey: "themeEditor.metric.size.lg" },
    ],
  },
  {
    titleKey: "themeEditor.metric.group.radii",
    rows: [
      { key: "--radius-sm", labelKey: "themeEditor.metric.size.sm" },
      { key: "--radius-md", labelKey: "themeEditor.metric.size.md" },
      { key: "--radius-lg", labelKey: "themeEditor.metric.size.lg" },
    ],
  },
  {
    titleKey: "themeEditor.metric.group.splitter",
    rows: [
      { key: "--splitter-size", labelKey: "themeEditor.metric.splitterSize" },
    ],
  },
];

// Base pixel value for each metric token, mirroring :root in theme.css. Shown
// when a theme omits the token — every built-in, and any custom theme saved
// before metric editing existed — so the field reflects the real rendered value;
// only a token the user actually edits gets written into the theme's vars.
const DEFAULT_METRICS = {
  "--space-1": 2,
  "--space-2": 4,
  "--space-3": 8,
  "--space-4": 12,
  "--space-5": 16,
  "--space-6": 24,
  "--space-7": 32,
  "--control-h-xs": 24,
  "--control-h-sm": 26,
  "--control-h-md": 30,
  "--control-h-lg": 32,
  "--radius-sm": 4,
  "--radius-md": 6,
  "--radius-lg": 8,
  "--splitter-size": 2,
};

// Flat list of every metric key — used to copy/validate metric tokens on import.
const METRIC_KEYS = METRIC_GROUPS.flatMap((g) => g.rows.map((r) => r.key));

const METRIC_MIN = 0;
const METRIC_MAX = 200;

/**
 * Parse a stored metric value (`"12px"` or a bare number) to a clamped integer,
 * or null when it isn't a number. The clamp keeps a corrupt or imported value
 * from producing an absurd layout.
 */
function parseMetric(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return null;
  return Math.max(METRIC_MIN, Math.min(METRIC_MAX, n));
}

let _customThemes = [];
let _selectedId = null;
let _editingTheme = null;
let _activeTab = "colors";

/**
 * Localize the hand-authored HTML shell once, after the catalog is applied and
 * before any theme renders. Mirrors app.js's localizeChrome(): the static
 * theme-editor.html ships English defaults; this replaces them from the active
 * catalog. Dynamic strings (button labels that toggle, colour-grid rows) are
 * owned by their render functions via t().
 */
function localizeChrome() {
  const setText = (sel, key) => {
    const el = document.querySelector(sel);
    if (el) el.textContent = t(key);
  };
  const setAttr = (sel, attr, key) => {
    const el = document.querySelector(sel);
    if (el) el.setAttribute(attr, t(key));
  };

  document.title = t("themeEditor.windowTitle");
  setText(".sidebar-title", "themeEditor.sidebarTitle");
  setText("#btn-import-theme", "themeEditor.import");
  setAttr("#btn-import-theme", "title", "themeEditor.importTitle");
  setText("#btn-new-theme", "themeEditor.newTheme");
  setAttr("#theme-name", "placeholder", "themeEditor.namePlaceholder");
  setText(".color-scheme-label span", "themeEditor.mode");
  setText('#theme-scheme option[value="dark"]', "themeEditor.schemeDark");
  setText('#theme-scheme option[value="light"]', "themeEditor.schemeLight");
  setText("#btn-export", "themeEditor.export");
  setText("#btn-clone", "themeEditor.clone");
  setText("#btn-delete", "common.delete");
  setText("#btn-apply", "themeEditor.apply");
  setText("#btn-save", "common.save");
  setText("#tab-colors", "themeEditor.tab.colors");
  setText("#tab-metrics", "themeEditor.tab.metrics");
  setText("#empty-state", "themeEditor.emptyState");
}

async function init() {
  try {
    applyCatalog(await window.themeEditor.i18n.load());
  } catch (err) {
    console.warn("[theme-editor] i18n catalog load failed:", err?.message);
  }
  localizeChrome();

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

  document
    .getElementById("tab-colors")
    .addEventListener("click", () => setActiveTab("colors"));
  document
    .getElementById("tab-metrics")
    .addEventListener("click", () => setActiveTab("metrics"));
  setActiveTab(_activeTab);
}

/** Switch the editor between the Colors and Metrics pages. */
function setActiveTab(tab) {
  _activeTab = tab;
  document.getElementById("editor-panel").dataset.tab = tab;
  document
    .getElementById("tab-colors")
    .classList.toggle("theme-tab--active", tab === "colors");
  document
    .getElementById("tab-metrics")
    .classList.toggle("theme-tab--active", tab === "metrics");
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
  li.className =
    "theme-item" + (_selectedId === theme.id ? " theme-item--selected" : "");
  li.dataset.id = theme.id;

  const swatch = document.createElement("span");
  swatch.className = "theme-swatch";
  swatch.style.background = theme.vars["--color-accent"] ?? "#888";

  const label = document.createElement("span");
  label.className = "theme-label";
  label.textContent = theme.name;

  const badge = document.createElement("span");
  badge.className = "theme-badge";
  badge.textContent = isBuiltIn ? t("themeEditor.builtIn") : "";

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
  document.getElementById("btn-save").textContent = t("common.save");
  document.getElementById("btn-delete").disabled = true;
  document.getElementById("btn-apply").disabled = false;
  document.getElementById("btn-clone").disabled = false;
  document.getElementById("btn-export").disabled = false;

  renderColorGrid(theme.vars, true);
  renderMetricsGrid(theme.vars, true);
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
  document.getElementById("btn-save").textContent = t("common.save");
  document.getElementById("btn-delete").disabled = false;
  document.getElementById("btn-apply").disabled = false;
  document.getElementById("btn-clone").disabled = false;
  document.getElementById("btn-export").disabled = false;

  renderColorGrid(theme.vars, false);
  renderMetricsGrid(theme.vars, false);
  previewThemeData(theme);
}

function updateSelectedClass() {
  document.querySelectorAll(".theme-item").forEach((el) => {
    el.classList.toggle("theme-item--selected", el.dataset.id === _selectedId);
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
    label.textContent = varLabel(key);
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

function renderMetricsGrid(vars, readOnly) {
  const grid = document.getElementById("metrics-grid");
  grid.innerHTML = "";

  for (const group of METRIC_GROUPS) {
    const heading = document.createElement("div");
    heading.className = "metric-group-title";
    heading.textContent = t(group.titleKey);
    grid.appendChild(heading);

    for (const { key, labelKey, params } of group.rows) {
      // Stored "<n>px" → integer for the field; fall back to the :root default
      // when the theme doesn't carry this token (built-ins, legacy customs).
      const value = parseMetric(vars[key]) ?? DEFAULT_METRICS[key];

      const row = document.createElement("div");
      row.className = "metric-row";

      const label = document.createElement("label");
      label.textContent = t(labelKey, params);
      label.title = key;

      const wrap = document.createElement("div");
      wrap.className = "metric-input-wrap";

      const input = document.createElement("input");
      input.type = "number";
      input.className = "metric-input";
      input.min = String(METRIC_MIN);
      input.max = String(METRIC_MAX);
      input.step = "1";
      input.value = String(value);
      input.disabled = readOnly;
      input.dataset.varKey = key;

      // The "px" unit is supplied by CSS (.metric-unit::after) — see theme-editor.css.
      const unit = document.createElement("span");
      unit.className = "metric-unit";

      input.addEventListener("input", () => {
        const n = parseMetric(input.value);
        if (n === null) return; // mid-edit empty / non-numeric — ignore
        onMetricChange(key, n);
      });

      wrap.appendChild(input);
      wrap.appendChild(unit);
      row.appendChild(label);
      row.appendChild(wrap);
      grid.appendChild(row);
    }
  }
}

function onMetricChange(varKey, value) {
  if (!_editingTheme) return;
  _editingTheme.vars[varKey] = `${value}px`;
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
  // Localized "Save" + a universal unsaved-state marker.
  document.getElementById("btn-save").textContent = t("common.save") + "*";
}

function createNewTheme() {
  const base = BUILT_IN_THEMES[0];
  const newTheme = {
    id: crypto.randomUUID(),
    name: t("themeEditor.newThemeName"),
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
    name: t("themeEditor.cloneName", { name: source.name }),
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
  document.getElementById("btn-save").textContent = t("common.save");
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
        document.getElementById("btn-save").textContent = t("common.save");
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
    name: String(data.name ?? t("themeEditor.importedThemeName")),
    colorScheme: data.colorScheme === "light" ? "light" : "dark",
    vars: {},
  };
  for (const key of VAR_KEYS) {
    newTheme.vars[key] = normalizeHex(data.vars[key] ?? "") ?? "#000000";
  }
  // Carry over any metric tokens the imported theme defines, normalized to
  // "<n>px"; absent or non-numeric tokens are simply omitted (they fall back to
  // the :root default at render time).
  for (const key of METRIC_KEYS) {
    const n = parseMetric(data.vars[key]);
    if (n !== null) newTheme.vars[key] = `${n}px`;
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
  // { __hippoError } envelope. This editor is a separate window with no toast
  // surface, so it cannot route into Notifications — but it must NOT broadcast
  // the themes as persisted, or the running app would show phantom themes that
  // vanish on the next restart (silent data loss). Surface the failure instead.
  if (result && result.__hippoError === true) {
    console.error("[theme-editor] saveManifest failed:", result.message);
    window.alert(
      t("themeEditor.saveFailed", {
        message: result.message || t("themeEditor.unknownError"),
      }),
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
