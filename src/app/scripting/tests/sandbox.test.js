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
 * scripting/tests/sandbox.test.js
 *
 * Characterises the sandboxed-JS runtime (Feature 25, step 1): the hippo.* API
 * surface, variable-write accumulation, request mutation, console capture,
 * syntax/runtime error reporting, and — most importantly — that the sandbox
 * cannot reach require / process / eval / Function (the acceptance criterion).
 */
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  runScript,
  runScriptIsolated,
  validateScript,
} = require("../sandbox.js");

const pre = (code, ctx = {}) => runScript({ phase: "pre", code, ...ctx });
const post = (code, ctx = {}) => runScript({ phase: "post", code, ...ctx });

describe("hippo.request (pre-request mutation)", () => {
  it("returns the mutated outgoing request", () => {
    const r = pre(
      `hippo.request.method = "POST";
       hippo.request.url = "https://example.com/new";
       hippo.request.headers["X-Added"] = "1";
       hippo.request.body = "hello";`,
      { request: { method: "GET", url: "https://x", headers: {}, body: "" } },
    );
    assert.equal(r.error, null);
    assert.equal(r.request.method, "POST");
    assert.equal(r.request.url, "https://example.com/new");
    assert.equal(r.request.headers["X-Added"], "1");
    assert.equal(r.request.body, "hello");
  });

  it("coerces non-string field values to strings", () => {
    const r = pre(`hippo.request.body = 42;`, {
      request: { method: "GET", url: "u", headers: {}, body: "" },
    });
    assert.equal(r.request.body, "42");
  });

  it("starts from the supplied request snapshot when unmodified", () => {
    const r = pre(`/* noop */`, {
      request: { method: "PUT", url: "u", headers: { A: "b" }, body: "x" },
    });
    assert.deepEqual(r.request, {
      method: "PUT",
      url: "u",
      headers: { A: "b" },
      body: "x",
    });
  });
});

describe("hippo.variables", () => {
  it("set() accumulates writes and coerces values to strings", () => {
    const r = pre(
      `hippo.variables.set("global", "a", "1");
       hippo.variables.set("environment", "b", 2);`,
    );
    assert.equal(r.error, null);
    assert.deepEqual(r.varWrites, [
      { scope: "global", name: "a", value: "1" },
      { scope: "environment", name: "b", value: "2" },
    ]);
  });

  it("get() reads from the supplied snapshot, by scope", () => {
    const r = pre(
      `hippo.variables.set("global", "echo", hippo.variables.get("environment", "token"));`,
      { variables: { environment: { token: "abc" } } },
    );
    assert.deepEqual(r.varWrites, [
      { scope: "global", name: "echo", value: "abc" },
    ]);
  });

  it("get() sees a value set earlier in the same script", () => {
    const r = pre(
      `hippo.variables.set("global", "x", "first");
       hippo.variables.set("collection", "y", hippo.variables.get("global", "x"));`,
    );
    assert.equal(r.varWrites[1].value, "first");
  });

  it("set('folder', …) is rejected — folder is read-only in v1", () => {
    const r = pre(`hippo.variables.set("folder", "n", "v");`);
    assert.notEqual(r.error, null);
    assert.match(r.error.message, /folder/);
    assert.deepEqual(r.varWrites, []); // fail closed
  });

  it("get('folder', …) is allowed", () => {
    const r = pre(
      `hippo.variables.set("global", "f", hippo.variables.get("folder", "k"));`,
      { variables: { folder: { k: "fv" } } },
    );
    assert.equal(r.varWrites[0].value, "fv");
  });

  it("rejects an unknown scope", () => {
    const r = pre(`hippo.variables.set("nope", "n", "v");`);
    assert.notEqual(r.error, null);
    assert.match(r.error.message, /unknown scope/);
  });

  it("get() returns undefined for an unset name, not an inherited prototype member", () => {
    const r = post(
      `hippo.variables.set("global", "a", String(hippo.variables.get("global", "toString")));
       hippo.variables.set("global", "b", String(hippo.variables.get("global", "hasOwnProperty")));
       hippo.variables.set("global", "c", String(hippo.variables.get("global", "constructor")));`,
      { variables: { global: {} } },
    );
    assert.equal(r.error, null);
    const byName = Object.fromEntries(
      r.varWrites.map((w) => [w.name, w.value]),
    );
    assert.equal(byName.a, "undefined");
    assert.equal(byName.b, "undefined");
    assert.equal(byName.c, "undefined");
  });

  it("set() rejects prototype-polluting names (fail closed, no varWrite)", () => {
    for (const name of ["__proto__", "constructor", "prototype"]) {
      const r = post(
        `hippo.variables.set("global", ${JSON.stringify(name)}, "x");`,
        { variables: { global: {} } },
      );
      assert.notEqual(r.error, null, `${name} must be rejected`);
      assert.match(r.error.message, /reserved variable name/);
      assert.deepEqual(r.varWrites, []);
    }
  });
});

