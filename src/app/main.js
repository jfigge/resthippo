// main.js — Electron main process for wurl
"use strict";

const { app, BrowserWindow, ipcMain, shell, Menu } = require("electron");
const fs   = require("fs");
const path = require("path");

const isDev = process.argv.includes("--dev");
const DEV_SERVER_PORT = process.env.SERVER_PORT || 8080;

// ─── Collections IPC ──────────────────────────────────────────────────────────
// Register handlers before app.whenReady() so they are ready the moment the
// renderer process makes its first invoke() call.
(function initCollectionsIPC() {
  // Electron resolves app.getPath('userData') to the correct platform directory:
  //   macOS:   ~/Library/Application Support/wurl
  //   Linux:   ~/.config/wurl
  //   Windows: %APPDATA%\wurl
  const dataFile = () => path.join(app.getPath("userData"), "collections.json");

  /**
   * Return the full stored data document, or safe defaults on first run / error.
   * Shape: { version, collections, settings }
   */
  ipcMain.handle("collections:read", async () => {
    const file = dataFile();
    try {
      if (!fs.existsSync(file)) return { version: 1, collections: [], settings: {} };
      const raw    = fs.readFileSync(file, "utf8");
      const parsed = JSON.parse(raw);
      return {
        version:     parsed.version     ?? 1,
        collections: Array.isArray(parsed.collections) ? parsed.collections : [],
        settings:    parsed.settings    ?? {},
      };
    } catch (err) {
      console.error("[main] collections:read error:", err.message);
      return { version: 1, collections: [], settings: {} };
    }
  });

  /**
   * Atomically overwrite the stored data file with the supplied document.
   * Accepts: { version, collections, settings }
   */
  ipcMain.handle("collections:write", async (_event, doc) => {
    const file = dataFile();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const payload = JSON.stringify({ version: 1, ...doc }, null, 2);
      fs.writeFileSync(file, payload, "utf8");
    } catch (err) {
      console.error("[main] collections:write error:", err.message);
    }
  });
})();

// ─── Window creation ──────────────────────────────────────────────────────────
function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    // Minimum enforced so splitter drag minimums (nav≥160, res≥160, request≥200)
    // are always achievable without the window becoming unusably cramped.
    //   landscape  : 160 + 4 + 200 + 4 + 160 = 528 px minimum columns
    //   height     : 44 header + 500 content   = 544 px
    minWidth: 800,
    minHeight: 560,
    title: "wurl",
    backgroundColor: "#1e1e2e",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, // Renderer cannot access Node APIs directly
      nodeIntegration: false, // Keep Node out of the renderer
      sandbox: true, // Extra isolation
    },
  });

  if (isDev) {
    // Development: load from the Go dev server
    win.loadURL(`http://localhost:${DEV_SERVER_PORT}`);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    // Production: load bundled web assets
    win.loadFile(path.join(__dirname, "..", "web", "index.html"));
  }

  // Open <a target="_blank"> links in the system browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  return win;
}

// ─── Application menu ─────────────────────────────────────────────────────────
function buildMenu() {
  const template = [
    {
      label: "wurl",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  buildMenu();
  createWindow();

  app.on("activate", () => {
    // macOS: re-create window when dock icon is clicked with no open windows
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
