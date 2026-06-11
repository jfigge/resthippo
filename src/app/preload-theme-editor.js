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
