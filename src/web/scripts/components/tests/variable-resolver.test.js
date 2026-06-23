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
 * components/tests/variable-resolver.test.js
 *
 * Unit tests for variable resolution: scope precedence, {{name}} substitution,
 * and the dynamic function logic map (built-in, context, and backend-delegated
 * functions). Backend functions (hmac/hash/env/jq) are exercised by stubbing the
 * `window.hippo` IPC bridge that function-backend.js reads at call time, so no
 * real network or Electron runtime is needed.
 *
 * Run with:   node --test components/tests/variable-resolver.test.js
 *
 * Dependencies: none external — Node's built-in test runner + assert. Relies on
 * the global crypto/btoa/atob available in supported Node versions.
 */

"use strict";

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  resolveVariable,
  resolveString,
  resolveStringAsync,
  collectScopes,
  collectScopeNames,
  collectTemplateVariables,
  tokenize,
  isFunctionCall,
  parseFunctionCall,
  buildFunctionToken,
  buildFolderChain,
  parseFnArgs,
} from "../variable-resolver.js";

// ── Scope precedence ─────────────────────────────────────────────────────────

test("resolveVariable: folder chain wins over collection/environment/global", () => {
  const ctx = {
    folderChain: [{ variables: { host: "folder-host" } }],
    collectionVariables: { host: "collection-host" },
    environmentVariables: { host: "environment-host" },
    globalVariables: { host: "global-host" },
  };
  const r = resolveVariable("host", ctx);
  assert.equal(r.found, true);
  assert.equal(r.value, "folder-host");
  assert.equal(r.source, "folder");
});

test("resolveVariable: collection wins over environment and global", () => {
  const ctx = {
    collectionVariables: { host: "collection-host" },
    environmentVariables: { host: "environment-host" },
    globalVariables: { host: "global-host" },
  };
  const r = resolveVariable("host", ctx);
  assert.equal(r.value, "collection-host");
  assert.equal(r.source, "collection");
});

test("resolveVariable: environment wins over global", () => {
  const ctx = {
    environmentVariables: { host: "environment-host" },
    globalVariables: { host: "global-host" },
  };
  const r = resolveVariable("host", ctx);
  assert.equal(r.value, "environment-host");
  assert.equal(r.source, "environment");
});

test("resolveVariable: falls through to global when no nearer scope has it", () => {
  const ctx = { globalVariables: { host: "global-host" } };
  const r = resolveVariable("host", ctx);
  assert.equal(r.value, "global-host");
  assert.equal(r.source, "global");
});

test("resolveVariable: nearest folder in the chain wins", () => {
  const ctx = {
    folderChain: [
      { variables: { token: "near" } },
      { variables: { token: "far" } },
    ],
  };
  assert.equal(resolveVariable("token", ctx).value, "near");
});

test("resolveVariable: unknown name reports not found", () => {
  const r = resolveVariable("nope", { globalVariables: { host: "h" } });
  assert.deepEqual(r, {
    found: false,
    value: undefined,
    source: null,
    secure: false,
  });
});

test("resolveVariable: null name or context is not found", () => {
  assert.equal(resolveVariable("", { globalVariables: {} }).found, false);
  assert.equal(resolveVariable("host", null).found, false);
});

test("resolveVariable: secure flag reflects the winning scope's secure set", () => {
  const ctx = {
    folderChain: [{ variables: { k: "v" }, secureVariables: new Set(["k"]) }],
    collectionVariables: { plain: "x" },
    secureCollectionVariables: new Set(),
  };
  assert.equal(resolveVariable("k", ctx).secure, true);
  assert.equal(resolveVariable("plain", ctx).secure, false);
});

test("resolveVariable: empty-string value is still 'found' (hasOwnProperty, not truthiness)", () => {
  const r = resolveVariable("blank", { collectionVariables: { blank: "" } });
  assert.equal(r.found, true);
  assert.equal(r.value, "");
});

// ── Scope enumeration helpers ────────────────────────────────────────────────

test("collectScopes lists scopes in priority order, one entry per folder", () => {
  const ctx = {
    folderChain: [{ variables: { a: 1 } }, { variables: { b: 2 } }],
    collectionVariables: { c: 3 },
    globalVariables: { d: 4 },
  };
  const sources = collectScopes(ctx).map((s) => s.source);
  assert.deepEqual(sources, ["folder", "folder", "collection", "global"]);
});

test("collectScopeNames dedupes by first occurrence and sorts within a scope", () => {
  const ctx = {
    folderChain: [{ variables: { z: 1, a: 1 } }],
    collectionVariables: { a: 2, m: 2 },
  };
  // folder names sorted (a, z) then collection-only names (m); 'a' not repeated.
  assert.deepEqual(collectScopeNames(ctx), ["a", "z", "m"]);
});

// ── tokenize / function-call parsing ─────────────────────────────────────────

test("tokenize splits text and {{variable}} segments", () => {
  assert.deepEqual(tokenize("a {{x}} b"), [
    { type: "text", content: "a " },
    { type: "variable", content: "x" },
    { type: "text", content: " b" },
  ]);
});

