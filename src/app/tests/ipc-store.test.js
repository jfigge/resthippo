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
 * ipc-store.test.js — executable tests for the store IPC handlers
 * (ipc/store.js), driving each registered handler through a lightweight harness
 * that mocks ipcMain + getStores + safeCall/safeCallWrite. Focus: the
 * defense-in-depth boundary that rejects a renderer-supplied path-segment id
 * (traversal / bad chars) BEFORE it reaches the store, while valid ids still
 * flow through untouched. Complements ipc-parity.test.js, which proves the
 * channels exist but not that they behave.
 */
"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { registerStoreIPC } = require("../ipc/store");

// A traversal / injection id that must be rejected at the boundary.
const BAD_IDS = [
  "..",
  ".",
  "../../etc/passwd",
  "a/b",
  "a\\b",
  "a\u0000b",
  "a<b",
  "",
];
const GOOD_ID = "col-1234-abcd";

/**
 * Register the handlers against mocks and return helpers to invoke them and to
 * inspect which store methods were called. safeCall/safeCallWrite mirror the
 * real main.js envelopes closely enough to assert boundary behaviour.
 */
function harness() {
  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn) };

  const calls = []; // { name, args } for every store method actually invoked
  const rec =
    (name) =>
    (...args) => {
      calls.push({ name, args });
      return { ok: true, name };
    };
  const store = {
    collectionStore: () => ({
      getManifest: rec("getManifest"),
      saveManifest: rec("saveManifest"),
      deleteCollection: rec("deleteCollection"),
    }),
    collectionsStore: () => ({
      getCollections: rec("getCollections"),
      saveCollections: rec("saveCollections"),
      saveTreeStructure: rec("saveTreeStructure"),
    }),
    treeStore: () => ({ getTree: rec("getTree"), saveTree: rec("saveTree") }),
    requestStore: () => ({
      getRequest: rec("getRequest"),
      updateRequest: rec("updateRequest"),
      deleteRequest: rec("deleteRequest"),
    }),
    historyStore: () => ({
      listHistory: rec("listHistory"),
      addHistory: rec("addHistory"),
      getHistoryResponse: rec("getHistoryResponse"),
      deleteHistory: rec("deleteHistory"),
      clearHistory: rec("clearHistory"),
      trimAllHistory: rec("trimAllHistory"),
    }),
    environmentStore: () => ({
      getEnvironments: rec("getEnvironments"),
      saveEnvironments: rec("saveEnvironments"),
    }),
    cookieStore: () => ({
      listCookies: rec("listCookies"),
      upsertCookie: rec("upsertCookie"),
      deleteCookie: rec("deleteCookie"),
      clearJar: rec("clearJar"),
    }),
  };

  const safeCall = (_ch, fn, fallback) => {
    try {
      return fn();
    } catch {
      return fallback;
    }
  };
  const safeCallWrite = (channel, fn) => {
    try {
      return fn();
    } catch (err) {
      return {
        __hippoError: true,
        channel,
        message: err.message,
        code: err.code,
      };
    }
  };

  registerStoreIPC({
    ipcMain,
    app: { getLocale: () => "en" },
    getStores: () => store,
    safeCall,
    safeCallWrite,
  });

  const invoke = (ch, ...args) => handlers.get(ch)({}, ...args);
  const called = (name) => calls.some((c) => c.name === name);
  return { invoke, called, calls };
}

describe("store IPC — boundary id validation (read handlers)", () => {
  let h;
  beforeEach(() => (h = harness()));

  const readCases = [
    { ch: "store:collections:get", method: "getCollections" },
    { ch: "store:tree:get", method: "getTree" },
    { ch: "store:requests:get", method: "getRequest" },
    { ch: "store:history:list", method: "listHistory" },
    { ch: "store:history:clear", method: "clearHistory" },
    { ch: "store:environments:get", method: "getEnvironments" },
    { ch: "store:cookies:list", method: "listCookies" },
  ];

  for (const { ch, method } of readCases) {
    it(`${ch}: a bad id is rejected without reaching the store`, () => {
      for (const bad of BAD_IDS) {
        h = harness();
        h.invoke(ch, bad);
        assert.equal(
          h.called(method),
          false,
          `${method} must NOT run for id ${JSON.stringify(bad)}`,
        );
      }
    });

    it(`${ch}: a valid id flows through to the store`, () => {
      h.invoke(ch, GOOD_ID);
      assert.equal(h.called(method), true);
    });
  }
});

describe("store IPC — boundary id validation (write handlers)", () => {
  const writeCases = [
    { ch: "store:collections:save", method: "saveCollections" },
    { ch: "store:collections:save-tree", method: "saveTreeStructure" },
    { ch: "store:tree:save", method: "saveTree" },
    { ch: "store:requests:update", method: "updateRequest" },
    { ch: "store:environments:save", method: "saveEnvironments" },
    { ch: "store:cookies:upsert", method: "upsertCookie" },
    { ch: "store:cookies:clear", method: "clearJar" },
  ];

  for (const { ch, method } of writeCases) {
    it(`${ch}: a bad id returns an INVALID_ID error and never writes`, () => {
      const h = harness();
      const res = h.invoke(ch, "../../evil", { some: "payload" });
      assert.equal(h.called(method), false);
      assert.equal(res.__hippoError, true);
      assert.equal(res.code, "INVALID_ID");
    });

    it(`${ch}: a valid id writes through to the store`, () => {
      const h = harness();
      h.invoke(ch, GOOD_ID, { some: "payload" });
      assert.equal(h.called(method), true);
    });
  }
});

describe("store IPC — two-id history handlers validate both ids", () => {
  for (const ch of ["store:history:response:get", "store:history:delete"]) {
    const method =
      ch === "store:history:response:get"
        ? "getHistoryResponse"
        : "deleteHistory";

    it(`${ch}: a bad requestId is rejected`, () => {
      const h = harness();
      h.invoke(ch, "../evil", GOOD_ID);
      assert.equal(h.called(method), false);
    });

    it(`${ch}: a bad historyId is rejected`, () => {
      const h = harness();
      h.invoke(ch, GOOD_ID, "../evil");
      assert.equal(h.called(method), false);
    });

    it(`${ch}: both ids valid flows through`, () => {
      const h = harness();
      h.invoke(ch, GOOD_ID, "hist-1");
      assert.equal(h.called(method), true);
    });
  }
});

describe("store IPC — non-path args are NOT over-validated", () => {
  it("store:history:trim passes a numeric limit straight through", () => {
    const h = harness();
    h.invoke("store:history:trim", 50);
    assert.equal(h.called("trimAllHistory"), true);
  });

  it("store:cookies:delete validates collectionId but treats the cookie ident as data", () => {
    const h = harness();
    // ident carries characters forbidden in a filename id; it is NOT a path
    // segment (the jar is keyed by collectionId) so it must not be rejected.
    h.invoke("store:cookies:delete", GOOD_ID, "name=session; path=/; domain=x");
    assert.equal(h.called("deleteCookie"), true);
  });

  it("store:manifest:get needs no id and works", () => {
    const h = harness();
    h.invoke("store:manifest:get");
    assert.equal(h.called("getManifest"), true);
  });
});
