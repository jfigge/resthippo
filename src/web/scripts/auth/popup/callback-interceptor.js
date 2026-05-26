/**
 * auth/popup/callback-interceptor.js
 *
 * Helpers that open the Electron OAuth popup window and parse the callback URL.
 *
 * All popup-based flows (Authorization Code, Implicit) MUST go through
 * window.wurl.oauth.openPopup — never modify the renderer's own window.location
 * or use window.open() which Electron routes through setWindowOpenHandler.
 *
 * In dev-server (non-Electron) mode a graceful error is returned because
 * OAuth popup flows require Electron's BrowserWindow internals to intercept
 * the redirect.
 */

"use strict";

import {
  OAuthError,
  OAuthErrorCode,
  popupCancelledError,
} from "../types/oauth-errors.js";

/** Default redirect URI used when none is supplied. */
export const DEFAULT_REDIRECT_URI = "http://localhost:7777/oauth/callback";

/**
 * Open the Electron OAuth popup window and wait for the redirect callback.
 *
 * Resolves with the full callback URL string on success.
 * Rejects with an OAuthError on cancellation or unavailability.
 *
 * @param {string} authUrl     - Full authorization URL (including all query params)
 * @param {string} redirectUri - The redirect_uri registered with the OAuth server
 * @param {string} [title]     - Popup window title
 * @returns {Promise<string>}  Callback URL (e.g. "http://localhost:7777/oauth/callback?code=…")
 */
export async function openOAuthPopup(
  authUrl,
  redirectUri,
  title = "OAuth Authorization",
) {
  if (typeof window.wurl?.oauth?.openPopup !== "function") {
    throw new OAuthError(
      OAuthErrorCode.POPUP_UNAVAILABLE,
      "OAuth popup is only available inside the Electron app. " +
        "When running via the dev-server, use a flow that does not require a browser popup " +
        "(e.g. Client Credentials or Resource Owner Password).",
    );
  }

  const result = await window.wurl.oauth.openPopup(authUrl, redirectUri, title);

  if (result?.cancelled || !result?.url) {
    throw popupCancelledError();
  }

  return result.url;
}
