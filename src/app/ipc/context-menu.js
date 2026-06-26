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
 * ipc/context-menu.js — native OS context-menu IPC.
 *
 * Extracted verbatim (behaviour-preserving) from main.js's initContextMenuIPC.
 * `ui:context-menu:show` pops a real OS context menu at (x, y) within the calling
 * window and resolves with the id of the clicked item — or null if dismissed.
 *
 * Items shape: [{ id, label, type?: "separator"|"checkbox"|"radio", enabled?,
 *                 checked?, accelerator?, iconDataUrl? }]
 */
"use strict";

const { Menu, BrowserWindow, nativeImage } = require("electron");

/**
 * @param {object} deps
 * @param {Electron.IpcMain} deps.ipcMain
 * @param {() => Electron.BrowserWindow | null} deps.getMainWin
 */
function registerContextMenu({ ipcMain, getMainWin }) {
  ipcMain.handle("ui:context-menu:show", (event, { items, x, y } = {}) => {
    return new Promise((resolve) => {
      let resultId = null;

      const template = (items ?? []).map((item) => {
        if (item?.type === "separator") return { type: "separator" };
        const entry = {
          label: String(item.label ?? ""),
          enabled: item.enabled !== false,
          click: () => {
            resultId = item.id ?? null;
          },
        };
        if (item.accelerator) {
          // Display-only: advertise the shortcut next to the item. The renderer
          // owns these keystrokes (focus-scoped), so the transient context menu
          // must not register them as global accelerators.
          entry.accelerator = String(item.accelerator);
          entry.registerAccelerator = false;
        }
        if (item.type === "checkbox" || item.type === "radio") {
          entry.type = item.type;
          entry.checked = !!item.checked;
        }
        if (item.iconDataUrl) {
          // The renderer rasterises an SVG glyph to a small black PNG data URL;
          // on macOS we mark it a template image so it follows the menu's
          // light/dark appearance. A bad/empty URL simply shows no icon.
          try {
            const img = nativeImage.createFromDataURL(String(item.iconDataUrl));
            if (img && !img.isEmpty()) {
              if (process.platform === "darwin") img.setTemplateImage(true);
              entry.icon = img;
            }
          } catch {
            /* ignore — item renders without an icon */
          }
        }
        return entry;
      });

      const menu = Menu.buildFromTemplate(template);
      const win =
        BrowserWindow.fromWebContents(event.sender) ??
        getMainWin() ??
        undefined;

      const popupOpts = { window: win, callback: () => resolve(resultId) };
      if (Number.isFinite(x) && Number.isFinite(y)) {
        popupOpts.x = Math.round(x);
        popupOpts.y = Math.round(y);
      }
      menu.popup(popupOpts);
    });
  });
}

module.exports = { registerContextMenu };
