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

"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("themeEditor", {
  platform: process.platform,
  // Same catalog resolver the main window uses (persisted locale → OS → English);
  // this separate window resolves and applies it once at startup. See i18n.js.
  i18n: { load: () => ipcRenderer.invoke("i18n:load") },
  getManifest: () => ipcRenderer.invoke("store:manifest:get"),
  saveManifest: (data) => ipcRenderer.invoke("store:manifest:save", data),
  previewTheme: (themeData) => ipcRenderer.send("theme:preview", themeData),
  notifyThemesChanged: (customThemes) =>
    ipcRenderer.send("theme:editor:notify", customThemes),
  applyTheme: (themeId) => ipcRenderer.send("theme:editor:apply", themeId),
  exportTheme: (themeData) => ipcRenderer.invoke("theme:export", themeData),
  importTheme: () => ipcRenderer.invoke("theme:import"),
});
