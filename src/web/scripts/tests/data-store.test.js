/**
 * tests/data-store.test.js
 *
 * Integration tests for the renderer's IPC persistence bridge (data-store.js).
 *
 * Every persistence call the renderer makes routes through this module to the
 * Electron main process via `window.wurl.store.*` (exposed by preload.js). An
 * untested bridge means an IPC channel rename or argument-shape drift between
 * preload.js and data-store.js would silently break saves with no signal. These
 * tests drive the bridge against a recording mock of `window.wurl` (mirroring the
 * `window.wurl` mock pattern in auth/tests/oauth.test.js) and assert, for each
 * public method:
 *   • it targets the correct `window.wurl.store.*` channel,
 *   • it forwards the right arguments / payload shape,
 *   • it surfaces the value the channel returns, and
 *   • it handles a thrown IPC error gracefully (warn + documented fallback)
 *     rather than letting it escape to the caller.
 *
 * No Electron process is spawned and no real network is touched — the mock is the
 * entire transport. Pure-logic coverage (payload building, variable resolution)
 * lives in components/tests and is intentionally not duplicated here.
 *
 * Run with:   node --test tests/data-store.test.js
 */

"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";

import * as store from "../data-store.js";

// ── Recording mock for window.wurl.store ──────────────────────────────────────
// Each leaf channel records { path, args } on every call, returns a value
// pre-seeded via setReturn(path, …), or throws an error seeded via
// setThrow(path, err). isElectron() in data-store.js keys off the presence of
// store.manifest.get being a function, so the mock satisfies that probe.

function makeWurlMock() {
  const calls = [];
  const returns = {};
  const throws = {};

  const channel =
    (path) =>
    async (...args) => {
      calls.push({ path, args });
      if (throws[path]) throw throws[path];
      return returns[path];
    };

  const wurl = {
    isElectron: true,
    store: {
      manifest: {
        get: channel("manifest.get"),
        save: channel("manifest.save"),
      },
      env: { get: channel("env.get"), save: channel("env.save") },
      requests: { delete: channel("requests.delete") },
      history: {
        list: channel("history.list"),
        add: channel("history.add"),
        getResponse: channel("history.getResponse"),
        delete: channel("history.delete"),
        clear: channel("history.clear"),
        trim: channel("history.trim"),
      },
      environments: {
        get: channel("environments.get"),
        save: channel("environments.save"),
      },
      cookies: {
        list: channel("cookies.list"),
        upsert: channel("cookies.upsert"),
        delete: channel("cookies.delete"),
        clear: channel("cookies.clear"),
      },
    },
  };

  return {
    calls,
    setReturn: (path, val) => (returns[path] = val),
    setThrow: (path, err) => (throws[path] = err),
    /** All recorded calls to a given channel path. */
    of: (path) => calls.filter((c) => c.path === path),
    /** The single recorded call to a path (asserts exactly one). */
    one: (path) => {
      const hits = calls.filter((c) => c.path === path);
      assert.equal(hits.length, 1, `expected exactly one call to ${path}`);
      return hits[0];
    },
    install: () => {
      globalThis.window = { wurl };
    },
  };
}

/**
 * Run `fn` with console.warn captured; returns { result, warnings }.
 * data-store.js logs a "[data-store] … failed" warning on every swallowed error,
 * so the error tests assert the warning fired rather than letting a silent
 * fallback masquerade as success.
 */
async function withCapturedWarn(fn) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const result = await fn();
    return { result, warnings };
  } finally {
    console.warn = original;
  }
}

/**
 * Run `fn` with a write-error sink installed (and console.error captured), then
 * restore both. Writes (save/delete) route failures to the sink registered via
 * setWriteErrorHandler and log them via console.error — unlike reads, they never
 * degrade silently. Loud-write tests use this to assert the sink fired rather
 * than letting a failure masquerade as success.
 *
 * @returns {Promise<{ result, errors: {label,message}[], logged: string[] }>}
 */
