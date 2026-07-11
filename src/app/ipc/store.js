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
 * ipc/store.js — storage IPC handlers (store:* + i18n:load).
 *
 * Extracted verbatim (behaviour-preserving) from main.js's initStoreIPC. Pure
 * delegation to the store modules behind the injected `getStores()` — manifest,
 * collections, nav tree, request CRUD, execution history, environments and the
 * persistent cookie jar — plus the i18n catalog load (which reads manifest
 * settings + the OS locale). Authoritative writes use safeCallWrite (a failure
 * returns a discriminable { __hippoError } the renderer toasts); best-effort
 * reclamation / auto-captured telemetry stays on the quiet safeCall path.
 */
"use strict";

const { loadCatalog } = require("../i18n");

/**
 * @param {object} deps
 * @param {Electron.IpcMain} deps.ipcMain
 * @param {Electron.App} deps.app
 * @param {() => object} deps.getStores
 * @param {(channel: string, fn: Function, fallback?: any) => any} deps.safeCall
 * @param {(channel: string, fn: Function) => any} deps.safeCallWrite
 */
function registerStoreIPC({
  ipcMain,
  app,
  getStores,
  safeCall,
  safeCallWrite,
}) {
  // ── Manifest (global collections list + settings) ───────────────────────────

  ipcMain.handle("store:manifest:get", () =>
    safeCall(
      "store:manifest:get",
      () => getStores().collectionStore().getManifest(),
      { version: 2, collections: [], activeCollectionId: null, settings: {} },
    ),
  );

  ipcMain.handle("store:manifest:save", (_event, data) =>
    safeCallWrite("store:manifest:save", () => {
      getStores().collectionStore().saveManifest(data);
    }),
  );

  // ── i18n catalog ────────────────────────────────────────────────────────────
  // Resolve the active locale (persisted preference → OS locale → English) and
  // return its bundled catalog plus the English fallback. The renderer awaits
  // this once at startup, before any component renders. Lives here because it
  // reads both the manifest settings and the on-disk catalogs — main-process
  // concerns the sandboxed renderer cannot reach.
  ipcMain.handle("i18n:load", () =>
    safeCall(
      "i18n:load",
      () => {
        const manifest = getStores().collectionStore().getManifest();
        return loadCatalog({
          requested: manifest?.settings?.locale,
          systemLocale: app.getLocale(),
        });
      },
      loadCatalog({ requested: "system", systemLocale: "en" }),
    ),
  );

  // Remove a collection's backing directory (requests, history, responses,
  // cookies, metadata). The renderer updates the manifest separately. This is
  // best-effort reclamation AFTER the authoritative manifest save, so it uses the
  // quiet safeCall path (a failed cleanup is not user-actionable data loss).
  ipcMain.handle("store:collections:delete", (_event, id) =>
    safeCall("store:collections:delete", () => {
      getStores().collectionStore().deleteCollection(id);
    }),
  );

  // ── Collection blob (assembles / decomposes per-file layout) ────────────────
  // Used by data-store.js to keep the same high-level collections API.

  ipcMain.handle("store:collections:get", (_event, id) =>
    safeCall(
      "store:collections:get",
      () => getStores().collectionsStore().getCollections(id),
      { version: 1, collections: [] },
    ),
  );

  ipcMain.handle("store:collections:save", (_event, id, data) =>
    safeCallWrite("store:collections:save", () => {
      getStores().collectionsStore().saveCollections(id, data);
    }),
  );

  // Granular tree-only save — persists folder structure + folder variables +
  // profile overrides without touching request files (a folder-variable change).
  ipcMain.handle("store:collections:save-tree", (_event, id, data) =>
    safeCallWrite("store:collections:save-tree", () => {
      getStores().collectionsStore().saveTreeStructure(id, data);
    }),
  );

  // ── Collection navigation tree ──────────────────────────────────────────────

  ipcMain.handle("store:tree:get", (_event, collectionId) =>
    safeCall(
      "store:tree:get",
      () => getStores().treeStore().getTree(collectionId),
      { children: [] },
    ),
  );

  // Authoritative write (nav tree is source of truth for folder structure).
  ipcMain.handle("store:tree:save", (_event, collectionId, tree) =>
    safeCallWrite("store:tree:save", () => {
      getStores().treeStore().saveTree(collectionId, tree);
    }),
  );

  // ── Granular request CRUD ───────────────────────────────────────────────────

  ipcMain.handle("store:requests:get", (_event, id) =>
    safeCall("store:requests:get", () =>
      getStores().requestStore().getRequest(id),
    ),
  );

  // Authoritative granular write: store:requests:update patches a single request
  // in place (used by the renderer's updateRequest for granular edits). New
  // requests have no dedicated channel — they land via the per-collection blob
  // written by store:collections:save.
  ipcMain.handle("store:requests:update", (_event, id, patch) =>
    safeCallWrite("store:requests:update", () =>
      getStores().requestStore().updateRequest(id, patch),
    ),
  );

  // Best-effort reclamation of a request's backing file AFTER the tree (source of
  // truth) was already saved loudly via store:collections:save. Quiet path: an unlink
  // failure (incl. ENOENT for an already-removed file) is not data loss.
  ipcMain.handle("store:requests:delete", (_event, id) =>
    safeCall("store:requests:delete", () => {
      getStores().requestStore().deleteRequest(id);
    }),
  );

  // ── Request execution history ───────────────────────────────────────────────
  // History is auto-captured telemetry recorded on every send/purge. The mutating
  // handlers below (add / delete / clear / trim) stay on the quiet safeCall path:
  // a lost or unpruned entry is not the user-authored data loss that safeCallWrite
  // exists to surface, and toasting per-entry would nag on a loop. Failures log.

  ipcMain.handle("store:history:list", (_event, requestId, options) =>
    safeCall(
      "store:history:list",
      () =>
        getStores()
          .historyStore()
          .listHistory(requestId, options ?? {}),
      { items: [], nextCursor: "" },
    ),
  );

  ipcMain.handle("store:history:add", (_event, requestId, entry, response) =>
    safeCall("store:history:add", () =>
      getStores().historyStore().addHistory(requestId, entry, response),
    ),
  );

  ipcMain.handle("store:history:response:get", (_event, requestId, historyId) =>
    safeCall("store:history:response:get", () =>
      getStores().historyStore().getHistoryResponse(requestId, historyId),
    ),
  );

  ipcMain.handle("store:history:delete", (_event, requestId, historyId) =>
    safeCall("store:history:delete", () =>
      getStores().historyStore().deleteHistory(requestId, historyId),
    ),
  );

  ipcMain.handle("store:history:clear", (_event, requestId) =>
    safeCall("store:history:clear", () =>
      getStores().historyStore().clearHistory(requestId),
    ),
  );

  ipcMain.handle("store:history:trim", (_event, maxEntries) =>
    safeCall("store:history:trim", () =>
      getStores().historyStore().trimAllHistory(maxEntries),
    ),
  );

  // ── Global + named environment variables (per collection) ────────────────────

  ipcMain.handle("store:environments:get", (_event, collectionId) =>
    safeCall(
      "store:environments:get",
      () => getStores().environmentStore().getEnvironments(collectionId),
      {
        version: 1,
        globalVariables: [],
        activeEnvironmentId: null,
        environments: [],
      },
    ),
  );

  // Authoritative write (user-authored global + named environment variables).
  ipcMain.handle("store:environments:save", (_event, collectionId, data) =>
    safeCallWrite("store:environments:save", () => {
      getStores().environmentStore().saveEnvironments(collectionId, data);
    }),
  );

  // ── Persistent cookie jar (per collection) ───────────────────────────────────
  // Capture/attachment happens automatically inside http:execute; these handlers
  // back the cookie-manager UI (view / edit / delete / clear).

  ipcMain.handle("store:cookies:list", (_event, collectionId) =>
    safeCall(
      "store:cookies:list",
      () => getStores().cookieStore().listCookies(collectionId),
      [],
    ),
  );

  // Authoritative writes (user edits to the persistent cookie jar via the manager).
  ipcMain.handle("store:cookies:upsert", (_event, collectionId, cookie) =>
    safeCallWrite("store:cookies:upsert", () => {
      getStores().cookieStore().upsertCookie(collectionId, cookie);
    }),
  );

  ipcMain.handle("store:cookies:delete", (_event, collectionId, ident) =>
    safeCallWrite("store:cookies:delete", () => {
      getStores().cookieStore().deleteCookie(collectionId, ident);
    }),
  );

  ipcMain.handle("store:cookies:clear", (_event, collectionId) =>
    safeCallWrite("store:cookies:clear", () => {
      getStores().cookieStore().clearJar(collectionId);
    }),
  );
}

module.exports = { registerStoreIPC };
