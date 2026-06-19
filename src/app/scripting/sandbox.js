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
 * scripting/sandbox.js — sandboxed JS runtime for pre-request & after-response
 * scripts (Feature 25).
 *
 * The sandbox is a PURE COMPUTE unit: it takes a snapshot of the request /
 * response / environment / variables, runs the user's script against a small
 * `hippo.*` API, and returns the resulting request mutation, variable writes and
 * console output. It owns no store, socket or filesystem handle — the renderer
 * persists variable writes through the existing capture write-back path, so the
 * security boundary is simply "this module can't reach anything dangerous."
 *
 * ── Security model ──────────────────────────────────────────────────────────
 * Scripts run in a fresh `vm` context with three deliberate hardenings:
 *   1. Only primitive strings cross into the context as inputs (`__phase`, the
 *      `__input` JSON); the `hippo` API is built by a trusted BOOTSTRAP script
 *      that runs *inside* the context, so the API surface handed to user code is
 *      context-native. NOTE — this does NOT make the host realm unreachable:
 *      Node makes the contextified global inherit (a proxy of) the HOST
 *      Object.prototype, so `Object.getPrototypeOf(globalThis).constructor`
 *      resolves to the host `Function` constructor. (Contextifying a
 *      null-prototype object, or `setPrototypeOf(global, null)` from the host,
 *      does NOT take — the vm global's prototype is managed by Node and cannot
 *      be removed this way; verified empirically.) Reaching that *reference* is
 *      harmless on its own — what stops the breakout is #2.
 *   2. `codeGeneration: { strings: false, wasm: false }` — `eval` and the
 *      `Function` constructor throw inside the context, so the reachable host
 *      Function constructor can never COMPILE code. This is the load-bearing
 *      barrier: `Function("return process")()` fails with EvalError. Treat this,
 *      not #1, as what actually contains a hostile script.
 *   3. A wall-clock `timeout` bounds the synchronous run so an infinite loop
 *      can't wedge the main process. Scripts are synchronous-only (no `await`);
 *      there is no network/timer in scope, so there is nothing to await.
 *
 *   Also: the protocol globals the bootstrap installs (`hippo`, `__out`,
 *   `__phase`) are defined non-writable, so a user script can't reassign them to
 *   corrupt or drop its own result.
 *
 * KNOWN LIMITATION — the `timeout` only interrupts SYNCHRONOUS execution. A
 * deliberately-detached async loop (`(async()=>{ while(true) await 0 })()`) keeps
 * running on the main event loop after the call returns and is NOT bounded.
 * `microtaskMode:"afterEvaluate"` would bound it but forcing the timeout to
 * interrupt a microtask corrupts Node's async_hooks (crash risk), so it is NOT
 * used. The real fix is the worker_threads isolate below; scripts are documented
 * synchronous-only and this only bites a script that intentionally goes async.
 *
 * Node's `vm` is not a hardened security boundary against a determined attacker
 * sharing the host process; for that, a `worker_threads` isolate is the planned
 * follow-up. For the v1 threat model — the user's own scripts (or those in a
 * shared collection) must not *casually or accidentally* reach fs/network/
 * `process`/`require` — the three measures above are sufficient and verified by
 * the sandbox-denial tests.
 *
 * Loadable under plain node (only `require("vm")`), so it is unit-tested
 * directly; main.js injects Electron's ipcMain via registerScripting().
 */
"use strict";

const vm = require("vm");

/** Filename tagged on the user's compiled script — used to locate error lines. */
const SCRIPT_FILENAME = "hippo-script.js";
/** Wall-clock cap (ms) for a single script run; an infinite loop trips this. */
const SCRIPT_TIMEOUT_MS = 1000;
/** Cap for the trusted bootstrap/epilogue stages (fast; guarded for safety). */
const STAGE_TIMEOUT_MS = 2000;

/** Scopes readable by hippo.variables.get. */
const ALL_SCOPES = ["global", "environment", "collection", "folder"];
/** Scopes writable by hippo.variables.set — `folder` is read-only in v1. */
const SET_SCOPES = ["global", "environment", "collection"];

