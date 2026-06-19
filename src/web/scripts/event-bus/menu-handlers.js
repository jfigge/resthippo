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
 * menu-handlers.js — import / export / backup event-bus handlers.
 *
 * These are the payload-less (or single-field) menu/toolbar triggers that just
 * open a modal or delegate to an app-level command. They hold no shared state,
 * so they take only the command functions they invoke via the bus context
 * (`ctx`, built by buildBusContext() in app.js). See "Component ↔ App
 * Communication" in CLAUDE.md and the hippo:* registry at the top of app.js.
 *
 * @param {object} ctx
 * @param {() => any} ctx.handleImport        open the external-file import flow
 * @param {Function}  ctx.handleCurlImport    save a request parsed from pasted cURL
 * @param {(collection: object) => void} ctx.handleExport  open the collection export picker
 * @param {(format: string) => any} ctx.runWorkspaceExport export every collection in one file
 */
import { BackupModal } from "../components/backup-modal.js";
import { ExportModal } from "../components/export-modal.js";
import { CurlImportModal } from "../components/curl-import-modal.js";

export function installMenuHandlers(ctx) {
  // Import a collection from an external file (Postman / Insomnia / OpenAPI / HAR).
  // Triggered by the toolbar button in tree-view or the File > Import menu item.
  window.addEventListener("hippo:import-requested", () => ctx.handleImport());

  // Import a single request from a pasted cURL command. Triggered by the
  // File > "Import from cURL" menu item; opens a paste-box modal.
  window.addEventListener("hippo:import-curl-requested", () =>
    CurlImportModal.open(ctx.handleCurlImport),
  );

  // Whole-workspace backup create/restore. Triggered by the File menu items,
  // which signal the renderer so the theme-styled BackupModal can collect the
  // secret mode and any password before main does the file I/O and encryption.
  window.addEventListener("hippo:backup-export-requested", () =>
    BackupModal.openExport(),
  );
  window.addEventListener("hippo:backup-import-requested", () =>
    BackupModal.openImport(),
  );

  // Export a collection to an interchange file (Postman / Insomnia / OpenAPI /
  // HAR). Triggered by "Export…" in the collection context menu; opens the
  // format picker, which calls back into runCollectionExport.
  window.addEventListener("hippo:export-collection", (e) =>
    ctx.handleExport(e.detail.collection),
  );

  // Export every collection to one interchange file. Triggered by the
  // "Export All Collections…" File-menu item.
  window.addEventListener("hippo:export-all-requested", () =>
    ExportModal.openWorkspace((format) => ctx.runWorkspaceExport(format)),
  );
}