async function withWriteHandler(fn) {
  const errors = [];
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  store.setWriteErrorHandler((info) => errors.push(info));
  try {
    const result = await fn();
    return { result, errors, logged };
  } finally {
    console.error = originalError;
    store.setWriteErrorHandler(null);
  }
}

/** Establish a known active collection so save* methods have a target. */
async function loadActive(
  mock,
  { id = "coll-1", name = "A", variables = {} } = {},
) {
  mock.setReturn("manifest.get", {
    version: 2,
    collections: [{ id, name }],
    activeCollectionId: id,
    settings: {},
  });
  mock.setReturn("env.get", { version: 1, collections: [], variables });
  return store.loadAll();
}

// ── loadAll: manifest.get + env.get ───────────────────────────────────────────

test("loadAll: reads manifest then the active collection's env file", async () => {
  const mock = makeWurlMock();
  mock.install();
  mock.setReturn("manifest.get", {
    version: 2,
    collections: [{ id: "c1", name: "Main" }],
    activeCollectionId: "c1",
    settings: { theme: "dark" },
  });
  mock.setReturn("env.get", {
    version: 1,
    collections: [{ id: "r1", name: "req" }],
    variables: { base: "https://x" },
  });

  const result = await store.loadAll();

  mock.one("manifest.get");
  assert.deepEqual(mock.one("env.get").args, ["c1"]);

  assert.equal(result.activeCollectionId, "c1");
  assert.equal(result.collections[0].id, "c1");
  // sendCookies defaults on and is materialised onto each collection row.
  assert.equal(result.collections[0].sendCookies, true);
  // Stored settings override the canonical defaults; defaults fill the rest.
  assert.equal(result.settings.theme, "dark");
  assert.equal(result.settings.timeout, 30000);
  assert.deepEqual(result.items, [{ id: "r1", name: "req" }]);
  assert.deepEqual(result.variables, { base: "https://x" });
});

test("loadAll: seeds a default collection on an empty (first-run) manifest", async () => {
  const mock = makeWurlMock();
  mock.install();
  mock.setReturn("manifest.get", {
    version: 2,
    collections: [],
    activeCollectionId: null,
    settings: {},
  });
  mock.setReturn("env.get", { version: 1, collections: [], variables: {} });

  const result = await store.loadAll();

  assert.equal(result.collections.length, 1);
  assert.equal(result.collections[0].name, "COLLECTIONS");
  assert.ok(result.collections[0].id, "seeded collection has an id");
  // env.get is called with the freshly-minted collection id.
  assert.equal(mock.one("env.get").args[0], result.activeCollectionId);
});

test("loadAll: a thrown manifest channel is absorbed into a valid default doc", async () => {
  const mock = makeWurlMock();
  mock.install();
  mock.setThrow("manifest.get", new Error("ipc disconnected"));

  const { result, warnings } = await withCapturedWarn(() => store.loadAll());

  // Resilience contract: startup never rejects — it degrades to a usable doc.
  assert.equal(result.collections.length, 1);
  assert.equal(result.collections[0].name, "COLLECTIONS");
  assert.ok(result.activeCollectionId);
  assert.ok(
    warnings.some((w) => w.includes("manifest load")),
    "a warning is logged for the failed manifest load",
  );
});

test("loadAll: a malformed (null) manifest hits the outer catch and returns defaults", async () => {
  const mock = makeWurlMock();
  mock.install();
  mock.setReturn("manifest.get", null); // raw.collections deref throws downstream

  const { result, warnings } = await withCapturedWarn(() => store.loadAll());

  assert.equal(result.collections.length, 1);
  assert.equal(result.collections[0].name, "COLLECTIONS");
  assert.deepEqual(result.items, []);
  assert.ok(warnings.some((w) => w.includes("load failed")));
});

// ── Collections: save paths ───────────────────────────────────────────────────

test("saveCollections: writes the active collection's items via env.save", async () => {
  const mock = makeWurlMock();
  mock.install();
  await loadActive(mock, { id: "coll-1", variables: { k: "v" } });

  const items = [{ id: "r9", name: "new" }];
  await store.saveCollections(items);

  const call = mock.one("env.save");
  assert.equal(call.args[0], "coll-1");
  assert.deepEqual(call.args[1], {
    version: 1,
    collections: items,
    // variables carried over from the loaded active collection, not discarded.
    variables: { k: "v" },
  });
});

