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

/**
 * ipc/oauth.js — OAuth 2.0 popup IPC.
 *
 * Extracted verbatim (behaviour-preserving) from main.js's initOAuthIPC. Opens a
 * sandboxed BrowserWindow popup for authorization-code / implicit flows; when the
 * IdP redirects back to the registered redirect_uri the navigation is intercepted,
 * the callback URL extracted, and the window closed. The redirect matcher and the
 * authorization-URL scheme guard are pure + security-sensitive and live (and are
 * unit-tested) in ./oauth-redirect.
 *
 *   oauth:open-popup   → { url, cancelled }
 *   oauth:clear-session → clears the default session (cookies/cache/storage)
 */
"use strict";

const { BrowserWindow, session } = require("electron");
const {
  isHttpUrl: isHttpAuthUrl,
  matchesRedirect,
} = require("../oauth-redirect");

/**
 * @param {object} deps
 * @param {Electron.IpcMain} deps.ipcMain
 * @param {() => Electron.BrowserWindow | null} deps.getMainWin
 * @param {() => (key: string, fallback: string) => string} deps.activeLabels
 */
function registerOAuthIPC({ ipcMain, getMainWin, activeLabels }) {
  ipcMain.handle(
    "oauth:open-popup",
    (_event, { authUrl, redirectUri, title }) => {
      return new Promise((resolve) => {
        // Only ever load an http(s) authorization endpoint. authUrl is built from
        // the user's OAuth config, but a stray `file:`/`data:`/`javascript:` value
        // must never reach loadURL — it would load in this app-origin (if sandboxed)
        // popup. Reject before the window is even created.
        if (!isHttpAuthUrl(authUrl)) {
          console.error("[oauth:popup] refusing non-http(s) authorization URL");
          resolve({ url: null, cancelled: true });
          return;
        }

        const popup = new BrowserWindow({
          width: 860,
          height: 720,
          title:
            title || activeLabels()("dialog.oauthTitle", "OAuth Authorization"),
          parent: getMainWin() || undefined,
          modal: false,
          show: false,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
          },
          autoHideMenuBar: true,
        });

        // Only reveal the window once the page is actually painted — if the auth
        // server immediately redirects (e.g. SSO session already active) the flow
        // resolves before this fires and the window is never shown.
        popup.once("ready-to-show", () => {
          if (!_resolved) popup.show();
        });

        let _resolved = false;

        /**
         * Resolve the pending promise and close the popup exactly once.
         * @param {{ url: string|null, cancelled: boolean }} result
         */
        function _finish(result) {
          if (_resolved) return;
          _resolved = true;
          try {
            if (!popup.isDestroyed()) {
              popup.webContents.stop();
              popup.close();
            }
          } catch {
            /* already destroyed */
          }
          resolve(result);
        }

        // A malicious or compromised IdP page must not be able to spawn child
        // windows (popunders, new BrowserWindows inheriting this context). The
        // whole flow happens by navigation in this single window.
        popup.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

        // ── Intercept any navigation to the redirect URI (fires BEFORE request) ──
        popup.webContents.on("will-navigate", (e, url) => {
          if (matchesRedirect(url, redirectUri)) {
            e.preventDefault();
            _finish({ url, cancelled: false });
          }
        });

        // ── Intercept server-initiated redirects (3xx) ─────────────────────────
        popup.webContents.on("will-redirect", (e, url) => {
          if (matchesRedirect(url, redirectUri)) {
            e.preventDefault();
            _finish({ url, cancelled: false });
          }
        });

        // ── Catch successful navigations (e.g. custom protocol handlers) ───────
        popup.webContents.on("did-navigate", (_e, url) => {
          if (matchesRedirect(url, redirectUri))
            _finish({ url, cancelled: false });
        });
        popup.webContents.on("did-navigate-in-page", (_e, url) => {
          if (matchesRedirect(url, redirectUri))
            _finish({ url, cancelled: false });
        });

        // ── Catch failed loads — e.g. http://localhost redirect with no listener ─
        // The browser will fail to connect to the localhost redirect, but the URL
        // still contains the authorization code we need.
        popup.webContents.on(
          "did-fail-load",
          (_e, _code, _desc, validatedUrl) => {
            if (matchesRedirect(validatedUrl, redirectUri)) {
              _finish({ url: validatedUrl, cancelled: false });
            }
          },
        );

        // ── User closed the window before completing login ─────────────────────
        popup.on("closed", () => _finish({ url: null, cancelled: true }));

        // ── Load the authorization URL ─────────────────────────────────────────
        popup.loadURL(authUrl).catch((err) => {
          console.error("[oauth:popup] loadURL error:", err.message);
          _finish({ url: null, cancelled: true });
        });
      });
    },
  );

  /**
   * Clear the default Electron session's storage data and cache.
   *
   * Erases all cookies, localStorage, sessionStorage, IndexedDB entries, and
   * the network cache that may be holding an authenticated IdP session.  After
   * calling this, the next OAuth authorization-code / implicit flow will present
   * a fresh login page rather than silently re-using a cached session.
   */
  ipcMain.handle("oauth:clear-session", async () => {
    try {
      await session.defaultSession.clearStorageData({
        storages: [
          "cookies",
          "sessionstorage",
          "localstorage",
          "indexdb",
          "shadercache",
          "websql",
          "serviceworkers",
          "cachestorage",
        ],
      });
      await session.defaultSession.clearCache();
      console.log("[oauth] Session cleared");
    } catch (err) {
      console.error("[oauth] clearSession error:", err.message);
    }
  });
}

module.exports = { registerOAuthIPC };
