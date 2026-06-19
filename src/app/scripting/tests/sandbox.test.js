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

const { runScript, validateScript } = require("../sandbox.js");

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

  it("terminates an infinite loop via the wall-clock timeout", () => {
    const r = pre(`while (true) {}`);
    assert.notEqual(r.error, null);
    assert.match(r.error.message, /timed out/i);
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
