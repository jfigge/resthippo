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

// cli-command.js — shared toast reporting for the `hippo` CLI-launcher install /
// remove flow (window.hippo.cli.*). Both the Settings → Command Line panel and
// the first-run prompt in app.js funnel their result here so the wording stays
// identical. The platform mechanics live in src/app/cli-launcher.js.

"use strict";

import { t } from "./i18n.js";
import { Notifications } from "./notifications.js";

/** Directory portion of a shim path, for the "add it to PATH" hint. */
function parentDir(p) {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > 0 ? p.slice(0, i) : p;
}

/**
 * Surface the outcome of an install()/uninstall() call as a toast.
 * @param {{ ok: boolean, reason?: string, path?: string, onPath?: boolean }} result
 * @param {{ uninstall?: boolean }} [opts]
 */
export function reportCliResult(result, { uninstall = false } = {}) {
  if (!result || !result.ok) {
    if (result?.reason === "permission")
      Notifications.error(t("settings.cli.errorPermission"));
    else Notifications.error(t("settings.cli.errorGeneric"));
    return;
  }
  if (uninstall) {
    Notifications.success(t("settings.cli.removedToast"));
    return;
  }
  if (result.onPath === false && result.path) {
    Notifications.info(
      t("settings.cli.installedPathNote", { dir: parentDir(result.path) }),
    );
  } else {
    Notifications.success(t("settings.cli.installedToast"));
  }
}
