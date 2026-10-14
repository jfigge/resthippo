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
 * menu-handlers.js — import / export / backup event-bus handlers.
 *
 * These are the payload-less (or single-field) menu/toolbar triggers that just
 * open a modal or delegate to an app-level command. They hold no shared state,
 * so they take only the command functions they invoke via the bus context
 * (`ctx`, built by buildBusContext() in app.js). See "Component ↔ App
 * Communication" in CLAUDE.md and the hippo:* registry at the top of app.js.
 *
 * @param {object} ctx
 * @param {(path: string) => Promise<boolean|{error: string}>} ctx.handleFilePathImport  read + import a typed local file path ({error} → shown inline)
 * @param {() => Promise<boolean>} ctx.handleImportBrowse  open the native picker + import the chosen file
 * @param {Function}  ctx.handleCurlImport    save a request parsed from pasted cURL
 * @param {Function}  ctx.handleUrlImport     fetch + import an interchange document from a URL
 * @param {(collection: object) => void} ctx.handleExport  open the collection export picker
 * @param {(format: string) => any} ctx.runWorkspaceExport export every collection in one file
 */
import { BackupModal } from "../components/backup-modal.js";
import { ExportModal } from "../components/export-modal.js";
import { CurlImportModal } from "../components/curl-import-modal.js";
import { UrlImportModal } from "../components/url-import-modal.js";

export function installMenuHandlers(ctx) {
  // Import a single request from a pasted cURL command. Triggered by the tree
  // toolbar's [+] secondary-click menu ("Import from cURL"); opens a paste-box
  // modal. (File-menu import/export items were removed — see main.js.)
  window.addEventListener("hippo:import-curl-requested", () =>
    CurlImportModal.open(ctx.handleCurlImport),
  );

  // Import a collection from a URL or a local file — one smart field routes on
  // what's typed (Postman / Insomnia / OpenAPI / Swagger / HAR — auto-detected).
  // Triggered by the Collections dialog's Import button; opens the URL-or-file
  // modal with a Browse… fallback.
  window.addEventListener("hippo:import-url-requested", () =>
    UrlImportModal.open({
      onImport: ctx.handleUrlImport,
      onImportFile: ctx.handleFilePathImport,
      onBrowse: ctx.handleImportBrowse,
    }),
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
  // Collections dialog's "Export All" button.
  window.addEventListener("hippo:export-all-requested", () =>
    ExportModal.openWorkspace((format) => ctx.runWorkspaceExport(format)),
  );
}