test("saveSettings: persists settings into the manifest via manifest.save", async () => {
  const mock = makeWurlMock();
  mock.install();
  await store.saveSettings({ theme: "latte", fontSize: 15 });

  const call = mock.one("manifest.save");
  assert.deepEqual(call.args[0].settings, { theme: "latte", fontSize: 15 });
});

test("saveManifest: strips per-collection variables before persisting", async () => {
  const mock = makeWurlMock();
  mock.install();
  await store.saveManifest({
    collections: [{ id: "c1", name: "A", variables: { secret: "x" } }],
    activeCollectionId: "c1",
  });

  const saved = mock.one("manifest.save").args[0];
  assert.equal(saved.activeCollectionId, "c1");
  assert.deepEqual(saved.collections, [{ id: "c1", name: "A" }]);
  assert.ok(
    !("variables" in saved.collections[0]),
    "variables must not leak into the manifest",
  );
});

// ── Collections: read + targeted writes ───────────────────────────────────────

test("loadCollectionData: reads a specific collection via env.get and normalises", async () => {
  const mock = makeWurlMock();
  mock.install();
  mock.setReturn("env.get", {
    version: 1,
    collections: [{ id: "r1" }],
    variables: { a: "1" },
  });

  const data = await store.loadCollectionData("coll-42");

  assert.deepEqual(mock.one("env.get").args, ["coll-42"]);
  assert.deepEqual(data, { items: [{ id: "r1" }], variables: { a: "1" } });
});

test("saveCollectionData: forwards explicit variables in the env blob", async () => {
  const mock = makeWurlMock();
  mock.install();
  await store.saveCollectionData("coll-7", [{ id: "r1" }], { v: "1" });

  const call = mock.one("env.save");
  assert.equal(call.args[0], "coll-7");
  assert.deepEqual(call.args[1], {
    version: 1,
    collections: [{ id: "r1" }],
    variables: { v: "1" },
  });
});

test("saveCollectionVariables: for a non-active collection, reads-then-writes its env", async () => {
  const mock = makeWurlMock();
  mock.install();
  await loadActive(mock, { id: "active-coll" });

  mock.setReturn("env.get", {
    version: 1,
    collections: [{ id: "keep" }],
    variables: {},
  });
  await store.saveCollectionVariables("other-coll", { token: "abc" });

  // Round-trips through env.get (to preserve existing items) then env.save.
  assert.equal(
    mock.of("env.get").some((c) => c.args[0] === "other-coll"),
    true,
  );
  const save = mock.of("env.save").find((c) => c.args[0] === "other-coll");
  assert.ok(save, "env.save targeted the non-active collection");
  assert.deepEqual(save.args[1], {
    version: 1,
    collections: [{ id: "keep" }],
    variables: { token: "abc" },
  });
});

test("setActiveCollection: is a local state switch with no IPC traffic", async () => {
  const mock = makeWurlMock();
  mock.install();
  store.setActiveCollection("coll-local");
  assert.equal(mock.calls.length, 0);
});

// ── Requests ──────────────────────────────────────────────────────────────────

test("deleteRequest: routes to the requests.delete channel with the id", async () => {
  const mock = makeWurlMock();
  mock.install();
  await store.deleteRequest("req-123");
  assert.deepEqual(mock.one("requests.delete").args, ["req-123"]);
});

// ── History: full CRUD ────────────────────────────────────────────────────────

test("listHistory: forwards id + options and surfaces the returned page", async () => {
  const mock = makeWurlMock();
  mock.install();
  const page = { items: [{ id: "h1" }], nextCursor: "cur-2" };
  mock.setReturn("history.list", page);

  const result = await store.listHistory("req-1", {
    limit: 25,
    cursor: "cur-1",
  });

  assert.deepEqual(mock.one("history.list").args, [
    "req-1",
    { limit: 25, cursor: "cur-1" },
  ]);
  assert.deepEqual(result, page);
});

