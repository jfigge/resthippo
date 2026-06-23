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
 * ASYNC-DoS containment — the in-vm `timeout` only interrupts SYNCHRONOUS
 * execution. A deliberately-detached async loop (`(async()=>{ while(true) await
 * 0 })()`) keeps running after the call returns and is NOT bounded by it
 * (`microtaskMode:"afterEvaluate"` would, but interrupting a microtask corrupts
 * Node's async_hooks — crash risk — so it is NOT used). The fix is
 * `runScriptIsolated()` below: it runs the very same `runScript()` inside a
 * `worker_threads` isolate and terminates the worker after every run, so a
 * runaway async loop wedges only that throwaway thread, never the main process.
 * The IPC handlers use the isolate; `runScript()` remains the in-process
 * primitive (used by the worker and by unit tests).
 *
 * Node's `vm` is not a hardened security boundary against a determined attacker
 * sharing the host process; the worker isolate raises that bar but the v1 threat
 * model is unchanged — the user's own scripts (or those in a shared collection)
 * must not *casually or accidentally* reach fs/network/`process`/`require`, which
 * the three measures above enforce and the sandbox-denial tests verify.
 *
 * Loadable under plain node (`vm` + `worker_threads` core modules), so it is
 * unit-tested directly; main.js injects Electron's ipcMain via registerScripting().
 */
"use strict";

const vm = require("vm");
const path = require("path");
const { Worker } = require("worker_threads");

/** Filename tagged on the user's compiled script — used to locate error lines. */
const SCRIPT_FILENAME = "hippo-script.js";
/** Wall-clock cap (ms) for a single script run; an infinite loop trips this. */
const SCRIPT_TIMEOUT_MS = 1000;
/** Cap for the trusted bootstrap/epilogue stages (fast; guarded for safety). */
const STAGE_TIMEOUT_MS = 2000;
/**
 * Absolute wall-clock backstop (ms) for an *isolated* run, covering work the
 * in-vm timeout can't interrupt (a detached async loop). Comfortably above
 * SCRIPT_TIMEOUT_MS so a normal slow-but-finishing script trips the in-vm
 * timeout first and only genuinely runaway async work reaches this backstop.
 */
const HARD_TIMEOUT_MS = SCRIPT_TIMEOUT_MS + 1500;
/** Resolved path to the worker entry that runs runScript() off the main thread. */
const WORKER_PATH = path.join(__dirname, "sandbox-worker.js");

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
  var out = { varWrites: [], logs: [], tests: [] };
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

  // ── Assertion engine (Feature 29) ─────────────────────────────────────────
  // A single matcher engine backs BOTH the scripted hippo.expect(...) helper and
  // the no-code assertions grid, so there is one set of comparison semantics and
  // one execution path. applyMatcher throws a descriptive Error on failure, which
  // hippo.test() (and the grid loop) catches to record a pass/fail result.
  function jstr(v) {
    if (typeof v === "string") return v;
    try {
      return JSON.stringify(v);
    } catch (e) {
      return String(v);
    }
  }
  function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (a && b && typeof a === "object") {
      if (Array.isArray(a) !== Array.isArray(b)) return false;
      var ka = Object.keys(a);
      var kb = Object.keys(b);
      if (ka.length !== kb.length) return false;
      for (var i = 0; i < ka.length; i++) {
        if (!Object.prototype.hasOwnProperty.call(b, ka[i])) return false;
        if (!deepEqual(a[ka[i]], b[ka[i]])) return false;
      }
      return true;
    }
    return false;
  }
  function testMatcher(actual, matcher, expected) {
    switch (matcher) {
      case "eq":
        return actual === expected;
      case "deepEq":
        return deepEqual(actual, expected);
      case "contains":
        if (actual == null) return false;
        if (Array.isArray(actual)) return actual.indexOf(expected) !== -1;
        return String(actual).indexOf(String(expected)) !== -1;
      case "exists":
        return actual !== undefined && actual !== null;
      case "lt":
        return Number(actual) < Number(expected);
      case "gt":
        return Number(actual) > Number(expected);
      case "matches":
        return new RegExp(expected).test(String(actual));
      case "truthy":
        return !!actual;
      case "falsy":
        return !actual;
      default:
        throw new Error("unknown matcher '" + matcher + "'");
    }
  }
  function matcherMessage(actual, matcher, expected, negate) {
    var n = negate ? " not" : "";
    switch (matcher) {
      case "eq":
        return "expected " + jstr(actual) + " to" + n + " equal " + jstr(expected);
      case "deepEq":
        return (
          "expected " + jstr(actual) + " to" + n + " deeply equal " + jstr(expected)
        );
      case "contains":
        return "expected " + jstr(actual) + " to" + n + " contain " + jstr(expected);
      case "exists":
        return "expected value to" + n + " exist";
      case "lt":
        return (
          "expected " + jstr(actual) + " to" + n + " be less than " + jstr(expected)
        );
      case "gt":
        return (
          "expected " +
          jstr(actual) +
          " to" +
          n +
          " be greater than " +
          jstr(expected)
        );
      case "matches":
        return "expected " + jstr(actual) + " to" + n + " match " + jstr(expected);
      case "truthy":
        return "expected " + jstr(actual) + " to" + n + " be truthy";
      case "falsy":
        return "expected " + jstr(actual) + " to" + n + " be falsy";
      default:
        return "assertion failed";
    }
  }
  function applyMatcher(actual, matcher, expected, negate) {
    var ok = testMatcher(actual, matcher, expected);
    if (negate) ok = !ok;
    if (!ok) throw new Error(matcherMessage(actual, matcher, expected, negate));
  }
  // Map a grid matcher token to the (engine key, negate) it compiles to.
  function gridMatcher(m) {
    switch (m) {
      case "equals":
        return { key: "eq", negate: false };
      case "notEquals":
        return { key: "eq", negate: true };
      case "contains":
        return { key: "contains", negate: false };
      case "notContains":
        return { key: "contains", negate: true };
      case "exists":
        return { key: "exists", negate: false };
      case "notExists":
        return { key: "exists", negate: true };
      case "lessThan":
        return { key: "lt", negate: false };
      case "greaterThan":
        return { key: "gt", negate: false };
      case "matches":
        return { key: "matches", negate: false };
      default:
        throw new Error("unknown matcher '" + m + "'");
    }
  }
  // Minimal JSON-path resolver ($.a.b[0].c / a.b[0] / ['k']) — the renderer's jq
  // engine lives in the sandboxed renderer and can't be required here.
  function resolvePath(root, path) {
    var p = String(path == null ? "" : path).trim();
    if (p.charAt(0) === "$") p = p.slice(1);
    if (p && p.charAt(0) !== "." && p.charAt(0) !== "[") p = "." + p;
    var re = /\\.([^.\\[\\]]+)|\\[(\\d+)\\]|\\['([^']*)'\\]|\\["([^"]*)"\\]/g;
    var cur = root;
    var m;
    while ((m = re.exec(p)) !== null) {
      if (cur == null) return undefined;
      var key =
        m[1] != null
          ? m[1]
          : m[2] != null
            ? Number(m[2])
            : m[3] != null
              ? m[3]
              : m[4];
      cur = cur[key];
    }
    return cur;
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
    // hippo.run(requestName) — execute another saved request (by name) and read
    // its response, so a pre- or after-response script can drive a dependency
    // (e.g. log in first) and use the result. The sandbox has no network, so the
    // request is actually fired by the RENDERER *before* this script runs: it
    // statically scans the script for hippo.run("…") calls, executes each named
    // request, and hands the results in as ctx.runResults — so the call resolves
    // synchronously here. The name must therefore be a string LITERAL the scanner
    // can see; a name it couldn't resolve, or that matches no request, throws.
    run: function (name) {
      var nm = name == null ? "" : String(name);
      var results = ctx.runResults || {};
      if (!Object.prototype.hasOwnProperty.call(results, nm)) {
        throw new Error(
          "hippo.run: no executed result for request '" +
            nm +
            "' — the request name must be a string literal naming an existing request",
        );
      }
      var r = results[nm] || {};
      var body = r.body == null ? "" : String(r.body);
      return Object.freeze({
        status: r.status,
        time: r.time,
        headers: Object.freeze(Object.assign({}, r.headers)),
        body: body,
        json: function () {
          return JSON.parse(body);
        },
      });
    },
    environment: Object.freeze({
      name: ctx.environment ? ctx.environment.name : undefined,
      variables: Object.freeze(
        Object.assign({}, ctx.environment ? ctx.environment.variables : null),
      ),
    }),
    // Feature 29 — scripted assertions. hippo.test(name, fn) records a pass/fail
    // result; hippo.expect(value).toX(...) throws on mismatch (caught by test()).
    test: function (name, fn) {
      var nm = name == null ? "" : String(name);
      if (typeof fn !== "function") {
        out.tests.push({
          name: nm,
          passed: false,
          message: "test body is not a function",
        });
        return;
      }
      try {
        fn();
        out.tests.push({ name: nm, passed: true, message: "" });
      } catch (e) {
        out.tests.push({
          name: nm,
          passed: false,
          message: (e && e.message) || String(e),
        });
      }
    },
    expect: function (value) {
      function build(negate) {
        return {
          toBe: function (x) {
            applyMatcher(value, "eq", x, negate);
          },
          toEqual: function (x) {
            applyMatcher(value, "deepEq", x, negate);
          },
          toContain: function (x) {
            applyMatcher(value, "contains", x, negate);
          },
          toBeLessThan: function (x) {
            applyMatcher(value, "lt", x, negate);
          },
          toBeGreaterThan: function (x) {
            applyMatcher(value, "gt", x, negate);
          },
          toMatch: function (x) {
            applyMatcher(value, "matches", x, negate);
          },
          toBeTruthy: function () {
            applyMatcher(value, "truthy", null, negate);
          },
          toBeFalsy: function () {
            applyMatcher(value, "falsy", null, negate);
          },
        };
      }
      var api = build(false);
      Object.defineProperty(api, "not", {
        enumerable: true,
        get: function () {
          return build(true);
        },
      });
      return api;
    },
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
      time: resSrc.time,
      headers: Object.freeze(Object.assign({}, resSrc.headers)),
      body: resSrc.body,
      json: function () {
        return JSON.parse(resSrc.body);
      },
    });
  }

  Object.freeze(hippo);

  // No-code assertions grid (Feature 29). Each enabled row resolves a value from
  // the response and runs it through the SAME matcher engine hippo.expect uses,
  // recording a pass/fail into out.tests. Post phase only — there is no response
  // to assert against in a pre-request script.
  if (__phase !== "pre" && Array.isArray(ctx.assertions)) {
    var resForGrid = ctx.response || {};
    var hdrLower = {};
    var rawHdr = resForGrid.headers || {};
    for (var hk in rawHdr) {
      if (Object.prototype.hasOwnProperty.call(rawHdr, hk))
        hdrLower[String(hk).toLowerCase()] = rawHdr[hk];
    }
    for (var ai = 0; ai < ctx.assertions.length; ai++) {
      var a = ctx.assertions[ai] || {};
      if (a.enabled === false) continue;
      var label =
        a.label == null || a.label === ""
          ? "assertion " + (ai + 1)
          : String(a.label);
      try {
        var actual;
        switch (a.source) {
          case "status":
            actual = resForGrid.status;
            break;
          case "responseTime":
            actual = resForGrid.time;
            break;
          case "header":
            actual = hdrLower[String(a.name || "").toLowerCase()];
            break;
          case "body":
            actual = resForGrid.body;
            break;
          case "json":
            var parsed;
            try {
              parsed = JSON.parse(resForGrid.body);
            } catch (pe) {
              throw new Error("response body is not valid JSON");
            }
            actual = resolvePath(parsed, a.name);
            break;
          default:
            throw new Error("unknown assertion source '" + a.source + "'");
        }
        var spec = gridMatcher(a.matcher);
        var expected = a.expected;
        var numericSource =
          a.source === "status" || a.source === "responseTime";
        if (spec.key === "lt" || spec.key === "gt") {
          expected = Number(expected);
        } else if (spec.key === "eq") {
          if (numericSource || typeof actual === "number") expected = Number(expected);
          else if (typeof actual === "boolean")
            expected = String(expected) === "true";
          else if (typeof actual === "string") expected = String(expected);
        }
        applyMatcher(actual, spec.key, expected, spec.negate);
        out.tests.push({ name: label, passed: true, message: "" });
      } catch (e) {
        out.tests.push({
          name: label,
          passed: false,
          message: (e && e.message) || String(e),
        });
      }
    }
  }

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
 * @param {object} [opts.runResults]         { [requestName]: { status, time, headers, body } }
 *   pre-executed responses for the requests the script names via hippo.run("…")
 * @returns {{ request: object|null, varWrites: Array, logs: Array,
 *            error: null | { name, message, line?, col? } }}
 *   On a script error, `request` and `varWrites` are dropped (fail closed — a
 *   half-run script must not mutate the request or persist variables); `logs`
 *   emitted before the throw are kept so the user can debug, and `error`
 *   carries the location.
 */
