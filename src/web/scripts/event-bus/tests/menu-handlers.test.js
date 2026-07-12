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
 * menu-handlers.test.js — the import/export menu event-bus handlers. Most of
 * these open a modal singleton (covered by those components' own tests); the
 * directly-testable seam is hippo:export-collection, which forwards the chosen
 * collection straight to the host's export handler. Installing the handlers must
 * also not throw.
 */
"use strict";

import { resetDom } from "../../tests/jsdom-setup.js";

import { test } from "node:test";
import assert from "node:assert/strict";

import { installMenuHandlers } from "../menu-handlers.js";

function setup() {
  resetDom();
  const calls = { export: [] };
  assert.doesNotThrow(() =>
    installMenuHandlers({
      handleExport: (c) => calls.export.push(c),
    }),
  );
  const fire = (type, detail) =>
    window.dispatchEvent(new CustomEvent(type, { detail }));
  return { calls, fire };
}

test("hippo:export-collection forwards the chosen collection to handleExport", () => {
  const { calls, fire } = setup();
  const collection = { id: "c1", name: "Alpha" };
  fire("hippo:export-collection", { collection });
  assert.deepEqual(calls.export, [collection]);
});

test("installMenuHandlers wires listeners without throwing", () => {
  // setup() asserts the install itself; a second, listener-free dispatch must be
  // harmless (no matching handler → no-op).
  const { calls, fire } = setup();
  fire("hippo:export-collection", { collection: { id: "c2" } });
  assert.equal(calls.export.length, 1);
});
