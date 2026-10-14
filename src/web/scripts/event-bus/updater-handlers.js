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
 * event-bus/updater-handlers.js — auto-update toast handlers (Feature 36).
 *
 * Extracted verbatim (behaviour-preserving) from app.js. These translate the
 * main→renderer hippo:updater-* broadcasts into discrete toasts (no live
 * percentage): an info toast when an update is found and downloading, a success
 * toast with a "Restart" action when it's ready, and — only for an explicit user
 * check — an "up to date" or error toast. A silent startup check never nags; the
 * Settings → About panel owns the inline status line. Stateless: it touches no
 * app module-level state, so it needs no bus context.
 */
"use strict";

import { Notifications } from "../notifications.js";
import { t } from "../i18n.js";

export function installUpdaterHandlers() {
  window.addEventListener("hippo:updater-available", (e) => {
    const version = e.detail?.version || "";
    Notifications.info(t("updater.downloadingMsg", { version }), {
      title: t("updater.available"),
    });
  });
  window.addEventListener("hippo:updater-downloaded", (e) => {
    const version = e.detail?.version || "";
    Notifications.success(t("updater.readyMsg", { version }), {
      title: t("updater.ready"),
      actionLabel: t("updater.restart"),
      onAction: () => window.hippo?.updater?.install?.(),
    });
  });
  window.addEventListener("hippo:updater-not-available", (e) => {
    // Dev/unpacked builds report their own status in Settings; don't toast.
    if (e.detail?.manual && e.detail?.reason !== "dev-build")
      Notifications.success(t("updater.upToDate"));
  });
  window.addEventListener("hippo:updater-error", (e) => {
    if (e.detail?.manual)
      Notifications.error(t("updater.failedMsg"), {
        title: t("updater.failed"),
      });
  });
}