function runScript({
  phase,
  code,
  request,
  response,
  environment,
  variables,
  assertions,
  runResults,
}) {
  const isPre = phase === "pre";
  const sandbox = {
    __phase: isPre ? "pre" : "post",
    __input: JSON.stringify({
      request: request || {},
      response: response || {},
      environment: environment || {},
      variables: variables || {},
      assertions: Array.isArray(assertions) ? assertions : [],
      runResults:
        runResults && typeof runResults === "object" ? runResults : {},
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
      tests: Array.isArray(out.tests) ? out.tests : [],
      error: null,
    };
  } catch (err) {
    // Recover any console output / test results emitted before the throw (best
    // effort). The partial is a context-realm object, so round-trip it through
    // JSON to re-home it in the host realm (else its prototype is a foreign
    // Object). Keeping tests means a script that throws AFTER some assertions
    // still surfaces those results alongside the engine error.
    let logs = [];
    let tests = [];
    try {
      const partial = sandbox.__out;
      if (partial && Array.isArray(partial.logs))
        logs = JSON.parse(JSON.stringify(partial.logs));
      if (partial && Array.isArray(partial.tests))
        tests = JSON.parse(JSON.stringify(partial.tests));
    } catch {
      /* context unreadable — leave logs/tests empty */
    }
    return {
      request: null,
      varWrites: [],
      logs,
      tests,
      error: describeError(err),
    };
  }
}

/** Fail-closed result envelope (no request mutation, no var writes). */
function failClosedResult(phase, error) {
  return {
    request: phase === "pre" ? null : undefined,
    varWrites: [],
    logs: [],
    tests: [],
    error,
  };
}

/**
 * Run a script in a worker_threads isolate so a detached async loop — which the
 * in-vm wall-clock timeout in runScript() cannot interrupt — wedges only the
 * worker, not the main process. The worker is terminated after every run (so a
 * runaway microtask loop dies with it) and on a hard-timeout backstop.
 *
 * Always resolves (never rejects) with the same envelope as runScript(); on any
 * worker failure it fails closed. If a worker cannot be spawned at all it falls
 * back to an in-process runScript() so the feature degrades rather than breaks.
 *
 * @param {object} opts  same shape as runScript()
 * @param {object} [cfg]
 * @param {number} [cfg.hardTimeoutMs]  override the wall-clock backstop (tests)
 * @returns {Promise<object>} runScript-shaped result
 */
function runScriptIsolated(
  opts = {},
  { hardTimeoutMs = HARD_TIMEOUT_MS } = {},
) {
  return new Promise((resolve) => {
    let settled = false;
    let worker = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (worker) worker.terminate().catch(() => {});
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish(
        failClosedResult(opts.phase, {
          name: "TimeoutError",
          message: `script exceeded ${hardTimeoutMs}ms`,
        }),
      );
    }, hardTimeoutMs);

    try {
      worker = new Worker(WORKER_PATH);
    } catch {
      // Couldn't spawn an isolate — degrade to an in-process run (still bounds
      // synchronous loops via the in-vm timeout; only the async-DoS edge case is
      // unprotected) rather than failing the feature outright.
      finish(runScript(opts));
      return;
    }
    worker.once("message", (msg) => finish(msg && msg.result));
    worker.once("error", () => {
      // The worker itself crashed (e.g. failed to load) — user-script errors are
      // caught inside the worker and posted as normal results, so reaching here
      // means the isolate is unavailable. Degrade to an in-process run rather
      // than failing the script (still bounds synchronous loops).
      finish(runScript(opts));
    });
    worker.once("exit", (code) => {
      // Only meaningful if the worker died before posting a result; a normal
      // run is already settled (and our own terminate() exits non-zero).
      if (code !== 0)
        finish(
          failClosedResult(opts.phase, {
            name: "InternalError",
            message: `script worker exited (${code})`,
          }),
        );
    });
    worker.postMessage({ jobId: 1, payload: opts });
  });
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
    tests: [],
    error: { name: "InternalError", message: "script execution failed" },
  });

  // Run user scripts in the worker isolate (async) so a detached async loop
  // can't wedge the main process; runScript stays the in-process primitive.
  ipcMain.handle("script:run-pre", (_event, payload = {}) =>
    safeCall(
      "script:run-pre",
      () => runScriptIsolated({ ...payload, phase: "pre" }),
      failClosed(true),
    ),
  );

  ipcMain.handle("script:run-post", (_event, payload = {}) =>
    safeCall(
      "script:run-post",
      () => runScriptIsolated({ ...payload, phase: "post" }),
      failClosed(false),
    ),
  );

  ipcMain.handle("script:validate", (_event, code) =>
    safeCall("script:validate", () => validateScript(code), { error: null }),
  );
}

module.exports = {
  runScript,
  runScriptIsolated,
  validateScript,
  registerScripting,
  // exported for tests
  SCRIPT_TIMEOUT_MS,
  HARD_TIMEOUT_MS,
  ALL_SCOPES,
  SET_SCOPES,
};