// The `hippo` API is defined as source so it is compiled *inside* the sandbox
// context (see security model #1). It reads its inputs from the primitive
// globals `__phase` / `__input` and accumulates results onto `globalThis.__out`.
const BOOTSTRAP = `
"use strict";
(function () {
  var ctx = JSON.parse(__input);
  var out = { varWrites: [], logs: [] };
  var vars = ctx.variables || {};
  var SET_SCOPES = ${JSON.stringify(SET_SCOPES)};
  var ALL_SCOPES = ${JSON.stringify(ALL_SCOPES)};

  function fmt(args) {
    return Array.prototype.map
      .call(args, function (a) {
        if (typeof a === "string") return a;
        try {
          return JSON.stringify(a);
        } catch (e) {
          return String(a);
        }
      })
      .join(" ");
  }
  function log(level, args) {
    out.logs.push({ level: level, text: fmt(args) });
  }

  var hippo = {
    variables: Object.freeze({
      get: function (scope, name) {
        if (ALL_SCOPES.indexOf(scope) === -1)
          throw new Error("hippo.variables.get: unknown scope '" + scope + "'");
        var m = vars[scope];
        // hasOwnProperty so an unset name returns undefined instead of leaking
        // an inherited Object.prototype member (toString, constructor, …).
        return m && Object.prototype.hasOwnProperty.call(m, name)
          ? m[name]
          : undefined;
      },
      set: function (scope, name, value) {
        if (scope === "folder")
          throw new Error(
            "hippo.variables.set: the 'folder' scope is read-only",
          );
        if (SET_SCOPES.indexOf(scope) === -1)
          throw new Error("hippo.variables.set: unknown scope '" + scope + "'");
        // Reject prototype-polluting names so a write can't corrupt the scope
        // map or be persisted as a bogus "__proto__"/"constructor" variable.
        if (
          name === "__proto__" ||
          name === "constructor" ||
          name === "prototype"
        )
          throw new Error(
            "hippo.variables.set: reserved variable name '" + name + "'",
          );
        var v = value == null ? "" : String(value);
        if (!vars[scope]) vars[scope] = {};
        vars[scope][name] = v;
        out.varWrites.push({ scope: scope, name: name, value: v });
      },
    }),
    console: Object.freeze({
      log: function () {
        log("log", arguments);
      },
      info: function () {
        log("info", arguments);
      },
      warn: function () {
        log("warn", arguments);
      },
      error: function () {
        log("error", arguments);
      },
    }),
    environment: Object.freeze({
      name: ctx.environment ? ctx.environment.name : undefined,
      variables: Object.freeze(
        Object.assign({}, ctx.environment ? ctx.environment.variables : null),
      ),
    }),
  };

  var reqSrc = ctx.request || {};
  if (__phase === "pre") {
    // Mutable in a pre-request script — the user edits the outgoing request.
    hippo.request = {
      method: reqSrc.method,
      url: reqSrc.url,
      headers: Object.assign({}, reqSrc.headers),
      body: reqSrc.body,
    };
    Object.defineProperty(hippo, "response", {
      enumerable: true,
      get: function () {
        throw new Error(
          "hippo.response is not available in a pre-request script",
        );
      },
    });
  } else {
    // Read-only snapshot of what was sent, plus the response.
    hippo.request = Object.freeze({
      method: reqSrc.method,
      url: reqSrc.url,
      headers: Object.freeze(Object.assign({}, reqSrc.headers)),
      body: reqSrc.body,
    });
    var resSrc = ctx.response || {};
    hippo.response = Object.freeze({
      status: resSrc.status,
      headers: Object.freeze(Object.assign({}, resSrc.headers)),
      body: resSrc.body,
      json: function () {
        return JSON.parse(resSrc.body);
      },
    });
  }

  Object.freeze(hippo);
  // Lock the protocol globals so a user script can't reassign them to corrupt
  // its own result (the API still mutates \`out\`'s contents — only the bindings
  // are frozen). \`__result\` is written last by the epilogue, so it needs no lock.
  Object.defineProperty(globalThis, "hippo", { value: hippo, enumerable: true });
  Object.defineProperty(globalThis, "__out", { value: out });
  Object.defineProperty(globalThis, "__phase", { value: __phase });
})();
`;

const EPILOGUE = `
"use strict";
(function () {
  var out = globalThis.__out;
  if (__phase === "pre") {
    var r = (globalThis.hippo && globalThis.hippo.request) || {};
    var hdrs = {};
    var rawH = r.headers && typeof r.headers === "object" ? r.headers : {};
    for (var k in rawH) {
      if (Object.prototype.hasOwnProperty.call(rawH, k))
        hdrs[k] = rawH[k] == null ? "" : String(rawH[k]);
    }
    out.request = {
      method: r.method == null ? "" : String(r.method),
      url: r.url == null ? "" : String(r.url),
      headers: hdrs,
      body: r.body == null ? "" : String(r.body),
    };
  }
  globalThis.__result = JSON.stringify(out);
})();
`;

/**
 * Turn a thrown error into a serialisable `{ name, message, line?, col? }`.
 * Line/col are recovered from the stack frame (or caret line) that references
 * the compiled user script, so the renderer can place an inline squiggle.
 * @param {*} err
 * @returns {{ name: string, message: string, line?: number, col?: number }}
 */
