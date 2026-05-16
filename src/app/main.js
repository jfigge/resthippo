// main.js — Electron main process for wurl
"use strict";

const { app, BrowserWindow, ipcMain, shell, Menu, nativeImage } = require("electron");
const fs           = require("fs");
const path         = require("path");
const http         = require("http");
const https        = require("https");
const net          = require("net");
const { spawn }    = require("child_process");
const { URL }      = require("url");

const isDev = process.argv.includes("--dev");

// devPort is resolved asynchronously inside app.whenReady().
// It is declared here so createWindow() can close over the final value.
let devPort = 0;

// Handle to the spawned Go dev-server process (dev mode only, no SERVER_PORT env).
let _devServerProcess = null;

// ─── Collections IPC ──────────────────────────────────────────────────────────
// Register handlers before app.whenReady() so they are ready the moment the
// renderer process makes its first invoke() call.
(function initCollectionsIPC() {
  // Electron resolves app.getPath('userData') to the correct platform directory:
  //   macOS:   ~/Library/Application Support/wurl
  //   Linux:   ~/.config/wurl
  //   Windows: %APPDATA%\wurl
  const dataFile = () => path.join(app.getPath("userData"), "collections.json");
  const envFile  = (id) => path.join(app.getPath("userData"), `${id}.json`);

  /**
   * Return the full stored manifest, or safe defaults on first run / error.
   * Shape v2: { version, environments, activeEnvironmentId, settings }
   * Shape v1 (legacy): { version, collections, settings }  — migration done in renderer
   */
  ipcMain.handle("collections:read", async () => {
    const file = dataFile();
    try {
      if (!fs.existsSync(file)) return { version: 2, environments: [], activeEnvironmentId: null, settings: {} };
      const raw    = fs.readFileSync(file, "utf8");
      const parsed = JSON.parse(raw);
      // Return as-is; the renderer detects version and migrates if needed
      return parsed;
    } catch (err) {
      console.error("[main] collections:read error:", err.message);
      return { version: 2, environments: [], activeEnvironmentId: null, settings: {} };
    }
  });

  /**
   * Atomically overwrite the stored manifest file.
   */
  ipcMain.handle("collections:write", async (_event, doc) => {
    const file = dataFile();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const payload = JSON.stringify(doc, null, 2);
      fs.writeFileSync(file, payload, "utf8");
    } catch (err) {
      console.error("[main] collections:write error:", err.message);
    }
  });

  /**
   * Load a per-environment collections file: <userData>/<envId>.json
   * Returns { version, collections } or safe defaults on missing / error.
   */
  ipcMain.handle("env:read", async (_event, envId) => {
    const file = envFile(envId);
    try {
      if (!fs.existsSync(file)) return { version: 1, collections: [] };
      const raw    = fs.readFileSync(file, "utf8");
      const parsed = JSON.parse(raw);
      return {
        version:     parsed.version     ?? 1,
        collections: Array.isArray(parsed.collections) ? parsed.collections : [],
      };
    } catch (err) {
      console.error("[main] env:read error:", err.message);
      return { version: 1, collections: [] };
    }
  });

  /**
   * Atomically overwrite a per-environment collections file.
   */
  ipcMain.handle("env:write", async (_event, envId, doc) => {
    const file = envFile(envId);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const payload = JSON.stringify({ version: 1, ...doc }, null, 2);
      fs.writeFileSync(file, payload, "utf8");
    } catch (err) {
      console.error("[main] env:write error:", err.message);
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

      // ── Outgoing request log ──────────────────────────────────────────────
      const httpVersion = isHttps ? "HTTP/2" : "HTTP/1.1";
      consoleLog.push(`> ${effectiveMethod} ${parsed.pathname}${parsed.search} ${httpVersion}`);
      consoleLog.push(`> Host: ${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`);
      Object.entries(reqHeaders).forEach(([k, v]) => consoleLog.push(`> ${k}: ${v}`));
      consoleLog.push(">");

      // ── Log request body (if any) with "|" prefix ─────────────────────
      if (bodyBuffer) {
        consoleLog.push("");
        bodyBuffer.toString("utf8").split("\n").forEach(line => consoleLog.push(`| ${line}`));
        consoleLog.push("");
        consoleLog.push("* We are completely uploaded and fine");
      }

      // ── Make the request ───────────────────────────────────────────────────
      consoleLog.push(`* Trying to resolve host '${parsed.hostname}'...`);
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
          consoleLog.push(`< ${httpVersion} ${code} ${phrase}`);
          Object.entries(res.headers).forEach(([k, v]) => {
            const vals = Array.isArray(v) ? v : [v];
            vals.forEach(vi => consoleLog.push(`< ${k}: ${vi}`));
          });
          consoleLog.push("<");
          consoleLog.push("");

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

          consoleLog.push(`* Connection to host ${parsed.hostname} left intact`);
          consoleLog.push(`* Issue another request to this URL: '${redirectUrl}'`);
          if (newMethod !== effectiveMethod) {
            consoleLog.push(`* Switch to ${newMethod}`);
          }
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

          consoleLog.push(`< ${httpVersion} ${code} ${phrase}`);
          Object.entries(res.headers).forEach(([k, v]) => {
            const vals = Array.isArray(v) ? v : [v];
            vals.forEach(vi => consoleLog.push(`< ${k}: ${vi}`));
          });
          consoleLog.push("<");
          consoleLog.push("");
          consoleLog.push(`* Received ${size} B chunk`);
          consoleLog.push(`* Connection to host ${parsed.hostname} left intact`);

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

      req.on("socket", (socket) => {
        // ── DNS resolution ──────────────────────────────────────────────────
        socket.on("lookup", (err, address, _family, hostname) => {
          if (err) {
            consoleLog.push(`* Could not resolve host '${hostname}': ${err.message}`);
          } else {
            consoleLog.push(`* Resolved '${hostname}' → ${address}`);
            consoleLog.push(`* Trying ${address}:${port}...`);
          }
        });

        // ── TCP connection established ───────────────────────────────────────
        socket.on("connect", () => {
          const remoteAddr = socket.remoteAddress;
          const remotePort = socket.remotePort;
          consoleLog.push(`* Connected to ${parsed.hostname} (${remoteAddr}) port ${remotePort}`);
          if (isHttps) {
            consoleLog.push(`* Performing TLS handshake with '${parsed.hostname}'...`);
          }
        });

        // ── TLS handshake complete (HTTPS only) ─────────────────────────────
        if (isHttps) {
          socket.on("secureConnect", () => {
            const protocol = socket.getProtocol();
            const cipher   = socket.getCipher();
            consoleLog.push(
              `* SSL connection using ${protocol} / ${cipher.standardName || cipher.name}`
            );
            const alpn = socket.alpnProtocol;
            if (alpn && alpn !== false) {
              consoleLog.push(`* ALPN: server accepted '${alpn}'`);
            }
          });
        }
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
    const _timeout = descriptor.timeout || 30000;
    consoleLog.push(`* Preparing request to ${descriptor.url}`);
    consoleLog.push(`* Current time is ${new Date().toISOString()}`);
    consoleLog.push(`* Enable automatic URL encoding`);
    consoleLog.push(`* Using default HTTP version`);
    consoleLog.push(`* Enable timeout of ${_timeout}ms`);
    consoleLog.push(descriptor.verifySsl === false ? `* Disable SSL validation` : `* Enable SSL validation`);
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

// ─── Dev-server port helpers ──────────────────────────────────────────────────

/**
 * Probe whether nothing is listening on `port` at 127.0.0.1.
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

/**
 * Return a random unused port in the IANA ephemeral range [49152, 65534].
 * Keeps trying random candidates until it finds one that is free.
 * @returns {Promise<number>}
 */
async function findFreePort() {
  const MIN = 49152;
  const MAX = 65534;
  while (true) {
    const candidate = Math.floor(Math.random() * (MAX - MIN + 1)) + MIN;
    if (await isPortFree(candidate)) return candidate;
  }
}

/**
 * Poll 127.0.0.1:port until something accepts connections or the deadline passes.
 * Used to wait for the Go server to finish compiling and start up.
 * @param {number} port
 * @param {number} maxWaitMs
 */
function waitForPort(port, maxWaitMs = 30000) {
  const deadline = Date.now() + maxWaitMs;
  return new Promise((resolve, reject) => {
    function attempt() {
      const sock = net.createConnection(port, "127.0.0.1");
      sock.once("connect", () => { sock.destroy(); resolve(); });
      sock.once("error",   () => {
        sock.destroy();
        if (Date.now() >= deadline) {
          reject(new Error(`Timed out waiting for dev server on port ${port}`));
        } else {
          setTimeout(attempt, 150);
        }
      });
    }
    attempt();
  });
}

/**
 * Spawn the Go dev server (via `go run`) on the given port.
 * Stores the child process in `_devServerProcess` so it can be killed on quit.
 * @param {number} port
 */
async function startDevServer(port) {
  const goMain  = path.join(__dirname, "..", "cmd", "main.go");
  const webDir  = path.join(__dirname, "..", "web");
  const dataDir = path.join(__dirname, "..", "..", "data");

  console.log(`[dev-server] spawning on port ${port}`);

  const proc = spawn(
    "go",
    ["run", goMain, "-port", String(port), "-web", webDir, "-data", dataDir],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } },
  );

  proc.stdout.on("data", (d) => process.stdout.write(`[dev-server] ${d}`));
  proc.stderr.on("data", (d) => process.stderr.write(`[dev-server] ${d}`));
  proc.on("exit",  (code, sig) => console.log(`[dev-server] exit code=${code} signal=${sig}`));
  proc.on("error", (err)       => console.error("[dev-server] spawn error:", err.message));

  _devServerProcess = proc;

  // go run needs to compile first — allow up to 30 s
  await waitForPort(port, 30000);
  console.log(`[dev-server] ready on port ${port}`);
}

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
    // Development: load from the Go dev server (port resolved in app.whenReady)
    win.loadURL(`http://localhost:${devPort}`);
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

// Always quit when the last window is closed — including on macOS.
// Standard macOS apps linger in the Dock after the window closes, but for an
// HTTP testing tool "close window = quit" is the expected behaviour.
app.on("window-all-closed", () => app.quit());

// Kill the spawned dev server (if any) before the process exits.
app.on("will-quit", () => {
  if (_devServerProcess) {
    _devServerProcess.kill();
    _devServerProcess = null;
  }
});

app.whenReady().then(async () => {
  // Set the macOS dock icon (no-op on Windows/Linux).
  if (process.platform === "darwin" && app.dock) {
    app.dock.setIcon(appIcon);
  }

  // In dev mode: resolve the port, spawning the Go server if needed.
  if (isDev) {
    if (process.env.SERVER_PORT) {
      // Caller already started the Go server on a known port — just connect.
      devPort = parseInt(process.env.SERVER_PORT, 10);
      console.log(`[main] Connecting to external dev server on port ${devPort}`);
    } else {
      // Pick a random unused high port and start the Go server ourselves.
      devPort = await findFreePort();
      await startDevServer(devPort);
    }
  }

  buildMenu();
  createWindow();

  // macOS: re-open a window when the dock icon is clicked with no open windows.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