describe("hippo.response (after-response)", () => {
  it("exposes status / headers / body and json()", () => {
    const r = post(
      `hippo.variables.set("global", "code", hippo.response.status);
       hippo.variables.set("global", "id", hippo.response.json().id);`,
      {
        response: {
          status: 201,
          headers: { "content-type": "application/json" },
          body: '{"id":"42"}',
        },
      },
    );
    assert.equal(r.error, null);
    assert.equal(r.varWrites[0].value, "201");
    assert.equal(r.varWrites[1].value, "42");
  });

  it("never returns a request patch for a post script", () => {
    const r = post(`/* noop */`, {
      request: { method: "GET", url: "u", headers: {}, body: "" },
    });
    assert.equal(r.request, null);
  });

  it("treats the request snapshot as read-only in post", () => {
    const r = post(
      `hippo.request.url = "MUT";
       hippo.variables.set("global", "u", hippo.request.url);`,
      { request: { method: "GET", url: "orig", headers: {}, body: "" } },
    );
    assert.equal(r.varWrites[0].value, "orig"); // mutation did not take
  });

  it("throws when a pre-request script reads hippo.response", () => {
    const r = pre(`const s = hippo.response.status;`);
    assert.notEqual(r.error, null);
    assert.match(r.error.message, /not available in a pre-request script/);
  });
});

describe("hippo.run (execute another request)", () => {
  const runCtx = {
    runResults: {
      Login: {
        status: 200,
        time: 12,
        headers: { "content-type": "application/json" },
        body: '{"token":"abc"}',
      },
    },
  };

  it("returns the pre-executed response (status/time/headers/body/json) in a pre-script", () => {
    const r = pre(
      `const res = hippo.run("Login");
       hippo.variables.set("environment", "status", res.status);
       hippo.variables.set("environment", "time", res.time);
       hippo.variables.set("environment", "ct", res.headers["content-type"]);
       hippo.variables.set("environment", "token", res.json().token);`,
      runCtx,
    );
    assert.equal(r.error, null);
    const w = Object.fromEntries(r.varWrites.map((v) => [v.name, v.value]));
    assert.equal(w.status, "200");
    assert.equal(w.time, "12");
    assert.equal(w.ct, "application/json");
    assert.equal(w.token, "abc");
  });

  it("is also available in an after-response script", () => {
    const r = post(
      `hippo.variables.set("global", "t", hippo.run("Login").json().token);`,
      runCtx,
    );
    assert.equal(r.error, null);
    assert.equal(r.varWrites[0].value, "abc");
  });

  it("throws for a name with no pre-executed result", () => {
    const r = pre(`hippo.run("Missing");`, runCtx);
    assert.notEqual(r.error, null);
    assert.match(r.error.message, /no executed result for request 'Missing'/);
  });

  it("throws (rather than crashing) when no runResults were supplied", () => {
    const r = pre(`hippo.run("Login");`);
    assert.notEqual(r.error, null);
    assert.match(r.error.message, /hippo\.run: no executed result/);
  });
});