test("isFunctionCall distinguishes calls from plain names", () => {
  assert.equal(isFunctionCall("uuid()"), true);
  assert.equal(isFunctionCall('now("ISO")'), true);
  assert.equal(isFunctionCall("host"), false);
});

test("parseFunctionCall extracts name and quoted/bare args", () => {
  assert.deepEqual(parseFunctionCall("uuid()"), { name: "uuid", rawArgs: [] });
  assert.deepEqual(
    parseFunctionCall('hmac("SHA256", key, "msg, with comma")'),
    {
      name: "hmac",
      rawArgs: ["SHA256", "key", "msg, with comma"],
    },
  );
});

test("buildFunctionToken is the inverse of parseFunctionCall", () => {
  assert.equal(buildFunctionToken("uuid"), "{{uuid()}}");
  assert.equal(
    buildFunctionToken("now", ["ISO", "utc"]),
    '{{now("ISO", "utc")}}',
  );
  const parsed = parseFunctionCall('now("ISO", "utc")');
  assert.deepEqual(parsed.rawArgs, ["ISO", "utc"]);
});

// ── resolveString (synchronous {{name}} substitution) ────────────────────────

test("resolveString substitutes known vars and leaves unknowns intact", () => {
  const ctx = { collectionVariables: { host: "example.com" } };
  assert.equal(
    resolveString("https://{{host}}/{{missing}}", ctx),
    "https://example.com/{{missing}}",
  );
});

test("resolveString resolves multiple/nested-scope variables in one template", () => {
  const ctx = {
    folderChain: [{ variables: { path: "v1" } }],
    collectionVariables: { host: "api" },
    globalVariables: { proto: "https" },
  };
  assert.equal(
    resolveString("{{proto}}://{{host}}/{{path}}", ctx),
    "https://api/v1",
  );
});

test("collectTemplateVariables reports found/unfound across templates, deduped", () => {
  const ctx = { collectionVariables: { host: "h" } };
  const out = collectTemplateVariables(["{{host}}/{{host}}", "{{gone}}"], ctx);
  assert.deepEqual(out, [
    { name: "host", found: true, value: "h" },
    { name: "gone", found: false, value: null },
  ]);
});

// ── resolveStringAsync (functions + variables) ───────────────────────────────

test("resolveStringAsync: plain variable substitution still works", async () => {
  const ctx = { collectionVariables: { host: "api.example.com" } };
  assert.equal(
    await resolveStringAsync("https://{{host}}", ctx),
    "https://api.example.com",
  );
});

