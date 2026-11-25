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
 * response/stderr-pane.js — the response viewer's Stderr tab and exit-status
 * presentation for Command requests (Feature 70).
 *
 * A command's exit code is its status (0 = success), stdout is the Body, and
 * stderr gets this separate pane. Large stderr is spilled to disk in the main
 * process like any large body and redeemed via `http:body:get`.
 */

"use strict";

import { t } from "../../i18n.js";

/**
 * Status-bar presentation of a command result.
 * @param {number} status       exit code
 * @param {string} statusText   terminating signal ("SIGTERM"), or ""
 * @returns {{ code: string, text: string, cls: string }}
 */
export function commandStatus(status, statusText) {
  const ok = status === 0 && !statusText;
  return {
    code: t("response.exit.code", { code: status }),
    text: statusText
      ? t("response.exit.signal", { signal: statusText })
      : ok
        ? t("response.exit.success")
        : t("response.exit.failure"),
    cls: ok ? "res-status--success" : "res-status--client-error",
  };
}

/**
 * Fill the Stderr pane.
 * @param {HTMLElement} pane
 * @param {{ stderr?: string, stderrTruncated?: boolean, stderrRef?: string|null,
 *   stderrSize?: number }} r
 */
export function renderStderrPane(pane, r) {
  if (!pane) return;
  pane.replaceChildren();
  const text = String(r?.stderr ?? "");
  if (!text) {
    const empty = document.createElement("div");
    empty.className = "panel-placeholder res-stderr-empty";
    empty.textContent = t("response.stderr.empty");
    pane.appendChild(empty);
    return;
  }
  if (r.stderrTruncated) {
    const banner = document.createElement("div");
    banner.className = "res-truncation-banner res-stderr-truncated";
    const msg = document.createElement("span");
    msg.textContent = t("response.stderr.truncated", {
      size: r.stderrSize ?? 0,
    });
    banner.appendChild(msg);
    const get = globalThis.window?.hippo?.http?.body?.get;
    if (r.stderrRef && typeof get === "function") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn--secondary res-stderr-full-btn";
      btn.textContent = t("response.stderr.viewFull");
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          const full = await get(r.stderrRef);
          if (full?.body != null) {
            renderStderrPane(pane, { stderr: full.body });
            return;
          }
        } catch {
          // fall through — leave the preview
        }
        btn.disabled = false;
      });
      banner.appendChild(btn);
    }
    pane.appendChild(banner);
  }
  const pre = document.createElement("pre");
  pre.className = "res-console-pre res-stderr-pre";
  pre.textContent = text;
  pane.appendChild(pre);
}