describe("hippo.console", () => {
  it("captures log/info/warn/error with levels", () => {
    const r = pre(
      `hippo.console.log("a", 1);
       hippo.console.warn("careful");
       hippo.console.error("boom");`,
    );
    assert.deepEqual(r.logs, [
      { level: "log", text: "a 1" },
      { level: "warn", text: "careful" },
      { level: "error", text: "boom" },
    ]);
  });

  it("keeps logs emitted before a thrown error (fail-closed otherwise)", () => {
    const r = pre(
      `hippo.console.log("before");
       hippo.variables.set("global", "x", "1");
       throw new Error("stop");`,
    );
    assert.notEqual(r.error, null);
    assert.deepEqual(r.logs, [{ level: "log", text: "before" }]);
    assert.deepEqual(r.varWrites, []); // discarded on error
    assert.equal(r.request, null);
  });
});

describe("sandbox denial (acceptance criterion)", () => {
  const denied = (expr) =>
    pre(`hippo.variables.set("global", "r", String(${expr}));`).varWrites[0]
      ?.value;

  it("has no require / process / module / global in scope", () => {
    assert.equal(denied(`typeof require`), "undefined");
    assert.equal(denied(`typeof process`), "undefined");
    assert.equal(denied(`typeof module`), "undefined");
    assert.equal(denied(`typeof globalThis.process`), "undefined");
  });

  it("blocks eval and the Function constructor (code generation off)", () => {
    const r = pre(
      `try { eval("1+1"); hippo.variables.set("global","e","ran"); }
       catch (err) { hippo.variables.set("global","e", err.name); }`,
    );
    assert.equal(r.varWrites[0].value, "EvalError");
  });

  it("neutralises the constructor.constructor escape", () => {
    // The classic vm breakout: reach the Function constructor and ask for
    // `process`. With code-generation disabled it throws instead of escaping.
    const r = pre(
      `try {
         const F = (function(){}).constructor;
         const p = F("return process")();
         hippo.variables.set("global","leak", typeof p);
       } catch (err) {
         hippo.variables.set("global","leak", "blocked:" + err.name);
       }`,
    );
    assert.equal(r.varWrites[0].value, "blocked:EvalError");
  });

  it("terminates a (synchronous) infinite loop via the wall-clock timeout", () => {
    const r = pre(`while (true) {}`);
    assert.notEqual(r.error, null);
    assert.match(r.error.message, /timed out/i);
  });
  // NOTE: a *detached async* loop (`(async()=>{while(true)await 0})()`) is NOT
  // bounded by the timeout — vm only interrupts synchronous code, and forcing it
  // to interrupt a microtask corrupts Node's async_hooks. The real fix is the
  // worker_threads isolate (see the security-model note in sandbox.js); scripts
  // are documented synchronous-only.
});

describe("result-protocol hardening", () => {
  it("ignores a script reassigning globalThis.__out (writes preserved)", () => {
    const a = pre(
      `globalThis.__out = null; hippo.variables.set("global", "a", "1");`,
    );
    assert.equal(a.error, null);
    assert.deepEqual(a.varWrites, [{ scope: "global", name: "a", value: "1" }]);

    const b = pre(
      `globalThis.__out = {}; hippo.variables.set("global", "b", "2");`,
    );
    assert.deepEqual(b.varWrites, [{ scope: "global", name: "b", value: "2" }]);
  });

  it("ignores a script reassigning globalThis.hippo", () => {
    const r = pre(
      `globalThis.hippo = null; hippo.variables.set("global", "ok", "1");`,
    );
    assert.equal(r.error, null);
    assert.equal(r.varWrites[0]?.value, "1");
  });
});

describe("validateScript", () => {
  it("returns no error for valid source", () => {
    assert.deepEqual(validateScript(`const x = 1; hippo.console.log(x);`), {
      error: null,
    });
  });

  it("reports the line of a syntax error", () => {
    const { error } = validateScript(`const ok = 1;\nconst bad = ;`);
    assert.notEqual(error, null);
    assert.equal(error.name, "SyntaxError");
    assert.equal(error.line, 2);
  });

  it("treats empty/whitespace source as valid", () => {
    assert.deepEqual(validateScript("   \n  "), { error: null });
  });
});

