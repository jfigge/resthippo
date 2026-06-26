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
 * event-bus/folder-vars-handlers.js — folder variables + run-folder handlers.
 *
 * Extracted verbatim (behaviour-preserving) from app.js. Two app-wide listeners:
 * `hippo:folder-vars-open` opens the variables popup scoped to a tree folder
 * node, and `hippo:run-folder` runs every request in a folder. Both reach the app
 * only through the bus context (the popup + the run-folder command), so they
 * carry no module-level coupling of their own.
 *
 * Bus context used: `varsPopup`, `getSettings()`, `runFolder()`.
 */
"use strict";

export function installFolderVarsHandler(ctx) {
  window.addEventListener("hippo:folder-vars-open", (e) => {
    const { nodeId, folderName, variables } = e.detail;
    ctx.varsPopup.open({
      scopeId: nodeId,
      scopeName: folderName,
      variables: variables ?? [],
      bulkEditor: ctx.getSettings().varsBulkEditor ?? true,
    });
  });

  window.addEventListener("hippo:run-folder", (e) => {
    ctx.runFolder(e.detail?.folderId);
  });
}
