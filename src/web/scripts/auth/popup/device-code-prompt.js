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
 * auth/popup/device-code-prompt.js
 *
 * Renderer UI for the OAuth 2.0 Device Authorization Grant (RFC 8628): a modal
 * that shows the user-code and verification URL the user must visit on a second
 * device, plus a live polling-status line, while flows/device-code.js polls the
 * token endpoint in the background.
 *
 * Mirrors popup/callback-interceptor.js: the flow imports this helper directly
 * (the UI-agnostic OAuthExecutor never passes UI callbacks through). The modal
 * itself is opened through the shared PopupManager so it gets the standard
 * mask / focus / lifecycle handling.
 *
 * Headless-safe: when there is no DOM (unit tests, the Go dev-server), this is a
 * no-op that returns an inert handle, so flows/device-code.js stays unit-testable
 * with a mocked token endpoint and no popup ever appears.
 */

"use strict";

import { t } from "../../i18n.js";
import { escapeHtml } from "../../utils/html.js";
import { icon } from "../../icons.js";

// PopupManager registers window listeners at module load, so it must NOT be
// imported statically: that would break the headless unit tests (and the Go
// dev-server) that load the device-code flow but have no `window`. It is
// dynamically imported below, only after the DOM guard has passed.

/** Inert handle used when no DOM is available (tests / dev-server). */
const NOOP_HANDLE = Object.freeze({ update() {}, close() {} });

/**
 * Show the device-code prompt.
 *
 * @param {object} info
 * @param {string} info.userCode                  - user_code to display (RFC 8628 §3.2)
 * @param {string} info.verificationUri           - verification_uri the user visits
 * @param {string} [info.verificationUriComplete] - verification_uri_complete (URI + code)
 * @param {number} [info.expiresIn]               - device_code lifetime in seconds
 * @param {object} [handlers]
 * @param {() => void} [handlers.onCancel] - invoked when the user dismisses the prompt
 * @returns {Promise<{ update: (patch: { status?: string, error?: string }) => void, close: () => void }>}
 */
export async function showDeviceCodePrompt(info, { onCancel } = {}) {
  if (typeof document === "undefined") return NOOP_HANDLE;

  const { PopupManager } = await import("../../popup-manager.js");

  const {
    userCode = "",
    verificationUri = "",
    verificationUriComplete = "",
    expiresIn = null,
  } = info ?? {};

  const dlg = document.createElement("div");
  dlg.className = "popup popup-device-code";
  dlg.setAttribute("role", "dialog");
  dlg.setAttribute("aria-modal", "true");
  dlg.setAttribute("aria-label", t("auth.oauth2.device.title"));

  // The complete URI (verification_uri_complete) already embeds the user code,
  // so it is the most convenient link; fall back to the plain verification_uri.
  const linkHref = verificationUriComplete || verificationUri;
  const expiresLine =
    expiresIn != null
      ? `<p class="device-code-expires">${t("auth.oauth2.device.expires", {
          minutes: Math.max(1, Math.round(Number(expiresIn) / 60)),
        })}</p>`
      : "";

  dlg.innerHTML = `
    <div class="popup-header">
      <span class="popup-title">${t("auth.oauth2.device.title")}</span>
      <button class="popup-close" aria-label="${t("common.close")}" data-action="cancel" title="${t("common.close")}">${icon("close", { size: 13 })}</button>
    </div>
    <div class="popup-body device-code-body">
      <p class="device-code-desc">${t("auth.oauth2.device.desc")}</p>
      <a class="device-code-uri" href="${escapeHtml(linkHref)}" target="_blank" rel="noopener noreferrer">${escapeHtml(verificationUri)}</a>
      <p class="device-code-label">${t("auth.oauth2.device.codeLabel")}</p>
      <div class="device-code-value" aria-label="${t("auth.oauth2.device.codeLabel")}">${escapeHtml(userCode)}</div>
      ${expiresLine}
      <p class="device-code-status" aria-live="polite">${t("auth.oauth2.device.waiting")}</p>
    </div>
    <div class="popup-footer">
      <button class="btn popup-btn btn--secondary" data-action="cancel">${t("auth.oauth2.device.cancel")}</button>
    </div>
  `;

  const statusEl = dlg.querySelector(".device-code-status");

  let closed = false;
  const cancel = () => {
    if (closed) return;
    closed = true;
    PopupManager.close();
    onCancel?.();
  };

  dlg
    .querySelectorAll('[data-action="cancel"]')
    .forEach((b) => b.addEventListener("click", cancel));

  PopupManager.open({ element: dlg, onMaskClick: cancel });

  return {
    update({ status, error } = {}) {
      if (closed || !statusEl) return;
      if (error) {
        statusEl.textContent = error;
        statusEl.classList.add("device-code-status--error");
      } else if (status) {
        statusEl.textContent = status;
        statusEl.classList.remove("device-code-status--error");
      }
    },
    close() {
      if (closed) return;
      closed = true;
      PopupManager.close();
    },
  };
}