describe("runtime error location", () => {
  it("reports the line a thrown error originated on", () => {
    const r = pre(`\n\nthrow new Error("boom");`);
    assert.notEqual(r.error, null);
    assert.equal(r.error.message, "boom");
    assert.equal(r.error.line, 3);
  });
});

describe("hippo.test / hippo.expect (Feature 29)", () => {
  it("records a passing and a failing test with messages", () => {
    const r = post(
      `hippo.test("ok", () => { hippo.expect(hippo.response.status).toBe(200); });
       hippo.test("bad", () => { hippo.expect(hippo.response.status).toBe(404); });`,
      { response: { status: 200, headers: {}, body: "" } },
    );
    assert.equal(r.error, null);
    assert.deepEqual(
      r.tests.map((t) => [t.name, t.passed]),
      [
        ["ok", true],
        ["bad", false],
      ],
    );
    assert.match(r.tests[1].message, /200 to equal 404/);
  });

  it("supports the matcher set and .not negation", () => {
    const r = post(
      `hippo.test("contain", () => hippo.expect(hippo.response.body).toContain('"a"'));
       hippo.test("lt", () => hippo.expect(hippo.response.time).toBeLessThan(1000));
       hippo.test("match", () => hippo.expect("abc123").toMatch("[0-9]+"));
       hippo.test("deep", () => hippo.expect(hippo.response.json()).toEqual({ a: 1 }));
       hippo.test("not", () => hippo.expect(hippo.response.status).not.toBe(500));
       hippo.test("truthy", () => hippo.expect(hippo.response.body).toBeTruthy());`,
      { response: { status: 200, time: 12, headers: {}, body: '{"a":1}' } },
    );
    assert.equal(r.error, null);
    assert.ok(
      r.tests.every((t) => t.passed),
      JSON.stringify(r.tests),
    );
  });

  it("records a non-function test body as failed without throwing", () => {
    const r = post(`hippo.test("nofn", 5);`, {
      response: { status: 200, headers: {}, body: "" },
    });
    assert.equal(r.error, null);
    assert.equal(r.tests[0].passed, false);
  });

  it("exposes hippo.response.time", () => {
    const r = post(`hippo.variables.set("global", "t", hippo.response.time);`, {
      response: { status: 200, time: 37, headers: {}, body: "" },
    });
    assert.equal(r.varWrites[0].value, "37");
  });

  it("keeps tests recorded before a later throw, alongside the error", () => {
    const r = post(
      `hippo.test("first", () => hippo.expect(1).toBe(1));
       throw new Error("stop");`,
      { response: { status: 200, headers: {}, body: "" } },
    );
    assert.notEqual(r.error, null);
    assert.equal(r.tests.length, 1);
    assert.equal(r.tests[0].passed, true);
  });
});

describe("no-code assertions grid (Feature 29)", () => {
  const grid = (assertions, response) =>
    runScript({ phase: "post", code: "", response, assertions });

  it("evaluates status / responseTime / header / body / json sources", () => {
    const r = grid(
      [
        {
          source: "status",
          matcher: "equals",
          expected: "200",
          label: "status",
        },
        {
          source: "responseTime",
          matcher: "lessThan",
          expected: "500",
          label: "time",
        },
        {
          source: "header",
          name: "Content-Type",
          matcher: "contains",
          expected: "json",
          label: "ct",
        },
        {
          source: "body",
          matcher: "contains",
          expected: "hello",
          label: "body",
        },
        {
          source: "json",
          name: "$.data.id",
          matcher: "equals",
          expected: "7",
          label: "json",
        },
      ],
      {
        status: 200,
        time: 25,
        headers: { "content-type": "application/json" },
        body: '{"data":{"id":7},"msg":"hello"}',
      },
    );
    assert.equal(r.error, null);
    assert.deepEqual(
      r.tests.map((t) => t.passed),
      [true, true, true, true, true],
    );
  });

  it("records failures and skips disabled rows", () => {
    const r = grid(
      [
        { source: "status", matcher: "equals", expected: "404", label: "s" },
        {
          source: "status",
          matcher: "equals",
          expected: "200",
          label: "skip",
          enabled: false,
        },
      ],
      { status: 200, headers: {}, body: "" },
    );
    assert.equal(r.tests.length, 1);
    assert.equal(r.tests[0].passed, false);
  });

  it("fails a json assertion when the body is not JSON", () => {
    const r = grid(
      [
        {
          source: "json",
          name: "$.id",
          matcher: "exists",
          expected: "",
          label: "j",
        },
      ],
      { status: 200, headers: {}, body: "not json" },
    );
    assert.equal(r.tests[0].passed, false);
    assert.match(r.tests[0].message, /not valid JSON/);
  });

  it("resolves array indices and bracket keys in JSON paths", () => {
    const r = grid(
      [
        {
          source: "json",
          name: "items[1].id",
          matcher: "equals",
          expected: "b",
          label: "idx",
        },
        {
          source: "json",
          name: "$['x']['y']",
          matcher: "equals",
          expected: "9",
          label: "brk",
        },
      ],
      {
        status: 200,
        headers: {},
        body: '{"items":[{"id":"a"},{"id":"b"}],"x":{"y":9}}',
      },
    );
    assert.deepEqual(
      r.tests.map((t) => t.passed),
      [true, true],
    );
  });
});

