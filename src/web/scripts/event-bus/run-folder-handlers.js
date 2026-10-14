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
 * event-bus/run-folder-handlers.js — run-folder handler.
 *
 * One app-wide listener: `hippo:run-folder` runs every request in a folder and
 * tallies the results. It reaches the app only through the bus context (the
 * run-folder command), so it carries no module-level coupling of its own.
 *
 * (Folder/collection variables are no longer edited via a popup — selecting a
 * container in the tree shows its variable editor inline in the request panel;
 * see installContainerSelectionHandler in app.js.)
 *
 * Bus context used: `runFolder()`.
 */
"use strict";

export function installRunFolderHandler(ctx) {
  window.addEventListener("hippo:run-folder", (e) => {
    ctx.runFolder(e.detail?.folderId);
  });
}