test("resolveStringAsync: built-in uuid() yields a v4 UUID", async () => {
  const out = await resolveStringAsync("{{uuid()}}", {});
  assert.match(
    out,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
});

test("resolveStringAsync: now() formats are deterministic in shape", async () => {
  assert.match(await resolveStringAsync('{{now("Unix")}}', {}), /^\d+$/);
  assert.match(await resolveStringAsync('{{now("UnixMs")}}', {}), /^\d+$/);
  assert.match(
    await resolveStringAsync('{{now("ISO")}}', {}),
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
  );
});

test("resolveStringAsync: base64 and url encode/decode round-trip", async () => {
  assert.equal(
    await resolveStringAsync('{{base64encode("hi there")}}', {}),
    "aGkgdGhlcmU=",
  );
  assert.equal(
    await resolveStringAsync('{{base64decode("aGkgdGhlcmU=")}}', {}),
    "hi there",
  );
  assert.equal(
    await resolveStringAsync('{{urlEncode("a b&c")}}', {}),
    "a%20b%26c",
  );
  assert.equal(
    await resolveStringAsync('{{urlDecode("a%20b%26c")}}', {}),
    "a b&c",
  );
});

test("resolveStringAsync: randomInt() stays within bounds", async () => {
  for (let i = 0; i < 20; i++) {
    const n = Number(await resolveStringAsync('{{randomInt("5", "7")}}', {}));
    assert.ok(n >= 5 && n <= 7, `randomInt out of range: ${n}`);
  }
});

test("resolveStringAsync: context functions read from the context object", async () => {
  const ctx = {
    folderChain: [{ name: "Inner" }, { name: "Outer" }],
    collectionName: "My Collection",
    requestName: "Get User",
    activeEnvironmentName: "Staging",
  };
  assert.equal(await resolveStringAsync('{{folderName("0")}}', ctx), "Inner");
  assert.equal(await resolveStringAsync('{{folderName("1")}}', ctx), "Outer");
  assert.equal(
    await resolveStringAsync("{{collectionName()}}", ctx),
    "My Collection",
  );
  assert.equal(await resolveStringAsync("{{requestName()}}", ctx), "Get User");
  assert.equal(
    await resolveStringAsync("{{environmentName()}}", ctx),
    "Staging",
  );
});

test("resolveStringAsync: response() reads the response cache with a simple jq path", async () => {
  const ctx = {
    responseCache: { Login: JSON.stringify({ data: { token: "abc123" } }) },
    responseHeaders: { Login: { "x-trace": "t-9" } },
    responseStatus: { Login: 201 },
  };
  assert.equal(
    await resolveStringAsync('{{response("Login", ".data.token")}}', ctx),
    "abc123",
  );
  assert.equal(
    await resolveStringAsync('{{responseHeader("Login", "X-Trace")}}', ctx),
    "t-9",
  );
  assert.equal(
    await resolveStringAsync('{{responseStatus("Login")}}', ctx),
    "201",
  );
});

test("resolveStringAsync: run() always resolves to an empty string", async () => {
  // run is fire-and-forget — the actual pre-execution is driven by the
  // prefetch pass in app.js; the token itself captures nothing and resolves to "".
  assert.equal(await resolveStringAsync('{{run("Login")}}', {}), "");
  assert.equal(
    await resolveStringAsync('before {{run("Login")}} after', {}),
    "before  after",
  );
});

test("resolveStringAsync: unknown function name is left as a literal token", async () => {
  assert.equal(
    await resolveStringAsync("{{notARealFunction()}}", {}),
    "{{notARealFunction()}}",
  );
});

// ── Backend-delegated functions (window.hippo IPC stubbed) ────────────────────

let backendCalls;

beforeEach(() => {
  backendCalls = [];
  // function-backend.js reads the bare `window` global at call time. Stub the
  // Electron IPC bridge so hmac/hash/env resolve deterministically offline.
  globalThis.window = {
    hippo: {
      isElectron: true,
      functions: {
        invoke: async (fn, args) => {
          backendCalls.push({ fn, args });
          if (fn === "hmac")
            return { result: `hmac:${args.algo}:${args.key}:${args.message}` };
          if (fn === "hash")
            return { result: `hash:${args.algo}:${args.value}` };
          if (fn === "env") return { result: `env:${args.name}` };
          return { result: "" };
        },
      },
    },
  };
});

afterEach(() => {
  delete globalThis.window;
});

test("resolveStringAsync: hmac() delegates to the backend with parsed args", async () => {
  const out = await resolveStringAsync('{{hmac("SHA256", "k", "msg")}}', {});
  assert.equal(out, "hmac:SHA256:k:msg");
  assert.deepEqual(backendCalls[0], {
    fn: "hmac",
    args: { algo: "SHA256", key: "k", message: "msg" },
  });
});

test("resolveStringAsync: hash() and environmentVariable() delegate to the backend", async () => {
  assert.equal(
    await resolveStringAsync('{{hash("SHA512", "x")}}', {}),
    "hash:SHA512:x",
  );
  assert.equal(
    await resolveStringAsync('{{environmentVariable("HOME")}}', {}),
    "env:HOME",
  );
});

test("resolveStringAsync: a throwing backend surfaces as an [error: …] token", async () => {
  globalThis.window.hippo.functions.invoke = async () => ({ error: "boom" });
  assert.equal(
    await resolveStringAsync('{{hmac("SHA256", "k", "m")}}', {}),
    "[error: boom]",
  );
});

// ── buildFolderChain ─────────────────────────────────────────────────────────

test("buildFolderChain returns ancestors nearest-first, excluding the node", () => {
  const tree = [
    {
      id: "root",
      children: [{ id: "mid", children: [{ id: "leaf" }] }],
    },
  ];
  const chain = buildFolderChain(tree, "leaf").map((n) => n.id);
  assert.deepEqual(chain, ["mid", "root"]);
});

test("buildFolderChain returns [] for an unknown node", () => {
  assert.deepEqual(buildFolderChain([{ id: "a" }], "missing"), []);
});

// ── parseFnArgs: a corrupt data-fn-args must not throw (it bricks save/send) ───

test("parseFnArgs: parses a valid JSON array", () => {
  assert.deepEqual(parseFnArgs('["a","b"]'), ["a", "b"]);
  assert.deepEqual(parseFnArgs("[]"), []);
});

test("parseFnArgs: returns [] for a missing attribute", () => {
  assert.deepEqual(parseFnArgs(undefined), []);
  assert.deepEqual(parseFnArgs(null), []);
});

test("parseFnArgs: returns [] for corrupt JSON instead of throwing", () => {
  // The bug: an unguarded JSON.parse here throws out of serializeEditor /
  // getValue, making the request unsaveable and unsendable.
  assert.doesNotThrow(() => parseFnArgs("not json"));
  assert.deepEqual(parseFnArgs("not json"), []);
  assert.deepEqual(parseFnArgs("{"), []);
  assert.deepEqual(parseFnArgs('"oops'), []);
});

test("parseFnArgs: returns [] for valid JSON that isn't an array", () => {
  assert.deepEqual(parseFnArgs("{}"), []);
  assert.deepEqual(parseFnArgs("5"), []);
  assert.deepEqual(parseFnArgs('"str"'), []);
  assert.deepEqual(parseFnArgs("null"), []);
});
