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
