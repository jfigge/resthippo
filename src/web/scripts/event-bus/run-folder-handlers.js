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
