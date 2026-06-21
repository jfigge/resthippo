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
