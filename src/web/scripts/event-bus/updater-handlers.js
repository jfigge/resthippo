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