test("addHistory: forwards (requestId, entry, response) and returns the stored entry", async () => {
  const mock = makeWurlMock();
  mock.install();
  const stored = { id: "h7", status: 200 };
  mock.setReturn("history.add", stored);

  const entry = { status: 200, elapsed: 12, size: 34 };
  const response = { headers: {}, body: "ok" };
  const result = await store.addHistory("req-1", entry, response);

  assert.deepEqual(mock.one("history.add").args, ["req-1", entry, response]);
  assert.deepEqual(result, stored);
});

test("getHistoryResponse: forwards (requestId, historyId) and surfaces the payload", async () => {
  const mock = makeWurlMock();
  mock.install();
  mock.setReturn("history.getResponse", { headers: {}, body: "payload" });

  const result = await store.getHistoryResponse("req-1", "hist-9");

  assert.deepEqual(mock.one("history.getResponse").args, ["req-1", "hist-9"]);
  assert.equal(result.body, "payload");
});

test("deleteHistory: forwards (requestId, historyId)", async () => {
  const mock = makeWurlMock();
  mock.install();
  await store.deleteHistory("req-1", "hist-9");
  assert.deepEqual(mock.one("history.delete").args, ["req-1", "hist-9"]);
});

test("clearHistory: forwards the requestId", async () => {
  const mock = makeWurlMock();
  mock.install();
  await store.clearHistory("req-1");
  assert.deepEqual(mock.one("history.clear").args, ["req-1"]);
});

test("trimHistory: forwards the max-entries cap", async () => {
  const mock = makeWurlMock();
  mock.install();
  await store.trimHistory(5);
  assert.deepEqual(mock.one("history.trim").args, [5]);
});

// ── Error propagation / fallback contracts ────────────────────────────────────
// data-store wraps each channel in storeCall(), which on a thrown IPC error logs
// a warning and resolves to the method's documented fallback. These tests pin
// that contract per-method so a regression to "throw and crash the renderer" or
// "silently return undefined" is caught.

test("listHistory: a channel error degrades to the empty-page fallback (+warn)", async () => {
  const mock = makeWurlMock();
  mock.install();
  mock.setThrow("history.list", new Error("ipc boom"));

  const { result, warnings } = await withCapturedWarn(() =>
    store.listHistory("req-1"),
  );

  assert.deepEqual(result, { items: [], nextCursor: "" });
  assert.ok(warnings.some((w) => w.includes("listHistory")));
});

test("addHistory: a channel error degrades to null (+warn)", async () => {
  const mock = makeWurlMock();
  mock.install();
  mock.setThrow("history.add", new Error("disk full"));

  const { result, warnings } = await withCapturedWarn(() =>
    store.addHistory("req-1", { status: 500 }),
  );

  assert.equal(result, null);
  assert.ok(warnings.some((w) => w.includes("addHistory")));
});

test("getHistoryResponse: a channel error degrades to null (+warn)", async () => {
  const mock = makeWurlMock();
  mock.install();
  mock.setThrow("history.getResponse", new Error("nope"));

  const { result, warnings } = await withCapturedWarn(() =>
    store.getHistoryResponse("req-1", "hist-1"),
  );

  assert.equal(result, null);
  assert.ok(warnings.some((w) => w.includes("getHistoryResponse")));
});

// ── Write-failure surfacing (loud writes) ─────────────────────────────────────
// Writes never degrade silently: a failure is logged AND raised to the registered
// write-error sink so the renderer can show a toast. Failure is detected either by
// a thrown transport (IPC channel broken) or a `{ __wurlError }` envelope returned
// by the main process's safeCallWrite(). These tests pin both detection paths.

