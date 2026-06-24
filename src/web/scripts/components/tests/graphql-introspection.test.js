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
 * components/tests/graphql-introspection.test.js
 *
 * Covers executeIntrospection()'s error ladder (each failure path carries the
 * right i18nKey/params for the UI to localize) and that it forwards the caller's
 * verifySsl / followRedirects into the request descriptor — so a self-signed
 * GraphQL endpoint the user can already send to can also be introspected. The
 * Electron `window.hippo.http.execute` bridge is stubbed; no real network.
 */

"use strict";

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { executeIntrospection } from "../graphql-introspection.js";

/** Install a stubbed Electron bridge whose http.execute resolves to `result`. */
function stubExecute(result) {
  const calls = [];
  globalThis.window = {
    hippo: {
      isElectron: true,
      http: {
        execute: async (desc) => {
          calls.push(desc);
          return typeof result === "function" ? result(desc) : result;
        },
      },
    },
  };
  return calls;
}

const OK_BODY = JSON.stringify({ data: { __schema: { types: [] } } });
const base = { url: "https://api/graphql", headers: {}, body: "{}" };

beforeEach(() => {
  globalThis.window = undefined;
});
afterEach(() => {
  delete globalThis.window;
});

test("executeIntrospection: returns the parsed envelope on success", async () => {
  stubExecute({ status: 200, body: OK_BODY });
  const json = await executeIntrospection(base);
  assert.deepEqual(json, { data: { __schema: { types: [] } } });
});

test("executeIntrospection: forwards verifySsl / followRedirects into the descriptor", async () => {
  const calls = stubExecute({ status: 200, body: OK_BODY });
  await executeIntrospection({
    ...base,
    verifySsl: false,
    followRedirects: false,
  });
  assert.equal(calls[0].verifySsl, false);
  assert.equal(calls[0].followRedirects, false);
});

test("executeIntrospection: defaults verifySsl / followRedirects to true when omitted", async () => {
  const calls = stubExecute({ status: 200, body: OK_BODY });
  await executeIntrospection(base);
  assert.equal(calls[0].verifySsl, true);
  assert.equal(calls[0].followRedirects, true);
});

test("executeIntrospection: a network error prefers the transport message (no i18nKey)", async () => {
  stubExecute({ status: 0, error: { message: "ECONNREFUSED 1.2.3.4:443" } });
  await assert.rejects(executeIntrospection(base), (err) => {
    assert.match(err.message, /ECONNREFUSED/);
    assert.equal(err.i18nKey, undefined); // real transport message used directly
    return true;
  });
});

test("executeIntrospection: a non-2xx status throws errHttp with the status param", async () => {
  stubExecute({ status: 503, body: "" });
  await assert.rejects(executeIntrospection(base), (err) => {
    assert.equal(err.i18nKey, "request.graphql.errHttp");
    assert.deepEqual(err.i18nParams, { status: 503 });
    return true;
  });
});

test("executeIntrospection: a non-JSON body throws errNotJson", async () => {
  stubExecute({ status: 200, body: "<html>not json</html>" });
  await assert.rejects(executeIntrospection(base), (err) => {
    assert.equal(err.i18nKey, "request.graphql.errNotJson");
    return true;
  });
});

test("executeIntrospection: a GraphQL errors[] body throws errGraphql with the message", async () => {
  stubExecute({
    status: 200,
    body: JSON.stringify({ errors: [{ message: "introspection disabled" }] }),
  });
  await assert.rejects(executeIntrospection(base), (err) => {
    assert.equal(err.i18nKey, "request.graphql.errGraphql");
    assert.match(err.i18nParams.message, /introspection disabled/);
    return true;
  });
});

test("executeIntrospection: a body with no __schema throws errNoSchema", async () => {
  stubExecute({ status: 200, body: JSON.stringify({ data: {} }) });
  await assert.rejects(executeIntrospection(base), (err) => {
    assert.equal(err.i18nKey, "request.graphql.errNoSchema");
    return true;
  });
});

test("executeIntrospection: a missing http.execute bridge throws errExecuteUnavailable", async () => {
  globalThis.window = { hippo: { isElectron: true, http: {} } };
  await assert.rejects(executeIntrospection(base), (err) => {
    assert.equal(err.i18nKey, "request.graphql.errExecuteUnavailable");
    return true;
  });
});
