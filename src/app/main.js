// main.js — Electron main process for wurl
"use strict";

const { app, BrowserWindow, ipcMain, shell, Menu, nativeImage } = require("electron");
const fs    = require("fs");
const path  = require("path");
const http  = require("http");
const https = require("https");
const { URL } = require("url");

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

// ─── HTTP Execute IPC ─────────────────────────────────────────────────────────
// Performs the actual outgoing HTTP/HTTPS request in the main (Node.js) process
// so the sandboxed renderer never touches the network directly.
// Returns a rich result object including a verbose console log.
(function initHttpIPC() {
  /**
   * Perform one HTTP request leg (no redirect logic here — handled below).
   * Returns a Promise that always resolves (never rejects) with a result object.
   *
   * @param {object}   desc        - Normalised request descriptor
   * @param {string[]} consoleLog  - Mutable array for verbose output lines
   * @param {number}   startTime   - Date.now() at the very start of the call
   * @param {number}   redirects   - How many redirects have been followed so far
   */
  function doRequest(desc, consoleLog, startTime, redirects) {
    const {
      method          = "GET",
      url: rawUrl,
      headers         = {},
      body            = null,
      bodyFilePath    = null,
      timeout         = 30000,
      followRedirects = true,
      verifySsl       = true,
      maxRedirects    = 10,
    } = desc;

    return new Promise((resolve) => {
      // ── Parse URL ──────────────────────────────────────────────────────────
      let parsed;
      try {
        parsed = new URL(rawUrl);
      } catch (e) {
        consoleLog.push(`* URL parse error: ${e.message}`);
        resolve({
          status: 0, statusText: "", headers: {}, cookies: [], body: "",
          elapsed: Date.now() - startTime, size: 0, consoleLog,
          error: { name: "TypeError", message: e.message },
        });
        return;
      }

      const isHttps    = parsed.protocol === "https:";
      const lib        = isHttps ? https : http;
      const defaultPort = isHttps ? 443 : 80;
      const port       = parsed.port ? parseInt(parsed.port, 10) : defaultPort;
      const effectiveMethod = method.toUpperCase();

      // ── Resolve body ───────────────────────────────────────────────────────
      const reqHeaders = { ...headers };
      let bodyBuffer   = null;

      if (redirects === 0) {
        if (bodyFilePath) {
          try {
            bodyBuffer = fs.readFileSync(bodyFilePath);
            if (!reqHeaders["Content-Length"])
              reqHeaders["Content-Length"] = String(bodyBuffer.length);
          } catch (e) {
            consoleLog.push(`* File read error: ${e.message}`);
          }
        } else if (body) {
          bodyBuffer = Buffer.from(body, "utf8");
          if (!reqHeaders["Content-Length"])
            reqHeaders["Content-Length"] = String(bodyBuffer.length);
        }
      }

      // ── Log outgoing request ───────────────────────────────────────────────
      consoleLog.push(`> ${effectiveMethod} ${parsed.pathname}${parsed.search} HTTP/1.1`);
      consoleLog.push(`> Host: ${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`);
      Object.entries(reqHeaders).forEach(([k, v]) => consoleLog.push(`> ${k}: ${v}`));
      consoleLog.push(">");

      // ── Make the request ───────────────────────────────────────────────────
      const options = {
        hostname: parsed.hostname,
        port,
        path: parsed.pathname + parsed.search,
        method: effectiveMethod,
        headers: reqHeaders,
        timeout,
        rejectUnauthorized: verifySsl,
      };

      const req = lib.request(options, (res) => {
        const code    = res.statusCode;
        const phrase  = res.statusMessage;

        // ── Redirect handling ────────────────────────────────────────────────
        if (followRedirects && [301, 302, 303, 307, 308].includes(code)) {
          const location = res.headers["location"];
          consoleLog.push(`< HTTP/1.1 ${code} ${phrase}`);
          Object.entries(res.headers).forEach(([k, v]) => {
            const vals = Array.isArray(v) ? v : [v];
            vals.forEach(vi => consoleLog.push(`< ${k}: ${vi}`));
          });
          consoleLog.push("<");

          if (!location) {
            consoleLog.push("* Redirect missing Location header — stopping");
            res.resume();
            resolve({
              status: code, statusText: phrase,
              headers: flatHeaders(res.headers), cookies: extractCookies(res.headers),
              body: "", elapsed: Date.now() - startTime, size: 0, consoleLog,
            });
            return;
          }
          if (redirects >= maxRedirects) {
            consoleLog.push(`* Too many redirects (max ${maxRedirects})`);
            res.resume();
            resolve({
              status: code, statusText: phrase,
              headers: flatHeaders(res.headers), cookies: extractCookies(res.headers),
              body: "", elapsed: Date.now() - startTime, size: 0, consoleLog,
              error: { name: "RedirectError", message: `Too many redirects (max ${maxRedirects})` },
            });
            return;
          }

          let redirectUrl;
          try { redirectUrl = new URL(location, rawUrl).toString(); }
          catch (_) { redirectUrl = location; }

          // HTTP 303 → always GET; POST 301/302 → GET (browser convention)
          const newMethod = (code === 303 || ([301, 302].includes(code) && effectiveMethod === "POST"))
            ? "GET" : effectiveMethod;

          consoleLog.push(`* Redirect ${redirects + 1} → ${redirectUrl}`);
          res.resume(); // drain the redirect body

          doRequest(
            { ...desc, method: newMethod, url: redirectUrl,
              body:         newMethod === "GET" ? null : body,
              bodyFilePath: newMethod === "GET" ? null : bodyFilePath },
            consoleLog, startTime, redirects + 1
          ).then(resolve);
          return;
        }

        // ── Normal response ──────────────────────────────────────────────────
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const elapsed   = Date.now() - startTime;
          const rawBody   = Buffer.concat(chunks);
          const bodyText  = rawBody.toString("utf8");
          const size      = rawBody.length;

          consoleLog.push(`< HTTP/1.1 ${code} ${phrase}`);
          Object.entries(res.headers).forEach(([k, v]) => {
            const vals = Array.isArray(v) ? v : [v];
            vals.forEach(vi => consoleLog.push(`< ${k}: ${vi}`));
          });
          consoleLog.push("<");
          consoleLog.push(`* Received ${size} bytes in ${elapsed}ms`);

          resolve({
            status: code, statusText: phrase,
            headers: flatHeaders(res.headers),
            cookies: extractCookies(res.headers),
            body: bodyText, elapsed, size, consoleLog,
          });
        });

        res.on("error", (err) => {
          const elapsed = Date.now() - startTime;
          consoleLog.push(`* Stream error: ${err.message}`);
          resolve({
            status: code, statusText: phrase, headers: {}, cookies: [],
            body: "", elapsed, size: 0, consoleLog,
            error: { name: "StreamError", message: err.message },
          });
        });
      });

      req.on("timeout", () => {
        consoleLog.push(`* Timed out after ${timeout}ms`);
        req.destroy(new Error(`Request timed out after ${timeout}ms`));
      });

      req.on("error", (err) => {
        const elapsed = Date.now() - startTime;
        consoleLog.push(`* ${err.message}`);
        resolve({
          status: 0, statusText: "", headers: {}, cookies: [],
          body: "", elapsed, size: 0, consoleLog,
          error: { name: err.code || err.name || "NetworkError", message: err.message },
        });
      });

      if (bodyBuffer) req.write(bodyBuffer);
      req.end();
    });
  }

  /** Flatten Node's multi-value header object into a plain key→string map. */
  function flatHeaders(hdrs) {
    const out = {};
    Object.entries(hdrs).forEach(([k, v]) => {
      out[k] = Array.isArray(v) ? v.join(", ") : v;
    });
    return out;
  }

  /** Extract Set-Cookie header values as a string array. */
  function extractCookies(hdrs) {
    const sc = hdrs["set-cookie"];
    return Array.isArray(sc) ? sc : (sc ? [sc] : []);
  }

  // ── IPC handler ─────────────────────────────────────────────────────────────
  ipcMain.handle("http:execute", async (_event, descriptor) => {
    const consoleLog = [];
    const startTime  = Date.now();
    consoleLog.push(`* Connecting to ${descriptor.url}`);
    console.log("[http:execute] →", descriptor.method, descriptor.url);
    try {
      const result = await doRequest(descriptor, consoleLog, startTime, 0);
      console.log("[http:execute] ←", result.status, result.statusText, `${result.elapsed}ms`);
      return result;
    } catch (err) {
      console.error("[http:execute] unexpected error:", err);
      consoleLog.push(`* Unexpected error: ${err.message}`);
      return {
        status: 0, statusText: "", headers: {}, cookies: [], body: "",
        elapsed: Date.now() - startTime, size: 0, consoleLog,
        error: { name: err.name || "Error", message: err.message },
      };
    }
  });
})();

// ─── App icon ─────────────────────────────────────────────────────────────────
// Resolved once at startup; used for both the BrowserWindow and the macOS dock.
const APP_ICON_PATH = path.join(__dirname, "..", "web", "wurl-logo.png");
const appIcon = nativeImage.createFromPath(APP_ICON_PATH);

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
    icon: appIcon,
    backgroundColor: "#1e1e2e",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,   // Renderer cannot access Node APIs directly
      nodeIntegration: false,   // Keep Node out of the renderer
      sandbox: true,            // Extra process isolation
      // Disable Chromium's web security (CORS, same-origin policy) so the
      // renderer can make fetch() calls to any host without restriction.
      // This is intentional for a desktop HTTP testing tool — requests from
      // the renderer go through the main-process IPC bridge (Node.js http/https),
      // not through Chromium's networking stack, but disabling web security
      // prevents Chromium from blocking anything that might slip through.
      webSecurity: false,
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
  // Set the macOS dock icon (no-op on Windows/Linux).
  if (process.platform === "darwin" && app.dock) {
    app.dock.setIcon(appIcon);
  }

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