test("deleteRequest: a channel error degrades quietly (+warn), no toast", async () => {
  // deleteRequest is best-effort reclamation after the authoritative tree save,
  // and runs in a per-id loop on folder deletes, so it stays on the quiet path:
  // a failure (incl. an already-gone file) warns but must NOT raise a toast.
  const mock = makeWurlMock();
  mock.install();
  mock.setThrow("requests.delete", new Error("locked"));

  const errors = [];
  store.setWriteErrorHandler((info) => errors.push(info));
  try {
    const { warnings } = await withCapturedWarn(() =>
      store.deleteRequest("req-1"),
    );
    assert.ok(warnings.some((w) => w.includes("deleteRequest")));
    assert.equal(errors.length, 0, "a quiet delete never fires the toast sink");
  } finally {
    store.setWriteErrorHandler(null);
  }
});

test("saveCollections: a main-process error envelope is surfaced as a write error", async () => {
  const mock = makeWurlMock();
  mock.install();
  await loadActive(mock, { id: "coll-1" });
  // safeCallWrite() in main returns this discriminable envelope on a handler
  // throw — it must NOT be mistaken for a successful save.
  mock.setReturn("env.save", {
    __wurlError: true,
    channel: "store:env:save",
    message: "ENOSPC: no space left on device",
  });

  const { errors } = await withWriteHandler(() =>
    store.saveCollections([{ id: "r1" }]),
  );

  assert.equal(errors.length, 1, "the envelope is detected as a failure");
  assert.equal(errors[0].label, "Save collection");
  assert.match(errors[0].message, /ENOSPC/);
});

test("saveCollectionData: returns false and notifies when the channel throws", async () => {
  const mock = makeWurlMock();
  mock.install();
  await loadActive(mock, { id: "coll-1" });
  mock.setThrow("env.save", new Error("permission denied"));

  const { result, errors } = await withWriteHandler(() =>
    store.saveCollectionData("coll-1", [{ id: "r1" }], {}),
  );

  assert.equal(result, false);
  assert.equal(errors[0].label, "Save collection");
  assert.match(errors[0].message, /permission denied/);
});

test("saveSettings: a thrown manifest.save is surfaced as a write error", async () => {
  const mock = makeWurlMock();
  mock.install();
  mock.setThrow("manifest.save", new Error("disk full"));

  const { errors } = await withWriteHandler(() =>
    store.saveSettings({ theme: "x" }),
  );

  assert.equal(errors.length, 1);
  assert.equal(errors[0].label, "Save settings");
});

test("write failure with no registered sink still logs and does not reject", async () => {
  const mock = makeWurlMock();
  mock.install();
  store.setWriteErrorHandler(null); // explicitly unregistered
  mock.setThrow("manifest.save", new Error("nope"));

  const logged = [];
  const originalError = console.error;
  console.error = (...a) => logged.push(a.join(" "));
  try {
    // Must resolve, never reject, even with no sink to receive the failure.
    await store.saveSettings({ theme: "x" });
    assert.ok(
      logged.some((l) => l.includes("Save settings")),
      "the failure is logged even without a sink",
    );
  } finally {
    console.error = originalError;
  }
});

test("saveEnvironments: forwards the document and returns true on success", async () => {
  const mock = makeWurlMock();
  mock.install();
  const doc = { version: 1, globalVariables: { a: "1" }, environments: [] };

  const { result, errors } = await withWriteHandler(() =>
    store.saveEnvironments(doc),
  );

  assert.equal(result, true);
  assert.equal(
    errors.length,
    0,
    "a successful save never fires the toast sink",
  );
  assert.deepEqual(mock.one("environments.save").args, [doc]);
});

test("saveEnvironments: a main-process error envelope is surfaced", async () => {
  // store:environments:save is an authoritative write (safeCallWrite in main), so
  // a handler throw returns this envelope rather than a look-alike success.
  const mock = makeWurlMock();
  mock.install();
  mock.setReturn("environments.save", {
    __wurlError: true,
    channel: "store:environments:save",
    message: "EACCES: permission denied",
  });

  const { result, errors } = await withWriteHandler(() =>
    store.saveEnvironments({ version: 1, environments: [] }),
  );

  assert.equal(result, false, "the envelope is detected as a failure");
  assert.equal(errors[0].label, "Save environments");
  assert.match(errors[0].message, /EACCES/);
});