describe("runScriptIsolated (worker_threads isolate)", () => {
  it("runs a normal script off-thread with the same result as in-process", async () => {
    const code = `hippo.console.log("hi");
       hippo.variables.set("global", "k", "v");`;
    const r = await runScriptIsolated({ phase: "pre", code, request: {} });
    assert.equal(r.error, null);
    assert.deepEqual(r.varWrites, [{ scope: "global", name: "k", value: "v" }]);
    assert.deepEqual(r.logs, [{ level: "log", text: "hi" }]);
  });

  it("bounds a synchronous infinite loop and fails closed", async () => {
    const r = await runScriptIsolated({
      phase: "pre",
      code: "while (true) {}",
      request: {},
    });
    assert.notEqual(r.error, null);
    assert.equal(r.request, null); // no mutation survives a timed-out run
  });

  it("contains a detached async loop in the worker — the host stays responsive", async () => {
    const code = "(async () => { while (true) { await 0; } })();";
    const r = await runScriptIsolated({ phase: "pre", code, request: {} });
    // The synchronous part completed and the call returned a normal result…
    assert.equal(r.error, null);
    // …and a host-thread macrotask timer still fires promptly, because the
    // runaway microtask loop lives (and is terminated) in the worker rather than
    // starving this thread — the exact DoS the isolate fixes.
    const start = Date.now();
    await new Promise((res) => setTimeout(res, 50));
    assert.ok(Date.now() - start < 1500, "host timer should not be starved");
  });

  it("contains an over-allocating script via the worker heap limit (fails closed, no host OOM)", async () => {
    // Unbounded allocation the in-vm wall-clock timeout does not bound by size.
    // The worker's resourceLimits abort it (or the timeout trips) before it can
    // exhaust the host — either way we get a fail-closed error, not a crash.
    const code = "const a = []; for (;;) { a.push(new Array(1e6).fill(7)); }";
    const r = await runScriptIsolated({ phase: "pre", code, request: {} });
    assert.notEqual(
      r.error,
      null,
      "an over-allocating script must fail closed",
    );
    assert.equal(r.request, null); // no mutation survives a failed run
    // The host thread is unharmed — a macrotask timer still fires promptly.
    const start = Date.now();
    await new Promise((res) => setTimeout(res, 50));
    assert.ok(Date.now() - start < 1500, "host timer should not be starved");
  });

  it("evaluates the no-code assertion grid through the isolate (post phase)", async () => {
    const r = await runScriptIsolated({
      phase: "post",
      code: "",
      assertions: [
        {
          enabled: true,
          source: "status",
          matcher: "equals",
          expected: "200",
          label: "ok",
        },
      ],
      response: { status: 200, headers: {}, body: "" },
    });
    assert.equal(r.error, null);
    assert.deepEqual(
      r.tests.map((t) => t.passed),
      [true],
    );
  });
});