function describeError(err) {
  const out = {
    name: (err && err.name) || "Error",
    message: (err && err.message) || String(err),
  };
  const stack = String((err && err.stack) || "");
  const escaped = SCRIPT_FILENAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const at = stack.match(new RegExp(escaped + ":(\\d+)(?::(\\d+))?"));
  if (at) {
    out.line = parseInt(at[1], 10);
    if (at[2]) out.col = parseInt(at[2], 10);
  }
  // Syntax errors print a caret line under the offending column.
  const caret = stack.split("\n").find((l) => /^\s*\^+\s*$/.test(l));
  if (caret) out.col = caret.indexOf("^") + 1;
  return out;
}

/**
 * Compile (but never run) a script to surface syntax errors for live validation.
 * @param {string} code
 * @returns {{ error: null | { name, message, line?, col? } }}
 */
function validateScript(code) {
  try {
    new vm.Script(String(code || ""), { filename: SCRIPT_FILENAME });
    return { error: null };
  } catch (err) {
    return { error: describeError(err) };
  }
}

/**
 * Run a pre-request or after-response script in the locked-down context.
 *
 * @param {object} opts
 * @param {"pre"|"post"} opts.phase
 * @param {string} opts.code                 the user's script source
 * @param {object} [opts.request]            { method, url, headers, body }
 * @param {object} [opts.response]           { status, headers, body } (post)
 * @param {object} [opts.environment]        { name, variables }
 * @param {object} [opts.variables]          { global, environment, collection, folder }
 * @returns {{ request: object|null, varWrites: Array, logs: Array,
 *            error: null | { name, message, line?, col? } }}
 *   On a script error, `request` and `varWrites` are dropped (fail closed — a
 *   half-run script must not mutate the request or persist variables); `logs`
 *   emitted before the throw are kept so the user can debug, and `error`
 *   carries the location.
 */
function runScript({ phase, code, request, response, environment, variables }) {
  const isPre = phase === "pre";
  const sandbox = {
    __phase: isPre ? "pre" : "post",
    __input: JSON.stringify({
      request: request || {},
      response: response || {},
      environment: environment || {},
      variables: variables || {},
    }),
  };
  vm.createContext(sandbox, {
    name: "hippo-script",
    codeGeneration: { strings: false, wasm: false },
  });

  try {
    vm.runInContext(BOOTSTRAP, sandbox, {
      filename: "hippo-bootstrap.js",
      timeout: STAGE_TIMEOUT_MS,
    });
    vm.runInContext(String(code || ""), sandbox, {
      filename: SCRIPT_FILENAME,
      timeout: SCRIPT_TIMEOUT_MS,
      displayErrors: true,
    });
    vm.runInContext(EPILOGUE, sandbox, {
      filename: "hippo-epilogue.js",
      timeout: STAGE_TIMEOUT_MS,
    });
    const out = JSON.parse(sandbox.__result || "{}");
    return {
      request: isPre ? out.request || null : null,
      varWrites: Array.isArray(out.varWrites) ? out.varWrites : [],
      logs: Array.isArray(out.logs) ? out.logs : [],
      error: null,
    };
  } catch (err) {
    // Recover any console output emitted before the throw (best effort). The
    // partial is a context-realm object, so round-trip it through JSON to
    // re-home it in the host realm (else its prototype is a foreign Object).
    let logs = [];
    try {
      const partial = sandbox.__out;
      if (partial && Array.isArray(partial.logs))
        logs = JSON.parse(JSON.stringify(partial.logs));
    } catch {
      /* context unreadable — leave logs empty */
    }
    return { request: null, varWrites: [], logs, error: describeError(err) };
  }
}

/**
 * Register the scripting IPC surface. Mirrors the result-or-error envelope
 * convention (a structured `error` field rather than a thrown reject); see the
 * error-conventions comment in main.js.
 *
 * @param {object} deps
 * @param {object} deps.ipcMain    Electron ipcMain (handle)
 * @param {Function} deps.safeCall logging-guarded call wrapper from main.js
 */
function registerScripting({ ipcMain, safeCall }) {
  const failClosed = (isPre) => ({
    request: isPre ? null : undefined,
    varWrites: [],
    logs: [],
    error: { name: "InternalError", message: "script execution failed" },
  });

  ipcMain.handle("script:run-pre", (_event, payload = {}) =>
    safeCall(
      "script:run-pre",
      () => runScript({ ...payload, phase: "pre" }),
      failClosed(true),
    ),
  );

  ipcMain.handle("script:run-post", (_event, payload = {}) =>
    safeCall(
      "script:run-post",
      () => runScript({ ...payload, phase: "post" }),
      failClosed(false),
    ),
  );

  ipcMain.handle("script:validate", (_event, code) =>
    safeCall("script:validate", () => validateScript(code), { error: null }),
  );
}

module.exports = {
  runScript,
  validateScript,
  registerScripting,
  // exported for tests
  SCRIPT_TIMEOUT_MS,
  ALL_SCOPES,
  SET_SCOPES,
};