test("upsertCookie: a thrown channel returns false and is surfaced", async () => {
  const mock = makeWurlMock();
  mock.install();
  mock.setThrow("cookies.upsert", new Error("disk full"));

  const { result, errors } = await withWriteHandler(() =>
    store.upsertCookie("coll-1", { name: "sid", domain: "x", path: "/" }),
  );

  assert.equal(result, false);
  assert.equal(errors[0].label, "Save cookie");
  assert.match(errors[0].message, /disk full/);
});

test("clearCookies: a main-process error envelope is surfaced", async () => {
  const mock = makeWurlMock();
  mock.install();
  mock.setReturn("cookies.clear", {
    __wurlError: true,
    channel: "store:cookies:clear",
    message: "ENOSPC",
  });

  const { result, errors } = await withWriteHandler(() =>
    store.clearCookies("coll-1"),
  );

  assert.equal(result, false);
  assert.equal(errors[0].label, "Clear cookies");
});

// ── Transport detection ───────────────────────────────────────────────────────

test("transport detection: without window.wurl.store the bridge takes the fetch path", async () => {
  // No Electron surface present → isElectron() is false → storeCall routes to the
  // Go dev-server fetch path. We stub fetch to prove the IPC channel is NOT used.
  globalThis.window = { wurl: { isElectron: false } };
  const originalFetch = globalThis.fetch;
  let fetched = null;
  globalThis.fetch = async (url, opts) => {
    fetched = { url, opts };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  try {
    await store.deleteRequest("req-1");
    assert.ok(fetched, "fetch was used as the transport");
    assert.match(fetched.url, /\/api\/requests\/req-1$/);
    assert.equal(fetched.opts.method, "DELETE");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── Dev-server (fetch) transport ──────────────────────────────────────────────
// When the page is served by the Go dev server (no Electron preload), every
// method falls through storeCall()'s `httpFn` arm to fetch() against /api/*.
// These exercise that whole second transport — URL shape, HTTP verb, request
// body, and the 404/non-OK handling in getHistoryResponse — which the IPC tests
// above never touch.

/** A fetch Response stub carrying a JSON body. */
const jsonRes = (data, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  json: async () => data,
});

/** Recording fetch mock: matches routes by URL substring, records every call. */
function makeFetchMock() {
  const calls = [];
  const routes = [];
  const fetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method ?? "GET", opts });
    for (const r of routes) if (url.includes(r.substr)) return r.respond(url);
    return jsonRes({});
  };
  return {
    calls,
    fetch,
    route: (substr, respond) => routes.push({ substr, respond }),
    of: (substr) => calls.filter((c) => c.url.includes(substr)),
    one: (substr) => {
      const hits = calls.filter((c) => c.url.includes(substr));
      assert.equal(hits.length, 1, `expected one fetch matching ${substr}`);
      return hits[0];
    },
  };
}

/**
 * Run `fn` with the dev-server transport active: no `window.wurl` (so
 * isElectron() is false) and a recording fetch mock seeded from `routes`
 * (`[substr, respond]` pairs). Restores the prior globals afterwards.
 */
async function withDevServer(routes, fn) {
  const prevWindow = globalThis.window;
  const prevFetch = globalThis.fetch;
  const mock = makeFetchMock();
  for (const [substr, respond] of routes) mock.route(substr, respond);
  globalThis.window = {}; // window.wurl absent → isElectron() === false
  globalThis.fetch = mock.fetch;
  try {
    return await fn(mock);
  } finally {
    globalThis.window = prevWindow;
    globalThis.fetch = prevFetch;
  }
}

test("dev-server: loadAll GETs /api/collections then the active /api/env", async () => {
  await withDevServer(
    [
      [
        "/api/collections",
        () =>
          jsonRes({
            version: 2,
            collections: [{ id: "c1", name: "A" }],
            activeCollectionId: "c1",
            settings: { theme: "x" },
          }),
      ],
      [
        "/api/env",
        () =>
          jsonRes({
            version: 1,
            collections: [{ id: "r1" }],
            variables: { k: "v" },
          }),
      ],
    ],
    async (mock) => {
      const result = await store.loadAll();
      assert.equal(mock.one("/api/env?id=c1").method, "GET");
      assert.deepEqual(result.items, [{ id: "r1" }]);
      assert.equal(result.settings.theme, "x");
      assert.deepEqual(result.variables, { k: "v" });
    },
  );
});

