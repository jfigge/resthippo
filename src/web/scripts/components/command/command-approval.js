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
 * components/command/command-approval.js — the "run this command?" dialog
 * (Feature 70). Shown before a command template runs for the first time or
 * after it changed, so an imported collection can never run a program silently.
 */

"use strict";

import { PopupManager } from "../../popup-manager.js";
import { t } from "../../i18n.js";

/**
 * Ask the user to approve a command. Lists the unresolved command line plus the
 * Environment variable NAMES (values may be secrets) and whether stdin is set.
 * @param {{ name?: string, commandLine: string, env: {key:string}[],
 *   template?: { commandStdin?: string } }} desc
 * @returns {Promise<boolean>}
 */
export function confirmCommandRun(desc) {
  const lines = [desc.commandLine];
  const keys = (desc.env ?? []).map((r) => r.key).filter(Boolean);
  if (keys.length)
    lines.push("", t("command.approve.envLine", { keys: keys.join(", ") }));
  if (desc.template?.commandStdin) lines.push(t("command.approve.stdinLine"));
  return new Promise((resolve) => {
    PopupManager.confirm({
      title: t("command.approve.title"),
      message: desc.name
        ? t("command.approve.messageNamed", { name: desc.name })
        : t("command.approve.message"),
      detail: lines.join("\n"),
      note: t("command.approve.note"),
      confirmLabel: t("command.approve.run"),
      confirmClass: "btn--primary",
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}