test("dev-server: saveSettings PUTs the manifest JSON to /api/collections", async () => {
  await withDevServer([], async (mock) => {
    await store.saveSettings({ theme: "latte" });
    const call = mock.one("/api/collections");
    assert.equal(call.method, "PUT");
    assert.equal(JSON.parse(call.opts.body).settings.theme, "latte");
  });
});

test("dev-server: saveCollections PUTs the active items to /api/env", async () => {
  await withDevServer(
    [
      [
        "/api/collections",
        () =>
          jsonRes({
            version: 2,
            collections: [{ id: "c1", name: "A" }],
            activeCollectionId: "c1",
            settings: {},
          }),
      ],
      [
        "/api/env",
        () => jsonRes({ version: 1, collections: [], variables: {} }),
      ],
    ],
    async (mock) => {
      await store.loadAll();
      await store.saveCollections([{ id: "r9" }]);
      const put = mock.of("/api/env").find((c) => c.method === "PUT");
      assert.ok(put, "an env PUT was issued");
      assert.match(put.url, /\/api\/env\?id=c1/);
      assert.deepEqual(JSON.parse(put.opts.body).collections, [{ id: "r9" }]);
    },
  );
});

test("dev-server: listHistory GETs /history with limit + cursor query", async () => {
  await withDevServer(
    [["/history", () => jsonRes({ items: [{ id: "h1" }], nextCursor: "n2" })]],
    async (mock) => {
      const result = await store.listHistory("req-1", {
        limit: 10,
        cursor: "c0",
      });
      const call = mock.one("/history");
      assert.equal(call.method, "GET");
      assert.match(call.url, /\/api\/requests\/req-1\/history\?/);
      assert.match(call.url, /limit=10/);
      assert.match(call.url, /cursor=c0/);
      assert.deepEqual(result, { items: [{ id: "h1" }], nextCursor: "n2" });
    },
  );
});

test("dev-server: addHistory POSTs entry + response to /history", async () => {
  await withDevServer(
    [["/history", () => jsonRes({ id: "h7" })]],
    async (mock) => {
      const result = await store.addHistory(
        "req-1",
        { status: 200 },
        { body: "ok" },
      );
      const call = mock.one("/history");
      assert.equal(call.method, "POST");
      const body = JSON.parse(call.opts.body);
      assert.equal(body.status, 200);
      assert.deepEqual(body.response, { body: "ok" });
      assert.deepEqual(result, { id: "h7" });
    },
  );
});

test("dev-server: getHistoryResponse GETs the response payload", async () => {
  await withDevServer(
    [["/response", () => jsonRes({ body: "payload" })]],
    async (mock) => {
      const result = await store.getHistoryResponse("req-1", "h9");
      assert.match(
        mock.one("/response").url,
        /\/api\/requests\/req-1\/history\/h9\/response/,
      );
      assert.equal(result.body, "payload");
    },
  );
});

test("dev-server: getHistoryResponse returns null on a 404 (no entry)", async () => {
  await withDevServer(
    [["/response", () => jsonRes(null, { ok: false, status: 404 })]],
    async () => {
      assert.equal(await store.getHistoryResponse("req-1", "h9"), null);
    },
  );
});

test("dev-server: getHistoryResponse degrades to null (+warn) on a 500", async () => {
  await withDevServer(
    [["/response", () => jsonRes(null, { ok: false, status: 500 })]],
    async () => {
      const { result, warnings } = await withCapturedWarn(() =>
        store.getHistoryResponse("req-1", "h9"),
      );
      assert.equal(result, null);
      assert.ok(warnings.some((w) => w.includes("getHistoryResponse")));
    },
  );
});

test("dev-server: deleteHistory DELETEs the single history entry", async () => {
  await withDevServer([], async (mock) => {
    await store.deleteHistory("req-1", "h9");
    assert.equal(mock.one("/history/h9").method, "DELETE");
  });
});

test("dev-server: clearHistory DELETEs the whole history collection", async () => {
  await withDevServer([], async (mock) => {
    await store.clearHistory("req-1");
    const call = mock.one("/api/requests/req-1/history");
    assert.equal(call.method, "DELETE");
  });
});

test("dev-server: trimHistory is a no-op (a main-process-only concern)", async () => {
  await withDevServer([], async (mock) => {
    await store.trimHistory(5);
    assert.equal(mock.calls.length, 0, "no fetch is issued");
  });
});

// ── loadAll: migration + repair branches ──────────────────────────────────────

test("loadAll: migrates legacy environments / activeEnvironmentId keys", async () => {
  const mock = makeWurlMock();
  mock.install();
  mock.setReturn("manifest.get", {
    environments: [{ id: "e1", name: "Legacy" }],
    activeEnvironmentId: "e1",
  });
  mock.setReturn("env.get", { version: 1, collections: [], variables: {} });

  const result = await store.loadAll();

  assert.equal(result.activeCollectionId, "e1");
  assert.equal(result.collections[0].id, "e1");
  assert.equal(result.collections[0].name, "Legacy");
});

test("loadAll: repairs an activeCollectionId that references no collection", async () => {
  const mock = makeWurlMock();
  mock.install();
  mock.setReturn("manifest.get", {
    version: 2,
    collections: [
      { id: "c1", name: "A" },
      { id: "c2", name: "B" },
    ],
    activeCollectionId: "ghost",
    settings: {},
  });
  mock.setReturn("env.get", { version: 1, collections: [], variables: {} });

  const result = await store.loadAll();

  // Falls back to the first collection and loads its env.
  assert.equal(result.activeCollectionId, "c1");
  assert.ok(mock.of("env.get").some((c) => c.args[0] === "c1"));
});

// ── Variable-preservation branches in the targeted save paths ──────────────────

test("loadCollectionData: refreshes the active-collection cache on a matching id", async () => {
  const mock = makeWurlMock();
  mock.install();
  await loadActive(mock, { id: "coll-1", variables: { old: "1" } });

  // Re-read the active collection with new variables…
  mock.setReturn("env.get", {
    version: 1,
    collections: [{ id: "r1" }],
    variables: { fresh: "2" },
  });
  await store.loadCollectionData("coll-1");

  // …so a later saveCollections persists the refreshed variables, not the stale.
  await store.saveCollections([{ id: "r1" }]);
  const save = mock.of("env.save").pop();
  assert.deepEqual(save.args[1].variables, { fresh: "2" });
});

test("saveCollectionData: reuses the cached variables for the active collection", async () => {
  const mock = makeWurlMock();
  mock.install();
  await loadActive(mock, { id: "coll-1", variables: { cached: "1" } });

  await store.saveCollectionData("coll-1", [{ id: "r1" }]); // no variables arg
  const save = mock.of("env.save").pop();
  assert.deepEqual(save.args[1].variables, { cached: "1" });
  assert.deepEqual(save.args[1].collections, [{ id: "r1" }]);
});

test("saveCollectionData: preserves on-disk variables for a non-active collection", async () => {
  const mock = makeWurlMock();
  mock.install();
  await loadActive(mock, { id: "active" });

  mock.setReturn("env.get", {
    version: 1,
    collections: [],
    variables: { disk: "1" },
  });
  await store.saveCollectionData("other", [{ id: "r1" }]); // no variables arg
  const save = mock.of("env.save").find((c) => c.args[0] === "other");
  assert.deepEqual(save.args[1].variables, { disk: "1" });
});

test("saveCollectionVariables: writes through the cache for the active collection", async () => {
  const mock = makeWurlMock();
  mock.install();
  await loadActive(mock, { id: "coll-1" });

  await store.saveCollectionVariables("coll-1", { t: "x" });
  const save = mock.of("env.save").pop();
  assert.equal(save.args[0], "coll-1");
  assert.deepEqual(save.args[1].variables, { t: "x" });
});
